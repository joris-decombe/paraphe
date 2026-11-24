// Signature dialog: draw, type or import a signature, keep a few for reuse.
// Signatures are stored only in this browser's localStorage.

const STORE_KEY = "paraphe.signatures";
const SCRIPT_FONTS = ["Segoe Script", "Ink Free", "Lucida Handwriting", "Segoe Print"];
const INKS = { black: "#111111", blue: "#1f3fa8" };

export function loadSaved() {
  try {
    const list = JSON.parse(localStorage.getItem(STORE_KEY) || "[]");
    return Array.isArray(list) ? list.filter((s) => typeof s?.src === "string") : [];
  } catch {
    return [];
  }
}

function storeSaved(list) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  } catch {
    // Storage full or disabled: the signature still works for this session.
  }
}

/** Crop a canvas to its non-transparent pixels and return a PNG data URL. */
function trimToPng(canvas, pad = 6) {
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  const px = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (px[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement("canvas");
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext("2d").drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

/** Freehand pad that keeps strokes as points, so it can re-render at any resolution. */
class DrawPad {
  constructor(canvas) {
    this.canvas = canvas;
    this.strokes = [];
    this.color = INKS.black;
    this.width = 3;
    let current = null;
    canvas.addEventListener("pointerdown", (e) => {
      canvas.setPointerCapture(e.pointerId);
      current = [this.#pos(e)];
      this.strokes.push(current);
      this.render();
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!current) return;
      for (const ev of e.getCoalescedEvents?.() ?? [e]) current.push(this.#pos(ev));
      this.render();
    });
    const end = () => (current = null);
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    new ResizeObserver(() => this.render()).observe(canvas);
  }
  #pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  get isEmpty() {
    return this.strokes.length === 0;
  }
  clear() {
    this.strokes = [];
    this.render();
  }
  undo() {
    this.strokes.pop();
    this.render();
  }
  #paint(ctx, scale) {
    ctx.strokeStyle = ctx.fillStyle = this.color;
    ctx.lineWidth = this.width * scale;
    ctx.lineCap = ctx.lineJoin = "round";
    for (const s of this.strokes) {
      const p = s.map(([x, y]) => [x * scale, y * scale]);
      if (p.length < 3) {
        ctx.beginPath();
        ctx.arc(p[0][0], p[0][1], ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      ctx.beginPath();
      ctx.moveTo(p[0][0], p[0][1]);
      for (let i = 1; i < p.length - 1; i++) {
        const mx = (p[i][0] + p[i + 1][0]) / 2;
        const my = (p[i][1] + p[i + 1][1]) / 2;
        ctx.quadraticCurveTo(p[i][0], p[i][1], mx, my);
      }
      const last = p[p.length - 1];
      ctx.lineTo(last[0], last[1]);
      ctx.stroke();
    }
  }
  render() {
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth: w, clientHeight: h } = this.canvas;
    if (!w || !h) return;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    const ctx = this.canvas.getContext("2d");
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.#paint(ctx, dpr);
  }
  /** Render at 3x for a crisp result in the PDF. */
  export() {
    const scale = 3;
    const c = document.createElement("canvas");
    c.width = this.canvas.clientWidth * scale;
    c.height = this.canvas.clientHeight * scale;
    this.#paint(c.getContext("2d"), scale);
    return trimToPng(c);
  }
}

function renderTyped(text, font, color) {
  const size = 120;
  const probe = document.createElement("canvas").getContext("2d");
  probe.font = `${size}px "${font}", cursive`;
  const w = Math.ceil(probe.measureText(text).width) + size;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = Math.ceil(size * 1.8);
  const ctx = c.getContext("2d");
  ctx.font = probe.font;
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.fillText(text, size / 2, c.height / 2);
  return trimToPng(c);
}

async function renderImported(file, removeBackground) {
  const bitmap = await createImageBitmap(file);
  const max = 1600;
  const k = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bitmap.width * k);
  c.height = Math.round(bitmap.height * k);
  const ctx = c.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, c.width, c.height);
  if (removeBackground) {
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      // Paper turns transparent, ink stays, with a soft ramp in between.
      const a = lum >= 225 ? 0 : lum <= 160 ? 1 : (225 - lum) / 65;
      d[i + 3] = Math.round(d[i + 3] * a);
    }
    ctx.putImageData(img, 0, 0);
  }
  return trimToPng(c);
}

let dialog;
let pad;

function build() {
  dialog = document.createElement("dialog");
  dialog.className = "sig-dialog";
  dialog.innerHTML = `
    <form method="dialog" class="sig-card">
      <header class="sig-head">
        <h2>Signature</h2>
        <button type="button" class="icon-btn" data-act="close" aria-label="Close">✕</button>
      </header>
      <section class="sig-saved" hidden>
        <h3>Saved</h3>
        <div class="sig-saved-list"></div>
      </section>
      <section class="sig-new">
        <h3 class="sig-new-title">New</h3>
        <div class="tabs" role="tablist">
          <button type="button" role="tab" data-tab="draw" aria-selected="true">Draw</button>
          <button type="button" role="tab" data-tab="type">Type</button>
          <button type="button" role="tab" data-tab="image">Image</button>
          <span class="tabs-spacer"></span>
          <span class="ink-pick" title="Ink colour">
            <button type="button" class="swatch" data-ink="black" style="--c:${INKS.black}" aria-label="Black ink" aria-pressed="true"></button>
            <button type="button" class="swatch" data-ink="blue" style="--c:${INKS.blue}" aria-label="Blue ink"></button>
          </span>
        </div>
        <div class="tab-panel" data-panel="draw">
          <canvas class="pad"></canvas>
          <div class="pad-line"></div>
          <div class="pad-actions">
            <span class="hint">Sign with your mouse, pen or finger</span>
            <button type="button" class="link-btn" data-act="pad-undo">Undo stroke</button>
            <button type="button" class="link-btn" data-act="pad-clear">Clear</button>
          </div>
        </div>
        <div class="tab-panel" data-panel="type" hidden>
          <input class="type-input" type="text" placeholder="Your name" autocomplete="name" spellcheck="false">
          <div class="font-list" role="radiogroup"></div>
        </div>
        <div class="tab-panel" data-panel="image" hidden>
          <label class="drop-img">
            <input type="file" accept="image/png,image/jpeg,image/webp" hidden>
            <span class="drop-img-text">Choose a photo or scan of your signature</span>
            <img alt="" hidden>
          </label>
          <label class="check"><input type="checkbox" class="rm-bg" checked> Remove white background</label>
        </div>
      </section>
      <footer class="sig-foot">
        <label class="check"><input type="checkbox" class="keep" checked> Save for next time</label>
        <span class="spacer"></span>
        <button type="button" class="btn" data-act="close">Cancel</button>
        <button type="button" class="btn primary" data-act="use">Use signature</button>
      </footer>
    </form>`;
  document.body.append(dialog);
  pad = new DrawPad(dialog.querySelector(".pad"));
}

/**
 * Open the dialog. Resolves with a PNG data URL, or null if cancelled.
 */
export function chooseSignature() {
  if (!dialog) build();
  const $ = (s) => dialog.querySelector(s);
  const $$ = (s) => [...dialog.querySelectorAll(s)];

  return new Promise((resolve) => {
    const ac = new AbortController();
    const on = (el, ev, fn) => el.addEventListener(ev, fn, { signal: ac.signal });
    let tab = "draw";
    let ink = "black";
    let font = SCRIPT_FONTS[0];
    let imported = null;
    let importFile = null;

    pad.clear();
    const done = (value) => {
      ac.abort();
      dialog.close();
      resolve(value);
    };

    const renderSaved = () => {
      const saved = loadSaved();
      $(".sig-saved").hidden = saved.length === 0;
      $(".sig-new-title").hidden = saved.length === 0;
      const list = $(".sig-saved-list");
      list.replaceChildren(
        ...saved.map((s) => {
          const item = document.createElement("div");
          item.className = "saved-item";
          item.innerHTML = `<button type="button" class="saved-use" title="Use this signature"><img alt="Saved signature"></button>
            <button type="button" class="saved-del" title="Delete" aria-label="Delete saved signature">✕</button>`;
          item.querySelector("img").src = s.src;
          item.querySelector(".saved-use").onclick = () => done(s.src);
          item.querySelector(".saved-del").onclick = () => {
            storeSaved(loadSaved().filter((x) => x.id !== s.id));
            renderSaved();
          };
          return item;
        }),
      );
    };

    const renderFonts = () => {
      const text = $(".type-input").value.trim() || "Your name";
      $(".font-list").replaceChildren(
        ...SCRIPT_FONTS.map((f) => {
          const b = document.createElement("button");
          b.type = "button";
          b.role = "radio";
          b.className = "font-opt";
          b.style.fontFamily = `"${f}", cursive`;
          b.style.color = INKS[ink];
          b.textContent = text;
          b.setAttribute("aria-checked", String(f === font));
          b.onclick = () => {
            font = f;
            renderFonts();
          };
          return b;
        }),
      );
    };

    const setTab = (t) => {
      tab = t;
      for (const b of $$("[data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === t));
      for (const p of $$("[data-panel]")) p.hidden = p.dataset.panel !== t;
      $(".ink-pick").style.visibility = t === "image" ? "hidden" : "visible";
      if (t === "draw") requestAnimationFrame(() => pad.render());
      if (t === "type") $(".type-input").focus();
    };

    const setInk = (k) => {
      ink = k;
      pad.color = INKS[k];
      pad.render();
      for (const b of $$("[data-ink]")) b.setAttribute("aria-pressed", String(b.dataset.ink === k));
      renderFonts();
    };

    const refreshImport = async () => {
      if (!importFile) return;
      imported = await renderImported(importFile, $(".rm-bg").checked);
      const img = $(".drop-img img");
      img.src = imported || "";
      img.hidden = !imported;
      $(".drop-img-text").hidden = !!imported;
    };

    for (const b of $$("[data-tab]")) on(b, "click", () => setTab(b.dataset.tab));
    for (const b of $$("[data-ink]")) on(b, "click", () => setInk(b.dataset.ink));
    for (const b of $$("[data-act=close]")) on(b, "click", () => done(null));
    on($("[data-act=pad-clear]"), "click", () => pad.clear());
    on($("[data-act=pad-undo]"), "click", () => pad.undo());
    on($(".type-input"), "input", renderFonts);
    on($(".type-input"), "keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        $("[data-act=use]").click();
      }
    });
    on($(".drop-img input"), "change", (e) => {
      importFile = e.target.files[0] || null;
      refreshImport();
    });
    on($(".rm-bg"), "change", refreshImport);
    on(dialog, "cancel", (e) => {
      e.preventDefault();
      done(null);
    });
    on($("[data-act=use]"), "click", () => {
      let src = null;
      if (tab === "draw") src = pad.isEmpty ? null : pad.export();
      else if (tab === "type") {
        const text = $(".type-input").value.trim();
        src = text ? renderTyped(text, font, INKS[ink]) : null;
      } else src = imported;
      if (!src) {
        const target = { draw: ".pad", type: ".type-input", image: ".drop-img" }[tab];
        $(target).animate([{ outlineColor: "#c0392b" }, { outlineColor: "transparent" }], 700);
        return;
      }
      if ($(".keep").checked) {
        const saved = loadSaved();
        saved.unshift({ id: crypto.randomUUID(), src, created: Date.now() });
        storeSaved(saved.slice(0, 8));
      }
      done(src);
    });

    // Reset the "new" panel each time.
    $(".type-input").value = "";
    $(".drop-img img").hidden = true;
    $(".drop-img-text").hidden = false;
    $(".drop-img input").value = "";
    setInk("black");
    renderSaved();
    dialog.showModal();
    setTab("draw");
  });
}
