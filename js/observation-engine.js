/*
  Observations logic with no network calls: the instruction Claude gets for sorting a trainer's free-text note
  into per-trainee observations, the check on Claude's answer, and grouping saved observations by trainee.
  Used by js/tools/observations.js; tested by observations/test/engine.test.js.
*/
(function (root) {
  const MAX_TEXT = 2000;

  const clean = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();

  // What Claude needs to tell trainees apart: the name on the dashboard and the email's first part,
  // since cohort names are often usernames ("christianabigan") while the trainer writes "Chris".
  function rosterLines(trainees) {
    return trainees.map((t) => `- id: ${t.id} | name: ${t.name}${t.email ? ` | email: ${t.email}` : ""}`).join("\n");
  }

  function splitPrompt({ note, trainees }) {
    return `A trainer wrote observations about trainees in a training class. Sort the note into observations per trainee.

Trainees in this class:
${rosterLines(trainees)}

Rules:
- Match each person the note mentions to exactly one trainee above, using first names, nicknames, surnames, initials or the email. Names on the list may be usernames (e.g. "christianabigan" is Christian Abigan, "Chris").
- If a name could be more than one trainee, or matches nobody on the list, do not guess: put that sentence in "unassigned".
- Keep the trainer's own words. Only trim the part that belongs to each trainee so it reads on its own (e.g. "Chris and Aira were late" becomes "Was late" for each of them, or keep the sentence as written). Do not add judgments, facts or advice that are not in the note.
- An observation about several trainees goes to each of them.
- Sentences about nobody in particular (e.g. the whole class) go in "unassigned".

Answer with JSON only, in this shape:
{"items":[{"traineeId":"<id from the list>","text":"<observation>"}],"unassigned":["<sentence>"]}

The note:
"""
${note}
"""`;
  }

  /**
   * Checks Claude's answer against the roster. Anything pointing at an id that isn't in the class goes to
   * unassigned rather than being filed under a guess. Returns { items: [{ traineeId, text }], unassigned: [text] }.
   */
  function checkSplit(reply, trainees) {
    const ids = new Set(trainees.map((t) => t.id));
    const items = [];
    const unassigned = [];
    const seen = new Set();
    const list = reply && Array.isArray(reply.items) ? reply.items : [];
    for (const it of list) {
      const text = clean(it && it.text).slice(0, MAX_TEXT);
      if (!text) continue;
      const id = it && String(it.traineeId || "");
      if (!ids.has(id)) { unassigned.push(text); continue; }
      const k = id + "\n" + text.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      items.push({ traineeId: id, text });
    }
    for (const u of (reply && Array.isArray(reply.unassigned) ? reply.unassigned : [])) {
      const text = clean(u).slice(0, MAX_TEXT);
      if (text && !unassigned.includes(text)) unassigned.push(text);
    }
    return { items, unassigned };
  }

  /** Saved observations for one cohort, grouped by trainee in roster order, newest first within each. */
  function groupByTrainee(observations, trainees) {
    const groups = trainees.map((t) => ({ trainee: t, observations: [] }));
    const byId = Object.fromEntries(groups.map((g) => [g.trainee.id, g]));
    const orphaned = [];
    for (const o of observations) (byId[o.traineeId] ? byId[o.traineeId].observations : orphaned).push(o);
    const newest = (a, b) => String(b.observedAt).localeCompare(String(a.observedAt));
    groups.forEach((g) => g.observations.sort(newest));
    orphaned.sort(newest);
    return { groups, orphaned };
  }

  /* ---------------- Training weeks ----------------
     trainingDays is the cohort's 20 weekday dates (TrainerHub.schedule.trainingDays). Week 1 is days 1-5, and so on.
     Week 0 means before training started; WEEK_AFTER means after it ended. */
  const WEEK_AFTER = 99;

  function weekOf(date, trainingDays) {
    if (!trainingDays.length) return 1;
    if (date < trainingDays[0]) return 0;
    if (date > trainingDays[trainingDays.length - 1]) return WEEK_AFTER;
    const i = trainingDays.filter((d) => d <= date).length - 1; // last training day on or before the date
    return Math.floor(i / 5) + 1;
  }

  function weekCount(trainingDays) { return Math.max(1, Math.ceil(trainingDays.length / 5)); }

  /** First and last training day of a week, or null for before/after training. */
  function weekRange(week, trainingDays) {
    const days = trainingDays.slice((week - 1) * 5, week * 5);
    return week >= 1 && days.length ? { start: days[0], end: days[days.length - 1] } : null;
  }

  /** Observations grouped by training week, newest week first. dateOf(observation) gives its calendar date. */
  function groupByWeek(observations, trainingDays, dateOf) {
    const byWeek = new Map();
    for (const o of observations) {
      const w = weekOf(dateOf(o), trainingDays);
      if (!byWeek.has(w)) byWeek.set(w, []);
      byWeek.get(w).push(o);
    }
    return [...byWeek.entries()].sort((a, b) => b[0] - a[0]).map(([week, list]) => ({ week, observations: list }));
  }

  // The weekly progress tags, in the order they're offered.
  const STATUSES = [
    { id: "behind", label: "Behind" },
    { id: "good", label: "Doing good" },
    { id: "excellent", label: "Excellent" },
  ];

  const api = { splitPrompt, checkSplit, groupByTrainee, MAX_TEXT, weekOf, weekCount, weekRange, groupByWeek, WEEK_AFTER, STATUSES };
  if (root.TrainerHub) root.TrainerHub.observationEngine = api;
  if (typeof module !== "undefined") module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
