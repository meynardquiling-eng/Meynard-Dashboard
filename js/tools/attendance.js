(function () {
  const { esc, plural, classTypePill } = TrainerHub;
  const S = TrainerHub.schedule;

  const STATUS = {
    present: { label: "Present", short: "P" },
    late: { label: "Late", short: "L" },
    absent: { label: "Absent", short: "A" },
  };
  const NEXT = { present: "late", late: "absent", absent: null, undefined: "present" };
  const PHASE_ORDER = { running: 0, upcoming: 1, unscheduled: 2, finished: 3 };
  const weekday = (date) => new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "narrow", timeZone: "UTC" });
  const shortDate = (date) => new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

  function phaseLabel(p) {
    if (p.phase === "unscheduled") return `<span class="pill warn">Needs a start date</span>`;
    if (p.phase === "upcoming") return `<span class="pill info">Starts ${shortDate(p.days[0])}</span>`;
    if (p.phase === "finished") return `<span class="pill mute">Finished ${shortDate(p.days[p.days.length - 1])}</span>`;
    return `<span class="pill hot">Week ${Math.floor(p.index / 5) + 1} of 4 · Day ${p.index + 1} of ${S.TRAINING_DAYS}</span>`;
  }

  // Today's summary for a running cohort.
  function todayStrip(c, p, ctx) {
    if (p.phase !== "running") return "";
    if (!p.isTrainingDay) return `<p class="muted small">No class today. Next Goodmorning message: ${shortDate(p.days[p.index + 1] || p.days[p.index])} at ${S.POST_TIME}.</p>`;
    const doc = ctx.data.getAttendance(c.id, p.today) || {};
    const counts = { present: 0, late: 0, absent: 0 };
    for (const t of c.trainees) {
      const r = doc.records && doc.records[t.id];
      if (r) counts[r.status]++;
    }
    const waiting = c.trainees.length - counts.present - counts.late - counts.absent;
    const posted = doc.postedAt
      ? `Goodmorning message posted at ${S.timeLabel(doc.postedAt)}${doc.checkedAt ? ` · replies checked at ${S.timeLabel(doc.checkedAt)}` : ""}`
      : S.central().minutes < 6 * 60 + 55 ? `Goodmorning message goes out at ${S.POST_TIME}` : "Goodmorning message not posted yet";
    return `
      <div class="today">
        <div class="today-head"><strong>Today · ${shortDate(p.today)}</strong><span class="muted small">${esc(posted)}</span></div>
        <div class="today-stats">
          <span class="stat-chip s-present"><b>${counts.present}</b> Present</span>
          <span class="stat-chip s-late"><b>${counts.late}</b> Late</span>
          <span class="stat-chip s-absent"><b>${counts.absent}</b> Absent</span>
          ${waiting ? `<span class="stat-chip"><b>${waiting}</b> ${S.isPastCutoff() ? "Not recorded" : "Waiting"}</span>` : ""}
        </div>
      </div>`;
  }

  function grid(c, p, ctx) {
    if (!c.trainees.length) return `<div class="empty">No trainees yet. Add them in the Cohorts tab.</div>`;
    if (!p.days.length) return "";
    const weeks = [0, 1, 2, 3].map((w) => p.days.slice(w * 5, w * 5 + 5));
    const head1 = weeks.map((_, w) => `<th colspan="5" class="wk">Week ${w + 1}</th>`).join("");
    const head2 = p.days.map((d) => `<th class="day ${d === p.today ? "is-today" : ""}" title="${shortDate(d)}">${weekday(d)}<span>${Number(d.slice(8))}</span></th>`).join("");

    const rows = c.trainees.map((t) => {
      const totals = { present: 0, late: 0, absent: 0 };
      const cells = p.days.map((d) => {
        const r = (ctx.data.getAttendance(c.id, d) || {}).records?.[t.id];
        const future = d > p.today;
        if (r) totals[r.status]++;
        const label = r
          ? `${STATUS[r.status].label}${r.repliedAt ? " · replied " + S.timeLabel(r.repliedAt) : ""}${r.source === "manual" ? " · set by trainer" : ""}`
          : future ? "Upcoming" : "No record";
        const cls = `cell ${r ? "s-" + r.status : future ? "future" : "none"} ${r && r.source === "manual" ? "manual" : ""} ${d === p.today ? "is-today" : ""}`;
        return future
          ? `<td><span class="${cls}" title="${shortDate(d)}: ${label}"></span></td>`
          : `<td><button class="${cls}" data-action="attendance:cycle" data-cohort="${c.id}" data-date="${d}" data-trainee="${t.id}"
               title="${shortDate(d)}: ${esc(label)}. Click to change." aria-label="${esc(t.name)}, ${shortDate(d)}: ${esc(label)}">${r ? STATUS[r.status].short : ""}</button></td>`;
      }).join("");
      return `
        <tr>
          <th class="name" scope="row">${esc(t.name)}</th>
          ${cells}
          <td class="num tot">${totals.present}</td><td class="num tot">${totals.late}</td><td class="num tot ${totals.absent >= 3 ? "danger" : ""}">${totals.absent}</td>
        </tr>`;
    }).join("");

    return `
      <div class="table-wrap">
        <table class="att">
          <thead>
            <tr><th></th>${head1}<th colspan="3" class="wk">Total</th></tr>
            <tr><th class="name">Trainee</th>${head2}<th class="tot" title="Present">P</th><th class="tot" title="Late">L</th><th class="tot" title="Absent">A</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function unmatched(c, p, ctx) {
    const items = [];
    for (const d of p.days) {
      const doc = ctx.data.getAttendance(c.id, d);
      (doc && doc.unmatched || []).forEach((u, i) => items.push({ d, i, u }));
    }
    if (!items.length) return "";
    const options = c.trainees.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
    return `
      <div class="unmatched">
        <strong>Replies we couldn't match to a trainee</strong>
        <span class="muted small">Their Slack email didn't match any trainee's work Gmail. Pick who it was.</span>
        ${items.map(({ d, i, u }) => `
          <div class="unmatched-row">
            <span class="min0"><strong>${esc(u.name || "Unknown")}</strong> <span class="muted small">${esc(u.email || "no email on Slack")} · ${shortDate(d)} at ${S.timeLabel(u.repliedAt)}</span></span>
            <select aria-label="Assign reply to trainee" data-action-change="attendance:assign" data-cohort="${c.id}" data-date="${d}" data-index="${i}">
              <option value="">Assign to…</option>${options}
            </select>
          </div>`).join("")}
      </div>`;
  }

  TrainerHub.registerTool({
    id: "attendance",
    name: "Attendance Checker",
    short: "Attendance",
    description: "Daily Goodmorning roll call from each cohort's Slack channel.",
    icon: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M9 15l2 2 4-4"/>',

    render(ctx) {
      const howItWorks = `
        <div class="card how">
          <strong>How it works</strong>
          <span>Every training day (Monday to Friday, 4 weeks from the start date) at <b>${S.POST_TIME} Central</b>, a Goodmorning message is posted in the cohort's Slack channel. Trainees reply "Goodmorning" in the thread.</span>
          <span class="rules"><span class="cell s-present">P</span> by 7:00 AM <span class="cell s-late">L</span> 7:01–7:15 AM <span class="cell s-absent">A</span> no reply by 7:15 AM <span class="cell none manual"></span> changed by a trainer</span>
          ${ctx.data.mode === "local" ? `<span class="warn-text">You're using the copy saved in this browser. Slack attendance only appears in the shared dashboard link.</span>` : ""}
        </div>`;

      const { cohorts } = ctx.data;
      if (!cohorts.length) {
        return howItWorks + `
          <div class="empty big">
            <strong>No cohorts yet</strong>
            <span>Add a cohort with a start date, a Slack channel and trainees, and its attendance shows up here.</span>
            <a class="btn" href="#cohorts">Go to Cohorts</a>
          </div>`;
      }

      const sections = cohorts
        .map((c) => ({ c, p: S.progress(c) }))
        .sort((a, b) => PHASE_ORDER[a.p.phase] - PHASE_ORDER[b.p.phase])
        .map(({ c, p }) => {
          const missing = [!c.slack && "a Slack channel", !c.startDate && "a start date", !c.trainees.length && "trainees"].filter(Boolean);
          return `
            <section class="card att-card ${p.phase}">
              <header class="att-head">
                <div class="min0">
                  <h2>${esc(c.name)}</h2>
                  <div class="meta-line">
                    ${classTypePill(c.classType)}
                    ${c.slack ? `<span class="muted small">${esc(/^https?:/i.test(c.slack) ? "Slack channel linked" : c.slack)}</span>` : ""}
                    ${c.teamLead ? `<span class="muted small">TL ${esc(c.teamLead.name)}</span>` : ""}
                    <span class="muted small">${plural(c.trainees.length, "trainee")}</span>
                  </div>
                </div>
                ${phaseLabel(p)}
              </header>
              ${missing.length ? `<p class="warn-text">Add ${missing.join(", ")} in <a href="#cohorts">Cohorts</a> so attendance can be taken.</p>` : ""}
              ${todayStrip(c, p, ctx)}
              ${p.phase === "finished" ? `<details><summary>Show attendance</summary>${grid(c, p, ctx)}</details>` : grid(c, p, ctx)}
              ${unmatched(c, p, ctx)}
            </section>`;
        }).join("");

      return howItWorks + `<div class="stack">${sections}</div>`;
    },

    actions: {
      // Click a day to correct it: Present -> Late -> Absent -> no record.
      cycle(el, ctx) {
        const { cohort, date, trainee } = el.dataset;
        const current = ctx.data.getAttendance(cohort, date)?.records?.[trainee]?.status;
        ctx.data.setMark(cohort, date, trainee, NEXT[current]);
        ctx.rerender();
      },
      assign(el, ctx) {
        if (!el.value) return;
        const { cohort, date, index } = el.dataset;
        const name = ctx.data.getCohort(cohort).trainees.find((t) => t.id === el.value).name;
        ctx.data.assignUnmatched(cohort, date, Number(index), el.value);
        ctx.rerender();
        TrainerHub.toast(`Reply assigned to ${name}`);
      },
    },
  });
})();
