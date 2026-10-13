# Quiz Generator

Topics come from the **Homeaglow Care Knowledge Library** (a Google Doc): one topic per article. For a topic, Claude writes multiple-choice questions **only from that article**, each with the sentence that proves its answer. The trainer approves the good ones once; they go into the question bank and are reused.

A trainer picks topics (or the Weekly Quiz) and a class, then clicks **Generate quiz**. Each trainee gets their own quiz as a private Slack DM **from the trainer's own Slack account**: a random subset of questions, in random order, with the answer choices shuffled. The trainee answers with one reply (`1A 2C 3B …`). **Refresh** reads the replies and grades them in the dashboard. Trainees never see a score or the correct answers. Trainers see scores and every answer in the Quiz tab.

No Slack app, no Apps Script, no spreadsheet and no Requests folder are needed.

## How it fits together

```
Dashboard (Quiz tab, trainers only), running as the trainer
  │
  ├─ Google Drive connector ── read the Knowledge Library Google Doc → split into topics (one per article)
  │                         └─ Export: create a new Google Sheet with the day's results
  │
  ├─ Claude (your account) ── write questions from one article → you approve → question bank
  │
  ├─ Slack connector ───────── Check Slack accounts: search each work email, exact match only
  │                         ├─ Generate: one DM per trainee (long quizzes continue as replies under it)
  │                         └─ Refresh: read each DM (and the quiz's thread), take the first reply with answers
  │
  └─ Dashboard database (editors only) ── question bank, quizzes, answer keys, answers, scores, history
```

| Where | What | Who can read it |
| --- | --- | --- |
| Knowledge Library (Google Doc) | The articles questions are written from | Whoever you share it with |
| `quiz/config` | Knowledge Library ID, export folder ID | Editors of the dashboard |
| `quizBank/<topic>` | Claude's questions for one topic: question, choices, correct answer, explanation, supporting quote, pending/approved | Editors |
| `quiz/directory` | Work email → Slack user ID, from “Check Slack accounts” | Editors |
| `quizGenerations/<id>` | One per Generate click: class, day, topics, length, time. Never overwritten. | Editors |
| `quizzes/<generationId>_<traineeId>` | That trainee's questions and answer key, delivery, first reply, score and per-question detail | Editors |

Trainees and anyone without edit access can't open these records; the database rules are set when the dashboard is published.

## Files

| File | What it is |
| --- | --- |
| `js/quiz-engine.js` | Quiz logic with no network calls: splitting the Knowledge Library into topics, the question-writing instruction and checks, randomizing, the trainee message, reading replies, grading, reading Slack results |
| `js/tools/quiz.js` | The Quiz tab: screens and the Drive/Slack calls |
| `quiz/test/engine.test.js` | Tests for `quiz-engine.js` (run with `node quiz/test/engine.test.js`) |

## Setup

1. Open the dashboard link as an editor and go to **Quiz**. Paste the Knowledge Library link and **Save**. You can also paste an export folder link; leave it blank to save exports in My Drive.
2. When claude.ai asks, allow **Google Drive**, **Slack** and **Claude** for the dashboard. Writing questions uses your own Claude usage.

## Using it

1. **Build the question bank.** Click **Build** next to a topic (or tick topics and click **Have Claude write questions**). Claude reads that article only and writes 15 questions. Each shows the correct answer, a one-line explanation and the sentence from the article that proves it. If Claude's quoted sentence isn't found in the article, the question is marked “check this one”.
2. **Review.** Approve the right ones (or **Approve all**), remove the rest. Only approved questions are used. **Write 15 more** adds new questions without repeating existing ones. The number next to each topic is its approved questions.
3. **Pick topics** (or the Weekly Quiz, once 50 questions are approved) and **a class**.
4. **Check Slack accounts.** Looks up each trainee's work email in Slack. Only an exact email match counts. Nothing is sent.
5. Check the **training day** (today, or pick one) and the **number of questions** (10–20, default 15; Weekly is always 50).
6. **Preview message** shows a sample of what a trainee receives. Nothing is sent.
7. **Send me a test quiz** sends a real sample quiz to your own Slack DMs only. Nothing is saved.
8. **Generate quiz** asks you to confirm, then sends the DMs one by one. Keep the page open until it finishes (the button shows “Sending 3 of 13…”).
9. Later, open the class and press **↻ Refresh** to read replies and grade them. Each trainee's first reply that contains answers is final; later replies are ignored.
10. **✉ Send via Slack DM**: resend to trainees whose delivery failed, remind trainees who haven't answered (the reminder never contains questions, answers or scores), or send yourself a results summary.
11. **⇪ Export** creates a new Google Sheet with every quiz for the day shown.

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

## How the Knowledge Library becomes topics

- Each heading-1 article is a topic. A short tab label right before an article merges into it and the article's full title is used.
- Categories come from the doc's own Table of Contents. An article the contents don't list stays with the article before it.
- Sections with almost no text, and the Table of Contents itself, are skipped.
- The Weekly Quiz draws exactly 50 questions from every approved question and is disabled until 50 are approved.
- If an article changes after its questions were written, its review panel says so.

## Known limitations

- **Messages come from your account.** Trainees see the quiz in their DM with you, and their replies land there too. Anyone who can read your Slack DMs could see them.
- **Sending happens in your browser.** If you close the page mid-send, the rest aren't sent. Every quiz is saved before sending starts, so the Results table shows who is still “Sending”; use ✉ → Resend for the ones that failed.
- **An unclear send is not retried automatically.** If Slack times out, the row says “Unconfirmed: check your DM with this trainee before resending”. A reply from that trainee still gets graded on Refresh.
- **Results update when you press Refresh**, not live.
- **A trainee could change a reply in Slack** before you refresh. The dashboard grades the text it reads at the first Refresh after the reply and never re-grades it.
- **Questions are only as right as the article.** Claude is told to use only the article, and each question carries its supporting quote, but always review before approving.
- **The Knowledge Library is read when the Quiz tab opens** (⟳ reloads it). Topics are found by headings, so renaming an article starts a new, empty topic; its old questions stay in the bank and still count toward the Weekly Quiz.
- **Notion** isn't connected yet; questions come from the Google Doc only.
- **Slack's send result** wasn't observed in a real call while building. The dashboard reads the message time and channel from the message link it returns; if it can't, it reads replies by time instead. Use **Send me a test quiz** to check it once.
- **“My Classes”** shows classes you created in the dashboard. Older classes have no creator recorded.
- **Holidays** are not skipped when working out the training day.

## Validation checklist

| Check | How it's covered |
| --- | --- |
| Random subset, order and choice order per trainee | Engine test: 8 trainees get different question sets/orders; each choice order is a permutation of its choices |
| No repeated question in a quiz | Engine test (15 and Weekly 50) |
| Topics from the Knowledge Library | Engine test on a small library in the connector's format; UI test on the real Knowledge Library text: 97 topics in 14 categories |
| Claude only sees one article | UI test: the request holds the chosen article and no other |
| Bad or unproven questions | Engine test: wrong choice count, missing/invalid answer, duplicate choices, repeats dropped; a quote not in the article is flagged |
| Only approved questions used | Engine test; UI test: counts and the “Only N approved questions” blocker update as you approve |
| Claude not allowed | UI test: clear message, nothing saved |
| Weekly Quiz exactly 50, disabled under 50 | Engine test (50 from 59); UI test: disabled under 50 approved, enabled at 59 |
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
| Quiz logic (`quiz-engine.js`) | `node quiz/test/engine.test.js` | 15/15 pass. Breaking the quote check or the tab-label merge makes a test fail |
| Quiz tab | Browser (Playwright) with a mocked database and viewer permissions, a Drive connector serving the real Knowledge Library text, and mocked Claude and Slack | All flows above pass, no console errors, no sideways scroll on a phone |
| Google Drive read | **Real**: the Knowledge Library was read once through the connector | Result shape `{fileContent, title, viewUrl}` confirmed |
| Claude question writing | **Mocked.** The real quality is only seen when you build your first topic | Review every question before approving |
| Slack result formats | **Real, read-only** calls: user search, DM history, own profile | Parsers tested against those exact formats |
| Slack sending | **Not done for real.** No real Slack messages were sent while building this | Use “Send me a test quiz” first |
| Google Drive export | **Not called for real.** Argument names checked against the connector's schema | Create result shape unverified |
| Database rules | Editor-only rules checked on the live dashboard for the earlier quiz records | Same rule level used for the new records |
