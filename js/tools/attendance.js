TrainerHub.registerTool({
  id: "attendance",
  name: "Attendance Checker",
  short: "Attendance",
  icon: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M9 15l2 2 4-4"/>',

  render(cohort, ctx) {
    const { esc, cells } = TrainerHub;
    if (!cohort.trainees.length) {
      return `<div class="empty">No sessions yet for ${esc(cohort.name)}. Attendance starts with the first class.</div>`;
    }

    const today = ctx.state.todayMarks[cohort.id] || {};
    const marks = cohort.trainees.map((t) => t.attendance + (today[t.name] || ""));
    const all = marks.join("");
    const present = [...all].filter((m) => m === "P").length;
    const late = [...all].filter((m) => m === "L").length;
    const absent = [...all].filter((m) => m === "A").length;
    const rate = Math.round(((present + late) / all.length) * 100);
    const markedToday = Object.keys(today).length;

    const rows = cohort.trainees.map((t, i) => {
      const attended = [...marks[i]].filter((m) => m !== "A").length;
      const low = attended / marks[i].length < 0.75;
      const seg = ["P", "L", "A"].map((m) =>
        `<button data-action="attendance:mark" data-name="${esc(t.name)}" data-mark="${m}" aria-pressed="${today[t.name] === m}">${m}</button>`
      ).join("");
      return `
        <tr>
          <td>${low ? `<strong class="danger">${esc(t.name)}</strong>` : esc(t.name)}</td>
          <td>${cells(t.attendance)}</td>
          <td class="num ${low ? "danger" : ""}">${attended} / ${marks[i].length}</td>
          <td><span class="seg" role="group" aria-label="Today's mark for ${esc(t.name)}">${seg}</span></td>
        </tr>`;
    }).join("");

    return `
      <div class="stack">
        <div class="stats">
          <div class="stat accent"><div class="label">Attendance rate</div><div class="value">${rate}%</div><div class="note">present or late</div></div>
          <div class="stat"><div class="label">Late</div><div class="value">${late}</div><div class="note">marks so far</div></div>
          <div class="stat"><div class="label">Absent</div><div class="value">${absent}</div><div class="note">marks so far</div></div>
          <div class="stat"><div class="label">Today's roll</div><div class="value">${markedToday}/${cohort.trainees.length}</div><div class="note">marked</div></div>
        </div>
        <div class="card">
          <h2>Roll call <span class="aside">${ctx.data.today}</span></h2>
          <div class="table-wrap"><table class="table">
            <thead><tr><th>Trainee</th><th>Past sessions</th><th>Attended</th><th>Today</th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>
          <div class="legend">
            <span><i style="background:var(--ok)"></i>Present</span>
            <span><i style="background:var(--warn)"></i>Late</span>
            <span><i style="background:var(--bad)"></i>Absent</span>
            <span>Names in red are below 75% attendance.</span>
          </div>
          <div class="btn-row" style="margin-top:14px">
            <button class="btn secondary" data-action="attendance:allPresent">Mark everyone present</button>
            <button class="btn secondary" data-action="attendance:clear">Clear today</button>
          </div>
        </div>
      </div>`;
  },

  actions: {
    mark(el, ctx) {
      const marks = (ctx.state.todayMarks[ctx.cohort.id] ||= {});
      const { name, mark } = el.dataset;
      if (marks[name] === mark) delete marks[name];
      else marks[name] = mark;
      ctx.save();
    },
    allPresent(el, ctx) {
      ctx.state.todayMarks[ctx.cohort.id] = Object.fromEntries(ctx.cohort.trainees.map((t) => [t.name, "P"]));
      ctx.save();
      TrainerHub.toast("Everyone marked present");
    },
    clear(el, ctx) {
      delete ctx.state.todayMarks[ctx.cohort.id];
      ctx.save();
    },
  },
});
