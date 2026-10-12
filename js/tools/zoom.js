TrainerHub.registerTool({
  id: "zoom",
  name: "Zoom Tracker",
  short: "Zoom",
  icon: '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="M16 10l6-3v10l-6-3z"/>',

  render(cohort, ctx) {
    const { esc, initials } = TrainerHub;
    const { live, next, history } = cohort.zoom;
    const size = cohort.trainees.length;

    let current;
    if (live) {
      const missing = new Set(live.notJoined);
      const faces = cohort.trainees.map((t) =>
        `<span class="face ${missing.has(t.name) ? "missing" : ""}" title="${esc(t.name)}">${initials(t.name)}</span>`).join("");
      current = `
        <div class="card">
          <h2><span class="live">LIVE</span> ${esc(live.title)} <span class="aside">started ${esc(live.startedAt)}</span></h2>
          <div class="stats" style="margin-bottom:14px">
            <div class="stat accent"><div class="label">In call</div><div class="value">${size - missing.size}/${size}</div></div>
            <div class="stat"><div class="label">Elapsed</div><div class="value">${live.minutes}m</div></div>
          </div>
          <div class="faces">${faces}</div>
          ${missing.size ? `
            <p style="margin-top:14px">Not in call: <strong class="danger">${[...missing].map(esc).join(", ")}</strong></p>
            <div class="btn-row" style="margin-top:10px"><button class="btn" data-action="zoom:copyMissing">Copy names</button></div>` : ""}
        </div>`;
    } else {
      current = `
        <div class="card">
          <h2>No live session</h2>
          <p>Next: <strong>${esc(next)}</strong></p>
        </div>`;
    }

    const rows = history.map((h) => `
      <tr>
        <td>${esc(h.date)}</td>
        <td>${esc(h.title)}</td>
        <td class="num">${h.minutes} min</td>
        <td class="num ${h.joined < size ? "danger" : ""}">${h.joined} / ${size}</td>
      </tr>`).join("");

    return `
      <div class="stack">
        ${current}
        <div class="card">
          <h2>Past sessions <span class="aside">${live ? "Up next: " + esc(next) : ""}</span></h2>
          ${history.length ? `<div class="table-wrap"><table class="table">
            <thead><tr><th>Date</th><th>Session</th><th>Length</th><th>Joined</th></tr></thead>
            <tbody>${rows}</tbody></table></div>` : `<div class="empty">No sessions yet.</div>`}
        </div>
      </div>`;
  },

  actions: {
    copyMissing(el, ctx) {
      const names = ctx.cohort.zoom.live.notJoined.join(", ");
      navigator.clipboard.writeText(names)
        .then(() => TrainerHub.toast("Names copied"))
        .catch(() => TrainerHub.toast(names));
    },
  },
});
