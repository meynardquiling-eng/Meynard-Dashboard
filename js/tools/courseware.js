(function () {
  const { esc, plural, formatDate, formatSize, openForm, confirmAction, toast } = TrainerHub;

  /*
    Material kinds. To support a new kind, add a row here.
      ext    file extensions that map to this kind
      hosts  URL patterns (for links) that map to this kind
  */
  const KINDS = [
    { id: "video",  label: "Video",          badge: "VID", ext: ["mp4", "mov", "webm", "mkv", "avi", "m4v", "wmv"], hosts: [/youtube\.com|youtu\.be|vimeo\.com|loom\.com/] },
    { id: "slides", label: "Slides",         badge: "PPT", ext: ["ppt", "pptx", "pps", "ppsx", "key", "odp"], hosts: [/docs\.google\.com\/presentation/] },
    { id: "doc",    label: "Document",       badge: "DOC", ext: ["doc", "docx", "odt", "rtf", "txt", "md"], hosts: [/docs\.google\.com\/document/] },
    { id: "pdf",    label: "PDF",            badge: "PDF", ext: ["pdf"], hosts: [/\.pdf($|\?)/i] },
    { id: "sheet",  label: "Spreadsheet",    badge: "XLS", ext: ["xls", "xlsx", "csv", "ods"], hosts: [/docs\.google\.com\/spreadsheets/] },
    { id: "image",  label: "Image",          badge: "IMG", ext: ["png", "jpg", "jpeg", "gif", "webp", "svg"], hosts: [] },
    { id: "audio",  label: "Audio",          badge: "AUD", ext: ["mp3", "wav", "m4a", "ogg"], hosts: [] },
    { id: "link",   label: "Link",           badge: "URL", ext: [], hosts: [] },
    { id: "other",  label: "Other",          badge: "FILE", ext: [], hosts: [] },
  ];
  const kindById = (id) => KINDS.find((k) => k.id === id) || KINDS[KINDS.length - 1];

  // Friendlier names for Google links.
  const GOOGLE_LABELS = [
    [/docs\.google\.com\/presentation/, "Google Slides"],
    [/docs\.google\.com\/document/, "Google Doc"],
    [/docs\.google\.com\/spreadsheets/, "Google Sheet"],
    [/docs\.google\.com\/forms/, "Google Form"],
    [/drive\.google\.com/, "Google Drive"],
  ];

  function kindForFile(file) {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    const byExt = KINDS.find((k) => k.ext.includes(ext));
    if (byExt) return byExt.id;
    if (file.type.startsWith("video/")) return "video";
    if (file.type.startsWith("image/")) return "image";
    if (file.type.startsWith("audio/")) return "audio";
    return "other";
  }
  const kindForUrl = (url) => (KINDS.find((k) => k.hosts.some((re) => re.test(url))) || kindById("link")).id;
  const sourceLabel = (m) => {
    if (m.source === "file") return (m.fileName.split(".").pop() || "").toUpperCase() + " · " + formatSize(m.size);
    const google = GOOGLE_LABELS.find(([re]) => re.test(m.url));
    if (google) return google[1];
    try { return new URL(m.url).hostname.replace(/^www\./, ""); } catch { return "Link"; }
  };

  const ACCEPT = KINDS.flatMap((k) => k.ext.map((e) => "." + e)).join(",") + ",video/*,audio/*,image/*";

  let filter = "all";
  const collapsed = new Set(); // kinds folded away in the All view

  // The All view: one section per kind, in KINDS order, each foldable.
  function groupedView(materials, ctx) {
    return KINDS.map((kind) => {
      const items = materials.filter((m) => m.kind === kind.id);
      if (!items.length) return "";
      const open = !collapsed.has(kind.id);
      return `
        <section class="kind-group">
          <div class="kind-group-head">
            <button class="kind-group-toggle" data-action="courseware:toggleGroup" data-kind="${kind.id}" aria-expanded="${open}">
              <span class="chev" aria-hidden="true"></span>
              <span class="kind-dot kind-${kind.id}" aria-hidden="true"></span>
              ${esc(kind.label)} <span class="muted">${items.length}</span>
            </button>
            <button class="link-btn" data-action="courseware:filter" data-kind="${kind.id}">Show only ${esc(kind.label.toLowerCase())}</button>
          </div>
          ${open ? `<div class="materials">${items.map((m) => card(m, ctx)).join("")}</div>` : ""}
        </section>`;
    }).join("");
  }

  function card(m, ctx) {
    const kind = kindById(m.kind);
    const href = m.source === "link" ? m.url : ctx.data.sharedFileUrl(m);
    const open = href
      ? `<a class="btn secondary" href="${esc(href)}" target="_blank" rel="noopener">Open</a>`
      : `<button class="btn secondary" data-action="courseware:open" data-id="${m.id}">Open</button>`;
    return `
      <article class="card material">
        <div class="kind kind-${kind.id}">${kind.badge}</div>
        <div class="min0">
          <h3 class="ellipsis" title="${esc(m.title)}">${esc(m.title)}</h3>
          <div class="muted small">${esc(sourceLabel(m))} · added ${formatDate(m.addedAt)}</div>
          ${m.topic ? `<div class="topic">${esc(m.topic)}</div>` : ""}
        </div>
        <div class="btn-row">
          ${open}
          <button class="link-btn" data-action="courseware:edit" data-id="${m.id}">Edit</button>
          <button class="link-btn danger" data-action="courseware:delete" data-id="${m.id}">Delete</button>
        </div>
      </article>`;
  }

  TrainerHub.registerTool({
    id: "courseware",
    name: "Courseware",
    short: "Courseware",
    description: "Your teaching materials: videos, slides, documents, PDFs and links.",
    icon: '<path d="M4 19.5V5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2zM4 19.5A2 2 0 0 0 6 21.5h14"/><path d="M9 8h7M9 12h5"/>',

    render(ctx) {
      const { materials } = ctx.data;
      const counts = Object.fromEntries(KINDS.map((k) => [k.id, materials.filter((m) => m.kind === k.id).length]));
      const shown = filter === "all" ? materials : materials.filter((m) => m.kind === filter);

      const chips = [["all", "All", materials.length], ...KINDS.filter((k) => counts[k.id]).map((k) => [k.id, k.label, counts[k.id]])]
        .map(([id, label, n]) => `<button class="chip" data-action="courseware:filter" data-kind="${id}" aria-pressed="${filter === id}">${esc(label)} <span>${n}</span></button>`)
        .join("");

      return `
        <div class="toolbar">
          <span class="muted">${plural(materials.length, "material")}</span>
          <div class="btn-row">
            <label class="btn">
              + Upload files
              <input type="file" id="courseware-upload" multiple accept="${ACCEPT}" data-action-change="courseware:upload" hidden>
            </label>
            <button class="btn secondary" data-action="courseware:addLink">+ Add link</button>
          </div>
        </div>

        <div class="dropzone" data-action-drop="courseware:drop">
          <strong>Drop files here</strong>
          <span>${ctx.data.mode === "shared"
            ? "MP4 or WebM videos, PDFs and images, up to 20 MB each. For PowerPoint, Word, Excel, Google Slides, Google Docs or bigger videos, put them in Google Drive and use <em>Add link</em>."
            : "Videos, PowerPoint, Word, PDF, Excel, images and more. For Google Slides or Google Docs, use <em>Add link</em>."}</span>
        </div>

        ${materials.length ? `<div class="chips">${chips}</div>` : ""}
        ${shown.length
          ? filter === "all" ? groupedView(materials, ctx) : `<div class="materials">${shown.map((m) => card(m, ctx)).join("")}</div>`
          : materials.length ? `<div class="empty">No materials of this type.</div>` : ""}`;
    },

    actions: {
      async upload(el, ctx) {
        await saveFiles([...el.files], ctx);
        el.value = "";
      },
      async drop(el, ctx, event) {
        await saveFiles([...event.dataTransfer.files], ctx);
      },
      addLink(el, ctx) {
        openForm({
          title: "Add a link", submitLabel: "Add link",
          fields: [
            { name: "url", label: "Link", type: "url", required: true, placeholder: "https://docs.google.com/presentation/…", hint: "Google Slides, Google Docs, Google Drive, YouTube, Loom or any web page. Make sure it's shared with whoever needs it." },
            { name: "title", label: "Title", placeholder: "Leave blank to use the link type" },
            { name: "topic", label: "Topic or module", placeholder: "e.g. Module 3 · Rescheduling" },
          ],
          onSubmit(v) {
            let url;
            try { url = new URL(v.url.match(/^https?:\/\//) ? v.url : "https://" + v.url); }
            catch { return "That doesn't look like a link. Paste the full address."; }
            const google = GOOGLE_LABELS.find(([re]) => re.test(url.href));
            const title = v.title || (google ? google[1] : url.hostname.replace(/^www\./, ""));
            ctx.data.addLink({ title, url: url.href, topic: v.topic }, kindForUrl(url.href));
            ctx.rerender();
            toast(`${title} added`);
          },
        });
      },
      async open(el, ctx) {
        const file = await ctx.data.getFile(el.dataset.id);
        if (!file) { toast("That file is missing from this browser."); return; }
        const url = URL.createObjectURL(file);
        // Browsers preview videos, PDFs and images in the new tab; Office files download instead.
        if (!window.open(url, "_blank")) toast("Your browser blocked the new tab. Allow pop-ups for this page.");
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      },
      edit(el, ctx) {
        const m = ctx.data.materials.find((x) => x.id === el.dataset.id);
        const fields = [
          { name: "title", label: "Title", required: true, value: m.title },
          { name: "topic", label: "Topic or module", value: m.topic, placeholder: "e.g. Module 3 · Rescheduling" },
        ];
        if (m.source === "link") fields.splice(1, 0, { name: "url", label: "Link", type: "url", required: true, value: m.url });
        openForm({
          title: "Edit material", fields,
          onSubmit(v) {
            if (v.url) v.kind = kindForUrl(v.url);
            ctx.data.updateMaterial(m.id, v);
            ctx.rerender();
          },
        });
      },
      delete(el, ctx) {
        const m = ctx.data.materials.find((x) => x.id === el.dataset.id);
        confirmAction({
          title: `Delete ${m.title}?`,
          message: m.source === "file" ? "The uploaded file will be removed from this browser." : "The link will be removed. The original stays where it is.",
          onConfirm: async () => {
            await ctx.data.deleteMaterial(m.id);
            ctx.rerender();
          },
        });
      },
      filter(el, ctx) {
        filter = el.dataset.kind;
        ctx.rerender();
      },
      toggleGroup(el, ctx) {
        const k = el.dataset.kind;
        if (collapsed.has(k)) collapsed.delete(k); else collapsed.add(k);
        ctx.rerender();
      },
    },
  });

  async function saveFiles(files, ctx) {
    if (!files.length) return;
    let saved = 0;
    for (const file of files) {
      const problem = ctx.data.uploadProblem(file);
      if (problem) { toast(problem); continue; }
      try {
        await ctx.data.addFile(file, kindForFile(file));
        saved++;
      } catch (err) {
        toast(`Couldn't save ${file.name}. The browser may be out of storage space.`);
      }
    }
    filter = "all";
    ctx.rerender();
    if (saved) toast(`${plural(saved, "file")} uploaded`);
  }
})();
