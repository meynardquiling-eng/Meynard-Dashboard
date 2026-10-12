TrainerHub.registerTool({
  id: "courseware",
  name: "Courseware",
  short: "Courseware",
  icon: '<path d="M4 19.5V5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2zM4 19.5A2 2 0 0 0 6 21.5h14"/><path d="M9 8h7M9 12h5"/>',

  render(cohort, ctx) {
    const { esc, pill } = TrainerHub;
    const { modules } = ctx.data;
    const current = cohort.currentModule;
    const done = Math.max(current, 0);
    const percent = Math.round((done / modules.length) * 100);

    const list = modules.map((m, i) => {
      const state = i < current ? pill("ok", "Done") : i === current ? pill("hot", "In progress") : pill("mute", "Upcoming");
      const materials = m.materials.map((name) => `<span class="pill info">${esc(name)}</span>`).join("");
      return `
        <div class="module ${i === current ? "current" : ""}">
          <span class="no">M${i + 1}</span>
          <div><strong>${esc(m.title)}</strong><div class="materials">${materials}</div></div>
          ${state}
        </div>`;
    }).join("");

    return `
      <div class="stack">
        <div class="stats">
          <div class="stat accent"><div class="label">Program delivered</div><div class="value">${percent}%</div><div class="note">${done} of ${modules.length} modules done</div></div>
          <div class="stat"><div class="label">Now teaching</div><div class="value" style="font-size:18px">${current >= 0 ? "M" + (current + 1) : "—"}</div><div class="note">${current >= 0 ? esc(modules[current].title) : "Not started"}</div></div>
        </div>
        <div class="card">
          <h2>Modules <span class="aside">${esc(cohort.name)}</span></h2>
          <div class="progress" style="margin-bottom:14px"><i style="width:${percent}%"></i></div>
          <div class="modules">${list}</div>
        </div>
      </div>`;
  },
});
