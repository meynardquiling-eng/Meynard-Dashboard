/*
  Quiz Generator. Today it draws from the question bank in data.js.
  To generate with AI later, replace `buildQuiz` with a call to your API; the page stays the same.
*/
(function () {
// Takes up to `count` questions from the module's bank (never repeats a question).
function buildQuiz(bank, count) {
  return bank.slice(0, count);
}

TrainerHub.registerTool({
  id: "quiz",
  name: "Quiz Generator",
  short: "Quiz",
  icon: '<path d="M9 9a3 3 0 1 1 4 2.8c-.6.3-1 .9-1 1.6V14"/><circle cx="12" cy="17.5" r=".6" fill="currentColor"/><rect x="3" y="3" width="18" height="18" rx="3"/>',

  render(cohort, ctx) {
    const { esc } = TrainerHub;
    const { modules } = ctx.data;
    const q = ctx.state.quiz;
    const defaultModule = modules[Math.max(cohort.currentModule, 0)].id;
    const moduleId = q.moduleId || defaultModule;

    const moduleOptions = modules.map((m, i) =>
      `<option value="${m.id}" ${m.id === moduleId ? "selected" : ""}>M${i + 1} · ${esc(m.title)}</option>`).join("");
    const countOptions = [3, 5, 10].map((n) =>
      `<option value="${n}" ${n === q.count ? "selected" : ""}>${n} questions</option>`).join("");

    let result = `<div class="empty">Pick a module and press Generate. Questions appear here for review before you send them.</div>`;
    if (q.generated && q.generated.cohortId === cohort.id) {
      const items = q.generated.items.map((item, i) => `
        <div class="question">
          <span class="num muted">Q${i + 1}</span> ${esc(item.q)}
          <ol type="A">${item.options.map((o, j) => `<li class="${j === item.answer ? "answer" : ""}">${esc(o)}</li>`).join("")}</ol>
        </div>`).join("");
      result = `
        <div class="card">
          <h2>${esc(q.generated.title)} <span class="aside">${q.generated.items.length} questions · answers in green</span></h2>
          ${items}
          <div class="btn-row" style="margin-top:14px">
            <button class="btn" data-action="quiz:copy">Copy quiz</button>
            <button class="btn secondary" data-action="quiz:discard">Discard</button>
          </div>
        </div>`;
    }

    return `
      <div class="stack">
        <div class="card">
          <h2>New quiz for ${esc(cohort.name)}</h2>
          <div class="fields">
            <label class="field">Source module<select id="quiz-module" data-action-change="quiz:setModule">${moduleOptions}</select></label>
            <label class="field">Length<select id="quiz-count" data-action-change="quiz:setCount">${countOptions}</select></label>
          </div>
          <button class="btn" data-action="quiz:generate">Generate quiz</button>
        </div>
        ${result}
      </div>`;
  },

  actions: {
    setModule(el, ctx) { ctx.state.quiz.moduleId = el.value; },
    setCount(el, ctx) { ctx.state.quiz.count = Number(el.value); },
    generate(el, ctx) {
      const { modules, questions } = ctx.data;
      const moduleId = document.getElementById("quiz-module").value;
      const count = Number(document.getElementById("quiz-count").value);
      const index = modules.findIndex((m) => m.id === moduleId);
      ctx.state.quiz = {
        moduleId, count,
        generated: {
          cohortId: ctx.cohort.id,
          title: `M${index + 1} · ${modules[index].title} check`,
          items: buildQuiz(questions[moduleId] || [], count),
        },
      };
      ctx.save();
    },
    copy(el, ctx) {
      const g = ctx.state.quiz.generated;
      const text = g.title + "\n\n" + g.items.map((it, i) =>
        `${i + 1}. ${it.q}\n` + it.options.map((o, j) => `   ${"ABC"[j]}) ${o}`).join("\n")).join("\n\n");
      navigator.clipboard.writeText(text)
        .then(() => TrainerHub.toast("Quiz copied"))
        .catch(() => TrainerHub.toast("Couldn't copy. Select the text instead."));
    },
    discard(el, ctx) {
      ctx.state.quiz.generated = null;
      ctx.save();
    },
  },
});
})();
