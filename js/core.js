/*
  Core: the tool registry, shared helpers, and the form/confirm dialog.
  Every tool file calls TrainerHub.registerTool({...}); the app only loops over the registry.
*/
window.TrainerHub = (function () {
  const tools = [];

  /**
   * Register a tool.
   *   id           unique key, also used in the URL (#cohorts)
   *   name         page title
   *   short        label under the rail icon
   *   description  one line under the page title
   *   icon         inner SVG markup (24x24 stroke icon)
   *   render       (ctx) => HTML string for the page body
   *   actions      optional { name: (el, ctx, event) => void }, triggered by
   *                data-action="toolId:name" (click), data-action-change (change), data-action-drop (file drop)
   */
  function registerTool(tool) {
    tools.push(tool);
  }

  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

  const pill = (kind, text) => `<span class="pill ${kind}">${esc(text)}</span>`;
  const icon = (svg) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${svg}</svg>`;
  const initials = (name) => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const isEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

  const formatDate = (iso) => {
    if (!iso) return "";
    const d = new Date(iso.length === 10 ? iso + "T00:00:00" : iso);
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  };

  const formatSize = (bytes) => {
    if (bytes == null) return "";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0;
    while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
    return `${bytes.toFixed(i ? 1 : 0)} ${units[i]}`;
  };

  // A page that has nothing on it yet.
  const placeholder = (title, text) => `
    <div class="empty big">
      <strong>${esc(title)}</strong>
      <span>${esc(text)}</span>
    </div>`;

  let toastTimer;
  function toast(message) {
    const el = document.getElementById("toast");
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
  }

  // localStorage can be blocked (private windows), so never let it break the app.
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem("trainerhub:" + key); return v == null ? fallback : JSON.parse(v); }
      catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem("trainerhub:" + key, JSON.stringify(value)); return true; }
      catch { return false; }
    },
  };

  /* ---------- Dialog: one <dialog> reused for every form and confirmation ---------- */

  /**
   * Open a form.
   *   fields: [{ name, label, type: "text"|"email"|"date"|"url"|"textarea", value, required, placeholder, hint }]
   *   onSubmit(values) returns an error message to keep the form open, or nothing to close it.
   */
  function openForm({ title, fields, submitLabel = "Save", onSubmit }) {
    const dialog = document.getElementById("dialog");
    const inputs = fields.map((f) => {
      const id = "field-" + f.name;
      const common = `id="${id}" name="${f.name}" ${f.required ? "required" : ""} placeholder="${esc(f.placeholder || "")}"`;
      const control = f.type === "textarea"
        ? `<textarea ${common} rows="${f.rows || 4}">${esc(f.value || "")}</textarea>`
        : `<input ${common} type="${f.type || "text"}" value="${esc(f.value || "")}" autocomplete="off">`;
      return `<label class="form-field" for="${id}"><span>${esc(f.label)}${f.required ? "" : ' <em>optional</em>'}</span>${control}${f.hint ? `<small>${esc(f.hint)}</small>` : ""}</label>`;
    }).join("");

    dialog.innerHTML = `
      <form method="dialog" class="dialog-body" novalidate>
        <h2>${esc(title)}</h2>
        ${inputs}
        <p class="form-error" role="alert"></p>
        <div class="btn-row end">
          <button type="button" class="btn secondary" data-close>Cancel</button>
          <button type="submit" class="btn">${esc(submitLabel)}</button>
        </div>
      </form>`;

    const form = dialog.querySelector("form");
    const error = dialog.querySelector(".form-error");
    dialog.querySelector("[data-close]").onclick = () => dialog.close();
    form.onsubmit = (e) => {
      e.preventDefault();
      const values = Object.fromEntries(fields.map((f) => [f.name, form.elements[f.name].value.trim()]));
      const missing = fields.find((f) => f.required && !values[f.name]);
      const message = missing ? `${missing.label} is required.` : onSubmit(values);
      if (message) { error.textContent = message; return; }
      dialog.close();
    };
    dialog.showModal();
    const first = form.querySelector("input, textarea");
    if (first) first.focus();
  }

  /** Ask before something destructive. */
  function confirmAction({ title, message, confirmLabel = "Delete", onConfirm }) {
    const dialog = document.getElementById("dialog");
    dialog.innerHTML = `
      <div class="dialog-body">
        <h2>${esc(title)}</h2>
        <p>${esc(message)}</p>
        <div class="btn-row end">
          <button type="button" class="btn secondary" data-close>Cancel</button>
          <button type="button" class="btn danger" data-ok>${esc(confirmLabel)}</button>
        </div>
      </div>`;
    dialog.querySelector("[data-close]").onclick = () => dialog.close();
    dialog.querySelector("[data-ok]").onclick = () => { dialog.close(); onConfirm(); };
    dialog.showModal();
    dialog.querySelector("[data-close]").focus();
  }

  return {
    tools, registerTool,
    esc, pill, icon, initials, plural, uid, isEmail, formatDate, formatSize, placeholder,
    toast, store, openForm, confirmAction,
  };
})();
