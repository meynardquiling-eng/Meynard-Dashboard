# Quiz Generator

A trainer picks topics (or the Weekly Quiz) and a class, then clicks **Generate quiz**. Each trainee gets their own quiz as a private Slack DM **from the trainer's own Slack account**: a random subset of questions, in random order, with the answer choices shuffled. The trainee answers with one reply (`1A 2C 3B …`). **Refresh** reads the replies and grades them in the dashboard. Trainees never see a score or the correct answers. Trainers see scores and every answer in the Quiz tab.

No Slack app, no Apps Script and no Requests folder are needed.

## How it fits together

```
Dashboard (Quiz tab, trainers only), running as the trainer
  │
  ├─ Google Drive connector ── download the Control Sheet as XLSX → SheetJS → Question Bank
  │                         └─ Export: create a new Google Sheet with the day's results
  │
  ├─ Slack connector ───────── Check Slack accounts: search each work email, exact match only
  │                         ├─ Generate: one DM per trainee (long quizzes continue as replies under it)
  │                         └─ Refresh: read each DM (and the quiz's thread), take the first reply with answers
  │
  └─ Dashboard database (editors only) ── quizzes, answer keys, answers, scores, generation history
```

| Where | What | Who can read it |
| --- | --- | --- |
| Control Sheet (Google Sheets) | The **Question Bank** tab | Whoever you share it with |
| `quiz/config` | Control Sheet ID, export folder ID | Editors of the dashboard |
| `quiz/directory` | Work email → Slack user ID, from “Check Slack accounts” | Editors |
| `quizGenerations/<id>` | One per Generate click: class, day, topics, length, time. Never overwritten. | Editors |
| `quizzes/<generationId>_<traineeId>` | That trainee's questions and answer key, delivery, first reply, score and per-question detail | Editors |

Trainees and anyone without edit access can't open these records; the database rules are set when the dashboard is published.

## Files

| File | What it is |
| --- | --- |
| `js/quiz-engine.js` | Quiz logic with no network calls: Question Bank checks, randomizing, the trainee message, reading replies, grading, reading Slack results |
| `js/tools/quiz.js` | The Quiz tab: screens and the Drive/Slack calls |
| `quiz/question-bank-template.csv` | Question Bank template: 3 placeholder topics, 15 questions |
| `quiz/test/engine.test.js` | Tests for `quiz-engine.js` (run with `node quiz/test/engine.test.js`) |

## Setup

1. Create a Google Sheet (e.g. **Trainer Hub Quiz Control**) with a tab named **Question Bank**. Import `quiz/question-bank-template.csv` into it and replace the placeholders with your questions.
2. Open the dashboard link as an editor and go to **Quiz**. Paste the Control Sheet link and **Save**. You can also paste an export folder link; leave it blank to save exports in My Drive.
3. When claude.ai asks, allow **Google Drive** and **Slack** for the dashboard. Both need to be connected in claude.ai Settings → Connectors.

## Using it

1. **Pick topics** (or the Weekly Quiz) and **a class**.
2. **Check Slack accounts.** Looks up each trainee's work email in Slack. Only an exact email match counts. Nothing is sent.
3. Check the **training day** (today, or pick one) and the **number of questions** (10–20, default 15; Weekly is always 50).
4. **Preview message** shows a sample of what a trainee receives. Nothing is sent.
5. **Send me a test quiz** sends a real sample quiz to your own Slack DMs only, so you can try replying and see how it looks. Nothing is saved.
6. **Generate quiz** asks you to confirm, then sends the DMs one by one. Keep the page open until it finishes (the button shows “Sending 3 of 13…”).
7. Later, open the class and press **↻ Refresh** to read replies and grade them. Each trainee's first reply that contains answers is final; later replies are ignored.
8. **✉ Send via Slack DM**: resend to trainees whose delivery failed, remind trainees who haven't answered (the reminder never contains questions, answers or scores), or send yourself a results summary.
9. **⇪ Export** creates a new Google Sheet with every quiz for the day shown.

### What trainees receive

```
**NH Cohort 10/19/2026 · Day 6 quiz** (15 questions)
Reply to this message with all your answers in one reply, like: `1A 2C 3B 4D`
Your first reply is final. Your answers are private.

**1.** Which booking step comes first?
      A. …
      B. …
```

Accepted reply formats: `1A 2C 3B`, `1. a, 2) c, 3-b`, one per line, or just the letters in order (`A C B D`) when the reply contains nothing else. A chat message like “I have a question” is not counted as an answer.

## Question Bank format

| Column | Required | Notes |
| --- | --- | --- |
| Topic | yes | Shown in the topic list |
| Question | yes | |
| Choice A–D | at least 2 | Leave unused choices empty (e.g. true/false uses A and B) |
| Correct answer | yes | One letter, `A`–`D`, pointing at a filled-in choice. Not the answer text. |
| Question ID | recommended | Stable ID such as `Q001`; used in results |
| Category | no | Groups topics in the dashboard (default “General”) |
| Active | no | `TRUE`/blank = used, `FALSE` = skipped |
| Explanation, Difficulty | no | Kept in the sheet only; never sent to trainees |

Questions that break these rules are skipped, and the dashboard says how many. The **Weekly Quiz** draws exactly 50 questions from every active question and is disabled until the bank has at least 50.

## Known limitations

- **Messages come from your account.** Trainees see the quiz in their DM with you, and their replies land there too. Anyone who can read your Slack DMs could see them.
- **Sending happens in your browser.** If you close the page mid-send, the rest aren't sent. Every quiz is saved before sending starts, so the Results table shows who is still “Sending”; use ✉ → Resend for the ones that failed.
- **An unclear send is not retried automatically.** If Slack times out, the row says “Unconfirmed: check your DM with this trainee before resending”. A reply from that trainee still gets graded on Refresh.
- **Results update when you press Refresh**, not live.
- **A trainee could change a reply in Slack** before you refresh. The dashboard grades the text it reads at the first Refresh after the reply and never re-grades it.
- **Slack's send result** wasn't observed in a real call while building. The dashboard reads the message time and channel from the message link it returns; if it can't, it reads replies by time instead. Use **Send me a test quiz** to check it once.
- **The Google Drive download result shape** wasn't observed in a real call either. If the Question Bank won't load, the page says so.
- **“My Classes”** shows classes you created in the dashboard. Older classes have no creator recorded.
- **Holidays** are not skipped when working out the training day.

## Validation checklist

| Check | How it's covered |
| --- | --- |
| Random subset, order and choice order per trainee | Engine test: 8 trainees get different question sets/orders; each choice order is a permutation of its choices |
| No repeated question in a quiz | Engine test (15 and Weekly 50) |
| Weekly Quiz exactly 50, disabled under 50 | Engine test (50 from 59); UI test: disabled with the reason when the bank has 19 |
| Weekly locks topics; picking a topic leaves Weekly | UI test |
| Quiz length 10–20 | UI blocks values outside the range with a reason |
| Not enough questions explained | Engine test and UI test (“Only 14 eligible questions…; 15 needed”) |
| Trainee message has no answers or scores | Engine test and UI test: no sent trainee message contains “score”, “%”, “correct answer” or “wrong” |
| Only DMs, never a channel | UI test: every send goes to a user ID |
| Long quizzes split safely | Engine test: 50 long questions split between questions, every part under Slack's limit, each question exactly once |
| Reply parsing | Engine test: numbered, lowercase, punctuation, letters-only, duplicates, out-of-range, chat messages ignored |
| First reply is final | Engine test and UI test: a chat message, then answers, then different answers → the answers reply is graded; Refresh never re-reads a graded trainee |
| Grading correct through shuffled choices | Engine test; UI test: all-correct reply scores 100% |
| Email match is exact | Engine test: `johnpaule@gmail.com` does not match `johnpaule@homeaglowcare.com`; uses the real Slack result format |
| Missing Slack account / failed send | UI test: “Not found” and “cannot_dm_user” shown in red per trainee; the rest still sent |
| Slack not connected | UI test: clear message, nothing saved |
| Summary only to the trainer | UI test: summary DM goes to the trainer's own Slack ID |
| Tab hidden from non-editors | UI test: no Quiz tab and `#quiz` opens Cohorts |
| History preserved | UI test: two generations on the same day both kept and selectable |
| Double-click | UI test: double-clicking Generate and Send creates one generation |
| Other tabs unaffected | UI test visits Cohorts, Attendance, Courseware, Zoom with no errors |

## Test evidence

| Part | Tested with | Result |
| --- | --- | --- |
| Quiz logic (`quiz-engine.js`) | `node quiz/test/engine.test.js` | 12/12 pass |
| Quiz tab | Browser (Playwright) with a mocked database, viewer permissions, a Drive connector serving a real XLSX built with SheetJS, and a mocked Slack connector | All flows above pass, no console errors, no sideways scroll on a phone |
| Slack result formats | **Real, read-only** calls: user search, DM history, own profile | Parsers tested against those exact formats |
| Slack sending | **Not done for real.** No real Slack messages were sent while building this | Use “Send me a test quiz” first |
| Google Drive | **Not called for real.** Argument names checked against the connector's schema | Download/create result shapes unverified |
| Database rules | Editor-only rules checked on the live dashboard for the earlier quiz records | Same rule level used for the new records |
