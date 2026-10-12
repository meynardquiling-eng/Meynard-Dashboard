(function () {
  const { esc, initials, plural, formatDate, isEmail, openForm, confirmAction, toast } = TrainerHub;

  const cohortFields = (c = {}) => [
    { name: "name", label: "Cohort name", required: true, value: c.name, placeholder: "e.g. Care Wave 15" },
    { name: "startDate", label: "Start date", type: "date", value: c.startDate },
    ...teamLeadFields(c.teamLead, false),
    { name: "notes", label: "Notes", type: "textarea", rows: 3, value: c.notes, placeholder: "Schedule, anything to remember" },
  ];

  const teamLeadFields = (tl, required = true) => [
    { name: "tlName", label: "Team Lead", required, value: tl && tl.name, placeholder: "e.g. Carla Mendoza" },
  ];

  const readTeamLead = (v) => (v.tlName ? { name: v.tlName } : null);

  // Cohort form values -> cohort fields.
  const readCohort = (v) => ({ name: v.name, startDate: v.startDate, notes: v.notes, teamLead: readTeamLead(v) });

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

  const traineeFields = (t = {}) => [
    { name: "name", label: "Full name", required: true, value: t.name, placeholder: "e.g. Ana Reyes" },
    { name: "email", label: "Work Gmail", type: "email", required: true, value: t.email, placeholder: "name@company.com" },
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
        <span class="min0"><strong class="ellipsis">${esc(t.name)}</strong><a class="small ellipsis" href="mailto:${esc(t.email)}">${esc(t.email)}</a></span>
        <span class="row-actions">
          <button class="link-btn" data-action="cohorts:editTrainee" data-cohort="${cohort.id}" data-trainee="${t.id}" aria-label="Edit ${esc(t.name)}">Edit</button>
          <button class="link-btn danger" data-action="cohorts:deleteTrainee" data-cohort="${cohort.id}" data-trainee="${t.id}" aria-label="Remove ${esc(t.name)}">Remove</button>
        </span>
      </li>`).join("");
    return `<ul class="people scroll">${items}</ul>`;
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

      const tiles = cohorts.map((c) => `
        <section class="card tile">
          <header class="tile-head">
            <div class="min0">
              <h2>${esc(c.name)}</h2>
              <div class="muted small">${c.startDate ? "Starts " + formatDate(c.startDate) : "No start date"}</div>
            </div>
            <span class="pill info">${plural(c.trainees.length, "trainee")}</span>
          </header>
          ${teamLeadRow(c)}
          ${c.notes ? `<p class="notes">${esc(c.notes)}</p>` : ""}
          ${traineeList(c)}
          <div class="btn-row">
            <button class="btn" data-action="cohorts:addTrainee" data-cohort="${c.id}">+ Add trainee</button>
            <button class="btn secondary" data-action="cohorts:bulkAdd" data-cohort="${c.id}">Paste a list</button>
          </div>
          <footer class="tile-foot">
            <button class="link-btn" data-action="cohorts:edit" data-cohort="${c.id}">Edit cohort</button>
            <button class="link-btn danger" data-action="cohorts:delete" data-cohort="${c.id}">Delete cohort</button>
          </footer>
        </section>`).join("");

      const addTile = `
        <button class="add-tile" data-action="cohorts:add">
          <span class="plus">+</span>
          <strong>Add cohort</strong>
        </button>`;

      return toolbar + `<div class="tiles">${tiles}${addTile}</div>`;
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
          title: `Add trainee to ${cohort.name}`, submitLabel: "Add trainee", fields: traineeFields(),
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
          title: "Edit trainee", fields: traineeFields(trainee),
          onSubmit(v) {
            const problem = checkEmail(cohort, v.email, trainee.id);
            if (problem) return problem;
            ctx.data.updateTrainee(cohort.id, trainee.id, v);
            ctx.rerender();
          },
        });
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
