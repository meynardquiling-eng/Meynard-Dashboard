/*
  Observations: the trainer writes what they noticed in plain words, Claude sorts it per trainee, the trainer
  checks the split, and each observation is saved under that trainee. One tile per cohort lists every trainee
  with their observations, newest first. Editors only (the observations collection is admin-only in the db rules).
*/
(function () {
  const { esc, plural, classTypePill, fold, isFoldOpen, toast } = TrainerHub;
  const O = TrainerHub.observationEngine;

  // Per viewer, not saved: the note being written and the split waiting for review, per cohort.
  const drafts = {};  // cohortId -> note text
  const reviews = {}; // cohortId -> { observedAt, rows: [{ traineeId, text }] }
  const busy = {};    // cohortId -> true while Claude is sorting

  const when = (iso) => new Date(iso).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  const localInput = (iso) => {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  function claudeError(e) {
    switch (e && e.code) {
      case "no_claude": return e.message;
      case "not_granted": return "Claude wasn't allowed for this dashboard. Allow it in the dashboard's permissions, then reload.";
      case "sampling_disabled": return "Claude isn't available for your account here.";
      case "rate_limited": return "You've hit a Claude usage limit. Try again later.";
      case "session_expired": return "Sign in to claude.ai again, then reload.";
      case "invalid_json": case "empty_completion": return "Claude's answer couldn't be read. Try again.";
      default: return "Claude had a problem. Try again in a moment.";
    }
  }

  function traineeOptions(c, selected) {
    return `<option value="" ${selected ? "" : "selected"}>Choose trainee (or leave to skip)…</option>` +
      c.trainees.map((t) => `<option value="${t.id}" ${t.id === selected ? "selected" : ""}>${esc(t.name)}</option>`).join("");
  }

  function composer(c) {
    const sorting = busy[c.id];
    return `
      <div class="obs-compose">
        <label class="form-field" for="obs-note-${c.id}"><span>New observations</span>
          <textarea id="obs-note-${c.id}" rows="4" data-action-input="observations:draft" data-cohort="${c.id}"
            placeholder="Write what you noticed, naming the trainees. e.g. Chris handled the ETF waiver call well. Aira and Paul were 10 minutes late from break." ${sorting ? "disabled" : ""}>${esc(drafts[c.id] || "")}</textarea>
          <small>Claude sorts it under each trainee you name. You check it before anything is saved. Saved with today's date and time.</small>
        </label>
        <div class="btn-row">
          <button class="btn" data-action="observations:sort" data-cohort="${c.id}" ${sorting ? "disabled" : ""}>${sorting ? "Sorting…" : "Sort into trainees"}</button>
          <button class="btn secondary" data-action="observations:manual" data-cohort="${c.id}" ${sorting ? "disabled" : ""}>File it myself</button>
        </div>
      </div>`;
  }

  function reviewPanel(c) {
    const r = reviews[c.id];
    if (!r) return "";
    const ready = r.rows.filter((x) => x.traineeId && x.text.trim()).length;
    const rows = r.rows.map((x, i) => `
      <li class="obs-review-row">
        <select aria-label="Trainee for observation ${i + 1}" data-action-change="observations:reviewTrainee" data-cohort="${c.id}" data-i="${i}">${traineeOptions(c, x.traineeId)}</select>
        <textarea id="obs-rev-${c.id}-${i}" rows="2" aria-label="Observation ${i + 1}" data-action-input="observations:reviewText" data-cohort="${c.id}" data-i="${i}">${esc(x.text)}</textarea>
        <button class="link-btn danger" data-action="observations:reviewRemove" data-cohort="${c.id}" data-i="${i}" aria-label="Remove observation ${i + 1}">Remove</button>
      </li>`).join("");
    return `
      <div class="obs-review">
        <div class="min0"><strong>Check before saving</strong>
          <span class="muted small">Change the trainee or wording if needed. Rows with no trainee are skipped. Observed ${esc(when(r.observedAt))}.</span></div>
        <ul>${rows || `<li class="muted small">Nothing to save. Add a row or discard.</li>`}</ul>
        <div class="btn-row">
          <button class="btn" data-action="observations:save" data-cohort="${c.id}" ${ready ? "" : "disabled"}>Save ${plural(ready, "observation")}</button>
          <button class="btn secondary" data-action="observations:reviewAdd" data-cohort="${c.id}">Add a row</button>
          <button class="btn secondary" data-action="observations:discard" data-cohort="${c.id}">Discard</button>
        </div>
      </div>`;
  }

  function observationItem(o) {
    return `
      <li class="obs-item">
        <div class="min0"><span class="muted small">${esc(when(o.observedAt))}${o.updatedAt ? " · edited" : ""}</span>
          <p>${esc(o.text)}</p></div>
        <div class="btn-row">
          <button class="link-btn" data-action="observations:edit" data-id="${o.id}">Edit</button>
          <button class="link-btn danger" data-action="observations:remove" data-id="${o.id}">Delete</button>
        </div>
      </li>`;
  }

  function traineeList(ctx, c) {
    const { groups, orphaned } = O.groupByTrainee(ctx.data.observationsFor(c.id), c.trainees);
    const person = (key, title, sub, list, t) => `
      <details class="obs-person" data-fold="${esc(key)}" ${isFoldOpen(key, false) ? "open" : ""}>
        <summary><span class="min0"><strong>${esc(title)}</strong>${TrainerHub.tlTag(t)}${sub ? ` <span class="muted small">${esc(sub)}</span>` : ""}</span>
          <span class="mini-counts">${list.length ? `${plural(list.length, "observation")} · latest ${esc(when(list[0].observedAt))}` : "No observations yet"}</span></summary>
        ${list.length ? `<ul class="obs-list">${list.map(observationItem).join("")}</ul>` : `<p class="muted small">Nothing yet.</p>`}
      </details>`;
    return `<div class="obs-people">
      ${groups.map((g) => person(`obs:${c.id}:${g.trainee.id}`, g.trainee.name, g.trainee.email, g.observations, g.trainee)).join("")}
      ${orphaned.length ? person(`obs:${c.id}:removed`, "Trainees no longer in this cohort", "", orphaned) : ""}
    </div>`;
  }

  function cohortBody(ctx, c) {
    const count = ctx.data.observationsFor(c.id).length;
    return `
      ${composer(c)}
      ${reviewPanel(c)}
      <div class="obs-bar"><strong>Trainees</strong>
        ${count && ctx.data.mode === "shared" ? `<button class="btn secondary" data-action="observations:export" data-cohort="${c.id}">Export to Google Sheets</button>` : ""}</div>
      ${traineeList(ctx, c)}`;
  }

  const csvCell = (v) => { const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

  TrainerHub.registerTool({
    id: "observations",
    name: "Observations",
    short: "Observations",
    description: "Write what you notice in class. Claude files each observation under the trainee it's about. Trainers only.",
    icon: '<path d="M4 4h12l4 4v12H4z"/><path d="M8 11h8M8 15h5"/>',
    visible: (ctx) => !!ctx.data.perms.manageClasses,

    render(ctx) {
      const { cohorts } = ctx.data;
      if (!cohorts.length) {
        return `
          <div class="empty big">
            <strong>No cohorts yet</strong>
            <span>Each cohort you add in Cohorts gets a tile here with its trainees.</span>
            <a class="btn" href="#cohorts">Go to Cohorts</a>
          </div>`;
      }
      return `<div class="folds">${cohorts.map((c) => {
        const n = ctx.data.observationsFor(c.id).length;
        return fold({
          key: "observations:" + c.id,
          summary: `
            <div class="min0">
              <h2>${esc(c.name)}</h2>
              <div class="meta-line">${classTypePill(c.classType)}<span class="muted small">${plural(c.trainees.length, "trainee")}</span><span class="mini-counts">${plural(n, "observation")}</span></div>
            </div>`,
          body: c.trainees.length ? cohortBody(ctx, c) : `<div class="empty">Add trainees to ${esc(c.name)} in Cohorts first.</div>`,
        });
      }).join("")}</div>`;
    },

    actions: {
      draft(el) { drafts[el.dataset.cohort] = el.value; },

      async sort(el, ctx) {
        const c = ctx.data.getCohort(el.dataset.cohort);
        const note = (drafts[c.id] || "").trim();
        if (!note) { toast("Write an observation first."); return; }
        const observedAt = new Date().toISOString();
        busy[c.id] = true;
        ctx.rerender();
        try {
          const reply = await ctx.data.askClaudeJson(O.splitPrompt({ note, trainees: c.trainees }), { cache: false });
          const { items, unassigned } = O.checkSplit(reply, c.trainees);
          reviews[c.id] = { observedAt, rows: [...items, ...unassigned.map((text) => ({ traineeId: "", text }))] };
          if (!items.length) toast("Claude couldn't tell who this is about. Pick the trainee for each row.");
        } catch (e) {
          console.warn("observations: sort", e && e.code);
          toast(`${claudeError(e)} You can still file it yourself.`);
          reviews[c.id] = { observedAt, rows: [{ traineeId: "", text: note }] };
        }
        busy[c.id] = false;
        ctx.rerender();
      },
      manual(el, ctx) {
        const id = el.dataset.cohort;
        reviews[id] = { observedAt: new Date().toISOString(), rows: [{ traineeId: "", text: (drafts[id] || "").trim() }] };
        ctx.rerender();
      },
      reviewTrainee(el, ctx) { reviews[el.dataset.cohort].rows[Number(el.dataset.i)].traineeId = el.value; ctx.rerender(); },
      // Typing in a review box doesn't re-render (the Save count updates on the next change).
      reviewText(el) { reviews[el.dataset.cohort].rows[Number(el.dataset.i)].text = el.value; },
      reviewRemove(el, ctx) { reviews[el.dataset.cohort].rows.splice(Number(el.dataset.i), 1); ctx.rerender(); },
      reviewAdd(el, ctx) { reviews[el.dataset.cohort].rows.push({ traineeId: "", text: "" }); ctx.rerender(); },
      discard(el, ctx) { delete reviews[el.dataset.cohort]; ctx.rerender(); },

      async save(el, ctx) {
        const c = ctx.data.getCohort(el.dataset.cohort);
        const r = reviews[c.id];
        const list = r.rows
          .map((x) => ({ traineeId: x.traineeId, text: x.text.trim().slice(0, O.MAX_TEXT) }))
          .filter((x) => x.traineeId && x.text)
          .map((x) => ({ cohortId: c.id, ...x, observedAt: r.observedAt }));
        if (!list.length) return;
        el.disabled = true;
        await ctx.data.addObservations(list);
        delete reviews[c.id];
        drafts[c.id] = "";
        const names = [...new Set(list.map((x) => c.trainees.find((t) => t.id === x.traineeId).name))];
        toast(`Saved ${plural(list.length, "observation")} for ${names.join(", ")}.`);
        ctx.rerender();
      },

      edit(el, ctx) {
        const o = ctx.data.getObservation(el.dataset.id);
        const c = o && ctx.data.getCohort(o.cohortId);
        if (!c) return;
        TrainerHub.openForm({
          title: "Edit observation",
          fields: [
            { name: "traineeId", label: "Trainee", type: "select", value: o.traineeId, required: true, options: c.trainees.map((t) => ({ value: t.id, label: t.name })) },
            { name: "text", label: "Observation", type: "textarea", value: o.text, required: true, rows: 5 },
            { name: "observedAt", label: "Observed", type: "datetime-local", value: localInput(o.observedAt), required: true },
          ],
          onSubmit(v) {
            const at = new Date(v.observedAt);
            if (isNaN(at)) return "Enter a valid date and time.";
            ctx.data.updateObservation(o.id, { traineeId: v.traineeId, text: v.text.slice(0, O.MAX_TEXT), observedAt: at.toISOString() });
          },
        });
      },
      remove(el, ctx) {
        const o = ctx.data.getObservation(el.dataset.id);
        if (!o) return;
        TrainerHub.confirmAction({
          title: "Delete this observation?",
          message: `"${o.text.length > 140 ? o.text.slice(0, 140) + "…" : o.text}" will be removed for good.`,
          onConfirm() { ctx.data.deleteObservation(o.id); },
        });
      },

      async export(el, ctx) {
        const c = ctx.data.getCohort(el.dataset.cohort);
        const { groups, orphaned } = O.groupByTrainee(ctx.data.observationsFor(c.id), c.trainees);
        const rows = [["Cohort", "Trainee", "Email", "Team Lead", "Observed", "Observation"]];
        for (const g of groups) for (const o of g.observations) rows.push([c.name, g.trainee.name, g.trainee.email || "", g.trainee.teamLead || "", when(o.observedAt), o.text]);
        for (const o of orphaned) rows.push([c.name, "(no longer in cohort)", "", "", when(o.observedAt), o.text]);
        el.disabled = true;
        try {
          const res = await ctx.data.drive("create_file", {
            title: `Observations - ${c.name} - ${new Date().toISOString().slice(0, 10)}`,
            textContent: rows.map((r) => r.map(csvCell).join(",")).join("\n"),
            contentMimeType: "text/csv",
          });
          const id = res && res.payload && (res.payload.id || (res.payload.file && res.payload.file.id));
          toast(id ? "Google Sheet created in your Drive." : "Created in your Google Drive.");
          if (id) window.open(`https://docs.google.com/spreadsheets/d/${id}`, "_blank", "noopener");
        } catch (e) {
          console.warn("observations: export", e && e.code);
          toast(e && e.code === "server_not_connected" ? "Google Drive isn't connected. Add it in claude.ai Settings → Connectors." : "Couldn't create the Google Sheet. Try again.");
        }
        el.disabled = false;
      },
    },
  });
})();
