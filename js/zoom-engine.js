/*
  Zoom engine: pure functions (no network, no DOM) used by the Zoom tab and by zoom/test/engine.test.js.
    - reading a Zoom participant report (CSV export from the Zoom web portal)
    - matching participants to a cohort's trainees (email, then name, then names the trainer assigned)
    - one row per trainee per day: tried to enter (waiting room), admitted, left, time in Zoom, drops

  Times are kept exactly as the report shows them (the Zoom account's time zone); no time-zone conversion.
*/
(function (root) {
  /* ---------------- CSV ---------------- */

  /** RFC 4180 CSV -> array of rows (arrays of strings). Handles quotes, "" escapes, CRLF and a BOM. */
  function parseCsv(text) {
    const s = String(text || "").replace(/^﻿/, "");
    const rows = [];
    let row = [], cell = "", quoted = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (quoted) {
        if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && s[i + 1] === "\n") i++;
        row.push(cell); rows.push(row); row = []; cell = "";
      } else cell += ch;
    }
    if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
    return rows.filter((r) => r.some((c) => c.trim() !== ""));
  }

  /* ---------------- Times ---------------- */

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const pad = (n) => String(n).padStart(2, "0");

  /**
   * "10/19/2026 06:58:10 AM", "2026-10-19 06:58:10", "Oct 19, 2026 06:58:10 AM" -> "2026-10-19 06:58:10"
   * (wall-clock time as written in the report), or null.
   */
  function parseZoomTime(value) {
    const s = String(value || "").trim();
    let y, mo, d, rest;
    let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T,]+(.+)$/);
    if (m) { mo = +m[1]; d = +m[2]; y = +m[3]; rest = m[4]; }
    else if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T]+(.+)$/))) { y = +m[1]; mo = +m[2]; d = +m[3]; rest = m[4]; }
    else if ((m = s.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})[ ,]+(.+)$/)) && MONTHS[m[1].toLowerCase()]) { mo = MONTHS[m[1].toLowerCase()]; d = +m[2]; y = +m[3]; rest = m[4]; }
    else return null;
    const t = rest.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?/);
    if (!t) return null;
    let h = +t[1];
    const min = +t[2], sec = +(t[3] || 0), ap = (t[4] || "").toUpperCase();
    if (ap === "PM" && h < 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || min > 59 || sec > 59) return null;
    return `${y}-${pad(mo)}-${pad(d)} ${pad(h)}:${pad(min)}:${pad(sec)}`;
  }

  // Seconds since 1970 for a wall-clock string, only for subtracting two times from the same report.
  const secondsOf = (wall) => Date.UTC(+wall.slice(0, 4), +wall.slice(5, 7) - 1, +wall.slice(8, 10), +wall.slice(11, 13), +wall.slice(14, 16), +wall.slice(17, 19)) / 1000;
  const dateOf = (wall) => wall.slice(0, 10);

  /** "2026-10-19 13:05:00" -> "1:05 PM" */
  function clockLabel(wall) {
    if (!wall) return "";
    let h = +wall.slice(11, 13);
    const ap = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${h}:${wall.slice(14, 16)} ${ap}`;
  }

  /** 185 -> "3h 05m", 42 -> "42m" */
  function durationLabel(minutes) {
    const m = Math.round(minutes || 0);
    return m >= 60 ? `${Math.floor(m / 60)}h ${pad(m % 60)}m` : `${m}m`;
  }

  /* ---------------- The report ---------------- */

  const norm = (s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
  function findCol(header, patterns) {
    const h = header.map(norm);
    for (const p of patterns) { const i = h.findIndex((c) => p.test(c)); if (i >= 0) return i; }
    return -1;
  }

  /**
   * A Zoom participant report CSV -> { meeting: {topic, id}, hasWaitingColumn, sessions: [{name, email, join, leave, waiting}], skipped }
   * The participant table is found by its header (it has a join time and a leave time); a meeting summary
   * block above it is read for the topic and meeting ID. Throws { message } when it isn't a participant report.
   */
  function readZoomReport(text) {
    const rows = parseCsv(text);
    const hi = rows.findIndex((r) => findCol(r, [/^join time/]) >= 0 && findCol(r, [/^leave time/]) >= 0);
    if (hi < 0) throw { message: "This file doesn't look like a Zoom participant report: it has no Join Time and Leave Time columns." };
    const header = rows[hi];
    const col = {
      name: findCol(header, [/^name \(original name\)/, /^name/, /^participant/, /^user name/, /^display name/]),
      email: findCol(header, [/^user email/, /^email/, /^participant email/]),
      join: findCol(header, [/^join time/]),
      leave: findCol(header, [/^leave time/]),
      waiting: findCol(header, [/waiting room/]),
    };
    if (col.name < 0) throw { message: "The participant report has no Name column." };

    const meeting = { topic: "", id: "" };
    for (let i = 0; i + 1 < hi; i++) {
      const tIdx = findCol(rows[i], [/^topic/]);
      const idIdx = findCol(rows[i], [/^meeting id/]);
      if (tIdx >= 0 || idIdx >= 0) {
        if (tIdx >= 0) meeting.topic = (rows[i + 1][tIdx] || "").trim();
        if (idIdx >= 0) meeting.id = (rows[i + 1][idIdx] || "").trim();
        break;
      }
    }

    const sessions = [];
    let skipped = 0;
    for (const r of rows.slice(hi + 1)) {
      const join = parseZoomTime(r[col.join]);
      const leave = parseZoomTime(r[col.leave]);
      const name = (r[col.name] || "").trim();
      if (!join || !leave || !name || secondsOf(leave) < secondsOf(join)) { skipped++; continue; }
      sessions.push({
        name,
        email: col.email >= 0 ? (r[col.email] || "").trim().toLowerCase() : "",
        join, leave,
        waiting: col.waiting >= 0 && /^(yes|true|1)$/i.test((r[col.waiting] || "").trim()),
      });
    }
    if (!sessions.length) throw { message: "The participant report has no rows with a valid join and leave time." };
    return { meeting, hasWaitingColumn: col.waiting >= 0, sessions, skipped };
  }

  /** Sessions grouped by the date each one started: { "2026-10-19": [...] } */
  function sessionsByDate(sessions) {
    const out = {};
    for (const s of sessions) (out[dateOf(s.join)] ||= []).push(s);
    return out;
  }

  const sessionKey = (s) => [s.name.toLowerCase(), s.email, s.join, s.leave, s.waiting ? 1 : 0].join("|");
  /** Adds new sessions to a day's existing ones, dropping exact repeats (the same report uploaded twice). */
  function mergeSessions(existing, added) {
    const seen = new Set((existing || []).map(sessionKey));
    const out = (existing || []).slice();
    let addedCount = 0;
    for (const s of added) { const k = sessionKey(s); if (!seen.has(k)) { seen.add(k); out.push(s); addedCount++; } }
    return { sessions: out, added: addedCount };
  }

  /* ---------------- Matching ---------------- */

  const nameKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  /** "Johnny (John Melvin Paule)" -> ["Johnny (John Melvin Paule)", "Johnny", "John Melvin Paule"] */
  function nameVariants(zoomName) {
    const full = String(zoomName || "").trim();
    const m = full.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    return m ? [full, m[1], m[2]] : [full];
  }
  /** Key a trainer's assignment is saved under, so the same Zoom name is recognized next time. */
  const aliasKey = (session) => (session.email ? "email:" + session.email : "name:" + nameKey(session.name));

  /**
   * Which trainee a session belongs to: alias the trainer saved, then email, then name (or email username).
   * Returns a trainee id, "ignore" (trainer said this isn't a trainee), or null.
   */
  function matchSession(session, trainees, aliases = {}) {
    const a = aliases[aliasKey(session)] || aliases["name:" + nameKey(session.name)];
    if (a) return a;
    if (session.email) {
      const t = trainees.find((x) => String(x.email || "").trim().toLowerCase() === session.email);
      if (t) return t.id;
    }
    const keys = nameVariants(session.name).map(nameKey).filter(Boolean);
    const hits = trainees.filter((t) => {
      const own = [nameKey(t.name), nameKey(String(t.email || "").split("@")[0])];
      return keys.some((k) => own.includes(k));
    });
    return hits.length === 1 ? hits[0].id : null;
  }

  /* ---------------- One row per trainee per day ---------------- */

  // Total time covered by a set of intervals (overlaps counted once) and how many separate stretches.
  function coverage(intervals) {
    const sorted = intervals.map(([a, b]) => [a, b]).sort((x, y) => x[0] - y[0]);
    let total = 0, stretches = 0, curA = null, curB = null;
    for (const [a, b] of sorted) {
      if (curB == null || a > curB) {
        if (curB != null) total += curB - curA;
        curA = a; curB = b; stretches++;
      } else if (b > curB) curB = b;
    }
    if (curB != null) total += curB - curA;
    return { seconds: total, stretches };
  }

  /**
   * A day's sessions -> { rows: [per trainee], unmatched: [per unknown participant], ignored }
   * Per trainee: triedToEnter (first waiting-room join, or null), admitted (first join in the meeting),
   * left (last leave), minutes (time actually in the meeting, gaps not counted), drops (times they
   * left and came back), sessions (in-meeting stretches, for the detail view).
   */
  function summarizeDay(sessions, trainees, aliases = {}, { hasWaitingColumn = false } = {}) {
    const byTrainee = {}, unknown = {};
    let ignored = 0;
    for (const s of sessions || []) {
      const id = matchSession(s, trainees, aliases);
      if (id === "ignore") { ignored++; continue; }
      if (id && trainees.some((t) => t.id === id)) (byTrainee[id] ||= []).push(s);
      else (unknown[aliasKey(s)] ||= { key: aliasKey(s), name: s.name, email: s.email, sessions: [] }).sessions.push(s);
    }
    const rows = trainees.map((t) => {
      const list = byTrainee[t.id] || [];
      const inMeeting = list.filter((s) => !s.waiting).sort((a, b) => a.join.localeCompare(b.join));
      const waiting = list.filter((s) => s.waiting).sort((a, b) => a.join.localeCompare(b.join));
      if (!inMeeting.length && !waiting.length) return { trainee: t, status: "absent" };
      const cov = coverage(inMeeting.map((s) => [secondsOf(s.join), secondsOf(s.leave)]));
      return {
        trainee: t,
        status: inMeeting.length ? "present" : "waiting-only",
        triedToEnter: waiting.length ? waiting[0].join : null,
        joinedDirectly: !waiting.length && hasWaitingColumn,
        admitted: inMeeting.length ? inMeeting[0].join : null,
        left: inMeeting.length ? inMeeting.reduce((m, s) => (s.leave > m ? s.leave : m), inMeeting[0].leave) : null,
        minutes: Math.round(cov.seconds / 60),
        drops: Math.max(0, cov.stretches - 1),
        sessions: inMeeting.map((s) => ({ join: s.join, leave: s.leave })),
        waitingSessions: waiting.map((s) => ({ join: s.join, leave: s.leave })),
      };
    });
    const unmatched = Object.values(unknown).map((u) => {
      const inMeeting = u.sessions.filter((s) => !s.waiting);
      const cov = coverage(inMeeting.map((s) => [secondsOf(s.join), secondsOf(s.leave)]));
      const first = u.sessions.map((s) => s.join).sort()[0];
      return { key: u.key, name: u.name, email: u.email, firstSeen: first, minutes: Math.round(cov.seconds / 60) };
    }).sort((a, b) => a.name.localeCompare(b.name));
    return { rows, unmatched, ignored };
  }

  const api = { parseCsv, parseZoomTime, clockLabel, durationLabel, readZoomReport, sessionsByDate, mergeSessions, nameVariants, aliasKey, matchSession, coverage, summarizeDay };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root && root.TrainerHub) root.TrainerHub.zoomEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
