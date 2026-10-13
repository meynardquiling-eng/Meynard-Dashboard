/*
  Quiz engine: pure functions (no network, no DOM) used by the Quiz tab and by quiz/test/engine.test.js.
    - splitting the Knowledge Library into topics, and asking for / checking Claude-written questions
    - building a randomized quiz per trainee
    - writing the Slack DM text (never includes answers or scores)
    - reading the trainee's reply ("1A 2C 3B …") and grading it
    - reading the Slack connector's text results (user search, messages, send results)
*/
(function (root) {
  const LETTERS = ["A", "B", "C", "D"];
  const MAX_MESSAGE_CHARS = 3800; // Slack allows ~5000 per message; stay well under

  /* ---------------- Knowledge base → topics ---------------- */

  const SKIP_TITLES = /^(table of contents)$/i;
  const MIN_ARTICLE_CHARS = 400;   // shorter sections are tab labels or empty placeholders
  const STOP = new Set(["the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "is", "it", "its", "my", "i", "how", "what", "when", "should", "with", "by", "kb", "ag", "knowledge", "base", "c", "cp"]);

  /** "ð **Vouchers in the CRM** ð" -> "Vouchers in the CRM" (drops emoji, mis-encoded emoji bytes, markdown). */
  function cleanTitle(line) {
    return String(line)
      .replace(/^#+\s*/, "")
      .replace(/\\/g, "")
      .replace(/\*+/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^[^A-Za-z0-9]+/, "")
      .replace(/[^A-Za-z0-9)?!.]+$/, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[A-Z0-9 \W]+$/, (t) => (/[A-Z]{2}/.test(t) ? t.toLowerCase().replace(/(^|\s)([a-z])/g, (m) => m.toUpperCase()) : t));
  }

  const words = (s) => String(s).replace(/\([^)]*\)/g, " ").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((w) => w && !STOP.has(w));

  /** A stable id for a topic name: "Vouchers in the CRM" -> "vouchers-in-the-crm". */
  const topicKey = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "topic";

  /** Short, stable fingerprint of an article, to notice when it changes. */
  function hashText(text) {
    let h = 5381;
    const t = String(text);
    for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  // Table of contents: lines that aren't list items are category names; list items under them are articles.
  function readContents(lines) {
    const entries = [];
    let category = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      const item = line.match(/^\s*[-*]\s+(.*)$/);
      const title = cleanTitle(item ? item[1] : line);
      if (!title || /table of contents|helping you think/i.test(title) || /knowledge library$/i.test(title)) continue;
      if (item) { if (category) entries.push({ title, category, words: words(title) }); }
      else { category = title; entries.push({ title, category, words: words(title) }); } // a heading can be an article too
    }
    return entries;
  }

  // The contents entry whose words best match the title (Dice overlap), or null.
  function categoryFor(name, contents) {
    const w = new Set(words(name));
    let best = null, bestScore = 0;
    for (const e of contents) {
      if (!e.words.length || !w.size) continue;
      const shared = e.words.filter((x) => w.has(x)).length;
      const score = (2 * shared) / (e.words.length + w.size);
      if (score > bestScore) { best = e; bestScore = score; }
    }
    return best && bestScore >= 0.6 ? best.category : null;
  }

  /**
   * The Knowledge Library text (Google Docs connector output: markdown, one "# " heading per article)
   * -> [{ key, name, category, text, hash }] in document order. Tiny sections (a tab's label) merge into
   * the article that follows and take its full title.
   */
  function splitKnowledgeBase(text) {
    const lines = String(text || "").split("\n");
    const sections = [];
    let cur = null;
    for (const line of lines) {
      if (/^# /.test(line)) { cur = { title: cleanTitle(line), lines: [] }; sections.push(cur); }
      else if (cur) cur.lines.push(line);
    }
    const tocIndex = sections.findIndex((x) => SKIP_TITLES.test(x.title));
    const contents = tocIndex >= 0 ? readContents(sections[tocIndex].lines) : [];

    const articles = [];
    let carry = null; // a short section waiting to merge into the next one
    sections.forEach((sec, i) => {
      if (i === tocIndex) return;
      const body = sec.lines.join("\n").replace(/\]\([^)]*\)/g, "]").trim(); // links add length, not meaning
      const merged = carry ? { title: sec.title || carry.title, body: (carry.body + "\n\n" + body).trim() } : { title: sec.title, body };
      carry = null;
      if (merged.body.length < MIN_ARTICLE_CHARS) { carry = merged.title ? merged : null; return; }
      if (!merged.title) return;
      articles.push(merged);
    });

    const seen = {};
    let prev = null;
    return articles.map((a) => {
      let key = topicKey(a.title);
      if (seen[key]) key += "-" + ++seen[key]; else seen[key] = 1;
      // An article the contents don't list belongs with the one before it (they're sub-sections).
      const category = categoryFor(a.title, contents) || prev || "General";
      prev = category;
      return { key, name: a.title, category, text: a.body, hash: hashText(a.body) };
    });
  }

  /* ---------------- Writing questions with Claude ---------------- */

  /** The instruction for one topic. Claude sees only this text. */
  function questionPrompt({ topic, text, count, avoid = [] }) {
    return [
      "You write multiple-choice quiz questions for new Homeaglow Care agents in training.",
      `Use ONLY the knowledge base article below, titled "${topic}". Do not use outside knowledge. If the article doesn't support ${count} good questions, write fewer.`,
      "",
      `Write ${count} questions that test what an agent must get right on the job: rules, steps, definitions, limits, which option applies, what to do or not do.`,
      "Rules:",
      "- Exactly four choices (A, B, C, D) and exactly one correct answer.",
      "- Wrong choices must be believable but clearly wrong according to the article.",
      "- No \"all of the above\", \"none of the above\" or trick wording. Don't mention \"the article\".",
      "- Each question under 300 characters, each choice under 150 characters.",
      "- \"quote\": one sentence copied word for word from the article that proves the correct answer.",
      "- \"explanation\": one short sentence on why the answer is correct.",
      avoid.length ? "- Don't repeat or closely rephrase these existing questions:\n" + avoid.map((q) => "  * " + q).join("\n") : "",
      "",
      'Reply with only JSON, like: {"questions":[{"question":"…","choices":{"A":"…","B":"…","C":"…","D":"…"},"correct":"B","explanation":"…","quote":"…"}]}',
      "",
      "<article>",
      text,
      "</article>",
    ].filter((l) => l !== "").join("\n");
  }

  const squash = (s) => String(s || "").toLowerCase().replace(/[*_`#>\\]/g, "").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[^a-z0-9]+/g, " ").trim();

  /**
   * Checks Claude's reply. Malformed questions are dropped; each kept question records whether its
   * quote was found in the article, so the trainer can see which answers are backed by the text.
   */
  function checkGenerated(reply, articleText, { idPrefix = "q", existing = [] } = {}) {
    const list = Array.isArray(reply) ? reply : reply && Array.isArray(reply.questions) ? reply.questions : [];
    const article = squash(articleText);
    const known = new Set(existing.map(squash));
    const questions = [];
    let dropped = 0;
    list.forEach((q, i) => {
      const question = String((q && q.question) || "").trim();
      const choices = {};
      for (const L of LETTERS) { const v = String((q && q.choices && q.choices[L]) || "").trim(); if (v) choices[L] = v; }
      const correct = String((q && q.correct) || "").trim().toUpperCase();
      const distinct = new Set(Object.values(choices).map(squash)).size === Object.keys(choices).length;
      if (!question || Object.keys(choices).length !== 4 || !choices[correct] || !distinct || known.has(squash(question))) { dropped++; return; }
      known.add(squash(question));
      const quote = String((q && q.quote) || "").trim();
      questions.push({
        id: `${idPrefix}${Date.now().toString(36)}${i}`,
        question, choices, correct,
        explanation: String((q && q.explanation) || "").trim(),
        quote, quoteFound: squash(quote).length >= 15 && article.includes(squash(quote)),
        status: "pending",
      });
    });
    return { questions, dropped };
  }

  /** Approved questions from the saved bank, in the shape buildQuiz uses. */
  function bankQuestions(bankDocs) {
    const out = [];
    for (const b of bankDocs) for (const q of b.questions || []) {
      if (q.status === "approved") out.push({ id: `${b.key}:${q.id}`, topic: b.topic, question: q.question, choices: q.choices, correct: q.correct });
    }
    return out;
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

  /**
   * The trainee's own results, sent only after the trainer clicks "Check answers": score, then each
   * question with their answer and the correct one. Split between questions like formatQuiz.
   */
  function formatResults({ className, day, result }) {
    const intro = `**${className} · Day ${day} quiz results**\nYour score: **${result.score} of ${result.total} (${result.pct}%)**`;
    const blocks = result.detail.map((d) =>
      `${d.correct ? "✅" : "❌"} **${d.n}.** ${d.question}\n      Your answer: ${d.answerGiven}` + (d.correct ? "" : `\n      Correct answer: ${d.correctAnswer}`));
    const messages = [];
    let current = intro;
    for (const b of blocks) {
      if ((current + "\n\n" + b).length > MAX_MESSAGE_CHARS) { messages.push(current); current = b; }
      else current += "\n\n" + b;
    }
    messages.push(current);
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

  /**
   * From slack_read_channel / slack_read_thread (detailed) text: [{ name, email, userId, at, ts, text }].
   * The two tools use different layouts (both seen in real calls):
   *   channel: "=== Message from Name <email> (U…) at <time> ===\nMessage TS: <ts>\n<text>"
   *   thread:  "From: Name <email> (U…)\nTime: <time>\nMessage TS: <ts>\n<text>", between
   *            "=== THREAD PARENT MESSAGE ===" / "--- Reply 1 of 2 ---" markers
   */
  function parseMessages(text) {
    const out = [];
    const clean = (t) => t.replace(/\s*(Reactions?:|Thread:)[\s\S]*$/, "").trim();
    const channel = /=== Message from (.*?) (?:<([^>]*)> )?\((U[A-Z0-9]+|B[A-Z0-9]+)\) at ([^=]*?) ===\s*\n?Message TS: (\d+\.\d+)\s*\n?([\s\S]*?)(?=\n?=== Message from |$)/g;
    for (const m of String(text).matchAll(channel)) {
      out.push({ name: m[1].trim(), email: (m[2] || "").trim(), userId: m[3], at: m[4].trim(), ts: m[5], text: clean(m[6]) });
    }
    const thread = /(?:^|\n)From: (.*?) (?:<([^>]*)> )?\((U[A-Z0-9]+|B[A-Z0-9]+)\)\s*\nTime: ([^\n]*)\nMessage TS: (\d+\.\d+)\s*\n?([\s\S]*?)(?=\n+(?:--- Reply \d+ of \d+ ---|=== THREAD [A-Z ]+ ===)|$)/g;
    for (const m of String(text).matchAll(thread)) {
      if (out.some((x) => x.ts === m[5])) continue;
      out.push({ name: m[1].trim(), email: (m[2] || "").trim(), userId: m[3], at: m[4].trim(), ts: m[5], text: clean(m[6]) });
    }
    return out;
  }

  // A message that is part of a quiz (questions with lettered choices), not an answer to one. Matters
  // when the trainer sends a test quiz to themselves: the quiz parts and the reply have the same author.
  const looksLikeQuiz = (t) => /(^|\n)\s*A\. .+\n\s*B\. /.test(String(t));

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
      .filter((m) => m.userId === slackUserId && Number(m.ts) > Number(afterTs) && !looksLikeQuiz(m.text))
      .sort((a, b) => Number(a.ts) - Number(b.ts));
    for (const m of mine) {
      const parsed = parseAnswers(m.text, n);
      if (parsed.count) return { ...parsed, ts: m.ts, text: m.text };
    }
    return null;
  }

  const api = { LETTERS, cleanTitle, topicKey, hashText, splitKnowledgeBase, questionPrompt, checkGenerated, bankQuestions, questionPool, shuffle, buildQuiz, formatQuiz, formatResults, parseAnswers, grade, textOf, findUserIdByEmail, parseMessages, parseProfileId, parseSendResult, firstSubmission };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root && root.TrainerHub) root.TrainerHub.quizEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
