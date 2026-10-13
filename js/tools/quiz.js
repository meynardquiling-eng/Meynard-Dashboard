/*
  Quiz Generator (trainer-only).

  Everything runs in this page, as the trainer, through their own claude.ai connectors:
    Google Drive  reads the Knowledge Library (a Google Doc; one topic per article) and creates the
                  results spreadsheet on Export.
    Claude        writes questions for a topic from that topic's article only. The trainer approves them
                  once; quizzes draw from the approved questions (the question bank).
    Slack         finds each trainee's Slack account by work email, sends each trainee their own quiz
                  as a DM from the trainer's account, and reads the trainee's reply on Refresh.
  The question bank, quizzes, answer keys, answers and scores are saved in the dashboard database,
  readable by editors only.
  The quiz logic (randomizing, message text, reading and grading replies) is in js/quiz-engine.js.
  See QUIZ.md.
*/
(function () {
  const { esc, plural, classTypePill, toast, isEmail } = TrainerHub;
  const S = TrainerHub.schedule;
  const E = TrainerHub.quizEngine;

  const REGULAR = { min: 10, max: 20, default: 15 };
  const WEEKLY = { length: 50, topic: "Weekly Quiz" };
  const CLASS_PAGE = 6;
  const BUILD_COUNT = 15; // questions Claude writes per request
  const REMINDER = (day) => `Reminder: your Day ${day} quiz is waiting in the message above. Reply with all your answers in one message, like \`1A 2C 3B\`.`;

  // UI state for this tab (per viewer, not saved).
  const ui = {
    topics: new Set(), weekly: false, topicQuery: "",
    classId: null, classQuery: "", myOnly: false, page: 0,
    day: null, length: REGULAR.default,
    busy: null,            // what's running: "check" | "generate" | "refresh" | "send" | "export" | "test"
    progress: null,        // { done, total }
    lastSubmit: null,      // { genId, day }
    showDay: null, generationId: null,
    selfId: null,          // the trainer's own Slack user id
    exportLinks: {},       // "<classId>_<day>" -> spreadsheet link
    kb: { status: "idle", topics: null, title: "", error: null, loadedAt: null },
    reviewKey: null,       // topic open in the review panel
    building: null,        // { keys: [...], done } while Claude writes questions
  };

  /* ---------------------------------------------------------------- errors */

  function connectorErrorText(server, e) {
    switch (e && e.code) {
      case "no_connector": return e.message;
      case "server_not_connected": return `${server} isn't connected. Add it in claude.ai Settings → Connectors, then reload.`;
      case "needs_reauth": return `${server} needs to be reconnected. Reconnect it in claude.ai Settings → Connectors.`;
      case "not_in_manifest": return `${server} access was declined for this dashboard. Allow it in the dashboard's permissions, then reload.`;
      case "selection_required": return `Choose which ${server} connection to use when claude.ai asks, then try again.`;
      case "blocked_by_policy": return `Your organization's policy blocks ${server} here.`;
      case "server_unavailable": return `${server} didn't respond. Try again in a moment.`;
      case "upstream_error": return `${server} had a problem. Try again in a moment.`;
      case "tool_error": return `${server} reported an error: ${e.message || "unknown"}.`;
      case "bad_doc": return e.message;
      default: return `Couldn't reach ${server}` + (e && e.message ? ": " + e.message : ".");
    }
  }
  const slackError = (e) => connectorErrorText("Slack", e);
  const driveError = (e) => connectorErrorText("Google Drive", e);
  function claudeError(e) {
    switch (e && e.code) {
      case "no_claude": return e.message;
      case "not_granted": return "Claude wasn't allowed for this dashboard. Allow it in the dashboard's permissions, then reload.";
      case "sampling_disabled": return "Claude isn't available for your account here.";
      case "rate_limited": return "You've hit a Claude usage limit. Try again later.";
      case "invalid_json": case "empty_completion": return "Claude's answer couldn't be read. Try again.";
      case "prompt_too_large": return "This article is too long to send in one go.";
      case "refused": return "Claude declined to write questions for this article.";
      case "session_expired": return "Sign in to claude.ai again, then reload.";
      default: return "Claude had a problem. Try again in a moment.";
    }
  }
  // A send that failed this way may still have gone out.
  const ambiguous = (e) => e && (e.code === "server_unavailable" || e.code === "upstream_error");
  const FATAL = ["server_not_connected", "needs_reauth", "not_in_manifest", "blocked_by_policy", "no_connector"];

  /* ---------------------------------------------------------------- reading the Knowledge Library */

  // read_file_content resolves {fileContent, title, viewUrl} (seen in a real call); read it defensively.
  function docFrom(result) {
    const p = result && result.payload;
    if (p && typeof p === "object" && typeof p.fileContent === "string") return p;
    const text = E.textOf(result);
    try { const j = JSON.parse(text); if (j && typeof j.fileContent === "string") return j; } catch { /* not JSON */ }
    return text ? { fileContent: text, title: "" } : null;
  }

  async function loadKnowledge(ctx) {
    const cfg = ctx.data.quizConfig;
    if (!cfg || !cfg.knowledgeDocId) return;
    ui.kb = { ...ui.kb, status: "loading", error: null };
    ctx.rerender();
    try {
      const doc = docFrom(await ctx.data.drive("read_file_content", { fileId: cfg.knowledgeDocId }));
      const topics = doc ? E.splitKnowledgeBase(doc.fileContent) : [];
      if (!topics.length) throw { code: "bad_doc", message: "No articles found in that Google Doc. Each article should start with a heading." };
      ui.kb = { status: "ready", topics, title: doc.title || "Knowledge Library", error: null, loadedAt: new Date() };
    } catch (e) {
      console.warn("quiz: load knowledge library", e && e.code);
      ui.kb = { ...ui.kb, status: "error", error: driveError(e) };
    }
    ctx.rerender();
  }

  /* ---------------------------------------------------------------- the question bank */

  const bankDoc = (ctx, topic) => ctx.data.quizBank[topic.key] || { key: topic.key, topic: topic.name, category: topic.category, questions: [] };
  const approvedCount = (ctx, topic) => (ctx.data.quizBank[topic.key] ? ctx.data.quizBank[topic.key].questions.filter((q) => q.status === "approved").length : 0);
  const pendingCount = (ctx, topic) => (ctx.data.quizBank[topic.key] ? ctx.data.quizBank[topic.key].questions.filter((q) => q.status === "pending").length : 0);
  const topicByKey = (key) => (ui.kb.topics || []).find((t) => t.key === key);

  // Claude writes questions for each topic from its article; they wait for the trainer's review.
  async function buildQuestions(ctx, topics) {
    ui.building = { keys: topics.map((t) => t.key), done: 0 };
    ctx.rerender();
    let added = 0, failed = null;
    for (const topic of topics) {
      const doc = bankDoc(ctx, topic);
      try {
        const reply = await ctx.data.askClaudeJson(
          E.questionPrompt({ topic: topic.name, text: topic.text, count: BUILD_COUNT, avoid: doc.questions.map((q) => q.question) }),
          { cache: false });
        const { questions } = E.checkGenerated(reply, topic.text, { existing: doc.questions.map((q) => q.question) });
        await ctx.data.saveBankTopic({ ...doc, topic: topic.name, category: topic.category, sourceHash: topic.hash, builtAt: new Date().toISOString(), questions: [...doc.questions, ...questions] });
        added += questions.length;
      } catch (e) {
        console.warn("quiz: build questions", e && e.code);
        failed = claudeError(e);
        if (e && ["not_granted", "sampling_disabled", "no_claude", "rate_limited", "session_expired"].includes(e.code)) break;
      }
      ui.building.done++;
      ctx.rerender();
    }
    ui.building = null;
    if (topics.length === 1) ui.reviewKey = topics[0].key;
    toast(failed ? `${failed}${added ? ` (${added} questions were added)` : ""}` : `${plural(added, "new question")} ready for review.`);
    ctx.rerender();
  }

  function setStatus(ctx, key, ids, status) {
    const doc = ctx.data.quizBank[key];
    if (!doc) return;
    const set = new Set(ids);
    const questions = status === "removed"
      ? doc.questions.filter((q) => !set.has(q.id))
      : doc.questions.map((q) => (set.has(q.id) ? { ...q, status } : q));
    ctx.data.saveBankTopic({ ...doc, questions });
  }

  /* ---------------------------------------------------------------- derived state */

  const parseId = (v) => {
    const s = String(v || "").trim();
    const m = s.match(/\/d\/([A-Za-z0-9_-]{10,})/) || s.match(/folders\/([A-Za-z0-9_-]{10,})/) || s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
    return m ? m[1] : s;
  };
  const normEmail = (v) => String(v || "").trim().toLowerCase();
  const shortDate = (date) => new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  const fmtAt = (iso) => (iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  function slackStatus(ctx, email) {
    if (!isEmail(email)) return { ok: false, label: "Missing email", kind: "bad", detail: "No valid work email in Cohorts." };
    const r = ctx.data.slackDirectory[normEmail(email)];
    if (!r) return { ok: false, label: "Not checked", kind: "mute", detail: "Slack account not matched yet. Use “Check Slack accounts”." };
    if (r.status === "found") return { ok: true, label: "Slack ✓", kind: "ok", userId: r.userId };
    if (r.status === "not-found") return { ok: false, label: "Not found", kind: "bad", detail: r.error };
    return { ok: false, label: "Check failed", kind: "warn", detail: r.error };
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

  const allApproved = (ctx) => E.bankQuestions(Object.values(ctx.data.quizBank));
  const pool = (ctx) => E.questionPool(allApproved(ctx), { weekly: ui.weekly, topics: [...ui.topics] });
  const quizLength = () => (ui.weekly ? WEEKLY.length : ui.length);
  const lengthOk = () => ui.weekly || (Number.isInteger(ui.length) && ui.length >= REGULAR.min && ui.length <= REGULAR.max);

  function blockers(ctx, cohort) {
    const out = [];
    if (!ctx.data.perms.manageClasses) out.push("You need permission to manage classes.");
    if (!ui.kb.topics) out.push("Load the Knowledge Library.");
    if (!ui.weekly && !ui.topics.size) out.push("Pick at least one topic, or the Weekly Quiz.");
    if (!cohort) out.push("Pick a class.");
    if (cohort) {
      const d = dayInfo(cohort);
      if (d.error) out.push(d.error);
      else if (!ui.day) out.push("Pick the training day.");
      if (!cohort.trainees.some((t) => slackStatus(ctx, t.email).ok)) out.push("No trainee has a matched Slack account yet. Use “Check Slack accounts”.");
    }
    if (!lengthOk()) out.push(`Quiz length must be ${REGULAR.min}–${REGULAR.max}.`);
    if ((ui.weekly || ui.topics.size) && pool(ctx).length < quizLength()) out.push(`Only ${pool(ctx).length} approved questions in your selection; ${quizLength()} needed. Build and approve more questions (see the topic's Review).`);
    if (ui.busy) out.push("Wait for the current Slack action to finish.");
    return out;
  }

  function quizState(q) {
    if (q.submission && q.resultsSent && q.resultsSent.at) return { label: "Results sent", kind: "ok" };
    if (q.submission) return { label: "Submitted", kind: "ok" };
    const d = q.delivery || {};
    if (d.status === "failed") return { label: "Delivery failed", kind: "bad" };
    if (d.status === "unknown") return { label: "Check Slack", kind: "warn" };
    if (d.status === "delivered") return { label: "Not started", kind: "mute" };
    return { label: "Sending…", kind: "info" };
  }
  function counts(quizzes) {
    const c = { pending: 0, delivered: 0, failed: 0, unknown: 0, submitted: 0, awaiting: 0 };
    for (const q of quizzes) {
      const s = (q.delivery || {}).status || "pending";
      c[s] = (c[s] || 0) + 1;
      if (q.submission) c.submitted++;
      else if (s === "delivered") c.awaiting++;
    }
    return c;
  }

  function finish(ctx, message) {
    ui.busy = null; ui.progress = null;
    if (message) toast(message);
    ctx.rerender();
  }
  function step(ctx) { ui.progress.done++; ctx.rerender(); }

  /* ---------------------------------------------------------------- Slack work (all as the trainer) */

  async function selfId(ctx) {
    if (!ui.selfId) ui.selfId = E.parseProfileId(E.textOf(await ctx.data.slack("slack_read_user_profile", { response_format: "detailed" })));
    if (!ui.selfId) throw { code: "tool_error", message: "couldn't read your own Slack user ID" };
    return ui.selfId;
  }

  // Looks up each trainee's Slack account by work email. Only an exact email match counts.
  async function checkSlackAccounts(ctx, cohort) {
    const people = cohort.trainees.filter((t) => isEmail(t.email));
    ui.busy = "check"; ui.progress = { done: 0, total: people.length };
    ctx.rerender();
    let found = 0, failed = 0;
    for (const t of people) {
      const email = normEmail(t.email);
      let entry;
      try {
        const res = await ctx.data.slack("slack_search_users", { keywords: [email.split("@")[0]], natural_language_query: "", response_format: "concise", limit: 20 });
        const userId = E.findUserIdByEmail(E.textOf(res), email);
        entry = userId ? { userId, status: "found" } : { userId: null, status: "not-found", error: "No Slack account uses this email." };
        if (userId) found++;
      } catch (e) {
        console.warn("quiz: slack lookup", e && e.code);
        if (e && FATAL.includes(e.code)) return finish(ctx, slackError(e));
        entry = { userId: null, status: "error", error: slackError(e) };
        failed++;
      }
      await ctx.data.saveSlackDirectory({ [email]: { ...entry, checkedAt: new Date().toISOString() } });
      step(ctx);
    }
    finish(ctx, `${found} of ${people.length} trainees matched in Slack${failed ? `; ${failed} lookups failed` : ""}.`);
  }

  /**
   * Sends one quiz DM (a first message, plus replies under it if the quiz is long). Never includes answers.
   * Returns the delivery record.
   */
  async function deliver(ctx, quiz, className) {
    const parts = E.formatQuiz({ className, day: quiz.day, questions: quiz.questions });
    const sentAfter = (Date.now() / 1000 - 2).toFixed(6); // replies are read from here if the message ts is unknown
    let first;
    try {
      first = E.parseSendResult(E.textOf(await ctx.data.slack("slack_send_message", { channel_id: quiz.slackUserId, message: parts[0] })));
    } catch (e) {
      console.warn("quiz: send", e && e.code);
      return ambiguous(e)
        ? { status: "unknown", at: new Date().toISOString(), sentAfter, error: slackError(e) + " It may still have been sent: check your DM with this trainee before resending." }
        : { status: "failed", at: new Date().toISOString(), error: slackError(e) };
    }
    const delivery = { status: "delivered", at: new Date().toISOString(), sentAfter, ts: first.ts, channel: first.channel, parts: parts.length };
    for (const part of parts.slice(1)) {
      try {
        await ctx.data.slack("slack_send_message", { channel_id: first.channel || quiz.slackUserId, message: part, ...(first.ts ? { thread_ts: first.ts } : {}) });
      } catch (e) {
        console.warn("quiz: send part", e && e.code);
        return { ...delivery, status: "failed", error: `Only part of the quiz was sent (${slackError(e)}) Resend it.` };
      }
    }
    return delivery;
  }

  async function generate(ctx, cohort) {
    const questionPool = pool(ctx);
    const length = quizLength();
    const gen = {
      id: newId(), classId: cohort.id, className: cohort.name, day: ui.day,
      mode: ui.weekly ? "weekly" : "regular", topics: ui.weekly ? [WEEKLY.topic] : [...ui.topics],
      length, poolSize: questionPool.length, createdAt: new Date().toISOString(), createdBy: ctx.data.perms.userId, status: "sending",
    };
    ui.lastSubmit = { genId: gen.id, day: gen.day };
    ui.showDay = gen.day; ui.generationId = gen.id;

    // Build and save every quiz before anything is sent, so a closed tab never loses an answer key.
    const quizzes = cohort.trainees.map((t) => {
      const s = slackStatus(ctx, t.email);
      return {
        generationId: gen.id, traineeId: t.id, classId: cohort.id, day: gen.day,
        name: t.name, email: normEmail(t.email), slackUserId: s.userId || null,
        questions: E.buildQuiz(questionPool, length),
        delivery: s.ok ? { status: "pending" } : { status: "failed", at: new Date().toISOString(), error: s.detail },
      };
    });
    await ctx.data.saveQuizGeneration(gen);
    for (const q of quizzes) await ctx.data.saveQuiz(q);

    const toSend = quizzes.filter((q) => q.delivery.status === "pending");
    ui.progress = { done: 0, total: toSend.length };
    ctx.rerender();
    for (const q of toSend) {
      q.delivery = await deliver(ctx, q, cohort.name);
      await ctx.data.saveQuiz(q);
      step(ctx);
    }
    const c = counts(quizzes);
    await ctx.data.saveQuizGeneration({ ...gen, status: "sent", sentAt: new Date().toISOString(), delivered: c.delivered, failed: c.failed + c.unknown });
    finish(ctx, `Sent ${c.delivered} of ${quizzes.length} quizzes${c.failed + c.unknown ? `; ${c.failed + c.unknown} need attention` : ""}.`);
  }

  // Reads each trainee's DM (and the quiz's thread), takes their first reply with answers, grades it.
  // Returns { graded, errors, fatal } — fatal is the error text when Slack can't be used at all.
  async function collectReplies(ctx, gen) {
    const open = ctx.data.quizzesFor(gen.id).filter((q) => q.delivery && ["delivered", "unknown"].includes(q.delivery.status) && !q.submission && q.slackUserId);
    ui.progress = { done: 0, total: open.length };
    ctx.rerender();
    let graded = 0, errors = 0;
    for (const q of open) {
      const d = q.delivery;
      const channel = d.channel || q.slackUserId;
      const after = d.ts || d.sentAfter || "0";
      try {
        const messages = E.parseMessages(E.textOf(await ctx.data.slack("slack_read_channel", { channel_id: channel, oldest: after, limit: 100, response_format: "detailed" })));
        if (d.ts) {
          const thread = await ctx.data.slack("slack_read_thread", { channel_id: channel, message_ts: d.ts, limit: 200, response_format: "detailed" });
          for (const m of E.parseMessages(E.textOf(thread))) if (!messages.some((x) => x.ts === m.ts)) messages.push(m);
        }
        const sub = E.firstSubmission(messages, q.slackUserId, after, q.questions.length);
        const next = { ...q, refreshError: null, refreshedAt: new Date().toISOString() };
        if (sub) {
          // The first reply is final: graded once, never replaced.
          next.submission = { at: new Date(Number(sub.ts) * 1000).toISOString(), ts: sub.ts, text: sub.text, answers: sub.answers };
          next.result = E.grade(q.questions, sub.answers);
          if (d.status === "unknown") next.delivery = { ...d, status: "delivered", error: null };
          graded++;
        }
        await ctx.data.saveQuiz(next);
      } catch (e) {
        console.warn("quiz: read replies", e && e.code);
        if (e && FATAL.includes(e.code)) return { graded, errors, fatal: slackError(e) };
        errors++;
        await ctx.data.saveQuiz({ ...q, refreshError: slackError(e) });
      }
      step(ctx);
    }
    return { graded, errors, fatal: null };
  }
  const readErrors = (n) => (n ? `; couldn't read ${n} DM${n > 1 ? "s" : ""}` : "");

  async function refreshResults(ctx, gen) {
    ui.busy = "refresh";
    const r = await collectReplies(ctx, gen);
    finish(ctx, r.fatal || `${plural(r.graded, "new submission")} graded${readErrors(r.errors)}.`);
  }

  // "Check answers": read and grade new replies, then DM each trainee who has answered their score and the
  // correct answers, under their quiz message. Each trainee's results go out once.
  async function checkAnswers(ctx, gen) {
    ui.busy = "check-answers";
    const r = await collectReplies(ctx, gen);
    if (r.fatal) return finish(ctx, r.fatal);
    const ready = ctx.data.quizzesFor(gen.id).filter((q) => q.result && !(q.resultsSent && q.resultsSent.at) && q.slackUserId);
    ui.busy = "send-results"; ui.progress = { done: 0, total: ready.length };
    ctx.rerender();
    let sent = 0, failed = 0;
    for (const q of ready) {
      const d = q.delivery || {};
      const channel = d.channel || q.slackUserId;
      let error = null;
      for (const part of E.formatResults({ className: gen.className, day: gen.day, result: q.result })) {
        try {
          await ctx.data.slack("slack_send_message", { channel_id: channel, message: part, ...(d.ts ? { thread_ts: d.ts } : {}) });
        } catch (e) {
          console.warn("quiz: send results", e && e.code);
          error = slackError(e) + (ambiguous(e) ? " It may still have been sent: check your DM before sending again." : "");
          if (e && FATAL.includes(e.code)) { await ctx.data.saveQuiz({ ...q, resultsError: error }); return finish(ctx, error); }
          break;
        }
      }
      if (error) { failed++; await ctx.data.saveQuiz({ ...q, resultsError: error }); }
      else { sent++; await ctx.data.saveQuiz({ ...q, resultsSent: { at: new Date().toISOString() }, resultsError: null }); }
      step(ctx);
    }
    const waiting = ctx.data.quizzesFor(gen.id).filter((q) => q.delivery && q.delivery.status === "delivered" && !q.submission).length;
    finish(ctx, `${plural(r.graded, "new submission")} graded. Results sent to ${plural(sent, "trainee")}${failed ? `; ${failed} failed` : ""}${waiting ? `; ${waiting} still haven't answered` : ""}${readErrors(r.errors)}.`);
  }

  async function retryFailed(ctx, gen, cohort) {
    const list = ctx.data.quizzesFor(gen.id).filter((q) => q.delivery && q.delivery.status === "failed" && !q.submission);
    if (!list.length) { toast("No failed deliveries."); return; }
    ui.busy = "send"; ui.progress = { done: 0, total: list.length };
    ctx.rerender();
    let sent = 0;
    for (const q of list) {
      const t = cohort.trainees.find((x) => x.id === q.traineeId);
      const s = slackStatus(ctx, t ? t.email : q.email);
      const next = { ...q, slackUserId: s.userId || q.slackUserId };
      if (!next.slackUserId) next.delivery = { ...q.delivery, at: new Date().toISOString(), error: s.detail || "No Slack account matched." };
      else { next.delivery = await deliver(ctx, next, cohort.name); if (next.delivery.status === "delivered") sent++; }
      await ctx.data.saveQuiz(next);
      step(ctx);
    }
    finish(ctx, `Resent ${sent} of ${list.length}.`);
  }

  async function remind(ctx, gen) {
    const list = ctx.data.quizzesFor(gen.id).filter((q) => q.delivery && q.delivery.status === "delivered" && !q.submission);
    if (!list.length) { toast("Everyone who got the quiz has answered."); return; }
    ui.busy = "send"; ui.progress = { done: 0, total: list.length };
    ctx.rerender();
    let sent = 0, failed = 0;
    for (const q of list) {
      try {
        await ctx.data.slack("slack_send_message", { channel_id: q.delivery.channel || q.slackUserId, message: REMINDER(q.day) });
        sent++;
        await ctx.data.saveQuiz({ ...q, remindedAt: new Date().toISOString() });
      } catch (e) { console.warn("quiz: remind", e && e.code); failed++; }
      step(ctx);
    }
    finish(ctx, `Reminded ${plural(sent, "trainee")}${failed ? `; ${failed} failed` : ""}.`);
  }

  // Results summary, sent only to the trainer's own Slack DM.
  async function sendSummary(ctx, gen) {
    ui.busy = "send"; ctx.rerender();
    try {
      const me = await selfId(ctx);
      const quizzes = ctx.data.quizzesFor(gen.id).sort((a, b) => a.name.localeCompare(b.name));
      const done = quizzes.filter((q) => q.result);
      const avg = done.length ? Math.round(done.reduce((n, q) => n + q.result.pct, 0) / done.length) : null;
      const rows = quizzes.map((q) => `| ${q.name.replace(/\|/g, "\\|")} | ${q.result ? `${q.result.pct}% (${q.result.score}/${q.result.total})` : quizState(q).label} |`);
      const text = `**${gen.className} · Day ${gen.day} quiz results** (only you can see this)\n${done.length} of ${quizzes.length} submitted${avg != null ? ` · average ${avg}%` : ""}\n\n| Trainee | Score |\n|---|---|\n${rows.join("\n")}`;
      await ctx.data.slack("slack_send_message", { channel_id: me, message: text.slice(0, 4900) });
      finish(ctx, "Summary sent to your own Slack DMs.");
    } catch (e) { console.warn("quiz: summary", e && e.code); finish(ctx, slackError(e)); }
  }

  // A real quiz from the current selection, sent only to the trainer. Nothing is saved.
  async function sendTest(ctx, cohort) {
    ui.busy = "test"; ctx.rerender();
    try {
      const me = await selfId(ctx);
      const quiz = { day: ui.day || 1, slackUserId: me, questions: E.buildQuiz(pool(ctx), quizLength()) };
      const d = await deliver(ctx, quiz, (cohort ? cohort.name : "Class") + " (TEST)");
      finish(ctx, d.status === "delivered" ? "Test quiz sent to your own Slack DMs." : d.error);
    } catch (e) { console.warn("quiz: test", e && e.code); finish(ctx, e && e.code ? slackError(e) : String((e && e.message) || e)); }
  }

  /* ---------------------------------------------------------------- export */

  const csvCell = (v) => { const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

  async function exportDay(ctx, cohort, day) {
    const gens = ctx.data.quizGenerations.filter((g) => g.classId === cohort.id && g.day === day);
    const rows = [["Class", "Training day", "Generated", "Generation ID", "Topics", "Trainee", "Email", "Slack user ID", "Delivery", "Quiz status", "Submitted", "Score", "Total", "Score %", "Answers"]];
    for (const g of gens) for (const q of ctx.data.quizzesFor(g.id).sort((a, b) => a.name.localeCompare(b.name))) {
      rows.push([cohort.name, day, fmtAt(g.createdAt), g.id, g.topics.join(", "), q.name, q.email, q.slackUserId || "", (q.delivery || {}).status || "",
        quizState(q).label, q.submission ? fmtAt(q.submission.at) : "", q.result ? q.result.score : "", q.result ? q.result.total : "", q.result ? q.result.pct : "",
        q.result ? q.result.detail.map((d) => `${d.n}:${d.answerGiven.split(".")[0]}${d.correct ? "✓" : "✗"}`).join(" ") : ""]);
    }
    ui.busy = "export"; ctx.rerender();
    try {
      const cfg = ctx.data.quizConfig || {};
      const res = await ctx.data.drive("create_file", {
        title: `Quiz results - ${cohort.name} - Day ${day} - ${new Date().toISOString().slice(0, 10)}`,
        textContent: rows.map((r) => r.map(csvCell).join(",")).join("\n"),
        contentMimeType: "text/csv",
        ...(cfg.exportFolderId ? { parentId: cfg.exportFolderId } : {}),
      });
      const text = E.textOf(res);
      const id = (res && res.payload && (res.payload.id || (res.payload.file && res.payload.file.id))) || (text.match(/"id"\s*:\s*"([A-Za-z0-9_-]{20,})"/) || [])[1];
      const link = (text.match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+/) || [])[0] || (id ? `https://docs.google.com/spreadsheets/d/${id}` : null);
      ui.exportLinks[`${cohort.id}_${day}`] = link || "created";
      finish(ctx, "Spreadsheet created.");
    } catch (e) { console.warn("quiz: export", e && e.code); finish(ctx, driveError(e)); }
  }

  /* ---------------------------------------------------------------- render pieces */

  function setupCard(ctx, editing) {
    const cfg = ctx.data.quizConfig || {};
    return `
      <div class="card quiz-setup">
        <h2>${editing ? "Quiz settings" : "Connect your Knowledge Library"}</h2>
        <p class="muted small">Paste the link to the Google Doc that holds your knowledge base. Each article becomes a topic, and Claude writes questions from it for you to approve. Quizzes are sent from your own Slack account. Details are in QUIZ.md.</p>
        <label class="form-field" for="quiz-doc-id"><span>Knowledge Library (Google Doc)</span><input id="quiz-doc-id" value="${esc(cfg.knowledgeDocId || "")}" placeholder="https://docs.google.com/document/d/…"></label>
        <label class="form-field" for="quiz-folder-id"><span>Export folder (leave blank for My Drive)</span><input id="quiz-folder-id" value="${esc(cfg.exportFolderId || "")}" placeholder="https://drive.google.com/drive/folders/…"></label>
        <div class="btn-row"><button class="btn" data-action="quiz:saveConfig">Save</button>${editing ? `<button class="btn secondary" data-action="quiz:cancelConfig">Cancel</button>` : ""}</div>
      </div>`;
  }

  function knowledgeBar() {
    const k = ui.kb;
    const when = k.loadedAt ? `${esc(k.title)} · ${plural(k.topics.length, "topic")} · loaded ${k.loadedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "";
    return `
      <div class="toolbar">
        <span class="muted small">${k.status === "loading" ? "Reading the Knowledge Library…" : k.status === "error" ? "" : when}</span>
        <div class="btn-row">
          <button class="icon-btn" data-action="quiz:reloadKnowledge" title="Reload the Knowledge Library" aria-label="Reload the Knowledge Library">⟳</button>
          <button class="icon-btn" data-action="quiz:editConfig" title="Quiz settings" aria-label="Quiz settings">⚙</button>
        </div>
      </div>
      ${k.status === "error" ? `<div class="banner error-banner"><div class="min0"><strong>Couldn't read the Knowledge Library</strong><span>${esc(k.error)}</span></div><button class="btn secondary" data-action="quiz:reloadKnowledge">Try again</button></div>` : ""}`;
  }

  function topicSection(ctx) {
    const topics = ui.kb.topics;
    if (!topics) return `<div class="empty">Topics appear once the Knowledge Library loads.</div>`;
    const total = allApproved(ctx).length;
    const q = ui.topicQuery.trim().toLowerCase();
    const groups = {};
    for (const t of topics) {
      if (q && !t.name.toLowerCase().includes(q) && !t.category.toLowerCase().includes(q)) continue;
      (groups[t.category] ||= []).push(t);
    }
    const weeklyOk = total >= WEEKLY.length;
    const short = topics.filter((t) => ui.topics.has(t.name) && approvedCount(ctx, t) < quizLength());
    const list = Object.keys(groups).map((cat) => `
      <div class="topic-group"><div class="topic-cat">${esc(cat)}</div>
        ${groups[cat].map((t) => {
          const id = "topic-" + t.key;
          const ready = approvedCount(ctx, t), waiting = pendingCount(ctx, t);
          return `<div class="topic-row ${ui.reviewKey === t.key ? "on" : ""}">
            <label class="topic ${ui.weekly ? "is-locked" : ""}" for="${id}">
              <input type="checkbox" id="${id}" data-action-change="quiz:toggleTopic" data-topic="${esc(t.name)}" ${ui.topics.has(t.name) ? "checked" : ""}>
              <span class="min0 ellipsis">${esc(t.name)}</span><span class="count" title="Approved questions">${ready}</span></label>
            <button class="link-btn small" data-action="quiz:review" data-key="${t.key}">${waiting ? `Review ${waiting}` : ready ? "Questions" : "Build"}</button>
          </div>`;
        }).join("")}
      </div>`).join("");
    return `
      <div class="card">
        <div class="card-head"><h2>Topics</h2><span class="muted small">${ui.weekly ? "Weekly Quiz selected" : `${ui.topics.size} selected`}${ui.topics.size ? ` · <button class="link-btn" data-action="quiz:clearTopics">Clear all</button>` : ""}</span></div>
        <button class="weekly ${ui.weekly ? "on" : ""}" data-action="quiz:toggleWeekly" ${weeklyOk ? "" : "disabled"} aria-pressed="${ui.weekly}">
          <strong>Weekly Quiz</strong>
          <span>${weeklyOk ? `Exactly ${WEEKLY.length} questions drawn from all ${total} approved questions.` : `Needs ${WEEKLY.length} approved questions; the bank has ${total}. Build and approve questions for more topics to use it.`}</span>
        </button>
        ${ui.weekly ? `<p class="muted small">Weekly Quiz uses every topic, so individual topics are locked. Pick a topic to switch back to a regular quiz.</p>` : ""}
        ${short.length && !ui.weekly ? `<div class="build-hint"><span class="small">${plural(short.length, "selected topic")} ${short.length === 1 ? "has" : "have"} fewer than ${quizLength()} approved questions.</span>
          <button class="btn secondary" data-action="quiz:buildSelected" ${ui.building || ui.busy ? "disabled" : ""}>${ui.building ? `Writing questions ${ui.building.done + 1} of ${ui.building.keys.length}…` : `Have Claude write questions`}</button></div>` : ""}
        <input class="search" id="quiz-topic-search" type="search" placeholder="Search topics" value="${esc(ui.topicQuery)}" data-action-input="quiz:topicSearch" aria-label="Search topics">
        <div class="topic-list">${list || `<div class="muted small">No topics match.</div>`}</div>
        <p class="muted small">The number is how many approved questions each topic has.</p>
      </div>`;
  }

  // The question bank for one topic: Claude's questions waiting for review, and the approved ones.
  function reviewSection(ctx) {
    const topic = topicByKey(ui.reviewKey);
    if (!topic) return "";
    const doc = bankDoc(ctx, topic);
    const pending = doc.questions.filter((q) => q.status === "pending");
    const approved = doc.questions.filter((q) => q.status === "approved");
    const buildingThis = ui.building && ui.building.keys[ui.building.done] === topic.key;
    const changed = doc.sourceHash && doc.sourceHash !== topic.hash;
    const item = (q) => `
      <li class="bank-q ${q.status}">
        <div class="bank-q-head"><strong>${esc(q.question)}</strong>
          <span class="btn-row">${q.status === "pending" ? `<button class="btn small" data-action="quiz:approve" data-id="${esc(q.id)}">Approve</button>` : `<span class="pill ok">Approved</span>`}
          <button class="btn small secondary" data-action="quiz:removeQuestion" data-id="${esc(q.id)}">Remove</button></span></div>
        <ol class="bank-choices" type="A">${E.LETTERS.map((L) => `<li class="${L === q.correct ? "correct" : ""}">${esc(q.choices[L])}${L === q.correct ? " ✓" : ""}</li>`).join("")}</ol>
        ${q.explanation ? `<div class="small muted">${esc(q.explanation)}</div>` : ""}
        ${q.quote ? `<div class="small bank-quote ${q.quoteFound ? "" : "warn-text"}">${q.quoteFound ? "From the article" : "Quote not found in the article, check this one"}: “${esc(q.quote)}”</div>` : `<div class="small warn-text">No supporting quote, check this one.</div>`}
      </li>`;
    return `
      <div class="card review">
        <div class="card-head">
          <div class="min0"><h2>${esc(topic.name)}</h2><span class="muted small">${esc(topic.category)} · ${approved.length} approved · ${pending.length} waiting for review</span></div>
          <div class="btn-row">
            <button class="btn secondary" data-action="quiz:buildOne" ${ui.building || ui.busy ? "disabled" : ""}>${buildingThis ? "Claude is writing…" : doc.questions.length ? `Write ${BUILD_COUNT} more` : `Write ${BUILD_COUNT} questions`}</button>
            ${pending.length ? `<button class="btn" data-action="quiz:approveAll">Approve all ${pending.length}</button>` : ""}
            <button class="icon-btn" data-action="quiz:closeReview" title="Close" aria-label="Close">×</button>
          </div>
        </div>
        <p class="muted small">Claude writes questions only from this article in your Knowledge Library. Approve the ones that are right; only approved questions go into quizzes.</p>
        ${changed ? `<p class="small warn-text">This article has changed since these questions were written. Check they still match.</p>` : ""}
        ${buildingThis ? `<div class="muted small" role="status">Claude is reading the article and writing questions. This can take up to a minute.</div>` : ""}
        ${pending.length ? `<h3>Waiting for review</h3><ul class="bank-list">${pending.map(item).join("")}</ul>` : ""}
        ${approved.length ? `<details class="bank-approved" ${pending.length ? "" : "open"}><summary>Approved questions (${approved.length})</summary><ul class="bank-list">${approved.map(item).join("")}</ul></details>` : ""}
        ${!doc.questions.length && !buildingThis ? `<div class="empty">No questions yet. Click “Write ${BUILD_COUNT} questions”.</div>` : ""}
      </div>`;
  }

  function classSection(ctx, cohort) {
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
        ${cohort ? rosterPreview(ctx, cohort) : ""}
      </div>`;
  }

  const progressText = () => (ui.progress ? ` ${ui.progress.done} of ${ui.progress.total}…` : "…");

  function rosterPreview(ctx, cohort) {
    const statuses = cohort.trainees.map((t) => ({ t, s: slackStatus(ctx, t.email) }));
    const ready = statuses.filter((x) => x.s.ok).length;
    return `
      <div class="roster-preview">
        <div class="card-head"><strong>${esc(cohort.name)} roster</strong><span class="muted small">${ready} of ${cohort.trainees.length} can receive quizzes in Slack</span></div>
        ${cohort.trainees.length ? `<ul class="mini-roster">${statuses.map(({ t, s }) => `
          <li><span class="min0 ellipsis">${esc(t.name)} <span class="muted small">${esc(t.email || "no email")}</span></span><span class="pill ${s.kind}" title="${esc(s.detail || "")}">${esc(s.label)}</span></li>`).join("")}</ul>`
          : `<div class="empty">No trainees in this class. Add them in Cohorts.</div>`}
        <div class="btn-row">
          <button class="btn secondary" data-action="quiz:check" ${cohort.trainees.length && !ui.busy ? "" : "disabled"}>${ui.busy === "check" ? "Checking Slack accounts" + progressText() : "Check Slack accounts"}</button>
          <span class="muted small">Looks up each work email in Slack. Nothing is sent.</span>
        </div>
      </div>`;
  }

  function settingsSection(cohort) {
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
          <input id="quiz-length" type="number" min="${REGULAR.min}" max="${REGULAR.max}" step="1" value="${quizLength()}" ${ui.weekly ? "disabled" : ""} data-action-change="quiz:setLength"></label>
      </div>`;
  }

  function generateSection(ctx, cohort) {
    const reasons = blockers(ctx, cohort);
    const ready = cohort ? cohort.trainees.filter((t) => slackStatus(ctx, t.email).ok).length : 0;
    const summary = cohort && (ui.weekly || ui.topics.size)
      ? `${ui.weekly ? "Weekly Quiz" : plural(ui.topics.size, "topic")} · ${quizLength()} questions each from a pool of ${pool(ctx).length} · ${plural(ready, "trainee")} in ${esc(cohort.name)}${ui.day ? ` · Day ${ui.day}` : ""}`
      : "";
    const canSample = (ui.weekly || ui.topics.size) && lengthOk() && pool(ctx).length >= quizLength();
    return `
      <div class="card generate">
        <div class="min0">
          ${summary ? `<strong>${summary}</strong>` : `<strong>Generate quiz</strong>`}
          ${reasons.length ? `<ul class="reasons">${reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : `<span class="muted small">Each trainee gets their own random questions and answer order, sent privately from your Slack account.</span>`}
          <div class="btn-row">
            <button class="link-btn" data-action="quiz:preview" ${canSample ? "" : "disabled"}>Preview message</button>
            <button class="link-btn" data-action="quiz:test" ${canSample && !ui.busy ? "" : "disabled"}>${ui.busy === "test" ? "Sending test…" : "Send me a test quiz"}</button>
          </div>
          ${ui.lastSubmit ? submitStatus(ctx) : ""}
        </div>
        <button class="btn big" data-action="quiz:generate" ${reasons.length ? "disabled" : ""}>${ui.busy === "generate" ? "Sending" + progressText() : "Generate quiz"}</button>
      </div>`;
  }

  function countChips(c) {
    return `
      <div class="today-stats">
        ${c.pending ? `<span class="stat-chip"><b>${c.pending}</b> Sending</span>` : ""}
        <span class="stat-chip s-present"><b>${c.delivered}</b> Delivered</span>
        ${c.unknown ? `<span class="stat-chip s-late"><b>${c.unknown}</b> Check Slack</span>` : ""}
        ${c.failed ? `<span class="stat-chip s-absent"><b>${c.failed}</b> Failed</span>` : ""}
        <span class="stat-chip"><b>${c.awaiting}</b> Awaiting submission</span>
        <span class="stat-chip s-present"><b>${c.submitted}</b> Submitted</span>
      </div>`;
  }

  function submitStatus(ctx) {
    const s = ui.lastSubmit;
    const quizzes = ctx.data.quizzesFor(s.genId);
    return `
      <div class="submit-status" role="status">
        <strong>Request submitted for Day ${s.day} - quizzes will be sent shortly. Refresh to check.</strong>
        ${ui.busy === "generate" && ui.progress ? `<span class="muted small">Sending from your Slack: ${ui.progress.done} of ${ui.progress.total}. Keep this page open until it finishes.</span>` : ""}
        ${quizzes.length ? countChips(counts(quizzes)) : ""}
      </div>`;
  }

  function resultsSection(ctx, cohort) {
    if (!cohort) return `<div class="card"><h2>Results</h2><div class="empty">Pick a class to see its quizzes and results.</div></div>`;
    const gens = ctx.data.quizGenerations.filter((g) => g.classId === cohort.id);
    const days = [...new Set(gens.map((g) => g.day))].sort((a, b) => b - a);
    if (!days.length) return `<div class="card"><h2>Results</h2><div class="empty">No quizzes generated for ${esc(cohort.name)} yet.</div></div>`;
    if (!days.includes(ui.showDay)) ui.showDay = days[0];
    const ofDay = gens.filter((g) => g.day === ui.showDay).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    if (!ofDay.some((g) => g.id === ui.generationId)) ui.generationId = ofDay[0].id;
    const gen = ofDay.find((g) => g.id === ui.generationId);
    const quizzes = ctx.data.quizzesFor(gen.id).sort((a, b) => a.name.localeCompare(b.name));

    const rows = quizzes.map((q) => {
      const st = quizState(q);
      const d = q.delivery || {};
      const dKind = { delivered: "ok", failed: "bad", unknown: "warn" }[d.status] || "mute";
      const dLabel = { delivered: "Delivered", failed: "Failed", unknown: "Unconfirmed" }[d.status] || "Sending";
      const answered = q.submission ? q.submission.answers.filter(Boolean).length : 0;
      return `<tr>
        <td><strong>${esc(q.name)}</strong></td>
        <td class="small">${esc(q.email)}${q.slackUserId ? `<br><span class="muted">${esc(q.slackUserId)}</span>` : ""}</td>
        <td><span class="pill ${dKind}">${dLabel}</span>${d.error ? `<br><span class="small danger-text">${esc(d.error)}</span>` : ""}${q.refreshError ? `<br><span class="small danger-text">Couldn't read replies: ${esc(q.refreshError)}</span>` : ""}${q.resultsError && !(q.resultsSent && q.resultsSent.at) ? `<br><span class="small danger-text">Results not sent: ${esc(q.resultsError)}</span>` : ""}</td>
        <td><span class="pill ${st.kind}">${esc(st.label)}</span>${q.submission && answered < q.questions.length ? `<br><span class="small muted">Answered ${answered} of ${q.questions.length}</span>` : ""}</td>
        <td class="small">${q.submission ? esc(fmtAt(q.submission.at)) : ""}</td>
        <td class="num"><strong>${q.result ? esc(q.result.pct) + "%" : "—"}</strong></td>
        <td>${q.result ? `<button class="link-btn" data-action="quiz:viewAnswers" data-gen="${esc(gen.id)}" data-trainee="${esc(q.traineeId)}">View answers</button>` : ""}</td>
      </tr>`;
    }).join("");
    const link = ui.exportLinks[`${cohort.id}_${ui.showDay}`];
    const busyLabel = { refresh: "Reading replies from Slack", "check-answers": "Reading and grading replies", "send-results": "Sending results to trainees", send: "Sending", export: "Creating spreadsheet" }[ui.busy];
    const stalled = gen.status === "sending" && !(ui.busy === "generate" && ui.lastSubmit && ui.lastSubmit.genId === gen.id);

    return `
      <div class="card results">
        <div class="card-head">
          <h2>Results</h2>
          <div class="btn-row">
            <label class="inline-field" for="quiz-show-day">Showing day
              <select id="quiz-show-day" data-action-change="quiz:showDay">${days.map((d) => `<option value="${d}" ${d === ui.showDay ? "selected" : ""}>Day ${d}</option>`).join("")}</select></label>
            ${ofDay.length > 1 ? `<label class="inline-field" for="quiz-gen">Quiz
              <select id="quiz-gen" data-action-change="quiz:pickGen">${ofDay.map((g) => `<option value="${esc(g.id)}" ${g.id === gen.id ? "selected" : ""}>${esc(fmtAt(g.createdAt))} · ${esc(g.id.slice(0, 8))}</option>`).join("")}</select></label>` : ""}
            <button class="btn" data-action="quiz:checkAnswers" ${ui.busy ? "disabled" : ""}>${ui.busy === "check-answers" || ui.busy === "send-results" ? "Checking" + progressText() : "Check answers"}</button>
            <button class="icon-btn" data-action="quiz:refresh" ${ui.busy ? "disabled" : ""} title="Refresh: read and grade replies without sending anything" aria-label="Refresh results">↻</button>
            <button class="icon-btn" data-action="quiz:slackMenu" ${ui.busy ? "disabled" : ""} title="Send via Slack DM" aria-label="Send via Slack DM">✉</button>
            <button class="icon-btn" data-action="quiz:export" ${ui.busy ? "disabled" : ""} title="Export the day's results to Google Sheets" aria-label="Export the day's results to Google Sheets">⇪</button>
          </div>
        </div>
        <div class="muted small">Generated ${esc(fmtAt(gen.createdAt))} · ${esc(gen.topics.join(", "))} · ${esc(gen.length)} questions · ID ${esc(gen.id)}</div>
        ${stalled ? `<p class="small danger-text">Sending stopped before it finished (the page was closed?). Rows still “Sending” were not sent; check your DMs, then use ✉ to resend failed ones.</p>` : ""}
        ${busyLabel ? `<div class="muted small" role="status">${busyLabel}${progressText()}</div>` : ""}
        ${link ? `<div class="small">Exported: ${link === "created" ? "a new spreadsheet is in your Google Drive." : `<a href="${esc(link)}" target="_blank" rel="noopener">Open spreadsheet</a>`}</div>` : ""}
        ${countChips(counts(quizzes))}
        <div class="table-wrap"><table class="table quiz-roster">
          <thead><tr><th>Trainee</th><th>Email / Slack</th><th>Delivery</th><th>Quiz</th><th>Submitted</th><th>Score</th><th></th></tr></thead>
          <tbody>${rows}</tbody></table></div>
      </div>`;
  }

  /* ---------------------------------------------------------------- the tool */

  let editingConfig = false;
  let autoLoaded = false;
  const currentGen = (ctx) => ctx.data.quizGenerations.find((g) => g.id === ui.generationId);

  TrainerHub.registerTool({
    id: "quiz",
    name: "Quiz Generator",
    short: "Quiz",
    description: "Send each trainee a private, randomized quiz from your Slack. Scores are visible to trainers only.",
    icon: '<path d="M9 9a3 3 0 1 1 4 2.8c-.6.3-1 .9-1 1.6V14"/><circle cx="12" cy="17.5" r=".6" fill="currentColor"/><rect x="3" y="3" width="18" height="18" rx="3"/>',
    // Trainer-only: hidden unless the viewer can manage classes. Quiz records are editor-only in the database too.
    visible: (ctx) => !!ctx.data.perms.manageClasses,

    render(ctx) {
      if (!ctx.data.perms.manageClasses) return TrainerHub.placeholder("Not available", "The Quiz Generator is for trainers who can manage classes.");
      if (ctx.data.mode === "local") return TrainerHub.placeholder("Open the shared dashboard", "The Quiz Generator works in the shared dashboard link, where it can reach Google Drive and Slack.");
      const cfg = ctx.data.quizConfig;
      if (!cfg || !cfg.knowledgeDocId || editingConfig) return setupCard(ctx, editingConfig);
      if (!autoLoaded) { autoLoaded = true; setTimeout(() => loadKnowledge(ctx), 0); }

      const cohort = ctx.data.getCohort(ui.classId) || null;
      return `
        ${knowledgeBar()}
        <div class="quiz-grid">
          <div class="stack">${topicSection(ctx)}</div>
          <div class="stack">${classSection(ctx, cohort)}${settingsSection(cohort)}</div>
        </div>
        ${reviewSection(ctx)}
        ${generateSection(ctx, cohort)}
        ${resultsSection(ctx, cohort)}`;
    },

    actions: {
      saveConfig(el, ctx) {
        const knowledgeDocId = parseId(document.getElementById("quiz-doc-id").value);
        const exportFolderId = parseId(document.getElementById("quiz-folder-id").value);
        if (!knowledgeDocId) { toast("Add the Knowledge Library link."); return; }
        ctx.data.saveQuizConfig({ knowledgeDocId, exportFolderId });
        editingConfig = false;
        autoLoaded = false;
        ui.kb = { status: "idle", topics: null, title: "", error: null, loadedAt: null };
        ctx.rerender();
      },
      editConfig(el, ctx) { editingConfig = true; ctx.rerender(); },
      cancelConfig(el, ctx) { editingConfig = false; ctx.rerender(); },
      reloadKnowledge(el, ctx) { loadKnowledge(ctx); },

      review(el, ctx) { ui.reviewKey = ui.reviewKey === el.dataset.key ? null : el.dataset.key; ctx.rerender(); },
      closeReview(el, ctx) { ui.reviewKey = null; ctx.rerender(); },
      buildOne(el, ctx) {
        const topic = topicByKey(ui.reviewKey);
        if (!topic || ui.building || ui.busy) return;
        buildQuestions(ctx, [topic]);
      },
      buildSelected(el, ctx) {
        if (ui.building || ui.busy) return;
        const list = ui.kb.topics.filter((t) => ui.topics.has(t.name) && approvedCount(ctx, t) < quizLength());
        if (list.length) buildQuestions(ctx, list);
      },
      approve(el, ctx) { setStatus(ctx, ui.reviewKey, [el.dataset.id], "approved"); },
      approveAll(el, ctx) {
        const doc = ctx.data.quizBank[ui.reviewKey];
        if (doc) setStatus(ctx, ui.reviewKey, doc.questions.filter((q) => q.status === "pending").map((q) => q.id), "approved");
      },
      removeQuestion(el, ctx) {
        const id = el.dataset.id;
        TrainerHub.confirmAction({
          title: "Remove this question?",
          message: "It's taken out of the question bank. Quizzes already sent keep their own copy.",
          confirmLabel: "Remove",
          onConfirm: () => setStatus(ctx, ui.reviewKey, [id], "removed"),
        });
      },

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
        if (ui.classId !== el.dataset.id) { ui.classId = el.dataset.id; ui.day = null; ui.showDay = null; ui.generationId = null; ui.lastSubmit = null; }
        ctx.rerender();
      },
      setDay(el, ctx) { ui.day = Number(el.value) || null; ctx.rerender(); },
      setLength(el, ctx) { ui.length = Math.round(Number(el.value)); ctx.rerender(); },

      check(el, ctx) {
        if (ui.busy) return;
        checkSlackAccounts(ctx, ctx.data.getCohort(ui.classId));
      },

      // Dry run: shows a sample trainee message. Nothing is sent or saved.
      preview(el, ctx) {
        const cohort = ctx.data.getCohort(ui.classId);
        let parts;
        try { parts = E.formatQuiz({ className: cohort ? cohort.name : "Class", day: ui.day || 1, questions: E.buildQuiz(pool(ctx), quizLength()) }); }
        catch (e) { toast(e.message); return; }
        TrainerHub.showDialog({
          title: "What a trainee receives",
          wide: true,
          html: `<p class="muted small">A sample. Every trainee gets different questions and answer order. Nothing was sent.${parts.length > 1 ? ` Long quizzes arrive as ${parts.length} messages (the rest as replies under the first).` : ""}</p>
            ${parts.map((p) => `<pre class="slack-preview">${esc(p)}</pre>`).join("")}`,
        });
      },

      test(el, ctx) {
        if (ui.busy) return;
        TrainerHub.confirmAction({
          title: "Send yourself a test quiz?",
          message: "A sample quiz from your current selection goes to your own Slack DMs only. No trainee gets anything and nothing is saved.",
          confirmLabel: "Send to me", confirmKind: "",
          onConfirm: () => sendTest(ctx, ctx.data.getCohort(ui.classId)),
        });
      },

      generate(el, ctx) {
        const cohort = ctx.data.getCohort(ui.classId);
        if (ui.busy || blockers(ctx, cohort).length) return;
        const ready = cohort.trainees.filter((t) => slackStatus(ctx, t.email).ok);
        const missing = cohort.trainees.length - ready.length;
        TrainerHub.confirmAction({
          title: `Send the Day ${ui.day} quiz to ${plural(ready.length, "trainee")}?`,
          message: `Each trainee gets a private DM from your Slack account with their own ${quizLength()} questions. The quiz has no answers in it; scores and correct answers go to each trainee only when you click “Check answers”.${missing ? ` ${missing} without a matched Slack account will be listed as failed.` : ""} Keep this page open until sending finishes.`,
          confirmLabel: "Send quizzes", confirmKind: "",
          onConfirm() {
            if (ui.busy) return; // double-click guard: one run at a time
            ui.busy = "generate";
            generate(ctx, cohort).catch((e) => {
              console.warn("quiz: generate", e);
              finish(ctx, e && e.code ? slackError(e) : (e && e.message) || "Couldn't generate the quiz.");
            });
          },
        });
      },

      showDay(el, ctx) { ui.showDay = Number(el.value); ui.generationId = null; ctx.rerender(); },
      pickGen(el, ctx) { ui.generationId = el.value; ctx.rerender(); },

      checkAnswers(el, ctx) {
        const gen = currentGen(ctx);
        if (ui.busy || !gen) return;
        TrainerHub.confirmAction({
          title: "Check answers and send results?",
          message: "Reads every trainee's reply in Slack and grades it. Then each trainee who has answered gets a private DM, under their quiz, with their score and the correct answers. Trainees who haven't answered get nothing yet, so click again later for them. Once results go out, someone who hasn't answered could be shown the answers.",
          confirmLabel: "Check and send", confirmKind: "",
          onConfirm() {
            if (ui.busy) return;
            ui.busy = "check-answers";
            checkAnswers(ctx, gen).catch((e) => { console.warn("quiz: check answers", e); finish(ctx, "Couldn't finish checking answers. Try again."); });
          },
        });
      },
      refresh(el, ctx) {
        const gen = currentGen(ctx);
        if (ui.busy || !gen) return;
        refreshResults(ctx, gen);
      },

      viewAnswers(el, ctx) {
        if (!ctx.data.perms.manageClasses) return;
        const q = ctx.data.getQuiz(el.dataset.gen, el.dataset.trainee);
        if (!q || !q.result) return;
        const r = q.result;
        TrainerHub.showDialog({
          title: `${q.name} · ${r.pct}% (${r.score}/${r.total})`,
          wide: true,
          html: `<p class="muted small">Submitted ${esc(fmtAt(q.submission.at))}. Their reply: “${esc(q.submission.text.slice(0, 300))}”</p>
            <table class="table answers"><thead><tr><th>#</th><th>Question</th><th>Answer given</th><th></th><th>Correct answer</th></tr></thead><tbody>
            ${r.detail.map((d) => `<tr><td class="num">${d.n}</td><td>${esc(d.question)}</td><td>${esc(d.answerGiven)}</td>
              <td><span class="pill ${d.correct ? "ok" : "bad"}">${d.correct ? "Correct" : "Wrong"}</span></td><td>${esc(d.correctAnswer)}</td></tr>`).join("")}
            </tbody></table>`,
        });
      },

      slackMenu(el, ctx) {
        const cohort = ctx.data.getCohort(ui.classId);
        const gen = currentGen(ctx);
        if (ui.busy || !gen) return;
        const c = counts(ctx.data.quizzesFor(gen.id));
        TrainerHub.chooseAction({
          title: "Send via Slack DM",
          message: "Nothing here sends scores or answers to trainees.",
          choices: [
            { label: `Resend to trainees whose delivery failed (${c.failed})`, value: "resend" },
            { label: `Remind trainees who haven't answered (${c.awaiting})`, value: "remind" },
            { label: "Send me a results summary (only you)", value: "summary" },
          ],
          onChoose(type) {
            const message = {
              resend: `Sends the same quiz again to ${plural(c.failed, "trainee")} whose delivery failed, using their current Slack match.${c.unknown ? ` ${c.unknown} unconfirmed sends are skipped: check your DMs with them first.` : ""}`,
              remind: `Sends this DM to ${plural(c.awaiting, "trainee")}: “${REMINDER(gen.day)}”`,
              summary: "Sends each trainee's score, and who hasn't submitted, to your own Slack DMs. No one else gets it.",
            }[type];
            TrainerHub.confirmAction({
              title: { resend: "Resend failed quizzes?", remind: "Send reminders?", summary: "Send yourself a summary?" }[type],
              message, confirmLabel: "Send", confirmKind: "",
              onConfirm() {
                if (ui.busy) return;
                if (type === "resend") retryFailed(ctx, gen, cohort);
                else if (type === "remind") remind(ctx, gen);
                else sendSummary(ctx, gen);
              },
            });
          },
        });
      },

      export(el, ctx) {
        const cohort = ctx.data.getCohort(ui.classId);
        if (ui.busy || !cohort) return;
        const day = ui.showDay;
        TrainerHub.confirmAction({
          title: `Export Day ${day} results?`,
          message: `Creates a new Google Sheet in your Drive with every Day ${day} quiz for ${cohort.name}: delivery, submission time, score and answers.`,
          confirmLabel: "Export", confirmKind: "",
          onConfirm: () => exportDay(ctx, cohort, day),
        });
      },
    },
  });
})();
