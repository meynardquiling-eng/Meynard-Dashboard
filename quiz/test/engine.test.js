// Tests for js/quiz-engine.js. Run: node quiz/test/engine.test.js
const assert = require("assert");
const E = require("../../js/quiz-engine.js");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// Deterministic random numbers so failures are reproducible.
function seeded(seed) { return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648); }

// Approved bank questions, in the shape bankQuestions() returns.
function bank(perTopic) {
  const out = [];
  let n = 0;
  for (const [topic, k] of perTopic)
    for (let i = 0; i < k; i++)
      out.push({ id: "Q" + ++n, topic, question: `${topic} q${i}`, choices: { A: "alpha", B: "bravo", C: "charlie", D: "delta" }, correct: "ABCD"[i % 4] });
  return out;
}

// A small library in the Google Docs connector's markdown shape (headings, a contents tab, tab labels).
const LIBRARY = [
  "# 📘 Table of Contents",
  "**Care Library**",
  "📘 **Table of Contents**",
  "  - [Welcome](about:blank)",
  "Care Foundation",
  "  - [Zero Tolerance Policy](https://docs.google.com/x#a)",
  "📅 **Bookings**",
  "  - [Rescheduling](https://docs.google.com/x#b)",
  "  - [No Claim](https://docs.google.com/x#c)",
  "📖 [Glossary](https://docs.google.com/x#g)",
  "# 🔴 Zero Tolerance Policy",
  "",
  "# **⚠️ Zero Tolerance Policy**",
  "Agents must never share internal notes with customers. " + "Breaking this rule leads to a final warning. ".repeat(12),
  "# Rescheduling",
  "Customers can reschedule up to 24 hours before the appointment without a fee. See [the guide](https://docs.google.com/very/long/link). " + "More detail about rescheduling. ".repeat(15),
  "# EXIT OFFERS",
  "Exit offers are made only after a retention offer is declined. " + "Offer rules continue here. ".repeat(20),
  "# Tab 9",
  "# No Claim",
  "When no cleaner claims a job, Care contacts the customer before the appointment. " + "No claim handling. ".repeat(25),
  "# Handling Common Issues",
  "short",
  "# 📖 Glossary",
  "MF: membership fee. ETF: early termination fee. " + "Glossary entries. ".repeat(25),
].join("\n");

test("splitKnowledgeBase: one topic per article, grouped by the contents, tab labels merged", () => {
  const topics = E.splitKnowledgeBase(LIBRARY);
  assert.deepStrictEqual(topics.map((t) => [t.name, t.category]), [
    ["Zero Tolerance Policy", "Care Foundation"],
    ["Rescheduling", "Bookings"],
    ["Exit Offers", "Bookings"],           // not in the contents: stays with the article before it
    ["No Claim", "Bookings"],              // "Tab 9" label merged into the next article
    ["Glossary", "Glossary"],              // a contents heading that is itself an article
  ]);
  const z = topics[0];
  assert.strictEqual(z.key, "zero-tolerance-policy");
  assert.ok(z.text.includes("never share internal notes"));
  assert.ok(!topics[1].text.includes("very/long/link"), "links are dropped from the article text");
  assert.ok(!topics.some((t) => /table of contents|common issues/i.test(t.name)), "contents and near-empty sections are not topics");
  assert.strictEqual(z.hash, E.splitKnowledgeBase(LIBRARY)[0].hash);
  assert.notStrictEqual(z.hash, topics[1].hash);
  assert.deepStrictEqual(E.splitKnowledgeBase(""), []);
});

test("questionPrompt: article only, count, format, and questions to avoid", () => {
  const p = E.questionPrompt({ topic: "No Claim", text: "ARTICLE BODY", count: 15, avoid: ["Old question?"] });
  assert.ok(p.includes("Use ONLY the knowledge base article below"));
  assert.ok(p.includes("Write 15 questions"));
  assert.ok(p.includes("<article>\nARTICLE BODY\n</article>"));
  assert.ok(p.includes("* Old question?"));
  assert.ok(p.includes('"correct":"B"'));
  assert.ok(!E.questionPrompt({ topic: "x", text: "y", count: 5 }).includes("Don't repeat"));
});

test("checkGenerated: keeps well-formed questions, drops broken ones and duplicates, checks quotes", () => {
  const article = "Customers can reschedule up to 24 hours before the appointment without a fee. Later changes cost $25.";
  const ok = { question: "How late can a customer reschedule for free?", choices: { A: "1 hour", B: "24 hours", C: "48 hours", D: "Never" }, correct: "B", explanation: "The article says 24 hours.", quote: "Customers can reschedule up to 24 hours before the appointment without a fee." };
  const reply = { questions: [
    ok,
    { ...ok, question: "What does a late change cost?", correct: "A", choices: { A: "$25", B: "$10", C: "$50", D: "Nothing" }, quote: "Late changes are expensive." },  // quote not in the article
    { ...ok, question: "Three choices only?", choices: { A: "x", B: "y", C: "z" } },
    { ...ok, question: "Correct letter missing", correct: "E" },
    { ...ok, question: "Same choice twice", choices: { A: "x", B: "x", C: "y", D: "z" } },
    { ...ok },                                                     // duplicate of the first
    { ...ok, question: "Already in the bank?" },
    null,
  ] };
  const r = E.checkGenerated(reply, article, { existing: ["already in the bank?"] });
  assert.strictEqual(r.questions.length, 2);
  assert.strictEqual(r.dropped, 6);
  assert.deepStrictEqual(r.questions.map((q) => [q.quoteFound, q.status]), [[true, "pending"], [false, "pending"]]);
  assert.notStrictEqual(r.questions[0].id, r.questions[1].id);
  assert.strictEqual(E.checkGenerated([ok], article).questions.length, 1, "a bare array is accepted too");
  assert.strictEqual(E.checkGenerated("nonsense", article).questions.length, 0);
});

test("bankQuestions: only approved questions, ids unique across topics", () => {
  const q = (id, status) => ({ id, status, question: id, choices: { A: "a", B: "b", C: "c", D: "d" }, correct: "A" });
  const out = E.bankQuestions([
    { key: "rescheduling", topic: "Rescheduling", questions: [q("q1", "approved"), q("q2", "pending")] },
    { key: "no-claim", topic: "No Claim", questions: [q("q1", "approved")] },
  ]);
  assert.deepStrictEqual(out.map((x) => [x.id, x.topic]), [["rescheduling:q1", "Rescheduling"], ["no-claim:q1", "No Claim"]]);
});

test("questionPool: only the chosen topics, weekly or not", () => {
  const questions = bank([["A", 3], ["B", 4], ["C", 5]]);
  assert.strictEqual(E.questionPool(questions, { weekly: true, topics: [] }).length, 0);
  assert.strictEqual(E.questionPool(questions, { weekly: true, topics: ["A", "B", "C"] }).length, 12);
  assert.strictEqual(E.questionPool(questions, { weekly: true, topics: ["B"] }).length, 4);
  assert.strictEqual(E.questionPool(questions, { weekly: false, topics: ["A", "C"] }).length, 8);
});

test("buildQuiz: right length, no repeats, choice order is a permutation, differs per trainee", () => {
  const pool = bank([["A", 30]]);
  const rand = seeded(7);
  const quizzes = Array.from({ length: 8 }, () => E.buildQuiz(pool, 15, rand));
  for (const q of quizzes) {
    assert.strictEqual(q.length, 15);
    assert.strictEqual(new Set(q.map((x) => x.id)).size, 15);
    for (const item of q) assert.deepStrictEqual(item.order.slice().sort(), Object.keys(item.choices).sort());
  }
  const sets = new Set(quizzes.map((q) => q.map((x) => x.id).join(",")));
  assert.ok(sets.size >= 7, "trainees should get different questions/orders");
  const orders = new Set(quizzes.flatMap((q) => q.map((x) => x.order.join(""))));
  assert.ok(orders.size > 1, "choice order should vary");
});

test("buildQuiz: weekly 50 works with 50+, refuses a pool that's too small", () => {
  const pool = bank([["A", 59]]);
  const q = E.buildQuiz(pool, 50, seeded(3));
  assert.strictEqual(q.length, 50);
  assert.strictEqual(new Set(q.map((x) => x.id)).size, 50);
  assert.throws(() => E.buildQuiz(pool.slice(0, 14), 15), /Only 14 eligible questions; 15 needed/);
});

test("formatQuiz: shows questions and display letters, never the answer or a score", () => {
  const pool = bank([["A", 20]]);
  const quiz = E.buildQuiz(pool, 10, seeded(11));
  const msgs = E.formatQuiz({ className: "Care Wave 15", day: 6, questions: quiz });
  const all = msgs.join("\n");
  assert.ok(all.includes("Care Wave 15 · Day 6 quiz"));
  assert.ok(all.includes("1A 2C 3B 4D"));
  quiz.forEach((q, i) => {
    assert.ok(all.includes(`**${i + 1}.** ${q.question}`));
    q.order.forEach((orig, k) => assert.ok(all.includes(`${E.LETTERS[k]}. ${q.choices[orig]}`)));
  });
  for (const word of [/score/i, /%/, /correct answer/i, /wrong/i, /Correct answer/]) assert.ok(!word.test(all), "trainee message must not contain " + word);
  assert.ok(!all.includes('"correct"'));
});

test("formatQuiz: long quizzes split between questions, each part under the limit", () => {
  const rows = bank([["A", 60]]).map((r) => ({ ...r, question: r.question + " " + "long text ".repeat(25) }));
  const quiz = E.buildQuiz(rows, 50, seeded(5));
  const msgs = E.formatQuiz({ className: "C", day: 1, questions: quiz });
  assert.ok(msgs.length > 1);
  for (const m of msgs) assert.ok(m.length <= 3800 + 120, "part too long: " + m.length);
  for (let i = 1; i <= 50; i++) assert.strictEqual(msgs.filter((m) => m.includes(`**${i}.** `)).length, 1, "question " + i + " in exactly one part");
  assert.ok(msgs[msgs.length - 1].includes("Reply with all 50 answers"));
});

test("formatResults: score, the trainee's answers and the correct ones, split safely", () => {
  const q = [
    { id: "Q1", topic: "T", question: "one", choices: { A: "a", B: "b", C: "c", D: "d" }, correct: "B", order: ["D", "B", "A", "C"] },
    { id: "Q2", topic: "T", question: "two", choices: { A: "yes", B: "no", C: "maybe", D: "later" }, correct: "A", order: ["B", "A", "C", "D"] },
  ];
  const r = E.grade(q, ["B", "A"]);
  const [msg, ...rest] = E.formatResults({ className: "Care Wave", day: 3, result: r });
  assert.strictEqual(rest.length, 0);
  assert.ok(msg.includes("Care Wave · Day 3 quiz results"));
  assert.ok(msg.includes("Your score: **1 of 2 (50%)**"));
  assert.ok(msg.includes("✅ **1.** one\n      Your answer: B. b") && !msg.split("**2.**")[0].includes("Correct answer"), "a right answer shows no correction");
  assert.ok(msg.includes("❌ **2.** two\n      Your answer: A. no\n      Correct answer: B. yes"));
  const big = E.grade(Array.from({ length: 50 }, (_, i) => ({ ...q[0], id: "L" + i, question: "long ".repeat(60) + i })), []);
  const parts = E.formatResults({ className: "C", day: 1, result: big });
  assert.ok(parts.length > 1 && parts.every((m) => m.length <= 3800 + 200));
  for (let i = 1; i <= 50; i++) assert.strictEqual(parts.filter((m) => m.includes(`**${i}.** `)).length, 1);
});

test("parseAnswers: numbered, lowercase, punctuation, sequence, duplicates, out of range", () => {
  assert.deepStrictEqual(E.parseAnswers("1A 2c 3-B, 4) d", 4).answers, ["A", "C", "B", "D"]);
  assert.deepStrictEqual(E.parseAnswers("1. a\n2: b\n3=c", 4).answers, ["A", "B", "C", null]);
  assert.deepStrictEqual(E.parseAnswers("A C B D", 4).answers, ["A", "C", "B", "D"]);
  assert.deepStrictEqual(E.parseAnswers("a, c, b", 4).answers, ["A", "C", "B", null]);
  assert.deepStrictEqual(E.parseAnswers("1A 1B 9C", 2).answers, ["A", null]); // first answer wins; 9 is out of range
  assert.deepStrictEqual(E.parseAnswers("10b 2a", 10).answers[9], "B");
  assert.strictEqual(E.parseAnswers("Goodmorning! I have a question", 5).count, 0);
  assert.strictEqual(E.parseAnswers("thanks", 5).count, 0);
  assert.strictEqual(E.parseAnswers("1 Apple", 5).count, 0); // a word starting with A is not an answer
});

test("grade: maps display letters back through the shuffled order", () => {
  const q = [
    { id: "Q1", topic: "T", question: "one", choices: { A: "a", B: "b", C: "c", D: "d" }, correct: "B", order: ["D", "B", "A", "C"] },
    { id: "Q2", topic: "T", question: "two", choices: { A: "yes", B: "no" }, correct: "A", order: ["B", "A"] },
    { id: "Q3", topic: "T", question: "three", choices: { A: "a", B: "b", C: "c" }, correct: "C", order: ["C", "A", "B"] },
  ];
  // Correct display letters: Q1 -> B (B shown 2nd), Q2 -> B, Q3 -> A
  const r = E.grade(q, ["B", "A", null]);
  assert.strictEqual(r.score, 1);
  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.pct, 33.3);
  assert.deepStrictEqual(r.detail.map((d) => [d.answerGiven, d.correctAnswer, d.correct]), [["B. b", "B. b", true], ["A. no", "B. yes", false], ["(no answer)", "A. c", false]]);
  // A letter beyond the choices shown counts as wrong, not as a crash.
  assert.strictEqual(E.grade([q[1]], ["D"]).detail[0].answerGiven, "(no answer)");
});

// Formats copied from real (read-only) Slack connector results.
const SEARCH = { payload: { results: "# Search Results for: johnpaule\n\n## Users (2 results)\n1. John Melvin Paule - U0C6RML603G - johnpaule@homeaglowcare.com\n2. John Paule Jr - U0C6RML6999 - johnpaule@other.com\n" } };
const HISTORY = "=== Message from Meynard Quiling <meynardquiling@maximizeltv.com> (U08D4U44SF2) at 2026-10-12 12:11:55 CDT === \nMessage TS: 1791825115.108429\n**Care Wave · Day 6 quiz**\n\n=== Message from John Melvin Paule <johnpaule@homeaglowcare.com> (U0C6RML603G) at 2026-10-12 12:15:02 CDT === \nMessage TS: 1791825302.000100\nhi sir, quick question\n\n=== Message from John Melvin Paule <johnpaule@homeaglowcare.com> (U0C6RML603G) at 2026-10-12 12:20:40 CDT === \nMessage TS: 1791825640.000200\n1A 2B 3C\n\n=== Message from John Melvin Paule <johnpaule@homeaglowcare.com> (U0C6RML603G) at 2026-10-12 12:21:00 CDT === \nMessage TS: 1791825660.000300\noops 1D 2D 3D";

test("textOf + findUserIdByEmail: exact email match only", () => {
  const text = E.textOf(SEARCH);
  assert.strictEqual(E.findUserIdByEmail(text, "JohnPaule@homeaglowcare.com"), "U0C6RML603G");
  assert.strictEqual(E.findUserIdByEmail(text, "johnpaule@gmail.com"), null);
  assert.strictEqual(E.findUserIdByEmail("", "a@b.com"), null);
  assert.strictEqual(E.textOf({ content: [{ type: "text", text: "hello" }] }), "hello");
});

test("parseMessages + firstSubmission: first reply with answers after the quiz is final", () => {
  const msgs = E.parseMessages(HISTORY);
  assert.strictEqual(msgs.length, 4);
  assert.deepStrictEqual([msgs[0].userId, msgs[0].ts, msgs[0].email], ["U08D4U44SF2", "1791825115.108429", "meynardquiling@maximizeltv.com"]);
  assert.strictEqual(msgs[2].text, "1A 2B 3C");
  const sub = E.firstSubmission(msgs, "U0C6RML603G", "1791825115.108429", 3);
  assert.deepStrictEqual(sub.answers, ["A", "B", "C"]);
  assert.strictEqual(sub.ts, "1791825640.000200");
  // The trainer's own messages never count, and messages before the quiz never count.
  assert.strictEqual(E.firstSubmission(msgs, "U08D4U44SF2", "0", 3), null);
  assert.strictEqual(E.firstSubmission(msgs, "U0C6RML603G", "1791825700.000000", 3), null);
});

// The slack_read_thread layout, copied from a real self-test (question text shortened).
const THREAD = "=== THREAD PARENT MESSAGE ===\nFrom: Meynard Quiling <meynardquiling@maximizeltv.com> (U08D4U44SF2)\nTime: 2026-10-13 07:18:45 CDT\nMessage TS: 1791893925.185499\n*Class (TEST) · Day 1 quiz* (3 questions)\nReply to this message with all your answers in one reply, like: `1A 2C 3B 4D`\n\n*1.* First question?\nA. one\nB. two\nC. three\nD. four\n*Sent using* <@U09SV7J2JDP|Claude>\n\n=== THREAD REPLIES (2 total) ===\n\n--- Reply 1 of 2 ---\nFrom: Meynard Quiling <meynardquiling@maximizeltv.com> (U08D4U44SF2)\nTime: 2026-10-13 07:18:46 CDT\nMessage TS: 1791893926.243229\n*2.* An agent has 3 ZTP instances, of different levels?\nA. A 1-week suspension\nB. Final Warning\nC. A 3-day suspension\nD. Termination\n\n*3.* In step 1 a customer signs up. What comes next?\nA. yes\nB. no\nC. maybe\nD. later\n\n_End of quiz. Reply with all 3 answers in one message._\n*Sent using* <@U09SV7J2JDP|Claude>\n\n--- Reply 2 of 2 ---\nFrom: Meynard Quiling <meynardquiling@maximizeltv.com> (U08D4U44SF2)\nTime: 2026-10-13 08:11:51 CDT\nMessage TS: 1791897111.192419\n1B\n2D\n3A\n";

test("parseMessages: the thread layout, and a self-test's quiz parts are not answers", () => {
  const msgs = E.parseMessages(THREAD);
  assert.deepStrictEqual(msgs.map((m) => m.ts), ["1791893925.185499", "1791893926.243229", "1791897111.192419"]);
  assert.strictEqual(msgs[2].text, "1B\n2D\n3A");
  assert.strictEqual(msgs[0].email, "meynardquiling@maximizeltv.com");
  // Same author for quiz and reply (a test quiz to yourself): the quiz's own thread part is skipped.
  const sub = E.firstSubmission(msgs, "U08D4U44SF2", "1791893925.185499", 3);
  assert.deepStrictEqual(sub.answers, ["B", "D", "A"]);
  assert.strictEqual(sub.ts, "1791897111.192419");
  // Both layouts together (channel history + thread) don't duplicate a message.
  const both = E.parseMessages(HISTORY + "\n" + THREAD);
  assert.strictEqual(both.length, 7);
});

test("textOf: reads results however the page receives them", () => {
  // payload parsed from JSON text (what read_channel returns), the raw JSON text block, structured content.
  const asPayload = { payload: { messages: THREAD, pagination_info: "none" } };
  const asTextBlock = { content: [{ type: "text", text: JSON.stringify({ messages: THREAD }) }] };
  const asStructured = { structuredContent: { messages: [THREAD] }, content: [] };
  for (const r of [asPayload, asTextBlock, asStructured, THREAD]) {
    const sub = E.firstSubmission(E.parseMessages(E.textOf(r)), "U08D4U44SF2", "1791893925.185499", 3);
    assert.ok(sub, "reply found");
    assert.deepStrictEqual(sub.answers, ["B", "D", "A"]);
  }
  assert.strictEqual(E.parseMessages(E.textOf(asPayload)).length, 3, "no duplicates");
  assert.deepStrictEqual(E.parseSendResult(E.textOf({ payload: { ok: true, channel: "D08CD94H27P", ts: "1791893925.185499" } })), { ts: "1791893925.185499", channel: "D08CD94H27P" });
});

test("parseProfileId: reads the id from the real profile format", () => {
  assert.strictEqual(E.parseProfileId(E.textOf({ payload: "User ID: U08D4U44SF2\nUsername: meynardquiling\n" })), "U08D4U44SF2");
  assert.strictEqual(E.parseProfileId("Username: x"), null);
});

test("parseSendResult: from fields or from the message link", () => {
  assert.deepStrictEqual(E.parseSendResult('{"ok":true,"channel":"D0ABCDEF12","ts":"1791825115.108429"}'), { ts: "1791825115.108429", channel: "D0ABCDEF12" });
  assert.deepStrictEqual(E.parseSendResult("Message sent: https://homeaglow.slack.com/archives/D0ABCDEF12/p1791825115108429"), { ts: "1791825115.108429", channel: "D0ABCDEF12" });
  assert.deepStrictEqual(E.parseSendResult("sent"), { ts: null, channel: null });
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log("ok   " + name); }
    catch (e) { console.log("FAIL " + name + "\n     " + (e && e.message)); }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  process.exit(passed === tests.length ? 0 : 1);
})();
