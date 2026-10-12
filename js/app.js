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
      ${browserCopyBanner()}
      <div class="${animate ? "fade-in" : ""}">${data.ready ? tool.render(context()) : notReady()}</div>`;
  }

  // Offer to bring over cohorts that were saved in this browser before the dashboard was shared.
  function browserCopyBanner() {
    const copy = data.browserCopy;
    if (!copy) return "";
    const trainees = copy.cohorts.reduce((n, c) => n + (c.trainees || []).length, 0);
    const parts = [
      copy.cohorts.length && TrainerHub.plural(copy.cohorts.length, "cohort") + ` (${TrainerHub.plural(trainees, "trainee")})`,
      copy.materials.length && TrainerHub.plural(copy.materials.length, "courseware item"),
    ].filter(Boolean).join(" and ");
    return `
      <div class="banner">
        <div class="min0"><strong>Found ${esc(parts)} saved in this browser</strong>
          <span>They were entered before the dashboard switched to shared storage. Copy them in so everyone with the link, and the Slack attendance, can use them.</span></div>
        <div class="btn-row">
          <button class="btn" data-action="app:copyBrowserData">Copy into the dashboard</button>
          <button class="btn secondary" data-action="app:hideBrowserCopy">Not now</button>
        </div>
      </div>`;
  }

  const appActions = {
    async copyBrowserData(el) {
      el.disabled = true;
      el.textContent = "Copying…";
      const r = await data.copyBrowserData();
      render();
      TrainerHub.toast(`Copied ${TrainerHub.plural(r.cohorts, "cohort")} and ${TrainerHub.plural(r.materials, "courseware item")}` +
        (r.skipped.length ? `. Not copied (file type or size not supported): ${r.skipped.join(", ")}` : ""));
    },
    hideBrowserCopy() { data.hideBrowserCopy(); },
  };

  function notReady() {
    return data.mode === "connecting"
      ? `<div class="empty big"><strong>Loading…</strong><span>Connecting to the shared dashboard.</span></div>`
      : `<div class="empty big"><strong>Can't load the dashboard's data</strong><span>Ask the dashboard owner to share it with you, then reload.</span></div>`;
  }

  function runAction(spec, el, event) {
    const [id, name] = spec.split(":");
    if (id === "app") return appActions[name] && appActions[name](el, event);
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

  // Re-draw when data arrives or changes, including changes other people or the Slack routine make.
  data.onChange(() => render());
  render(true);
})();
