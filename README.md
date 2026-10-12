# Trainer Hub

A dashboard for trainers. A rail on the left switches between tools.

| Tool | What it does |
| --- | --- |
| Cohorts | One tile per cohort. Add, edit and delete cohorts. Assign a Team Lead (name + work email). Add trainees (name + work Gmail) one at a time or paste a list. Edit or remove trainees. |
| Attendance Checker | A tile for each cohort listing its trainees, pulled from the Cohorts tab. The tracker itself comes later. |
| Quiz Generator | Empty for now. |
| Courseware | Upload videos, PowerPoint, Word, PDF, Excel, images and other files, or add links to Google Slides, Google Docs, Drive, YouTube or Loom. Filter by type, open, rename, tag with a topic, delete. |
| Zoom Tracker | Empty for now. |

## Where your data is saved

Everything is saved **in the browser you use**:

- cohorts, trainees and material details in `localStorage`
- uploaded files in `IndexedDB` (handles large files like videos)

That means it stays after you close the tab, but it isn't shared with other people or other computers, and clearing the browser's site data deletes it. Moving to shared storage (a database, Google Drive) only requires changing `js/data.js`.

## Run it

Open `index.html` in a browser. There is no build step and nothing to install.

To serve it locally instead: `python3 -m http.server` and open http://localhost:8000.

## Project layout

```
index.html            page shell and script order
css/tokens.css        colors, fonts, radii (light + dark). Change the look here.
css/app.css           layout and shared components
js/core.js            tool registry, helpers, form and confirm dialogs, toast
js/data.js            all reads and writes (cohorts, trainees, materials, files)
js/tools/*.js         one file per tool
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
