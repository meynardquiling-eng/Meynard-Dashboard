/*
  Quiz Generator (trainer-only).

  The dashboard never builds, sends or grades quizzes. It:
    1. reads the Control Sheet (Question Bank, Generated Links, Results, Request Log, Slack Directory)
       by downloading it as XLSX through the viewer's Google Drive connector and parsing it with SheetJS;
    2. writes a new, small JSON request file into the Requests folder (it never edits an existing one);
    3. records each request in the artifact database (quizRequests) for status and double-click protection.
  The Apps Script backend (quiz/Code.gs) does the rest. See QUIZ.md.
*/
(function () {
  const { esc, plural, classTypePill, toast } = TrainerHub;
  const S = TrainerHub.schedule;

  const REGULAR = { min: 10, max: 20, default: 15 };
  const WEEKLY = { length: 50, topic: "Weekly Quiz" };
  const CLASS_PAGE = 6;
  const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const LETTERS = ["A", "B", "C", "D"];

  // UI state for this tab (per viewer, not saved).
  const ui = {
    topics: new Set(), weekly: false, topicQuery: "",
    classId: null, classQuery: "", myOnly: false, page: 0,
    day: null, length: REGULAR.default,
    submitting: false, lastSubmit: null,
    showDay: null, generationId: null,
    sheet: { status: "idle", data: null, error: null, loadedAt: null },
  };

  /* ---------------------------------------------------------------- reading the Control Sheet */

  // Finds the base64 file bytes in a download_file_content result (the connector's exact shape isn't documented).
  function extractBase64(result) {
    const candidates = [];
    const take = (v) => { if (typeof v === "string") candidates.push(v); };
    const walk = (v, depth) => {
      if (!v || depth > 3) return;
      if (typeof v === "string") { take(v); try { walk(JSON.parse(v), depth + 1); } catch { /* not JSON */ } return; }
      if (typeof v === "object") for (const k of Object.keys(v)) walk(v[k], depth + 1);
    };
    walk(result && result.payload, 0);
    for (const b of (result && result.content) || []) walk(b, 0);
    const looksB64 = (s) => s.length > 200 && /^[A-Za-z0-9+/=_\-\s]+$/.test(s);
    const hit = candidates.filter(looksB64).sort((a, b) => b.length - a.length)[0];
    return hit ? hit.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/") : null;
  }

  function validQuestion(r) {
    const filled = LETTERS.filter((L) => String(r["Choice " + L] || "").trim() !== "");
    const correct = String(r["Correct answer"] || "").trim().toUpperCase();
    const active = ["", "true", "yes", "1"].includes(String(r["Active"]).trim().toLowerCase());
    return active && String(r["Topic"] || "").trim() && String(r["Question"] || "").trim()
      && filled.length >= 2 && filled.includes(correct);
  }

  function parseWorkbook(b64) {
    const wb = XLSX.read(b64, { type: "base64" });
    const rows = (name) => (wb.Sheets[name] ? XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: "", raw: false }) : null);
    const bank = rows("Question Bank");
    if (!bank) throw { code: "bad_sheet", message: 'The Control Sheet has no "Question Bank" tab. Run setupControlSheet() in Apps Script.' };
    const topics = {};
    let invalid = 0;
    for (const r of bank) {
      const name = String(r["Topic"] || "").trim();
      if (!name) continue;
      const t = topics[name] || (topics[name] = { name, category: String(r["Category"] || "").trim() || "General", eligible: 0 });
      if (validQuestion(r)) t.eligible++; else invalid++;
    }
    const directory = {};
    for (const r of rows("Slack Directory") || []) directory[String(r["Email"]).toLowerCase()] = r;
    return {
      topics: Object.values(topics).sort((a, b) => a.name.localeCompare(b.name)),
      invalid,
      links: rows("Generated Links") || [],
      results: rows("Results") || [],
      log: rows("Request Log") || [],
      directory,
    };
  }

  function driveErrorText(e) {
    switch (e && e.code) {
      case "no_connector": return e.message;
      case "server_not_connected": return "Google Drive isn't connected. Add it in claude.ai Settings → Connectors, then reload.";
      case "needs_reauth": return "Google Drive needs to be reconnected. Reconnect it in claude.ai Settings → Connectors.";
      case "not_in_manifest": return "Google Drive access was declined for this dashboard. Allow it in the dashboard's permissions, then reload.";
      case "selection_required": return "Choose which Google Drive connection to use when claude.ai asks, then reload.";
      case "blocked_by_policy": return "Your organization's policy blocks Google Drive here.";
      case "server_unavailable": return "Google Drive didn't respond. Try again in a moment.";
      case "tool_error": return "Google Drive reported an error: " + (e.message || "unknown") + ". Check the IDs in Quiz settings and that you can open the files.";
      case "bad_sheet": return e.message;
      default: return "Couldn't reach Google Drive" + (e && e.message ? ": " + e.message : ".");
    }
  }

  async function loadSheet(ctx) {
    const cfg = ctx.data.quizConfig;
    if (!cfg || !cfg.controlSheetId) return;
    ui.sheet = { ...ui.sheet, status: "loading", error: null };
    ctx.rerender();
    try {
      const result = await ctx.data.drive("download_file_content", { fileId: cfg.controlSheetId, exportMimeType: XLSX_MIME });
      const b64 = extractBase64(result);
      if (!b64) throw { code: "tool_error", message: "the download didn't contain a spreadsheet" };
      if (typeof XLSX === "undefined") throw { code: "bad_sheet", message: "The spreadsheet reader (SheetJS) didn't load. Check your connection and reload." };
      ui.sheet = { status: "ready", data: parseWorkbook(b64), error: null, loadedAt: new Date() };
    } catch (e) {
      console.warn("quiz: load control sheet", e && e.code);
      ui.sheet = { ...ui.sheet, status: "error", error: driveErrorText(e) };
    }
    ctx.rerender();
  }

  /* ---------------------------------------------------------------- derived state */

  const parseId = (v) => {
    const s = String(v || "").trim();
    const m = s.match(/\/d\/([A-Za-z0-9_-]{10,})/) || s.match(/folders\/([A-Za-z0-9_-]{10,})/) || s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
    return m ? m[1] : s;
  };
  const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || ""));
  const shortDate = (date) => new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const stamp = (v) => (v ? String(v) : "");

  function slackStatus(sheet, email) {
    if (!isEmail(email)) return { ok: false, label: "Missing email", kind: "bad" };
    const r = sheet && sheet.directory[String(email).toLowerCase()];
    if (!r) return { ok: false, label: "Not checked", kind: "mute" };
    if (r["Status"] === "Found") return { ok: true, label: "Slack ✓", kind: "ok" };
    if (r["Status"] === "Dry run") return { ok: true, label: "Dry run", kind: "warn" };
    return { ok: false, label: "Not found", kind: "bad", detail: r["Error"] };
  }

  // Which training day the quiz is for: today if it's a training day, otherwise the trainer must pick.
  function dayInfo(cohort) {
    const p = S.progress(cohort);
    if (p.phase === "unscheduled") return { error: "This class has no start date. Add one in Cohorts so the training day can be worked out." };
    if (p.phase === "upcoming") return { error: `This class starts ${shortDate(p.days[0])}. Quizzes can be sent from Day 1.` };
    const options = p.days.map((d, i) => ({ day: i + 1, date: d })).filter((o) => o.date <= p.today);
    const today = p.phase === "running" && p.isTrainingDay ? p.index + 1 : null;
    return { options, today, needsPick: !today };
  }

  function poolSize(sheet) {
    if (!sheet) return 0;
    if (ui.weekly) return sheet.topics.reduce((n, t) => n + t.eligible, 0);
    return sheet.topics.filter((t) => ui.topics.has(t.name)).reduce((n, t) => n + t.eligible, 0);
  }

  function blockers(ctx, cohort, sheet) {
    const out = [];
    if (!ctx.data.perms.manageClasses) out.push("You need permission to manage classes.");
    if (!sheet) out.push("Load the Control Sheet.");
    if (!ui.weekly && !ui.topics.size) out.push("Pick at least one topic, or the Weekly Quiz.");
    if (!cohort) out.push("Pick a class.");
    if (cohort) {
      const d = dayInfo(cohort);
      if (d.error) out.push(d.error);
      else if (!ui.day) out.push("Pick the training day.");
      const ready = cohort.trainees.filter((t) => slackStatus(sheet, t.email).ok).length;
      if (!ready) out.push("No trainee has a matched Slack account yet. Use “Check Slack accounts”.");
    }
    const length = ui.weekly ? WEEKLY.length : ui.length;
    if (!ui.weekly && !(Number.isInteger(length) && length >= REGULAR.min && length <= REGULAR.max)) out.push(`Quiz length must be ${REGULAR.min}–${REGULAR.max}.`);
    if (sheet && (ui.weekly || ui.topics.size) && poolSize(sheet) < length) out.push(`Only ${poolSize(sheet)} eligible questions in your selection; ${length} needed.`);
    if (ui.submitting) out.push("Submitting…");
    return out;
  }

  /* ---------------------------------------------------------------- render pieces */

  function setupCard(ctx, editing) {
    const cfg = ctx.data.quizConfig || {};
    return `
      <div class="card quiz-setup">
        <h2>${editing ? "Quiz settings" : "Connect the quiz backend"}</h2>
        <p class="muted small">Paste the Control Sheet and Requests folder links (or IDs). They aren't secret; the Slack token stays in Apps Script. Setup steps are in QUIZ.md.</p>
        <label class="form-field" for="quiz-sheet-id"><span>Control Sheet</span><input id="quiz-sheet-id" value="${esc(cfg.controlSheetId || "")}" placeholder="https://docs.google.com/spreadsheets/d/…"></label>
        <label class="form-field" for="quiz-folder-id"><span>Requests folder</span><input id="quiz-folder-id" value="${esc(cfg.requestsFolderId || "")}" placeholder="https://drive.google.com/drive/folders/…"></label>
        <div class="btn-row"><button class="btn" data-action="quiz:saveConfig">Save</button>${editing ? `<button class="btn secondary" data-action="quiz:cancelConfig">Cancel</button>` : ""}</div>
      </div>`;
  }

  function sheetBar(ctx) {
    const s = ui.sheet;
    const when = s.loadedAt ? `Loaded ${s.loadedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "";
    return `
      <div class="toolbar">
        <span class="muted small">${s.status === "loading" ? "Loading Control Sheet…" : s.status === "error" ? "" : esc(when)}${s.data && s.data.invalid ? ` · ${plural(s.data.invalid, "question")} skipped (inactive or invalid)` : ""}</span>
        <div class="btn-row">
          <button class="icon-btn" data-action="quiz:refresh" title="Refresh results" aria-label="Refresh results">↻</button>
          <button class="icon-btn" data-action="quiz:editConfig" title="Quiz settings" aria-label="Quiz settings">⚙</button>
        </div>
      </div>
      ${s.status === "error" ? `<div class="banner error-banner"><div class="min0"><strong>Couldn't load the Control Sheet</strong><span>${esc(s.error)}</span></div><button class="btn secondary" data-action="quiz:refresh">Try again</button></div>` : ""}`;
  }

  function topicSection(sheet) {
    if (!sheet) return `<div class="empty">Topics appear once the Control Sheet loads.</div>`;
    const total = sheet.topics.reduce((n, t) => n + t.eligible, 0);
    const q = ui.topicQuery.trim().toLowerCase();
    const groups = {};
    for (const t of sheet.topics) {
      if (q && !t.name.toLowerCase().includes(q) && !t.category.toLowerCase().includes(q)) continue;
      (groups[t.category] ||= []).push(t);
    }
    const weeklyOk = total >= WEEKLY.length;
    const list = Object.keys(groups).sort().map((cat) => `
      <div class="topic-group"><div class="topic-cat">${esc(cat)}</div>
        ${groups[cat].map((t, i) => {
          const id = "topic-" + btoa(unescape(encodeURIComponent(t.name))).replace(/[^A-Za-z0-9]/g, "").slice(0, 40) + i;
          const disabled = !t.eligible;
          return `<label class="topic ${disabled ? "is-disabled" : ""} ${ui.weekly && !disabled ? "is-locked" : ""}" for="${id}">
            <input type="checkbox" id="${id}" data-action-change="quiz:toggleTopic" data-topic="${esc(t.name)}" ${ui.topics.has(t.name) ? "checked" : ""} ${disabled ? "disabled" : ""}>
            <span class="min0 ellipsis">${esc(t.name)}</span><span class="count">${t.eligible}</span></label>`;
        }).join("")}
      </div>`).join("");
    return `
      <div class="card">
        <div class="card-head"><h2>Topics</h2><span class="muted small">${ui.weekly ? "Weekly Quiz selected" : `${ui.topics.size} selected`}${ui.topics.size ? ` · <button class="link-btn" data-action="quiz:clearTopics">Clear all</button>` : ""}</span></div>
        <button class="weekly ${ui.weekly ? "on" : ""}" data-action="quiz:toggleWeekly" ${weeklyOk ? "" : "disabled"} aria-pressed="${ui.weekly}">
          <strong>Weekly Quiz</strong>
          <span>${weeklyOk ? `Exactly ${WEEKLY.length} questions drawn from all ${total} eligible questions.` : `Needs ${WEEKLY.length} eligible questions; the bank has ${total}. Add more to the Question Bank to use it.`}</span>
        </button>
        ${ui.weekly ? `<p class="muted small">Weekly Quiz uses every topic, so individual topics are locked. Pick a topic to switch back to a regular quiz.</p>` : ""}
        <input class="search" id="quiz-topic-search" type="search" placeholder="Search topics" value="${esc(ui.topicQuery)}" data-action-input="quiz:topicSearch" aria-label="Search topics">
        <div class="topic-list">${list || `<div class="muted small">No topics match.</div>`}</div>
      </div>`;
  }

  function classSection(ctx, cohort, sheet) {
    const q = ui.classQuery.trim().toLowerCase();
    const me = ctx.data.perms.userId;
    const all = ctx.data.cohorts.filter((c) => (!q || c.name.toLowerCase().includes(q)) && (!ui.myOnly || (me && c.createdBy === me)));
    const pages = Math.max(1, Math.ceil(all.length / CLASS_PAGE));
    ui.page = Math.min(ui.page, pages - 1);
    const shown = all.slice(ui.page * CLASS_PAGE, (ui.page + 1) * CLASS_PAGE);
    const rows = shown.map((c) => `
      <button class="class-row ${c.id === ui.classId ? "on" : ""}" data-action="quiz:pickClass" data-id="${c.id}" aria-pressed="${c.id === ui.classId}">
        <strong class="min0 ellipsis">${esc(c.name)}</strong>${classTypePill(c.classType)}<span class="muted small">${plural(c.trainees.length, "trainee")}</span>
      </button>`).join("");
    return `
      <div class="card">
        <div class="card-head"><h2>Class</h2>
          <label class="toggle" for="quiz-my-classes"><input type="checkbox" id="quiz-my-classes" data-action-change="quiz:myOnly" ${ui.myOnly ? "checked" : ""}> My Classes</label></div>
        <input class="search" id="quiz-class-search" type="search" placeholder="Search classes" value="${esc(ui.classQuery)}" data-action-input="quiz:classSearch" aria-label="Search classes">
        <div class="class-list">${rows || `<div class="muted small">${ui.myOnly ? "No classes you created match. Turn off My Classes to see all." : "No classes match."}</div>`}</div>
        ${pages > 1 ? `<div class="pager"><button class="link-btn" data-action="quiz:page" data-dir="-1" ${ui.page ? "" : "disabled"}>‹ Prev</button><span class="muted small">Page ${ui.page + 1} of ${pages}</span><button class="link-btn" data-action="quiz:page" data-dir="1" ${ui.page < pages - 1 ? "" : "disabled"}>Next ›</button></div>` : ""}
        ${cohort ? rosterPreview(ctx, cohort, sheet) : ""}
      </div>`;
  }

  function rosterPreview(ctx, cohort, sheet) {
    const statuses = cohort.trainees.map((t) => ({ t, s: slackStatus(sheet, t.email) }));
    const ready = statuses.filter((x) => x.s.ok).length;
    const pending = pendingOfType(ctx, "resolve-roster", cohort.id);
    return `
      <div class="roster-preview">
        <div class="card-head"><strong>${esc(cohort.name)} roster</strong><span class="muted small">${ready} of ${cohort.trainees.length} can receive quizzes in Slack</span></div>
        ${cohort.trainees.length ? `<ul class="mini-roster">${statuses.map(({ t, s }) => `
          <li><span class="min0 ellipsis">${esc(t.name)} <span class="muted small">${esc(t.email || "no email")}</span></span><span class="pill ${s.kind}" title="${esc(s.detail || "")}">${esc(s.label)}</span></li>`).join("")}</ul>`
          : `<div class="empty">No trainees in this class. Add them in Cohorts.</div>`}
        <div class="btn-row">
          <button class="btn secondary" data-action="quiz:resolve" ${cohort.trainees.length && !pending ? "" : "disabled"}>${pending ? "Checking Slack accounts…" : "Check Slack accounts"}</button>
          ${pending ? `<span class="muted small">Submitted ${timeOf(pending.createdAt)}. Refresh in a minute.</span>` : ""}
        </div>
      </div>`;
  }

  function settingsSection(ctx, cohort) {
    let dayHtml = `<div class="muted small">Pick a class first.</div>`;
    if (cohort) {
      const d = dayInfo(cohort);
      if (d.error) dayHtml = `<p class="warn-text">${esc(d.error)} <a href="#cohorts">Open Cohorts</a></p>`;
      else {
        if (ui.day == null && d.today) ui.day = d.today;
        dayHtml = `
          <label class="form-field" for="quiz-day"><span>Training day${d.needsPick ? " (today isn't a training day: pick one)" : ""}</span>
            <select id="quiz-day" data-action-change="quiz:setDay">
              ${d.needsPick && ui.day == null ? `<option value="" selected disabled>Pick a day…</option>` : ""}
              ${d.options.map((o) => `<option value="${o.day}" ${o.day === ui.day ? "selected" : ""}>Day ${o.day} · ${shortDate(o.date)}${o.day === d.today ? " (today)" : ""}</option>`).join("")}
            </select></label>`;
      }
    }
    return `
      <div class="card quiz-settings">
        <h2>Quiz</h2>
        ${dayHtml}
        <label class="form-field" for="quiz-length"><span>Questions per trainee ${ui.weekly ? "(Weekly Quiz is always 50)" : `(${REGULAR.min}–${REGULAR.max})`}</span>
          <input id="quiz-length" type="number" min="${REGULAR.min}" max="${REGULAR.max}" step="1" value="${ui.weekly ? WEEKLY.length : ui.length}" ${ui.weekly ? "disabled" : ""} data-action-change="quiz:setLength"></label>
      </div>`;
  }

  function generateSection(ctx, cohort, sheet) {
    const reasons = blockers(ctx, cohort, sheet);
    const pool = poolSize(sheet);
    const ready = cohort ? cohort.trainees.filter((t) => slackStatus(sheet, t.email).ok).length : 0;
    const summary = cohort && (ui.weekly || ui.topics.size)
      ? `${ui.weekly ? "Weekly Quiz" : plural(ui.topics.size, "topic")} · ${ui.weekly ? WEEKLY.length : ui.length} questions each from a pool of ${pool} · ${plural(ready, "trainee")} in ${esc(cohort.name)}${ui.day ? ` · Day ${ui.day}` : ""}`
      : "";
    return `
      <div class="card generate">
        <div class="min0">
          ${summary ? `<strong>${summary}</strong>` : `<strong>Generate quiz</strong>`}
          ${reasons.length ? `<ul class="reasons">${reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : `<span class="muted small">Each trainee gets their own random questions and answer order, sent privately in Slack.</span>`}
          ${ui.lastSubmit ? submitStatus(ctx) : ""}
        </div>
        <button class="btn big" data-action="quiz:generate" ${reasons.length ? "disabled" : ""}>Generate quiz</button>
      </div>`;
  }

  function linksFor(sheet, generationId) {
    return sheet ? sheet.links.filter((l) => String(l["Generation ID"]) === generationId) : [];
  }
  function counts(links) {
    const c = { queued: 0, delivered: 0, failed: 0, submitted: 0, awaiting: 0, dry: 0 };
    for (const l of links) {
      const d = l["Delivery status"];
      if (d === "Pending") c.queued++;
      else if (d === "Delivered") c.delivered++;
      else if (d === "Failed") c.failed++;
      else if (/^Dry run/.test(d)) c.dry++;
      if (l["Submission status"] === "Submitted") c.submitted++;
      else if (d === "Delivered") c.awaiting++;
    }
    return c;
  }
  const countChips = (c) => `
    <div class="today-stats">
      ${c.queued ? `<span class="stat-chip"><b>${c.queued}</b> Queued</span>` : ""}
      <span class="stat-chip s-present"><b>${c.delivered}</b> Delivered</span>
      ${c.dry ? `<span class="stat-chip s-late"><b>${c.dry}</b> Dry run</span>` : ""}
      ${c.failed ? `<span class="stat-chip s-absent"><b>${c.failed}</b> Failed</span>` : ""}
      <span class="stat-chip"><b>${c.awaiting}</b> Awaiting submission</span>
      <span class="stat-chip s-present"><b>${c.submitted}</b> Submitted</span>
    </div>`;

  const logFor = (sheet, requestId) => sheet && sheet.log.find((r) => String(r["Request ID"]) === requestId);
  const timeOf = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");

  function pendingOfType(ctx, type, classId) {
    const sheet = ui.sheet.data;
    return ctx.data.quizRequests.find((r) => r.type === type && r.classId === classId && r.status !== "failed" &&
      !(sheet && logFor(sheet, r.requestId) && /^(Done|Rejected)/.test(logFor(sheet, r.requestId)["Status"])));
  }

  function submitStatus(ctx) {
    const s = ui.lastSubmit;
    const sheet = ui.sheet.data;
    const log = logFor(sheet, s.requestId);
    const c = counts(linksFor(sheet, s.requestId));
    return `
      <div class="submit-status" role="status">
        <strong>Request submitted for Day ${s.day} - quizzes will be sent shortly. Refresh to check.</strong>
        ${log ? `<span class="small ${log["Status"] === "Rejected" ? "danger-text" : "muted"}">Backend: ${esc(log["Status"])}${log["Message"] ? " · " + esc(log["Message"]) : ""}</span>` : `<span class="muted small">Waiting for the backend to pick it up (runs every minute).</span>`}
        ${linksFor(sheet, s.requestId).length ? countChips(c) : ""}
      </div>`;
  }

  function resultsSection(ctx, cohort) {
    const sheet = ui.sheet.data;
    if (!cohort) return `<div class="card"><h2>Results</h2><div class="empty">Pick a class to see its quizzes and results.</div></div>`;
    // Generations: from the sheet, plus requests the backend hasn't picked up yet.
    const gens = {};
    for (const l of sheet ? sheet.links : []) {
      if (String(l["Class ID"]) !== cohort.id) continue;
      const id = String(l["Generation ID"]);
      gens[id] ||= { id, day: Number(l["Training day"]), at: stamp(l["Generation date/time"]), topics: l["Topics"], length: l["Quiz length"], links: [] };
      gens[id].links.push(l);
    }
    for (const r of ctx.data.quizRequests) {
      if (r.type !== "generate" || r.classId !== cohort.id || gens[r.requestId]) continue;
      gens[r.requestId] = { id: r.requestId, day: r.trainingDay, at: r.createdAt, topics: r.topics.join(", "), length: r.quizLength, links: [], pending: true, failed: r.status === "failed" };
    }
    const list = Object.values(gens);
    const days = [...new Set(list.map((g) => g.day))].sort((a, b) => b - a);
    if (!days.length) return `<div class="card"><h2>Results</h2><div class="empty">No quizzes generated for ${esc(cohort.name)} yet.</div></div>`;
    if (!days.includes(ui.showDay)) ui.showDay = days[0];
    const ofDay = list.filter((g) => g.day === ui.showDay).sort((a, b) => String(b.at).localeCompare(String(a.at)));
    if (!ofDay.some((g) => g.id === ui.generationId)) ui.generationId = ofDay[0].id;
    const gen = ofDay.find((g) => g.id === ui.generationId);
    const results = {};
    for (const r of sheet ? sheet.results : []) if (String(r["Generation ID"]) === gen.id) results[String(r["Trainee ID"])] = r;
    const log = logFor(sheet, gen.id);

    let body;
    if (gen.pending) {
      body = `<div class="empty">${gen.failed ? "This request couldn't be submitted to Drive." : log && log["Status"] === "Rejected" ? `The backend rejected this request: ${esc(log["Message"])}` : "Submitted. The backend hasn't created these quizzes yet; refresh in a minute."}</div>`;
    } else {
      const rows = gen.links.map((l) => {
        const r = results[String(l["Trainee ID"])];
        const delivery = l["Delivery status"];
        const quizStatus = delivery === "Failed" ? "Delivery failed" : (l["Submission status"] || "Not started");
        const qsKind = quizStatus === "Submitted" ? "ok" : quizStatus === "In progress" ? "info" : quizStatus === "Delivery failed" ? "bad" : "mute";
        return `<tr>
          <td><strong>${esc(l["Trainee name"])}</strong></td>
          <td class="small">${esc(l["Trainee email"])}${l["Slack user ID"] && l["Slack user ID"] !== "DRYRUN" ? `<br><span class="muted">${esc(l["Slack user ID"])}</span>` : ""}</td>
          <td><span class="pill ${delivery === "Delivered" ? "ok" : delivery === "Failed" ? "bad" : "mute"}">${esc(delivery)}</span>${l["Last error"] ? `<br><span class="small danger-text">${esc(l["Last error"])}</span>` : ""}</td>
          <td><span class="pill ${qsKind}">${esc(quizStatus)}</span></td>
          <td class="small">${esc(stamp(l["Submission timestamp"]))}</td>
          <td class="num"><strong>${r ? esc(r["Score percentage"]) + "%" : "—"}</strong></td>
          <td>${r ? `<button class="link-btn" data-action="quiz:viewAnswers" data-gen="${esc(gen.id)}" data-trainee="${esc(l["Trainee ID"])}">View answers</button>` : ""}</td>
        </tr>`;
      }).join("");
      body = `${countChips(counts(gen.links))}
        <div class="table-wrap"><table class="table quiz-roster">
          <thead><tr><th>Trainee</th><th>Email / Slack</th><th>Delivery</th><th>Quiz</th><th>Submitted</th><th>Score</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table></div>`;
    }

    const recent = ctx.data.quizRequests.filter((r) => r.classId === cohort.id && ["resend", "trainer-summary", "export"].includes(r.type)).slice(0, 4);
    const recentHtml = recent.length ? `<div class="recent-actions">${recent.map((r) => {
      const lg = logFor(sheet, r.requestId);
      const msg = lg ? `${lg["Status"]}${lg["Message"] ? " · " + lg["Message"] : ""}` : r.status === "failed" ? "Couldn't submit" : "Waiting for the backend";
      const link = (msg.match(/https:\/\/docs\.google\.com\/\S+/) || [])[0];
      const label = { resend: "Resend / remind", "trainer-summary": "Results summary to me", export: "Export to Sheets" }[r.type];
      return `<div class="small"><strong>${label}</strong> · ${timeOf(r.createdAt)} · <span class="muted">${esc(link ? msg.replace(link, "") : msg)}</span>${link ? ` <a href="${esc(link)}" target="_blank" rel="noopener">Open spreadsheet</a>` : ""}</div>`;
    }).join("")}</div>` : "";

    return `
      <div class="card results">
        <div class="card-head">
          <h2>Results</h2>
          <div class="btn-row">
            <label class="inline-field" for="quiz-show-day">Showing day
              <select id="quiz-show-day" data-action-change="quiz:showDay">${days.map((d) => `<option value="${d}" ${d === ui.showDay ? "selected" : ""}>Day ${d}</option>`).join("")}</select></label>
            ${ofDay.length > 1 ? `<label class="inline-field" for="quiz-gen">Quiz
              <select id="quiz-gen" data-action-change="quiz:pickGen">${ofDay.map((g) => `<option value="${esc(g.id)}" ${g.id === gen.id ? "selected" : ""}>${esc(fmtAt(g.at))} · ${esc(g.id.slice(0, 8))}</option>`).join("")}</select></label>` : ""}
            <button class="icon-btn" data-action="quiz:refresh" title="Refresh results" aria-label="Refresh results">↻</button>
            <button class="icon-btn" data-action="quiz:slackMenu" ${gen.pending ? "disabled" : ""} title="Send via Slack DM" aria-label="Send via Slack DM">✉</button>
            <button class="icon-btn" data-action="quiz:export" title="Export the day's results to Google Sheets" aria-label="Export the day's results to Google Sheets">⇪</button>
          </div>
        </div>
        <div class="muted small">Generated ${esc(fmtAt(gen.at))} · ${esc(gen.topics)} · ${esc(gen.length)} questions · ID ${esc(gen.id)}</div>
        ${body}
        ${recentHtml}
      </div>`;
  }
  const fmtAt = (v) => { const d = new Date(String(v).replace(" ", "T")); return isNaN(d) ? String(v) : d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };

  /* ---------------------------------------------------------------- submitting request files */

  async function submitRequest(ctx, type, fields, cohort) {
    const cfg = ctx.data.quizConfig;
    const requestId = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
    const createdAt = new Date().toISOString();
    const body = { requestId, type, classId: cohort.id, className: cohort.name, requestedAt: createdAt, ...fields };
    const record = { requestId, type, classId: cohort.id, trainingDay: fields.trainingDay || null, topics: fields.topics || [], quizLength: fields.quizLength || null, createdAt, createdBy: ctx.data.perms.userId, status: "submitting" };
    await ctx.data.saveQuizRequest(record);
    try {
      const title = `quiz-request-${cohort.id}-${Date.now()}.json`;
      const res = await ctx.data.drive("create_file", {
        title, parentId: cfg.requestsFolderId, textContent: JSON.stringify(body),
        contentMimeType: "application/json", disableConversionToGoogleType: true,
      });
      const fileId = res && res.payload && (res.payload.id || (res.payload.file && res.payload.file.id)) || null;
      await ctx.data.saveQuizRequest({ ...record, status: "submitted", fileId, fileName: title });
      return { ok: true, requestId };
    } catch (e) {
      console.warn("quiz: create request file", e && e.code);
      // server_unavailable/upstream_error are ambiguous for writes: the file may exist. Say so; don't retry on our own.
      const ambiguous = e && (e.code === "server_unavailable" || e.code === "upstream_error");
      await ctx.data.saveQuizRequest({ ...record, status: ambiguous ? "unknown" : "failed", error: driveErrorText(e) });
      return { ok: false, requestId, error: driveErrorText(e) + (ambiguous ? " The request may still have gone through: refresh before trying again." : "") };
    }
  }

  const traineePayload = (cohort) => cohort.trainees.map((t) => ({ id: t.id, name: t.name, email: String(t.email || "").trim().toLowerCase() }));

  /* ---------------------------------------------------------------- the tool */

  let editingConfig = false;
  let autoLoaded = false;

  TrainerHub.registerTool({
    id: "quiz",
    name: "Quiz Generator",
    short: "Quiz",
    description: "Send each trainee a private, randomized quiz in Slack. Scores are visible to trainers only.",
    icon: '<path d="M9 9a3 3 0 1 1 4 2.8c-.6.3-1 .9-1 1.6V14"/><circle cx="12" cy="17.5" r=".6" fill="currentColor"/><rect x="3" y="3" width="18" height="18" rx="3"/>',
    // Trainer-only: hidden unless the viewer can manage classes. The backend checks TRAINER_EMAILS too.
    visible: (ctx) => !!ctx.data.perms.manageClasses,

    render(ctx) {
      if (!ctx.data.perms.manageClasses) return TrainerHub.placeholder("Not available", "The Quiz Generator is for trainers who can manage classes.");
      if (ctx.data.mode === "local") return TrainerHub.placeholder("Open the shared dashboard", "The Quiz Generator works in the shared dashboard link, where it can reach Google Drive.");
      const cfg = ctx.data.quizConfig;
      if (!cfg || !cfg.controlSheetId || !cfg.requestsFolderId || editingConfig) return setupCard(ctx, editingConfig);
      if (!autoLoaded) { autoLoaded = true; setTimeout(() => loadSheet(ctx), 0); }

      const sheet = ui.sheet.data;
      const cohort = ctx.data.getCohort(ui.classId) || null;
      return `
        ${sheetBar(ctx)}
        <div class="quiz-grid">
          <div class="stack">${topicSection(sheet)}</div>
          <div class="stack">${classSection(ctx, cohort, sheet)}${settingsSection(ctx, cohort)}</div>
        </div>
        ${generateSection(ctx, cohort, sheet)}
        ${resultsSection(ctx, cohort)}`;
    },

    actions: {
      saveConfig(el, ctx) {
        const controlSheetId = parseId(document.getElementById("quiz-sheet-id").value);
        const requestsFolderId = parseId(document.getElementById("quiz-folder-id").value);
        if (!controlSheetId || !requestsFolderId) { toast("Add both the Control Sheet and the Requests folder."); return; }
        ctx.data.saveQuizConfig({ controlSheetId, requestsFolderId });
        editingConfig = false;
        autoLoaded = false;
        ui.sheet = { status: "idle", data: null, error: null, loadedAt: null };
        ctx.rerender();
      },
      editConfig(el, ctx) { editingConfig = true; ctx.rerender(); },
      cancelConfig(el, ctx) { editingConfig = false; ctx.rerender(); },
      refresh(el, ctx) { loadSheet(ctx); },

      topicSearch(el, ctx) { ui.topicQuery = el.value; ctx.rerender(); },
      toggleTopic(el, ctx) {
        const name = el.dataset.topic;
        if (el.checked) { ui.topics.add(name); ui.weekly = false; } else ui.topics.delete(name);
        ctx.rerender();
      },
      clearTopics(el, ctx) { ui.topics.clear(); ctx.rerender(); },
      toggleWeekly(el, ctx) {
        ui.weekly = !ui.weekly;
        if (ui.weekly) ui.topics.clear(); // Weekly Quiz replaces and locks the topic list
        ctx.rerender();
      },

      classSearch(el, ctx) { ui.classQuery = el.value; ui.page = 0; ctx.rerender(); },
      myOnly(el, ctx) { ui.myOnly = el.checked; ui.page = 0; ctx.rerender(); },
      page(el, ctx) { ui.page += Number(el.dataset.dir); ctx.rerender(); },
      pickClass(el, ctx) {
        if (ui.classId !== el.dataset.id) { ui.classId = el.dataset.id; ui.day = null; ui.showDay = null; ui.generationId = null; }
        ctx.rerender();
      },
      setDay(el, ctx) { ui.day = Number(el.value) || null; ctx.rerender(); },
      setLength(el, ctx) { ui.length = Math.round(Number(el.value)); ctx.rerender(); },

      async resolve(el, ctx) {
        const cohort = ctx.data.getCohort(ui.classId);
        el.disabled = true;
        const r = await submitRequest(ctx, "resolve-roster", { trainees: traineePayload(cohort) }, cohort);
        toast(r.ok ? "Checking Slack accounts. Refresh in a minute." : r.error);
        ctx.rerender();
      },

      async generate(el, ctx) {
        const cohort = ctx.data.getCohort(ui.classId);
        if (ui.submitting || blockers(ctx, cohort, ui.sheet.data).length) return; // double-click guard
        ui.submitting = true;
        el.disabled = true;
        ctx.rerender();
        const fields = {
          mode: ui.weekly ? "weekly" : "regular",
          topics: ui.weekly ? [WEEKLY.topic] : [...ui.topics],
          quizLength: ui.weekly ? WEEKLY.length : ui.length,
          trainingDay: ui.day,
          trainees: traineePayload(cohort),
        };
        const r = await submitRequest(ctx, "generate", fields, cohort);
        ui.submitting = false;
        if (r.ok) {
          ui.lastSubmit = { requestId: r.requestId, day: ui.day };
          ui.showDay = ui.day; ui.generationId = r.requestId;
          toast("Request submitted");
        } else toast(r.error);
        ctx.rerender();
      },

      showDay(el, ctx) { ui.showDay = Number(el.value); ui.generationId = null; ctx.rerender(); },
      pickGen(el, ctx) { ui.generationId = el.value; ctx.rerender(); },

      viewAnswers(el, ctx) {
        if (!ctx.data.perms.manageClasses) return;
        const sheet = ui.sheet.data;
        const r = sheet && sheet.results.find((x) => String(x["Generation ID"]) === el.dataset.gen && String(x["Trainee ID"]) === el.dataset.trainee);
        if (!r) return;
        let detail = [];
        try { detail = JSON.parse(r["Per-question detail"]); } catch { /* shown as empty */ }
        TrainerHub.showDialog({
          title: `${r["Trainee name"]} · ${r["Score percentage"]}% (${r["Score"]}/${r["Total questions"]})`,
          wide: true,
          html: detail.length ? `<table class="table answers"><thead><tr><th>#</th><th>Question</th><th>Answer given</th><th></th><th>Correct answer</th></tr></thead><tbody>
            ${detail.map((d) => `<tr><td class="num">${d.n}</td><td>${esc(d.question)}</td><td>${esc(d.answerGiven)}</td>
              <td><span class="pill ${d.correct ? "ok" : "bad"}">${d.correct ? "Correct" : "Wrong"}</span></td><td>${esc(d.correctAnswer)}</td></tr>`).join("")}
            </tbody></table>` : `<div class="empty">No answer detail stored for this result.</div>`,
        });
      },

      slackMenu(el, ctx) {
        const cohort = ctx.data.getCohort(ui.classId);
        const genId = ui.generationId;
        TrainerHub.chooseAction({
          title: "Send via Slack DM",
          message: "Nothing here sends scores or answers to trainees.",
          choices: [
            { label: "Retry failed deliveries and remind trainees who haven't finished", value: "resend" },
            { label: "Send me a results summary (trainer only)", value: "trainer-summary" },
          ],
          onChoose(type) {
            const links = linksFor(ui.sheet.data, genId);
            const message = type === "resend"
              ? `Failed deliveries (${links.filter((l) => l["Delivery status"] === "Failed").length}) are retried. Trainees who have the quiz but haven't submitted (${counts(links).awaiting}) get this DM: “Reminder: your quiz is waiting in the message above. Tap a letter to answer.”`
              : "You'll get a Slack DM listing each trainee's score and who hasn't submitted. It goes only to you (the Slack account matching your Google account).";
            TrainerHub.confirmAction({
              title: type === "resend" ? "Retry and remind?" : "Send results summary to you?",
              message, confirmLabel: "Send",
              async onConfirm() {
                const r = await submitRequest(ctx, type, { generationId: genId }, cohort);
                toast(r.ok ? "Request submitted. Refresh in a minute." : r.error);
                ctx.rerender();
              },
            });
          },
        });
      },

      export(el, ctx) {
        const cohort = ctx.data.getCohort(ui.classId);
        TrainerHub.confirmAction({
          title: `Export Day ${ui.showDay} results?`,
          message: `Creates a new Google Sheet with every submitted result for ${cohort.name}, Day ${ui.showDay}, in the export folder set in Apps Script.`,
          confirmLabel: "Export",
          async onConfirm() {
            const r = await submitRequest(ctx, "export", { trainingDay: ui.showDay }, cohort);
            toast(r.ok ? "Export requested. The link appears here in about a minute (refresh)." : r.error);
            ctx.rerender();
          },
        });
      },
    },
  });
})();
