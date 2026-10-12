# Quiz Generator

A trainer picks topics (or the Weekly Quiz) and a class, then clicks **Generate quiz**. Each trainee in that class gets their own quiz in a private Slack DM: a random subset of questions, in random order, with the answer choices shuffled. Trainees tap a letter for each answer; they never see a score or the correct answers. Trainers see scores and every answer in the Quiz tab.

## How it fits together

```
Dashboard (Quiz tab, trainers only)
  │  reads the Control Sheet as XLSX (Google Drive connector → SheetJS)
  │  writes NEW request files only:  Requests folder / quiz-request-<classId>-<timestamp>.json
  ▼
Google Apps Script (bound to the Control Sheet)          Slack app "Trainer Hub Quiz" (bot)
  processRequests() every minute:                         ▲ users.lookupByEmail, conversations.open,
    validate → authorize → build quizzes → DM  ───────────┘ chat.postMessage, chat.update
  doPost() web app  ◄──────── Slack Interactivity: a trainee taps an answer button
    record answer → next question → grade at the end → "Results"
```

| Piece | Where | Holds |
| --- | --- | --- |
| Control Sheet | Google Sheets | Question Bank, Generated Links, Results, Request Log, Slack Directory, Quiz State (hidden) |
| Requests folder | Google Drive | One small JSON file per trainer action. Never edited after creation. |
| Apps Script | bound to the Control Sheet | All quiz building, Slack sending, grading. Slack token in Script Properties. |
| Slack app | your Slack workspace | The bot that DMs quizzes and receives answer taps |
| Dashboard | the claude.ai link | Settings (sheet and folder IDs) and a record of submitted requests, in the artifact database, readable only by editors |

The answer key, answers and scores live only in the Control Sheet. The dashboard reads them with the trainer's own Google Drive access and never stores them in the artifact database.

## Files

| File | What it is |
| --- | --- |
| `quiz/Code.gs` | The complete Apps Script backend (configuration constants at the top) |
| `quiz/appsscript.json` | Apps Script manifest: scopes, time zone, web app settings |
| `quiz/slack-app-manifest.yml` | Slack app manifest: bot scopes and the interactivity URL |
| `quiz/question-bank-template.csv` | Question Bank template: 3 placeholder topics, 15 questions |
| `quiz/test/backend.test.js` | Backend tests (run with `node quiz/test/backend.test.js`) |
| `js/tools/quiz.js` | The dashboard's Quiz tab |

## Setup

You need: edit access to a Google Drive, permission to create a Slack app in your workspace (or a Slack admin to approve it), and editor access to the dashboard.

### 1. Control Sheet and Requests folder
1. Create a Google Sheet named e.g. **Trainer Hub Quiz Control**.
2. Create a Drive folder named e.g. **Trainer Hub Quiz Requests**. Share it (Editor) with every trainer who will generate quizzes. The folder must be in **My Drive**, not a shared drive, because the script checks who owns each request file.
3. Optional: create an **exports** folder for "Export to Google Sheets".

### 2. Apps Script
1. In the Control Sheet: **Extensions → Apps Script**.
2. Replace `Code.gs` with `quiz/Code.gs`. In **Project Settings**, tick "Show appsscript.json" and replace it with `quiz/appsscript.json`.
3. At the top of `Code.gs`, set `REQUESTS_FOLDER_ID` (and `EXPORT_FOLDER_ID` if you made one). Leave `CONTROL_SHEET_ID` blank.
4. **Project Settings → Script properties**:

   | Property | Value |
   | --- | --- |
   | `TRAINER_EMAILS` | Comma-separated Google accounts allowed to submit requests, e.g. `you@company.com,lead@company.com` |
   | `DRY_RUN` | `true` for now (nothing is sent to Slack) |
   | `SLACK_BOT_TOKEN` | Added in step 3 |
   | `SLACK_VERIFICATION_TOKEN` | Added in step 3 |

5. Run `setupControlSheet` once (approve the permissions). It creates every tab, seeds the Question Bank template and creates the signing secret.
6. Run `installTrigger` once. `processRequests` now runs every minute.
7. **Deploy → New deployment → Web app**: Execute as **Me**, Who has access **Anyone**. Copy the `/exec` URL.

### 3. Slack app
1. Go to https://api.slack.com/apps → **Create New App → From an app manifest**, choose your workspace, paste `quiz/slack-app-manifest.yml`, and replace `REQUEST_URL` with the `/exec` URL.
2. **Install to Workspace** (a Slack admin may need to approve it).
3. Copy **OAuth & Permissions → Bot User OAuth Token** (`xoxb-…`) into the `SLACK_BOT_TOKEN` script property.
4. Copy **Basic Information → App Credentials → Verification Token** into `SLACK_VERIFICATION_TOKEN`.

Bot scopes and why: `users:read` and `users:read.email` match trainee emails to Slack accounts; `im:write` opens the DM; `chat:write` sends and advances the quiz.

### 4. Dashboard
1. Open the dashboard link as an editor and go to **Quiz**.
2. Paste the Control Sheet link and the Requests folder link and **Save**.
3. Allow Google Drive when claude.ai asks.

### 5. Try it in dry-run mode
1. Pick a class and click **Check Slack accounts**. With no Slack token yet, the backend marks every valid email "Dry run".
2. Pick topics and click **Generate quiz**. Within a minute the Results table shows each trainee as "Dry run (not sent)".
3. In Apps Script, run `previewFirstQueuedQuiz` to see the Slack message a trainee would get, and `simulateAnswersForQuiz("<Quiz ID>")` to grade a quiz without Slack. The score then appears in the dashboard.
4. When happy, add the Slack tokens, set `DRY_RUN` to `false`, click **Check Slack accounts** again (real lookups), and generate.

## Question Bank format

| Column | Required | Notes |
| --- | --- | --- |
| Topic | yes | Shown in the topic list |
| Question | yes | |
| Choice A–D | at least 2 | Leave unused choices empty (e.g. true/false uses A and B) |
| Correct answer | yes | One letter, `A`–`D`, pointing at a filled-in choice. Not the answer text. |
| Question ID | recommended | Stable ID such as `Q001`; used in results |
| Category | optional | Groups topics in the dashboard (default "General") |
| Active | optional | `TRUE`/blank = used, `FALSE` = skipped |
| Explanation, Difficulty | optional | Stored only; never shown to trainees |

Questions that break these rules are skipped, and the dashboard says how many. The **Weekly Quiz** draws exactly 50 questions from every active question in the bank and is disabled until the bank has at least 50.

## Request files

`quiz-request-<classId>-<timestamp>.json`, created by the dashboard in the Requests folder. Every file has a unique `requestId`; the backend ignores a second file with the same ID.

```json
{ "requestId": "…", "type": "generate", "classId": "…", "className": "…", "mode": "regular",
  "topics": ["Booking Flow"], "quizLength": 15, "trainingDay": 6,
  "trainees": [{ "id": "…", "name": "…", "email": "…" }], "requestedAt": "…" }
```

Other `type`s use the same file pattern: `resolve-roster` (look up Slack accounts), `resend` (retry failed deliveries and remind trainees who haven't finished, no quiz content in the reminder), `trainer-summary` (DM the requesting trainer a results summary), `export` (copy a day's results to a new Google Sheet).

## Known limitations

- **Slack signature check isn't possible in Apps Script.** Web apps can't read request headers, so Slack's signing-secret check can't run. Instead the backend requires the payload's verification token, an HMAC in every button only this script can create, and that the person tapping is the quiz's own Slack user. For stronger verification, move `doPost` to a host that can read headers (e.g. a Cloud Run function).
- **Slack expects a reply within 3 seconds.** Apps Script usually answers in time. If it's slow, Slack shows a warning icon on the tap, but the answer is still recorded and the next question still appears.
- **One question per message.** The quiz message is replaced by the next question after each tap, so any length works (including 50) and an answer can't be changed once tapped.
- **The dashboard can't send Slack messages itself.** "Send via Slack DM" and "Check Slack accounts" create request files; the backend does the Slack work within about a minute.
- **The Google Drive download result shape** was not observed in a real call while building. The page searches the result for the file data and shows "the download didn't contain a spreadsheet" if it can't find it. Tell Claude if you see that.
- **"My Classes"** shows classes you created in the dashboard. Classes created before this feature have no creator recorded.
- **Holidays** are not skipped when working out the training day.

## Validation checklist

| Check | How it's covered |
| --- | --- |
| Random subset, order and choice order per trainee | Backend test: 8 trainees get different question sets/orders; each question's choice order is a permutation of its choices |
| No repeated question in a quiz | Backend test (regular and Weekly 50) |
| Weekly Quiz is exactly 50, disabled under 50 | Backend test rejects a 50-question request with 15 questions; UI test shows it disabled with the reason, and enabled with 59 |
| Weekly locks topics; picking a topic leaves Weekly | UI test |
| Quiz length 10–20 enforced | UI test (25 blocked with a reason) and backend test (25 rejected) |
| Not enough questions explained | UI test ("Only 14 eligible questions…") and backend test |
| Score privacy in Slack | Backend test: no trainee-facing message contains "score", "%", "correct answer", "wrong" |
| Answers final, no duplicates | Backend test: a second tap on the same question is ignored; taps after submission don't add results |
| Forged / foreign taps rejected | Backend test: wrong verification token, forged signature, another user's tap all ignored |
| Grading correct | Backend test: 5 of 10 right → score 5, 50%, per-question detail matches |
| Duplicate request files | Backend test: same request ID twice → processed once |
| Retry after partial failure | Backend test: rate limit mid-generation resumes without duplicate rows; rate limit mid-delivery resumes without resending |
| Crash after sending | Backend test: a quiz already posted is marked delivered, never resent |
| Missing Slack account / invalid email | Backend test: shown as "Failed" with the reason; UI test shows it in red |
| Unauthorized requests | Backend test: requester not in `TRAINER_EMAILS` → Rejected, nothing created |
| Tab hidden from non-editors | UI test: viewer without edit access has no Quiz tab, and `#quiz` opens Cohorts |
| Quiz records hidden from non-editors | Database rules checked on the live dashboard: a record is invisible at Contributor level, visible at Editor level |
| History preserved | Backend test: two generations for the same day both kept; UI test lists both with date/time and ID |
| Double-click | UI test: double-clicking Generate creates one request file |
| Other tabs unaffected | Cohorts, Attendance, Courseware and data-copy tests still pass |

## Test evidence

| Part | Tested with | Result |
| --- | --- | --- |
| Apps Script logic (`Code.gs`) | Node harness with in-memory Sheets, Drive, Slack, locks (`quiz/test/backend.test.js`) | 17/17 pass. Mutation check: breaking the resume skip, answer-order check, grading, or no-resend check each makes a test fail |
| Dashboard Quiz tab | Browser (Playwright) with mocked database, viewer permissions and a Drive connector serving a real XLSX built with SheetJS | All flows above pass, no console errors |
| Artifact database rules | **Real**: the live dashboard's database, at Contributor and Editor levels | As intended |
| Google Drive connector | **Not called for real.** Argument names checked against the connector's schema | Download result shape unverified |
| Slack Web API and interactivity | **Not called for real** (mocked). Only documented methods are used | Needs the Slack app; first real run in dry-run mode, then live |
| Apps Script runtime (triggers, web app, Drive ownership) | **Not run for real** | Run `setupControlSheet`, dry-run steps above |

No real Slack messages were sent and no real Drive files were created while building this.
