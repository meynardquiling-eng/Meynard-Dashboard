// Tests for js/observation-engine.js. Run: node observations/test/engine.test.js
const assert = require("assert");
const O = require("../../js/observation-engine.js");

const trainees = [
  { id: "t1", name: "christianabigan", email: "christianabigan@maximizeltv.com" },
  { id: "t2", name: "airavalerio", email: "airavalerio@maximizeltv.com" },
  { id: "t3", name: "paulolilang", email: "paulolilang@maximizeltv.com" },
];
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok -", name); };

test("prompt lists every trainee with id and email, and the note", () => {
  const p = O.splitPrompt({ note: "Chris did well.", trainees });
  for (const t of trainees) { assert(p.includes(`id: ${t.id}`)); assert(p.includes(t.email)); }
  assert(p.includes("Chris did well."));
  assert(/do not guess/i.test(p));
});

test("checkSplit keeps items for real trainees and trims whitespace", () => {
  const r = O.checkSplit({ items: [{ traineeId: "t1", text: "  Handled the ETF call well. " }, { traineeId: "t2", text: "Late from break" }] }, trainees);
  assert.deepStrictEqual(r.items, [{ traineeId: "t1", text: "Handled the ETF call well." }, { traineeId: "t2", text: "Late from break" }]);
  assert.deepStrictEqual(r.unassigned, []);
});

test("an id that isn't in the class is never filed under a guess", () => {
  const r = O.checkSplit({ items: [{ traineeId: "t9", text: "Mark was quiet" }, { traineeId: "christianabigan", text: "x" }] }, trainees);
  assert.deepStrictEqual(r.items, []);
  assert.deepStrictEqual(r.unassigned, ["Mark was quiet", "x"]);
});

test("empty text dropped, duplicates removed, unassigned kept once", () => {
  const r = O.checkSplit({ items: [{ traineeId: "t3", text: "" }, { traineeId: "t3", text: "Asked good questions" }, { traineeId: "t3", text: "asked good questions" }],
    unassigned: ["Class was noisy", "Class was noisy", ""] }, trainees);
  assert.deepStrictEqual(r.items, [{ traineeId: "t3", text: "Asked good questions" }]);
  assert.deepStrictEqual(r.unassigned, ["Class was noisy"]);
});

test("a malformed answer gives nothing rather than throwing", () => {
  for (const bad of [null, {}, { items: "no" }, { items: [null, 5] }]) {
    const r = O.checkSplit(bad, trainees);
    assert.deepStrictEqual(r, { items: [], unassigned: [] });
  }
});

test("very long text is capped", () => {
  const r = O.checkSplit({ items: [{ traineeId: "t1", text: "a".repeat(O.MAX_TEXT + 50) }] }, trainees);
  assert.strictEqual(r.items[0].text.length, O.MAX_TEXT);
});

test("groupByTrainee lists every trainee in roster order, newest first, and keeps removed trainees' notes", () => {
  const obs = [
    { id: "a", traineeId: "t2", observedAt: "2026-10-20T13:00:00Z" },
    { id: "b", traineeId: "t2", observedAt: "2026-10-20T15:00:00Z" },
    { id: "c", traineeId: "gone", observedAt: "2026-10-19T15:00:00Z" },
  ];
  const { groups, orphaned } = O.groupByTrainee(obs, trainees);
  assert.deepStrictEqual(groups.map((g) => g.trainee.id), ["t1", "t2", "t3"]);
  assert.deepStrictEqual(groups[0].observations, []);
  assert.deepStrictEqual(groups[1].observations.map((o) => o.id), ["b", "a"]);
  assert.deepStrictEqual(orphaned.map((o) => o.id), ["c"]);
});

// 20 weekdays from Mon 2026-10-19.
const days = [];
for (const d = new Date(Date.UTC(2026, 9, 19)); days.length < 20; d.setUTCDate(d.getUTCDate() + 1))
  if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10));

test("weekOf: training days 1-5 are week 1, and so on; weekends belong to the week before", () => {
  assert.strictEqual(O.weekOf("2026-10-19", days), 1);
  assert.strictEqual(O.weekOf("2026-10-23", days), 1);
  assert.strictEqual(O.weekOf("2026-10-25", days), 1); // Sunday after week 1
  assert.strictEqual(O.weekOf("2026-10-26", days), 2);
  assert.strictEqual(O.weekOf("2026-11-13", days), 4);
  assert.strictEqual(O.weekOf("2026-10-18", days), 0);
  assert.strictEqual(O.weekOf("2026-11-16", days), O.WEEK_AFTER);
  assert.strictEqual(O.weekCount(days), 4);
  assert.deepStrictEqual(O.weekRange(2, days), { start: "2026-10-26", end: "2026-10-30" });
  assert.strictEqual(O.weekRange(0, days), null);
});

test("groupByWeek: newest week first, each observation once", () => {
  const obs = [{ id: "a", d: "2026-10-20" }, { id: "b", d: "2026-10-27" }, { id: "c", d: "2026-10-21" }, { id: "e", d: "2026-10-16" }];
  const g = O.groupByWeek(obs, days, (o) => o.d);
  assert.deepStrictEqual(g.map((x) => [x.week, x.observations.map((o) => o.id)]), [[2, ["b"]], [1, ["a", "c"]], [0, ["e"]]]);
});

console.log(`\n${passed}/9 passed`);
