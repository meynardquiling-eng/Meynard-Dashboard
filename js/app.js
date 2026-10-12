/*
  App shell: builds the rail from the tool registry, renders the current tool,
  and routes [data-action="toolId:actionName"] events to that tool's actions.
  Nothing here knows about specific tools.
*/
(function () {
  const { tools, data, esc, icon, store } = TrainerHub;

  let toolId = location.hash.slice(1) || store.get("tool", tools[0].id);
  if (!tools.some((t) => t.id === toolId)) toolId = tools[0].id;

  const rail = document.getElementById("rail");
  const main = document.getElementById("main");
  const currentTool = () => tools.find((t) => t.id === toolId);

  const context = () => ({ data, rerender: () => render() });

  function renderRail() {
    rail.innerHTML =
      `<div class="logo" aria-hidden="true">TH</div>` +
      tools.map((t) => `
        <button class="rail-btn" data-tool="${t.id}" ${t.id === toolId ? 'aria-current="page"' : ""} title="${esc(t.name)}">
          ${icon(t.icon)}<span>${esc(t.short)}</span>
        </button>`).join("") +
      `<div class="spacer"></div>`;
  }

  // `animate` is true only when switching tools, so edits inside a page don't replay the fade.
  function render(animate = false) {
    const tool = currentTool();
    renderRail();
    document.title = `${tool.name} · Trainer Hub`;
    main.innerHTML = `
      <header class="page-head">
        <span class="badge-icon">${icon(tool.icon)}</span>
        <div class="min0"><h1>${esc(tool.name)}</h1><div class="sub">${esc(tool.description || "")}</div></div>
      </header>
      <div class="${animate ? "fade-in" : ""}">${tool.render(context())}</div>`;
  }

  function runAction(spec, el, event) {
    const [id, name] = spec.split(":");
    const tool = tools.find((t) => t.id === id);
    const fn = tool && tool.actions && tool.actions[name];
    if (fn) fn(el, context(), event);
  }

  rail.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-tool]");
    if (btn) location.hash = btn.dataset.tool;
  });

  main.addEventListener("click", (e) => {
    const el = e.target.closest("[data-action]");
    if (el) runAction(el.dataset.action, el, e);
  });

  main.addEventListener("change", (e) => {
    const spec = e.target.dataset.actionChange;
    if (spec) runAction(spec, e.target, e);
  });

  // File drag-and-drop onto any [data-action-drop] element.
  main.addEventListener("dragover", (e) => {
    const zone = e.target.closest("[data-action-drop]");
    if (!zone) return;
    e.preventDefault();
    zone.classList.add("over");
  });
  main.addEventListener("dragleave", (e) => {
    const zone = e.target.closest("[data-action-drop]");
    if (zone && !zone.contains(e.relatedTarget)) zone.classList.remove("over");
  });
  main.addEventListener("drop", (e) => {
    const zone = e.target.closest("[data-action-drop]");
    if (!zone) return;
    e.preventDefault();
    zone.classList.remove("over");
    runAction(zone.dataset.actionDrop, zone, e);
  });

  window.addEventListener("hashchange", () => {
    const id = location.hash.slice(1);
    if (!tools.some((t) => t.id === id)) return;
    toolId = id;
    store.set("tool", id);
    render(true);
    main.scrollTop = 0;
  });

  render(true);
})();
