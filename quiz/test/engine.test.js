// Tests for js/quiz-engine.js. Run: node quiz/test/engine.test.js
const assert = require("assert");
const E = require("../../js/quiz-engine.js");

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// Deterministic random numbers so failures are reproducible.
function seeded(seed) { return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648); }

function bankRows(perTopic) {
  const rows = [];
  let n = 0;
  for (const [topic, cat, k] of perTopic)
    for (let i = 0; i < k; i++)
      rows.push({ Topic: topic, Question: `${topic} q${i}`, "Choice A": "alpha", "Choice B": "bravo", "Choice C": "charlie", "Choice D": "delta", "Correct answer": "ABCD"[i % 4], "Question ID": "Q" + ++n, Category: cat, Active: "TRUE" });
  return rows;
}

test("readBank keeps valid questions, skips invalid ones and counts per topic", () => {
  const rows = bankRows([["Booking", "Core", 3], ["Policies", "Rules", 2]]);
  rows.push({ Topic: "Policies", Question: "inactive", "Choice A": "a", "Choice B": "b", "Correct answer": "A", Active: "FALSE" });
  rows.push({ Topic: "Empty", Question: "bad key", "Choice A": "a", "Choice B": "b", "Correct answer": "C", Category: "Rules" });
  rows.push({ Topic: "", Question: "" }); // blank row ignored
  const bank = E.readBank(rows);
  assert.strictEqual(bank.questions.length, 5);
  assert.strictEqual(bank.skipped, 2);
  assert.deepStrictEqual(bank.topics.map((t) => [t.name, t.category, t.eligible]), [["Booking", "Core", 3], ["Empty", "Rules", 0], ["Policies", "Rules", 2]]);
  assert.strictEqual(E.questionProblem({ Topic: "x", Question: "y", "Choice A": "a", "Choice B": "b", "Correct answer": "AB" }), "correct answer must be A, B, C or D");
});

test("questionPool: weekly uses everything, otherwise only chosen topics", () => {
  const bank = E.readBank(bankRows([["A", "c", 3], ["B", "c", 4], ["C", "c", 5]]));
  assert.strictEqual(E.questionPool(bank.questions, { weekly: true, topics: [] }).length, 12);
  assert.strictEqual(E.questionPool(bank.questions, { weekly: false, topics: ["A", "C"] }).length, 8);
});

test("buildQuiz: right length, no repeats, choice order is a permutation, differs per trainee", () => {
  const pool = E.readBank(bankRows([["A", "c", 30]])).questions;
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
  const pool = E.readBank(bankRows([["A", "c", 59]])).questions;
  const q = E.buildQuiz(pool, 50, seeded(3));
  assert.strictEqual(q.length, 50);
  assert.strictEqual(new Set(q.map((x) => x.id)).size, 50);
  assert.throws(() => E.buildQuiz(pool.slice(0, 14), 15), /Only 14 eligible questions; 15 needed/);
});

test("formatQuiz: shows questions and display letters, never the answer or a score", () => {
  const pool = E.readBank(bankRows([["A", "c", 20]])).questions;
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
  const rows = bankRows([["A", "c", 60]]).map((r) => ({ ...r, Question: r.Question + " " + "long text ".repeat(25) }));
  const quiz = E.buildQuiz(E.readBank(rows).questions, 50, seeded(5));
  const msgs = E.formatQuiz({ className: "C", day: 1, questions: quiz });
  assert.ok(msgs.length > 1);
  for (const m of msgs) assert.ok(m.length <= 3800 + 120, "part too long: " + m.length);
  for (let i = 1; i <= 50; i++) assert.strictEqual(msgs.filter((m) => m.includes(`**${i}.** `)).length, 1, "question " + i + " in exactly one part");
  assert.ok(msgs[msgs.length - 1].includes("Reply with all 50 answers"));
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
