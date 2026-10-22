/*
  Toolairy PDF Editor. Runs 100% in the browser.

  How it works
  - pdf.js draws each page; a second canvas on top shows the annotations.
  - Annotations are stored in "base space": points, origin top-left, y down,
    for the page as it is normally displayed (with its own built-in rotation).
  - On download, annotations are drawn on a transparent canvas and placed on the page
    with pdf-lib (standard mode), or everything is flattened to images.
*/
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { PDFDocument, degrees } from "pdf-lib";
import JSZip from "jszip";
import "@fontsource-variable/caveat";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/* ---------------------------------------------------------------- constants */
const CSS_PER_PT = 96 / 72;
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const MAX_PIXELS = 16e6;
const MAX_EXPORT_PIXELS = 30e6;
const THUMB_W = 110;

const FONTS = {
  Helvetica: 'Helvetica, Arial, "Segoe UI", sans-serif',
  Times: '"Times New Roman", Times, serif',
  Courier: '"Courier New", Courier, monospace',
  Handwriting: '"Caveat Variable", "Segoe Script", cursive',
};
const STAMPS = {
  approved: { text: "APPROVED", color: "#2b8a3e" },
  confidential: { text: "CONFIDENTIAL", color: "#c92a2a" },
  draft: { text: "DRAFT", color: "#1971c2" },
  rejected: { text: "REJECTED", color: "#c92a2a" },
  paid: { text: "PAID", color: "#2b8a3e" },
  copy: { text: "COPY", color: "#862e9c" },
};
const BOX = new Set(["rect", "ellipse", "white", "redact", "image"]);
const HINTS = {
  select: "Click an item to select, move, or resize it. Press Delete to remove it.",
  edittext: "Click a word or line of text in the PDF. It is covered and replaced with text you can edit.",
  text: "Click on the page to place text.",
  stamp: "Choose a stamp in the right panel, then click on the page.",
  pen: "Draw freehand on the page.",
  hl: "Drag over text to highlight it.",
  rect: "Drag on the page to draw a rectangle.",
  ellipse: "Drag on the page to draw an ellipse.",
  line: "Drag on the page to draw a line.",
  arrow: "Drag on the page to draw an arrow.",
  white: "Drag over an area to cover it with white.",
  redact: "Drag over an area to cover it with black. Download as flattened pages to remove the text underneath.",
};
const SHOW = {
  pen: ["color", "sw", "opacity"],
  hl: ["color", "sw", "opacity"],
  rect: ["color", "sw", "opacity", "fill"],
  ellipse: ["color", "sw", "opacity", "fill"],
  line: ["color", "sw", "opacity"],
  arrow: ["color", "sw", "opacity"],
  text: ["color", "opacity", "font", "size", "style", "border"],
  stamp: ["stamp", "size", "opacity"],
  image: ["opacity"],
};
// Default settings per tool (edited through the right-hand panel)
const D = {
  pen: { color: "#1d4ed8", sw: 3, opacity: 1 },
  hl: { color: "#ffd43b", sw: 16, opacity: 0.4 },
  rect: { color: "#e03131", sw: 3, opacity: 1, fill: false },
  ellipse: { color: "#e03131", sw: 3, opacity: 1, fill: false },
  line: { color: "#e03131", sw: 3, opacity: 1 },
  arrow: { color: "#e03131", sw: 3, opacity: 1 },
  text: { color: "#111827", opacity: 1, font: "Helvetica", size: 18, bold: false, italic: false, border: false },
  stamp: { stamp: "approved", size: 28, opacity: 1 },
  image: { opacity: 1 },
};

/* ------------------------------------------------------------------ helpers */
const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const tick = () => new Promise((r) => setTimeout(r, 0));
const canvasToBlob = (cv, type, q) =>
  new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error("Could not create the image."))), type, q));

const stage = $("pe-stage");
const pagesEl = $("pe-pages");
const thumbsEl = $("pe-thumbs");

let idSeq = 0;
const uid = () => "i" + ++idSeq;

function setStatus(msg, bad = false) {
  const el = $("pe-status");
  el.textContent = msg || "";
  el.classList.toggle("pe-bad", bad);
}

function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* -------------------------------------------------------------------- state */
let sources = []; // { bytes, lib (pdf-lib doc), doc (pdf.js doc), pages: Map }
let entries = []; // working pages: { id, src, pn, rot, annots, x0, y0, w, h, R0 }
let hist = [];
let hi = -1;
let tool = "select";
let sel = null; // { eid, aid }
let zoom = 1;
let fitMode = false;
let cur = 0;
let dirty = false;
let docName = "document";
let drag = null;
let dragFrom = -1;

const views = new Map();
const thumbs = new Map();
const imgCache = new Map();
const mctx = document.createElement("canvas").getContext("2d");

/* ----------------------------------------------------------------- geometry */
// e.w / e.h / e.R0 describe the raw page (size and built-in rotation).
// e.rot is the extra rotation the user applied.
function dims(e) {
  const swap = e.R0 % 180 !== 0;
  const W0 = swap ? e.h : e.w;
  const H0 = swap ? e.w : e.h;
  const turn = e.rot % 180 !== 0;
  return { W0, H0, dw: turn ? H0 : W0, dh: turn ? W0 : H0 };
}
// Canvas transform that maps a W x H space (top-left origin) rotated clockwise by rot
function mat(rot, W, H, s) {
  if (rot === 90) return [0, s, -s, 0, H * s, 0];
  if (rot === 180) return [-s, 0, 0, -s, W * s, H * s];
  if (rot === 270) return [0, -s, s, 0, 0, W * s];
  return [s, 0, 0, s, 0, 0];
}
// Inverse: displayed point (u, v) back to base space
function toBase(rot, W, H, u, v) {
  if (rot === 90) return [v, H - u];
  if (rot === 180) return [W - u, H - v];
  if (rot === 270) return [W - v, u];
  return [u, v];
}
const cssScale = () => zoom * CSS_PER_PT;
function pixelScale(e) {
  const { dw, dh } = dims(e);
  const want = cssScale() * Math.min(window.devicePixelRatio || 1, 2);
  return Math.min(want, Math.sqrt(MAX_PIXELS / (dw * dh)));
}
const capScale = (k, w, h) => Math.min(k, Math.sqrt(MAX_EXPORT_PIXELS / (w * h)));

/* ------------------------------------------------------------ annotations */
const cloneAnnot = (a) => ({ ...a, pts: a.pts ? a.pts.slice() : undefined });
const cloneEntries = (list) => list.map((e) => ({ ...e, annots: e.annots.map(cloneAnnot) }));

function fontStr(a) {
  return (a.italic ? "italic " : "") + (a.bold ? "bold " : "") + a.size + "px " + (FONTS[a.font] || FONTS.Helvetica);
}
function measure(a) {
  mctx.font = fontStr(a);
  const lines = String(a.text || "").split("\n");
  let w = 0;
  for (const l of lines) w = Math.max(w, mctx.measureText(l).width);
  const lh = a.size * 1.25;
  const pad = a.border ? a.size * 0.4 : 0;
  return { w: w + pad * 2, h: lines.length * lh + pad * 2, lh, pad, lines };
}
function bounds(a) {
  if (a.type === "text") {
    const m = measure(a);
    return { x: a.x, y: a.y, w: m.w, h: m.h };
  }
  if (a.pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < a.pts.length; i += 2) {
      x0 = Math.min(x0, a.pts[i]); x1 = Math.max(x1, a.pts[i]);
      y0 = Math.min(y0, a.pts[i + 1]); y1 = Math.max(y1, a.pts[i + 1]);
    }
    const r = (a.sw || 1) / 2;
    return { x: x0 - r, y: y0 - r, w: x1 - x0 + 2 * r, h: y1 - y0 + 2 * r };
  }
  if (a.type === "line" || a.type === "arrow") {
    return { x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2), w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
  }
  return { x: a.x, y: a.y, w: a.w, h: a.h };
}

function drawAnnot(ctx, a) {
  ctx.save();
  ctx.globalAlpha = a.opacity == null ? 1 : a.opacity;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = a.color;
  ctx.fillStyle = a.color;
  ctx.lineWidth = a.sw || 1;
  switch (a.type) {
    case "pen":
    case "hl": {
      const p = a.pts;
      ctx.beginPath();
      ctx.moveTo(p[0], p[1]);
      if (p.length <= 4) ctx.lineTo(p[2] + 0.01, p[3]);
      else {
        for (let i = 2; i < p.length - 2; i += 2) {
          ctx.quadraticCurveTo(p[i], p[i + 1], (p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2);
        }
        ctx.lineTo(p[p.length - 2], p[p.length - 1]);
      }
      ctx.stroke();
      break;
    }
    case "rect":
    case "white":
    case "redact":
      if (a.fill || a.type !== "rect") ctx.fillRect(a.x, a.y, a.w, a.h);
      else ctx.strokeRect(a.x, a.y, a.w, a.h);
      break;
    case "ellipse":
      ctx.beginPath();
      ctx.ellipse(a.x + a.w / 2, a.y + a.h / 2, Math.abs(a.w / 2), Math.abs(a.h / 2), 0, 0, Math.PI * 2);
      if (a.fill) ctx.fill();
      else ctx.stroke();
      break;
    case "line":
    case "arrow": {
      ctx.beginPath();
      ctx.moveTo(a.x1, a.y1);
      ctx.lineTo(a.x2, a.y2);
      ctx.stroke();
      if (a.type === "arrow") {
        const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
        const len = Math.max(10, a.sw * 4);
        ctx.beginPath();
        ctx.moveTo(a.x2, a.y2);
        ctx.lineTo(a.x2 - len * Math.cos(ang - Math.PI / 7), a.y2 - len * Math.sin(ang - Math.PI / 7));
        ctx.moveTo(a.x2, a.y2);
        ctx.lineTo(a.x2 - len * Math.cos(ang + Math.PI / 7), a.y2 - len * Math.sin(ang + Math.PI / 7));
        ctx.stroke();
      }
      break;
    }
    case "text": {
      const m = measure(a);
      ctx.font = fontStr(a);
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      if (a.border) {
        const lw = Math.max(1, a.size * 0.1);
        ctx.lineWidth = lw;
        ctx.strokeRect(a.x + lw / 2, a.y + lw / 2, m.w - lw, m.h - lw);
      }
      m.lines.forEach((l, i) => ctx.fillText(l, a.x + m.pad, a.y + m.pad + i * m.lh));
      break;
    }
    case "image": {
      const img = imgCache.get(a.imgKey);
      if (img) ctx.drawImage(img, a.x, a.y, a.w, a.h);
      break;
    }
  }
  ctx.restore();
}

function drawWatermark(ctx, W, H, wm) {
  ctx.save();
  ctx.globalAlpha = wm.opacity;
  ctx.fillStyle = wm.color;
  ctx.translate(W / 2, H / 2);
  ctx.rotate(-Math.atan2(H, W));
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  let size = Math.min(W, H) / 6;
  ctx.font = "bold " + size + "px " + FONTS.Helvetica;
  const tw = ctx.measureText(wm.text).width;
  const max = Math.hypot(W, H) * 0.7;
  if (tw > max) {
    size *= max / tw;
    ctx.font = "bold " + size + "px " + FONTS.Helvetica;
  }
  ctx.fillText(wm.text, 0, 0);
  ctx.restore();
}

function paintAnnots(ctx, e, W0, H0, wm) {
  for (const a of e.annots) drawAnnot(ctx, a);
  if (wm && wm.text) drawWatermark(ctx, W0, H0, wm);
}

/* hit testing */
function distSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - x1) * dx + (py - y1) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
function hitTest(a, x, y, tol) {
  if (a.pts) {
    for (let i = 0; i < a.pts.length - 2; i += 2) {
      if (distSeg(x, y, a.pts[i], a.pts[i + 1], a.pts[i + 2], a.pts[i + 3]) <= tol + a.sw / 2) return true;
    }
    return false;
  }
  if (a.type === "line" || a.type === "arrow") return distSeg(x, y, a.x1, a.y1, a.x2, a.y2) <= tol + a.sw / 2;
  const b = bounds(a);
  return x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol;
}
function handlePoints(a) {
  if (a.type === "line" || a.type === "arrow") return [[a.x1, a.y1], [a.x2, a.y2]];
  if (BOX.has(a.type)) return [[a.x, a.y], [a.x + a.w, a.y], [a.x + a.w, a.y + a.h], [a.x, a.y + a.h]];
  return [];
}
function hitHandle(a, x, y, tol) {
  const pts = handlePoints(a);
  for (let i = 0; i < pts.length; i++) {
    if (Math.abs(x - pts[i][0]) <= tol && Math.abs(y - pts[i][1]) <= tol) return i;
  }
  return -1;
}
function applyMove(a, o, dx, dy) {
  if (a.pts) a.pts = o.pts.map((v, i) => v + (i % 2 ? dy : dx));
  else if (a.type === "line" || a.type === "arrow") {
    a.x1 = o.x1 + dx; a.y1 = o.y1 + dy; a.x2 = o.x2 + dx; a.y2 = o.y2 + dy;
  } else {
    a.x = o.x + dx; a.y = o.y + dy;
  }
}
function applyHandle(a, o, h, x, y) {
  if (a.type === "line" || a.type === "arrow") {
    if (h === 0) { a.x1 = x; a.y1 = y; } else { a.x2 = x; a.y2 = y; }
    return;
  }
  const opp = [[o.x + o.w, o.y + o.h], [o.x, o.y + o.h], [o.x, o.y], [o.x + o.w, o.y]][h];
  let nw = Math.max(Math.abs(x - opp[0]), 4);
  let nh = Math.max(Math.abs(y - opp[1]), 4);
  let nx = x < opp[0] ? opp[0] - nw : opp[0];
  let ny = y < opp[1] ? opp[1] - nh : opp[1];
  if (a.type === "image") {
    nh = nw / (o.w / o.h);
    ny = y < opp[1] ? opp[1] - nh : opp[1];
  }
  a.x = nx; a.y = ny; a.w = nw; a.h = nh;
}
function drawSelection(ctx, a, px) {
  const b = bounds(a);
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "#3b82f6";
  ctx.lineWidth = 1.5 * px;
  if (a.type !== "line" && a.type !== "arrow") {
    ctx.setLineDash([5 * px, 4 * px]);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.setLineDash([]);
  }
  const hs = 5 * px;
  handlePoints(a).forEach(([x, y]) => {
    ctx.fillStyle = "#fff";
    ctx.fillRect(x - hs, y - hs, hs * 2, hs * 2);
    ctx.strokeRect(x - hs, y - hs, hs * 2, hs * 2);
  });
  ctx.restore();
}

/* ------------------------------------------------------------ render queue */
let chain = Promise.resolve();
function enqueue(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}
function getPageProxy(e) {
  const s = sources[e.src];
  if (!s.pages.has(e.pn)) s.pages.set(e.pn, s.doc.getPage(e.pn));
  return s.pages.get(e.pn);
}

/* ------------------------------------------------------------ page views */
const io = new IntersectionObserver(
  (list) => {
    for (const it of list) {
      const v = it.target._v;
      if (!v) continue;
      v.visible = it.isIntersecting;
      if (v.visible) { ensureRendered(v); drawOverlay(v); } else releaseView(v);
    }
  },
  { root: stage, rootMargin: "700px 0px" }
);
const tio = new IntersectionObserver(
  (list) => {
    for (const it of list) {
      const t = it.target._t;
      if (!t) continue;
      t.visible = it.isIntersecting;
      if (t.visible) renderThumb(t);
      else { t.key = ""; t.canvas.width = 0; t.canvas.height = 0; }
    }
  },
  { root: thumbsEl, rootMargin: "400px 400px" }
);

function createView(e) {
  const el = document.createElement("div");
  el.className = "pe-page";
  const pdfCanvas = document.createElement("canvas");
  pdfCanvas.className = "pe-pdf";
  const ov = document.createElement("canvas");
  ov.className = "pe-ov";
  const num = document.createElement("span");
  num.className = "pe-pnum";
  el.append(pdfCanvas, ov, num);
  const v = { entry: e, el, pdfCanvas, ov, num, key: "", visible: false, index: 0, raf: 0 };
  el._v = v;
  ov.addEventListener("pointerdown", (ev) => onDown(v, ev));
  ov.addEventListener("pointermove", (ev) => onMove(v, ev));
  ov.addEventListener("pointerup", (ev) => onUp(v, ev));
  ov.addEventListener("pointercancel", (ev) => onUp(v, ev));
  ov.addEventListener("dblclick", () => {
    const a = selAnnot();
    if (a && a.type === "text") { $("pe-text").focus(); $("pe-text").select(); }
  });
  return v;
}

function layoutView(v) {
  const e = v.entry;
  const { dw, dh } = dims(e);
  const s = cssScale();
  v.el.style.width = dw * s + "px";
  v.el.style.height = dh * s + "px";
  v.num.textContent = v.index + 1;
  if (v.visible) { ensureRendered(v); drawOverlay(v); }
}

function releaseView(v) {
  v.key = "";
  v.pdfCanvas.width = 0; v.pdfCanvas.height = 0;
  v.ov.width = 0; v.ov.height = 0;
}

function ensureRendered(v) {
  const e = v.entry;
  const k = pixelScale(e);
  const key = [e.src, e.pn, e.R0, e.rot, k.toFixed(3)].join("|");
  if (v.key === key) return;
  v.key = key;
  if (e.src === null) { v.pdfCanvas.width = 0; v.pdfCanvas.height = 0; return; } // blank page
  enqueue(async () => {
    if (v.key !== key || !v.visible) { if (v.key === key) v.key = ""; return; }
    const page = await getPageProxy(e);
    const vp = page.getViewport({ scale: k, rotation: (e.R0 + e.rot) % 360 });
    const off = document.createElement("canvas");
    off.width = Math.ceil(vp.width);
    off.height = Math.ceil(vp.height);
    await page.render({ canvasContext: off.getContext("2d"), viewport: vp }).promise;
    if (v.key !== key) return;
    const cv = v.pdfCanvas;
    cv.width = off.width;
    cv.height = off.height;
    cv.getContext("2d").drawImage(off, 0, 0);
  }).catch((err) => {
    if (v.key === key) v.key = "";
    console.warn(err);
  });
}

function drawOverlay(v) {
  if (!v.visible) return;
  const e = v.entry;
  const { W0, H0, dw, dh } = dims(e);
  const k = pixelScale(e);
  const pw = Math.ceil(dw * k), ph = Math.ceil(dh * k);
  const cv = v.ov;
  if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
  const ctx = cv.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, pw, ph);
  ctx.setTransform(...mat(e.rot, W0, H0, k));
  for (const a of e.annots) drawAnnot(ctx, a);
  if (sel && sel.eid === e.id) {
    const a = e.annots.find((x) => x.id === sel.aid);
    if (a) drawSelection(ctx, a, 1 / cssScale());
  }
}
function scheduleOverlay(v) {
  if (!v || v.raf) return;
  v.raf = requestAnimationFrame(() => { v.raf = 0; drawOverlay(v); });
}
const redrawEntry = (eid) => { const v = views.get(eid); if (v) drawOverlay(v); };

/* ------------------------------------------------------------- thumbnails */
function createThumb(e) {
  const el = document.createElement("div");
  el.className = "pe-thumb";
  el.draggable = true;
  const canvas = document.createElement("canvas");
  const lab = document.createElement("div");
  el.append(canvas, lab);
  const t = { entry: e, el, canvas, lab, key: "", visible: false, index: 0 };
  el._t = t;
  el.addEventListener("click", () => goToPage(t.index));
  el.addEventListener("dragstart", (ev) => {
    dragFrom = t.index;
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", String(t.index));
  });
  el.addEventListener("dragover", (ev) => {
    if (dragFrom < 0) return;
    ev.preventDefault();
    el.classList.add("pe-over");
  });
  el.addEventListener("dragleave", () => el.classList.remove("pe-over"));
  el.addEventListener("drop", (ev) => {
    ev.preventDefault();
    el.classList.remove("pe-over");
    if (dragFrom >= 0 && dragFrom !== t.index) movePage(dragFrom, t.index);
    dragFrom = -1;
  });
  el.addEventListener("dragend", () => { dragFrom = -1; });
  return t;
}
function layoutThumb(t) {
  const { dw, dh } = dims(t.entry);
  t.canvas.style.width = THUMB_W + "px";
  t.canvas.style.height = (THUMB_W * dh) / dw + "px";
  t.lab.textContent = t.index + 1;
  if (t.visible) renderThumb(t);
}
function renderThumb(t) {
  const e = t.entry;
  const key = [e.src, e.pn, e.R0, e.rot].join("|");
  if (t.key === key) return;
  t.key = key;
  enqueue(async () => {
    if (t.key !== key || !t.visible) { if (t.key === key) t.key = ""; return; }
    const { dw, dh } = dims(e);
    const k = (THUMB_W * Math.min(window.devicePixelRatio || 1, 2)) / dw;
    const cv = t.canvas;
    if (e.src === null) {
      cv.width = Math.ceil(dw * k); cv.height = Math.ceil(dh * k);
      const c = cv.getContext("2d"); c.fillStyle = "#fff"; c.fillRect(0, 0, cv.width, cv.height);
      return;
    }
    const page = await getPageProxy(e);
    const vp = page.getViewport({ scale: k, rotation: (e.R0 + e.rot) % 360 });
    const off = document.createElement("canvas");
    off.width = Math.ceil(vp.width); off.height = Math.ceil(vp.height);
    await page.render({ canvasContext: off.getContext("2d"), viewport: vp }).promise;
    if (t.key !== key) return;
    cv.width = off.width; cv.height = off.height;
    cv.getContext("2d").drawImage(off, 0, 0);
  }).catch((err) => {
    if (t.key === key) t.key = "";
    console.warn(err);
  });
}

/* ---------------------------------------------------------------- syncing */
function syncAll() {
  const seen = new Set();
  entries.forEach((e, i) => {
    let v = views.get(e.id);
    if (!v) { v = createView(e); views.set(e.id, v); io.observe(v.el); }
    v.entry = e;
    v.index = i;
    seen.add(e.id);
  });
  for (const [id, v] of views) {
    if (!seen.has(id)) { io.unobserve(v.el); v.el.remove(); views.delete(id); }
  }
  entries.forEach((e, i) => {
    const el = views.get(e.id).el;
    if (pagesEl.children[i] !== el) pagesEl.insertBefore(el, pagesEl.children[i] || null);
  });
  entries.forEach((e) => layoutView(views.get(e.id)));

  const seenT = new Set();
  entries.forEach((e, i) => {
    let t = thumbs.get(e.id);
    if (!t) { t = createThumb(e); thumbs.set(e.id, t); tio.observe(t.el); }
    t.entry = e;
    t.index = i;
    seenT.add(e.id);
  });
  for (const [id, t] of thumbs) {
    if (!seenT.has(id)) { tio.unobserve(t.el); t.el.remove(); thumbs.delete(id); }
  }
  entries.forEach((e, i) => {
    const el = thumbs.get(e.id).el;
    if (thumbsEl.children[i] !== el) thumbsEl.insertBefore(el, thumbsEl.children[i] || null);
  });
  entries.forEach((e) => layoutThumb(thumbs.get(e.id)));

  cur = clamp(cur, 0, Math.max(0, entries.length - 1));
  highlightThumb();
  updateUi();
}

function highlightThumb() {
  entries.forEach((e, i) => {
    const t = thumbs.get(e.id);
    if (t) t.el.classList.toggle("pe-cur", i === cur);
  });
  const t = entries[cur] && thumbs.get(entries[cur].id);
  if (t) {
    const top = t.el.offsetTop, bottom = top + t.el.offsetHeight;
    if (top < thumbsEl.scrollTop) thumbsEl.scrollTop = top - 8;
    else if (bottom > thumbsEl.scrollTop + thumbsEl.clientHeight) thumbsEl.scrollTop = bottom - thumbsEl.clientHeight + 8;
  }
}
function setCur(i) {
  if (i === cur) return;
  cur = i;
  highlightThumb();
  $("pe-pageinfo").textContent = entries.length ? "Page " + (cur + 1) + " of " + entries.length : "No file open";
}
function goToPage(i) {
  const e = entries[i];
  if (!e) return;
  const v = views.get(e.id);
  stage.scrollTo({ top: v.el.offsetTop - 12, behavior: "smooth" });
  setCur(i);
}
function updateCurrent() {
  const mid = stage.scrollTop + stage.clientHeight * 0.4;
  const kids = pagesEl.children;
  let best = 0;
  for (let i = 0; i < kids.length; i++) {
    if (kids[i].offsetTop <= mid) best = i; else break;
  }
  setCur(best);
}
let scrollRaf = 0;
stage.addEventListener("scroll", () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updateCurrent(); });
});

function updateUi() {
  const has = entries.length > 0;
  $$("[data-needs-doc]").forEach((b) => { b.disabled = !has; });
  $("pe-undo").disabled = !(hi > 0);
  $("pe-redo").disabled = !(hi >= 0 && hi < hist.length - 1);
  $("pe-pageinfo").textContent = has ? "Page " + (cur + 1) + " of " + entries.length : "No file open";
  $("pe-empty").hidden = has;
  pagesEl.hidden = !has;
  stage.dataset.tool = tool;
  updateZoomUi();
}

/* ------------------------------------------------------------------ history */
function commit() {
  hist = hist.slice(0, hi + 1);
  hist.push(cloneEntries(entries));
  if (hist.length > 80) hist.shift();
  hi = hist.length - 1;
  dirty = true;
  updateUi();
}
function afterHistory() {
  if (sel && !selAnnot()) sel = null;
  dirty = true;
  syncAll();
  refreshInspector();
}
function undo() {
  if (hi <= 0) return;
  hi--;
  entries = cloneEntries(hist[hi]);
  afterHistory();
}
function redo() {
  if (hi >= hist.length - 1) return;
  hi++;
  entries = cloneEntries(hist[hi]);
  afterHistory();
}

/* -------------------------------------------------------------------- zoom */
function fitZoom() {
  const maxW = Math.max(1, ...entries.map((e) => dims(e).dw));
  return clamp((stage.clientWidth - 44) / (maxW * CSS_PER_PT), 0.2, 4);
}
function updateZoomUi() {
  const s = $("pe-zoom");
  const custom = $("pe-zcustom");
  const key = String(zoom);
  const known = ZOOMS.some((z) => String(z) === key);
  if (fitMode) s.value = "fit";
  else if (known) s.value = key;
  else {
    custom.textContent = Math.round(zoom * 100) + "%";
    custom.hidden = false;
    s.value = "custom";
  }
}
function setZoom(z, auto = false) {
  const ratio = stage.scrollHeight ? stage.scrollTop / stage.scrollHeight : 0;
  zoom = clamp(z, 0.2, 4);
  if (!auto) fitMode = false;
  entries.forEach((e) => layoutView(views.get(e.id)));
  stage.scrollTop = ratio * stage.scrollHeight;
  updateZoomUi();
}
$("pe-zin").addEventListener("click", () => {
  const next = ZOOMS.find((z) => z > zoom + 0.001);
  if (next) setZoom(next);
});
$("pe-zout").addEventListener("click", () => {
  const prev = [...ZOOMS].reverse().find((z) => z < zoom - 0.001);
  if (prev) setZoom(prev);
});
$("pe-zoom").addEventListener("change", (ev) => {
  const val = ev.target.value;
  if (val === "fit") { fitMode = true; setZoom(fitZoom(), true); }
  else if (val !== "custom") setZoom(+val);
});
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (fitMode && entries.length) setZoom(fitZoom(), true); }, 200);
});

/* ---------------------------------------------------------------- opening */
const isPdf = (f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);
const isImage = (f) => /^image\//.test(f.type) || /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name);

async function imageToPdfBytes(file) {
  const pdf = await PDFDocument.create();
  let img;
  if (file.type === "image/jpeg") {
    img = await pdf.embedJpg(new Uint8Array(await file.arrayBuffer()));
  } else {
    const bmp = await createImageBitmap(file);
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    c.getContext("2d").drawImage(bmp, 0, 0);
    const blob = await canvasToBlob(c, "image/png");
    img = await pdf.embedPng(new Uint8Array(await blob.arrayBuffer()));
  }
  const s = Math.min(0.75, 842 / Math.max(img.width, img.height));
  const w = img.width * s, h = img.height * s;
  const page = pdf.addPage([w, h]);
  page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  return pdf.save();
}

async function readSource(bytes, idx, name) {
  const fail = () => new Error('"' + name + '" could not be opened. It may be password-protected or damaged.');
  let lib;
  try { lib = await PDFDocument.load(bytes, { updateMetadata: false }); } catch { throw fail(); }
  let doc;
  try { doc = await pdfjsLib.getDocument({ data: bytes.slice() }).promise; } catch { throw fail(); }
  const src = { bytes, lib, doc, pages: new Map() };
  const list = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const promise = doc.getPage(n);
    src.pages.set(n, promise);
    const p = await promise;
    const [x0, y0, x1, y1] = p.view;
    list.push({
      id: uid(), src: idx, pn: n, rot: 0, annots: [],
      x0, y0, w: x1 - x0, h: y1 - y0, R0: ((p.rotate % 360) + 360) % 360,
    });
    if (n % 25 === 0) { setStatus("Reading page " + n + " of " + doc.numPages + "..."); await tick(); }
  }
  return { src, list };
}

async function openFiles(fileList, append) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  if (!append && entries.length && dirty && !confirm("Open a new file? Your unsaved changes will be lost.")) return;
  setStatus("Opening...");
  const offset = append ? sources.length : 0;
  const newSources = [];
  const newEntries = [];
  try {
    for (const f of files) {
      let bytes;
      if (isPdf(f)) bytes = new Uint8Array(await f.arrayBuffer());
      else if (isImage(f)) bytes = await imageToPdfBytes(f);
      else throw new Error('"' + f.name + '" is not a PDF or a supported image (PNG, JPG, WebP, GIF).');
      const { src, list } = await readSource(bytes, offset + newSources.length, f.name);
      newSources.push(src);
      newEntries.push(...list);
    }
  } catch (err) {
    newSources.forEach((s) => s.doc.destroy());
    setStatus(err.message || "Could not open the file.", true);
    return;
  }

  if (append) {
    sources.push(...newSources);
    entries.push(...newEntries);
    commit();
    syncAll();
    setStatus(newEntries.length + " page(s) added at the end.");
  } else {
    sources.forEach((s) => s.doc.destroy());
    sources = newSources;
    entries = newEntries;
    docName = files[0].name.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|]/g, "_") || "document";
    hist = []; hi = -1; sel = null; cur = 0; fitMode = false;
    commit();
    dirty = false;
    zoom = clamp(Math.min(1.25, fitZoom()), 0.2, 4);
    syncAll();
    stage.scrollTop = 0;
    setStatus(HINTS.select);
    $("pe-fname").value = docName + "-edited";
  }
}

/* ------------------------------------------------------------- selection */
const findEntry = (id) => entries.find((e) => e.id === id);
function selAnnot() {
  if (!sel) return null;
  const e = findEntry(sel.eid);
  return e ? e.annots.find((a) => a.id === sel.aid) || null : null;
}
function select(eid, aid) {
  const prev = sel;
  sel = eid ? { eid, aid } : null;
  if (prev) redrawEntry(prev.eid);
  if (sel) redrawEntry(sel.eid);
  refreshInspector();
}
function deleteSelected() {
  const a = selAnnot();
  if (!a) return;
  const e = findEntry(sel.eid);
  e.annots = e.annots.filter((x) => x !== a);
  const eid = e.id;
  sel = null;
  redrawEntry(eid);
  refreshInspector();
  commit();
}
function duplicateSelected() {
  const a = selAnnot();
  if (!a) return;
  const e = findEntry(sel.eid);
  const copy = cloneAnnot(a);
  copy.id = uid();
  applyMove(copy, a, 14, 14);
  e.annots.push(copy);
  commit();
  select(e.id, copy.id);
}

/* ------------------------------------------------------------- inspector */
const PANEL = [
  ["pe-color", "color", (el) => el.value],
  ["pe-sw", "sw", (el) => +el.value],
  ["pe-opacity", "opacity", (el) => +el.value / 100],
  ["pe-fill", "fill", (el) => el.checked],
  ["pe-font", "font", (el) => el.value],
  ["pe-size", "size", (el) => clamp(+el.value || 18, 6, 300)],
  ["pe-bold", "bold", (el) => el.checked],
  ["pe-italic", "italic", (el) => el.checked],
  ["pe-border", "border", (el) => el.checked],
  ["pe-text", "text", (el) => el.value],
  ["pe-stamp", "stamp", (el) => el.value],
];
function setVal(id, v) {
  const el = $(id);
  if (el.type === "checkbox") el.checked = !!v;
  else el.value = v;
}
function refreshInspector() {
  const a = selAnnot();
  const kind = a ? a.type : tool;
  const show = new Set(SHOW[kind] || []);
  if (a && a.type === "text") show.add("text");
  $$("#pe-inspector [data-g]").forEach((el) => { el.hidden = !show.has(el.dataset.g); });
  $("pe-sel").hidden = !a;
  $("pe-hint").hidden = show.size > 0 || !!a;
  $("pe-hint").textContent = HINTS[tool] || "Pick a tool, or select an item on the page, to change its settings.";
  const src = a || D[kind] || {};
  setVal("pe-color", src.color || "#000000");
  setVal("pe-sw", src.sw ?? 3);
  setVal("pe-opacity", Math.round((src.opacity ?? 1) * 100));
  setVal("pe-fill", src.fill);
  setVal("pe-font", src.font || "Helvetica");
  setVal("pe-size", src.size ?? 18);
  setVal("pe-bold", src.bold);
  setVal("pe-italic", src.italic);
  setVal("pe-border", src.border);
  setVal("pe-stamp", src.stamp || "approved");
  setVal("pe-text", a && a.type === "text" ? a.text : "");
}
function onPanelInput(prop, value, final) {
  const a = selAnnot();
  const kind = a ? a.type : tool;
  if (D[kind] && prop !== "text") D[kind][prop] = value;
  if (a) {
    a[prop] = value;
    scheduleOverlay(views.get(sel.eid));
    if (final) {
      if (a.type === "text" && !String(a.text).trim()) { deleteSelected(); return; }
      commit();
    }
  }
}
PANEL.forEach(([id, prop, get]) => {
  const el = $(id);
  el.addEventListener("input", () => onPanelInput(prop, get(el), false));
  el.addEventListener("change", () => onPanelInput(prop, get(el), true));
});
$("pe-del").addEventListener("click", deleteSelected);
$("pe-dup").addEventListener("click", duplicateSelected);

/* ------------------------------------------------------------------ tools */
function setTool(t) {
  tool = t;
  select(null);
  $$("button[data-tool]").forEach((b) => {
    const on = b.dataset.tool === t;
    b.classList.toggle("pe-on", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
  stage.dataset.tool = t;
  refreshInspector();
  if (entries.length) setStatus(HINTS[t] || "");
}
$$("button[data-tool]").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));

/* ---------------------------------------------------------- pointer events */
function basePoint(v, ev) {
  const e = v.entry;
  const { W0, H0, dw, dh } = dims(e);
  const r = v.ov.getBoundingClientRect();
  const u = ((ev.clientX - r.left) / r.width) * dw;
  const w = ((ev.clientY - r.top) / r.height) * dh;
  return toBase(e.rot, W0, H0, u, w);
}

function startDraw(v, x, y) {
  const e = v.entry;
  const d = D[tool] || {};
  let a;
  if (tool === "pen" || tool === "hl") {
    a = { id: uid(), type: tool, pts: [x, y, x, y], color: d.color, sw: d.sw, opacity: d.opacity };
  } else if (tool === "rect" || tool === "ellipse") {
    a = { id: uid(), type: tool, x, y, w: 0, h: 0, color: d.color, sw: d.sw, opacity: d.opacity, fill: d.fill };
  } else if (tool === "white" || tool === "redact") {
    a = { id: uid(), type: tool, x, y, w: 0, h: 0, color: tool === "white" ? "#ffffff" : "#000000", opacity: 1, fill: true, sw: 0 };
  } else {
    a = { id: uid(), type: tool, x1: x, y1: y, x2: x, y2: y, color: d.color, sw: d.sw, opacity: d.opacity };
  }
  e.annots.push(a);
  drag = { mode: "draw", v, a, sx: x, sy: y };
}

function addAndSelect(e, a) {
  e.annots.push(a);
  setTool("select");
  select(e.id, a.id);
  commit();
  drawOverlay(views.get(e.id));
}

function onDown(v, ev) {
  if (!ev.isPrimary || (ev.pointerType === "mouse" && ev.button !== 0)) return;
  const e = v.entry;
  setCur(v.index);
  const [x, y] = basePoint(v, ev);
  const px = 1 / cssScale();
  const capture = () => { try { v.ov.setPointerCapture(ev.pointerId); } catch {} };

  if (tool === "select") {
    if (sel && sel.eid === e.id) {
      const a = selAnnot();
      const h = a ? hitHandle(a, x, y, 9 * px) : -1;
      if (a && h !== -1) {
        drag = { mode: "handle", v, a, h, orig: cloneAnnot(a), moved: false };
        capture(); ev.preventDefault();
        return;
      }
    }
    for (let i = e.annots.length - 1; i >= 0; i--) {
      const a = e.annots[i];
      if (hitTest(a, x, y, 6 * px)) {
        select(e.id, a.id);
        drag = { mode: "move", v, a, orig: cloneAnnot(a), sx: x, sy: y, moved: false };
        capture(); ev.preventDefault();
        return;
      }
    }
    select(null);
    return;
  }

  ev.preventDefault();

  if (tool === "text") {
    const d = D.text;
    const a = { id: uid(), type: "text", x, y, text: "Text", color: d.color, opacity: d.opacity, font: d.font, size: d.size, bold: d.bold, italic: d.italic, border: d.border };
    addAndSelect(e, a);
    setTimeout(() => { $("pe-text").focus(); $("pe-text").select(); }, 0);
    return;
  }
  if (tool === "stamp") {
    const st = STAMPS[D.stamp.stamp] || STAMPS.approved;
    const a = { id: uid(), type: "text", x, y, text: st.text, color: st.color, opacity: D.stamp.opacity, font: "Helvetica", size: D.stamp.size, bold: true, italic: false, border: true };
    addAndSelect(e, a);
    return;
  }
  if (tool === "edittext") { editTextAt(v, x, y); return; }

  startDraw(v, x, y);
  capture();
  scheduleOverlay(v);
}

function onMove(v, ev) {
  if (!drag || drag.v !== v) return;
  const [x, y] = basePoint(v, ev);
  const a = drag.a;
  if (drag.mode === "draw") {
    if (a.pts) {
      const n = a.pts.length;
      if (Math.hypot(x - a.pts[n - 2], y - a.pts[n - 1]) > 0.6 / cssScale()) a.pts.push(x, y);
    } else if (a.type === "line" || a.type === "arrow") {
      a.x2 = x; a.y2 = y;
    } else {
      a.x = Math.min(drag.sx, x); a.y = Math.min(drag.sy, y);
      a.w = Math.abs(x - drag.sx); a.h = Math.abs(y - drag.sy);
    }
  } else if (drag.mode === "move") {
    applyMove(a, drag.orig, x - drag.sx, y - drag.sy);
    drag.moved = true;
  } else if (drag.mode === "handle") {
    applyHandle(a, drag.orig, drag.h, x, y);
    drag.moved = true;
  }
  scheduleOverlay(v);
}

function onUp(v, ev) {
  if (!drag || drag.v !== v) return;
  const d = drag;
  drag = null;
  try { v.ov.releasePointerCapture(ev.pointerId); } catch {}
  const e = v.entry;
  const a = d.a;
  if (d.mode === "draw") {
    const tiny =
      (BOX.has(a.type) && a.w < 3 && a.h < 3) ||
      ((a.type === "line" || a.type === "arrow") && Math.hypot(a.x2 - a.x1, a.y2 - a.y1) < 3);
    if (tiny) { e.annots = e.annots.filter((x) => x !== a); drawOverlay(v); return; }
    commit();
    if (a.type !== "pen" && a.type !== "hl") select(e.id, a.id);
    else drawOverlay(v);
  } else if (d.moved) {
    commit();
  }
}

/* ------------------------------------------- edit existing text (cover + retype) */
async function editTextAt(v, x, y) {
  const e = v.entry;
  if (e.src === null) { setStatus("This is a blank page. Use the Text tool instead.", true); return; }
  setStatus("Looking for text...");
  try {
    const page = await getPageProxy(e);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    let best = null;
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const t = pdfjsLib.Util.transform(vp.transform, it.transform);
      const size = Math.hypot(t[2], t[3]);
      if (size < 1 || Math.abs(t[2]) > size * 0.02) continue; // skip rotated or skewed text
      const left = t[4], base = t[5];
      const top = base - size * 0.9, bottom = base + size * 0.3;
      if (x >= left - 2 && x <= left + it.width + 2 && y >= top && y <= bottom) {
        best = { it, left, w: it.width, base, size, top };
        break;
      }
    }
    if (!best) { setStatus("No editable text found there. Click directly on a word.", true); return; }

    const fam = ((tc.styles[best.it.fontName] || {}).fontFamily || "").toLowerCase();
    const fontKey = /mono|courier/.test(fam) ? "Courier" : /serif/.test(fam) && !/sans/.test(fam) ? "Times" : "Helvetica";
    const cover = { id: uid(), type: "white", x: best.left - 1.5, y: best.top, w: best.w + 3, h: best.size * 1.25, color: "#ffffff", opacity: 1, fill: true, sw: 0 };
    const label = {
      id: uid(), type: "text", x: best.left, y: best.base - best.size * 0.85, text: best.it.str,
      color: "#000000", opacity: 1, font: fontKey, size: Math.round(best.size * 10) / 10,
      bold: /bold/i.test(best.it.fontName), italic: false, border: false,
    };
    e.annots.push(cover, label);
    setTool("select");
    select(e.id, label.id);
    commit();
    drawOverlay(v);
    setStatus("Type your new text in the Text box on the right.");
    setTimeout(() => { $("pe-text").focus(); $("pe-text").select(); }, 0);
  } catch (err) {
    console.warn(err);
    setStatus("Could not read the text on this page.", true);
  }
}

/* -------------------------------------------------------------- images */
async function fileToImageUrl(file) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL(file.type === "image/jpeg" ? "image/jpeg" : "image/png", 0.9);
}
async function placeImage(url, target = 180) {
  const e = entries[cur];
  if (!e) return;
  const img = new Image();
  img.src = url;
  await img.decode();
  const key = "g" + ++idSeq;
  imgCache.set(key, img);
  const { W0, H0 } = dims(e);
  const w = Math.min(target, W0 * 0.7);
  const h = w * (img.naturalHeight / img.naturalWidth);
  addAndSelect(e, { id: uid(), type: "image", imgKey: key, x: (W0 - w) / 2, y: (H0 - h) / 2, w, h, opacity: 1 });
  goToPage(cur);
}
$("pe-image").addEventListener("click", () => $("pe-img-file").click());
$("pe-img-file").addEventListener("change", async (ev) => {
  const f = ev.target.files[0];
  ev.target.value = "";
  if (!f) return;
  try { await placeImage(await fileToImageUrl(f), 220); } catch { setStatus("That image could not be read.", true); }
});

/* ------------------------------------------------------------ signature */
const sigDlg = $("pe-sig-dlg");
const sigDraw = $("pe-sig-draw");
const sd = sigDraw.getContext("2d");
let sigTab = "draw";
let sigInk = false;
let sigDrawing = false;
let sigUploadUrl = "";
sd.lineWidth = 3.4;
sd.lineCap = "round";
sd.lineJoin = "round";

function sigPos(ev) {
  const r = sigDraw.getBoundingClientRect();
  return [((ev.clientX - r.left) * sigDraw.width) / r.width, ((ev.clientY - r.top) * sigDraw.height) / r.height];
}
sigDraw.addEventListener("pointerdown", (ev) => {
  sigDrawing = true;
  sigInk = true;
  try { sigDraw.setPointerCapture(ev.pointerId); } catch {}
  const [x, y] = sigPos(ev);
  sd.strokeStyle = $("pe-sig-ink").value;
  sd.beginPath(); sd.moveTo(x, y); sd.lineTo(x + 0.01, y); sd.stroke();
  ev.preventDefault();
});
sigDraw.addEventListener("pointermove", (ev) => {
  if (!sigDrawing) return;
  const [x, y] = sigPos(ev);
  sd.lineTo(x, y); sd.stroke();
});
["pointerup", "pointercancel"].forEach((n) => sigDraw.addEventListener(n, () => { sigDrawing = false; }));
$("pe-sig-clear").addEventListener("click", () => { sd.clearRect(0, 0, sigDraw.width, sigDraw.height); sigInk = false; });

function renderTyped() {
  const c = $("pe-sig-type");
  const x = c.getContext("2d");
  x.clearRect(0, 0, c.width, c.height);
  const name = $("pe-sig-name").value.trim();
  if (!name) return;
  let size = 110;
  x.fillStyle = $("pe-sig-ink").value;
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.font = size + 'px "Caveat Variable", cursive';
  while (x.measureText(name).width > c.width - 40 && size > 28) {
    size -= 4;
    x.font = size + 'px "Caveat Variable", cursive';
  }
  x.fillText(name, c.width / 2, c.height / 2);
}
$("pe-sig-name").addEventListener("input", renderTyped);
$("pe-sig-ink").addEventListener("change", renderTyped);

$$('input[name="pe-sigtab"]').forEach((r) =>
  r.addEventListener("change", () => {
    sigTab = r.value;
    $$("[data-sigpanel]").forEach((p) => { p.hidden = p.dataset.sigpanel !== sigTab; });
    if (sigTab === "type") document.fonts.load('40px "Caveat Variable"').then(renderTyped);
  })
);
$("pe-sig-file").addEventListener("change", async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  try {
    sigUploadUrl = await fileToImageUrl(f);
    const img = $("pe-sig-preview");
    img.src = sigUploadUrl;
    img.hidden = false;
  } catch { $("pe-sig-msg").textContent = "That image could not be read."; }
});

function trimCanvas(src) {
  const { width: w, height: h } = src;
  const d = src.getContext("2d").getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 12) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - 6); y0 = Math.max(0, y0 - 6);
  x1 = Math.min(w - 1, x1 + 6); y1 = Math.min(h - 1, y1 + 6);
  const out = document.createElement("canvas");
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext("2d").drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}
$("pe-sign").addEventListener("click", () => {
  $("pe-sig-msg").textContent = "";
  sigDlg.showModal();
});
$("pe-sig-add").addEventListener("click", async () => {
  const msg = $("pe-sig-msg");
  let url = "";
  if (sigTab === "draw") {
    const t = sigInk ? trimCanvas(sigDraw) : null;
    if (!t) { msg.textContent = "Draw your signature in the box first."; return; }
    url = t.toDataURL("image/png");
  } else if (sigTab === "type") {
    const t = trimCanvas($("pe-sig-type"));
    if (!t) { msg.textContent = "Type your name first."; return; }
    url = t.toDataURL("image/png");
  } else {
    if (!sigUploadUrl) { msg.textContent = "Choose an image first."; return; }
    url = sigUploadUrl;
  }
  sigDlg.close();
  await placeImage(url, 170);
});

/* ---------------------------------------------------------- page actions */
function rotateCur(dir) {
  const e = entries[cur];
  if (!e) return;
  e.rot = (e.rot + dir + 360) % 360;
  syncAll();
  commit();
}
function movePage(from, to) {
  if (from === to || from < 0 || to < 0 || from >= entries.length || to >= entries.length) return;
  const [e] = entries.splice(from, 1);
  entries.splice(to, 0, e);
  cur = to;
  syncAll();
  commit();
  goToPage(to);
}
$("pe-rotl").addEventListener("click", () => rotateCur(-90));
$("pe-rotr").addEventListener("click", () => rotateCur(90));
$("pe-up").addEventListener("click", () => movePage(cur, cur - 1));
$("pe-down").addEventListener("click", () => movePage(cur, cur + 1));
$("pe-dupe").addEventListener("click", () => {
  const e = entries[cur];
  if (!e) return;
  const copy = cloneEntries([e])[0];
  copy.id = uid();
  entries.splice(cur + 1, 0, copy);
  cur += 1;
  syncAll();
  commit();
  goToPage(cur);
});
$("pe-blank").addEventListener("click", () => {
  const e = entries[cur];
  if (!e) return;
  const { dw, dh } = dims(e);
  entries.splice(cur + 1, 0, { id: uid(), src: null, pn: 0, rot: 0, annots: [], x0: 0, y0: 0, w: dw, h: dh, R0: 0 });
  cur += 1;
  syncAll();
  commit();
  goToPage(cur);
});
$("pe-del-page").addEventListener("click", () => {
  if (entries.length <= 1) { setStatus("A PDF needs at least one page.", true); return; }
  if (!confirm("Delete page " + (cur + 1) + "?")) return;
  entries.splice(cur, 1);
  cur = Math.min(cur, entries.length - 1);
  sel = null;
  syncAll();
  commit();
  refreshInspector();
});

/* -------------------------------------------------------------- exporting */
function renderOverlayRaw(e, k0, wm) {
  const { W0, H0 } = dims(e);
  const k = capScale(k0, e.w, e.h);
  const cv = document.createElement("canvas");
  cv.width = Math.ceil(e.w * k);
  cv.height = Math.ceil(e.h * k);
  const ctx = cv.getContext("2d");
  ctx.setTransform(...mat((360 - e.R0) % 360, W0, H0, k)); // base space back to the raw page
  paintAnnots(ctx, e, W0, H0, wm);
  return cv;
}

async function flattenPage(out, e, q, wm) {
  const { W0, H0, dw, dh } = dims(e);
  const k = capScale(q.k, dw, dh);
  const cv = document.createElement("canvas");
  cv.width = Math.ceil(dw * k);
  cv.height = Math.ceil(dh * k);
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, cv.width, cv.height);
  if (e.src !== null) {
    const page = await getPageProxy(e);
    const vp = page.getViewport({ scale: k, rotation: (e.R0 + e.rot) % 360 });
    await enqueue(() => page.render({ canvasContext: ctx, viewport: vp }).promise);
  }
  ctx.save();
  ctx.setTransform(...mat(e.rot, W0, H0, k));
  paintAnnots(ctx, e, W0, H0, wm);
  ctx.restore();
  const blob = await canvasToBlob(cv, "image/jpeg", q.j);
  const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
  const page = out.addPage([dw, dh]);
  page.drawImage(img, { x: 0, y: 0, width: dw, height: dh });
}

async function buildPdf(list, opts = {}) {
  const { flatten = false, quality = "medium", watermark = null, onProgress } = opts;
  const presets = { high: { k: 2.5, j: 0.9 }, medium: { k: 1.6, j: 0.75 }, low: { k: 1.1, j: 0.55 } };
  const q = presets[quality] || presets.medium;
  const out = await PDFDocument.create();
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (onProgress) onProgress(i + 1, list.length);
    if (flatten) {
      await flattenPage(out, e, q, watermark);
    } else {
      let page;
      if (e.src === null) page = out.addPage([e.w, e.h]);
      else {
        const [cp] = await out.copyPages(sources[e.src].lib, [e.pn - 1]);
        page = out.addPage(cp);
      }
      if (e.rot) page.setRotation(degrees((e.R0 + e.rot) % 360));
      if (e.annots.length || watermark) {
        const cv = renderOverlayRaw(e, 3, watermark);
        const blob = await canvasToBlob(cv, "image/png");
        const img = await out.embedPng(new Uint8Array(await blob.arrayBuffer()));
        page.drawImage(img, { x: e.x0, y: e.y0, width: e.w, height: e.h });
      }
    }
    await tick();
  }
  out.setProducer("Toolairy PDF Editor");
  return out.save();
}

const safeName = (raw, fallback) => {
  let n = String(raw || "").trim().replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/[. ]+$/, "");
  return (n || fallback) + ".pdf";
};

$("pe-download").addEventListener("click", () => $("pe-export-dlg").showModal());
$("pe-export-go").addEventListener("click", async () => {
  const btn = $("pe-export-go");
  btn.disabled = true;
  try {
    const wmText = $("pe-wm-text").value.trim();
    const watermark = wmText ? { text: wmText, opacity: +$("pe-wm-op").value / 100, color: "#7a7a7a" } : null;
    const bytes = await buildPdf(entries, {
      flatten: $("pe-mode-flat").checked,
      quality: $("pe-quality").value,
      watermark,
      onProgress: (i, n) => setStatus("Saving page " + i + " of " + n + "..."),
    });
    download(safeName($("pe-fname").value, "document-edited"), bytes, "application/pdf");
    dirty = false;
    setStatus("Done. Your PDF was created in your browser.");
    $("pe-export-dlg").close();
  } catch (err) {
    console.error(err);
    setStatus("Could not save the PDF: " + (err.message || "unknown error"), true);
    $("pe-export-dlg").close();
  } finally {
    btn.disabled = false;
  }
});

/* extract and split */
function parseRanges(text, n) {
  const out = [];
  for (const part of text.split(",")) {
    const t = part.trim();
    if (!t) continue;
    const m = t.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) return { error: '"' + t + '" is not a valid page or range.' };
    const a = +m[1], b = m[2] ? +m[2] : a;
    if (a < 1 || b < 1 || a > n || b > n) return { error: "Pages must be between 1 and " + n + "." };
    if (a <= b) for (let i = a; i <= b; i++) out.push(i - 1);
    else for (let i = a; i >= b; i--) out.push(i - 1);
  }
  if (!out.length) return { error: "Enter at least one page number or range." };
  return { list: out };
}
$("pe-extract").addEventListener("click", () => {
  $("pe-extract-msg").textContent = "The document has " + entries.length + " pages.";
  $("pe-range").value = String(cur + 1);
  $("pe-extract-dlg").showModal();
});
$("pe-extract-go").addEventListener("click", async () => {
  const msg = $("pe-extract-msg");
  const r = parseRanges($("pe-range").value, entries.length);
  if (r.error) { msg.textContent = r.error; return; }
  try {
    msg.textContent = "Working...";
    const bytes = await buildPdf(r.list.map((i) => entries[i]));
    download(safeName(docName + "-pages", "pages"), bytes, "application/pdf");
    $("pe-extract-dlg").close();
    setStatus("Extracted " + r.list.length + " page(s).");
  } catch (err) { msg.textContent = "Could not extract the pages: " + (err.message || "unknown error"); }
});
$("pe-split-go").addEventListener("click", async () => {
  const msg = $("pe-extract-msg");
  try {
    const zip = new JSZip();
    for (let i = 0; i < entries.length; i++) {
      msg.textContent = "Splitting page " + (i + 1) + " of " + entries.length + "...";
      zip.file(docName + "-page-" + (i + 1) + ".pdf", await buildPdf([entries[i]]));
      await tick();
    }
    const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
    download(docName + "-pages.zip", blob);
    $("pe-extract-dlg").close();
    setStatus("Split into " + entries.length + " files.");
  } catch (err) { msg.textContent = "Could not split the file: " + (err.message || "unknown error"); }
});

/* ------------------------------------------------------- file inputs, drops */
$("pe-open").addEventListener("click", () => $("pe-file").click());
$("pe-empty-open").addEventListener("click", () => $("pe-file").click());
$("pe-add").addEventListener("click", () => $("pe-file-add").click());
$("pe-file").addEventListener("change", (ev) => { const f = ev.target.files; openFiles(f, false).finally(() => { ev.target.value = ""; }); });
$("pe-file-add").addEventListener("change", (ev) => { const f = ev.target.files; openFiles(f, true).finally(() => { ev.target.value = ""; }); });

["dragenter", "dragover"].forEach((n) =>
  stage.addEventListener(n, (ev) => {
    if (dragFrom >= 0 || !ev.dataTransfer || !Array.from(ev.dataTransfer.types).includes("Files")) return;
    ev.preventDefault();
    stage.classList.add("pe-drag");
  })
);
["dragleave", "drop"].forEach((n) => stage.addEventListener(n, () => stage.classList.remove("pe-drag")));
stage.addEventListener("drop", (ev) => {
  if (dragFrom >= 0 || !ev.dataTransfer || !ev.dataTransfer.files.length) return;
  ev.preventDefault();
  openFiles(ev.dataTransfer.files, entries.length > 0);
});

/* ---------------------------------------------------------------- undo etc */
$("pe-undo").addEventListener("click", undo);
$("pe-redo").addEventListener("click", redo);
window.addEventListener("keydown", (ev) => {
  const tag = (ev.target && ev.target.tagName) || "";
  const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (ev.target && ev.target.isContentEditable);
  if (typing) return;
  const mod = ev.ctrlKey || ev.metaKey;
  const key = ev.key.toLowerCase();
  if (mod && key === "z") { ev.preventDefault(); if (ev.shiftKey) redo(); else undo(); }
  else if (mod && key === "y") { ev.preventDefault(); redo(); }
  else if ((ev.key === "Delete" || ev.key === "Backspace") && selAnnot()) { ev.preventDefault(); deleteSelected(); }
  else if (ev.key === "Escape") { if (sel) select(null); else setTool("select"); }
});
window.addEventListener("beforeunload", (ev) => {
  if (dirty) { ev.preventDefault(); ev.returnValue = ""; }
});

/* -------------------------------------------------------------------- init */
setTool("select");
updateUi();
refreshInspector();
document.fonts.load('20px "Caveat Variable"').then(() => views.forEach((v) => drawOverlay(v))).catch(() => {});