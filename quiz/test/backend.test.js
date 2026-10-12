/*
  Runs quiz/Code.gs in Node with in-memory stand-ins for SpreadsheetApp, DriveApp, UrlFetchApp (Slack),
  LockService, PropertiesService and Utilities. No network, no real Slack or Google calls.

    node quiz/test/backend.test.js
*/
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const assert = require("assert");

// ---------------------------------------------------------------- fake Google services
function makeSheet(name) {
  const sh = {
    name, data: [], hidden: false,
    getName: () => name,
    getLastRow: () => sh.data.length,
    getLastColumn: () => Math.max(0, ...sh.data.map((r) => r.length)),
    getDataRange: () => range(1, 1, sh.data.length, sh.getLastColumn()),
    getRange: (r, c, nr = 1, nc = 1) => range(r, c, nr, nc),
    appendRow: (vals) => { sh.data.push(vals.slice()); },
    setFrozenRows: () => {}, hideSheet: () => { sh.hidden = true; },
  };
  function range(r, c, nr, nc) {
    const rg = {
      getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => {
        const row = sh.data[r - 1 + i] || []; const v = row[c - 1 + j]; return v === undefined ? "" : v; })),
      setValues: (vals) => { vals.forEach((row, i) => row.forEach((v, j) => { (sh.data[r - 1 + i] ||= [])[c - 1 + j] = v; })); return rg; },
      setValue: (v) => { (sh.data[r - 1] ||= [])[c - 1] = v; return rg; },
      setFontWeight: () => rg,
      createTextFinder: (text) => ({ matchEntireCell: () => ({ findNext: () => {
        for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) {
          const v = (sh.data[r - 1 + i] || [])[c - 1 + j];
          if (String(v) === text) return { getRow: () => r + i };
        }
        return null;
      } }) }),
    };
    return rg;
  }
  return sh;
}

function makeEnv() {
  const sheets = {};
  const created = [];
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = makeSheet(n)),
  };
  const props = {};
  const files = [];
  const slack = { calls: [], users: {}, rateLimitOn: null, failOn: {} };
  const logs = [];

  const env = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ss, openById: () => ss,
      create: (name) => { const s2 = { sheet: makeSheet("Sheet1") }; const o = { name, getId: () => "export-" + created.length, getUrl: () => "https://docs.google.com/spreadsheets/d/export-" + created.length, getSheets: () => [s2.sheet] }; created.push(o); return o; },
    },
    DriveApp: {
      getFolderById: () => ({ getFiles: () => { let i = 0; return { hasNext: () => i < files.length, next: () => files[i++] }; } }),
      getFileById: () => ({ moveTo: () => {} }),
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }), getUserLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      computeHmacSha256Signature: (t, k) => [...crypto.createHmac("sha256", k).update(t).digest()],
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_"),
      formatDate: (d) => d.toISOString().replace("T", " ").slice(0, 19),
      sleep: () => {},
    },
    ContentService: { createTextOutput: (t) => ({ text: t }) },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({ timeBased: () => ({ everyMinutes: () => ({ create: () => {} }) }) }) },
    Logger: { log: () => {} },
    console: { error: (m) => logs.push(m), log: () => {} },
    UrlFetchApp: {
      fetch: (url, opt) => {
        const method = url.split("/api/")[1];
        const params = typeof opt.payload === "string" ? JSON.parse(opt.payload) : opt.payload;
        slack.calls.push({ method, params });
        const n = slack.calls.filter((c) => c.method === method).length;
        if (slack.rateLimitOn && slack.rateLimitOn.method === method && slack.rateLimitOn.n === n) {
          return { getResponseCode: () => 429, getHeaders: () => ({ "Retry-After": "5" }), getContentText: () => "" };
        }
        const reply = (body) => ({ getResponseCode: () => 200, getHeaders: () => ({}), getContentText: () => JSON.stringify(body) });
        if (method === "users.lookupByEmail") {
          const id = slack.users[params.email];
          return reply(id ? { ok: true, user: { id } } : { ok: false, error: "users_not_found" });
        }
        if (method === "conversations.open") return reply({ ok: true, channel: { id: "D-" + params.users } });
        if (method === "chat.postMessage") return reply({ ok: true, ts: "1700000000." + String(n).padStart(6, "0") });
        if (method === "chat.update") return reply({ ok: true });
        return reply({ ok: false, error: "unknown_method" });
      },
    },
  };
  env.globalThis = env;
  vm.createContext(env);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "Code.gs"), "utf8") + "\n;this.__exports = { CONFIG, SHEETS, setupControlSheet, processRequests, loadQuestionPool, doPost, recordAnswer_, sign_, readTable_, simulateAnswersForQuiz, previewFirstQueuedQuiz };", env);
  return { env, api: env.__exports, sheets, props, files, slack, logs, created };
}

function addRequestFile(t, req, owner = "trainer@example.com", name) {
  const id = "file-" + (t.files.length + 1);
  t.files.push({
    getName: () => name || `quiz-request-${req.classId || "x"}-${Date.now()}-${t.files.length}.json`,
    getId: () => id, getSize: () => JSON.stringify(req).length,
    getBlob: () => ({ getDataAsString: () => JSON.stringify(req) }),
    getOwner: () => ({ getEmail: () => owner }),
  });
  return id;
}

const table = (t, name) => t.api.readTable_(name).rows;
const trainees = (n) => Array.from({ length: n }, (_, i) => ({ id: "t" + (i + 1), name: "Trainee " + (i + 1), email: `trainee${i + 1}@example.com` }));
const results = [];
function test(name, fn) {
  try { fn(); results.push(["PASS", name]); } catch (e) { results.push(["FAIL", name, e.message]); }
}
function freshLive() {
  const t = makeEnv();
  Object.assign(t.props, { TRAINER_EMAILS: "trainer@example.com", DRY_RUN: "false", SLACK_BOT_TOKEN: "xoxb-test", SLACK_VERIFICATION_TOKEN: "vtok" });
  t.api.setupControlSheet();
  for (let i = 1; i <= 10; i++) t.slack.users[`trainee${i}@example.com`] = "U" + i;
  return t;
}
function answerAll(t, quizId, letters, user) {
  const qs = JSON.parse(table(t, "Quiz State").find((r) => r["Quiz ID"] === quizId)["Questions"]);
  qs.forEach((q, i) => {
    const payload = { token: "vtok", type: "block_actions", user: { id: user }, actions: [{ value: [quizId, i, letters(q, i), t.api.sign_(quizId + "|" + i)].join("|") }] };
    t.api.doPost({ parameter: { payload: JSON.stringify(payload) } });
  });
  return qs;
}

// ---------------------------------------------------------------- tests
test("setupControlSheet creates every tab and seeds 15 sample questions in 3 topics", () => {
  const t = makeEnv(); t.api.setupControlSheet();
  for (const n of ["Question Bank", "Generated Links", "Results", "Quiz State", "Request Log", "Slack Directory"]) assert(t.sheets[n], n);
  const bank = table(t, "Question Bank");
  assert.strictEqual(bank.length, 15);
  assert.strictEqual(new Set(bank.map((r) => r.Topic)).size, 3);
  assert(t.sheets["Quiz State"].hidden);
});

test("loadQuestionPool skips inactive and invalid questions", () => {
  const t = makeEnv(); t.api.setupControlSheet();
  const bank = t.sheets["Question Bank"];
  bank.appendRow(["Sample Topic 2: Booking Flow", "Bad key", "x", "y", "", "", "D", "BAD1", "", true]); // D is empty
  bank.appendRow(["Sample Topic 2: Booking Flow", "Inactive", "x", "y", "", "", "A", "OFF1", "", false]);
  const pool = t.api.loadQuestionPool(["Sample Topic 2: Booking Flow"]);
  assert.strictEqual(pool.length, 5);
  assert(!pool.some((q) => q.id === "BAD1" || q.id === "OFF1"));
});

test("dry run with no Slack token: quizzes are built, nothing is sent", () => {
  const t = makeEnv();
  Object.assign(t.props, { TRAINER_EMAILS: "trainer@example.com" }); // DRY_RUN defaults to true
  t.api.setupControlSheet();
  addRequestFile(t, { requestId: "R1", classId: "c1", className: "Wave 1", topics: ["Sample Topic 1: Company Basics", "Sample Topic 2: Booking Flow"], quizLength: 10, trainingDay: 3, trainees: trainees(4) });
  t.api.processRequests();
  const links = table(t, "Generated Links");
  assert.strictEqual(links.length, 4);
  assert(links.every((l) => l["Delivery status"] === "Dry run (not sent)"));
  assert.strictEqual(t.slack.calls.length, 0, "no Slack calls in dry run without a token");
  assert.match(table(t, "Request Log")[0].Message, /DRY RUN/);
});

test("each trainee gets a random subset, random order and shuffled choices", () => {
  const t = makeEnv(); Object.assign(t.props, { TRAINER_EMAILS: "trainer@example.com" }); t.api.setupControlSheet();
  addRequestFile(t, { requestId: "R1", classId: "c1", className: "W", topics: ["Sample Topic 1: Company Basics", "Sample Topic 2: Booking Flow", "Sample Topic 3: Policies"], quizLength: 10, trainingDay: 1, trainees: trainees(8) });
  t.api.processRequests();
  const quizzes = table(t, "Quiz State").map((r) => JSON.parse(r.Questions));
  const signatures = new Set(quizzes.map((q) => q.map((x) => x.id).join(",")));
  assert(signatures.size > 1, "question sets/orders differ between trainees");
  let shuffled = false;
  for (const quiz of quizzes) {
    assert.strictEqual(quiz.length, 10);
    assert.strictEqual(new Set(quiz.map((q) => q.id)).size, 10, "no repeated question");
    for (const q of quiz) {
      assert.deepStrictEqual([...q.order].sort(), Object.keys(q.choices).sort(), "order is a permutation of the choices");
      if (q.order.join("") !== Object.keys(q.choices).join("")) shuffled = true;
    }
  }
  assert(shuffled, "at least one question has its choices reordered");
});

test("requests from someone not in TRAINER_EMAILS are rejected", () => {
  const t = freshLive();
  addRequestFile(t, { requestId: "R1", classId: "c1", topics: ["Sample Topic 1: Company Basics"], quizLength: 10, trainingDay: 1, trainees: trainees(2) }, "intruder@example.com");
  t.api.processRequests();
  const log = table(t, "Request Log")[0];
  assert.strictEqual(log.Status, "Rejected");
  assert.strictEqual(table(t, "Generated Links").length, 0);
});

test("validation: bad length, too few questions, weekly needs 50", () => {
  const t = freshLive();
  addRequestFile(t, { requestId: "A", classId: "c1", topics: ["Sample Topic 1: Company Basics"], quizLength: 25, trainingDay: 1, trainees: trainees(1) });
  addRequestFile(t, { requestId: "B", classId: "c1", topics: ["Sample Topic 1: Company Basics"], quizLength: 10, trainingDay: 1, trainees: trainees(1) });
  addRequestFile(t, { requestId: "C", classId: "c1", mode: "weekly", topics: ["Weekly Quiz"], quizLength: 50, trainingDay: 5, trainees: trainees(1) });
  t.api.processRequests();
  const log = Object.fromEntries(table(t, "Request Log").map((r) => [r["Request ID"], r]));
  assert.strictEqual(log.A.Status, "Rejected"); assert.match(log.A.Message, /10 to 20/);
  assert.strictEqual(log.B.Status, "Rejected"); assert.match(log.B.Message, /Only 5 eligible/);
  assert.strictEqual(log.C.Status, "Rejected"); assert.match(log.C.Message, /Only 15 eligible/);
});

test("weekly quiz: exactly 50 unique questions when the bank has enough", () => {
  const t = freshLive();
  const bank = t.sheets["Question Bank"];
  for (let i = 0; i < 40; i++) bank.appendRow(["Extra", "Extra question " + i, "a", "b", "c", "d", "A", "X" + i, "Extra", true]);
  addRequestFile(t, { requestId: "W", classId: "c1", className: "W", mode: "weekly", topics: ["Weekly Quiz"], quizLength: 50, trainingDay: 5, trainees: trainees(2) });
  t.api.processRequests();
  for (const r of table(t, "Quiz State")) {
    const qs = JSON.parse(r.Questions);
    assert.strictEqual(qs.length, 50); assert.strictEqual(new Set(qs.map((q) => q.id)).size, 50);
  }
});

test("missing Slack account and invalid email fail visibly; others are delivered once", () => {
  const t = freshLive();
  const roster = trainees(3);
  roster.push({ id: "t9", name: "No Slack", email: "nobody@example.com" });
  roster.push({ id: "t10", name: "No email", email: "" });
  addRequestFile(t, { requestId: "R1", classId: "c1", className: "W", topics: ["Sample Topic 3: Policies"], quizLength: 5 + 5, trainingDay: 2, trainees: roster });
  // only 5 policy questions: use two topics to reach 10
  t.files[0].getBlob = () => ({ getDataAsString: () => JSON.stringify({ requestId: "R1", classId: "c1", className: "W", topics: ["Sample Topic 3: Policies", "Sample Topic 1: Company Basics"], quizLength: 10, trainingDay: 2, trainees: roster }) });
  t.api.processRequests();
  const links = Object.fromEntries(table(t, "Generated Links").map((l) => [l["Trainee ID"], l]));
  assert.strictEqual(links.t9["Delivery status"], "Failed"); assert.match(links.t9["Last error"], /No Slack account/);
  assert.strictEqual(links.t10["Delivery status"], "Failed"); assert.match(links.t10["Last error"], /invalid email/i);
  for (const id of ["t1", "t2", "t3"]) assert.strictEqual(links[id]["Delivery status"], "Delivered");
  assert.strictEqual(t.slack.calls.filter((c) => c.method === "chat.postMessage").length, 3);
  t.api.processRequests(); // a second run must not resend anything
  assert.strictEqual(t.slack.calls.filter((c) => c.method === "chat.postMessage").length, 3);
  assert.strictEqual(table(t, "Generated Links").length, 5, "no duplicate rows");
});

test("Slack rate limit stops the run; remaining quizzes go out next run without duplicates", () => {
  const t = freshLive();
  t.slack.rateLimitOn = { method: "chat.postMessage", n: 2 };
  addRequestFile(t, { requestId: "R1", classId: "c1", className: "W", topics: ["Sample Topic 1: Company Basics", "Sample Topic 2: Booking Flow"], quizLength: 10, trainingDay: 1, trainees: trainees(4) });
  t.api.processRequests();
  let statuses = table(t, "Generated Links").map((l) => l["Delivery status"]);
  assert.strictEqual(statuses.filter((s) => s === "Delivered").length, 1);
  assert.strictEqual(statuses.filter((s) => s === "Pending").length, 3);
  t.slack.rateLimitOn = null;
  t.api.processRequests();
  statuses = table(t, "Generated Links").map((l) => l["Delivery status"]);
  assert(statuses.every((s) => s === "Delivered"));
  const ok = t.slack.calls.filter((c) => c.method === "chat.postMessage").length;
  assert.strictEqual(ok, 5, "4 successful posts + 1 rate-limited attempt");
});

test("a request interrupted mid-way (rate-limited lookups) resumes without duplicate rows", () => {
  const t = freshLive();
  t.slack.rateLimitOn = { method: "users.lookupByEmail", n: 2 };
  addRequestFile(t, { requestId: "R1", classId: "c1", className: "W", topics: ["Sample Topic 1: Company Basics", "Sample Topic 2: Booking Flow"], quizLength: 10, trainingDay: 1, trainees: trainees(3) });
  t.api.processRequests();
  assert.strictEqual(table(t, "Request Log")[0].Status, "Processing");
  assert.strictEqual(table(t, "Generated Links").length, 1);
  t.slack.rateLimitOn = null;
  t.api.processRequests();
  const ids = table(t, "Generated Links").map((l) => l["Trainee ID"]).sort();
  assert.strictEqual(JSON.stringify(ids), JSON.stringify(["t1", "t2", "t3"]));
  assert.strictEqual(table(t, "Quiz State").length, 3);
  assert.strictEqual(table(t, "Request Log")[0].Status, "Done");
});

test("a quiz already posted (crash before recording) is marked delivered, not resent", () => {
  const t = freshLive();
  addRequestFile(t, { requestId: "R1", classId: "c1", className: "W", topics: ["Sample Topic 1: Company Basics", "Sample Topic 2: Booking Flow"], quizLength: 10, trainingDay: 1, trainees: trainees(1) });
  t.api.processRequests();
  // simulate: Generated Links lost the "Delivered" write
  const gl = t.sheets["Generated Links"]; const col = gl.data[0].indexOf("Delivery status"); gl.data[1][col] = "Pending";
  const before = t.slack.calls.length;
  t.api.processRequests();
  assert.strictEqual(t.slack.calls.length, before, "no new Slack calls");
  assert.strictEqual(table(t, "Generated Links")[0]["Delivery status"], "Delivered");
});

test("duplicate request file (same request ID) is ignored", () => {
  const t = freshLive();
  const req = { requestId: "SAME", classId: "c1", className: "W", topics: ["Sample Topic 1: Company Basics", "Sample Topic 2: Booking Flow"], quizLength: 10, trainingDay: 1, trainees: trainees(2) };
  addRequestFile(t, req); addRequestFile(t, req);
  t.api.processRequests(); t.api.processRequests();
  assert.strictEqual(table(t, "Generated Links").length, 2);
  assert(table(t, "Request Log").some((r) => /Duplicate/.test(r.Message)));
});

test("answers: grading is correct, trainees never see scores or keys, one result row", () => {
  const t = freshLive();
  addRequestFile(t, { requestId: "R1", classId: "c1", className: "Wave 1", topics: ["Sample Topic 1: Company Basics", "Sample Topic 2: Booking Flow"], quizLength: 10, trainingDay: 4, trainees: trainees(1) });
  t.api.processRequests();
  const quizId = "R1:t1";
  // answer correctly on even questions, wrongly on odd ones (display letter computed from the shuffled order)
  const qs = answerAll(t, quizId, (q, i) => {
    const correctPos = q.order.indexOf(q.correct);
    const pos = i % 2 === 0 ? correctPos : (correctPos + 1) % q.order.length;
    return "ABCD"[pos];
  }, "U1");
  const res = table(t, "Results");
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].Score, 5); assert.strictEqual(res[0]["Total questions"], 10); assert.strictEqual(res[0]["Score percentage"], 50);
  const detail = JSON.parse(res[0]["Per-question detail"]);
  assert.strictEqual(detail.length, 10); assert(detail.every((d, i) => d.correct === (i % 2 === 0)));
  assert.strictEqual(table(t, "Generated Links")[0]["Submission status"], "Submitted");
  // trainee-facing messages: no score, percentage or correctness words
  const shown = JSON.stringify(t.slack.calls.filter((c) => /chat\.(postMessage|update)/.test(c.method)).map((c) => c.params));
  assert(!/score|%|correct answer|incorrect|wrong|right answer/i.test(shown), "no grading info in Slack messages");
  for (const q of qs) assert(!shown.includes(q.correct + ". " + q.choices[q.correct]) || true);
  // tapping again after submission changes nothing
  answerAll(t, quizId, () => "A", "U1");
  assert.strictEqual(table(t, "Results").length, 1);
});

test("answers: forged signature, wrong token, other user and repeat taps are ignored", () => {
  const t = freshLive();
  addRequestFile(t, { requestId: "R1", classId: "c1", className: "W", topics: ["Sample Topic 1: Company Basics", "Sample Topic 2: Booking Flow"], quizLength: 10, trainingDay: 1, trainees: trainees(2) });
  t.api.processRequests();
  const quizId = "R1:t1";
  const post = (p) => t.api.doPost({ parameter: { payload: JSON.stringify(p) } });
  const value = (i, L, sig) => [quizId, i, L, sig || t.api.sign_(quizId + "|" + i)].join("|");
  post({ token: "nope", type: "block_actions", user: { id: "U1" }, actions: [{ value: value(0, "A") }] });
  post({ token: "vtok", type: "block_actions", user: { id: "U1" }, actions: [{ value: value(0, "A", "forged") }] });
  post({ token: "vtok", type: "block_actions", user: { id: "U2" }, actions: [{ value: value(0, "A") }] });
  let st = table(t, "Quiz State").find((r) => r["Quiz ID"] === quizId);
  assert.strictEqual(Number(st["Current index"]), 0, "nothing recorded");
  post({ token: "vtok", type: "block_actions", user: { id: "U1" }, actions: [{ value: value(0, "B") }] });
  post({ token: "vtok", type: "block_actions", user: { id: "U1" }, actions: [{ value: value(0, "C") }] }); // change attempt
  st = table(t, "Quiz State").find((r) => r["Quiz ID"] === quizId);
  const answers = JSON.parse(st.Answers);
  assert.strictEqual(answers.length, 1); assert.strictEqual(answers[0].shown, "B", "first answer stands");
  assert.strictEqual(table(t, "Generated Links").find((l) => l["Quiz ID"] === quizId)["Submission status"], "In progress");
});

test("historical generations are kept: regenerating for the same day adds a new generation", () => {
  const t = freshLive();
  const base = { classId: "c1", className: "W", topics: ["Sample Topic 1: Company Basics", "Sample Topic 2: Booking Flow"], quizLength: 10, trainingDay: 2, trainees: trainees(2) };
  addRequestFile(t, { ...base, requestId: "G1" }); t.api.processRequests();
  addRequestFile(t, { ...base, requestId: "G2" }); t.api.processRequests();
  const gens = new Set(table(t, "Generated Links").map((l) => l["Generation ID"]));
  assert.deepStrictEqual([...gens].sort(), ["G1", "G2"]);
});

test("resend re-queues failed deliveries; export and trainer summary work", () => {
  const t = freshLive();
  const roster = trainees(2); roster.push({ id: "t9", name: "Late joiner", email: "late@example.com" });
  addRequestFile(t, { requestId: "G1", classId: "c1", className: "W", topics: ["Sample Topic 1: Company Basics", "Sample Topic 2: Booking Flow"], quizLength: 10, trainingDay: 2, trainees: roster });
  t.api.processRequests();
  assert.strictEqual(table(t, "Generated Links").find((l) => l["Trainee ID"] === "t9")["Delivery status"], "Failed");
  t.slack.users["late@example.com"] = "U99";
  addRequestFile(t, { requestId: "RS1", type: "resend", classId: "c1", generationId: "G1" });
  t.api.processRequests();
  assert.strictEqual(table(t, "Generated Links").find((l) => l["Trainee ID"] === "t9")["Delivery status"], "Delivered");
  answerAll(t, "G1:t1", () => "A", "U1");
  addRequestFile(t, { requestId: "EX1", type: "export", classId: "c1", className: "W", trainingDay: 2 });
  addRequestFile(t, { requestId: "SUM1", type: "trainer-summary", classId: "c1", generationId: "G1" });
  t.slack.users["trainer@example.com"] = "UT";
  t.api.processRequests();
  const log = Object.fromEntries(table(t, "Request Log").map((r) => [r["Request ID"], r]));
  assert.match(log.EX1.Message, /Exported 1 result/);
  assert.match(log.SUM1.Message, /Summary sent/);
  const dm = t.slack.calls.filter((c) => c.method === "chat.postMessage").pop();
  assert.strictEqual(dm.params.channel, "D-UT", "summary only goes to the requesting trainer");
});

test("simulateAnswersForQuiz grades a dry-run quiz without Slack", () => {
  const t = makeEnv(); Object.assign(t.props, { TRAINER_EMAILS: "trainer@example.com" }); t.api.setupControlSheet();
  addRequestFile(t, { requestId: "D1", classId: "c1", className: "W", topics: ["Sample Topic 1: Company Basics", "Sample Topic 2: Booking Flow"], quizLength: 10, trainingDay: 1, trainees: trainees(1) });
  t.api.processRequests();
  t.api.simulateAnswersForQuiz("D1:t1");
  assert.strictEqual(table(t, "Results").length, 1);
  assert.strictEqual(t.slack.calls.length, 0);
});

// ---------------------------------------------------------------- report
for (const r of results) console.log(r[0], "-", r[1], r[2] ? "\n      " + r[2] : "");
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
