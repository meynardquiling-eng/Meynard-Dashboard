(function () {
  const { esc, initials, plural, classTypePill, formatDate } = TrainerHub;

  TrainerHub.registerTool({
    id: "attendance",
    name: "Attendance Checker",
    short: "Attendance",
    description: "Every cohort and its trainees. Trainees come from the Cohorts tab.",
    icon: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M9 15l2 2 4-4"/>',

    render(ctx) {
      const { cohorts } = ctx.data;

      if (!cohorts.length) {
        return `
          <div class="empty big">
            <strong>No cohorts yet</strong>
            <span>Cohorts you add in the Cohorts tab show up here as tiles, with their trainees.</span>
            <a class="btn" href="#cohorts">Go to Cohorts</a>
          </div>`;
      }

      const tiles = cohorts.map((c) => {
        const people = c.trainees.length
          ? `<ul class="people">${c.trainees.map((t) => `
              <li>
                <span class="avatar">${esc(initials(t.name))}</span>
                <span class="min0"><strong>${esc(t.name)}</strong><span class="muted small ellipsis">${esc(t.email)}</span></span>
              </li>`).join("")}</ul>`
          : `<div class="empty">No trainees in this cohort yet.</div>`;
        return `
          <section class="card tile">
            <header class="tile-head">
              <div class="min0">
                <h2>${esc(c.name)}</h2>
                <div class="meta-line">${classTypePill(c.classType)}<span class="muted small">${c.startDate ? "Starts " + formatDate(c.startDate) : "No start date"}</span></div>
                ${c.teamLead ? `<div class="small">Team Lead: <strong>${esc(c.teamLead.name)}</strong></div>` : ""}
              </div>
              <span class="pill info">${plural(c.trainees.length, "trainee")}</span>
            </header>
            ${people}
            <a class="link-btn" href="#cohorts">Manage trainees →</a>
          </section>`;
      }).join("");

      return `
        <div class="tiles">${tiles}</div>
        <p class="muted small" style="margin-top:16px">The attendance tracker will be added here later.</p>`;
    },
  });
})();
