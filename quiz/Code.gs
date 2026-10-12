/**
 * Trainer Hub — Quiz backend (Google Apps Script, bound to the Control Sheet).
 *
 * What it does
 *   - Every minute (time-driven trigger -> processRequests): reads new request files that the dashboard
 *     created in the Requests folder, validates them, builds one randomized quiz per trainee, and
 *     sends each quiz to the trainee as a Slack DM from the Trainer Hub Slack app.
 *   - When a trainee taps an answer button in Slack, Slack calls this script's web app (doPost).
 *     The answer is recorded, the message is replaced by the next question, and after the last
 *     question the quiz is graded here and written to "Results". Trainees never see scores or
 *     correct answers.
 *
 * Setup: see QUIZ.md in the repository. In short:
 *   1. Fill in CONFIG below.
 *   2. Script properties (Project settings -> Script properties):
 *        SLACK_BOT_TOKEN           xoxb-... from the Slack app (never put it in the dashboard)
 *        SLACK_VERIFICATION_TOKEN  "Verification Token" from the Slack app's Basic Information page
 *        TRAINER_EMAILS            comma-separated Google accounts allowed to submit requests
 *        DRY_RUN                   "true" while testing (nothing is sent to Slack), "false" to go live
 *   3. Run setupControlSheet() once, then installTrigger() once.
 *   4. Deploy -> New deployment -> Web app (Execute as: Me, Who has access: Anyone) and paste the
 *      /exec URL into the Slack app's Interactivity "Request URL".
 */

// ---------------------------------------------------------------- configuration
const CONFIG = {
  CONTROL_SHEET_ID: '',                    // blank = the spreadsheet this script is bound to
  REQUESTS_FOLDER_ID: 'PASTE_REQUESTS_FOLDER_ID',
  EXPORT_FOLDER_ID: '',                    // where "Export" creates result spreadsheets; blank = Requests folder
  TIME_ZONE: 'America/Chicago',
  REQUEST_PREFIX: 'quiz-request-',
  REGULAR_MIN: 10,
  REGULAR_MAX: 20,
  WEEKLY_LENGTH: 50,
  WEEKLY_TOPIC: 'Weekly Quiz',             // value the dashboard sends in `topics` for a Weekly Quiz
  TRAINING_DAYS: 20,
  MAX_TRAINEES: 200,
  MAX_REQUEST_BYTES: 200 * 1024,
  MAX_DELIVERY_ATTEMPTS: 5,
  RUN_BUDGET_MS: 4.5 * 60 * 1000,          // stop starting new work after this (Apps Script limit is 6 min)
  DELIVERY_PAUSE_MS: 350,                  // between DMs, to stay under Slack rate limits
};

const SHEETS = {
  BANK: 'Question Bank',
  LINKS: 'Generated Links',
  RESULTS: 'Results',
  STATE: 'Quiz State',          // backend-only: per-trainee question order, choice order, answers
  LOG: 'Request Log',           // one row per request file, read by the dashboard for status
  DIRECTORY: 'Slack Directory', // email -> Slack user id, read by the dashboard
};

const HEADERS = {
  [SHEETS.BANK]: ['Topic', 'Question', 'Choice A', 'Choice B', 'Choice C', 'Choice D', 'Correct answer',
    'Question ID', 'Category', 'Active', 'Explanation', 'Difficulty'],
  [SHEETS.LINKS]: ['Generation ID', 'Class ID', 'Class name', 'Trainee ID', 'Trainee name', 'Trainee email',
    'Slack user ID', 'Training day', 'Generation date/time', 'Topics', 'Quiz length', 'Delivery status',
    'Slack message or quiz reference', 'Submission status', 'Submission timestamp', 'Quiz ID',
    'Delivery attempts', 'Last error', 'Mode'],
  [SHEETS.RESULTS]: ['Generation ID', 'Class ID', 'Class name', 'Trainee ID', 'Trainee name', 'Trainee email',
    'Training day', 'Submission timestamp', 'Score', 'Total questions', 'Score percentage',
    'Per-question detail', 'Quiz ID'],
  [SHEETS.STATE]: ['Quiz ID', 'Generation ID', 'Trainee ID', 'Slack user ID', 'Channel ID', 'Message TS',
    'Questions', 'Answers', 'Current index', 'Status', 'Updated at'],
  [SHEETS.LOG]: ['Request ID', 'Type', 'File ID', 'File name', 'Requested by', 'Received at', 'Status',
    'Message', 'Updated at', 'Class ID', 'Training day'],
  [SHEETS.DIRECTORY]: ['Email', 'Slack user ID', 'Status', 'Error', 'Checked at'],
};

const DELIVERY = { PENDING: 'Pending', DELIVERED: 'Delivered', FAILED: 'Failed', DRY_RUN: 'Dry run (not sent)' };
const SUBMISSION = { NOT_STARTED: 'Not started', IN_PROGRESS: 'In progress', SUBMITTED: 'Submitted', FAILED: 'Delivery failed' };
const LETTERS = ['A', 'B', 'C', 'D'];

// ---------------------------------------------------------------- small helpers
function props_() { return PropertiesService.getScriptProperties(); }
function isDryRun_() { return String(props_().getProperty('DRY_RUN') || 'true').toLowerCase() !== 'false'; }
function nowIso_() { return new Date().toISOString(); }
function centralStamp_(d) { return Utilities.formatDate(d || new Date(), CONFIG.TIME_ZONE, 'yyyy-MM-dd HH:mm:ss'); }
function isEmail_(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '')); }

/** Structured log line. Never pass answers, answer keys or tokens in `ctx`. */
function logError_(where, err, ctx) {
  console.error(JSON.stringify({ where: where, error: String(err && err.message || err), ctx: ctx || {} }));
}

function spreadsheet_() {
  return CONFIG.CONTROL_SHEET_ID ? SpreadsheetApp.openById(CONFIG.CONTROL_SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  const sh = spreadsheet_().getSheetByName(name);
  if (!sh) throw new Error('Missing tab "' + name + '". Run setupControlSheet().');
  return sh;
}

/** Reads a tab into objects keyed by header; each object carries its sheet row number in `_row`. */
function readTable_(name) {
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  const headers = values[0].map(String);
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const o = { _row: i + 1 };
    headers.forEach(function (h, j) { o[h] = values[i][j]; });
    rows.push(o);
  }
  return { sheet: sh, headers: headers, rows: rows };
}

function appendRow_(name, obj) {
  const sh = sheet_(name);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  sh.appendRow(headers.map(function (h) { return obj[h] === undefined ? '' : obj[h]; }));
  return sh.getLastRow();
}

/** Updates only the named cells of one row, so concurrent writers never clobber other columns. */
function updateCells_(name, row, obj) {
  const sh = sheet_(name);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  Object.keys(obj).forEach(function (key) {
    const col = headers.indexOf(key);
    if (col >= 0) sh.getRange(row, col + 1).setValue(obj[key]);
  });
}

/** Finds the row whose `column` exactly equals `value` (fast, uses TextFinder). Returns row number or 0. */
function findRow_(name, column, value) {
  const sh = sheet_(name);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const col = headers.indexOf(column);
  if (col < 0 || sh.getLastRow() < 2) return 0;
  const hit = sh.getRange(2, col + 1, sh.getLastRow() - 1, 1).createTextFinder(String(value)).matchEntireCell(true).findNext();
  return hit ? hit.getRow() : 0;
}

function rowObject_(name, row) {
  const sh = sheet_(name);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const values = sh.getRange(row, 1, 1, headers.length).getValues()[0];
  const o = { _row: row };
  headers.forEach(function (h, j) { o[h] = values[j]; });
  return o;
}

function shuffle_(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/** Short HMAC so a button value can't be forged to answer someone else's quiz. */
function sign_(text) {
  let secret = props_().getProperty('QUIZ_SIGNING_SECRET');
  if (!secret) { secret = Utilities.getUuid() + Utilities.getUuid(); props_().setProperty('QUIZ_SIGNING_SECRET', secret); }
  const bytes = Utilities.computeHmacSha256Signature(text, secret);
  return Utilities.base64EncodeWebSafe(bytes).slice(0, 16);
}

// ---------------------------------------------------------------- setup
/** Creates any missing tabs with their headers and seeds the Question Bank template if it's empty. */
function setupControlSheet() {
  const ss = spreadsheet_();
  Object.keys(HEADERS).forEach(function (name) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  });
  const bank = ss.getSheetByName(SHEETS.BANK);
  if (bank.getLastRow() === 1) {
    const rows = SAMPLE_QUESTIONS.map(function (q, i) {
      return [q[0], q[1], q[2], q[3], q[4], q[5], q[6], 'Q' + String(i + 1).padStart(3, '0'), q[7], true, '', ''];
    });
    bank.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
  }
  ss.getSheetByName(SHEETS.STATE).hideSheet();
  sign_('init'); // makes sure the signing secret exists
  Logger.log('Control Sheet ready. Dry run is ' + (isDryRun_() ? 'ON' : 'OFF') + '.');
}

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'processRequests') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processRequests').timeBased().everyMinutes(1).create();
  Logger.log('processRequests will run every minute.');
}

// ---------------------------------------------------------------- question bank
/**
 * Checks one Question Bank row. Returns an error string, or '' when the question is usable.
 * Correct answer must be a single letter (A-D) whose choice is filled in; at least two choices.
 */
function validateQuestion_(r) {
  if (!String(r['Topic']).trim()) return 'missing topic';
  if (!String(r['Question']).trim()) return 'missing question';
  const filled = LETTERS.filter(function (L) { return String(r['Choice ' + L]).trim() !== ''; });
  if (filled.length < 2) return 'needs at least two choices';
  const correct = String(r['Correct answer']).trim().toUpperCase();
  if (LETTERS.indexOf(correct) < 0) return 'correct answer must be A, B, C or D';
  if (filled.indexOf(correct) < 0) return 'correct answer ' + correct + ' points at an empty choice';
  return '';
}

function isActive_(r) {
  const v = String(r['Active']).trim().toLowerCase();
  return v === '' || v === 'true' || v === 'yes' || v === '1';
}

/**
 * Eligible questions for the given topics (all topics for the Weekly Quiz).
 * Each: { id, topic, question, choices: {A: text, ...}, correct: 'B' }.
 */
function loadQuestionPool(topics) {
  const weekly = topics.length === 1 && topics[0] === CONFIG.WEEKLY_TOPIC;
  const wanted = {};
  topics.forEach(function (t) { wanted[String(t).trim().toLowerCase()] = true; });
  const pool = [];
  readTable_(SHEETS.BANK).rows.forEach(function (r) {
    if (!isActive_(r) || validateQuestion_(r)) return;
    if (!weekly && !wanted[String(r['Topic']).trim().toLowerCase()]) return;
    const choices = {};
    LETTERS.forEach(function (L) { const t = String(r['Choice ' + L]).trim(); if (t) choices[L] = t; });
    pool.push({
      id: String(r['Question ID'] || ('row' + r._row)),
      topic: String(r['Topic']).trim(),
      question: String(r['Question']).trim(),
      choices: choices,
      correct: String(r['Correct answer']).trim().toUpperCase(),
    });
  });
  return pool;
}

/**
 * One trainee's quiz: a random subset of `length` questions in random order, each with its choices in
 * random order. Stored with a snapshot of the question text, choices and key so results can be
 * reproduced even if the Question Bank changes later.
 */
function buildQuiz_(pool, length) {
  return shuffle_(pool).slice(0, length).map(function (q) {
    return { id: q.id, topic: q.topic, question: q.question, choices: q.choices, correct: q.correct,
      order: shuffle_(Object.keys(q.choices)) }; // order[i] = original letter shown as display letter LETTERS[i]
  });
}

// ---------------------------------------------------------------- Slack API
function slackToken_() {
  const t = props_().getProperty('SLACK_BOT_TOKEN');
  if (!t) throw new Error('SLACK_BOT_TOKEN script property is not set');
  return t;
}

/**
 * Calls a Slack Web API method. Throws {code, retryAfter?} on failure.
 * Uses only documented methods: users.lookupByEmail, conversations.open, chat.postMessage, chat.update.
 */
function slack_(method, params, asForm) {
  const options = { method: 'post', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + slackToken_() } };
  if (asForm) options.payload = params;
  else { options.contentType = 'application/json; charset=utf-8'; options.payload = JSON.stringify(params); }
  const res = UrlFetchApp.fetch('https://slack.com/api/' + method, options);
  if (res.getResponseCode() === 429) {
    const h = res.getHeaders();
    throw { code: 'ratelimited', retryAfter: Number(h['Retry-After'] || h['retry-after'] || 30) };
  }
  let body;
  try { body = JSON.parse(res.getContentText()); } catch (e) { throw { code: 'bad_response_' + res.getResponseCode() }; }
  if (!body.ok) throw { code: body.error || 'unknown_error' };
  return body;
}

/** Friendly text for Slack error codes the trainer can act on. */
function slackErrorText_(code) {
  const map = {
    users_not_found: 'No Slack account uses this email. Check the trainee\'s work email or Slack profile.',
    user_not_found: 'Slack account not found.',
    cannot_dm_bot: 'This Slack account is a bot.',
    user_disabled: 'This Slack account is deactivated.',
    not_allowed_token_type: 'The Slack token is the wrong type; use the bot token (xoxb-).',
    missing_scope: 'The Slack app is missing a permission scope. See QUIZ.md.',
    invalid_auth: 'The Slack bot token is invalid.',
    account_inactive: 'The Slack app was uninstalled or its token revoked.',
    restricted_action: 'Workspace settings block this app from messaging this person.',
    ratelimited: 'Slack rate limit reached; will retry.',
  };
  return map[code] || ('Slack error: ' + code);
}

/** email -> Slack user id, cached in the Slack Directory tab. Returns {id} or {error}. */
function resolveSlackUser_(email) {
  email = String(email || '').trim().toLowerCase();
  if (!isEmail_(email)) return { error: 'Missing or invalid email' };
  if (isDryRun_() && !props_().getProperty('SLACK_BOT_TOKEN')) {
    // Dry run before the Slack app exists: pretend every valid email resolves, and say so.
    upsertDirectory_(email, 'DRYRUN', 'Dry run', 'No Slack token yet; not a real lookup');
    return { id: 'DRYRUN' };
  }
  try {
    const body = slack_('users.lookupByEmail', { email: email }, true);
    upsertDirectory_(email, body.user.id, 'Found', '');
    return { id: body.user.id };
  } catch (e) {
    if (e && e.code === 'ratelimited') throw e;
    const msg = slackErrorText_(e && e.code || String(e));
    upsertDirectory_(email, '', 'Not found', msg);
    return { error: msg };
  }
}

function upsertDirectory_(email, slackId, status, error) {
  try {
    const row = findRow_(SHEETS.DIRECTORY, 'Email', email);
    const values = { 'Email': email, 'Slack user ID': slackId, 'Status': status, 'Error': error, 'Checked at': nowIso_() };
    if (row) updateCells_(SHEETS.DIRECTORY, row, values); else appendRow_(SHEETS.DIRECTORY, values);
  } catch (e) { logError_('upsertDirectory', e, { status: status }); }
}

// ---------------------------------------------------------------- Slack messages (trainee-facing: never scores or keys)
function mrkdwn_(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function questionBlocks_(quizId, header, questions, index) {
  const q = questions[index];
  const choiceLines = q.order.map(function (orig, i) { return '*' + LETTERS[i] + '.* ' + mrkdwn_(q.choices[orig]); }).join('\n');
  const sig = sign_(quizId + '|' + index);
  return [
    { type: 'context', elements: [{ type: 'mrkdwn', text: mrkdwn_(header) }] },
    { type: 'section', text: { type: 'mrkdwn', text: '*Question ' + (index + 1) + ' of ' + questions.length + '*\n' + mrkdwn_(q.question) } },
    { type: 'section', text: { type: 'mrkdwn', text: choiceLines } },
    { type: 'actions', block_id: 'quiz_answer', elements: q.order.map(function (orig, i) {
      return { type: 'button', action_id: 'answer_' + LETTERS[i], text: { type: 'plain_text', text: LETTERS[i] },
        value: [quizId, index, LETTERS[i], sig].join('|') };
    }) },
    { type: 'context', elements: [{ type: 'mrkdwn', text: 'Tap the letter of your answer. Each answer is final. Your answers are private.' }] },
  ];
}

function doneBlocks_(header, count) {
  return [
    { type: 'context', elements: [{ type: 'mrkdwn', text: mrkdwn_(header) }] },
    { type: 'section', text: { type: 'mrkdwn', text: ':white_check_mark: *Quiz submitted.* ' + count + ' answers recorded. Thank you! Your trainer will review the results.' } },
  ];
}

// ---------------------------------------------------------------- request processing (time-driven trigger)
function processRequests() {
  const started = Date.now();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return; // a previous run is still working
  try {
    let folder;
    try { folder = DriveApp.getFolderById(CONFIG.REQUESTS_FOLDER_ID); }
    catch (e) { logError_('openRequestsFolder', e, {}); return; }

    const handled = {};
    try {
      readTable_(SHEETS.LOG).rows.forEach(function (r) {
        if (['Done', 'Rejected', 'Done with errors'].indexOf(String(r['Status'])) >= 0) handled[String(r['File ID'])] = true;
      });
    } catch (e) { logError_('readLog', e, {}); return; }

    const files = folder.getFiles();
    while (files.hasNext() && Date.now() - started < CONFIG.RUN_BUDGET_MS) {
      const file = files.next();
      if (file.getName().indexOf(CONFIG.REQUEST_PREFIX) !== 0 || handled[file.getId()]) continue;
      try { handleRequestFile_(file); }
      catch (e) { logError_('handleRequestFile', e, { fileId: file.getId() }); }
    }
    deliverPending_(started);
  } finally {
    lock.releaseLock();
  }
}

function logRequest_(requestId, fields) {
  try {
    const row = findRow_(SHEETS.LOG, 'Request ID', requestId);
    fields['Updated at'] = nowIso_();
    if (row) updateCells_(SHEETS.LOG, row, fields);
    else { fields['Request ID'] = requestId; fields['Received at'] = nowIso_(); appendRow_(SHEETS.LOG, fields); }
  } catch (e) { logError_('logRequest', e, { requestId: requestId }); }
}

/** Reads, authorizes and validates one request file, then hands it to its type's handler. The file is never modified. */
function handleRequestFile_(file) {
  const base = { 'File ID': file.getId(), 'File name': file.getName() };
  let req;
  try {
    if (file.getSize() > CONFIG.MAX_REQUEST_BYTES) throw new Error('Request file is too large');
    req = JSON.parse(file.getBlob().getDataAsString());
  } catch (e) {
    logRequest_(file.getId(), Object.assign(base, { 'Type': 'unknown', 'Status': 'Rejected', 'Message': 'Not a valid JSON request: ' + e.message }));
    return;
  }
  const requestId = String(req.requestId || file.getId()).slice(0, 80);
  const type = String(req.type || 'generate');

  // A second file carrying an already-logged request ID (e.g. a double click) is never processed twice.
  const prior = findRow_(SHEETS.LOG, 'Request ID', requestId);
  if (prior && String(rowObject_(SHEETS.LOG, prior)['File ID']) !== file.getId()) {
    logRequest_(file.getId(), Object.assign(base, { 'Type': type, 'Status': 'Rejected', 'Message': 'Duplicate of request ' + requestId + '; ignored.' }));
    return;
  }

  // Backend authorization: only files owned by a listed trainer are processed.
  let owner = '';
  try { owner = file.getOwner() ? file.getOwner().getEmail().toLowerCase() : ''; } catch (e) { logError_('fileOwner', e, { requestId: requestId }); }
  const trainers = String(props_().getProperty('TRAINER_EMAILS') || '').toLowerCase().split(',').map(function (s) { return s.trim(); }).filter(String);
  Object.assign(base, { 'Type': type, 'Requested by': owner, 'Class ID': String(req.classId || ''), 'Training day': req.trainingDay || '' });
  if (!owner || trainers.indexOf(owner) < 0) {
    logRequest_(requestId, Object.assign(base, { 'Status': 'Rejected', 'Message': 'Requester ' + (owner || '(unknown)') + ' is not in TRAINER_EMAILS.' }));
    return;
  }

  logRequest_(requestId, Object.assign(base, { 'Status': 'Processing', 'Message': '' }));
  try {
    const handlers = { generate: handleGenerate_, 'resolve-roster': handleResolveRoster_, resend: handleResend_, 'trainer-summary': handleTrainerSummary_, export: handleExport_ };
    if (!handlers[type]) throw { reject: 'Unknown request type "' + type + '"' };
    const message = handlers[type](req, requestId, owner);
    logRequest_(requestId, { 'Status': /fail/i.test(message) ? 'Done with errors' : 'Done', 'Message': message });
  } catch (e) {
    if (e && e.reject) logRequest_(requestId, { 'Status': 'Rejected', 'Message': e.reject });
    else if (e && e.code === 'ratelimited') logRequest_(requestId, { 'Status': 'Processing', 'Message': 'Slack rate limit; continuing next minute.' });
    else { logError_('handler:' + type, e, { requestId: requestId }); logRequest_(requestId, { 'Status': 'Processing', 'Message': 'Temporary error, will retry: ' + String(e && e.message || e.code || e) }); }
  }
}

function reject_(msg) { throw { reject: msg }; }

function validateRoster_(trainees) {
  if (!Array.isArray(trainees) || !trainees.length) reject_('No trainees in the request.');
  if (trainees.length > CONFIG.MAX_TRAINEES) reject_('Too many trainees (max ' + CONFIG.MAX_TRAINEES + ').');
  trainees.forEach(function (t) {
    if (!t || !String(t.id || '').trim() || !String(t.name || '').trim()) reject_('Every trainee needs an id and a name.');
  });
}

/** Generate: one quiz per trainee, queued for delivery. Safe to re-run: existing rows are skipped. */
function handleGenerate_(req, generationId) {
  const weekly = req.mode === 'weekly' || (req.topics && req.topics.length === 1 && req.topics[0] === CONFIG.WEEKLY_TOPIC);
  const topics = weekly ? [CONFIG.WEEKLY_TOPIC] : (req.topics || []).map(String).filter(String);
  const length = Number(req.quizLength);
  const day = Number(req.trainingDay);
  if (!String(req.classId || '').trim()) reject_('Missing classId.');
  if (!weekly && !topics.length) reject_('No topics selected.');
  if (weekly && length !== CONFIG.WEEKLY_LENGTH) reject_('Weekly Quiz must be exactly ' + CONFIG.WEEKLY_LENGTH + ' questions.');
  if (!weekly && !(length >= CONFIG.REGULAR_MIN && length <= CONFIG.REGULAR_MAX && length === Math.floor(length))) reject_('Quiz length must be a whole number from ' + CONFIG.REGULAR_MIN + ' to ' + CONFIG.REGULAR_MAX + '.');
  if (!(day >= 1 && day <= CONFIG.TRAINING_DAYS && day === Math.floor(day))) reject_('Training day must be 1 to ' + CONFIG.TRAINING_DAYS + '.');
  validateRoster_(req.trainees);

  const pool = loadQuestionPool(topics);
  if (pool.length < length) reject_('Only ' + pool.length + ' eligible questions for ' + topics.join(', ') + '; ' + length + ' needed.');

  const existing = {};
  readTable_(SHEETS.LINKS).rows.forEach(function (r) { if (String(r['Generation ID']) === generationId) existing[String(r['Trainee ID'])] = true; });

  let queued = 0, failed = 0;
  const generatedAt = centralStamp_();
  req.trainees.forEach(function (t) {
    const traineeId = String(t.id);
    if (existing[traineeId]) return; // already created on an earlier run
    const quizId = generationId + ':' + traineeId;
    const email = String(t.email || '').trim().toLowerCase();
    const who = resolveSlackUser_(email); // may throw ratelimited: the request stays Processing and resumes next minute
    const questions = buildQuiz_(pool, length);
    appendRow_(SHEETS.STATE, {
      'Quiz ID': quizId, 'Generation ID': generationId, 'Trainee ID': traineeId, 'Slack user ID': who.id || '',
      'Questions': JSON.stringify(questions), 'Answers': '[]', 'Current index': 0,
      'Status': who.id ? 'Queued' : 'Not deliverable', 'Updated at': nowIso_(),
    });
    appendRow_(SHEETS.LINKS, {
      'Generation ID': generationId, 'Class ID': String(req.classId), 'Class name': String(req.className || ''),
      'Trainee ID': traineeId, 'Trainee name': String(t.name), 'Trainee email': email, 'Slack user ID': who.id || '',
      'Training day': day, 'Generation date/time': generatedAt, 'Topics': topics.join(', '), 'Quiz length': length,
      'Delivery status': who.id ? DELIVERY.PENDING : DELIVERY.FAILED, 'Slack message or quiz reference': '',
      'Submission status': who.id ? SUBMISSION.NOT_STARTED : SUBMISSION.FAILED, 'Submission timestamp': '',
      'Quiz ID': quizId, 'Delivery attempts': 0, 'Last error': who.error || '', 'Mode': weekly ? 'weekly' : 'regular',
    });
    if (who.id) queued++; else failed++;
  });
  return 'Queued ' + queued + ' quiz' + (queued === 1 ? '' : 'zes') + (failed ? '; ' + failed + ' failed (no Slack account)' : '') + (isDryRun_() ? '. DRY RUN: nothing will be sent to Slack.' : '.');
}

/** Delivers queued quizzes until the time budget runs out. Each trainee is tracked separately. */
function deliverPending_(started) {
  let links;
  try { links = readTable_(SHEETS.LINKS).rows.filter(function (r) { return r['Delivery status'] === DELIVERY.PENDING; }); }
  catch (e) { logError_('readPending', e, {}); return; }

  for (let i = 0; i < links.length; i++) {
    if (Date.now() - started > CONFIG.RUN_BUDGET_MS) return;
    const link = links[i];
    const quizId = String(link['Quiz ID']);
    try {
      const stateRow = findRow_(SHEETS.STATE, 'Quiz ID', quizId);
      if (!stateRow) throw new Error('quiz state missing');
      const state = rowObject_(SHEETS.STATE, stateRow);

      if (state['Message TS']) { // already posted on an earlier run that stopped before recording it: never resend
        updateCells_(SHEETS.LINKS, link._row, { 'Delivery status': DELIVERY.DELIVERED, 'Slack message or quiz reference': state['Channel ID'] + ':' + state['Message TS'] });
        continue;
      }
      if (isDryRun_()) {
        updateCells_(SHEETS.LINKS, link._row, { 'Delivery status': DELIVERY.DRY_RUN, 'Slack message or quiz reference': 'dry-run:' + quizId });
        continue;
      }

      const questions = JSON.parse(state['Questions']);
      const header = link['Class name'] + ' · Day ' + link['Training day'] + ' quiz · ' + questions.length + ' questions';
      const channel = slack_('conversations.open', { users: String(state['Slack user ID']) }).channel.id;
      updateCells_(SHEETS.STATE, stateRow, { 'Channel ID': channel });
      const posted = slack_('chat.postMessage', { channel: channel, text: 'Your quiz: question 1 of ' + questions.length, blocks: questionBlocks_(quizId, header, questions, 0) });
      updateCells_(SHEETS.STATE, stateRow, { 'Message TS': posted.ts, 'Status': 'Delivered', 'Updated at': nowIso_() });
      updateCells_(SHEETS.LINKS, link._row, { 'Delivery status': DELIVERY.DELIVERED, 'Slack message or quiz reference': channel + ':' + posted.ts, 'Last error': '' });
      Utilities.sleep(CONFIG.DELIVERY_PAUSE_MS);
    } catch (e) {
      if (e && e.code === 'ratelimited') { logError_('deliver:ratelimited', e.code, { quizId: quizId }); return; } // resume next minute
      const attempts = Number(link['Delivery attempts'] || 0) + 1;
      const giveUp = attempts >= CONFIG.MAX_DELIVERY_ATTEMPTS || ['users_not_found', 'user_disabled', 'cannot_dm_bot', 'restricted_action'].indexOf(e && e.code) >= 0;
      logError_('deliver', e && e.code || e, { quizId: quizId, attempts: attempts });
      try {
        updateCells_(SHEETS.LINKS, link._row, {
          'Delivery attempts': attempts, 'Last error': slackErrorText_(e && e.code || String(e && e.message || e)),
          'Delivery status': giveUp ? DELIVERY.FAILED : DELIVERY.PENDING,
          'Submission status': giveUp ? SUBMISSION.FAILED : link['Submission status'],
        });
      } catch (e2) { logError_('deliver:record', e2, { quizId: quizId }); }
    }
  }
}

/** resolve-roster: look up each trainee's Slack account so the dashboard can show who can receive quizzes. */
function handleResolveRoster_(req) {
  validateRoster_(req.trainees);
  let found = 0, missing = 0;
  req.trainees.forEach(function (t) {
    const r = resolveSlackUser_(t.email);
    if (r.id) found++; else missing++;
  });
  return 'Slack accounts found: ' + found + '; not found: ' + missing + '.';
}

/** resend: retry failed deliveries, and nudge delivered-but-not-started trainees (no quiz content in the nudge). */
function handleResend_(req) {
  const generationId = String(req.generationId || '');
  if (!generationId) reject_('Missing generationId.');
  const only = Array.isArray(req.traineeIds) && req.traineeIds.length ? req.traineeIds.map(String) : null;
  let requeued = 0, reminded = 0, failed = 0;
  readTable_(SHEETS.LINKS).rows.forEach(function (r) {
    if (String(r['Generation ID']) !== generationId || (only && only.indexOf(String(r['Trainee ID'])) < 0)) return;
    try {
      if (r['Delivery status'] === DELIVERY.FAILED) {
        const who = resolveSlackUser_(r['Trainee email']);
        if (!who.id) { failed++; updateCells_(SHEETS.LINKS, r._row, { 'Last error': who.error }); return; }
        const stateRow = findRow_(SHEETS.STATE, 'Quiz ID', r['Quiz ID']);
        if (stateRow) updateCells_(SHEETS.STATE, stateRow, { 'Slack user ID': who.id, 'Status': 'Queued' });
        updateCells_(SHEETS.LINKS, r._row, { 'Slack user ID': who.id, 'Delivery status': DELIVERY.PENDING, 'Delivery attempts': 0, 'Last error': '', 'Submission status': SUBMISSION.NOT_STARTED });
        requeued++;
      } else if (r['Delivery status'] === DELIVERY.DELIVERED && r['Submission status'] !== SUBMISSION.SUBMITTED && !isDryRun_()) {
        const ref = String(r['Slack message or quiz reference']).split(':');
        slack_('chat.postMessage', { channel: ref[0], thread_ts: ref[1], text: 'Reminder: your quiz is waiting in the message above. Tap a letter to answer.' });
        reminded++;
      }
    } catch (e) {
      if (e && e.code === 'ratelimited') throw e;
      failed++; logError_('resend', e && e.code || e, { quizId: String(r['Quiz ID']) });
    }
  });
  return 'Re-queued ' + requeued + ', reminded ' + reminded + (failed ? ', failed ' + failed : '') + (isDryRun_() ? ' (dry run: no reminders sent)' : '') + '.';
}

/** trainer-summary: DM a results summary to the trainer who asked (never to trainees). */
function handleTrainerSummary_(req, requestId, owner) {
  const generationId = String(req.generationId || '');
  if (!generationId) reject_('Missing generationId.');
  const links = readTable_(SHEETS.LINKS).rows.filter(function (r) { return String(r['Generation ID']) === generationId; });
  if (!links.length) reject_('No quizzes found for that generation.');
  const results = {};
  readTable_(SHEETS.RESULTS).rows.forEach(function (r) { if (String(r['Generation ID']) === generationId) results[String(r['Trainee ID'])] = r; });
  const lines = links.map(function (l) {
    const res = results[String(l['Trainee ID'])];
    return '• ' + l['Trainee name'] + ': ' + (res ? res['Score percentage'] + '% (' + res['Score'] + '/' + res['Total questions'] + ')' : l['Submission status']);
  });
  const scores = Object.keys(results).map(function (k) { return Number(results[k]['Score percentage']); });
  const avg = scores.length ? Math.round(scores.reduce(function (a, b) { return a + b; }, 0) / scores.length * 10) / 10 : null;
  const text = '*Quiz results: ' + links[0]['Class name'] + ', Day ' + links[0]['Training day'] + '*\n' +
    'Submitted ' + scores.length + ' of ' + links.length + (avg === null ? '' : ' · average ' + avg + '%') + '\n' + lines.join('\n');
  if (isDryRun_()) return 'Dry run: summary for ' + owner + ' prepared, not sent.';
  const who = resolveSlackUser_(owner);
  if (!who.id) return 'Failed: no Slack account for ' + owner + '.';
  const channel = slack_('conversations.open', { users: who.id }).channel.id;
  slack_('chat.postMessage', { channel: channel, text: text });
  return 'Summary sent to ' + owner + ' by Slack DM.';
}

/** export: copy the selected results into a new spreadsheet in the export folder. */
function handleExport_(req) {
  const classId = String(req.classId || '');
  const day = Number(req.trainingDay);
  const ids = Array.isArray(req.generationIds) ? req.generationIds.map(String) : null;
  if (!classId || !(day >= 1)) reject_('Export needs classId and trainingDay.');
  const res = readTable_(SHEETS.RESULTS);
  const rows = res.rows.filter(function (r) {
    return String(r['Class ID']) === classId && Number(r['Training day']) === day && (!ids || ids.indexOf(String(r['Generation ID'])) >= 0);
  });
  const name = 'Quiz results · ' + (req.className || classId) + ' · Day ' + day + ' · ' + centralStamp_().slice(0, 10);
  const out = SpreadsheetApp.create(name);
  const header = res.headers;
  const data = [header].concat(rows.map(function (r) { return header.map(function (h) { return r[h]; }); }));
  out.getSheets()[0].getRange(1, 1, data.length, header.length).setValues(data);
  const file = DriveApp.getFileById(out.getId());
  const folderId = CONFIG.EXPORT_FOLDER_ID || CONFIG.REQUESTS_FOLDER_ID;
  try { file.moveTo(DriveApp.getFolderById(folderId)); } catch (e) { logError_('export:move', e, { folderId: folderId }); }
  return 'Exported ' + rows.length + ' result' + (rows.length === 1 ? '' : 's') + ': ' + out.getUrl();
}

// ---------------------------------------------------------------- Slack interactivity (web app)
/** Health check only; returns no data. */
function doGet() {
  return ContentService.createTextOutput('Trainer Hub quiz backend is running.');
}

/**
 * Slack calls this when a trainee taps an answer button.
 * Apps Script web apps can't read request headers, so Slack's signing-secret check isn't possible here.
 * Instead: the payload's verification token must match, the button value carries an HMAC only this
 * script can make, and the tapping user must be the quiz's own Slack user.
 */
function doPost(e) {
  const ok = ContentService.createTextOutput('');
  let payload;
  try { payload = JSON.parse(e.parameter.payload); } catch (err) { logError_('doPost:parse', err, {}); return ok; }
  try {
    const expected = props_().getProperty('SLACK_VERIFICATION_TOKEN');
    if (!expected || payload.token !== expected) { logError_('doPost:token', 'verification token mismatch', {}); return ok; }
    if (payload.type !== 'block_actions' || !payload.actions || !payload.actions.length) return ok;
    const parts = String(payload.actions[0].value || '').split('|');
    if (parts.length !== 4) return ok;
    recordAnswer_(parts[0], Number(parts[1]), parts[2], parts[3], payload.user && payload.user.id);
  } catch (err) {
    logError_('doPost', err && err.code || err, { user: payload && payload.user && payload.user.id });
  }
  return ok; // Slack only needs a 200 within 3 seconds
}

/** Records one answer. Rejects forged, stale, duplicate and out-of-order taps; never reveals correctness. */
function recordAnswer_(quizId, index, displayLetter, sig, slackUserId) {
  if (sign_(quizId + '|' + index) !== sig) { logError_('answer:signature', 'bad signature', { quizId: quizId }); return; }
  // Answers are serialized with the user lock (the minute trigger uses the script lock, so it never blocks answers).
  const lock = LockService.getUserLock();
  if (!lock.tryLock(2500)) { logError_('answer:lock', 'busy', { quizId: quizId }); return; }
  try {
    const stateRow = findRow_(SHEETS.STATE, 'Quiz ID', quizId);
    if (!stateRow) return;
    const state = rowObject_(SHEETS.STATE, stateRow);
    if (String(state['Slack user ID']) !== String(slackUserId)) { logError_('answer:user', 'not the quiz owner', { quizId: quizId }); return; }
    if (state['Status'] === 'Submitted') return;
    const current = Number(state['Current index']);
    if (index !== current) return; // a repeat tap on an old question: the first answer stands

    const questions = JSON.parse(state['Questions']);
    const q = questions[index];
    const pos = LETTERS.indexOf(displayLetter);
    if (pos < 0 || pos >= q.order.length) return;
    const answers = JSON.parse(state['Answers'] || '[]');
    answers[index] = { shown: displayLetter, original: q.order[pos], at: nowIso_() };
    const next = index + 1;
    const finished = next >= questions.length;
    updateCells_(SHEETS.STATE, stateRow, { 'Answers': JSON.stringify(answers), 'Current index': next, 'Status': finished ? 'Submitted' : 'In progress', 'Updated at': nowIso_() });

    const linkRow = findRow_(SHEETS.LINKS, 'Quiz ID', quizId);
    const link = linkRow ? rowObject_(SHEETS.LINKS, linkRow) : {};
    const header = (link['Class name'] || 'Quiz') + ' · Day ' + (link['Training day'] || '?') + ' quiz · ' + questions.length + ' questions';
    if (finished) {
      writeResult_(quizId, link, questions, answers);
      if (linkRow) updateCells_(SHEETS.LINKS, linkRow, { 'Submission status': SUBMISSION.SUBMITTED, 'Submission timestamp': centralStamp_() });
    } else if (index === 0 && linkRow) {
      updateCells_(SHEETS.LINKS, linkRow, { 'Submission status': SUBMISSION.IN_PROGRESS });
    }
    if (!isDryRun_()) try {
      slack_('chat.update', {
        channel: state['Channel ID'], ts: String(state['Message TS']),
        text: finished ? 'Quiz submitted' : 'Question ' + (next + 1) + ' of ' + questions.length,
        blocks: finished ? doneBlocks_(header, questions.length) : questionBlocks_(quizId, header, questions, next),
      });
    } catch (err) { logError_('answer:update', err && err.code || err, { quizId: quizId, index: index }); }
  } finally {
    lock.releaseLock();
  }
}

/** Grades on the backend and writes one Results row (only once per quiz). */
function writeResult_(quizId, link, questions, answers) {
  try {
    if (findRow_(SHEETS.RESULTS, 'Quiz ID', quizId)) return; // already graded
    let score = 0;
    const detail = questions.map(function (q, i) {
      const a = answers[i] || {};
      const correct = a.original === q.correct;
      if (correct) score++;
      return { n: i + 1, questionId: q.id, topic: q.topic, question: q.question,
        answerGiven: a.original ? a.original + '. ' + q.choices[a.original] : '(no answer)',
        correctAnswer: q.correct + '. ' + q.choices[q.correct], correct: correct, answeredAt: a.at || '' };
    });
    appendRow_(SHEETS.RESULTS, {
      'Generation ID': link['Generation ID'], 'Class ID': link['Class ID'], 'Class name': link['Class name'],
      'Trainee ID': link['Trainee ID'], 'Trainee name': link['Trainee name'], 'Trainee email': link['Trainee email'],
      'Training day': link['Training day'], 'Submission timestamp': centralStamp_(), 'Score': score,
      'Total questions': questions.length, 'Score percentage': Math.round(score / questions.length * 1000) / 10,
      'Per-question detail': JSON.stringify(detail), 'Quiz ID': quizId,
    });
  } catch (e) { logError_('writeResult', e, { quizId: quizId }); }
}

// ---------------------------------------------------------------- dry-run helpers (run from the editor)
/** Shows (in the execution log) what trainee 1 of the newest generation would see. Never sends anything. */
function previewFirstQueuedQuiz() {
  const rows = readTable_(SHEETS.STATE).rows;
  if (!rows.length) { Logger.log('No quizzes yet.'); return; }
  const s = rows[rows.length - 1];
  const qs = JSON.parse(s['Questions']);
  Logger.log(JSON.stringify(questionBlocks_(String(s['Quiz ID']), 'Preview', qs, 0), null, 2));
}

/** Answers every question of a dry-run quiz at random, to test grading and Results without Slack. */
function simulateAnswersForQuiz(quizId) {
  const stateRow = findRow_(SHEETS.STATE, 'Quiz ID', quizId);
  if (!stateRow) throw new Error('No such quiz');
  const state = rowObject_(SHEETS.STATE, stateRow);
  const questions = JSON.parse(state['Questions']);
  if (!isDryRun_()) throw new Error('Only available while DRY_RUN is true');
  for (let i = Number(state['Current index']); i < questions.length; i++) {
    const pick = LETTERS[Math.floor(Math.random() * questions[i].order.length)];
    recordAnswer_(quizId, i, pick, sign_(quizId + '|' + i), state['Slack user ID']);
  }
}

// ---------------------------------------------------------------- Question Bank template (placeholder content)
// [Topic, Question, Choice A, Choice B, Choice C, Choice D, Correct answer, Category]
const SAMPLE_QUESTIONS = [
  ['Sample Topic 1: Company Basics', '[Placeholder] Which value does the sample company list first?', 'Customer first', 'Speed', 'Profit', 'Growth', 'A', 'Onboarding'],
  ['Sample Topic 1: Company Basics', '[Placeholder] Which team handles sample billing questions?', 'Sales', 'Care', 'Engineering', 'Marketing', 'B', 'Onboarding'],
  ['Sample Topic 1: Company Basics', '[Placeholder] What is the sample support email?', 'help@example.com', 'support@example.com', 'care@example.com', 'team@example.com', 'C', 'Onboarding'],
  ['Sample Topic 1: Company Basics', '[Placeholder] How many sample service tiers exist?', 'One', 'Two', 'Three', 'Four', 'C', 'Onboarding'],
  ['Sample Topic 1: Company Basics', '[Placeholder] True or false: the sample office is open on weekends.', 'True', 'False', '', '', 'B', 'Onboarding'],
  ['Sample Topic 2: Booking Flow', '[Placeholder] What is confirmed first when booking?', 'Address and date', 'Payment refund', 'Cleaner rating', 'Promo code', 'A', 'Core Skills'],
  ['Sample Topic 2: Booking Flow', '[Placeholder] Where is a booking change logged?', 'Personal notes', 'The CRM booking record', 'A chat message', 'Nowhere', 'B', 'Core Skills'],
  ['Sample Topic 2: Booking Flow', '[Placeholder] When is a confirmation sent?', 'After the visit', 'Never', 'Right after booking', 'One week later', 'C', 'Core Skills'],
  ['Sample Topic 2: Booking Flow', '[Placeholder] What do you offer if no slot is free?', 'Nothing', 'The nearest available slots', 'A refund only', 'A cancellation', 'B', 'Core Skills'],
  ['Sample Topic 2: Booking Flow', '[Placeholder] Which detail is optional in a sample booking?', 'Address', 'Date', 'Special instructions', 'Service type', 'C', 'Core Skills'],
  ['Sample Topic 3: Policies', '[Placeholder] A customer cancels 12 hours before. What applies?', 'Full refund', 'Late cancellation fee', 'Free reschedule', 'Account closure', 'B', 'Policies'],
  ['Sample Topic 3: Policies', '[Placeholder] Which document lists refund amounts?', 'The refund matrix', 'The org chart', 'The style guide', 'The holiday calendar', 'A', 'Policies'],
  ['Sample Topic 3: Policies', '[Placeholder] Who approves an exception to policy?', 'Any agent', 'The customer', 'A team lead', 'Nobody', 'C', 'Policies'],
  ['Sample Topic 3: Policies', '[Placeholder] How long are sample call recordings kept?', '7 days', '30 days', '90 days', '1 year', 'C', 'Policies'],
  ['Sample Topic 3: Policies', '[Placeholder] First step when a customer reports damage?', 'Issue a refund', 'Ask for details and photos', 'Close the ticket', 'Blame the cleaner', 'B', 'Policies'],
];
