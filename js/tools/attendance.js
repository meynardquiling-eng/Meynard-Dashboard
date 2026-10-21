(function () {
  const { esc, plural, classTypePill } = TrainerHub;
  const S = TrainerHub.schedule;

  const PHASE_ORDER = { running: 0, upcoming: 1, unscheduled: 2, finished: 3 };
  const weekday = (date) => new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "narrow", timeZone: "UTC" });
  const shortDate = (date) => new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const fmtPoints = (n) => String(Math.round(n * 100) / 100);

  // Ticked = checked in. Older records (before ticks) stored present/late/absent.
  const isIn = (r) => !!r && (r.checkedIn ?? (r.status === "present" || r.status === "late"));
  const recordOf = (ctx, c, d, t) => (ctx.data.getAttendance(c.id, d) || {}).records?.[t.id];

  function phaseLabel(p) {
    if (p.phase === "unscheduled") return `<span class="pill warn">Needs a start date</span>`;
    if (p.phase === "upcoming") return `<span class="pill info">Starts ${shortDate(p.days[0])}</span>`;
    if (p.phase === "finished") return `<span class="pill mute">Finished ${shortDate(p.days[p.days.length - 1])}</span>`;
    return `<span class="pill hot">Week ${Math.floor(p.index / 5) + 1} of 4 · Day ${p.index + 1} of ${S.TRAINING_DAYS}</span>`;
  }

  function todayTally(c, p, ctx) {
    const doc = ctx.data.getAttendance(c.id, p.today) || {};
    const tally = { in: 0, noReply: 0, ncns: 0, waiting: 0, points: 0 };
    for (const t of c.trainees) {
      const r = doc.records && doc.records[t.id];
      if (r && r.points) tally.points += r.points;
      if (isIn(r)) tally.in++;
      else if (r && r.flag === "possible-ncns") tally.ncns++;
      else if (r && (r.flag === "no-reply" || r.source === "manual")) tally.noReply++;
      else tally.waiting++;
    }
    return { doc, tally };
  }

  // Shown on the closed tile.
  function todayCounts(c, p, ctx) {
    if (p.phase !== "running" || !p.isTrainingDay) return "";
    const { tally } = todayTally(c, p, ctx);
    return `<span class="mini-counts">Today <b class="t-present">${tally.in}</b> in${tally.ncns ? ` · <b class="t-late">${tally.ncns}</b> possible NCNS` : ""}</span>`;
  }

  function todayStrip(c, p, ctx) {
    if (p.phase !== "running") return "";
    if (!p.isTrainingDay) return `<p class="muted small">No class today. Next Goodmorning message: ${shortDate(p.days[p.index + 1] || p.days[p.index])} at ${S.POST_TIME}.</p>`;
    const { doc, tally } = todayTally(c, p, ctx);
    const now = S.central().minutes;
    const steps = [
      doc.postedAt ? `Posted ${S.timeLabel(doc.postedAt)}` : now < 6 * 60 + 55 ? `Posts at ${S.POST_TIME}` : "Not posted yet",
      doc.checkedAt ? `checked ${S.timeLabel(doc.checkedAt)}` : `checks at ${S.CHECK_TIME}`,
      doc.recheckedAt ? `rechecked ${S.timeLabel(doc.recheckedAt)}` : `rechecks at ${S.RECHECK_TIME}`,
    ].join(" · ");
    return `
      <div class="today">
        <div class="today-head"><strong>Today · ${shortDate(p.today)}</strong><span class="muted small">${esc(steps)}</span></div>
        <div class="today-stats">
          <span class="stat-chip s-present"><b>${tally.in}</b> Checked in</span>
          ${tally.noReply ? `<span class="stat-chip"><b>${tally.noReply}</b> No reply yet</span>` : ""}
          ${tally.ncns ? `<span class="stat-chip s-late"><b>${tally.ncns}</b> Possible NCNS</span>` : ""}
          ${tally.waiting ? `<span class="stat-chip"><b>${tally.waiting}</b> Waiting</span>` : ""}
          <span class="stat-chip s-absent"><b>${fmtPoints(tally.points)}</b> Points today</span>
        </div>
      </div>`;
  }

  function dayCell(c, t, d, p, ctx) {
    const r = recordOf(ctx, c, d, t);
    const ids = `data-cohort="${c.id}" data-date="${d}" data-trainee="${t.id}"`;
    if (d > p.today) return `<td><div class="day future"><input type="checkbox" class="tick" disabled aria-label="${esc(t.name)}, ${shortDate(d)}: upcoming"></div></td>`;

    const checked = isIn(r);
    const ncns = !checked && r && r.flag === "possible-ncns";
    const noReply = !checked && r && r.flag === "no-reply";
    const details = [
      checked ? "Checked in" : ncns ? "Possible NCNS" : noReply ? "No reply yet" : "Not checked in",
      r && r.repliedAt && `replied ${S.timeLabel(r.repliedAt)}`,
      r && r.source === "manual" && "tick set by trainer",
      r && r.points != null && `${fmtPoints(r.points)} pts`,
      r && r.comment && `“${r.comment}”`,
    ].filter(Boolean).join(" · ");
    const badge = r && r.points != null
      ? `<span class="pts-val ${r.points >= 1 ? "hi" : ""}">${fmtPoints(r.points)}</span>`
      : ncns ? `<span class="pts-flag">NCNS?</span>` : `<span class="pts-add">+</span>`;
    return `
      <td><div class="day ${checked ? "in" : ncns ? "ncns" : noReply ? "noreply" : ""} ${d === p.today ? "is-today" : ""}" title="${shortDate(d)}: ${esc(details)}">
        <input type="checkbox" class="tick" ${checked ? "checked" : ""} data-action-change="attendance:tick" ${ids}
          aria-label="${esc(t.name)} checked in on ${shortDate(d)}">
        <button class="pts ${r && r.comment ? "has-note" : ""}" data-action="attendance:edit" ${ids} aria-label="Points and comment for ${esc(t.name)}, ${shortDate(d)}">${badge}</button>
      </div></td>`;
  }

  function grid(c, p, ctx) {
    if (!c.trainees.length) return `<div class="empty">No trainees yet. Add them in the Cohorts tab.</div>`;
    if (!p.days.length) return "";
    const elapsed = p.days.filter((d) => d <= p.today).length;
    const head1 = [0, 1, 2, 3].map((w) => `<th colspan="5" class="wk">Week ${w + 1}</th>`).join("");
    const head2 = p.days.map((d) => `<th class="day-h ${d === p.today ? "is-today" : ""}" title="${shortDate(d)}">${weekday(d)}<span>${Number(d.slice(8))}</span></th>`).join("");

    const rows = c.trainees.map((t) => {
      let daysIn = 0, points = 0;
      for (const d of p.days) {
        const r = recordOf(ctx, c, d, t);
        if (d <= p.today && isIn(r)) daysIn++;
        if (r && r.points) points += r.points;
      }
      return `
        <tr>
          <th class="name" scope="row">${esc(t.name)}${TrainerHub.tlTag(t)}</th>
          ${p.days.map((d) => dayCell(c, t, d, p, ctx)).join("")}
          <td class="num tot">${daysIn}/${elapsed}</td>
          <td class="num tot pts-total ${points >= 2 ? "danger" : ""}">${fmtPoints(points)}</td>
        </tr>`;
    }).join("");

    return `
      <div class="table-wrap">
        <table class="att">
          <thead>
            <tr><th></th>${head1}<th colspan="2" class="wk">Total</th></tr>
            <tr><th class="name">Trainee</th>${head2}<th class="tot" title="Days checked in so far">Days</th><th class="tot" title="Attendance points">Points</th></tr>
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
        <span class="muted small">Their Slack email didn't match any trainee's work Gmail. Pick who it was and they'll be ticked.</span>
        ${items.map(({ d, i, u }) => `
          <div class="unmatched-row">
            <span class="min0"><strong>${esc(u.name || "Unknown")}</strong> <span class="muted small">${esc(u.email || "no email on Slack")} · ${shortDate(d)} at ${S.timeLabel(u.repliedAt)}</span></span>
            <select aria-label="Assign reply to trainee" data-action-change="attendance:assign" data-cohort="${c.id}" data-date="${d}" data-index="${i}">
              <option value="">Assign to…</option>${options}
            </select>
          </div>`).join("")}
      </div>`;
  }

  function howItWorks(ctx) {
    return `
      <div class="card how">
        <strong>How it works</strong>
        <span>Each training day (Monday to Friday, 4 weeks from the start date), a Goodmorning message is posted in the cohort's Slack channel at <b>${S.POST_TIME} Central</b>. At <b>${S.CHECK_TIME}</b> everyone who replied "Goodmorning" is ticked. At <b>${S.RECHECK_TIME}</b> late replies are ticked and anyone still silent is flagged <b>Possible NCNS</b>.</span>
        <span>Tick or untick any box yourself. Click the space under a box to add <b>points</b> or a <b>comment</b>. Slack never changes a tick you set or any points.</span>
        <div class="table-wrap"><table class="points-key">
          <tr><th>Penalty points</th>${S.POINTS.map((x) => `<td>${fmtPoints(x.value)}</td>`).join("")}</tr>
          <tr><th>Shift missed</th><td>0:11–2:15</td><td>2:15–4:30</td><td>4:30–6:45</td><td>6:45–9:00</td><td>NCNS</td></tr>
        </table></div>
        ${ctx.data.mode === "local" ? `<span class="warn-text">You're using the copy saved in this browser. Slack attendance only appears in the shared dashboard link.</span>` : ""}
      </div>`;
  }

  TrainerHub.registerTool({
    id: "attendance",
    name: "Attendance Checker",
    short: "Attendance",
    description: "Daily Goodmorning check-in from Slack, with points and comments.",
    icon: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M9 15l2 2 4-4"/>',

    render(ctx) {
      const { cohorts } = ctx.data;
      if (!cohorts.length) {
        return howItWorks(ctx) + `
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
          return TrainerHub.fold({
            key: "attendance:" + c.id,
            open: p.phase === "running",
            className: "att-card " + p.phase,
            summary: `
              <div class="min0">
                <h2>${esc(c.name)}</h2>
                <div class="meta-line">
                  ${classTypePill(c.classType)}
                  ${c.slack ? `<span class="muted small">${esc(/^https?:/i.test(c.slack) ? "Slack channel linked" : c.slack)}</span>` : ""}
                  <span class="muted small">${plural(c.trainees.length, "trainee")}</span>
                  ${todayCounts(c, p, ctx)}
                </div>
              </div>
              ${phaseLabel(p)}`,
            body: `
              ${missing.length ? `<p class="warn-text">Add ${missing.join(", ")} in <a href="#cohorts">Cohorts</a> so attendance can be taken.</p>` : ""}
              ${todayStrip(c, p, ctx)}
              ${grid(c, p, ctx)}
              ${unmatched(c, p, ctx)}`,
          });
        }).join("");

      return howItWorks(ctx) + `<div class="folds">${sections}</div>`;
    },

    actions: {
      // Tick or untick a day. Slack won't change it after this.
      tick(el, ctx) {
        const { cohort, date, trainee } = el.dataset;
        ctx.data.updateRecord(cohort, date, trainee, { checkedIn: el.checked });
        ctx.rerender();
      },
      // Points, comment (and the tick) for one trainee's day.
      edit(el, ctx) {
        const { cohort, date, trainee } = el.dataset;
        const c = ctx.data.getCohort(cohort);
        const t = c.trainees.find((x) => x.id === trainee);
        const r = recordOf(ctx, c, date, t) || {};
        const was = isIn(r);
        const intro = r.repliedAt
          ? `Replied "Goodmorning" in Slack at ${S.timeLabel(r.repliedAt)}.`
          : r.flag === "possible-ncns" ? `No Slack reply by ${S.RECHECK_TIME}. Possible NCNS.`
          : r.flag === "no-reply" ? `No Slack reply by ${S.CHECK_TIME}.`
          : "No Slack reply recorded.";
        TrainerHub.openForm({
          title: `${t.name} · ${shortDate(date)}`,
          intro,
          fields: [
            { name: "checkedIn", label: "Checked in", type: "checkbox", value: was },
            { name: "points", label: "Penalty points", type: "select", options: S.POINTS, emptyLabel: "No points", value: r.points },
            { name: "comment", label: "Comment", type: "textarea", rows: 3, value: r.comment, placeholder: "e.g. Called in at 7:30, internet outage" },
          ],
          onSubmit(v) {
            const fields = { points: v.points === "" ? null : Number(v.points), comment: v.comment };
            if (v.checkedIn !== was) fields.checkedIn = v.checkedIn;
            ctx.data.updateRecord(cohort, date, trainee, fields);
            ctx.rerender();
            TrainerHub.toast(`Saved ${t.name} for ${shortDate(date)}`);
          },
        });
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
