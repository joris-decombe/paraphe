// Finds the places on a flat PDF page where a person would write, without
// running anything from the file: only the page's text and its drawing
// instructions are read. A "spot" is a rectangle in display points (the same
// space as the placed items: scale 1, y down, page rotation applied):
//
//   line   a ruled line or a run of underscores/dots after a label
//   box    an empty rectangle big enough to hold a few words
//   check  a small empty square
//
// This is a heuristic: it is good on clean forms and will miss or invent
// a few spots on dense ones. The caller shows spots as hints; nothing is
// written to the PDF until the person clicks one.

const LEADER = /_{3,}|\.{4,}|…{2,}|\.( \.){3,}/g;
const MAX_SPOTS = 400;

const area = (r) => r.w * r.h;
function overlap(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}
const xOverlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));

/** Multiply two PDF matrices: apply `a`, then `b`. */
function mul(a, b) {
  return [
    a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
  ];
}

/** Text items as display-space boxes; leader runs are split out as `runs`. */
function readText(content, viewport) {
  const words = [];
  const runs = [];
  for (const it of content.items) {
    if (!it.str || !it.str.trim()) continue;
    const [a, b, c, d, e, f] = it.transform;
    const lu = Math.hypot(a, b);
    const lv = Math.hypot(c, d);
    if (!lu || !lv || !it.width) continue;
    // Corners of the text run, in the page's own space and then as displayed.
    const h = it.height || lv;
    const [x1, y1] = viewport.convertToViewportPoint(e, f);
    const [x2, y2] = viewport.convertToViewportPoint(e + (a / lu) * it.width + (c / lv) * h, f + (b / lu) * it.width + (d / lv) * h);
    const [ux, uy] = viewport.convertToViewportPoint(e + a / lu, f + b / lu);
    // Only text that reads left to right as displayed can label a field.
    if (ux - x1 < 0.9 || Math.abs(uy - y1) > 0.1) continue;
    const box = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
    if (!box.w || !box.h) continue;
    const per = box.w / it.str.length;
    const rest = it.str.replace(LEADER, "").trim();
    for (const m of it.str.matchAll(LEADER)) {
      runs.push({ x: box.x + m.index * per, y: box.y, w: m[0].length * per, h: box.h });
    }
    if (rest) words.push({ ...box, text: rest });
  }
  return { words, runs };
}

/** Rectangles and horizontal lines that the page draws (strokes, and hairline fills). */
function readShapes(list, viewport, OPS) {
  const rects = [];
  const lines = [];
  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const toDisplay = (x, y) => viewport.convertToViewportPoint(x * ctm[0] + y * ctm[2] + ctm[4], x * ctm[1] + y * ctm[3] + ctm[5]);
  const STROKE = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const FILL = new Set([OPS.fill, OPS.eoFill]);

  function addPath(data, painted) {
    const subs = [];
    let cur = null;
    for (let i = 0; i < data.length; ) {
      const op = data[i++];
      if (op === 0) { // moveTo
        cur = [toDisplay(data[i], data[i + 1])];
        subs.push(cur);
        i += 2;
      } else if (op === 1) { // lineTo
        cur?.push(toDisplay(data[i], data[i + 1]));
        i += 2;
      } else if (op === 2) { // curveTo: a curve is never a ruled line or a box
        cur = null;
        i += 6;
      } else if (op === 3) { // quadratic curve
        cur = null;
        i += 4;
      } else if (op === 4) { // close
        if (cur && cur.length >= 2) cur.push(cur[0]);
      } else {
        return;
      }
    }
    for (const pts of subs) {
      if (!pts || pts.length < 2) continue;
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const r = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
      const flat = pts.every((p) => Math.abs(p[1] - pts[0][1]) < 0.6);
      const axisAligned = pts.every((p) => (Math.abs(p[0] - r.x) < 0.6 || Math.abs(p[0] - r.x - r.w) < 0.6) && (Math.abs(p[1] - r.y) < 0.6 || Math.abs(p[1] - r.y - r.h) < 0.6));
      if (flat && r.w > 0) {
        if (painted === "stroke") lines.push({ x: r.x, y: pts[0][1], w: r.w });
      } else if (axisAligned && pts.length >= 4 && r.w > 0 && r.h > 0) {
        if (painted === "stroke") rects.push(r);
        else if (r.h < 1.6) lines.push({ x: r.x, y: r.y + r.h / 2, w: r.w }); // hairline filled rectangle
      }
    }
  }

  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    const args = list.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = mul(args, ctm);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (args?.[0]) ctm = mul(args[0], ctm);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === OPS.constructPath) {
      const paint = args[0];
      const painted = STROKE.has(paint) ? "stroke" : FILL.has(paint) ? "fill" : null;
      if (painted) for (const data of args[1]) addPath(data, painted);
    }
  }
  return { rects, lines };
}

/**
 * @param page      a pdf.js page proxy
 * @param OPS       pdfjsLib.OPS
 * @param widgets   display-space boxes of the form fields the page already has
 * @returns spots, top to bottom
 */
export async function detectSpots(page, OPS, widgets = []) {
  const viewport = page.getViewport({ scale: 1 });
  const [content, list] = await Promise.all([page.getTextContent(), page.getOperatorList()]);
  const { words, runs } = readText(content, viewport);
  const { rects, lines } = readShapes(list, viewport, OPS);
  const spots = [];
  const taken = (r) => widgets.some((w) => overlap(w, r) > 0.3 * Math.min(area(w), area(r)));
  const add = (spot) => {
    if (taken(spot)) return;
    if (spots.some((s) => overlap(s, spot) > 0.5 * Math.min(area(s), area(spot)))) return;
    spots.push(spot);
  };

  // Checkboxes: small, squarish, empty.
  const boxes = [];
  for (const r of rects) {
    if (r.w >= 6 && r.w <= 18 && r.h >= 6 && r.h <= 18 && Math.abs(r.w - r.h) <= 3) {
      if (!words.some((w) => overlap(w, r) > 0.3 * area(r))) add({ kind: "check", x: r.x, y: r.y, w: r.w, h: r.h });
    } else if (r.w >= 24 && r.h >= 10 && r.h <= 50 && r.w <= viewport.width * 0.9) {
      boxes.push(r);
    }
  }

  // Text boxes: empty rectangles.
  for (const r of boxes) {
    if (!words.some((w) => overlap(w, r) > 0.2 * area(w))) add({ kind: "box", x: r.x, y: r.y, w: r.w, h: r.h });
  }

  const fieldHeight = (ref) => Math.min(Math.max(ref, 9), 18);

  // Leader runs (underscores, dots): the text goes just above the baseline.
  for (const r of runs) {
    if (r.w < 20) continue;
    add({ kind: "line", x: r.x, y: r.y, w: r.w, h: r.h });
  }

  // Ruled lines that have a label next to them and nothing written on them.
  for (const l of lines) {
    if (l.w < 36 || l.w > viewport.width * 0.85) continue;
    const seg = { x: l.x, y: l.y - 12, w: l.w, h: 12 };
    let labelled = false;
    let written = false;
    for (const w of words) {
      const base = w.y + w.h; // baseline, roughly
      const onLine = base >= l.y - 6 && base <= l.y + 1;
      if (onLine && xOverlap(w, seg) >= 20) {
        written = true; // text already sits on this line
        continue;
      }
      const left = w.x + w.w <= l.x + 4 && w.x + w.w >= l.x - 60 && base >= l.y - 14 && base <= l.y + 4;
      const above = base < l.y - 5 && base >= l.y - 18 && w.x >= l.x - 6 && w.x <= l.x + 40;
      const below = w.y > l.y && w.y <= l.y + 12 && xOverlap(w, seg) > 0.2 * w.w;
      if (left || above || below) labelled = true;
    }
    if (labelled && !written) {
      const h = fieldHeight(12);
      add({ kind: "line", x: l.x, y: l.y - h - 1, w: l.w, h });
    }
  }

  spots.sort((a, b) => a.y - b.y || a.x - b.x);
  return spots.slice(0, MAX_SPOTS);
}
