(function () {
  const { esc, initials, plural, classTypePill, formatDate, isEmail, openForm, confirmAction, toast, tlTag, CLASS_TYPES } = TrainerHub;

  const views = {}; // cohortId -> "trainees" | "teamLeads" (per viewer, not saved)

  // Team Lead names to suggest: the cohort's Team Lead split on "and", "&", "," or "/" ("Kevin and Rob" -> Kevin, Rob),
  // plus every name already given to a trainee.
  function teamLeadNames(c) {
    const fromCohort = c.teamLead ? c.teamLead.name.split(/\s*(?:,|&|\/|\band\b)\s*/i) : [];
    return [...new Set([...fromCohort, ...c.trainees.map((t) => t.teamLead)].map((n) => (n || "").trim()).filter(Boolean))];
  }

  const cohortFields = (c = {}) => [
    { name: "name", label: "Cohort name", required: true, value: c.name, placeholder: "e.g. Care Wave 15" },
    { name: "classType", label: "Class type", type: "select", options: CLASS_TYPES, required: true, value: c.classType },
    { name: "startDate", label: "Start date", type: "date", value: c.startDate },
    ...teamLeadFields(c.teamLead, false),
    { name: "slack", label: "Slack Channel", value: c.slack, placeholder: "#care-wave-15 or a link to the channel" },
    { name: "notes", label: "Notes", type: "textarea", rows: 3, value: c.notes, placeholder: "Schedule, anything to remember" },
  ];

  const teamLeadFields = (tl, required = true) => [
    { name: "tlName", label: "Team Lead", required, value: tl && tl.name, placeholder: "e.g. Carla Mendoza" },
  ];

  const readTeamLead = (v) => (v.tlName ? { name: v.tlName } : null);

  // Cohort form values -> cohort fields.
  const readCohort = (v) => ({
    name: v.name, classType: v.classType, startDate: v.startDate, notes: v.notes,
    teamLead: readTeamLead(v), slack: readSlack(v.slack),
  });

  // "care-wave-15" -> "#care-wave-15"; links are kept as they are.
  const readSlack = (value) => (!value || /^https?:\/\//i.test(value) || value.startsWith("#") ? value : "#" + value);

  function slackRow(c) {
    if (!c.slack) return "";
    const isLink = /^https?:\/\//i.test(c.slack);
    const label = isLink ? "Open channel" : c.slack;
    const text = isLink
      ? `<a href="${esc(c.slack)}" target="_blank" rel="noopener">${esc(label)}</a>`
      : `<strong>${esc(label)}</strong>`;
    return `<div class="slack-row"><span class="slack-label">Slack</span>${text}</div>`;
  }

  function teamLeadRow(c) {
    if (!c.teamLead) {
      return `<button class="link-btn tl-add" data-action="cohorts:teamLead" data-cohort="${c.id}">+ Add Team Lead</button>`;
    }
    const tl = c.teamLead;
    return `
      <div class="tl">
        <span class="avatar tl-avatar" title="Team Lead">${esc(initials(tl.name))}</span>
        <span class="min0">
          <span class="tl-label">Team Lead</span>
          <strong class="ellipsis">${esc(tl.name)}</strong>
        </span>
        <span class="row-actions">
          <button class="link-btn" data-action="cohorts:teamLead" data-cohort="${c.id}" aria-label="Change Team Lead">Change</button>
          <button class="link-btn danger" data-action="cohorts:removeTeamLead" data-cohort="${c.id}" aria-label="Remove Team Lead">Remove</button>
        </span>
      </div>`;
  }

  const traineeFields = (t = {}, c = null) => [
    { name: "name", label: "Full name", required: true, value: t.name, placeholder: "e.g. Ana Reyes" },
    { name: "email", label: "Work Gmail", type: "email", required: true, value: t.email, placeholder: "name@company.com" },
    { name: "teamLead", label: "Team Lead (optional)", value: t.teamLead, placeholder: "e.g. Kevin",
      hint: c && teamLeadNames(c).length ? "In this cohort: " + teamLeadNames(c).join(", ") : "The Team Lead this trainee goes to after training." },
  ];

  // Returns an error message if the email is invalid or already used in this cohort.
  function checkEmail(cohort, email, exceptId) {
    if (!isEmail(email)) return `"${email}" doesn't look like an email address.`;
    const taken = cohort.trainees.some((t) => t.id !== exceptId && t.email.toLowerCase() === email.toLowerCase());
    if (taken) return `${email} is already in ${cohort.name}.`;
  }

  function traineeList(cohort) {
    if (!cohort.trainees.length) {
      return `<div class="empty">No trainees yet.</div>`;
    }
    const items = cohort.trainees.map((t) => `
      <li>
        <span class="avatar">${esc(initials(t.name))}</span>
        <span class="min0"><strong class="ellipsis">${esc(t.name)}${tlTag(t)}</strong><a class="small ellipsis" href="mailto:${esc(t.email)}">${esc(t.email)}</a></span>
        <span class="row-actions">
          <button class="link-btn" data-action="cohorts:editTrainee" data-cohort="${cohort.id}" data-trainee="${t.id}" aria-label="Edit ${esc(t.name)}">Edit</button>
          <button class="link-btn danger" data-action="cohorts:deleteTrainee" data-cohort="${cohort.id}" data-trainee="${t.id}" aria-label="Remove ${esc(t.name)}">Remove</button>
        </span>
      </li>`).join("");
    return `<ul class="people scroll">${items}</ul>`;
  }

  // One row per trainee with their Team Lead, editable in place, and how many trainees each Team Lead has.
  function teamLeadList(c) {
    if (!c.trainees.length) return `<div class="empty">No trainees yet.</div>`;
    const names = teamLeadNames(c);
    const count = (n) => c.trainees.filter((t) => (t.teamLead || "") === n).length;
    const unset = count("");
    return `
      <div class="today-stats">
        ${names.map((n) => `<span class="stat-chip"><b>${count(n)}</b> ${esc(n)}</span>`).join("")}
        <span class="stat-chip ${unset ? "s-late" : ""}"><b>${unset}</b> no Team Lead yet</span>
      </div>
      <datalist id="tl-names-${c.id}">${names.map((n) => `<option value="${esc(n)}">`).join("")}</datalist>
      <ul class="people tl-assign">${c.trainees.map((t) => `
        <li>
          <span class="avatar">${esc(initials(t.name))}</span>
          <label class="min0" for="tl-${c.id}-${t.id}"><strong class="ellipsis">${esc(t.name)}</strong><span class="small muted ellipsis">${esc(t.email)}</span></label>
          <input id="tl-${c.id}-${t.id}" class="tl-input" list="tl-names-${c.id}" value="${esc(t.teamLead || "")}" placeholder="Team Lead"
            data-action-change="cohorts:setTraineeTeamLead" data-cohort="${c.id}" data-trainee="${t.id}" autocomplete="off">
        </li>`).join("")}</ul>
      <p class="muted small">Type a name or pick one. It saves when you leave the box, and shows next to the trainee on every tab.</p>`;
  }

  function viewTabs(c) {
    const v = views[c.id] || "trainees";
    const tab = (id, label) => `<button class="seg ${v === id ? "on" : ""}" data-action="cohorts:view" data-cohort="${c.id}" data-view="${id}" aria-pressed="${v === id}">${label}</button>`;
    return `<div class="segs" role="group" aria-label="Show">${tab("trainees", "Trainees")}${tab("teamLeads", "Team Leads")}</div>`;
  }

  TrainerHub.registerTool({
    id: "cohorts",
    name: "Cohorts",
    short: "Cohorts",
    description: "Create cohorts, assign a Team Lead and add trainees.",
    icon: '<path d="M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1"/><circle cx="9" cy="7" r="3.5"/><path d="M22 19v-1a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',

    render(ctx) {
      const { cohorts } = ctx.data;
      const traineeCount = cohorts.reduce((n, c) => n + c.trainees.length, 0);

      const toolbar = `
        <div class="toolbar">
          <span class="muted">${plural(cohorts.length, "cohort")} · ${plural(traineeCount, "trainee")}</span>
          <button class="btn" data-action="cohorts:add">+ Add cohort</button>
        </div>`;

      if (!cohorts.length) {
        return toolbar + `
          <div class="empty big">
            <strong>No cohorts yet</strong>
            <span>Add your first cohort, then add its trainees with their work Gmail.</span>
            <button class="btn" data-action="cohorts:add">+ Add cohort</button>
          </div>`;
      }

      const tiles = cohorts.map((c) => TrainerHub.fold({
        key: "cohorts:" + c.id,
        summary: `
          <div class="min0">
            <h2>${esc(c.name)}</h2>
            <div class="meta-line">
              ${classTypePill(c.classType)}
              <span class="muted small">${c.startDate ? "Starts " + formatDate(c.startDate) : "No start date"}</span>
              ${c.teamLead ? `<span class="muted small">TL ${esc(c.teamLead.name)}</span>` : ""}
            </div>
          </div>
          <span class="pill info">${plural(c.trainees.length, "trainee")}</span>`,
        body: `
          ${teamLeadRow(c)}
          ${slackRow(c)}
          ${c.notes ? `<p class="notes">${esc(c.notes)}</p>` : ""}
          ${viewTabs(c)}
          ${(views[c.id] || "trainees") === "teamLeads" ? teamLeadList(c) : traineeList(c)}
          <div class="btn-row">
            <button class="btn" data-action="cohorts:addTrainee" data-cohort="${c.id}">+ Add trainee</button>
            <button class="btn secondary" data-action="cohorts:bulkAdd" data-cohort="${c.id}">Paste a list</button>
          </div>
          <footer class="tile-foot">
            <button class="link-btn" data-action="cohorts:edit" data-cohort="${c.id}">Edit cohort</button>
            <button class="link-btn danger" data-action="cohorts:delete" data-cohort="${c.id}">Delete cohort</button>
          </footer>`,
      })).join("");

      const addTile = `
        <button class="add-tile" data-action="cohorts:add">
          <span class="plus">+</span>
          <strong>Add cohort</strong>
        </button>`;

      return toolbar + `<div class="folds">${tiles}${addTile}</div>`;
    },

    actions: {
      add(el, ctx) {
        openForm({
          title: "Add cohort", submitLabel: "Add cohort", fields: cohortFields(),
          onSubmit(v) {
            ctx.data.addCohort(readCohort(v));
            ctx.rerender();
            toast(`${v.name} added`);
          },
        });
      },
      edit(el, ctx) {
        const cohort = ctx.data.getCohort(el.dataset.cohort);
        openForm({
          title: "Edit cohort", fields: cohortFields(cohort),
          onSubmit(v) {
            ctx.data.updateCohort(cohort.id, readCohort(v));
            ctx.rerender();
          },
        });
      },
      delete(el, ctx) {
        const cohort = ctx.data.getCohort(el.dataset.cohort);
        confirmAction({
          title: `Delete ${cohort.name}?`,
          message: cohort.trainees.length
            ? `This also removes its ${plural(cohort.trainees.length, "trainee")}. You can't undo this.`
            : "You can't undo this.",
          confirmLabel: "Delete cohort",
          onConfirm() {
            ctx.data.deleteCohort(cohort.id);
            ctx.rerender();
            toast(`${cohort.name} deleted`);
          },
        });
      },
      teamLead(el, ctx) {
        const cohort = ctx.data.getCohort(el.dataset.cohort);
        openForm({
          title: `${cohort.teamLead ? "Change" : "Add"} Team Lead for ${cohort.name}`,
          submitLabel: "Save Team Lead",
          fields: teamLeadFields(cohort.teamLead),
          onSubmit(v) {
            const teamLead = readTeamLead(v);
            ctx.data.updateCohort(cohort.id, { teamLead });
            ctx.rerender();
            toast(`${teamLead.name} is Team Lead for ${cohort.name}`);
          },
        });
      },
      removeTeamLead(el, ctx) {
        const cohort = ctx.data.getCohort(el.dataset.cohort);
        confirmAction({
          title: `Remove ${cohort.teamLead.name} as Team Lead?`,
          message: `${cohort.name} will have no Team Lead.`,
          confirmLabel: "Remove",
          onConfirm() {
            ctx.data.updateCohort(cohort.id, { teamLead: null });
            ctx.rerender();
          },
        });
      },
      addTrainee(el, ctx) {
        const cohort = ctx.data.getCohort(el.dataset.cohort);
        openForm({
          title: `Add trainee to ${cohort.name}`, submitLabel: "Add trainee", fields: traineeFields({}, cohort),
          onSubmit(v) {
            const problem = checkEmail(cohort, v.email);
            if (problem) return problem;
            ctx.data.addTrainee(cohort.id, v);
            ctx.rerender();
            toast(`${v.name} added`);
          },
        });
      },
      bulkAdd(el, ctx) {
        const cohort = ctx.data.getCohort(el.dataset.cohort);
        openForm({
          title: `Paste trainees into ${cohort.name}`, submitLabel: "Add trainees",
          fields: [{
            name: "list", label: "One trainee per line: name, email", type: "textarea", rows: 8, required: true,
            placeholder: "Ana Reyes, ana.reyes@company.com\nJoel Santos, joel.santos@company.com",
            hint: "You can paste straight from a spreadsheet (name and email columns).",
          }],
          onSubmit(v) {
            const lines = v.list.split("\n").map((l) => l.trim()).filter(Boolean);
            const parsed = [];
            for (const [i, line] of lines.entries()) {
              const parts = line.split(/[,\t;]/).map((p) => p.trim()).filter(Boolean);
              const email = parts.find((p) => p.includes("@"));
              const name = parts.filter((p) => p !== email).join(" ");
              if (!name || !email) return `Line ${i + 1} needs a name and an email: "${line}"`;
              const problem = checkEmail(cohort, email) ||
                (parsed.some((p) => p.email.toLowerCase() === email.toLowerCase()) ? `${email} appears twice in the list.` : "");
              if (problem) return `Line ${i + 1}: ${problem}`;
              parsed.push({ name, email });
            }
            parsed.forEach((t) => ctx.data.addTrainee(cohort.id, t));
            ctx.rerender();
            toast(`${plural(parsed.length, "trainee")} added to ${cohort.name}`);
          },
        });
      },
      editTrainee(el, ctx) {
        const cohort = ctx.data.getCohort(el.dataset.cohort);
        const trainee = cohort.trainees.find((t) => t.id === el.dataset.trainee);
        openForm({
          title: "Edit trainee", fields: traineeFields(trainee, cohort),
          onSubmit(v) {
            const problem = checkEmail(cohort, v.email, trainee.id);
            if (problem) return problem;
            ctx.data.updateTrainee(cohort.id, trainee.id, v);
            ctx.rerender();
          },
        });
      },
      view(el, ctx) { views[el.dataset.cohort] = el.dataset.view; ctx.rerender(); },
      setTraineeTeamLead(el, ctx) {
        const cohort = ctx.data.getCohort(el.dataset.cohort);
        const trainee = cohort && cohort.trainees.find((t) => t.id === el.dataset.trainee);
        if (!trainee) return;
        const name = el.value.trim();
        if ((trainee.teamLead || "") === name) return;
        ctx.data.updateTrainee(cohort.id, trainee.id, { teamLead: name });
        ctx.rerender();
        toast(name ? `${trainee.name} goes to ${name}` : `Team Lead cleared for ${trainee.name}`);
      },
      deleteTrainee(el, ctx) {
        const cohort = ctx.data.getCohort(el.dataset.cohort);
        const trainee = cohort.trainees.find((t) => t.id === el.dataset.trainee);
        confirmAction({
          title: `Remove ${trainee.name}?`,
          message: `They'll be removed from ${cohort.name}.`,
          confirmLabel: "Remove",
          onConfirm() {
            ctx.data.deleteTrainee(cohort.id, trainee.id);
            ctx.rerender();
          },
        });
      },
    },
  });
})();
