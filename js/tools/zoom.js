/*
  Zoom monitoring: per cohort, per training day, when each trainee tried to enter (waiting room), was admitted,
  left, and how long they were in the meeting. The trainer uploads Zoom's participant report (CSV) after class;
  the dashboard reads it in the browser (js/zoom-engine.js) and saves the sessions with the cohort. No Zoom
  connector is involved.
*/
(function () {
  const { esc, plural, classTypePill, fold, toast } = TrainerHub;
  const S = TrainerHub.schedule;
  const Z = TrainerHub.zoomEngine;

  const selectedDate = {}; // cohortId -> date being viewed (per viewer, not saved)

  const dayLabel = (date) => new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const timeCell = (wall) => (wall ? esc(Z.clockLabel(wall)) : "");

  // Dates to choose from: training days so far plus any day that has an upload, newest first.
  function dateOptions(ctx, c) {
    const p = S.progress(c);
    const days = p.days ? p.days.filter((d) => d <= p.today) : [];
    const set = new Set([...days, ...ctx.data.zoomDatesFor(c.id)]);
    return [...set].sort().reverse().map((d) => ({ date: d, day: p.days ? p.days.indexOf(d) + 1 : 0 }));
  }

  function currentDate(ctx, c) {
    const opts = dateOptions(ctx, c);
    if (selectedDate[c.id] && opts.some((o) => o.date === selectedDate[c.id])) return selectedDate[c.id];
    const withData = ctx.data.zoomDatesFor(c.id);
    return withData.length ? withData[withData.length - 1] : (opts[0] ? opts[0].date : S.central().date);
  }

  function summary(ctx, c, date) {
    const doc = ctx.data.getZoomDay(c.id, date);
    if (!doc) return null;
    return { doc, ...Z.summarizeDay(doc.sessions, c.trainees, ctx.data.zoomAliases(c.id), { hasWaitingColumn: doc.hasWaitingColumn }) };
  }

  function triedCell(row, doc) {
    if (row.triedToEnter) return timeCell(row.triedToEnter);
    if (row.joinedDirectly) return `<span class="muted small">Joined directly</span>`;
    return `<span class="muted small" title="This Zoom report has no waiting-room column">Not in report</span>`;
  }

  function sessionsDetail(row) {
    if (!row.drops && !(row.waitingSessions || []).length) return row.drops ? String(row.drops) : `<span class="muted">0</span>`;
    const lines = [
      ...(row.waitingSessions || []).map((s) => `<li class="muted">Waiting room ${timeCell(s.join)} – ${timeCell(s.leave)}</li>`),
      ...row.sessions.map((s) => `<li>In meeting ${timeCell(s.join)} – ${timeCell(s.leave)}</li>`),
    ];
    return `<details class="sessions"><summary>${row.drops}</summary><ul>${lines.join("")}</ul></details>`;
  }

  function table(ctx, c, date) {
    const sum = summary(ctx, c, date);
    if (!sum) return `<div class="empty">No Zoom report for ${dayLabel(date)} yet. Upload the participant report above.</div>`;
    const { doc, rows, unmatched } = sum;
    const present = rows.filter((r) => r.status === "present");
    const waitingOnly = rows.filter((r) => r.status === "waiting-only").length;
    const absent = rows.filter((r) => r.status === "absent").length;
    const avg = present.length ? present.reduce((n, r) => n + r.minutes, 0) / present.length : 0;
    const body = rows.map((r) => {
      const t = r.trainee;
      if (r.status === "absent") {
        return `<tr class="z-absent"><td><strong>${esc(t.name)}</strong>${TrainerHub.tlTag(t)}<br><span class="muted small">${esc(t.email || "")}</span></td>
          <td colspan="5"><span class="pill bad">Not in Zoom</span></td></tr>`;
      }
      return `<tr>
        <td><strong>${esc(t.name)}</strong>${TrainerHub.tlTag(t)}<br><span class="muted small">${esc(t.email || "")}</span></td>
        <td>${triedCell(r, doc)}</td>
        <td>${r.admitted ? timeCell(r.admitted) : `<span class="pill warn">Never admitted</span>`}</td>
        <td>${timeCell(r.left)}</td>
        <td class="num"><strong>${r.admitted ? Z.durationLabel(r.minutes) : "—"}</strong></td>
        <td class="num">${sessionsDetail(r)}</td>
      </tr>`;
    }).join("");

    const options = (key) => `<option value="">Assign to…</option>${c.trainees.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}<option value="ignore">Not a trainee (ignore)</option>`;
    const unmatchedHtml = unmatched.length ? `
      <div class="z-unmatched">
        <strong>${plural(unmatched.length, "Zoom participant")} not matched to a trainee</strong>
        <span class="muted small">Pick who each one is. The dashboard remembers it for this cohort's future reports.</span>
        <ul>${unmatched.map((u) => `
          <li><span class="min0"><strong>${esc(u.name)}</strong> <span class="muted small">${esc(u.email || "no email")} · first seen ${timeCell(u.firstSeen)} · ${Z.durationLabel(u.minutes)} in meeting</span></span>
            <select data-action-change="zoom:assign" data-cohort="${c.id}" data-key="${esc(u.key)}" aria-label="Who is ${esc(u.name)}?">${options(u.key)}</select></li>`).join("")}</ul>
      </div>` : "";

    const aliases = ctx.data.zoomAliases(c.id);
    const ignoredKeys = Object.keys(aliases).filter((k) => aliases[k] === "ignore");
    const ignoredHtml = ignoredKeys.length ? `<div class="muted small">Ignored: ${ignoredKeys.map((k) => `${esc(k.replace(/^(email|name):/, ""))} <button class="link-btn" data-action="zoom:unassign" data-cohort="${c.id}" data-key="${esc(k)}">undo</button>`).join(" · ")}</div>` : "";

    const uploads = (doc.uploads || []).map((u) => `${esc(u.fileName)}${u.topic ? ` (${esc(u.topic)})` : ""}`).join(", ");
    return `
      <div class="today-stats">
        <span class="stat-chip s-present"><b>${present.length}</b> of ${c.trainees.length} in Zoom</span>
        ${waitingOnly ? `<span class="stat-chip s-late"><b>${waitingOnly}</b> never admitted</span>` : ""}
        <span class="stat-chip s-absent"><b>${absent}</b> not in Zoom</span>
        <span class="stat-chip"><b>${Z.durationLabel(avg)}</b> average time in Zoom</span>
      </div>
      <div class="table-wrap"><table class="table zoom-table">
        <thead><tr><th>Trainee</th><th>Tried to enter</th><th>Admitted</th><th>Left</th><th class="num">Time in Zoom</th><th class="num">Drops</th></tr></thead>
        <tbody>${body}</tbody></table></div>
      ${unmatchedHtml}
      ${ignoredHtml}
      <p class="muted small">From ${uploads || "an uploaded report"}. Times are as shown in the Zoom report (your Zoom account's time zone). Time in Zoom counts only time in the meeting, not the waiting room or gaps after a drop. Drops are how many times a trainee left and came back.</p>`;
  }

  function cohortBody(ctx, c) {
    const date = currentDate(ctx, c);
    const opts = dateOptions(ctx, c);
    const has = !!ctx.data.getZoomDay(c.id, date);
    return `
      <div class="zoom-bar">
        <label class="inline-field" for="zoom-day-${c.id}">Day
          <select id="zoom-day-${c.id}" data-action-change="zoom:pickDay" data-cohort="${c.id}">
            ${(opts.some((o) => o.date === date) ? opts : [{ date, day: 0 }, ...opts]).map((o) => `<option value="${o.date}" ${o.date === date ? "selected" : ""}>${dayLabel(o.date)}${o.day ? ` · Day ${o.day}` : ""}${ctx.data.getZoomDay(c.id, o.date) ? " ✓" : ""}</option>`).join("")}
          </select></label>
        <div class="btn-row">
          <label class="btn secondary" for="zoom-upload-${c.id}">Upload Zoom report
            <input type="file" id="zoom-upload-${c.id}" accept=".csv,text/csv" data-action-change="zoom:upload" data-cohort="${c.id}" hidden></label>
          ${has && ctx.data.mode === "shared" ? `<button class="btn secondary" data-action="zoom:export" data-cohort="${c.id}">Export to Google Sheets</button>` : ""}
          ${has ? `<button class="btn secondary danger-text" data-action="zoom:clearDay" data-cohort="${c.id}">Clear this day</button>` : ""}
        </div>
      </div>
      <div class="dropzone small" data-action-drop="zoom:drop" data-cohort="${c.id}">
        <strong>Drop the Zoom participant report (CSV) here</strong>
        <span>In the Zoom web portal: Reports → Usage → click the number under Participants for the meeting → untick "Show unique users" → Export. Upload one report per meeting; a second meeting the same day adds to it.</span>
      </div>
      ${table(ctx, c, date)}`;
  }

  async function addReports(ctx, c, files) {
    for (const file of files) {
      if (!/\.csv$/i.test(file.name)) { toast(`${file.name}: upload the CSV export from Zoom (not Excel or PDF).`); continue; }
      let report;
      try { report = Z.readZoomReport(await file.text()); }
      catch (e) { toast(`${file.name}: ${(e && e.message) || "couldn't read this file."}`); continue; }
      const byDate = Z.sessionsByDate(report.sessions);
      const parts = [];
      for (const [date, sessions] of Object.entries(byDate)) {
        const doc = ctx.data.getZoomDay(c.id, date) || { cohortId: c.id, date, sessions: [], uploads: [], hasWaitingColumn: false };
        const merged = Z.mergeSessions(doc.sessions, sessions);
        await ctx.data.saveZoomDay({
          ...doc,
          sessions: merged.sessions,
          hasWaitingColumn: doc.hasWaitingColumn || report.hasWaitingColumn,
          uploads: merged.added
            ? [...(doc.uploads || []), { fileName: file.name, topic: report.meeting.topic, meetingId: report.meeting.id, uploadedAt: new Date().toISOString(), rows: merged.added }]
            : (doc.uploads || []),
        });
        parts.push(`${dayLabel(date)}: ${merged.added ? plural(merged.added, "new session") : "nothing new (already uploaded)"}`);
        selectedDate[c.id] = date;
      }
      toast(`${file.name} · ${parts.join(" · ")}${report.skipped ? ` · ${plural(report.skipped, "row")} skipped (no valid times)` : ""}`);
    }
    ctx.rerender();
  }

  const csvCell = (v) => { const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

  TrainerHub.registerTool({
    id: "zoom",
    name: "Zoom Tracker",
    short: "Zoom",
    description: "When each trainee tried to enter Zoom, was admitted and left, and their time in Zoom each day.",
    icon: '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="M16 10l6-3v10l-6-3z"/>',

    render(ctx) {
      const { cohorts } = ctx.data;
      if (!cohorts.length) {
        return `
          <div class="empty big">
            <strong>No cohorts yet</strong>
            <span>Each cohort you add in Cohorts gets a tile here for its Zoom monitoring.</span>
            <a class="btn" href="#cohorts">Go to Cohorts</a>
          </div>`;
      }
      const tiles = cohorts.map((c) => {
        const dates = ctx.data.zoomDatesFor(c.id);
        const last = dates[dates.length - 1];
        const lastSum = last ? summary(ctx, c, last) : null;
        const mini = lastSum ? `<span class="mini-counts">${dayLabel(last)} <b class="t-present">${lastSum.rows.filter((r) => r.status === "present").length}</b> of ${c.trainees.length} in Zoom</span>` : `<span class="muted small">No Zoom reports yet</span>`;
        return fold({
          key: "zoom:" + c.id,
          summary: `
            <div class="min0">
              <h2>${esc(c.name)}</h2>
              <div class="meta-line">${classTypePill(c.classType)}<span class="muted small">${plural(c.trainees.length, "trainee")}</span>${mini}</div>
            </div>`,
          body: c.trainees.length ? cohortBody(ctx, c) : `<div class="empty">Add trainees to ${esc(c.name)} in Cohorts first.</div>`,
        });
      }).join("");
      return `<div class="folds">${tiles}</div>`;
    },

    actions: {
      pickDay(el, ctx) { selectedDate[el.dataset.cohort] = el.value; ctx.rerender(); },
      async upload(el, ctx) {
        const c = ctx.data.getCohort(el.dataset.cohort);
        await addReports(ctx, c, [...el.files]);
        el.value = "";
      },
      async drop(el, ctx, event) {
        await addReports(ctx, ctx.data.getCohort(el.dataset.cohort), [...event.dataTransfer.files]);
      },
      assign(el, ctx) {
        if (!el.value) return;
        ctx.data.setZoomAlias(el.dataset.cohort, el.dataset.key, el.value);
        ctx.rerender();
      },
      unassign(el, ctx) {
        ctx.data.setZoomAlias(el.dataset.cohort, el.dataset.key, null);
        ctx.rerender();
      },
      clearDay(el, ctx) {
        const c = ctx.data.getCohort(el.dataset.cohort);
        const date = currentDate(ctx, c);
        TrainerHub.confirmAction({
          title: `Clear Zoom data for ${dayLabel(date)}?`,
          message: `Removes the uploaded Zoom sessions for ${c.name} on ${dayLabel(date)}. You can upload the report again afterwards.`,
          confirmLabel: "Clear",
          onConfirm() { ctx.data.deleteZoomDay(c.id, date); ctx.rerender(); },
        });
      },
      async export(el, ctx) {
        const c = ctx.data.getCohort(el.dataset.cohort);
        const date = currentDate(ctx, c);
        const sum = summary(ctx, c, date);
        if (!sum) return;
        const rows = [["Cohort", "Date", "Trainee", "Email", "Team Lead", "Tried to enter", "Admitted", "Left", "Time in Zoom (minutes)", "Drops", "Status"]];
        for (const r of sum.rows) {
          rows.push([c.name, date, r.trainee.name, r.trainee.email || "", r.trainee.teamLead || "",
            r.triedToEnter ? Z.clockLabel(r.triedToEnter) : r.joinedDirectly ? "Joined directly" : r.status === "absent" ? "" : "Not in report",
            r.admitted ? Z.clockLabel(r.admitted) : "", r.left ? Z.clockLabel(r.left) : "",
            r.status === "present" ? r.minutes : "", r.status === "present" ? r.drops : "",
            { present: "In Zoom", "waiting-only": "Never admitted", absent: "Not in Zoom" }[r.status]]);
        }
        el.disabled = true;
        try {
          const res = await ctx.data.drive("create_file", {
            title: `Zoom monitoring - ${c.name} - ${date}`,
            textContent: rows.map((r) => r.map(csvCell).join(",")).join("\n"),
            contentMimeType: "text/csv",
          });
          const id = res && res.payload && (res.payload.id || (res.payload.file && res.payload.file.id));
          toast(id ? "Google Sheet created in your Drive." : "Created in your Google Drive.");
          if (id) window.open(`https://docs.google.com/spreadsheets/d/${id}`, "_blank", "noopener");
        } catch (e) {
          console.warn("zoom: export", e && e.code);
          toast(e && e.code === "server_not_connected" ? "Google Drive isn't connected. Add it in claude.ai Settings → Connectors." : "Couldn't create the Google Sheet. Try again.");
        }
        el.disabled = false;
      },
    },
  });
})();
