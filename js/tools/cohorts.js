TrainerHub.registerTool({
  id: "cohorts",
  name: "Cohorts",
  short: "Cohorts",
  icon: '<path d="M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1"/><circle cx="9" cy="7" r="3.5"/><path d="M22 19v-1a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',

  render(cohort, ctx) {
    const { esc, pct, statusPill } = TrainerHub;
    const { data } = ctx;
    const active = data.cohorts.filter((c) => c.trainees.length);
    const traineeCount = active.reduce((n, c) => n + c.trainees.length, 0);
    const atRisk = data.cohorts.filter((c) => c.status.kind === "warn").length;

    const rows = data.cohorts.map((c) => {
      const mod = data.modules[c.currentModule];
      return `
        <tr class="clickable ${c.id === cohort.id ? "selected" : ""}" data-action="cohorts:select" data-id="${c.id}">
          <td><strong>${esc(c.name)}</strong></td>
          <td>${esc(c.stage)}</td>
          <td class="num">${c.trainees.length || "—"}</td>
          <td>${mod ? `M${c.currentModule + 1} · ${esc(mod.title)}` : '<span class="muted">Not started</span>'}</td>
          <td class="num">${pct(c.quizAvg)}</td>
          <td>${statusPill(c)}</td>
        </tr>`;
    }).join("");

    return `
      <div class="stack">
        <div class="stats">
          <div class="stat accent"><div class="label">Active cohorts</div><div class="value">${active.length}</div><div class="note">${data.cohorts.length - active.length} upcoming</div></div>
          <div class="stat"><div class="label">Trainees</div><div class="value">${traineeCount}</div><div class="note">across active cohorts</div></div>
          <div class="stat"><div class="label">Need attention</div><div class="value">${atRisk}</div><div class="note">cohort${atRisk === 1 ? "" : "s"} flagged</div></div>
        </div>
        <div class="card">
          <h2>All cohorts <span class="aside">Click a row to make it the current cohort</span></h2>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Cohort</th><th>Stage</th><th>Trainees</th><th>Current module</th><th>Quiz avg</th><th>Status</th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>
        </div>
      </div>`;
  },

  actions: {
    select(el, ctx) {
      ctx.setCohort(el.dataset.id);
    },
  },
});
