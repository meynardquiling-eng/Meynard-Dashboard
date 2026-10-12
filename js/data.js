/*
  Data layer. Every read and write of cohorts, trainees and materials goes through here,
  so moving to a real backend later means changing only this file.

  Today:
    - cohorts, trainees and material details are saved in this browser (localStorage)
    - uploaded files are saved in this browser (IndexedDB), which handles large files like videos
*/
(function () {
  const { store, uid } = TrainerHub;

  const state = {
    cohorts: store.get("cohorts", []),
    materials: store.get("materials", []),
  };

  let warned = false;
  function save() {
    const ok = store.set("cohorts", state.cohorts) && store.set("materials", state.materials);
    if (!ok && !warned) {
      warned = true;
      TrainerHub.toast("This browser isn't letting the app save. Changes will be lost when you close the page.");
    }
  }

  const findCohort = (id) => state.cohorts.find((c) => c.id === id);

  /* ---------- File storage (IndexedDB) ---------- */
  let dbPromise;
  function db() {
    dbPromise ||= new Promise((resolve, reject) => {
      const req = indexedDB.open("trainerhub", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("files");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  async function fileOp(mode, fn) {
    const conn = await db();
    return new Promise((resolve, reject) => {
      const tx = conn.transaction("files", mode);
      const req = fn(tx.objectStore("files"));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  TrainerHub.data = {
    /* ----- Cohorts ----- */
    get cohorts() { return state.cohorts; },
    getCohort: findCohort,

    // teamLead is { name, email } or null.
    addCohort({ name, startDate, notes, teamLead = null }) {
      const cohort = { id: uid(), name, startDate, notes, teamLead, trainees: [], createdAt: new Date().toISOString() };
      state.cohorts.push(cohort);
      save();
      return cohort;
    },
    updateCohort(id, fields) {
      Object.assign(findCohort(id), fields);
      save();
    },
    deleteCohort(id) {
      state.cohorts = state.cohorts.filter((c) => c.id !== id);
      save();
    },

    /* ----- Trainees ----- */
    addTrainee(cohortId, { name, email }) {
      findCohort(cohortId).trainees.push({ id: uid(), name, email });
      save();
    },
    updateTrainee(cohortId, traineeId, fields) {
      Object.assign(findCohort(cohortId).trainees.find((t) => t.id === traineeId), fields);
      save();
    },
    deleteTrainee(cohortId, traineeId) {
      const cohort = findCohort(cohortId);
      cohort.trainees = cohort.trainees.filter((t) => t.id !== traineeId);
      save();
    },

    /* ----- Courseware materials ----- */
    get materials() { return state.materials; },

    // An uploaded file: details in localStorage, the file itself in IndexedDB.
    async addFile(file, kind) {
      const id = uid();
      await fileOp("readwrite", (s) => s.put(file, id));
      state.materials.unshift({
        id, kind, source: "file",
        title: file.name.replace(/\.[^.]+$/, ""),
        fileName: file.name, size: file.size, mime: file.type,
        topic: "", addedAt: new Date().toISOString(),
      });
      save();
    },
    // A link to Google Slides, a Google Doc, a video, etc.
    addLink({ title, url, topic }, kind) {
      state.materials.unshift({ id: uid(), kind, source: "link", title, url, topic, addedAt: new Date().toISOString() });
      save();
    },
    updateMaterial(id, fields) {
      Object.assign(state.materials.find((m) => m.id === id), fields);
      save();
    },
    async deleteMaterial(id) {
      const material = state.materials.find((m) => m.id === id);
      if (material && material.source === "file") await fileOp("readwrite", (s) => s.delete(id));
      state.materials = state.materials.filter((m) => m.id !== id);
      save();
    },
    getFile(id) {
      return fileOp("readonly", (s) => s.get(id));
    },
  };
})();
