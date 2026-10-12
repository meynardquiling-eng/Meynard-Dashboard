(function () {
  const { esc, plural, classTypePill, fold } = TrainerHub;

  TrainerHub.registerTool({
    id: "zoom",
    name: "Zoom Tracker",
    short: "Zoom",
    description: "Zoom sessions for each cohort.",
    icon: '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="M16 10l6-3v10l-6-3z"/>',

    render(ctx) {
      const { cohorts } = ctx.data;
      if (!cohorts.length) {
        return `
          <div class="empty big">
            <strong>No cohorts yet</strong>
            <span>Each cohort you add in Cohorts gets a tile here for its Zoom sessions.</span>
            <a class="btn" href="#cohorts">Go to Cohorts</a>
          </div>`;
      }
      const tiles = cohorts.map((c) => fold({
        key: "zoom:" + c.id,
        summary: `
          <div class="min0">
            <h2>${esc(c.name)}</h2>
            <div class="meta-line">${classTypePill(c.classType)}<span class="muted small">${plural(c.trainees.length, "trainee")}</span></div>
          </div>`,
        body: `<div class="empty">Zoom tracking for ${esc(c.name)} will appear here.</div>`,
      })).join("");
      return `<div class="folds">${tiles}</div>`;
    },
  });
})();
