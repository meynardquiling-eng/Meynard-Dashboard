// Tests for js/zoom-engine.js. Run: node zoom/test/engine.test.js
const assert = require("assert");
const Z = require("../../js/zoom-engine.js");

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// Laid out like Zoom's "Export with meeting data" participant report: a meeting block, a blank line, then
// one row per join/leave, with "In Waiting Room" rows for time spent waiting to be admitted.
const REPORT = [
  "Meeting ID,Topic,Start Time,End Time,User Email,Duration (Minutes),Participants",
  '852 1234 5678,"NH Cohort 10/19/2026, Day 1",10/19/2026 06:55:00 AM,10/19/2026 03:05:00 PM,trainer@co.com,490,5',
  "",
  "Name (Original Name),User Email,Join Time,Leave Time,Duration (Minutes),Guest,In Waiting Room",
  "Trainer Jo,trainer@co.com,10/19/2026 06:55:00 AM,10/19/2026 03:05:00 PM,490,No,No",
  "Ana Reyes,ana@co.com,10/19/2026 06:57:10 AM,10/19/2026 06:59:40 AM,3,Yes,Yes",
  "Ana Reyes,ana@co.com,10/19/2026 06:59:40 AM,10/19/2026 10:00:00 AM,181,Yes,No",
  "Ana Reyes,ana@co.com,10/19/2026 10:15:00 AM,10/19/2026 03:00:00 PM,285,Yes,No",
  '"Joel S. (Joel Santos)",,10/19/2026 07:20:00 AM,10/19/2026 12:00:00 PM,280,Yes,No',
  "Joel Santos,joel@co.com,10/19/2026 11:30:00 AM,10/19/2026 01:00:00 PM,90,Yes,No",
  "iPhone 12,,10/19/2026 08:00:00 AM,10/19/2026 08:30:00 AM,30,Yes,No",
  "Mika Lim,mika@co.com,10/19/2026 07:01:00 AM,10/19/2026 07:20:00 AM,19,Yes,Yes",
  "Broken Row,x@co.com,not a time,10/19/2026 08:30:00 AM,30,Yes,No",
].join("\r\n");

const TRAINEES = [
  { id: "t1", name: "Ana Reyes", email: "Ana@co.com" },
  { id: "t2", name: "joelsantos", email: "joel@co.com" },
  { id: "t3", name: "Mika Lim", email: "mika@co.com" },
  { id: "t4", name: "Rey Dizon", email: "rey@co.com" },
];

test("parseCsv: quotes, escaped quotes, CRLF, BOM, blank lines", () => {
  assert.deepStrictEqual(Z.parseCsv('﻿a,"b,c","d ""e"""\r\n\r\n1,2,3\n'), [["a", "b,c", 'd "e"'], ["1", "2", "3"]]);
  assert.deepStrictEqual(Z.parseCsv('x,"line1\nline2"'), [["x", "line1\nline2"]]);
});

test("parseZoomTime: the formats Zoom exports, 12-hour clock edge cases, junk", () => {
  assert.strictEqual(Z.parseZoomTime("10/19/2026 06:58:10 AM"), "2026-10-19 06:58:10");
  assert.strictEqual(Z.parseZoomTime("10/19/2026 12:05:00 AM"), "2026-10-19 00:05:00");
  assert.strictEqual(Z.parseZoomTime("10/19/2026 12:05:00 PM"), "2026-10-19 12:05:00");
  assert.strictEqual(Z.parseZoomTime("10/19/2026 01:05 PM"), "2026-10-19 13:05:00");
  assert.strictEqual(Z.parseZoomTime("2026-10-19 13:05:09"), "2026-10-19 13:05:09");
  assert.strictEqual(Z.parseZoomTime("Oct 19, 2026 07:01:02 AM"), "2026-10-19 07:01:02");
  assert.strictEqual(Z.parseZoomTime("not a time"), null);
  assert.strictEqual(Z.parseZoomTime("13/40/2026 07:00 AM"), null);
  assert.strictEqual(Z.clockLabel("2026-10-19 13:05:00"), "1:05 PM");
  assert.strictEqual(Z.clockLabel("2026-10-19 00:05:00"), "12:05 AM");
  assert.strictEqual(Z.durationLabel(185), "3h 05m");
  assert.strictEqual(Z.durationLabel(42), "42m");
});

test("readZoomReport: finds the participant table under the meeting block", () => {
  const r = Z.readZoomReport(REPORT);
  assert.deepStrictEqual(r.meeting, { topic: "NH Cohort 10/19/2026, Day 1", id: "852 1234 5678" });
  assert.strictEqual(r.hasWaitingColumn, true);
  assert.strictEqual(r.sessions.length, 8);
  assert.strictEqual(r.skipped, 1);
  assert.deepStrictEqual(r.sessions[1], { name: "Ana Reyes", email: "ana@co.com", join: "2026-10-19 06:57:10", leave: "2026-10-19 06:59:40", waiting: true });
  assert.ok(Object.keys(Z.sessionsByDate(r.sessions)).join() === "2026-10-19");
});

test("readZoomReport: a report without the waiting-room column, and a file that isn't a report", () => {
  const r = Z.readZoomReport("Name,Email,Join Time,Leave Time,Duration\nAna,ana@co.com,2026-10-19 07:00:00,2026-10-19 08:00:00,60\n");
  assert.strictEqual(r.hasWaitingColumn, false);
  assert.strictEqual(r.sessions[0].waiting, false);
  assert.throws(() => Z.readZoomReport("a,b\n1,2"), (e) => /no Join Time and Leave Time/.test(e.message));
  assert.throws(() => Z.readZoomReport("Name,Join Time,Leave Time\nAna,bad,bad"), (e) => /no rows with a valid/.test(e.message));
});

test("matchSession: email, then name or email username, original name in brackets, aliases, ignore", () => {
  const s = (name, email = "") => ({ name, email });
  assert.strictEqual(Z.matchSession(s("Anything", "ana@co.com"), TRAINEES), "t1");
  assert.strictEqual(Z.matchSession(s("ana reyes"), TRAINEES), "t1");
  assert.strictEqual(Z.matchSession(s("Joel Santos"), TRAINEES), "t2", "matches the trainee whose email username is joelsantos");
  assert.strictEqual(Z.matchSession(s("Joel S. (Joel Santos)"), TRAINEES), "t2");
  assert.strictEqual(Z.matchSession(s("iPhone 12"), TRAINEES), null);
  assert.strictEqual(Z.matchSession(s("iPhone 12"), TRAINEES, { "name:iphone12": "t4" }), "t4");
  assert.strictEqual(Z.matchSession(s("Trainer Jo", "trainer@co.com"), TRAINEES, { "email:trainer@co.com": "ignore" }), "ignore");
  // Two trainees with the same name: no guess.
  assert.strictEqual(Z.matchSession(s("Sam Cruz"), [{ id: "a", name: "Sam Cruz" }, { id: "b", name: "Sam Cruz" }]), null);
});

test("summarizeDay: tried to enter, admitted, left, time in Zoom (gaps and overlaps), drops, absent", () => {
  const r = Z.readZoomReport(REPORT);
  const day = Z.summarizeDay(r.sessions, TRAINEES, { "email:trainer@co.com": "ignore" }, { hasWaitingColumn: true });
  const by = Object.fromEntries(day.rows.map((x) => [x.trainee.id, x]));
  // Ana: waited 06:57:10, admitted 06:59:40, left 10:00, back 10:15 to 15:00 -> 3h00m20s + 4h45m = 465 min, 1 drop.
  assert.deepStrictEqual([by.t1.triedToEnter, by.t1.admitted, by.t1.left, by.t1.minutes, by.t1.drops], ["2026-10-19 06:57:10", "2026-10-19 06:59:40", "2026-10-19 15:00:00", 465, 1]);
  // Joel: two overlapping sessions (07:20-12:00 and 11:30-13:00) count once: 5h40m = 340 min, no drop.
  assert.deepStrictEqual([by.t2.admitted, by.t2.left, by.t2.minutes, by.t2.drops, by.t2.joinedDirectly], ["2026-10-19 07:20:00", "2026-10-19 13:00:00", 340, 0, true]);
  // Mika: only ever in the waiting room.
  assert.deepStrictEqual([by.t3.status, by.t3.triedToEnter, by.t3.admitted, by.t3.minutes], ["waiting-only", "2026-10-19 07:01:00", null, 0]);
  assert.strictEqual(by.t4.status, "absent");
  assert.deepStrictEqual(day.unmatched.map((u) => [u.name, u.minutes]), [["iPhone 12", 30]]);
  assert.strictEqual(day.ignored, 1);
});

test("mergeSessions: uploading the same report twice adds nothing; a second meeting adds its rows", () => {
  const r = Z.readZoomReport(REPORT);
  const first = Z.mergeSessions([], r.sessions);
  assert.strictEqual(first.added, 8);
  const again = Z.mergeSessions(first.sessions, r.sessions);
  assert.strictEqual(again.added, 0);
  const extra = Z.mergeSessions(first.sessions, [{ name: "Rey Dizon", email: "rey@co.com", join: "2026-10-19 13:00:00", leave: "2026-10-19 14:00:00", waiting: false }]);
  assert.deepStrictEqual([extra.added, extra.sessions.length], [1, 9]);
});

test("coverage: overlapping, touching and separate stretches", () => {
  assert.deepStrictEqual(Z.coverage([[0, 10], [5, 20], [20, 30], [40, 50]]), { seconds: 40, stretches: 2 });
  assert.deepStrictEqual(Z.coverage([]), { seconds: 0, stretches: 0 });
});

(async () => {
  let passed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log("ok   " + name); }
    catch (e) { console.log("FAIL " + name + "\n     " + (e && e.message)); }
  }
  console.log(`\n${passed}/${tests.length} passed`);
  process.exit(passed === tests.length ? 0 : 1);
})();
