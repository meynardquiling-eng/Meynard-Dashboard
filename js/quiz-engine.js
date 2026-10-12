/*
  Quiz engine: pure functions (no network, no DOM) used by the Quiz tab and by quiz/test/engine.test.js.
    - reading the Question Bank rows
    - building a randomized quiz per trainee
    - writing the Slack DM text (never includes answers or scores)
    - reading the trainee's reply ("1A 2C 3B …") and grading it
    - reading the Slack connector's text results (user search, messages, send results)
*/
(function (root) {
  const LETTERS = ["A", "B", "C", "D"];
  const MAX_MESSAGE_CHARS = 3800; // Slack allows ~5000 per message; stay well under

  /* ---------------- Question Bank ---------------- */

  // Returns "" for a usable question, or why it can't be used.
  function questionProblem(r) {
    const active = ["", "true", "yes", "1"].includes(String(r["Active"] ?? "").trim().toLowerCase());
    if (!active) return "inactive";
    if (!String(r["Topic"] || "").trim()) return "missing topic";
    if (!String(r["Question"] || "").trim()) return "missing question";
    const filled = LETTERS.filter((L) => String(r["Choice " + L] || "").trim() !== "");
    if (filled.length < 2) return "needs at least two choices";
    const correct = String(r["Correct answer"] || "").trim().toUpperCase();
    if (!LETTERS.includes(correct)) return "correct answer must be A, B, C or D";
    if (!filled.includes(correct)) return `correct answer ${correct} points at an empty choice`;
    return "";
  }

  /** rows from the "Question Bank" tab -> { topics: [{name, category, eligible}], questions: [...], skipped } */
  function readBank(rows) {
    const topics = {};
    const questions = [];
    let skipped = 0;
    rows.forEach((r, i) => {
      const name = String(r["Topic"] || "").trim();
      if (!name && !String(r["Question"] || "").trim()) return; // blank row
      const t = topics[name || "(no topic)"] ||= { name: name || "(no topic)", category: String(r["Category"] || "").trim() || "General", eligible: 0 };
      if (questionProblem(r)) { skipped++; return; }
      const choices = {};
      LETTERS.forEach((L) => { const v = String(r["Choice " + L] || "").trim(); if (v) choices[L] = v; });
      questions.push({
        id: String(r["Question ID"] || "").trim() || "row" + (i + 2),
        topic: name, question: String(r["Question"]).trim(), choices,
        correct: String(r["Correct answer"]).trim().toUpperCase(),
      });
      t.eligible++;
    });
    return { topics: Object.values(topics).sort((a, b) => a.name.localeCompare(b.name)), questions, skipped };
  }

  function questionPool(questions, { weekly, topics }) {
    if (weekly) return questions.slice();
    const wanted = new Set(topics);
    return questions.filter((q) => wanted.has(q.topic));
  }

  /* ---------------- Randomization ---------------- */

  function shuffle(arr, rand = Math.random) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /**
   * One trainee's quiz: `length` random questions in random order, each with its choices in random order.
   * order[i] is the original letter shown as display letter LETTERS[i]. Keeps a snapshot for auditing.
   */
  function buildQuiz(pool, length, rand = Math.random) {
    if (pool.length < length) throw new Error(`Only ${pool.length} eligible questions; ${length} needed.`);
    return shuffle(pool, rand).slice(0, length).map((q) => ({
      id: q.id, topic: q.topic, question: q.question, choices: q.choices, correct: q.correct,
      order: shuffle(Object.keys(q.choices), rand),
    }));
  }

  /* ---------------- Slack message (trainee-facing: never answers or scores) ---------------- */

  /** Returns one or more message texts; questions are never split across messages. */
  function formatQuiz({ className, day, questions }) {
    const intro =
      `**${className} · Day ${day} quiz** (${questions.length} questions)\n` +
      `Reply to this message with all your answers in one reply, like: \`1A 2C 3B 4D\`\n` +
      `Your first reply is final. Your answers are private.`;
    const blocks = questions.map((q, i) =>
      `**${i + 1}.** ${q.question}\n` + q.order.map((orig, k) => `      ${LETTERS[k]}. ${q.choices[orig]}`).join("\n"));
    const messages = [];
    let current = intro;
    for (const b of blocks) {
      if ((current + "\n\n" + b).length > MAX_MESSAGE_CHARS) { messages.push(current); current = b; }
      else current += "\n\n" + b;
    }
    messages.push(current);
    if (messages.length > 1) messages[messages.length - 1] += `\n\n_End of quiz. Reply with all ${questions.length} answers in one message._`;
    return messages;
  }

  /* ---------------- Reading and grading the reply ---------------- */

  /**
   * "1A 2c 3-B, 4) d" or "A C B D" -> ["A","C","B","D", ...] (null where unanswered), length n.
   * Numbered answers win; a plain sequence of letters is used only when there are no numbers.
   */
  function parseAnswers(text, n) {
    const answers = new Array(n).fill(null);
    const t = String(text || "").replace(/<[^>]*>/g, " ");
    const numbered = [...t.matchAll(/(\d{1,3})\s*[\.\):\-=]?\s*([A-Da-d])(?![A-Za-z])/g)];
    if (numbered.length) {
      for (const m of numbered) {
        const i = Number(m[1]) - 1;
        if (i >= 0 && i < n && answers[i] == null) answers[i] = m[2].toUpperCase(); // first answer to a number counts
      }
    } else if (/^[\s,;.]*([A-Da-d][\s,;.]+)*[A-Da-d][\s,;.]*$/.test(t)) {
      // Only when the whole reply is letters ("A C B D"), so a chat message like "I have a question" isn't an answer.
      const seq = t.match(/[A-Da-d]/g).map((L) => L.toUpperCase());
      seq.slice(0, n).forEach((L, i) => { answers[i] = L; });
    }
    return { answers, count: answers.filter(Boolean).length };
  }

  /** Grades display-letter answers against the quiz snapshot. Score is a percentage, never money. */
  function grade(questions, displayAnswers) {
    let score = 0;
    const detail = questions.map((q, i) => {
      const shown = displayAnswers[i];
      const pos = shown ? LETTERS.indexOf(shown) : -1;
      const original = pos >= 0 && pos < q.order.length ? q.order[pos] : null;
      const correct = original === q.correct;
      if (correct) score++;
      return {
        n: i + 1, questionId: q.id, topic: q.topic, question: q.question,
        answerGiven: original ? `${shown}. ${q.choices[original]}` : "(no answer)",
        correctAnswer: `${LETTERS[q.order.indexOf(q.correct)]}. ${q.choices[q.correct]}`,
        correct,
      };
    });
    const total = questions.length;
    return { score, total, pct: total ? Math.round((score / total) * 1000) / 10 : 0, detail };
  }

  /* ---------------- Reading the Slack connector's text results ---------------- */

  const textOf = (result) => {
    if (result == null) return "";
    if (typeof result === "string") return result;
    const parts = [];
    const p = result.payload;
    if (typeof p === "string") parts.push(p);
    else if (p && typeof p === "object") parts.push(...Object.values(p).filter((v) => typeof v === "string"), JSON.stringify(p));
    for (const b of result.content || []) if (b && typeof b.text === "string") parts.push(b.text);
    return parts.join("\n");
  };

  /** From slack_search_users (concise) text: the user id whose listed email exactly matches. */
  function findUserIdByEmail(text, email) {
    const want = String(email || "").trim().toLowerCase();
    for (const line of String(text).split("\n")) {
      const m = line.match(/\s-\s(U[A-Z0-9]{6,})\s-\s([^\s]+@[^\s]+)/);
      if (m && m[2].toLowerCase() === want) return m[1];
    }
    return null;
  }

  /** From slack_read_channel / slack_read_thread (detailed) text: [{ name, email, userId, ts, text }]. */
  function parseMessages(text) {
    const out = [];
    const re = /=== Message from (.*?) (?:<([^>]*)> )?\((U[A-Z0-9]+|B[A-Z0-9]+)\) at ([^=]*?) ===\s*\n?Message TS: (\d+\.\d+)\s*\n?([\s\S]*?)(?=\n?=== Message from |$)/g;
    for (const m of String(text).matchAll(re)) {
      out.push({ name: m[1].trim(), email: (m[2] || "").trim(), userId: m[3], at: m[4].trim(), ts: m[5], text: m[6].replace(/\s*(Reactions?:|Thread:)[\s\S]*$/, "").trim() });
    }
    return out;
  }

  /** From slack_read_user_profile (detailed) text: "User ID: U08…". */
  function parseProfileId(text) {
    const m = String(text).match(/User ID:\s*(U[A-Z0-9]{6,})/);
    return m ? m[1] : null;
  }

  /** From a slack_send_message result: { ts, channel } (from fields or the message link). */
  function parseSendResult(text) {
    const s = String(text);
    const link = s.match(/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/);
    const ts = (s.match(/"?ts"?\s*[:=]\s*"?(\d{10}\.\d{6})/) || [])[1] || (link ? `${link[2]}.${link[3]}` : null);
    const channel = (s.match(/"?channel(?:_id)?"?\s*[:=]\s*"?([CDG][A-Z0-9]{6,})/) || [])[1] || (link ? link[1] : null);
    return { ts, channel };
  }

  /** The trainee's first reply after the quiz message that contains at least one answer. */
  function firstSubmission(messages, slackUserId, afterTs, n) {
    const mine = messages
      .filter((m) => m.userId === slackUserId && Number(m.ts) > Number(afterTs))
      .sort((a, b) => Number(a.ts) - Number(b.ts));
    for (const m of mine) {
      const parsed = parseAnswers(m.text, n);
      if (parsed.count) return { ...parsed, ts: m.ts, text: m.text };
    }
    return null;
  }

  const api = { LETTERS, questionProblem, readBank, questionPool, shuffle, buildQuiz, formatQuiz, parseAnswers, grade, textOf, findUserIdByEmail, parseMessages, parseProfileId, parseSendResult, firstSubmission };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root && root.TrainerHub) root.TrainerHub.quizEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
