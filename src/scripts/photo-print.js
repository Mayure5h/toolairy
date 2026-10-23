/*
  Toolairy Passport Photo Maker and Print Layout. Runs fully in the browser.

  Flow
  - cropperjs handles crop, rotate, and flip on the uploaded image.
  - A small preview canvas is rebuilt (debounced) whenever the crop or size changes.
  - On export, the crop is rendered at the exact pixel size (inches x DPI) with two-pass
    downsampling for clean edges, then saved as PNG/JPEG, placed in a PDF, or printed.
  - The sheet layout is computed in millimeters and shared by preview, print, and PDF.
*/
import Cropper from "cropperjs";
import "cropperjs/dist/cropper.css";
import { PDFDocument, rgb } from "pdf-lib";

/* ---------------------------------------------------------------- helpers */
const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const MM = 25.4;
const inch = (v) => v * MM;
const PAD = 18;
const RULER = 26;

const canvasToBlob = (cv, type, q) =>
  new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error("Could not create the image."))), type, q));

/* ----------------------------------------------------------------- data */
const PRESETS = [
  { id: "p35x45", label: "Passport 35 × 45 mm (3.5 × 4.5 cm)", w: 35, h: 45 },
  { id: "p2x2", label: "Passport / visa 2 × 2 in (51 × 51 mm)", w: inch(2), h: inch(2) },
  { id: "wallet", label: "Wallet 2.5 × 3.5 in", w: inch(2.5), h: inch(3.5) },
  { id: "4x6", label: "Photo 4 × 6 in", w: inch(4), h: inch(6) },
  { id: "5x7", label: "Photo 5 × 7 in", w: inch(5), h: inch(7) },
  { id: "8x10", label: "Photo 8 × 10 in", w: inch(8), h: inch(10) },
  { id: "a4", label: "A4 photo (210 × 297 mm)", w: 210, h: 297 },
];
const PAPERS = {
  a4: { label: "A4 (210 × 297 mm)", w: 210, h: 297 },
  a3: { label: "A3 (297 × 420 mm)", w: 297, h: 420 },
  a5: { label: "A5 (148 × 210 mm)", w: 148, h: 210 },
  letter: { label: "Letter (8.5 × 11 in)", w: 215.9, h: 279.4 },
  legal: { label: "Legal (8.5 × 14 in)", w: 215.9, h: 355.6 },
  p4x6: { label: "Photo paper 4 × 6 in", w: 101.6, h: 152.4 },
  p5x7: { label: "Photo paper 5 × 7 in", w: 127, h: 177.8 },
};

const S = {
  wIn: 35 / MM, hIn: 45 / MM, unit: "mm", dpi: 300, lock: true, mode: "fixed",
  rot: 0, flipX: 1, flipY: 1, bg: "#ffffff",
  paper: "a4", orient: "portrait", margin: 5, align: "center", place: { x: 0, y: 0 },
  multi: false, gap: 3, copies: 0, guides: true, runit: "cm",
  tab: "edit", zoom: "fit",
};
let cropper = null;
let appliedAspect = NaN;
let prev = null;
let lastDraw = null;
let drag = null;
let currentUrl = "";
let fileBase = "photo";
let previewTimer = 0;

/* ------------------------------------------------------- units and display */
const toDisp = (inches) => {
  if (S.unit === "in") return inches;
  if (S.unit === "cm") return inches * 2.54;
  if (S.unit === "mm") return inches * MM;
  return inches * S.dpi;
};
const fromDisp = (v) => {
  if (S.unit === "in") return v;
  if (S.unit === "cm") return v / 2.54;
  if (S.unit === "mm") return v / MM;
  return v / S.dpi;
};
const dispStr = (inches) => (S.unit === "px" ? String(Math.round(inches * S.dpi)) : String(+toDisp(inches).toFixed(2)));
const f2 = (n) => String(+n.toFixed(2));

function status(msg, bad = false) {
  const el = $("pp-status");
  el.textContent = msg || "";
  el.classList.toggle("pp-bad", bad);
}
function busy(msg) {
  $("pp-busy").hidden = !msg;
  if (msg) $("pp-busy-msg").textContent = msg;
}
const ready = () => !!(cropper && cropper.ready);

function renderInputs(except) {
  const step = S.unit === "px" ? "1" : "0.1";
  $("pp-w").step = step;
  $("pp-h").step = step;
  if (except !== "w") $("pp-w").value = dispStr(S.wIn);
  if (except !== "h") $("pp-h").value = dispStr(S.hIn);
  updateReadout();
}
function updateReadout() {
  const W = Math.round(S.wIn * S.dpi), H = Math.round(S.hIn * S.dpi);
  $("pp-readout").textContent =
    "Output: " + W + " × " + H + " px at " + S.dpi + " DPI\n" +
    f2(S.wIn * MM) + " × " + f2(S.hIn * MM) + " mm  |  " +
    f2(S.wIn * 2.54) + " × " + f2(S.hIn * 2.54) + " cm  |  " +
    f2(S.wIn) + " × " + f2(S.hIn) + " in";
}

/* ---------------------------------------------------------- setup of lists */
PRESETS.forEach((p) => $("pp-preset").add(new Option(p.label, p.id)));
$("pp-preset").add(new Option("Custom size", "custom"));
$("pp-preset").value = "p35x45";
Object.entries(PAPERS).forEach(([k, p]) => $("pp-paper").add(new Option(p.label, k)));
$("pp-paper").value = S.paper;
renderInputs();

/* --------------------------------------------------------------- image load */
function typeName(file) {
  const m = (file.type || "").split("/")[1];
  return (m || file.name.split(".").pop() || "image").toUpperCase();
}
function loadFile(file) {
  if (!file) return;
  const msg = $("pp-upmsg");
  msg.textContent = "";
  const looksImage = /^image\//.test(file.type) || /\.(jpe?g|png|webp|gif|bmp|tiff?)$/i.test(file.name);
  if (!looksImage) { msg.textContent = "Please choose an image file (JPG, PNG, or WebP)."; return; }
  busy("Loading photo...");
  const url = URL.createObjectURL(file);
  const test = new Image();
  test.onload = () => {
    if (cropper) { cropper.destroy(); cropper = null; }
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = url;
    fileBase = file.name.replace(/\.[^.]+$/, "").replace(/[^\w\-]+/g, "_") || "photo";
    $("pp-m-px").textContent = test.naturalWidth + " × " + test.naturalHeight;
    $("pp-m-size").textContent = file.size >= 1048576 ? (file.size / 1048576).toFixed(2) + " MB" : Math.round(file.size / 1024) + " KB";
    $("pp-m-mp").textContent = ((test.naturalWidth * test.naturalHeight) / 1e6).toFixed(1) + " MP";
    $("pp-m-type").textContent = typeName(file);
    $("pp-meta").hidden = false;
    $("pp-empty").hidden = true;
    $("pp-editwrap").hidden = false;
    $("pp-prev-empty").hidden = true;
    $("pp-prevscroll").hidden = false;
    setTab("edit");
    const img = $("pp-img");
    img.onload = () => { initCropper(img); busy(null); };
    img.src = url;
  };
  test.onerror = () => {
    URL.revokeObjectURL(url);
    busy(null);
    msg.textContent = /\.tiff?$/i.test(file.name)
      ? "This browser cannot open TIFF files. Please convert the photo to JPG or PNG first."
      : "That file could not be read as an image. Try a JPG or PNG.";
  };
  test.src = url;
}

function initCropper(img) {
  appliedAspect = S.mode === "fixed" ? S.wIn / S.hIn : NaN;
  cropper = new Cropper(img, {
    viewMode: 1,
    dragMode: "move",
    autoCropArea: 0.9,
    responsive: true,
    checkOrientation: false, // modern browsers already apply EXIF orientation
    aspectRatio: appliedAspect,
    wheelZoomRatio: 0.08,
    crop() { onCrop(); },
    ready() {
      S.rot = 0; S.flipX = 1; S.flipY = 1;
      $("pp-rot").value = 0;
      $("pp-rotval").textContent = "0°";
      updateUi();
      onCrop();
      status("Drag the box to position the crop. Scroll to zoom the photo.");
    },
  });
}

function onCrop() {
  if (!ready()) return;
  const d = cropper.getData(true);
  if (S.mode === "free" && S.lock && d.width > 0 && d.height > 0) {
    S.hIn = (S.wIn * d.height) / d.width;
    renderInputs();
  }
  refreshQuality();
  schedulePreview();
}

function refreshQuality() {
  const box = $("pp-quality"), low = $("pp-low"), badge = $("pp-badge");
  if (!ready()) { box.textContent = ""; low.hidden = true; badge.hidden = true; $("pp-croplabel").textContent = ""; return; }
  const d = cropper.getData(true);
  if (!d.width || !d.height) return;
  const eff = Math.min(d.width / S.wIn, d.height / S.hIn);
  box.textContent =
    "Your crop gives about " + Math.round(eff) + " DPI at this size." +
    (eff >= 300 ? " Great for sharp prints." : eff >= 200 ? " Good for most prints." : "");
  const isLow = eff < 200;
  low.hidden = !isLow;
  badge.hidden = !isLow || S.tab !== "prev";
  if (isLow) {
    const t = "Low print resolution warning: about " + Math.round(eff) + " DPI (200 or more is recommended)";
    low.textContent = t;
    badge.textContent = t;
  }
  $("pp-croplabel").textContent =
    "Crop size: " + dispStr(S.wIn) + " × " + dispStr(S.hIn) + " " + S.unit + " (from " + d.width + " × " + d.height + " px of your photo)";
}

/* ------------------------------------------------------- size and aspect */
function currentRatio() {
  if (S.mode === "free" && ready()) {
    const d = cropper.getData(true);
    if (d.width > 0 && d.height > 0) return d.width / d.height;
  }
  return S.wIn / S.hIn;
}
function applyAspect(force) {
  if (!ready()) return;
  const want = S.mode === "fixed" ? S.wIn / S.hIn : NaN;
  const same = (Number.isNaN(want) && Number.isNaN(appliedAspect)) || Math.abs(want - appliedAspect) < 1e-4;
  if (same && !force) return;
  appliedAspect = want;
  cropper.setAspectRatio(want);
}
function afterSize() {
  S.wIn = clamp(S.wIn, 0.1, 60);
  S.hIn = clamp(S.hIn, 0.1, 60);
  applyAspect(false);
  updateReadout();
  refreshQuality();
  updateCount();
  schedulePreview();
}
function onSize(which) {
  const raw = parseFloat($(which === "w" ? "pp-w" : "pp-h").value);
  if (!(raw > 0)) return;
  const v = fromDisp(raw);
  const ratio = S.lock ? currentRatio() : 0;
  if (which === "w") { S.wIn = v; if (S.lock) S.hIn = v / ratio; }
  else { S.hIn = v; if (S.lock) S.wIn = v * ratio; }
  $("pp-preset").value = "custom";
  renderInputs(which);
  afterSize();
}
$("pp-w").addEventListener("input", () => onSize("w"));
$("pp-h").addEventListener("input", () => onSize("h"));
$("pp-lock").addEventListener("change", (e) => { S.lock = e.target.checked; });
$("pp-unit").addEventListener("change", (e) => { S.unit = e.target.value; renderInputs(); refreshQuality(); });
$("pp-preset").addEventListener("change", (e) => {
  const p = PRESETS.find((x) => x.id === e.target.value);
  if (!p) return;
  S.wIn = p.w / MM;
  S.hIn = p.h / MM;
  setMode("fixed");
  renderInputs();
  afterSize();
});
function setMode(m) {
  S.mode = m;
  $$('input[name="pp-mode"]').forEach((r) => { r.checked = r.value === m; });
  applyAspect(true);
}
$$('input[name="pp-mode"]').forEach((r) => r.addEventListener("change", () => { if (r.checked) { setMode(r.value); afterSize(); } }));

function setDpi(v) {
  S.dpi = clamp(Math.round(v) || 300, 50, 1200);
  $("pp-dpi").value = S.dpi;
  $$("[data-dpi]").forEach((b) => b.classList.toggle("pp-on", +b.dataset.dpi === S.dpi));
  renderInputs();
  refreshQuality();
  schedulePreview();
}
$$("[data-dpi]").forEach((b) => b.addEventListener("click", () => setDpi(+b.dataset.dpi)));
$("pp-dpi").addEventListener("change", (e) => setDpi(+e.target.value));

/* ----------------------------------------------------- rotate, flip, color */
const normRot = (v) => ((((v + 180) % 360) + 360) % 360) - 180;
function setRot(v) {
  S.rot = normRot(v);
  $("pp-rot").value = S.rot;
  $("pp-rotval").textContent = S.rot + "°";
  if (ready()) { cropper.rotateTo(S.rot); schedulePreview(); }
}
$("pp-rot").addEventListener("input", (e) => setRot(+e.target.value));
$("pp-rotm").addEventListener("click", () => setRot(S.rot - 90));
$("pp-rotp").addEventListener("click", () => setRot(S.rot + 90));
$("pp-flipx").addEventListener("click", () => { if (!ready()) return; S.flipX *= -1; cropper.scaleX(S.flipX); schedulePreview(); });
$("pp-flipy").addEventListener("click", () => { if (!ready()) return; S.flipY *= -1; cropper.scaleY(S.flipY); schedulePreview(); });
$("pp-bg").addEventListener("input", (e) => { S.bg = e.target.value; schedulePreview(); });

/* ------------------------------------------------------------ sheet layout */
function paperDims() {
  const p = PAPERS[S.paper];
  return S.orient === "landscape" ? { w: p.h, h: p.w } : { w: p.w, h: p.h };
}

function layout() {
  const paper = paperDims();
  const w = S.wIn * MM, h = S.hIn * MM, m = S.margin;
  const g = S.multi ? S.gap : 0;
  const L = { paper, w, h, items: [], guides: [], notes: [], count: 1, capacity: 1 };
  let cols = 1, rows = 1, count = 1;

  if (S.multi) {
    const c = Math.floor((paper.w - 2 * m + g) / (w + g));
    const r = Math.floor((paper.h - 2 * m + g) / (h + g));
    if (c >= 1 && r >= 1) {
      L.capacity = c * r;
      count = S.copies > 0 ? Math.min(S.copies, L.capacity) : L.capacity;
      cols = Math.min(c, count);
      rows = Math.ceil(count / cols);
    } else {
      L.notes.push("The photo is larger than the printable area, so it cannot be repeated on this sheet.");
    }
  }
  const bw = cols * w + (cols - 1) * g;
  const bh = rows * h + (rows - 1) * g;

  let bx, by;
  if (S.align === "topleft") { bx = m; by = m; }
  else if (S.align === "custom") {
    bx = clamp(S.place.x, Math.min(0, paper.w - bw), Math.max(0, paper.w - bw));
    by = clamp(S.place.y, Math.min(0, paper.h - bh), Math.max(0, paper.h - bh));
  } else { bx = (paper.w - bw) / 2; by = (paper.h - bh) / 2; }

  for (let i = 0; i < count; i++) {
    L.items.push({ x: bx + (i % cols) * (w + g), y: by + Math.floor(i / cols) * (h + g), w, h });
  }
  L.count = count;
  L.block = { x: bx, y: by, w: bw, h: bh };

  if (S.guides) {
    const xs = [bx];
    for (let c = 1; c < cols; c++) xs.push(bx + c * (w + g) - g / 2);
    xs.push(bx + bw);
    const ys = [by];
    for (let r = 1; r < rows; r++) ys.push(by + r * (h + g) - g / 2);
    ys.push(by + bh);
    const ext = 3;
    xs.forEach((x) => L.guides.push({ x1: x, y1: by - ext, x2: x, y2: by + bh + ext }));
    ys.forEach((y) => L.guides.push({ x1: bx - ext, y1: y, x2: bx + bw + ext, y2: y }));
  }
  if (bw > paper.w + 0.01 || bh > paper.h + 0.01) L.notes.push("The photo is larger than the paper, so part of it will be cut off.");
  return L;
}

function updateCount() {
  const L = layout();
  let t = L.count + (L.count === 1 ? " photo" : " photos") + " on the sheet";
  if (S.multi && L.capacity > 1) t += " (the sheet fits up to " + L.capacity + ")";
  t += ".";
  if (L.notes.length) t += " " + L.notes.join(" ");
  $("pp-count").textContent = t;
}

["pp-paper", "pp-orient", "pp-margin", "pp-gap", "pp-copies", "pp-guides", "pp-multi", "pp-runit"].forEach((id) =>
  $(id).addEventListener("input", () => {
    S.paper = $("pp-paper").value;
    S.orient = $("pp-orient").value;
    S.margin = parseFloat($("pp-margin").value) || 0;
    S.gap = clamp(parseFloat($("pp-gap").value) || 0, 0, 30);
    S.copies = Math.max(0, parseInt($("pp-copies").value, 10) || 0);
    S.guides = $("pp-guides").checked;
    S.multi = $("pp-multi").checked;
    S.runit = $("pp-runit").value;
    updateCount();
    drawPreview();
  })
);
$$("[data-align]").forEach((b) =>
  b.addEventListener("click", () => {
    if (b.dataset.align === "custom" && S.align !== "custom") {
      const L = layout();
      S.place = { x: L.block.x, y: L.block.y };
    }
    setAlign(b.dataset.align);
  })
);
function setAlign(a) {
  S.align = a;
  $$("[data-align]").forEach((b) => b.classList.toggle("pp-on", b.dataset.align === a));
  updateCount();
  drawPreview();
}

/* ------------------------------------------------------------------ preview */
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(rebuildPreview, 120);
}
function rebuildPreview() {
  if (!ready()) return;
  const c = cropper.getCroppedCanvas({ maxWidth: 1100, maxHeight: 1100, fillColor: S.bg, imageSmoothingQuality: "high" });
  if (!c) return;
  const asp = S.wIn / S.hIn;
  const pw = asp >= 1 ? 1100 : Math.max(8, Math.round(1100 * asp));
  const ph = asp >= 1 ? Math.max(8, Math.round(1100 / asp)) : 1100;
  const out = document.createElement("canvas");
  out.width = pw;
  out.height = ph;
  const x = out.getContext("2d");
  x.imageSmoothingQuality = "high";
  x.fillStyle = S.bg;
  x.fillRect(0, 0, pw, ph);
  x.drawImage(c, 0, 0, pw, ph);
  prev = out;
  updateCount();
  drawPreview();
}

function previewScale(paper) {
  const base = 96 / MM; // CSS pixels per mm at 100%
  if (S.zoom === "1") return base;
  if (S.zoom === "0.5") return base * 0.5;
  const sc = $("pp-prevscroll");
  const aw = sc.clientWidth - 2 * PAD - RULER;
  const ah = sc.clientHeight - 2 * PAD - RULER;
  return clamp(Math.min(aw / paper.w, ah / paper.h), 0.4, 8);
}

function drawRulers(ctx, ox, oy, pw, ph, s) {
  const inches = S.runit === "in";
  const levels = inches
    ? [[MM / 8, 0.25], [MM / 4, 0.35], [MM / 2, 0.45], [MM, 0.62]]
    : [[1, 0.25], [5, 0.4], [10, 0.62]];
  const major = inches ? MM : 10;
  ctx.save();
  ctx.fillStyle = "#e9edf5";
  ctx.fillRect(ox, oy - RULER, pw * s, RULER);
  ctx.fillRect(ox - RULER, oy, RULER, ph * s);
  ctx.fillRect(ox - RULER, oy - RULER, RULER, RULER);
  ctx.strokeStyle = "#445069";
  ctx.fillStyle = "#2b3245";
  ctx.lineWidth = 1;
  ctx.font = "10px system-ui, sans-serif";
  for (const [step, len] of levels) {
    if (step * s < 3.5) continue;
    for (let v = 0; v <= pw + 0.001; v += step) {
      const x = ox + v * s;
      ctx.beginPath(); ctx.moveTo(x, oy); ctx.lineTo(x, oy - RULER * len); ctx.stroke();
    }
    for (let v = 0; v <= ph + 0.001; v += step) {
      const y = oy + v * s;
      ctx.beginPath(); ctx.moveTo(ox, y); ctx.lineTo(ox - RULER * len, y); ctx.stroke();
    }
  }
  let every = 1;
  for (const n of [1, 2, 5, 10]) { every = n; if (n * major * s >= 34) break; }
  const lab = (i) => String(i * every);
  ctx.textBaseline = "top";
  for (let i = 0; i * every * major <= pw + 0.001; i++) {
    ctx.fillText(lab(i), ox + i * every * major * s + 2, oy - RULER + 2);
  }
  for (let i = 0; i * every * major <= ph + 0.001; i++) {
    ctx.fillText(lab(i), ox - RULER + 2, oy + i * every * major * s + 2);
  }
  ctx.fillText(inches ? "in" : "cm", ox - RULER + 4, oy - RULER + 8);
  ctx.restore();
}

function drawPreview() {
  if (S.tab !== "prev" || !prev) return;
  const cv = $("pp-prevcv");
  const L = layout();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const s = previewScale(L.paper);
  const pw = L.paper.w * s, ph = L.paper.h * s;
  const cw = PAD * 2 + RULER + pw, ch = PAD * 2 + RULER + ph;
  cv.style.width = cw + "px";
  cv.style.height = ch + "px";
  cv.width = Math.round(cw * dpr);
  cv.height = Math.round(ch * dpr);
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const ox = PAD + RULER, oy = PAD + RULER;
  lastDraw = { s, ox, oy, L };

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = 14;
  ctx.fillStyle = "#fff";
  ctx.fillRect(ox, oy, pw, ph);
  ctx.restore();

  drawRulers(ctx, ox, oy, L.paper.w, L.paper.h, s);

  if (S.margin > 0) {
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = "#b6bdd0";
    ctx.strokeRect(ox + S.margin * s, oy + S.margin * s, pw - 2 * S.margin * s, ph - 2 * S.margin * s);
    ctx.restore();
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy, pw, ph);
  ctx.clip();
  ctx.imageSmoothingQuality = "high";
  for (const it of L.items) {
    ctx.drawImage(prev, ox + it.x * s, oy + it.y * s, it.w * s, it.h * s);
    ctx.strokeStyle = "rgba(20,33,61,0.25)";
    ctx.lineWidth = 0.5;
    ctx.strokeRect(ox + it.x * s, oy + it.y * s, it.w * s, it.h * s);
  }
  ctx.strokeStyle = "#8a93a8";
  ctx.lineWidth = 0.7;
  for (const g of L.guides) {
    ctx.beginPath();
    ctx.moveTo(ox + g.x1 * s, oy + g.y1 * s);
    ctx.lineTo(ox + g.x2 * s, oy + g.y2 * s);
    ctx.stroke();
  }
  ctx.restore();
  refreshQuality();
}

/* drag to position */
const prevCv = $("pp-prevcv");
function pointerMm(ev) {
  const r = prevCv.getBoundingClientRect();
  return { x: (ev.clientX - r.left - lastDraw.ox) / lastDraw.s, y: (ev.clientY - r.top - lastDraw.oy) / lastDraw.s };
}
prevCv.addEventListener("pointerdown", (ev) => {
  if (!lastDraw || (ev.pointerType === "mouse" && ev.button !== 0)) return;
  const p = pointerMm(ev);
  const b = lastDraw.L.block;
  if (p.x < b.x || p.x > b.x + b.w || p.y < b.y || p.y > b.y + b.h) return;
  S.place = { x: b.x, y: b.y };
  if (S.align !== "custom") setAlign("custom");
  drag = { sx: p.x, sy: p.y, ox: b.x, oy: b.y };
  try { prevCv.setPointerCapture(ev.pointerId); } catch {}
  prevCv.style.cursor = "grabbing";
  ev.preventDefault();
});
prevCv.addEventListener("pointermove", (ev) => {
  if (!lastDraw) return;
  const p = pointerMm(ev);
  if (!drag) {
    const b = lastDraw.L.block;
    prevCv.style.cursor = p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h ? "grab" : "default";
    return;
  }
  S.place = { x: drag.ox + (p.x - drag.sx), y: drag.oy + (p.y - drag.sy) };
  drawPreview();
});
["pointerup", "pointercancel"].forEach((n) =>
  prevCv.addEventListener(n, () => { drag = null; prevCv.style.cursor = "default"; })
);

/* ---------------------------------------------------------------- tabs, zoom */
function setTab(t) {
  S.tab = t;
  $("pp-pane-edit").classList.toggle("pp-off", t !== "edit");
  $("pp-pane-prev").classList.toggle("pp-off", t !== "prev");
  $$("[data-tab]").forEach((b) => b.classList.toggle("pp-on", b.dataset.tab === t));
  $("pp-zoomgrp").hidden = t !== "prev";
  $("pp-badge").hidden = true;
  if (t === "prev") { rebuildPreview(); drawPreview(); }
}
$$("[data-tab]").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
$$("[data-zoom]").forEach((b) =>
  b.addEventListener("click", () => {
    S.zoom = b.dataset.zoom;
    $$("[data-zoom]").forEach((x) => x.classList.toggle("pp-on", x === b));
    drawPreview();
  })
);
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(drawPreview, 150);
});

/* --------------------------------------------------- full-size output render */
function resample(src, W, H) {
  let cur = src;
  // Pass 1: halve repeatedly while the image is at least twice the target (avoids aliasing)
  while (cur.width / 2 >= W && cur.height / 2 >= H) {
    const c = document.createElement("canvas");
    c.width = Math.max(W, Math.round(cur.width / 2));
    c.height = Math.max(H, Math.round(cur.height / 2));
    const x = c.getContext("2d");
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = "high";
    x.drawImage(cur, 0, 0, c.width, c.height);
    cur = c;
  }
  // Pass 2: final scale to the exact pixel size
  const out = document.createElement("canvas");
  out.width = W;
  out.height = H;
  const ctx = out.getContext("2d");
  ctx.fillStyle = S.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(cur, 0, 0, W, H);
  return out;
}
async function buildOutput() {
  if (!ready()) throw new Error("Add a photo first.");
  const W = Math.round(S.wIn * S.dpi), H = Math.round(S.hIn * S.dpi);
  if (W * H > 40e6) {
    throw new Error("The output would be " + W + " × " + H + " px, which is too large for a browser. Lower the DPI or the size.");
  }
  const src = cropper.getCroppedCanvas({ fillColor: S.bg, imageSmoothingEnabled: true, imageSmoothingQuality: "high" });
  if (!src) throw new Error("Could not read the crop area.");
  await new Promise((r) => setTimeout(r, 0));
  return resample(src, W, H);
}

/* DPI metadata */
let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngWithDpi(bytes, dpi) {
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // "pHYs"
  dv.setUint32(8, ppm);
  dv.setUint32(12, ppm);
  chunk[16] = 1; // pixels per meter
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  const out = new Uint8Array(bytes.length + 21);
  out.set(bytes.subarray(0, 33), 0); // signature + IHDR
  out.set(chunk, 33);
  out.set(bytes.subarray(33), 54);
  return out;
}
function jpegWithDpi(b, dpi) {
  const d = Math.min(65535, Math.round(dpi));
  const isJfif = b[2] === 0xff && b[3] === 0xe0 && b[6] === 0x4a && b[7] === 0x46 && b[8] === 0x49 && b[9] === 0x46;
  if (isJfif) {
    const o = b.slice();
    o[13] = 1;
    o[14] = d >> 8; o[15] = d & 255; o[16] = d >> 8; o[17] = d & 255;
    return o;
  }
  const seg = new Uint8Array([0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, d >> 8, d & 255, d >> 8, d & 255, 0, 0]);
  const o = new Uint8Array(b.length + seg.length);
  o.set(b.subarray(0, 2), 0);
  o.set(seg, 2);
  o.set(b.subarray(2), 2 + seg.length);
  return o;
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
const sizeTag = () => Math.round(S.wIn * MM) + "x" + Math.round(S.hIn * MM) + "mm";

/* ------------------------------------------------------------------ actions */
async function run(msg, fn) {
  busy(msg);
  status("");
  try {
    await fn();
  } catch (err) {
    console.error(err);
    status(err.message || "Something went wrong.", true);
  } finally {
    busy(null);
  }
}

$("pp-dl").addEventListener("click", () =>
  run("Preparing your photo...", async () => {
    const canvas = await buildOutput();
    const png = $("pp-fmt").value === "png";
    const blob = await canvasToBlob(canvas, png ? "image/png" : "image/jpeg", +$("pp-q").value / 100);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const out = png ? pngWithDpi(bytes, S.dpi) : jpegWithDpi(bytes, S.dpi);
    download(fileBase + "-" + sizeTag() + "-" + S.dpi + "dpi." + (png ? "png" : "jpg"), out, png ? "image/png" : "image/jpeg");
    status("Saved " + canvas.width + " × " + canvas.height + " px at " + S.dpi + " DPI.");
  })
);
$("pp-q").addEventListener("input", (e) => { $("pp-qval").textContent = e.target.value; });

async function sheetJpegBytes() {
  const canvas = await buildOutput();
  const blob = await canvasToBlob(canvas, "image/jpeg", 0.95);
  return new Uint8Array(await blob.arrayBuffer());
}

$("pp-pdf").addEventListener("click", () =>
  run("Building your PDF...", async () => {
    const L = layout();
    const pt = 72 / MM;
    const doc = await PDFDocument.create();
    const page = doc.addPage([L.paper.w * pt, L.paper.h * pt]);
    const img = await doc.embedJpg(await sheetJpegBytes());
    for (const it of L.items) {
      page.drawImage(img, { x: it.x * pt, y: (L.paper.h - it.y - it.h) * pt, width: it.w * pt, height: it.h * pt });
    }
    for (const g of L.guides) {
      page.drawLine({
        start: { x: g.x1 * pt, y: (L.paper.h - g.y1) * pt },
        end: { x: g.x2 * pt, y: (L.paper.h - g.y2) * pt },
        thickness: 0.3,
        color: rgb(0.5, 0.5, 0.5),
      });
    }
    doc.setProducer("Toolairy Passport Photo Maker");
    download(fileBase + "-" + sizeTag() + "-sheet.pdf", await doc.save(), "application/pdf");
    status("PDF saved. It is " + f2(L.paper.w) + " × " + f2(L.paper.h) + " mm with the photo at exact size.");
  })
);

$("pp-print").addEventListener("click", () =>
  run("Preparing the sheet...", async () => {
    const L = layout();
    const blob = new Blob([await sheetJpegBytes()], { type: "image/jpeg" });
    const url = URL.createObjectURL(blob);

    let root = $("pp-print");
    if (!root) { root = document.createElement("div"); root.id = "pp-print"; document.body.appendChild(root); }
    root.innerHTML = "";
    root.style.cssText = "position:relative;overflow:hidden;background:#fff;width:" + L.paper.w + "mm;height:" + L.paper.h + "mm;";
    const imgs = [];
    for (const it of L.items) {
      const im = document.createElement("img");
      im.src = url;
      im.style.cssText = "position:absolute;left:" + it.x + "mm;top:" + it.y + "mm;width:" + it.w + "mm;height:" + it.h + "mm;";
      root.appendChild(im);
      imgs.push(im);
    }
    for (const g of L.guides) {
      const d = document.createElement("div");
      const vertical = g.x1 === g.x2;
      d.style.cssText =
        "position:absolute;background:#808080;left:" + Math.min(g.x1, g.x2) + "mm;top:" + Math.min(g.y1, g.y2) + "mm;" +
        (vertical ? "width:0.2mm;height:" + Math.abs(g.y2 - g.y1) + "mm;" : "height:0.2mm;width:" + Math.abs(g.x2 - g.x1) + "mm;");
      root.appendChild(d);
    }
    let st = $("pp-print-style");
    if (!st) { st = document.createElement("style"); st.id = "pp-print-style"; document.head.appendChild(st); }
    st.textContent = "@page { size: " + L.paper.w + "mm " + L.paper.h + "mm; margin: 0; }";
    await Promise.all(imgs.map((im) => im.decode().catch(() => {})));
    busy(null);
    window.print();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    status("In the print dialog, set Scale to 100%, turn off Fit to page, and set Margins to None.");
  })
);

$("pp-reset").addEventListener("click", () => {
  if (!ready()) return;
  Object.assign(S, {
    wIn: 35 / MM, hIn: 45 / MM, unit: "mm", dpi: 300, lock: true, mode: "fixed",
    bg: "#ffffff", paper: "a4", orient: "portrait", margin: 5, align: "center", place: { x: 0, y: 0 },
    multi: false, gap: 3, copies: 0, guides: true, runit: "cm", zoom: "fit",
  });
  $("pp-preset").value = "p35x45";
  $("pp-unit").value = "mm";
  $("pp-lock").checked = true;
  $("pp-bg").value = "#ffffff";
  $("pp-paper").value = "a4";
  $("pp-orient").value = "portrait";
  $("pp-margin").value = "5";
  $("pp-multi").checked = false;
  $("pp-gap").value = "3";
  $("pp-copies").value = "";
  $("pp-guides").checked = true;
  $("pp-runit").value = "cm";
  $$("[data-zoom]").forEach((b) => b.classList.toggle("pp-on", b.dataset.zoom === "fit"));
  setMode("fixed");
  setDpi(300);
  setAlign("center");
  S.flipX = 1; S.flipY = 1;
  cropper.reset();
  cropper.scaleX(1);
  cropper.scaleY(1);
  setRot(0);
  applyAspect(true);
  renderInputs();
  afterSize();
  status("Everything was reset.");
});

/* -------------------------------------------------------------------- inputs */
const drop = $("pp-drop");
$("pp-file").addEventListener("change", (e) => { loadFile(e.target.files[0]); e.target.value = ""; });
["dragenter", "dragover"].forEach((n) => document.addEventListener(n, (e) => {
  if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes("Files")) return;
  e.preventDefault();
  drop.classList.add("pp-over");
}));
["dragleave", "drop"].forEach((n) => document.addEventListener(n, () => drop.classList.remove("pp-over")));
document.addEventListener("drop", (e) => {
  if (!e.dataTransfer || !e.dataTransfer.files.length) return;
  e.preventDefault();
  loadFile(e.dataTransfer.files[0]);
});

function updateUi() {
  $$("[data-needs-img]").forEach((b) => { b.disabled = !ready(); });
}

/* ---------------------------------------------------------------------- init */
setDpi(300);
updateUi();
updateCount();

/* keep the pinned preview just below the site header */
function setStickyTop() {
  const h = document.querySelector(".site-header");
  document.documentElement.style.setProperty("--pp-top", (h ? h.offsetHeight : 72) + 8 + "px");
}
setStickyTop();
window.addEventListener("resize", setStickyTop);