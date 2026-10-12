/*
  App shell: builds the rail from the tool registry, keeps the current tool and cohort,
  and routes clicks on [data-action="toolId:actionName"] to that tool's actions.
  Nothing here knows about specific tools.
*/
(function () {
  const { tools, data } = TrainerHub;
  const { esc, icon, store } = TrainerHub;

  const state = {
    toolId: location.hash.slice(1) || store.get("tool", tools[0].id),
    cohortId: store.get("cohort", data.cohorts[0].id),
    todayMarks: store.get("todayMarks", {}),
    quiz: { moduleId: null, count: 5, generated: null },
  };
  if (!tools.some((t) => t.id === state.toolId)) state.toolId = tools[0].id;
  if (!data.cohorts.some((c) => c.id === state.cohortId)) state.cohortId = data.cohorts[0].id;

  const rail = document.getElementById("rail");
  const main = document.getElementById("main");

  const currentTool = () => tools.find((t) => t.id === state.toolId);
  const currentCohort = () => data.cohorts.find((c) => c.id === state.cohortId);

  function context() {
    return {
      data,
      state,
      cohort: currentCohort(),
      setCohort(id) { state.cohortId = id; store.set("cohort", id); render(); },
      setTool(id) { location.hash = id; },
      save() { store.set("todayMarks", state.todayMarks); render(); },
    };
  }

  function renderRail() {
    rail.innerHTML =
      `<div class="logo" aria-hidden="true">TH</div>` +
      tools.map((t) => `
        <button class="rail-btn" data-tool="${t.id}" ${t.id === state.toolId ? 'aria-current="page"' : ""} title="${esc(t.name)}">
          ${icon(t.icon)}<span>${esc(t.short)}</span>
        </button>`).join("") +
      `<div class="spacer"></div>`;
  }

  // `animate` is true only when switching tools, so clicks inside a page don't replay the fade.
  function render(animate = false) {
    const tool = currentTool();
    const cohort = currentCohort();
    renderRail();
    document.title = `${tool.name} · Trainer Hub`;

    const cohortButtons = data.cohorts.map((c) =>
      `<button class="cohort-btn" data-cohort="${c.id}" aria-pressed="${c.id === cohort.id}">${esc(c.name)}</button>`).join("");

    main.innerHTML = `
      <header class="page-head">
        <div class="title">
          <span class="badge-icon">${icon(tool.icon)}</span>
          <div><h1>${esc(tool.name)}</h1><div class="sub">${esc(cohort.name)} · ${esc(cohort.stage)} · ${esc(data.today)}</div></div>
        </div>
        <nav class="right" aria-label="Cohort">${cohortButtons}</nav>
      </header>
      <div class="${animate ? "fade-in" : ""}">${tool.render(cohort, context())}</div>`;
  }

  function runAction(spec, el) {
    const [toolId, name] = spec.split(":");
    const tool = tools.find((t) => t.id === toolId);
    const fn = tool && tool.actions && tool.actions[name];
    if (fn) fn(el, context());
  }

  rail.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tool]");
    if (btn) location.hash = btn.dataset.tool;
  });

  main.addEventListener("click", (e) => {
    const cohortBtn = e.target.closest("[data-cohort]");
    if (cohortBtn) return context().setCohort(cohortBtn.dataset.cohort);
    const actionEl = e.target.closest("[data-action]");
    if (actionEl) runAction(actionEl.dataset.action, actionEl);
  });

  main.addEventListener("change", (e) => {
    const spec = e.target.dataset.actionChange;
    if (spec) runAction(spec, e.target);
  });

  window.addEventListener("hashchange", () => {
    const id = location.hash.slice(1);
    if (!tools.some((t) => t.id === id)) return;
    state.toolId = id;
    store.set("tool", id);
    render(true);
    main.scrollTop = 0;
  });

  render(true);
})();
