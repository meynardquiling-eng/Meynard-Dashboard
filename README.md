# Trainer Hub

A dashboard for trainers. A rail on the left switches between five tools; the buttons at the top switch the cohort.

| Tool | What it does |
| --- | --- |
| Cohorts | Every cohort with its stage, current module, quiz average and status. Click a row to make it current. |
| Attendance Checker | Past attendance per trainee, plus today's roll call (P / L / A). Today's marks are saved in the browser. |
| Quiz Generator | Builds a quiz from a module's question bank, shows the answers, and copies it to the clipboard. |
| Courseware | Modules in order with their materials and progress. |
| Zoom Tracker | The live session, who isn't in the call, and past sessions. |

All data is sample data in `js/data.js`.

## Run it

Open `index.html` in a browser. There is no build step and nothing to install.

To serve it locally instead: `python3 -m http.server` and open http://localhost:8000.

## Project layout

```
index.html            page shell and script order
css/tokens.css        colors, fonts, radii (light + dark). Change the look here.
css/app.css           layout and shared components (cards, stats, tables, pills, buttons)
js/core.js            tool registry + shared helpers (esc, pill, icon, toast, store)
js/data.js            sample data: modules, question bank, cohorts, trainees, Zoom sessions
js/tools/*.js         one file per tool
js/app.js             rail, cohort switcher, routing (#toolId) and action dispatch
```

## Common edits

**Add a tool.** Create `js/tools/mytool.js`:

```js
TrainerHub.registerTool({
  id: "mytool",                 // also the URL: index.html#mytool
  name: "My Tool",              // page title
  short: "Mine",                // label under the rail icon
  icon: '<circle cx="12" cy="12" r="9"/>',  // 24x24 stroke SVG
  render(cohort, ctx) {
    return `<div class="card"><h2>Hello ${cohort.name}</h2></div>`;
  },
  actions: {
    // <button data-action="mytool:hello">  calls this
    hello(el, ctx) { TrainerHub.toast("Hi!"); },
  },
});
```

Then add `<script src="js/tools/mytool.js"></script>` to `index.html` before `js/app.js`. The rail picks it up automatically. The rail order follows the script order.

**Change colors.** Edit `css/tokens.css`. The brand is blue (`--blue-*`) with orange (`--orange-500`) for highlights. Status colors (`--ok`, `--warn`, `--bad`) are kept separate from the brand.

**Use real data.** Replace the contents of `js/data.js`, keeping the same shape. To load from an API later, fetch the data and set `TrainerHub.data` before `js/app.js` runs.

**Generate quizzes with AI.** Replace `buildQuiz` in `js/tools/quiz.js` with a call to your API. It should return `[{ q, options: [...], answer: index }]`.
