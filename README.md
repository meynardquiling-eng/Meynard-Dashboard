# Trainer Hub

A dashboard for trainers. A rail on the left switches between tools.

| Tool | What it does |
| --- | --- |
| Cohorts | One tile per cohort that opens and closes. Add, edit and delete cohorts, each with a class type (Transformation or CP Gen). Assign a Team Lead and a Slack channel. Add trainees (name + work Gmail) one at a time or paste a list. Edit or remove trainees. |
| Attendance Checker | Daily Slack check-in. At 6:55 AM Central a Goodmorning message is posted in each running cohort's channel; at 7:05 repliers are ticked, at 9:00 late repliers are ticked and the rest flagged Possible NCNS. Each day is a tick box you can change, with penalty points and a comment. One tile per cohort with a 4-week grid and point totals. See [ATTENDANCE.md](ATTENDANCE.md). |
| Quiz Generator | Trainers only (hidden from viewers who can't edit). Pick topics or the Weekly Quiz and a class; each trainee gets a private, randomized quiz in Slack. Scores and answers visible to trainers only. Backend in Google Apps Script. See [QUIZ.md](QUIZ.md). |
| Courseware | Upload videos, PowerPoint, Word, PDF, Excel, images and other files, or add links to Google Slides, Google Docs, Drive, YouTube or Loom. Filter by type, open, rename, tag with a topic, delete. |
| Zoom Tracker | One tile per cohort; tracking comes later. |

## Where your data is saved

**Shared dashboard (the claude.ai link).** Cohorts, trainees, materials and attendance live in the dashboard's own database, and uploaded files in its asset storage. Everyone the link is shared with sees the same data, and the Slack attendance routines read and write it. Uploads there are limited to MP4/WebM video, PDF, images and text files up to 20 MB each; put PowerPoint, Word, Excel and larger videos in Google Drive and add them as links.

**Local copy (index.html opened from disk).** Everything is saved in that browser only (`localStorage`, plus `IndexedDB` for files) and Slack attendance can't reach it. Useful for trying changes.

All saving goes through `js/data.js`, which picks the right place automatically.

## Run it

Open `index.html` in a browser. There is no build step and nothing to install.

To serve it locally instead: `python3 -m http.server` and open http://localhost:8000.

## Project layout

```
index.html            page shell and script order
css/tokens.css        colors, fonts, radii (light + dark). Change the look here.
css/app.css           layout and shared components
js/core.js            tool registry, helpers, form and confirm dialogs, toast
js/schedule.js        attendance schedule: Central time, 20 training days, cutoffs
js/data.js            all reads and writes (cohorts, trainees, materials, files)
js/tools/*.js         one file per tool
quiz/                 Quiz Generator backend: Apps Script, Slack app manifest, Question Bank template, tests
js/app.js             rail, routing (#toolId) and action dispatch
```

## Common edits

**Add a tool.** Create `js/tools/mytool.js`:

```js
TrainerHub.registerTool({
  id: "mytool",                 // also the URL: index.html#mytool
  name: "My Tool",              // page title
  short: "Mine",                // label under the rail icon
  description: "What this tool is for.",
  icon: '<circle cx="12" cy="12" r="9"/>',  // 24x24 stroke SVG
  render(ctx) {
    return `<button class="btn" data-action="mytool:hello">Say hi</button>`;
  },
  actions: {
    hello(el, ctx) { TrainerHub.toast("Hi!"); },
  },
});
```

Then add `<script src="js/tools/mytool.js"></script>` to `index.html` before `js/app.js`. The rail order follows the script order.

**Ask for input.** Use `TrainerHub.openForm({ title, fields, onSubmit })` for a form and `TrainerHub.confirmAction({ title, message, onConfirm })` before deleting. After changing data, call `ctx.rerender()`.

**Support a new file type in Courseware.** Add a row to `KINDS` in `js/tools/courseware.js` and a color in `css/tokens.css` (`--type-*`).

**Change colors.** Edit `css/tokens.css`. The brand is blue (`--blue-*`) with orange (`--orange-500`) for highlights.
