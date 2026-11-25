import { pdfjsLib } from "./pdfjs.js";
import { EventBus, PDFLinkService, PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import "pdfjs-dist/web/pdf_viewer.css";
import "./app.css";
import bundledFiles from "virtual:pdf-assets";
import { chooseSignature } from "./signature.js";
import {
  DATE_STYLES, formatDate, formatForField, formatValue, formats, numberSpecFromActions,
  regionChoices, resetFormats, setFormats, setSystemLocale,
} from "./formats.js";

const { AnnotationEditorType } = pdfjsLib;

// pdf.js keys that start with this prefix are written to the file as new annotations.
const NEW_ANNOT_PREFIX = "pdfjs_internal_editor_";
// pdf.js lays out FreeText annotations with these factors (see FreeTextAnnotation).
const LINE_FACTOR = 1.35;
const COLORS = { black: [17, 17, 17], blue: [31, 63, 168] };
const MARKS = {
  check: "M4.5 12.5 9.5 17.5 19.5 6.5",
  cross: "M6 6 18 18M18 6 6 18",
};

const $ = (s) => document.querySelector(s);

// ---------------------------------------------------------------------------
// pdf.js setup
// ---------------------------------------------------------------------------

/** Serves fonts and image decoders from inside this HTML file, so nothing is fetched. */
class BundledDataFactory {
  async fetch({ kind, filename }) {
    const data = bundledFiles[filename];
    if (!data) throw new Error(`Not bundled (${kind}): ${filename}`);
    return data.slice();
  }
}

const noL10n = {
  getLanguage: () => "en-us",
  getDirection: () => "ltr",
  get: async (ids) => (Array.isArray(ids) ? ids.map(() => "") : ""),
  translate: async () => {},
  translateOnce: async () => {},
  destroy: async () => {},
  pause() {},
  resume() {},
};

const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus, externalLinkTarget: 2 /* _blank */ });
const viewer = new PDFViewer({
  container: $("#viewerContainer"),
  viewer: $("#viewer"),
  eventBus,
  linkService,
  l10n: noL10n,
  textLayerMode: 0,
  annotationEditorMode: AnnotationEditorType.DISABLE,
  removePageBorders: false,
});
linkService.setViewer(viewer);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  doc: null,
  loadingTask: null,
  fileName: "",
  /** Items placed on pages. Geometry is in PDF points, in the page's displayed orientation. */
  items: [],
  selectedId: null,
  editingId: null,
  tool: "select",
  pendingImage: null,
  textSize: 11,
  color: "black",
  undo: [],
  dirty: false,
  nextId: 1,
};

const els = new Map(); // item id -> element
const overlays = new Map(); // page index -> overlay element
const measureCtx = document.createElement("canvas").getContext("2d");

const findItem = (id) => state.items.find((i) => i.id === id);
const pageScale = (pageIndex) => viewer.getPageView(pageIndex)?.viewport.scale ?? 1;

function pushUndo() {
  state.undo.push(JSON.stringify(state.items));
  if (state.undo.length > 100) state.undo.shift();
  markDirty();
}

function undo() {
  const snap = state.undo.pop();
  if (snap === undefined) return;
  state.items = JSON.parse(snap);
  state.selectedId = state.editingId = null;
  rebuildItems();
  markDirty();
}

function markDirty() {
  state.dirty = true;
  updateChrome();
}

// ---------------------------------------------------------------------------
// Overlay rendering
// ---------------------------------------------------------------------------

function textWidth(item) {
  measureCtx.font = `${item.size}px Helvetica, Arial, sans-serif`;
  const lines = item.text.split("\n");
  return Math.max(...lines.map((l) => measureCtx.measureText(l).width), item.size * 0.5);
}

/** Bounding box of an item in display points. */
function itemBox(item) {
  if (item.type === "text") {
    const lines = item.text.split("\n").length;
    return { x: item.x, y: item.y, w: textWidth(item) + item.size * 0.15, h: lines * LINE_FACTOR * item.size };
  }
  return { x: item.x, y: item.y, w: item.w, h: item.h };
}

function ensureOverlay(pageIndex) {
  const pv = viewer.getPageView(pageIndex);
  if (!pv?.div) return null;
  let ov = overlays.get(pageIndex);
  if (!ov) {
    ov = document.createElement("div");
    ov.className = "pp-overlay";
    ov.dataset.page = String(pageIndex);
    ov.addEventListener("pointerdown", (e) => onOverlayPointerDown(e, pageIndex));
    overlays.set(pageIndex, ov);
  }
  if (ov.parentNode !== pv.div) pv.div.append(ov);
  return ov;
}

function attachAllOverlays() {
  if (!state.doc) return;
  for (let i = 0; i < viewer.pagesCount; i++) ensureOverlay(i);
  for (const item of state.items) layoutItem(item);
}

function createItemEl(item) {
  const el = document.createElement("div");
  el.className = `pp-item pp-${item.type}`;
  el.dataset.id = String(item.id);
  if (item.type === "text") {
    const t = document.createElement("div");
    t.className = "pp-txt";
    t.spellcheck = false;
    el.append(t);
    t.addEventListener("blur", () => finishEditing(item.id));
    t.addEventListener("keydown", (e) => {
      if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
        e.preventDefault();
        t.blur();
      }
      e.stopPropagation();
    });
    el.addEventListener("dblclick", () => startEditing(item.id));
  } else if (item.type === "image") {
    const img = document.createElement("img");
    img.draggable = false;
    img.alt = "Signature";
    el.append(img);
  } else {
    el.innerHTML = `<svg viewBox="0 0 24 24" preserveAspectRatio="none"><path d="${MARKS[item.type]}"/></svg>`;
  }
  const handle = document.createElement("div");
  handle.className = "pp-handle";
  handle.title = "Drag to resize";
  el.append(handle);
  el.addEventListener("pointerdown", (e) => onItemPointerDown(e, item.id, e.target === handle));
  return el;
}

function layoutItem(item) {
  let el = els.get(item.id);
  if (!el) {
    el = createItemEl(item);
    els.set(item.id, el);
  }
  const ov = ensureOverlay(item.page);
  if (ov && el.parentNode !== ov) ov.append(el);
  const s = pageScale(item.page);
  el.style.left = `${item.x * s}px`;
  el.style.top = `${item.y * s}px`;
  el.style.color = `rgb(${COLORS[item.color].join(",")})`;
  el.classList.toggle("sel", item.id === state.selectedId);
  if (item.type === "text") {
    el.style.fontSize = `${item.size * s}px`;
    const t = el.firstElementChild;
    if (state.editingId !== item.id && t.textContent !== item.text) t.textContent = item.text;
  } else {
    el.style.width = `${item.w * s}px`;
    el.style.height = `${item.h * s}px`;
    if (item.type === "image") {
      const img = el.firstElementChild;
      if (img.getAttribute("src") !== item.src) img.src = item.src;
    }
  }
}

function rebuildItems() {
  for (const el of els.values()) el.remove();
  els.clear();
  for (const item of state.items) layoutItem(item);
  updateChrome();
}

function removeItem(id) {
  state.items = state.items.filter((i) => i.id !== id);
  els.get(id)?.remove();
  els.delete(id);
  if (state.selectedId === id) state.selectedId = null;
  if (state.editingId === id) state.editingId = null;
}

function select(id) {
  state.selectedId = id;
  for (const [eid, el] of els) el.classList.toggle("sel", eid === id);
  const item = id && findItem(id);
  if (item?.type === "text") state.textSize = item.size;
  if (item) state.color = item.color;
  updateChrome();
}

// ---------------------------------------------------------------------------
// Text editing
// ---------------------------------------------------------------------------

function startEditing(id) {
  const item = findItem(id);
  const el = els.get(id);
  if (!item || item.type !== "text" || !el) return;
  if (state.editingId && state.editingId !== id) finishEditing(state.editingId);
  state.editingId = id;
  select(id);
  el.classList.add("editing");
  const t = el.firstElementChild;
  t.contentEditable = "plaintext-only";
  if (t.contentEditable !== "plaintext-only") t.contentEditable = "true";
  t.focus({ preventScroll: true });
  const range = document.createRange();
  range.selectNodeContents(t);
  range.collapse(false);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
}

function finishEditing(id) {
  if (state.editingId !== id) return;
  const item = findItem(id);
  const el = els.get(id);
  state.editingId = null;
  if (!item || !el) return;
  const t = el.firstElementChild;
  t.contentEditable = "false";
  el.classList.remove("editing");
  const text = t.innerText.replace(/\r/g, "").replace(/\n+$/, "");
  if (!text.trim()) {
    removeItem(id);
    // Drop the snapshot taken when this empty box was created.
    if (item.isNew) state.undo.pop();
    updateChrome();
    return;
  } else if (text !== item.text) {
    if (!item.isNew) pushUndo();
    item.text = text;
    markDirty();
  }
  delete item.isNew;
  layoutItem(item);
  updateChrome();
}

// ---------------------------------------------------------------------------
// Pointer interactions
// ---------------------------------------------------------------------------

function pointInPage(e, pageIndex) {
  const ov = overlays.get(pageIndex);
  const r = ov.getBoundingClientRect();
  const s = pageScale(pageIndex);
  return { x: (e.clientX - r.left) / s, y: (e.clientY - r.top) / s };
}

function onOverlayPointerDown(e, pageIndex) {
  if (state.tool === "select" || e.button !== 0) return;
  e.preventDefault();
  // Keep the document-level "click away" handler from closing what we open here.
  e.stopPropagation();
  if (state.editingId) finishEditing(state.editingId);
  const p = pointInPage(e, pageIndex);
  const base = { id: state.nextId++, page: pageIndex, color: state.color };
  let item;
  switch (state.tool) {
    case "text":
    case "date": {
      const size = state.textSize;
      const text = state.tool === "date" ? formatDate() : "";
      item = { ...base, type: "text", size, text, x: p.x - 1, y: p.y - (LINE_FACTOR * size) / 2 };
      break;
    }
    case "check":
    case "cross": {
      const w = Math.max(8, state.textSize * 1.1);
      item = { ...base, type: state.tool, x: p.x - w / 2, y: p.y - w / 2, w, h: w };
      break;
    }
    case "sign": {
      const { src, ratio } = state.pendingImage;
      let w = 150;
      let h = w / ratio;
      if (h > 50) {
        h = 50;
        w = h * ratio;
      }
      item = { ...base, type: "image", src, x: p.x - w / 2, y: p.y - h / 2, w, h };
      break;
    }
    default:
      return;
  }
  pushUndo();
  state.items.push(item);
  layoutItem(item);
  select(item.id);
  if (item.type === "text" && !item.text) {
    item.isNew = true;
    setTool("select");
    // Focus now, not on the next frame, so fast typing can't land in a form field.
    startEditing(item.id);
  } else if (state.tool === "text" || state.tool === "date" || state.tool === "sign") {
    setTool("select");
  }
  updateChrome();
}

function onItemPointerDown(e, id, onHandle) {
  if (state.tool !== "select" || e.button !== 0) return;
  if (state.editingId === id && !onHandle) return; // let the caret move
  e.preventDefault();
  e.stopPropagation();
  if (state.editingId) finishEditing(state.editingId);
  const item = findItem(id);
  if (!item) return;
  select(id);
  const el = els.get(id);
  el.setPointerCapture(e.pointerId);
  const s = pageScale(item.page);
  const start = { x: e.clientX, y: e.clientY, item: { ...item }, box: itemBox(item) };
  let moved = false;

  const move = (ev) => {
    const dx = (ev.clientX - start.x) / s;
    const dy = (ev.clientY - start.y) / s;
    if (!moved && Math.hypot(dx, dy) * s < 3) return;
    if (!moved) {
      pushUndo();
      moved = true;
    }
    if (onHandle) {
      if (item.type === "text") {
        const k = Math.max(0.2, (start.box.h + dy) / start.box.h);
        item.size = Math.min(72, Math.max(5, Math.round(start.item.size * k * 2) / 2));
        state.textSize = item.size;
      } else {
        const ratio = start.item.w / start.item.h;
        const k = Math.max((start.item.w + dx) / start.item.w, (start.item.h + dy) / start.item.h);
        item.w = Math.max(6, start.item.w * k);
        item.h = item.w / ratio;
      }
    } else {
      item.x = start.item.x + dx;
      item.y = start.item.y + dy;
    }
    layoutItem(item);
    updateChrome();
  };
  const up = () => {
    el.removeEventListener("pointermove", move);
    el.removeEventListener("pointerup", up);
    el.removeEventListener("pointercancel", up);
  };
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
}

document.addEventListener("pointerdown", (e) => {
  if (e.target.closest(".pp-item, .toolbar, dialog")) return;
  if (state.editingId) finishEditing(state.editingId);
  if (state.selectedId) select(null);
});

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

const HINTS = {
  text: "Click where the text should go",
  date: "Click where today's date should go",
  check: "Click to add check marks · Esc when done",
  cross: "Click to add crosses · Esc when done",
  sign: "Click where the signature should go · Esc to cancel",
};

function setTool(tool) {
  if (state.editingId) finishEditing(state.editingId);
  state.tool = tool;
  if (tool !== "sign") state.pendingImage = null;
  document.body.dataset.tool = tool;
  updateChrome();
}

function updateChrome() {
  const hasDoc = !!state.doc;
  document.body.classList.toggle("has-doc", hasDoc);
  for (const b of document.querySelectorAll("button[data-tool]")) {
    b.setAttribute("aria-pressed", String(b.dataset.tool === state.tool));
    b.disabled = !hasDoc;
  }
  for (const b of document.querySelectorAll("[data-color]")) {
    b.setAttribute("aria-pressed", String(b.dataset.color === state.color));
  }
  $("#sizeValue").textContent = String(state.textSize);
  $("#save").disabled = !hasDoc;
  $("#delete").disabled = !state.selectedId;
  $("#undo").disabled = state.undo.length === 0;
  for (const id of ["#zoomIn", "#zoomOut", "#sizeDown", "#sizeUp"]) $(id).disabled = !hasDoc;
  $("#fileName").textContent = state.fileName ? `${state.fileName}${state.dirty ? " •" : ""}` : "";
  const hint = HINTS[state.tool];
  $("#hint").textContent = hint || "";
  $("#hint").hidden = !hint;
}

function changeSize(delta) {
  const item = state.selectedId && findItem(state.selectedId);
  const next = Math.min(72, Math.max(5, (item?.type === "text" ? item.size : state.textSize) + delta));
  state.textSize = next;
  if (item?.type === "text") {
    pushUndo();
    item.size = next;
    layoutItem(item);
  }
  updateChrome();
}

function setColor(color) {
  state.color = color;
  const item = state.selectedId && findItem(state.selectedId);
  if (item && item.type !== "image" && item.color !== color) {
    pushUndo();
    item.color = color;
    layoutItem(item);
  }
  updateChrome();
}

function deleteSelected() {
  if (!state.selectedId) return;
  pushUndo();
  removeItem(state.selectedId);
  updateChrome();
}

async function startSignature() {
  if (state.editingId) finishEditing(state.editingId);
  const src = await chooseSignature();
  if (!src) return;
  const img = new Image();
  img.src = src;
  await img.decode();
  setTool("sign");
  state.pendingImage = { src, ratio: img.naturalWidth / img.naturalHeight };
}

for (const b of document.querySelectorAll("button[data-tool]")) {
  b.addEventListener("click", () => {
    if (b.dataset.tool === "sign") startSignature();
    else setTool(state.tool === b.dataset.tool ? "select" : b.dataset.tool);
  });
}
for (const b of document.querySelectorAll("[data-color]")) b.addEventListener("click", () => setColor(b.dataset.color));
$("#sizeDown").addEventListener("click", () => changeSize(-1));
$("#sizeUp").addEventListener("click", () => changeSize(1));
$("#delete").addEventListener("click", deleteSelected);
$("#undo").addEventListener("click", undo);
$("#zoomIn").addEventListener("click", () => viewer.increaseScale());
$("#zoomOut").addEventListener("click", () => viewer.decreaseScale());
/** Prefer the File System Access picker: its handle lets Save start in the PDF's own folder. */
async function chooseFile() {
  if (!window.showOpenFilePicker) {
    $("#fileInput").click();
    return;
  }
  try {
    const [handle] = await window.showOpenFilePicker({
      id: "paraphe-open",
      types: [{ description: "PDF document", accept: { "application/pdf": [".pdf"] } }],
    });
    openFile(await handle.getFile(), handle);
  } catch (err) {
    if (err?.name !== "AbortError") $("#fileInput").click();
  }
}

$("#open").addEventListener("click", chooseFile);
$("#emptyOpen").addEventListener("click", chooseFile);
$("#fileInput").addEventListener("change", (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (f) openFile(f);
});
$("#save").addEventListener("click", () => save());

// ---------------------------------------------------------------------------
// Keyboard, drag and drop
// ---------------------------------------------------------------------------

function isTyping(target) {
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (state.doc) save();
    return;
  }
  if (mod && e.key.toLowerCase() === "o") {
    e.preventDefault();
    chooseFile();
    return;
  }
  if (mod && (e.key === "=" || e.key === "+")) {
    e.preventDefault();
    viewer.increaseScale();
    return;
  }
  if (mod && e.key === "-") {
    e.preventDefault();
    viewer.decreaseScale();
    return;
  }
  if (document.querySelector("dialog[open]") || isTyping(e.target)) return;
  if (mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undo();
  } else if (e.key === "Escape") {
    if (state.tool !== "select") setTool("select");
    else select(null);
  } else if (e.key === "Delete" || e.key === "Backspace") {
    if (state.selectedId) {
      e.preventDefault();
      deleteSelected();
    }
  } else if (e.key === "Enter" && state.selectedId) {
    e.preventDefault();
    startEditing(state.selectedId);
  } else if (e.key.startsWith("Arrow") && state.selectedId) {
    e.preventDefault();
    const item = findItem(state.selectedId);
    const step = e.shiftKey ? 10 : 1;
    pushUndo();
    if (e.key === "ArrowLeft") item.x -= step;
    if (e.key === "ArrowRight") item.x += step;
    if (e.key === "ArrowUp") item.y -= step;
    if (e.key === "ArrowDown") item.y += step;
    layoutItem(item);
  }
});

window.addEventListener("dragover", (e) => {
  e.preventDefault();
  document.body.classList.add("dragging");
});
window.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) document.body.classList.remove("dragging");
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("dragging");
  const isPdf = (x) => x && (x.type === "application/pdf" || /\.pdf$/i.test(x.name));
  const items = [...(e.dataTransfer?.items || [])].filter((i) => i.kind === "file");
  const index = items.findIndex((i) => isPdf(i.getAsFile()));
  if (index < 0) {
    if (items.length) toast("That isn't a PDF.");
    return;
  }
  // The handle must be requested during the drop event itself.
  const file = items[index].getAsFile();
  const handlePromise = items[index].getAsFileSystemHandle?.() ?? Promise.resolve(null);
  handlePromise.catch(() => null).then((handle) => openFile(file, handle?.kind === "file" ? handle : null));
});

window.addEventListener("beforeunload", (e) => {
  if (state.dirty) e.preventDefault();
});

// ---------------------------------------------------------------------------
// Viewer events
// ---------------------------------------------------------------------------

eventBus.on("pagesinit", () => {
  requestAnimationFrame(() => {
    viewer.currentScaleValue = "page-width";
    if (viewer.currentScale > 1.25) viewer.currentScale = 1.25;
    attachAllOverlays();
  });
});
eventBus.on("pagerendered", ({ pageNumber }) => {
  ensureOverlay(pageNumber - 1);
  for (const item of state.items) if (item.page === pageNumber - 1) layoutItem(item);
});
eventBus.on("scalechanging", ({ scale }) => {
  attachAllOverlays();
  $("#zoomValue").textContent = `${Math.round(scale * 100)}%`;
});

// ---------------------------------------------------------------------------
// Regional formats: dates and amounts in form fields
// ---------------------------------------------------------------------------

/** Widget id -> number format declared by the form (amounts, percentages). */
const numberFields = new Map();

function collectNumberFields(fields) {
  numberFields.clear();
  // pdf.js returns a Map of field name -> widgets (older versions: a plain object).
  const groups = fields instanceof Map ? [...fields.values()] : Object.values(fields || {});
  for (const widgets of groups) {
    for (const w of widgets) {
      if (w.type !== "text" || !w.id) continue;
      const spec = numberSpecFromActions(w.actions);
      if (spec) numberFields.set(w.id, spec);
    }
  }
  for (const el of document.querySelectorAll(".annotationLayer input[data-element-id]")) {
    if (numberInput(el)) el.inputMode = "decimal";
  }
  return groups.length;
}

function numberInput(el) {
  return el?.matches?.(".annotationLayer input[data-element-id]") && numberFields.has(el.dataset.elementId) ? el : null;
}

// Reformat an amount when the field loses focus. pdf.js stores `formattedValue`
// for the field's appearance and keeps `value` as the plain number.
document.addEventListener("focusout", (e) => {
  const el = numberInput(e.target);
  if (!el || !state.doc) return;
  const id = el.dataset.elementId;
  const text = el.value.trim();
  const storage = state.doc.annotationStorage;
  if (!text) {
    storage.setValue(id, { value: "", formattedValue: null });
    return;
  }
  const out = formatForField(text, numberFields.get(id));
  if (!out) return; // not a number: leave what was typed
  el.value = out.formatted;
  storage.setValue(id, { value: out.value, formattedValue: out.formatted });
});

eventBus.on("annotationlayerrendered", () => {
  for (const el of document.querySelectorAll(".annotationLayer input[data-element-id]")) {
    if (numberInput(el)) el.inputMode = "decimal";
  }
});

/** After the region changes, redo amounts already typed. */
function reformatNumberFields() {
  if (!state.doc) return;
  const storage = state.doc.annotationStorage;
  for (const [id, spec] of numberFields) {
    const entry = storage.getRawValue(id);
    if (!entry?.formattedValue || entry.value === "") continue;
    const n = Number(entry.value) * (spec.kind === "percent" ? 100 : 1);
    if (!Number.isFinite(n)) continue;
    const out = formatValue(n, spec);
    storage.setValue(id, { formattedValue: out.formatted });
    const el = document.querySelector(`.annotationLayer input[data-element-id="${CSS.escape(id)}"]`);
    if (el && el !== document.activeElement) el.value = out.formatted;
  }
}

function renderFormats() {
  $("#regionLabel").textContent = formats.locale.split("-")[0].toUpperCase();
  const select = $("#regionSelect");
  select.replaceChildren(
    ...regionChoices().map(({ tag, label }) => new Option(`${label} · ${tag}`, tag, false, tag === formats.locale)),
  );
  const labels = { numeric: "Short", long: "Long", iso: "ISO" };
  $("#dateStyles").replaceChildren(
    ...DATE_STYLES.map((style) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "choice";
      b.role = "radio";
      b.setAttribute("aria-checked", String(style === formats.date));
      b.innerHTML = `<span></span><small></small>`;
      b.firstChild.textContent = formatDate(new Date(), style);
      b.lastChild.textContent = labels[style];
      b.onclick = () => {
        setFormats({ date: style });
        renderFormats();
      };
      return b;
    }),
  );
  $("#numberPreview").textContent = formatValue(1234.5, { kind: "number", decimals: 2, grouping: true, currency: "", prepend: false }).formatted;
  $("#formatsReset").hidden = formats.auto;
}

function toggleFormats(open = $("#formatsPop").hidden) {
  $("#formatsPop").hidden = !open;
  $("#formatsBtn").setAttribute("aria-expanded", String(open));
  if (open) renderFormats();
}

$("#formatsBtn").addEventListener("click", () => toggleFormats());
$("#regionSelect").addEventListener("change", (e) => {
  setFormats({ locale: e.target.value });
  renderFormats();
  reformatNumberFields();
});
$("#formatsReset").addEventListener("click", () => {
  resetFormats();
  renderFormats();
  reformatNumberFields();
});
document.addEventListener("pointerdown", (e) => {
  if (!$("#formatsPop").hidden && !e.target.closest(".pop-anchor")) toggleFormats(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#formatsPop").hidden) {
    toggleFormats(false);
    e.stopImmediatePropagation();
  }
}, true);
renderFormats();

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

/**
 * @param {File} file
 * @param {FileSystemFileHandle|null} handle  Where the file came from, when known.
 */
async function openFile(file, handle = null) {
  if (state.dirty && !confirm("You have unsaved changes. Open another file anyway?")) return;
  state.fileHandle = handle;
  const data = new Uint8Array(await file.arrayBuffer());
  if (state.loadingTask) await state.loadingTask.destroy();
  for (const ov of overlays.values()) ov.remove();
  overlays.clear();
  for (const el of els.values()) el.remove();
  els.clear();
  Object.assign(state, { doc: null, items: [], undo: [], selectedId: null, editingId: null, dirty: false });
  setTool("select");

  const task = pdfjsLib.getDocument({
    data,
    BinaryDataFactory: BundledDataFactory,
    useSystemFonts: false,
    isEvalSupported: false,
    enableXfa: false,
  });
  task.onPassword = (update, reason) => {
    const again = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
    const pw = prompt(again ? "Wrong password. Try again:" : "This PDF is password protected. Password:");
    if (pw === null) task.destroy();
    else update(pw);
  };
  state.loadingTask = task;
  try {
    const doc = await task.promise;
    state.doc = doc;
    state.fileName = file.name;
    document.title = `${file.name} · Paraphe`;
    doc.annotationStorage.onSetModified = () => markDirty();
    document.body.classList.add("has-doc");
    viewer.setDocument(doc);
    linkService.setDocument(doc);
    const fields = await doc.getFieldObjects();
    if (collectNumberFields(fields)) toast("This PDF has form fields: click a field to fill it.");
  } catch (err) {
    if (err?.name === "PasswordException") return;
    console.error(err);
    toast(`Couldn't open this file: ${err?.message || err}`);
  }
  updateChrome();
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

async function rasterizeMark(item) {
  const px = 160;
  const c = new OffscreenCanvas(px, px);
  const ctx = c.getContext("2d");
  ctx.scale(px / 24, px / 24);
  ctx.strokeStyle = `rgb(${COLORS[item.color].join(",")})`;
  ctx.lineWidth = 2.6;
  ctx.lineCap = ctx.lineJoin = "round";
  ctx.stroke(new Path2D(MARKS[item.type]));
  return c.transferToImageBitmap();
}

async function imageBitmapFromDataUrl(src) {
  const blob = await (await fetch(src)).blob();
  return createImageBitmap(blob);
}

/** Turn the placed items into pdf.js "new annotation" records. */
async function buildAnnotations() {
  const out = [];
  for (const item of state.items) {
    const page = await state.doc.getPage(item.page + 1);
    const vp = page.getViewport({ scale: 1 });
    const b = itemBox(item);
    const [x1, y1] = vp.convertToPdfPoint(b.x, b.y);
    const [x2, y2] = vp.convertToPdfPoint(b.x + b.w, b.y + b.h);
    const rect = [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
    const common = { pageIndex: item.page, rect, rotation: vp.rotation, structTreeParentId: null };
    const key = `${NEW_ANNOT_PREFIX}paraphe_${item.id}`;
    if (item.type === "text") {
      out.push([key, {
        ...common,
        annotationType: AnnotationEditorType.FREETEXT,
        color: COLORS[item.color],
        fontSize: item.size,
        value: item.text,
      }]);
    } else {
      const bitmap = item.type === "image" ? await imageBitmapFromDataUrl(item.src) : await rasterizeMark(item);
      out.push([key, {
        ...common,
        annotationType: AnnotationEditorType.STAMP,
        bitmapId: key,
        bitmap,
        isSvg: false,
      }]);
    }
  }
  return out;
}

async function save() {
  if (!state.doc) return;
  if (state.editingId) finishEditing(state.editingId);
  const btn = $("#save");
  btn.disabled = true;
  const storage = state.doc.annotationStorage;
  const added = [];
  let bytes;
  try {
    for (const [key, value] of await buildAnnotations()) {
      storage.setValue(key, value);
      added.push(key);
    }
    bytes = await state.doc.saveDocument();
  } catch (err) {
    console.error(err);
    toast(`Couldn't build the PDF: ${err?.message || err}`);
    return;
  } finally {
    // Keep the items as editable overlays; remove the temporary records.
    for (const key of added) storage.remove(key);
    btn.disabled = false;
  }
  const name = state.fileName.replace(/\.pdf$/i, "") + " (signed).pdf";
  const saved = await writeFile(bytes, name);
  if (saved) {
    state.dirty = false;
    updateChrome();
    toast(`Saved ${saved}`);
  }
}

async function writeFile(bytes, suggestedName) {
  if (window.chrome?.webview) return hostSave(bytes, suggestedName);
  if (window.showSaveFilePicker) {
    const options = {
      id: "paraphe-save",
      suggestedName,
      types: [{ description: "PDF document", accept: { "application/pdf": [".pdf"] } }],
    };
    // Start in the original PDF's folder when we know it.
    const attempts = state.fileHandle ? [{ ...options, startIn: state.fileHandle }, options] : [options];
    for (const opts of attempts) {
      try {
        const handle = await window.showSaveFilePicker(opts);
        const w = await handle.createWritable();
        await w.write(bytes);
        await w.close();
        return handle.name;
      } catch (err) {
        if (err?.name === "AbortError") return null;
        console.warn("Save picker failed", err);
      }
    }
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: suggestedName });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return suggestedName;
}

// ---------------------------------------------------------------------------

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

// ---------------------------------------------------------------------------
// Windows app (WebView2 host)
// ---------------------------------------------------------------------------

// Asked by the app before its window closes.
window.parapheIsDirty = () => state.dirty;

const host = window.chrome?.webview;
let pendingSave = null;

/** In the app, saving goes through the native Windows "Save as" dialog. */
function hostSave(bytes, suggestedName) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return new Promise((resolve) => {
    pendingSave = resolve;
    host.postMessage({ type: "save", name: suggestedName, data: btoa(binary) });
  });
}

if (host) {
  document.body.classList.add("in-app");
  host.addEventListener("message", async (e) => {
    const msg = e.data || {};
    if (msg.type === "open") {
      // Explorer opened a PDF with Paraphe: the app sends a file handle.
      const handle = e.additionalObjects?.[0];
      if (!handle?.getFile) return;
      try {
        openFile(await handle.getFile(), handle);
      } catch (err) {
        toast(`Couldn't open ${msg.name || "the file"}: ${err?.message || err}`);
      }
    } else if (msg.type === "saved" || msg.type === "save-cancelled" || msg.type === "save-failed") {
      if (msg.type === "save-failed") toast(`Couldn't save: ${msg.error}`);
      pendingSave?.(msg.type === "saved" ? msg.name : null);
      pendingSave = null;
    } else if (msg.type === "host") {
      // Until the user picks a region, follow Windows' regional format.
      if (msg.locale) {
        setSystemLocale(msg.locale);
        renderFormats();
      }
      const b = $("#makeDefault");
      b.hidden = false;
      b.textContent = msg.installed ? "Make Paraphe my PDF app" : "Install and make Paraphe my PDF app";
    }
  });
  $("#makeDefault").addEventListener("click", () => host.postMessage({ type: "make-default" }));
  host.postMessage({ type: "ready" });
}

// Exposed for automated tests only.
globalThis.__paraphe = { state, openFile, buildAnnotations, viewer };

setTool("select");
