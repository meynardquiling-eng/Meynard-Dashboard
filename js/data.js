/*
  Data layer. Every read and write of cohorts, trainees, materials and attendance goes through here.

  Two places data can live:
    shared  The dashboard opened from its claude.ai link. Data is in the artifact's database
            (collections: cohorts, materials, attendance) and uploaded files in its asset storage.
            The Slack attendance routine reads cohorts and writes attendance here.
    local   index.html opened straight from disk. Data stays in this browser
            (localStorage, plus IndexedDB for files). Slack attendance can't reach it.

  Screens call these functions and re-render when onChange fires; they never care which mode is active.
*/
(function () {
  const { store, uid, toast } = TrainerHub;

  const state = {
    mode: window.claude && typeof window.claude.use === "function" ? "connecting" : "local",
    cohorts: [],
    materials: [],
    attendance: {}, // "<cohortId>_<date>" -> attendance document
    zoomDays: {},    // zoom/<cohortId>_<date>  Zoom participant sessions uploaded for that cohort and day
    zoomAliases: {}, // zoomAliases/<cohortId>   { "<email:…|name:…>": traineeId | "ignore" } set by the trainer
    // Who is viewing. manageClasses = may run the Quiz Generator (editors and the owner of the shared dashboard).
    perms: { manageClasses: false, userId: null },
    // Quiz Generator, editors only (db rules make these unreadable to anyone else):
    quizConfig: null,      // quiz/config     { knowledgeDocId, exportFolderId } — not secrets
    quizBank: {},          // quizBank/<topicKey>  Claude-written questions for one Knowledge Library topic, with review status
    slackDirectory: {},    // quiz/directory  { "<email>": { userId, status: "found"|"not-found"|"error", error, checkedAt } }
    quizGenerations: [],   // quizGenerations/<genId>  one per Generate click: class, day, topics, length (never overwritten)
    quizzes: {},           // quizzes/<genId>_<traineeId>  questions + answer key, delivery, submission, result
  };
  const listeners = [];
  const notify = () => listeners.forEach((fn) => fn());
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const attendanceKey = (cohortId, date) => `${cohortId}_${date}`;
  const findCohort = (id) => state.cohorts.find((c) => c.id === id);

  let db = null;
  let assets = null;
  let mcp = null;
  let sample = null;
  let browserCopyHidden = false;

  /* ---------- Saving ---------- */

  // Writes to one document go out one at a time, in order.
  const queues = {};
  function write(path, op) {
    queues[path] = (queues[path] || Promise.resolve())
      .then(op)
      .catch((err) => {
        console.error(path, err);
        toast(err && err.code === "invalid_argument"
          ? "You don't have permission to change this dashboard."
          : "Couldn't save that change. Check your connection and try again.");
      });
    return queues[path];
  }

  let warned = false;
  function saveLocal() {
    const ok = store.set("cohorts", state.cohorts) && store.set("materials", state.materials) && store.set("attendance", state.attendance)
      && store.set("zoomDays", state.zoomDays) && store.set("zoomAliases", state.zoomAliases);
    if (!ok && !warned) {
      warned = true;
      toast("This browser isn't letting the app save. Changes will be lost when you close the page.");
    }
  }

  function saveCohort(cohort) {
    if (db) return write("cohorts/" + cohort.id, () => db.doc("cohorts/" + cohort.id).set(clone(cohort)));
    saveLocal();
  }
  function saveMaterial(m) {
    if (db) return write("materials/" + m.id, () => db.doc("materials/" + m.id).set(clone(m)));
    saveLocal();
  }
  function saveAttendance(doc) {
    const key = attendanceKey(doc.cohortId, doc.date);
    if (db) return write("attendance/" + key, () => db.doc("attendance/" + key).set(clone(doc)));
    saveLocal();
  }
  function removeDoc(path) {
    if (db) return write(path, () => db.doc(path).delete());
    saveLocal();
  }

  /* ---------- Starting up ---------- */

  function startLocal() {
    state.mode = "local";
    state.perms = { manageClasses: true, userId: null }; // the person with the file on their computer
    state.cohorts = store.get("cohorts", []);
    state.materials = store.get("materials", []);
    state.attendance = store.get("attendance", {});
    state.zoomDays = store.get("zoomDays", {});
    state.zoomAliases = store.get("zoomAliases", {});
    state.quizConfig = store.get("quizConfig", null);
    notify();
  }

  async function startShared() {
    try {
      db = await window.claude.use("db");
    } catch {
      db = null;
    }
    if (!db) {
      // The page is inside claude.ai but the database isn't available to this viewer.
      state.mode = "unavailable";
      notify();
      return;
    }
    try { assets = await window.claude.use("assets"); } catch { assets = null; }
    try { mcp = await window.claude.use("mcp"); } catch { mcp = null; }
    try {
      const user = await window.claude.use("user");
      state.perms = {
        manageClasses: user ? await user.canEdit() : false,
        userId: user ? await user.id() : null,
      };
    } catch { state.perms = { manageClasses: false, userId: null }; }
    state.mode = "shared";

    const onError = () => toast("Lost the live connection to the dashboard. Reload the page.");
    db.collection("cohorts").onSnapshot((snap) => {
      state.cohorts = snap.docs.map((d) => clone(d.data()))
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      notify();
    }, onError);
    db.collection("materials").onSnapshot((snap) => {
      state.materials = snap.docs.map((d) => clone(d.data()))
        .sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
      notify();
    }, onError);
    db.collection("attendance").onSnapshot((snap) => {
      state.attendance = Object.fromEntries(snap.docs.map((d) => [d.id, clone(d.data())]));
      notify();
    }, onError);
    db.collection("zoom").onSnapshot((snap) => {
      state.zoomDays = Object.fromEntries(snap.docs.map((d) => [d.id, clone(d.data())]));
      notify();
    }, onError);
    db.collection("zoomAliases").onSnapshot((snap) => {
      state.zoomAliases = Object.fromEntries(snap.docs.map((d) => [d.id, clone(d.data()).map || {}]));
      notify();
    }, onError);
    if (state.perms.manageClasses) {
      // Readable only by editors (see the db rules declared when the dashboard is published).
      db.doc("quiz/config").onSnapshot((snap) => {
        state.quizConfig = snap.exists ? clone(snap.data()) : null;
        notify();
      }, onError);
      db.collection("quizBank").onSnapshot((snap) => {
        state.quizBank = Object.fromEntries(snap.docs.map((d) => [d.id, clone(d.data())]));
        notify();
      }, onError);
      db.doc("quiz/directory").onSnapshot((snap) => {
        state.slackDirectory = snap.exists ? clone(snap.data()) : {};
        notify();
      }, onError);
      db.collection("quizGenerations").onSnapshot((snap) => {
        state.quizGenerations = snap.docs.map((d) => clone(d.data()))
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        notify();
      }, onError);
      db.collection("quizzes").onSnapshot((snap) => {
        state.quizzes = Object.fromEntries(snap.docs.map((d) => [d.id, clone(d.data())]));
        notify();
      }, onError);
    }
    notify();
  }

  if (state.mode === "local") startLocal();
  else startShared();

  /* ---------- File storage for local mode (IndexedDB) ---------- */
  let idbPromise;
  function idb() {
    idbPromise ||= new Promise((resolve, reject) => {
      const req = indexedDB.open("trainerhub", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("files");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return idbPromise;
  }
  async function fileOp(mode, fn) {
    const conn = await idb();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction("files", mode);
      const req = fn(tx.objectStore("files"));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  // File types the shared dashboard's storage accepts (20 MB each).
  const SHARED_FILE_TYPES = {
    mp4: "video/mp4", webm: "video/webm", pdf: "application/pdf",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    txt: "text/plain", csv: "text/csv", md: "text/markdown",
  };
  const SHARED_MAX_BYTES = 20 * 1024 * 1024;

  TrainerHub.data = {
    /** "local", "connecting", "shared" or "unavailable". */
    get mode() { return state.mode; },
    /** { manageClasses, userId } for the current viewer. */
    get perms() { return state.perms; },
    get ready() { return state.mode === "local" || state.mode === "shared"; },
    onChange(fn) { listeners.push(fn); },

    /* ----- Cohorts ----- */
    get cohorts() { return state.cohorts; },
    getCohort: findCohort,

    // classType is one of TrainerHub.CLASS_TYPES; teamLead is { name } or null; slack is "#channel" or a link.
    addCohort({ name, classType, startDate, notes, teamLead = null, slack = "" }) {
      const cohort = { id: uid(), name, classType, startDate, notes, teamLead, slack, trainees: [], createdAt: new Date().toISOString(), createdBy: state.perms.userId };
      state.cohorts.push(cohort);
      saveCohort(cohort);
      return cohort;
    },
    updateCohort(id, fields) {
      const cohort = findCohort(id);
      Object.assign(cohort, fields);
      saveCohort(cohort);
    },
    deleteCohort(id) {
      state.cohorts = state.cohorts.filter((c) => c.id !== id);
      for (const key of Object.keys(state.attendance).filter((k) => state.attendance[k].cohortId === id)) {
        delete state.attendance[key];
        if (db) removeDoc("attendance/" + key);
      }
      for (const key of Object.keys(state.zoomDays).filter((k) => state.zoomDays[k].cohortId === id)) {
        delete state.zoomDays[key];
        if (db) removeDoc("zoom/" + key);
      }
      if (state.zoomAliases[id]) { delete state.zoomAliases[id]; if (db) removeDoc("zoomAliases/" + id); }
      removeDoc("cohorts/" + id);
    },

    /* ----- Trainees ----- */
    addTrainee(cohortId, { name, email }) {
      const cohort = findCohort(cohortId);
      cohort.trainees.push({ id: uid(), name, email });
      saveCohort(cohort);
    },
    updateTrainee(cohortId, traineeId, fields) {
      const cohort = findCohort(cohortId);
      Object.assign(cohort.trainees.find((t) => t.id === traineeId), fields);
      saveCohort(cohort);
    },
    deleteTrainee(cohortId, traineeId) {
      const cohort = findCohort(cohortId);
      cohort.trainees = cohort.trainees.filter((t) => t.id !== traineeId);
      saveCohort(cohort);
    },

    /* ----- Attendance ----- */
    /*
      One document per cohort per training day, written by the Slack routines (see ATTENDANCE.md):
        { cohortId, date, channel, channelId, messageTs, postedAt, checkedAt, recheckedAt,
          records: { <traineeId>: { checkedIn, repliedAt, flag: "no-reply"|"possible-ncns",
                                    source: "slack"|"manual", points, comment } },
          unmatched: [ { slackUserId, name, email, repliedAt, text } ] }
      The routines set checkedIn/repliedAt/flag and never touch points or comment, nor a tick set by hand.
    */
    getAttendance(cohortId, date) {
      return state.attendance[attendanceKey(cohortId, date)];
    },
    // A trainer's change to one trainee's day. fields: any of { checkedIn, points, comment }.
    updateRecord(cohortId, date, traineeId, fields) {
      const key = attendanceKey(cohortId, date);
      const doc = state.attendance[key] || (state.attendance[key] = { cohortId, date, records: {}, unmatched: [] });
      doc.records ||= {};
      const r = { ...(doc.records[traineeId] || {}) };
      if ("checkedIn" in fields) {
        r.checkedIn = fields.checkedIn;
        r.source = "manual"; // the Slack checks won't change a tick set by hand
        delete r.flag;
        delete r.status;
      }
      if ("points" in fields) { if (fields.points == null) delete r.points; else r.points = fields.points; }
      if ("comment" in fields) { if (fields.comment) r.comment = fields.comment; else delete r.comment; }
      doc.records[traineeId] = r;
      saveAttendance(doc);
    },
    // Match a Slack reply nobody could be matched to: that trainee is ticked as checked in.
    assignUnmatched(cohortId, date, index, traineeId) {
      const doc = state.attendance[attendanceKey(cohortId, date)];
      const reply = doc.unmatched[index];
      doc.records ||= {};
      const r = { ...(doc.records[traineeId] || {}), checkedIn: true, repliedAt: reply.repliedAt, source: "manual" };
      delete r.flag;
      doc.records[traineeId] = r;
      doc.unmatched.splice(index, 1);
      saveAttendance(doc);
    },

    /* ----- Quiz Generator (shared dashboard, editors only) ----- */
    get quizConfig() { return state.quizConfig; },
    saveQuizConfig(cfg) {
      state.quizConfig = { ...cfg, updatedAt: new Date().toISOString() };
      if (db) return write("quiz/config", () => db.doc("quiz/config").set(clone(state.quizConfig)));
      store.set("quizConfig", state.quizConfig);
    },
    get quizBank() { return state.quizBank; },
    saveBankTopic(doc) {
      state.quizBank[doc.key] = doc;
      notify();
      if (db) return write("quizBank/" + doc.key, () => db.doc("quizBank/" + doc.key).set(clone(doc)));
    },
    /**
     * Asks Claude (on the viewer's own Claude account) and returns the reply parsed as JSON.
     * Rejects with { code, message } (codes from the claude.ai sample runtime, plus "no_claude").
     */
    async askClaudeJson(prompt, options) {
      if (!sample) { try { sample = window.claude ? await window.claude.use("sample") : null; } catch { sample = null; } }
      if (!sample) throw { code: "no_claude", message: "Asking Claude is only available in the shared dashboard." };
      return sample.json(prompt, options);
    },
    get slackDirectory() { return state.slackDirectory; },
    // entries: { "<email>": { userId, status, error, checkedAt } } merged into the directory.
    saveSlackDirectory(entries) {
      Object.assign(state.slackDirectory, entries);
      notify();
      if (db) return write("quiz/directory", () => db.doc("quiz/directory").set(clone(state.slackDirectory)));
    },
    get quizGenerations() { return state.quizGenerations; },
    saveQuizGeneration(gen) {
      const i = state.quizGenerations.findIndex((g) => g.id === gen.id);
      if (i >= 0) state.quizGenerations[i] = gen; else state.quizGenerations.unshift(gen);
      notify();
      if (db) return write("quizGenerations/" + gen.id, () => db.doc("quizGenerations/" + gen.id).set(clone(gen)));
    },
    quizzesFor(genId) {
      return Object.values(state.quizzes).filter((q) => q.generationId === genId);
    },
    getQuiz(genId, traineeId) { return state.quizzes[`${genId}_${traineeId}`]; },
    saveQuiz(quiz) {
      const key = `${quiz.generationId}_${quiz.traineeId}`;
      state.quizzes[key] = quiz;
      notify();
      if (db) return write("quizzes/" + key, () => db.doc("quizzes/" + key).set(clone(quiz)));
    },
    /**
     * Calls a connector tool as the viewer ("Google Drive" or "Slack"). Resolves the tool result; rejects with
     * { code, message } (codes from the claude.ai connector runtime, plus "no_connector").
     */
    async connector(server, tool, input) {
      if (!mcp) throw { code: "no_connector", message: `${server} access is only available in the shared dashboard.` };
      return mcp.callTool(server, tool, input, { cache: false });
    },
    drive(tool, input) { return this.connector("Google Drive", tool, input); },
    slack(tool, input) { return this.connector("Slack", tool, input); },

    /* ----- Zoom monitoring ----- */
    /*
      zoom/<cohortId>_<date>: { cohortId, date, hasWaitingColumn, sessions: [{ name, email, join, leave, waiting }],
                                uploads: [{ fileName, topic, meetingId, uploadedAt, rows }] }
      Times are wall-clock strings exactly as the Zoom report shows them.
    */
    getZoomDay(cohortId, date) { return state.zoomDays[`${cohortId}_${date}`]; },
    zoomDatesFor(cohortId) {
      return Object.values(state.zoomDays).filter((d) => d.cohortId === cohortId).map((d) => d.date).sort();
    },
    saveZoomDay(doc) {
      const key = `${doc.cohortId}_${doc.date}`;
      state.zoomDays[key] = doc;
      notify();
      if (db) return write("zoom/" + key, () => db.doc("zoom/" + key).set(clone(doc)));
      store.set("zoomDays", state.zoomDays);
    },
    deleteZoomDay(cohortId, date) {
      const key = `${cohortId}_${date}`;
      delete state.zoomDays[key];
      notify();
      if (db) return removeDoc("zoom/" + key);
      store.set("zoomDays", state.zoomDays);
    },
    zoomAliases(cohortId) { return state.zoomAliases[cohortId] || {}; },
    // Remembers which trainee a Zoom name or email belongs to ("ignore" for the trainer, guests, etc.).
    setZoomAlias(cohortId, key, traineeId) {
      const map = { ...(state.zoomAliases[cohortId] || {}) };
      if (traineeId) map[key] = traineeId; else delete map[key];
      state.zoomAliases[cohortId] = map;
      notify();
      if (db) return write("zoomAliases/" + cohortId, () => db.doc("zoomAliases/" + cohortId).set({ map: clone(map) }));
      store.set("zoomAliases", state.zoomAliases);
    },

    /* ----- Courseware materials ----- */
    get materials() { return state.materials; },

    /* ----- Copying data saved in this browser into the shared dashboard ----- */
    // Before the dashboard was shared, everything was saved in the browser. This finds what's
    // still there and not yet in the shared database (null when there's nothing to copy).
    get browserCopy() {
      if (state.mode !== "shared" || browserCopyHidden) return null;
      const cohorts = store.get("cohorts", []).filter((c) => !findCohort(c.id));
      const skipped = store.get("browserCopySkipped", []);
      const materials = store.get("materials", [])
        .filter((m) => !skipped.includes(m.id) && !state.materials.some((x) => x.id === m.id));
      return cohorts.length || materials.length ? { cohorts, materials } : null;
    },
    hideBrowserCopy() { browserCopyHidden = true; notify(); },
    // Copies cohorts, trainees and materials across. The browser's copy is left untouched.
    async copyBrowserData() {
      const copy = this.browserCopy;
      const skipped = [];
      if (!copy) return { cohorts: 0, materials: 0, skipped };
      for (const c of copy.cohorts) {
        const cohort = { trainees: [], teamLead: null, slack: "", ...c };
        state.cohorts.push(cohort);
        await saveCohort(cohort);
      }
      const localAttendance = store.get("attendance", {});
      for (const [key, doc] of Object.entries(localAttendance)) {
        if (!state.attendance[key] && copy.cohorts.some((c) => c.id === doc.cohortId)) {
          state.attendance[key] = doc;
          await saveAttendance(doc);
        }
      }
      let materials = 0;
      for (const m of copy.materials) {
        const meta = { ...m };
        if (m.source === "file") {
          const file = await this.getFile(m.id).catch(() => null);
          const problem = file ? this.uploadProblem(new File([file], m.fileName)) : "missing";
          if (problem) {
            skipped.push(m.fileName);
            store.set("browserCopySkipped", [...store.get("browserCopySkipped", []), m.id]);
            continue;
          }
          const ext = (m.fileName.split(".").pop() || "").toLowerCase();
          meta.assetId = (await assets.upload(file, { type: SHARED_FILE_TYPES[ext] })).id;
        }
        state.materials.unshift(meta);
        await saveMaterial(meta);
        materials++;
      }
      notify();
      return { cohorts: copy.cohorts.length, materials, skipped };
    },

    // Why a file can't be uploaded here, or nothing if it can.
    uploadProblem(file) {
      if (state.mode !== "shared") return;
      const ext = (file.name.split(".").pop() || "").toLowerCase();
      if (!SHARED_FILE_TYPES[ext]) return `${file.name}: this file type can't be stored in the shared dashboard. Put it in Google Drive and use Add link.`;
      if (file.size > SHARED_MAX_BYTES) return `${file.name} is over 20 MB. Put it in Google Drive and use Add link.`;
      if (!assets) return "Only editors of this dashboard can upload files.";
    },

    async addFile(file, kind) {
      const meta = {
        id: uid(), kind, source: "file",
        title: file.name.replace(/\.[^.]+$/, ""),
        fileName: file.name, size: file.size, mime: file.type,
        topic: "", addedAt: new Date().toISOString(),
      };
      if (state.mode === "shared") {
        const ext = (file.name.split(".").pop() || "").toLowerCase();
        const uploaded = await assets.upload(file, { type: SHARED_FILE_TYPES[ext] });
        meta.assetId = uploaded.id;
      } else {
        await fileOp("readwrite", (s) => s.put(file, meta.id));
      }
      state.materials.unshift(meta);
      saveMaterial(meta);
    },
    // A link to Google Slides, a Google Doc, a video, etc.
    addLink({ title, url, topic }, kind) {
      const m = { id: uid(), kind, source: "link", title, url, topic, addedAt: new Date().toISOString() };
      state.materials.unshift(m);
      saveMaterial(m);
    },
    updateMaterial(id, fields) {
      const m = state.materials.find((x) => x.id === id);
      Object.assign(m, fields);
      saveMaterial(m);
    },
    async deleteMaterial(id) {
      const m = state.materials.find((x) => x.id === id);
      if (m && m.source === "file") {
        if (m.assetId && assets) await assets.delete(m.assetId);
        else if (!m.assetId) await fileOp("readwrite", (s) => s.delete(id));
      }
      state.materials = state.materials.filter((x) => x.id !== id);
      removeDoc("materials/" + id);
    },
    // Shared files have a permanent address; local ones come out of IndexedDB.
    sharedFileUrl(m) {
      return m.assetId ? "/_blob/" + m.assetId : null;
    },
    getFile(id) {
      return fileOp("readonly", (s) => s.get(id));
    },
  };
})();
