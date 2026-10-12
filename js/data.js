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
  };
  const listeners = [];
  const notify = () => listeners.forEach((fn) => fn());
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const attendanceKey = (cohortId, date) => `${cohortId}_${date}`;
  const findCohort = (id) => state.cohorts.find((c) => c.id === id);

  let db = null;
  let assets = null;

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
    const ok = store.set("cohorts", state.cohorts) && store.set("materials", state.materials) && store.set("attendance", state.attendance);
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
    state.cohorts = store.get("cohorts", []);
    state.materials = store.get("materials", []);
    state.attendance = store.get("attendance", {});
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
    get ready() { return state.mode === "local" || state.mode === "shared"; },
    onChange(fn) { listeners.push(fn); },

    /* ----- Cohorts ----- */
    get cohorts() { return state.cohorts; },
    getCohort: findCohort,

    // classType is one of TrainerHub.CLASS_TYPES; teamLead is { name } or null; slack is "#channel" or a link.
    addCohort({ name, classType, startDate, notes, teamLead = null, slack = "" }) {
      const cohort = { id: uid(), name, classType, startDate, notes, teamLead, slack, trainees: [], createdAt: new Date().toISOString() };
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
      One document per cohort per training day, written by the Slack routine:
        { cohortId, date, channel, channelId, messageTs, postedAt, checkedAt,
          records: { <traineeId>: { status: "present"|"late"|"absent", repliedAt, source: "slack"|"manual" } },
          unmatched: [ { slackUserId, name, email, repliedAt, text } ] }
    */
    getAttendance(cohortId, date) {
      return state.attendance[attendanceKey(cohortId, date)];
    },
    // A trainer's correction. status null clears it.
    setMark(cohortId, date, traineeId, status) {
      const key = attendanceKey(cohortId, date);
      const doc = state.attendance[key] || (state.attendance[key] = { cohortId, date, records: {}, unmatched: [] });
      doc.records ||= {};
      if (status) doc.records[traineeId] = { ...(doc.records[traineeId] || {}), status, source: "manual" };
      else delete doc.records[traineeId];
      saveAttendance(doc);
    },
    // Match a Slack reply nobody could be matched to.
    assignUnmatched(cohortId, date, index, traineeId) {
      const doc = state.attendance[attendanceKey(cohortId, date)];
      const reply = doc.unmatched[index];
      const status = TrainerHub.schedule.statusForReply(reply.repliedAt) || "absent";
      doc.records ||= {};
      doc.records[traineeId] = { status, repliedAt: reply.repliedAt, source: "manual" };
      doc.unmatched.splice(index, 1);
      saveAttendance(doc);
    },

    /* ----- Courseware materials ----- */
    get materials() { return state.materials; },

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
