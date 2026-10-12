/*
  Core: the tool registry and small shared helpers.
  Every tool file calls TrainerHub.registerTool({...}); the app only loops over the registry.
*/
window.TrainerHub = (function () {
  const tools = [];

  /**
   * Register a tool.
   * @param {object} tool
   *   id       unique key, also used in the URL (#attendance)
   *   name     page title
   *   short    label under the rail icon
   *   icon     inner SVG markup (24x24 stroke icon)
   *   render   (cohort, ctx) => HTML string for the page body
   *   actions  optional { name: (el, ctx) => void }, triggered by data-action="toolId:name"
   */
  function registerTool(tool) {
    tools.push(tool);
  }

  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

  const pct = (value) => (value == null ? "—" : value + "%");

  const pill = (kind, text) => `<span class="pill ${kind}">${esc(text)}</span>`;

  const icon = (svg) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${svg}</svg>`;

  const initials = (name) => name.split(" ").map((w) => w[0]).join("").toUpperCase();

  // "PPLA__" -> coloured squares; P present, L late, A absent, _ no session yet
  const cells = (marks) =>
    `<span class="cells">${[...marks].map((m) => `<i class="${m === "P" ? "" : m}"></i>`).join("")}</span>`;

  const statusPill = (cohort) => pill(cohort.status.kind, cohort.status.label);

  let toastTimer;
  function toast(message) {
    const el = document.getElementById("toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2400);
  }

  // localStorage can be blocked (private windows), so never let it break the app.
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem("trainerhub:" + key); return v == null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem("trainerhub:" + key, JSON.stringify(value)); } catch { /* ignore */ }
    },
  };

  return { tools, registerTool, esc, pct, pill, icon, initials, cells, statusPill, toast, store };
})();
