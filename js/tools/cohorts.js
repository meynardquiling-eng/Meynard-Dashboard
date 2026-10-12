(function () {
  const { esc, plural, formatDate, isEmail, openForm, confirmAction, toast } = TrainerHub;

  const cohortFields = (c = {}) => [
    { name: "name", label: "Cohort name", required: true, value: c.name, placeholder: "e.g. Care Wave 15" },
    { name: "startDate", label: "Start date", type: "date", value: c.startDate },
    { name: "notes", label: "Notes", type: "textarea", rows: 3, value: c.notes, placeholder: "Schedule, team lead, anything to remember" },
  ];

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

  function traineeTable(cohort) {
    if (!cohort.trainees.length) {
      return `<div class="empty">No trainees yet. Use <strong>Add trainee</strong> or <strong>Paste a list</strong>.</div>`;
    }
    const rows = cohort.trainees.map((t, i) => `
      <tr>
        <td class="num muted">${i + 1}</td>
        <td><strong>${esc(t.name)}</strong></td>
        <td><a href="mailto:${esc(t.email)}">${esc(t.email)}</a></td>
        <td class="actions">
          <button class="link-btn" data-action="cohorts:editTrainee" data-cohort="${cohort.id}" data-trainee="${t.id}">Edit</button>
          <button class="link-btn danger" data-action="cohorts:deleteTrainee" data-cohort="${cohort.id}" data-trainee="${t.id}">Remove</button>
        </td>
      </tr>`).join("");
    return `
      <div class="table-wrap"><table class="table">
        <thead><tr><th>#</th><th>Name</th><th>Work Gmail</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  }

  TrainerHub.registerTool({
    id: "cohorts",
    name: "Cohorts",
    short: "Cohorts",
    description: "Create cohorts and add their trainees.",
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

      const cards = cohorts.map((c) => `
        <section class="card cohort-card">
          <header class="cohort-head">
            <div class="min0">
              <h2>${esc(c.name)}</h2>
              <div class="muted small">${c.startDate ? "Starts " + formatDate(c.startDate) + " · " : ""}${plural(c.trainees.length, "trainee")}</div>
              ${c.notes ? `<p class="notes">${esc(c.notes)}</p>` : ""}
            </div>
            <div class="btn-row">
              <button class="btn" data-action="cohorts:addTrainee" data-cohort="${c.id}">+ Add trainee</button>
              <button class="btn secondary" data-action="cohorts:bulkAdd" data-cohort="${c.id}">Paste a list</button>
              <button class="btn secondary" data-action="cohorts:edit" data-cohort="${c.id}">Edit</button>
              <button class="btn secondary danger-text" data-action="cohorts:delete" data-cohort="${c.id}">Delete</button>
            </div>
          </header>
          ${traineeTable(c)}
        </section>`).join("");

      return toolbar + `<div class="stack">${cards}</div>`;
    },

    actions: {
      add(el, ctx) {
        openForm({
          title: "Add cohort", submitLabel: "Add cohort", fields: cohortFields(),
          onSubmit(v) {
            ctx.data.addCohort(v);
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
            ctx.data.updateCohort(cohort.id, v);
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
