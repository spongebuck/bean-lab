'use strict';

/* Saul's Bean Lab
 *
 * Turns an image into a bead pattern. Everything happens in this tab: the image is
 * decoded, sampled and quantised locally and never leaves the browser.
 *
 *   engine    image → grid of cells → colours (a real bead brand, or free colours)
 *   viewer    pan / zoom canvas with rulers, highlighting and a "finished beads" view
 *   panels    settings on the left, materials list on the right
 *   output    PNG sheet, per-board print pages, copyable shopping list
 */

// ---------------------------------------------------------------------------
// Helpers and constants
// ---------------------------------------------------------------------------

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const fmt = (n) => n.toLocaleString('zh-CN');
const cm = (mm) => String(Math.round(mm) / 10);
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const TAU = Math.PI * 2;

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

const MIN_CELLS = 5;
const MAX_CELLS = 500;
const WORKING_EDGE = 1200; // decoded images are kept at most this large
const STORAGE_KEY = 'bean-lab:settings:v2';

const INK = '#191815';
const PAPER = '#faf9f6';
const PANEL = '#e9e7e6';
const MUTED = '#5d5751';
const BOARD_LINE = '#cf5a3c';
const FONT_MONO = '"Anthropic Mono", "SFMono-Regular", ui-monospace, Menlo, monospace';
const FONT_SANS = '"Anthropic Sans", -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';

// ---------------------------------------------------------------------------
// Colour science
// ---------------------------------------------------------------------------

const LINEAR = Float64Array.from({ length: 256 }, (_, i) => {
  const v = i / 255;
  return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
});
const labF = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

/** sRGB (0–255) → CIE Lab (D65). Distances in Lab track what the eye sees far better than RGB. */
function rgbToLab(r, g, b) {
  const R = LINEAR[Math.round(r)], G = LINEAR[Math.round(g)], B = LINEAR[Math.round(b)];
  const x = labF((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
  const y = labF(R * 0.2126 + G * 0.7152 + B * 0.0722);
  const z = labF((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

const labDist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgbToHex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const inkFor = (lab) => (lab[0] > 62 ? '#1f1d1a' : '#ffffff');

/** A short Chinese description of a colour ("浅蓝", "灰绿", "棕色"…), for codes that have no name. */
function describeColor([r, g, b]) {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d < 0.07 || s < 0.1) return l > 0.93 ? '白色' : l > 0.78 ? '浅灰' : l > 0.5 ? '灰色' : l > 0.22 ? '深灰' : '黑色';

  let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h = (h * 60 + 360) % 360;

  // Muted warm colours read as browns and beiges, not as "greyish red".
  const yellowish = h >= 14 && h < 68;
  if (l > 0.9 && yellowish) return '米白';
  if ((h < 45 || h >= 340) && s < 0.35 && l < 0.45) return l < 0.25 ? '深棕' : '棕色';
  if (yellowish && s < 0.32) return l > 0.78 ? '米色' : l > 0.5 ? '浅褐' : '褐色';

  let base;
  if (h < 14 || h >= 340) base = l > 0.72 ? '粉' : l < 0.28 ? '酒红' : '红';
  else if (h < 42) base = l < 0.42 ? '棕' : s < 0.55 && l > 0.68 ? '米' : l > 0.8 ? '杏' : '橙';
  else if (h < 68) base = l < 0.36 ? '橄榄' : s < 0.5 && l > 0.72 ? '米' : '黄';
  else if (h < 95) base = '黄绿';
  else if (h < 165) base = '绿';
  else if (h < 195) base = '青';
  else if (h < 255) base = '蓝';
  else if (h < 290) base = '紫';
  else base = l > 0.68 ? '粉' : '玫红';

  if (base === '橄榄') return '橄榄绿';
  if (['米', '杏', '酒红'].includes(base)) return base.length === 1 ? base + '色' : base;
  if (base === '棕') return l < 0.25 ? '深棕' : '棕色';
  const tone = l > 0.78 ? '浅' : l < 0.3 ? '深' : '';
  const dull = s < 0.22 ? '灰' : '';
  const name = tone + dull + base;
  return name.length === 1 ? name + '色' : name;
}

// ---------------------------------------------------------------------------
// Bead brands (data in palettes.js)
// ---------------------------------------------------------------------------

const BRANDS = Object.fromEntries(
  Object.entries(window.BEAD_BRANDS || {}).map(([key, brand]) => [
    key,
    {
      key,
      label: brand.label,
      colors: brand.colors.map(([code, hex, english]) => {
        const rgb = hexToRgb(hex);
        return { code, hex: '#' + hex, rgb, lab: rgbToLab(...rgb), name: describeColor(rgb), english: english || '' };
      }),
    },
  ]),
);

const brandLabel = (key) => (BRANDS[key] ? `${BRANDS[key].label} 色卡` : '自由配色');
/** How a colour is referred to in text: "A12", "#3" for free colours, "3 · 80-15211" when the cell label differs. */
const colorRef = (c, brand) => (brand === 'free' ? `#${c.code}` : c.label !== c.code ? `${c.label} · ${c.code}` : c.code);

// ---------------------------------------------------------------------------
// Settings and state
// ---------------------------------------------------------------------------

const DEFAULTS = {
  longest: 29,
  lockRatio: true,
  fit: 'contain',
  brand: BRANDS.mard ? 'mard' : 'free',
  colors: 16,
  removeBg: false,
  despeckle: false,
  beadSize: 5,
  boardSize: 29,
  showGrid: true,
  showCodes: true,
  showBoards: true,
  view: 'chart',
};

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
  } catch {
    /* private mode or corrupt value: fall back to defaults */
  }
  const s = { ...DEFAULTS, ...saved };
  s.longest = clamp(Math.round(+s.longest) || DEFAULTS.longest, MIN_CELLS, MAX_CELLS);
  s.colors = clamp(Math.round(+s.colors) || DEFAULTS.colors, 2, 48);
  s.boardSize = clamp(Math.round(+s.boardSize) || DEFAULTS.boardSize, 10, 100);
  s.beadSize = s.beadSize === 2.6 ? 2.6 : 5;
  if (s.brand !== 'free' && !BRANDS[s.brand]) s.brand = DEFAULTS.brand;
  if (!['contain', 'cover'].includes(s.fit)) s.fit = 'contain';
  if (!['chart', 'beads'].includes(s.view)) s.view = 'chart';
  return s;
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
  } catch {
    /* storage unavailable — settings just won't persist */
  }
}

const state = {
  settings: loadSettings(),
  width: 29,
  height: 29,
  adjust: { brightness: 0, contrast: 0, saturation: 0 },
  source: null, // canvas holding the decoded image
  sourceName: '',
  title: '',
  pattern: null, // { width, height, cells, colors, total, brand }
  highlight: -1, // index into pattern.colors, or -1
  done: new Set(), // indexes marked as finished
};

// ---------------------------------------------------------------------------
// Engine: image → cells
// ---------------------------------------------------------------------------

/** Halve a canvas until the next halving would undershoot the target. One big
 *  drawImage downscale skips most source pixels and aliases; halving averages them. */
function halveTowardsSmooth(source, targetW, targetH) {
  let current = source;
  while (current.width / 2 >= targetW && current.height / 2 >= targetH && current.width > 2 && current.height > 2) {
    const next = makeCanvas(current.width / 2, current.height / 2);
    const ctx = next.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(current, 0, 0, next.width, next.height);
    current = next;
  }
  return current;
}

/** Decode-time copy of the image, capped at WORKING_EDGE so every later step is cheap.
 *  Also notes whether the image is a cutout (transparent around its edge). */
function toWorkingCanvas(image) {
  const w = image.naturalWidth || image.width;
  const h = image.naturalHeight || image.height;
  const scale = Math.min(1, WORKING_EDGE / Math.max(w, h));
  let out = makeCanvas(w, h);
  out.getContext('2d').drawImage(image, 0, 0, w, h);
  if (scale < 1) {
    const tw = Math.round(w * scale), th = Math.round(h * scale);
    const halved = halveTowardsSmooth(out, tw, th);
    out = makeCanvas(tw, th);
    const ctx = out.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(halved, 0, 0, tw, th);
  }
  const data = out.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, out.width, out.height).data;
  let clear = 0, total = 0;
  const probe = (x, y) => { total++; if (data[(y * out.width + x) * 4 + 3] < 128) clear++; };
  for (let x = 0; x < out.width; x += 2) { probe(x, 0); probe(x, out.height - 1); }
  for (let y = 0; y < out.height; y += 2) { probe(0, y); probe(out.width - 1, y); }
  out.cutout = clear > total * 0.3;
  return out;
}

/** Draw the image onto a W × H canvas, fitted whole (contain) or cropped (cover). */
function drawFitted(source, W, H, fit) {
  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  // Pixel art keeps hard edges: nearest-neighbour, and no smoothing halving steps.
  ctx.imageSmoothingEnabled = !source.pixelArt;
  const halveTowards = source.pixelArt ? (src) => src : halveTowardsSmooth;
  const sw = source.width, sh = source.height;
  if (fit === 'cover') {
    const scale = Math.max(W / sw, H / sh);
    const halved = halveTowards(source, sw * scale, sh * scale);
    const k = halved.width / sw;
    const cw = W / scale, ch = H / scale;
    ctx.drawImage(halved, ((sw - cw) / 2) * k, ((sh - ch) / 2) * k, cw * k, ch * k, 0, 0, W, H);
  } else {
    const scale = Math.min(W / sw, H / sh);
    const dw = sw * scale, dh = sh * scale;
    ctx.drawImage(halveTowards(source, dw, dh), (W - dw) / 2, (H - dh) / 2, dw, dh);
  }
  return ctx.getImageData(0, 0, W, H).data;
}

/**
 * Sample the image onto a width × height grid, one RGB colour (or "empty") per cell.
 *
 * Each cell is supersampled and takes the colour that covers most of it, rather than
 * the average. Averaging turns every anti-aliased edge into an in-between shade — a
 * red cap with a dark outline grows a ring of brown — and each shade then claims a
 * bead colour of its own. Where no colour dominates (photo texture), the cell falls
 * back to the average.
 */
function rasterize(source, width, height, fit) {
  const f = clamp(Math.floor(Math.sqrt(1600000 / (width * height))), 1, 6);
  const W = width * f;
  const data = drawFitted(source, W, height * f, fit);
  const n = width * height;
  const rgb = new Float32Array(n * 3);
  const empty = new Uint8Array(n);
  const samples = f * f;
  const counts = new Int32Array(samples);
  const sums = new Float64Array(samples * 3);
  const JOIN2 = 30 * 30; // samples this close (RGB) count as one colour, so JPEG noise doesn't split them

  for (let cy = 0; cy < height; cy++) {
    for (let cx = 0; cx < width; cx++) {
      let groups = 0, opaque = 0, ar = 0, ag = 0, ab = 0;
      for (let sy = 0; sy < f; sy++) {
        let p = ((cy * f + sy) * W + cx * f) * 4;
        for (let sx = 0; sx < f; sx++, p += 4) {
          const a = data[p + 3] / 255;
          if (a < 0.5) continue;
          // Half-transparent edges are composited onto white, like a sticker on paper.
          const r = data[p] * a + 255 * (1 - a), g = data[p + 1] * a + 255 * (1 - a), b = data[p + 2] * a + 255 * (1 - a);
          ar += r; ag += g; ab += b; opaque++;
          let j = 0;
          for (; j < groups; j++) {
            const k = counts[j];
            const dr = sums[j * 3] / k - r, dg = sums[j * 3 + 1] / k - g, db = sums[j * 3 + 2] / k - b;
            if (dr * dr + dg * dg + db * db < JOIN2) break;
          }
          if (j === groups) { counts[j] = 0; sums[j * 3] = sums[j * 3 + 1] = sums[j * 3 + 2] = 0; groups++; }
          counts[j]++; sums[j * 3] += r; sums[j * 3 + 1] += g; sums[j * 3 + 2] += b;
        }
      }
      const i = cy * width + cx;
      if (opaque * 2 < samples) { empty[i] = 1; continue; }
      let top = 0;
      for (let j = 1; j < groups; j++) if (counts[j] > counts[top]) top = j;
      if (counts[top] >= Math.max(2, opaque * 0.25)) {
        rgb[i * 3] = sums[top * 3] / counts[top];
        rgb[i * 3 + 1] = sums[top * 3 + 1] / counts[top];
        rgb[i * 3 + 2] = sums[top * 3 + 2] / counts[top];
      } else {
        rgb[i * 3] = ar / opaque; rgb[i * 3 + 1] = ag / opaque; rgb[i * 3 + 2] = ab / opaque;
      }
    }
  }
  return { rgb, empty };
}

function applyAdjustments(rgb, { brightness, contrast, saturation }) {
  if (!brightness && !contrast && !saturation) return;
  const offset = brightness * 1.6;
  const cf = 1 + (contrast / 50) * 0.8;
  const sf = 1 + saturation / 50;
  for (let i = 0; i < rgb.length; i += 3) {
    let r = (rgb[i] - 128) * cf + 128 + offset;
    let g = (rgb[i + 1] - 128) * cf + 128 + offset;
    let b = (rgb[i + 2] - 128) * cf + 128 + offset;
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    rgb[i] = gray + (r - gray) * sf;
    rgb[i + 1] = gray + (g - gray) * sf;
    rgb[i + 2] = gray + (b - gray) * sf;
  }
}

/** Clear the backdrop: walk in from the border, find the colour the image's outer
 *  edge mostly shares, and flood-fill it away. Images without one are left alone. */
function removeBackground(rgb, empty, width, height) {
  const n = width * height;
  const labs = new Float32Array(n * 3);
  const hasLab = new Uint8Array(n);
  const labAt = (i) => {
    if (!hasLab[i]) {
      const [L, a, b] = rgbToLab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
      labs[i * 3] = L; labs[i * 3 + 1] = a; labs[i * 3 + 2] = b;
      hasLab[i] = 1;
    }
    return [labs[i * 3], labs[i * 3 + 1], labs[i * 3 + 2]];
  };
  const neighbours = (i, visit) => {
    const x = i % width;
    if (x > 0) visit(i - 1);
    if (x < width - 1) visit(i + 1);
    if (i >= width) visit(i - width);
    if (i < n - width) visit(i + width);
  };

  // 1. Through transparent cells to the first solid ones: the image's outer edge.
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  const edge = [];
  const reach = (i) => {
    if (seen[i]) return;
    seen[i] = 1;
    if (empty[i]) queue[tail++] = i;
    else edge.push(i);
  };
  for (let x = 0; x < width; x++) { reach(x); reach(n - width + x); }
  for (let y = 0; y < height; y++) { reach(y * width); reach(y * width + width - 1); }
  while (head < tail) neighbours(queue[head++], reach);
  if (!edge.length) return;

  // 2. The colour most of that edge agrees on.
  const TOL2 = 13 * 13;
  const edgeLabs = edge.map(labAt);
  const stride = Math.max(1, Math.floor(edgeLabs.length / 160));
  let backdrop = null, support = 0;
  for (let j = 0; j < edgeLabs.length; j += stride) {
    let count = 0;
    for (const lab of edgeLabs) if (labDist2(lab, edgeLabs[j]) < TOL2) count++;
    if (count > support) { support = count; backdrop = edgeLabs[j]; }
  }
  if (support < edgeLabs.length * 0.35) return;

  // 3. Flood from the matching edge cells through everything close to that colour.
  const FLOOD2 = 16 * 16;
  const flooded = new Uint8Array(n);
  head = tail = 0;
  const spread = (i) => {
    if (flooded[i]) return;
    if (!empty[i] && labDist2(labAt(i), backdrop) >= FLOOD2) return;
    flooded[i] = 1;
    empty[i] = 1;
    queue[tail++] = i;
  };
  for (const i of edge) spread(i);
  while (head < tail) neighbours(queue[head++], spread);
}

/** Group cells into colour buckets (5 bits per channel) so palette work scales with
 *  the number of distinct colours, not the number of cells. */
function histogram(rgb, empty) {
  const n = empty.length;
  const index = new Int32Array(32768).fill(-1);
  const bucketOf = new Int32Array(n).fill(-1);
  const sums = [];
  for (let i = 0; i < n; i++) {
    if (empty[i]) continue;
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let k = index[key];
    if (k < 0) {
      k = index[key] = sums.length;
      sums.push([0, 0, 0, 0]);
    }
    const sum = sums[k];
    sum[0] += r; sum[1] += g; sum[2] += b; sum[3]++;
    bucketOf[i] = k;
  }
  const buckets = sums.map(([r, g, b, count]) => {
    const rgbMean = [r / count, g / count, b / count];
    return { rgb: rgbMean, lab: rgbToLab(...rgbMean), n: count };
  });
  return { bucketOf, buckets };
}

/** Leader clustering: buckets within `radius` (ΔE) of a more common bucket join it.
 *  A flat area with a little noise becomes one colour, even when it sits halfway
 *  between two bead colours and would otherwise speckle across both. */
function mergeNearby(buckets, radius) {
  const r2 = radius * radius;
  const order = buckets.map((_, b) => b).sort((a, b) => buckets[b].n - buckets[a].n);
  const groupOf = new Int32Array(buckets.length);
  const groups = [];
  // Leaders are filed in a Lab grid of `radius`-sized cells; a match can only be in the 27 around.
  const grid = new Map();
  const cellKey = (L, a, b) => `${L},${a},${b}`;
  for (const b of order) {
    const { lab, rgb, n } = buckets[b];
    const [gl, ga, gb] = lab.map((v) => Math.floor(v / radius));
    let g = -1;
    search: for (let dl = -1; dl <= 1; dl++) {
      for (let da = -1; da <= 1; da++) {
        for (let db = -1; db <= 1; db++) {
          for (const candidate of grid.get(cellKey(gl + dl, ga + da, gb + db)) || []) {
            if (labDist2(groups[candidate].leader, lab) < r2) { g = candidate; break search; }
          }
        }
      }
    }
    if (g < 0) {
      g = groups.length;
      groups.push({ leader: lab, sum: [0, 0, 0], rgbSum: [0, 0, 0], n: 0 });
      const key = cellKey(gl, ga, gb);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(g);
    }
    const group = groups[g];
    for (let c = 0; c < 3; c++) { group.sum[c] += lab[c] * n; group.rgbSum[c] += rgb[c] * n; }
    group.n += n;
    groupOf[b] = g;
  }
  const merged = groups.map((g) => ({ lab: g.sum.map((v) => v / g.n), rgb: g.rgbSum.map((v) => v / g.n), n: g.n }));
  return { merged, groupOf };
}

/** Pick at most `limit` colours from a brand. Every bucket starts on its nearest bead
 *  colour; then the colour whose removal costs least (cells × extra colour error) is
 *  dropped, one at a time. Small but distinctive areas — eyes, outlines — are
 *  expensive to remove, so they survive. */
function brandPalette(buckets, candidates, limit) {
  const B = buckets.length;
  const best = new Int32Array(B), second = new Int32Array(B);
  const dBest = new Float64Array(B), dSecond = new Float64Array(B);
  let active = candidates.map((_, p) => p);

  const nearestTwo = (b) => {
    const lab = buckets[b].lab;
    let p1 = -1, p2 = -1, d1 = Infinity, d2 = Infinity;
    for (const p of active) {
      const d = labDist2(lab, candidates[p].lab);
      if (d < d1) { p2 = p1; d2 = d1; p1 = p; d1 = d; } else if (d < d2) { p2 = p; d2 = d; }
    }
    best[b] = p1; dBest[b] = Math.sqrt(d1);
    second[b] = p2; dSecond[b] = Math.sqrt(d2);
  };

  for (let b = 0; b < B; b++) nearestTwo(b);
  const used = [...new Set(best)];
  if (used.length > limit) {
    active = used;
    for (let b = 0; b < B; b++) nearestTwo(b);
    while (active.length > limit) {
      const cost = new Float64Array(candidates.length);
      for (let b = 0; b < B; b++) cost[best[b]] += buckets[b].n * (dSecond[b] - dBest[b]);
      let victim = active[0];
      for (const p of active) if (cost[p] < cost[victim]) victim = p;
      active = active.filter((p) => p !== victim);
      for (let b = 0; b < B; b++) if (best[b] === victim || second[b] === victim) nearestTwo(b);
    }
  }
  return { assign: best, entries: candidates };
}

/** Free colours: weighted k-means in Lab. Seeds favour colours that are both common
 *  and far from those already chosen, so a big white backdrop takes one slot, not five. */
function freePalette(buckets, limit) {
  const B = buckets.length;
  const k = Math.min(limit, B);
  let first = 0;
  for (let b = 1; b < B; b++) if (buckets[b].n > buckets[first].n) first = b;
  const centers = [buckets[first].lab.slice()];
  const minD = new Float64Array(B).fill(Infinity);
  while (centers.length < k) {
    const last = centers[centers.length - 1];
    let pick = -1, score = 0;
    for (let b = 0; b < B; b++) {
      const d = labDist2(buckets[b].lab, last);
      if (d < minD[b]) minD[b] = d;
      // Only colours clearly apart from every pick so far (ΔE ≥ 8) are candidates.
      const s = minD[b] >= 64 ? Math.sqrt(buckets[b].n) * minD[b] : 0;
      if (s > score) { score = s; pick = b; }
    }
    if (pick < 0) break;
    centers.push(buckets[pick].lab.slice());
  }

  const assign = new Int32Array(B).fill(-1);
  let sums = [];
  for (let iter = 0; iter < 14; iter++) {
    let changed = false;
    for (let b = 0; b < B; b++) {
      let j = 0, dj = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = labDist2(buckets[b].lab, centers[c]);
        if (d < dj) { dj = d; j = c; }
      }
      if (assign[b] !== j) { assign[b] = j; changed = true; }
    }
    sums = centers.map(() => [0, 0, 0, 0, 0, 0, 0]);
    for (let b = 0; b < B; b++) {
      const { lab, rgb, n } = buckets[b];
      const s = sums[assign[b]];
      s[0] += lab[0] * n; s[1] += lab[1] * n; s[2] += lab[2] * n;
      s[3] += rgb[0] * n; s[4] += rgb[1] * n; s[5] += rgb[2] * n; s[6] += n;
    }
    sums.forEach((s, c) => { if (s[6]) centers[c] = [s[0] / s[6], s[1] / s[6], s[2] / s[6]]; });
    if (!changed) break;
  }

  const entries = sums.map((s) => {
    const rgb = s[6] ? [s[3] / s[6], s[4] / s[6], s[5] / s[6]].map(Math.round) : [255, 255, 255];
    return { code: '', hex: rgbToHex(rgb), rgb, lab: rgbToLab(...rgb), name: describeColor(rgb), english: '' };
  });
  return { assign, entries };
}

/** Fold lone beads into their surroundings: a cell that matches none of its
 *  neighbours takes the colour most of them share (or goes empty among empties). */
function despeckle(cells, width, height) {
  const src = cells.slice();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const v = src[i];
      if (v < 0) continue;
      const around = [];
      if (x > 0) around.push(src[i - 1]);
      if (x < width - 1) around.push(src[i + 1]);
      if (y > 0) around.push(src[i - width]);
      if (y < height - 1) around.push(src[i + width]);
      if (around.includes(v)) continue;
      const tally = new Map();
      for (const a of around) tally.set(a, (tally.get(a) || 0) + 1);
      let winner = null, votes = 0;
      for (const [a, count] of tally) if (count > votes) { winner = a; votes = count; }
      if (votes >= Math.max(2, around.length - 1)) cells[i] = winner;
    }
  }
}

/** Count, drop unused colours, sort by usage and renumber. */
function finalizePattern(cells, entries, width, height, brand) {
  const counts = new Int32Array(entries.length);
  for (const v of cells) if (v >= 0) counts[v]++;
  const used = entries
    .map((entry, i) => ({ entry, i, count: counts[i] }))
    .filter((u) => u.count > 0)
    .sort((a, b) => b.count - a.count || a.entry.code.localeCompare(b.entry.code, 'en', { numeric: true }));
  const remap = new Int16Array(entries.length).fill(-1);
  used.forEach((u, k) => { remap[u.i] = k; });
  for (let i = 0; i < cells.length; i++) if (cells[i] >= 0) cells[i] = remap[cells[i]];
  // `label` is what goes inside a cell: the brand code when it is short enough to read
  // there (MARD "A12"), otherwise this pattern's own number for the colour (Perler's
  // "80-15211" would be illegible), which the legend maps back to the code.
  const colors = used.map((u, k) => {
    const code = brand === 'free' ? String(k + 1) : u.entry.code;
    return { ...u.entry, code, label: code.length <= 4 ? code : String(k + 1), count: u.count };
  });
  const total = colors.reduce((sum, c) => sum + c.count, 0);
  return { width, height, cells, colors, total, brand };
}

function buildPattern(source, o) {
  const { width, height } = o;
  const n = width * height;
  const { rgb, empty } = rasterize(source, width, height, o.fit);
  applyAdjustments(rgb, o.adjust);
  for (let i = 0; i < rgb.length; i++) rgb[i] = clamp(Math.round(rgb[i]), 0, 255);
  // A cutout's background is already transparent; its outer edge is the subject's own
  // outline, which the backdrop search would otherwise mistake for a backdrop.
  if (o.removeBg && !source.cutout) removeBackground(rgb, empty, width, height);

  const { bucketOf, buckets } = histogram(rgb, empty);
  const cells = new Int16Array(n).fill(-1);
  if (!buckets.length) return finalizePattern(cells, [], width, height, o.brand);

  const { merged, groupOf } = mergeNearby(buckets, 7);
  const picked = o.brand === 'free' || !BRANDS[o.brand]
    ? freePalette(merged, o.colors)
    : brandPalette(merged, BRANDS[o.brand].colors, o.colors);
  const { entries } = picked;
  for (let i = 0; i < n; i++) if (bucketOf[i] >= 0) cells[i] = picked.assign[groupOf[bucketOf[i]]];
  if (o.despeckle && !source.pixelArt) despeckle(cells, width, height);
  return finalizePattern(cells, entries, width, height, o.brand);
}

// ---------------------------------------------------------------------------
// Drawing (shared by the viewer, the PNG sheet and the print pages)
// ---------------------------------------------------------------------------

/** Per-colour fill and label ink, faded when another colour is highlighted or this one is done. */
function colorStyles(pattern, highlight = -1, done = new Set()) {
  return pattern.colors.map((c, i) => {
    const faded = highlight >= 0 ? i !== highlight : done.has(i);
    const rgb = faded ? c.rgb.map((v) => v + (246 - v) * 0.8) : c.rgb;
    return { rgb, fill: rgbToHex(rgb), ink: faded ? 'rgba(25,24,21,0.2)' : inkFor(c.lab), faded };
  });
}

/** The pattern at one pixel per cell, for drawing very zoomed-out views in one call. */
function cellBitmap(pattern, styles) {
  const canvas = makeCanvas(pattern.width, pattern.height);
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(pattern.width, pattern.height);
  pattern.cells.forEach((v, i) => {
    if (v < 0) return;
    const [r, g, b] = styles[v].rgb;
    img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255;
  });
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function drawBead(ctx, cx, cy, r, fill, shaded) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, TAU);
  ctx.arc(cx, cy, r * 0.36, 0, TAU, true);
  ctx.fill();
  if (!shaded) return;
  ctx.lineWidth = r * 0.16;
  ctx.strokeStyle = 'rgba(255,255,255,0.38)';
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.68, Math.PI * 1.05, Math.PI * 1.5);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0,0,0,0.13)';
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.7, Math.PI * 0.05, Math.PI * 0.55);
  ctx.stroke();
}

/**
 * Paint cells [c0,c1) × [r0,r1) of a pattern whose cell (0,0) sits at (ox, oy),
 * `s` px per cell. Grid tiers and board lines follow absolute coordinates, so a
 * print page of columns 30–58 shows the same bold lines as the whole chart.
 */
function paintCells(ctx, pattern, o) {
  const { ox, oy, s, c0, c1, r0, r1, styles } = o;
  const dpr = o.dpr || 1;
  const snap = (v) => Math.round(v * dpr) / dpr;
  const { width: cols, cells, colors } = pattern;
  const visible = (c1 - c0) * (r1 - r0);
  if (visible <= 0) return;

  if (o.beads && s >= 4 && visible <= 60000) {
    const shaded = s >= 9;
    for (let r = r0; r < r1; r++) {
      for (let c = c0; c < c1; c++) {
        const v = cells[r * cols + c];
        const cx = ox + (c + 0.5) * s, cy = oy + (r + 0.5) * s;
        if (v < 0) {
          if (s >= 8) {
            ctx.fillStyle = '#e2ddd5';
            ctx.beginPath();
            ctx.arc(cx, cy, s * 0.12, 0, TAU);
            ctx.fill();
          }
          continue;
        }
        drawBead(ctx, cx, cy, s * 0.46, styles[v].fill, shaded);
      }
    }
  } else if (visible > 40000 || s < 3) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(o.bitmap || cellBitmap(pattern, styles), c0, r0, c1 - c0, r1 - r0, ox + c0 * s, oy + r0 * s, (c1 - c0) * s, (r1 - r0) * s);
  } else {
    // Runs of one colour become one rect; snapped edges keep neighbours seamless.
    for (let r = r0; r < r1; r++) {
      const y0 = snap(oy + r * s), y1 = snap(oy + (r + 1) * s);
      let c = c0;
      while (c < c1) {
        const v = cells[r * cols + c];
        let end = c + 1;
        while (end < c1 && cells[r * cols + end] === v) end++;
        if (v >= 0) {
          const x0 = snap(ox + c * s), x1 = snap(ox + end * s);
          ctx.fillStyle = styles[v].fill;
          ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
        }
        c = end;
      }
    }
  }

  const top = oy + r0 * s, bottom = oy + r1 * s, left = ox + c0 * s, right = ox + c1 * s;
  // Lines every `step` cells, leaving out multiples of `skip` (a heavier tier draws those).
  const lines = (step, skip, color, width, dash = [], inner = false) => {
    const lw = Math.max(1, Math.round(width * dpr)) / dpr;
    const half = Math.round(lw * dpr) % 2 ? 0.5 / dpr : 0;
    ctx.beginPath();
    for (let c = Math.ceil(c0 / step) * step; c <= c1; c += step) {
      if ((skip && c % skip === 0) || (inner && (c === 0 || c === cols))) continue;
      const x = snap(ox + c * s) + half;
      ctx.moveTo(x, top); ctx.lineTo(x, bottom);
    }
    for (let r = Math.ceil(r0 / step) * step; r <= r1; r += step) {
      if ((skip && r % skip === 0) || (inner && (r === 0 || r === pattern.height))) continue;
      const y = snap(oy + r * s) + half;
      ctx.moveTo(left, y); ctx.lineTo(right, y);
    }
    ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.stroke();
    ctx.setLineDash([]);
  };

  if (o.grid) {
    if (s >= 5) lines(1, 5, 'rgba(25,24,21,0.14)', 1);
    if (s >= 2.5) lines(5, 10, 'rgba(25,24,21,0.34)', 1);
    lines(10, 0, 'rgba(25,24,21,0.62)', s >= 12 ? 1.5 : 1);
    ctx.strokeStyle = 'rgba(25,24,21,0.62)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(ox, oy, cols * s, pattern.height * s);
  }
  if (o.boards) {
    lines(o.boards, 0, BOARD_LINE, Math.max(1.5, s * 0.08), [Math.max(4, s * 0.5), Math.max(3, s * 0.3)], true);
  }

  if (o.codes && !o.beads && s >= 12) {
    const longest = Math.max(1, ...colors.map((c) => c.label.length));
    const size = Math.min(s * 0.42, (s * 0.84) / (longest * 0.62));
    if (size >= 6) {
      ctx.font = `600 ${size.toFixed(1)}px ${FONT_MONO}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let r = r0; r < r1; r++) {
        for (let c = c0; c < c1; c++) {
          const v = cells[r * cols + c];
          if (v < 0) continue;
          ctx.fillStyle = styles[v].ink;
          ctx.fillText(colors[v].label, ox + (c + 0.5) * s, oy + (r + 0.5) * s + size * 0.06);
        }
      }
    }
  }
}

/** Numbers along the top and left edges. `step` is chosen so labels never collide. */
function paintRulers(ctx, o) {
  const { ox, oy, s, c0, c1, r0, r1, size, font, color, hover } = o;
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 250].find((n) => n * s >= o.minGap) || 500;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const label = (n, x, y, active) => {
    if (active) {
      const w = Math.max(size * 0.9, ctx.measureText(String(n)).width + 8);
      ctx.fillStyle = INK;
      ctx.beginPath();
      ctx.roundRect ? ctx.roundRect(x - w / 2, y - size * 0.36, w, size * 0.72, size * 0.36) : ctx.rect(x - w / 2, y - size * 0.36, w, size * 0.72);
      ctx.fill();
      ctx.fillStyle = PAPER;
    } else {
      ctx.fillStyle = color;
    }
    ctx.fillText(String(n), x, y + 0.5);
  };
  for (let c = c0; c < c1; c++) {
    const n = c + 1, active = hover && hover.col === c;
    if (active || n === 1 || n % step === 0) label(n, ox + (c + 0.5) * s, o.top + size / 2, active);
  }
  for (let r = r0; r < r1; r++) {
    const n = r + 1, active = hover && hover.row === r;
    if (active || n === 1 || n % step === 0) label(n, o.left + size / 2, oy + (r + 0.5) * s, active);
  }
}

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

const RULER = 24;
const VIEW_PAD = 20;

const viewer = {
  el: $('#viewer'),
  canvas: $('#patternCanvas'),
  ctx: null,
  width: 0,
  height: 0,
  dpr: 1,
  scale: 10,
  x: 0,
  y: 0,
  fitScale: 10,
  userZoomed: false,
  hover: null,
  styles: [],
  bitmap: null,
  frame: 0,
};
viewer.ctx = viewer.canvas.getContext('2d');

function refreshStyles() {
  if (!state.pattern) return;
  viewer.styles = colorStyles(state.pattern, state.highlight, state.done);
  viewer.bitmap = cellBitmap(state.pattern, viewer.styles);
}

/** On phones the viewer sits in the page flow; give it the pattern's proportions
 *  instead of a fixed height, so a wide pattern doesn't float in empty space. */
const stacked = window.matchMedia('(max-width: 760px)');
function sizeViewerForPattern() {
  const p = state.pattern;
  if (!p || !stacked.matches) {
    viewer.el.style.removeProperty('--viewer-h');
    return;
  }
  const inner = viewer.el.clientWidth - RULER - VIEW_PAD * 2;
  const ideal = (inner * p.height) / p.width + RULER + VIEW_PAD * 2;
  viewer.el.style.setProperty('--viewer-h', `${Math.round(clamp(ideal, 280, window.innerHeight * 0.72))}px`);
}

function resizeViewer() {
  sizeViewerForPattern();
  const rect = viewer.el.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const prevW = viewer.width, prevH = viewer.height;
  viewer.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  viewer.width = rect.width;
  viewer.height = rect.height;
  viewer.canvas.width = Math.round(rect.width * viewer.dpr);
  viewer.canvas.height = Math.round(rect.height * viewer.dpr);
  if (!viewer.userZoomed || !prevW) {
    fitView();
  } else {
    viewer.x += (rect.width - prevW) / 2;
    viewer.y += (rect.height - prevH) / 2;
    computeFitScale();
    updateZoomLabel();
  }
  drawViewer();
}

function computeFitScale() {
  const p = state.pattern;
  if (!p || !viewer.width) return;
  const aw = viewer.width - RULER - VIEW_PAD * 2;
  const ah = viewer.height - RULER - VIEW_PAD * 2;
  viewer.fitScale = Math.max(0.5, Math.min(aw / p.width, ah / p.height));
}

function fitView() {
  const p = state.pattern;
  if (!p || !viewer.width) return;
  computeFitScale();
  viewer.scale = viewer.fitScale;
  viewer.x = RULER + (viewer.width - RULER - p.width * viewer.scale) / 2;
  viewer.y = RULER + (viewer.height - RULER - p.height * viewer.scale) / 2;
  viewer.userZoomed = false;
  updateZoomLabel();
  scheduleDraw();
}

function clampPan() {
  const p = state.pattern;
  if (!p) return;
  const keep = 48;
  viewer.x = clamp(viewer.x, RULER + keep - p.width * viewer.scale, viewer.width - keep);
  viewer.y = clamp(viewer.y, RULER + keep - p.height * viewer.scale, viewer.height - keep);
}

function zoomAt(factor, px = (viewer.width + RULER) / 2, py = (viewer.height + RULER) / 2) {
  if (!state.pattern) return;
  const min = viewer.fitScale * 0.5;
  const max = Math.max(viewer.fitScale * 2, 72);
  const next = clamp(viewer.scale * factor, min, max);
  const k = next / viewer.scale;
  viewer.x = px - (px - viewer.x) * k;
  viewer.y = py - (py - viewer.y) * k;
  viewer.scale = next;
  viewer.userZoomed = true;
  clampPan();
  updateZoomLabel();
  scheduleDraw();
}

function updateZoomLabel() {
  $('#zoomReset').textContent = `${Math.round((viewer.scale / viewer.fitScale) * 100)}%`;
  // Zoomed in, drags and scrolls move the chart; at fit size they scroll the page,
  // so a phone user is never stuck on a viewer that fills the screen.
  viewer.el.classList.toggle('is-zoomed', viewer.scale > viewer.fitScale * 1.02);
}

function scheduleDraw() {
  if (viewer.frame) return;
  viewer.frame = requestAnimationFrame(() => {
    viewer.frame = 0;
    drawViewer();
  });
}

function drawViewer() {
  const { ctx, width: W, height: H, dpr } = viewer;
  if (!W) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = PANEL;
  ctx.fillRect(0, 0, W, H);
  const p = state.pattern;
  if (!p) return;

  const s = viewer.scale, ox = viewer.x, oy = viewer.y;
  const view = {
    ox, oy, s, dpr,
    c0: clamp(Math.floor((RULER - ox) / s), 0, p.width),
    c1: clamp(Math.ceil((W - ox) / s), 0, p.width),
    r0: clamp(Math.floor((RULER - oy) / s), 0, p.height),
    r1: clamp(Math.ceil((H - oy) / s), 0, p.height),
  };
  const set = state.settings;
  const beads = set.view === 'beads';

  ctx.save();
  ctx.beginPath();
  ctx.rect(RULER, RULER, W - RULER, H - RULER);
  ctx.clip();

  ctx.shadowColor = 'rgba(25,24,21,0.1)';
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = beads ? '#f3f0ea' : '#ffffff';
  ctx.fillRect(ox, oy, p.width * s, p.height * s);
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  paintCells(ctx, p, {
    ...view,
    styles: viewer.styles,
    bitmap: viewer.bitmap,
    beads,
    grid: set.showGrid && !beads,
    codes: set.showCodes,
    boards: set.showBoards ? set.boardSize : 0,
  });

  const hover = viewer.hover;
  if (hover) {
    ctx.fillStyle = 'rgba(25,24,21,0.06)';
    ctx.fillRect(ox + hover.col * s, oy, s, p.height * s);
    ctx.fillRect(ox, oy + hover.row * s, p.width * s, s);
    ctx.lineWidth = 2;
    ctx.strokeStyle = INK;
    ctx.strokeRect(ox + hover.col * s - 1, oy + hover.row * s - 1, s + 2, s + 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(ox + hover.col * s + 0.5, oy + hover.row * s + 0.5, s - 1, s - 1);
  }
  ctx.restore();

  // Rulers stay pinned while the chart pans underneath.
  ctx.fillStyle = '#f4f2ed';
  ctx.fillRect(0, 0, W, RULER);
  ctx.fillRect(0, 0, RULER, H);
  ctx.save();
  ctx.beginPath();
  ctx.rect(RULER, 0, W - RULER, RULER);
  ctx.rect(0, RULER, RULER, H - RULER);
  ctx.clip();
  paintRulers(ctx, {
    ...view,
    top: 0,
    left: 0,
    size: RULER,
    minGap: 26,
    font: `10px ${FONT_MONO}`,
    color: MUTED,
    hover,
  });
  ctx.restore();
  ctx.fillStyle = 'rgba(25,24,21,0.12)';
  ctx.fillRect(RULER, RULER - 1, W - RULER, 1);
  ctx.fillRect(RULER - 1, RULER, 1, H - RULER);
}

function cellAt(clientX, clientY) {
  const p = state.pattern;
  if (!p) return null;
  const rect = viewer.canvas.getBoundingClientRect();
  const x = clientX - rect.left, y = clientY - rect.top;
  if (x < RULER || y < RULER) return null;
  const col = Math.floor((x - viewer.x) / viewer.scale);
  const row = Math.floor((y - viewer.y) / viewer.scale);
  if (col < 0 || row < 0 || col >= p.width || row >= p.height) return null;
  return { col, row, value: p.cells[row * p.width + col] };
}

const HOVER_HINT = window.matchMedia('(hover: none)').matches ? '点一下格子，突出同一种颜色' : '把鼠标移到图纸上查看坐标';

function setHover(cell) {
  const prev = viewer.hover;
  if (prev && cell && prev.col === cell.col && prev.row === cell.row) return;
  if (!prev && !cell) return;
  viewer.hover = cell;
  viewer.el.classList.toggle('is-pointing', Boolean(cell && cell.value >= 0));
  const info = $('#hoverInfo');
  if (cell) {
    const color = cell.value >= 0 ? state.pattern.colors[cell.value] : null;
    info.textContent = `第 ${cell.col + 1} 列 · 第 ${cell.row + 1} 行 · ${color ? `${colorRef(color, state.pattern.brand)} ${color.name}` : '空'}`;
  } else {
    info.textContent = HOVER_HINT;
  }
  scheduleDraw();
}

function bindViewer() {
  const el = viewer.el;
  const pointers = new Map();
  let gesture = null;

  const local = (e) => {
    const rect = viewer.canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, local(e));
    if (pointers.size === 1) {
      gesture = { type: 'pan', start: local(e), x: viewer.x, y: viewer.y, moved: false };
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      gesture = { type: 'pinch', dist: Math.hypot(a[0] - b[0], a[1] - b[1]), mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] };
    }
  });

  el.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) {
      if (e.pointerType === 'mouse') setHover(cellAt(e.clientX, e.clientY));
      return;
    }
    pointers.set(e.pointerId, local(e));
    if (gesture?.type === 'pan') {
      const [x, y] = local(e);
      const dx = x - gesture.start[0], dy = y - gesture.start[1];
      if (!gesture.moved && Math.hypot(dx, dy) > 4) {
        gesture.moved = true;
        el.classList.add('is-panning');
      }
      if (gesture.moved) {
        viewer.x = gesture.x + dx;
        viewer.y = gesture.y + dy;
        clampPan();
        setHover(null);
        scheduleDraw();
      }
    } else if (gesture?.type === 'pinch' && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      viewer.x += mid[0] - gesture.mid[0];
      viewer.y += mid[1] - gesture.mid[1];
      zoomAt(dist / gesture.dist, mid[0], mid[1]);
      gesture.dist = dist;
      gesture.mid = mid;
    }
  });

  const release = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (gesture?.type === 'pan' && !gesture.moved && e.type === 'pointerup') {
      const cell = cellAt(e.clientX, e.clientY);
      setHighlight(cell && cell.value >= 0 && cell.value !== state.highlight ? cell.value : -1);
    }
    if (pointers.size === 0) {
      gesture = null;
      el.classList.remove('is-panning');
    } else if (pointers.size === 1) {
      const [rest] = pointers.values();
      gesture = { type: 'pan', start: rest, x: viewer.x, y: viewer.y, moved: true };
    }
  };
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !pointers.size) setHover(null); });

  el.addEventListener('wheel', (e) => {
    if (!state.pattern) return;
    const zoomGesture = e.ctrlKey || e.metaKey;
    if (!zoomGesture && !viewer.el.classList.contains('is-zoomed')) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewer.height : 1;
    const [x, y] = local(e);
    if (zoomGesture) {
      zoomAt(Math.exp(-clamp(e.deltaY * unit, -60, 60) * 0.01), x, y);
    } else {
      viewer.x -= e.deltaX * unit;
      viewer.y -= e.deltaY * unit;
      clampPan();
      scheduleDraw();
    }
  }, { passive: false });

  el.addEventListener('dblclick', (e) => {
    const [x, y] = local(e);
    zoomAt(2, x, y);
  });

  el.addEventListener('keydown', (e) => {
    const step = 60;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) {
      e.preventDefault();
      viewer.x += moves[e.key][0];
      viewer.y += moves[e.key][1];
      clampPan();
      scheduleDraw();
    }
  });

  new ResizeObserver(resizeViewer).observe(el);
  $('#zoomIn').addEventListener('click', () => zoomAt(1.4));
  $('#zoomOut').addEventListener('click', () => zoomAt(1 / 1.4));
  $('#zoomReset').addEventListener('click', fitView);
}

// ---------------------------------------------------------------------------
// Workspace: generating and syncing the panels
// ---------------------------------------------------------------------------

let generateTimer = 0;

function requestGenerate(delay = 40) {
  clearTimeout(generateTimer);
  generateTimer = setTimeout(runGenerate, delay);
}

function runGenerate() {
  if (!state.source) return;
  const busy = $('#viewerBusy');
  if (state.width * state.height > 60000 && busy.classList.contains('hidden')) {
    busy.classList.remove('hidden');
    setTimeout(() => { generate(); busy.classList.add('hidden'); }, 30);
  } else {
    generate();
  }
}

function generate() {
  const prev = state.pattern;
  const keep = (i) => prev?.colors[i]?.code;
  const highlightCode = state.highlight >= 0 ? keep(state.highlight) : null;
  const doneCodes = new Set([...state.done].map(keep));
  const s = state.settings;

  state.pattern = buildPattern(state.source, {
    width: state.width,
    height: state.height,
    fit: s.fit,
    adjust: state.adjust,
    brand: s.brand,
    colors: s.colors,
    removeBg: s.removeBg,
    despeckle: s.despeckle,
  });

  // Highlight and progress survive a regenerate when the same brand codes are still there.
  const colors = state.pattern.colors;
  const sameBrand = prev && prev.brand === state.pattern.brand && state.pattern.brand !== 'free';
  state.highlight = sameBrand ? colors.findIndex((c) => c.code === highlightCode) : -1;
  state.done = new Set(sameBrand ? colors.map((c, i) => (doneCodes.has(c.code) ? i : -1)).filter((i) => i >= 0) : []);

  refreshStyles();
  sizeViewerForPattern();
  if (!prev || prev.width !== state.width || prev.height !== state.height) fitView();
  else computeFitScale();
  viewer.hover = null;
  $('#viewerEmpty').classList.toggle('hidden', state.pattern.total > 0);
  renderMaterials();
  updateStats();
  updateHighlightInfo();
  scheduleDraw();
}

function aspect() {
  return state.source ? state.source.width / state.source.height : 1;
}

function setSizeFromLongest(longest) {
  const a = aspect();
  const w = a >= 1 ? longest : Math.round(longest * a);
  const h = a >= 1 ? Math.round(longest / a) : longest;
  commitSize(w, h);
}

function commitSize(w, h, { remember = true } = {}) {
  state.width = clamp(Math.round(w) || MIN_CELLS, MIN_CELLS, MAX_CELLS);
  state.height = clamp(Math.round(h) || MIN_CELLS, MIN_CELLS, MAX_CELLS);
  $('#gridWidth').value = state.width;
  $('#gridHeight').value = state.height;
  if (remember) {
    state.settings.longest = Math.max(state.width, state.height);
    saveSettings();
  }
  syncPresets();
  updateStats();
}

/** Presets are whole pegboards: the longest edge fills 1, 2 or 3 boards, so nothing
 *  spills a single row onto an extra board. */
function syncPresets() {
  const longest = Math.max(state.width, state.height);
  const B = state.settings.boardSize;
  $$('#sizePresets button').forEach((b) => {
    const k = +b.dataset.boards;
    $('span', b).textContent = `${B * k} 格`;
    b.title = `最长边 ${B * k} 格，${k === 1 ? '一块板' : `${k} × ${k} 块板以内`}`;
    b.setAttribute('aria-pressed', String(B * k === longest));
  });
}

function syncPressed(groupSelector, attr, value) {
  $$(`${groupSelector} button`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[attr] === String(value))));
}

function syncRangeFill(input) {
  const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--fill', `${pct}%`);
}

function syncControls() {
  const s = state.settings;
  syncPressed('#fitMode', 'fit', s.fit);
  syncPressed('#beadSize', 'bead', s.beadSize);
  syncPressed('#viewMode', 'view', s.view);
  $('#lockRatio').setAttribute('aria-pressed', String(s.lockRatio));
  $('#brand').value = s.brand;
  $('#colorCount').value = s.colors;
  $('#colorValue').textContent = `${s.colors} 色`;
  $('#removeBg').checked = s.removeBg && !state.source?.cutout;
  $('#despeckle').checked = s.despeckle && !state.source?.pixelArt;
  $('#boardSize').value = s.boardSize;
  syncPresets();
  $('#showGrid').checked = s.showGrid;
  $('#showCodes').checked = s.showCodes;
  $('#showBoards').checked = s.showBoards;
  syncAdjust();
  $$('input[type="range"]').forEach(syncRangeFill);
}

function syncAdjust() {
  for (const key of ['brightness', 'contrast', 'saturation']) {
    const input = $(`#${key}`);
    input.value = state.adjust[key];
    $(`#${key}Value`).textContent = state.adjust[key] > 0 ? `+${state.adjust[key]}` : state.adjust[key];
    syncRangeFill(input);
  }
  const touched = Object.values(state.adjust).some(Boolean);
  $('#adjustNote').textContent = touched ? '已调整' : '';
}

function updateStats() {
  const s = state.settings;
  const w = state.width, h = state.height;
  const size = `${cm(w * s.beadSize)} × ${cm(h * s.beadSize)} cm`;
  const bx = Math.ceil(w / s.boardSize), by = Math.ceil(h / s.boardSize);
  $('#physicalSize').textContent = `成品约 ${size}`;
  $('#statGrid').textContent = `${w} × ${h} 格`;
  $('#statSize').textContent = size;
  $('#statBoards').textContent = `${bx * by} 块（${bx}×${by}）`;
  const p = state.pattern;
  if (!p) return;
  $('#statColors').textContent = `${p.colors.length} 种`;
  $('#totalBeads').textContent = `${fmt(p.total)} 颗`;
  viewer.el.setAttribute('aria-label', `拼豆图纸预览，${p.width} × ${p.height} 格，${p.colors.length} 种颜色，共 ${p.total} 颗`);
  updateProgress();
}

function updateProgress() {
  const p = state.pattern;
  const doneBeads = [...state.done].reduce((sum, i) => sum + (p.colors[i]?.count || 0), 0);
  $('#progress').classList.toggle('hidden', !state.done.size);
  $('#progressText').textContent = `${fmt(doneBeads)} / ${fmt(p.total)} 颗 · ${state.done.size} / ${p.colors.length} 色`;
  $('#progressBar').style.width = `${p.total ? (doneBeads / p.total) * 100 : 0}%`;
}

function renderMaterials() {
  const p = state.pattern;
  const list = $('#paletteList');
  const check = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  list.innerHTML = p.colors
    .map((c, i) => {
      const pct = p.total ? (c.count / p.total) * 100 : 0;
      const pctText = pct >= 1 ? `${Math.round(pct)}%` : '<1%';
      const title = `${c.english ? `${c.english} · ` : ''}点击在图纸上突出 ${c.code}`;
      const code = colorRef(c, p.brand);
      return `<li class="palette-item${i === state.highlight ? ' is-active' : ''}${state.done.has(i) ? ' is-done' : ''}" data-index="${i}">
        <button class="palette-main" type="button" aria-pressed="${i === state.highlight}" title="${escapeHtml(title)}">
          <i class="bead-chip" style="--c:${c.hex}"></i>
          <span class="palette-text"><b>${escapeHtml(code)}<span>${c.name}</span></b><small>${c.hex.toUpperCase()}</small></span>
          <span class="palette-count">${fmt(c.count)}<small>${pctText}</small></span>
        </button>
        <button class="done-toggle" type="button" aria-pressed="${state.done.has(i)}" aria-label="标记 ${escapeHtml(code)} 已拼完" title="拼完了">${check}</button>
      </li>`;
    })
    .join('');
}

function syncMaterialStates() {
  $$('#paletteList .palette-item').forEach((li) => {
    const i = +li.dataset.index;
    li.classList.toggle('is-active', i === state.highlight);
    li.classList.toggle('is-done', state.done.has(i));
    $('.palette-main', li).setAttribute('aria-pressed', String(i === state.highlight));
    $('.done-toggle', li).setAttribute('aria-pressed', String(state.done.has(i)));
  });
}

function setHighlight(index) {
  state.highlight = index;
  refreshStyles();
  syncMaterialStates();
  updateHighlightInfo();
  scheduleDraw();
  if (index >= 0) {
    const item = $(`#paletteList [data-index="${index}"]`);
    item?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function toggleDone(index) {
  if (state.done.has(index)) state.done.delete(index);
  else state.done.add(index);
  refreshStyles();
  syncMaterialStates();
  updateProgress();
  scheduleDraw();
}

function updateHighlightInfo() {
  const box = $('#highlightInfo');
  const c = state.pattern?.colors[state.highlight];
  box.classList.toggle('hidden', !c);
  if (!c) return;
  $('#highlightSwatch').style.background = c.hex;
  $('#highlightText').textContent = `只看 ${colorRef(c, state.pattern.brand)} ${c.name} · ${fmt(c.count)} 颗`;
}

// ---------------------------------------------------------------------------
// Loading images
// ---------------------------------------------------------------------------

function decodeImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode failed'));
    img.src = url;
  });
}

async function loadImageFile(file) {
  if (!file) return;
  if (file.type && !file.type.startsWith('image/')) {
    toast('请选择一张图片文件');
    return;
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await decodeImage(url);
    const name = file.name && !/^image\.\w+$/i.test(file.name) ? file.name : '粘贴的图片';
    useImage(img, name);
  } catch {
    toast('这张图片读不出来，试试 JPG 或 PNG');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Open an image in the workspace. Pixel art (the ready-made patterns) is sampled
 *  with nearest-neighbour and starts at its own size, one cell per pixel. */
function useImage(img, name, title, { pixelArt = false, size = null } = {}) {
  if (!(img.naturalWidth || img.width)) {
    toast('这张图片读不出来，试试 JPG 或 PNG');
    return;
  }
  state.source = toWorkingCanvas(img);
  state.source.pixelArt = pixelArt;
  state.sourceName = name;
  state.title = title || name.replace(/\.[^.]+$/, '') || '我的拼豆图纸';
  state.adjust = { brightness: 0, contrast: 0, saturation: 0 };
  state.highlight = -1;
  state.done = new Set();
  state.pattern = null;
  viewer.userZoomed = false;

  const thumb = makeCanvas(88, 88);
  const tctx = thumb.getContext('2d');
  const k = Math.max(88 / state.source.width, 88 / state.source.height);
  tctx.drawImage(state.source, (88 - state.source.width * k) / 2, (88 - state.source.height * k) / 2, state.source.width * k, state.source.height * k);
  $('#sourcePreview').src = thumb.toDataURL();
  $('#fileName').textContent = name;
  $('#fileName').title = name;
  $('#sourceSize').textContent = `${img.naturalWidth || img.width} × ${img.naturalHeight || img.height} ${pixelArt ? '像素画' : 'px'}`;
  $('#patternTitle').value = state.title;
  $('#removeBg').disabled = state.source.cutout;
  $('#removeBg').checked = state.settings.removeBg && !state.source.cutout;
  $('#removeBgHint').textContent = state.source.cutout
    ? '这张图自带透明背景，背景已经留空了。'
    : '与边缘相连的单一底色（比如白底）不放豆。透明区域始终留空。';
  $('#despeckle').disabled = pixelArt;
  $('#despeckle').checked = state.settings.despeckle && !pixelArt;
  $('#despeckleHint').textContent = pixelArt ? '像素画每一颗都是画好的，不需要清理。' : '把孤零零的单颗豆子并入周围的颜色。';

  syncAdjust();
  if (size) commitSize(size[0], size[1], { remember: false });
  else setSizeFromLongest(state.settings.longest);
  showWorkspace();
  generate();
}

function showWorkspace() {
  $('#landing').classList.add('hidden');
  $('#workspace').classList.remove('hidden');
  document.body.classList.add('in-workspace');
  window.scrollTo({ top: 0, behavior: 'instant' });
  requestAnimationFrame(resizeViewer);
}

function showLanding() {
  $('#workspace').classList.add('hidden');
  $('#landing').classList.remove('hidden');
  document.body.classList.remove('in-workspace');
  const resume = $('#resumeButton');
  resume.classList.toggle('hidden', !state.source);
  $('#resumeName').textContent = state.title;
  window.scrollTo({ top: 0, behavior: 'instant' });
}

// ---------------------------------------------------------------------------
// Ready-made patterns (data in presets.js)
// ---------------------------------------------------------------------------

const PRESETS = (window.BEAD_PRESETS?.collections || []).flatMap((collection) =>
  collection.items.map((item) => ({
    ...item,
    collection: collection.name,
    palette: window.BEAD_PRESETS.palette,
    width: item.rows[0].length,
    height: item.rows.length,
    beads: item.rows.join('').replace(/\./g, '').length,
    colors: new Set(item.rows.join('').replace(/\./g, '')).size,
  })),
);

/** The preset drawn at `scale` px per cell; '.' stays transparent. */
function presetCanvas(preset, scale = 1) {
  const canvas = makeCanvas(preset.width * scale, preset.height * scale);
  const ctx = canvas.getContext('2d');
  preset.rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      if (!preset.palette[ch]) return;
      ctx.fillStyle = preset.palette[ch];
      ctx.fillRect(x * scale, y * scale, scale, scale);
    });
  });
  return canvas;
}

function openPreset(preset) {
  // Show the drawing as designed: never fewer colour slots than it uses.
  if (state.settings.colors < preset.colors) {
    state.settings.colors = preset.colors;
    saveSettings();
    syncControls();
  }
  const title = `${preset.collection} · ${preset.name}`;
  useImage(presetCanvas(preset), `${title}.png`, title, { pixelArt: true, size: [preset.width, preset.height] });
}

function downloadPreset(preset) {
  presetCanvas(preset, 24).toBlob((blob) => {
    if (blob) saveBlob(blob, `${preset.id}.png`);
  }, 'image/png');
}

function renderPresets() {
  const grid = $('#presetGrid');
  if (!PRESETS.length) {
    $('#gallery').classList.add('hidden');
    return;
  }
  // One scale for every card, so Clawd is the same size in all of them.
  const widest = Math.max(...PRESETS.map((p) => p.width));
  grid.replaceChildren(...PRESETS.map((preset) => {
    const item = document.createElement('li');
    item.className = 'preset-card';
    item.innerHTML = `
      <button class="preset-open" type="button" aria-label="打开 ${escapeHtml(preset.collection)} ${escapeHtml(preset.name)}">
        <span class="preset-art"></span>
        <span class="preset-meta"><b>${escapeHtml(preset.name)}</b><span>${preset.width}&nbsp;×&nbsp;${preset.height} · ${fmt(preset.beads)}&nbsp;颗</span></span>
      </button>
      <button class="preset-download" type="button" aria-label="下载 ${escapeHtml(preset.name)} PNG"><span>PNG </span>↓</button>`;
    const art = presetCanvas(preset);
    art.style.width = `${(preset.width / widest) * 76}%`;
    $('.preset-art', item).append(art);
    $('.preset-open', item).addEventListener('click', () => openPreset(preset));
    $('.preset-download', item).addEventListener('click', () => downloadPreset(preset));
    return item;
  }));
}

// ---------------------------------------------------------------------------
// Output: PNG sheet, print pages, shopping list
// ---------------------------------------------------------------------------

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function safeFileName(text) {
  return (text || '拼豆图纸').replace(/[\\/:*?"<>|]+/g, '-').trim().slice(0, 60) || '拼豆图纸';
}

function patternSummary() {
  const p = state.pattern, s = state.settings;
  const bx = Math.ceil(p.width / s.boardSize), by = Math.ceil(p.height / s.boardSize);
  return {
    grid: `${p.width} × ${p.height} 格`,
    beads: `${fmt(p.total)} 颗`,
    colors: `${p.colors.length} 色`,
    brand: brandLabel(p.brand),
    size: `${cm(p.width * s.beadSize)} × ${cm(p.height * s.beadSize)} cm（${s.beadSize} mm 豆）`,
    boards: `${bx * by} 块 ${s.boardSize} × ${s.boardSize} 板`,
  };
}

function renderSheet() {
  const p = state.pattern, s = state.settings;
  const cols = p.width, rows = p.height;
  const cs = clamp(Math.floor(2400 / Math.max(cols, rows)), 8, 40);
  const M = 64, ruler = 30;
  const gridW = cols * cs, gridH = rows * cs;
  const width = Math.max(M * 2 + ruler + gridW, 1000);
  const itemW = 230, itemH = 46;
  const legendCols = Math.max(1, Math.floor((width - M * 2) / itemW));
  const legendRows = Math.ceil(p.colors.length / legendCols);
  const headerH = 128;
  const legendTop = M + headerH + ruler + gridH + 64;
  const height = legendTop + 44 + legendRows * itemH + 40 + 40 + M;
  if (width * height > 16384 * 16384 * 0.25) throw new Error('too large');

  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, width, height);

  const info = patternSummary();
  ctx.fillStyle = INK;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = `700 40px ${FONT_SANS}`;
  ctx.fillText(state.title || '我的拼豆图纸', M, M + 40);
  ctx.font = `15px ${FONT_MONO}`;
  ctx.fillStyle = MUTED;
  ctx.fillText(`${info.grid} · ${info.beads} · ${info.colors} · ${info.brand} · 成品约 ${info.size} · ${info.boards}`, M, M + 76);

  const gx = Math.round((width - ruler - gridW) / 2 + ruler);
  const gy = M + headerH + ruler;
  const styles = colorStyles(p);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(gx, gy, gridW, gridH);
  paintCells(ctx, p, {
    ox: gx, oy: gy, s: cs, c0: 0, c1: cols, r0: 0, r1: rows,
    styles, grid: true, codes: s.showCodes, boards: s.showBoards ? s.boardSize : 0,
  });
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.strokeRect(gx - 1, gy - 1, gridW + 2, gridH + 2);
  paintRulers(ctx, {
    ox: gx, oy: gy, s: cs, c0: 0, c1: cols, r0: 0, r1: rows,
    top: gy - ruler, left: gx - ruler, size: ruler, minGap: 24,
    font: `${cs >= 20 ? 12 : 11}px ${FONT_MONO}`, color: MUTED,
  });

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = INK;
  ctx.font = `700 22px ${FONT_SANS}`;
  ctx.fillText('材料清单', M, legendTop + 22);
  ctx.font = `14px ${FONT_MONO}`;
  ctx.fillStyle = MUTED;
  ctx.fillText(`共 ${info.beads} · ${info.colors} · ${info.brand}`, M + 104, legendTop + 21);

  p.colors.forEach((c, i) => {
    const x = M + (i % legendCols) * itemW;
    const y = legendTop + 44 + Math.floor(i / legendCols) * itemH;
    // The swatch looks like a chart cell, label and all, so the two read as a pair.
    ctx.fillStyle = c.hex;
    ctx.fillRect(x, y + 3, 30, 30);
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 3.5, 29, 29);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = inkFor(c.lab);
    ctx.font = `600 ${c.label.length > 2 ? 11 : 13}px ${FONT_MONO}`;
    ctx.fillText(c.label, x + 15, y + 18.5);
    ctx.textAlign = 'left';
    ctx.fillStyle = INK;
    ctx.font = `600 16px ${FONT_MONO}`;
    ctx.fillText(p.brand === 'free' ? `#${c.code}` : c.code, x + 40, y + 12);
    ctx.font = `13px ${FONT_SANS}`;
    ctx.fillStyle = MUTED;
    ctx.fillText(`${c.name} · ${c.hex.toUpperCase()}`, x + 40, y + 30);
    ctx.textAlign = 'right';
    ctx.font = `600 15px ${FONT_MONO}`;
    ctx.fillStyle = INK;
    ctx.fillText(fmt(c.count), x + itemW - 22, y + 12);
    ctx.textAlign = 'left';
    ctx.strokeStyle = '#e2ded9';
    ctx.beginPath();
    ctx.moveTo(x, y + itemH - 4);
    ctx.lineTo(x + itemW - 16, y + itemH - 4);
    ctx.stroke();
  });

  ctx.textBaseline = 'alphabetic';
  ctx.font = `13px ${FONT_MONO}`;
  ctx.fillStyle = MUTED;
  ctx.fillText("SAUL'S BEAN LAB", M, height - M + 8);
  ctx.textAlign = 'right';
  ctx.fillText('imsaul.lol', width - M, height - M + 8);
  return canvas;
}

async function downloadPng() {
  if (!state.pattern?.total) return;
  try {
    await document.fonts?.ready;
    const canvas = renderSheet();
    canvas.toBlob((blob) => {
      if (!blob) {
        toast('图纸太大，导出失败。试试小一点的尺寸');
        return;
      }
      saveBlob(blob, `${safeFileName(state.title)}-拼豆图纸.png`);
      toast('图纸已下载');
    }, 'image/png');
  } catch {
    toast('图纸太大，导出失败。试试小一点的尺寸');
  }
}

/** Assemble print pages: a cover with the overview and shopping list, then one
 *  page per pegboard. With 5 mm beads the boards print at 1:1, so a page can sit
 *  under a clear pegboard as a template. */
function buildPrintPages() {
  const p = state.pattern, s = state.settings;
  const root = $('#printRoot');
  root.innerHTML = '';
  if (!p?.total) return false;

  const B = s.boardSize;
  const bx = Math.ceil(p.width / B), by = Math.ceil(p.height / B);
  const pages = bx * by;
  const cellMm = Math.min(5, 186 / (B + 1), 210 / (B + 1));
  const trueScale = s.beadSize === 5 && Math.abs(cellMm - 5) < 0.01;
  const pxPerMm = pages > 30 ? 6 : 10;
  const cellPx = Math.max(8, Math.round(cellMm * pxPerMm));
  const styles = colorStyles(p);
  const info = patternSummary();
  const keyItem = (c, count) => `<li><i style="background:${c.hex}"></i><b>${escapeHtml(colorRef(c, p.brand))}</b><span>${c.name}</span><em>${fmt(count)}</em></li>`;

  // Cover
  const cover = document.createElement('section');
  cover.className = 'print-page';
  const ovMm = Math.min(190 / p.width, 120 / p.height);
  const ovPx = Math.max(2, Math.round(ovMm * 8));
  const overview = makeCanvas(p.width * ovPx, p.height * ovPx);
  const octx = overview.getContext('2d');
  octx.fillStyle = '#ffffff';
  octx.fillRect(0, 0, overview.width, overview.height);
  paintCells(octx, p, { ox: 0, oy: 0, s: ovPx, c0: 0, c1: p.width, r0: 0, r1: p.height, styles, grid: ovPx >= 6, boards: B });
  octx.font = `700 ${Math.max(14, Math.min(B * ovPx * 0.28, 64))}px ${FONT_SANS}`;
  octx.textAlign = 'center';
  octx.textBaseline = 'middle';
  for (let j = 0; j < by; j++) {
    for (let i = 0; i < bx; i++) {
      const cx = (i * B + Math.min(B, p.width - i * B) / 2) * ovPx;
      const cy = (j * B + Math.min(B, p.height - j * B) / 2) * ovPx;
      octx.lineWidth = 4;
      octx.strokeStyle = 'rgba(255,255,255,0.9)';
      octx.strokeText(`${j + 1}-${i + 1}`, cx, cy);
      octx.fillStyle = INK;
      octx.fillText(`${j + 1}-${i + 1}`, cx, cy);
    }
  }
  overview.style.width = `${p.width * ovMm}mm`;
  overview.className = 'print-overview';
  cover.innerHTML = `<h1>${escapeHtml(state.title || '我的拼豆图纸')}</h1>
    <p class="print-meta">${info.grid} · ${info.beads} · ${info.colors} · ${info.brand} · 成品约 ${info.size} · ${info.boards}</p>`;
  cover.append(overview);
  cover.insertAdjacentHTML('beforeend', `<h2>材料清单</h2><ul class="print-key">${p.colors.map((c) => keyItem(c, c.count)).join('')}</ul>
    <p class="print-note">${trueScale
      ? '之后每页是一块拼豆板，按 1:1 实物尺寸排版。打印时缩放请选「实际大小 / 100%」，就能把纸垫在透明拼豆板下面照着放。'
      : '之后每页是一块拼豆板（为了看清色号，按放大比例排版）。'} 编号「行-列」对应上面总览里的位置。</p>`);
  root.append(cover);

  // One page per board
  let page = 0;
  for (let j = 0; j < by; j++) {
    for (let i = 0; i < bx; i++) {
      page++;
      const c0 = i * B, r0 = j * B;
      const c1 = Math.min(c0 + B, p.width), r1 = Math.min(r0 + B, p.height);
      const ruler = cellPx;
      const canvas = makeCanvas((B + 1) * cellPx, (B + 1) * cellPx);
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // Peg positions this board has but the pattern doesn't reach.
      ctx.fillStyle = '#efebe5';
      ctx.fillRect(ruler, ruler, B * cellPx, B * cellPx);
      const ox = ruler - c0 * cellPx, oy = ruler - r0 * cellPx;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(ruler, ruler, (c1 - c0) * cellPx, (r1 - r0) * cellPx);
      paintCells(ctx, p, { ox, oy, s: cellPx, c0, c1, r0, r1, styles, grid: true, codes: true });
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2;
      ctx.strokeRect(ruler, ruler, B * cellPx, B * cellPx);
      paintRulers(ctx, {
        ox, oy, s: cellPx, c0, c1, r0, r1, top: 0, left: 0, size: ruler, minGap: cellPx * 0.9,
        font: `${Math.round(cellPx * 0.4)}px ${FONT_MONO}`, color: MUTED,
      });
      canvas.style.width = `${(B + 1) * cellMm}mm`;

      const counts = new Map();
      for (let r = r0; r < r1; r++) {
        for (let c = c0; c < c1; c++) {
          const v = p.cells[r * p.width + c];
          if (v >= 0) counts.set(v, (counts.get(v) || 0) + 1);
        }
      }
      const used = [...counts].sort((a, b) => b[1] - a[1]);
      const total = used.reduce((sum, [, n]) => sum + n, 0);

      const section = document.createElement('section');
      section.className = 'print-page';
      section.innerHTML = `<div class="print-head"><div><h2>板 ${j + 1}-${i + 1}</h2>
        <p>列 ${c0 + 1}–${c1} · 行 ${r0 + 1}–${r1} · ${fmt(total)} 颗${trueScale ? ' · 1:1' : ''}</p></div>
        <p>${escapeHtml(state.title)} · 第 ${page} / ${pages} 页</p></div>`;
      section.append(canvas);
      section.insertAdjacentHTML('beforeend', `<ul class="print-key compact">${used.map(([v, n]) => keyItem(p.colors[v], n)).join('')}</ul>`);
      root.append(section);
    }
  }
  document.body.classList.add('has-print');
  return true;
}

function printPattern() {
  const p = state.pattern;
  if (!p?.total) return;
  const B = state.settings.boardSize;
  const pages = Math.ceil(p.width / B) * Math.ceil(p.height / B) + 1;
  if (pages > 80 && !confirm(`这份图纸要打印 ${pages} 页，确定继续吗？`)) return;
  buildPrintPages();
  setTimeout(() => window.print(), 60);
}

async function copyList() {
  const p = state.pattern;
  if (!p?.total) return;
  const info = patternSummary();
  const lines = [
    `${state.title} · ${info.grid} · 共 ${info.beads} · ${info.brand}`,
    '',
    ...p.colors.map((c) => `${colorRef(c, p.brand)}\t${c.name}\t${c.hex.toUpperCase()}\t${c.count} 颗`),
  ];
  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  toast('材料清单已复制');
}

// ---------------------------------------------------------------------------
// Landing hero: the sample run through the real pipeline, drawn as beads
// ---------------------------------------------------------------------------

const hero = { canvas: $('#heroCanvas'), pattern: null, start: 0, frame: 0 };

function drawHero(now) {
  const { canvas, pattern } = hero;
  const rect = canvas.getBoundingClientRect();
  if (!pattern || !rect.width) return false;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(rect.width * dpr)) {
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const { width: cols, height: rows, cells } = pattern;
  const pitch = Math.floor(Math.min((rect.width * 0.8) / cols, (rect.height * 0.78) / rows));
  const bw = cols * pitch, bh = rows * pitch;
  const bx = (rect.width - bw) / 2, by = (rect.height - bh) / 2 - 6;
  ctx.fillStyle = 'rgba(255,255,255,0.32)';
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(bx - pitch * 0.6, by - pitch * 0.6, bw + pitch * 1.2, bh + pitch * 1.2, pitch) : ctx.rect(bx - pitch * 0.6, by - pitch * 0.6, bw + pitch * 1.2, bh + pitch * 1.2);
  ctx.fill();

  const elapsed = now - hero.start;
  let running = false;
  const styles = colorStyles(pattern);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = cells[r * cols + c];
      const cx = bx + (c + 0.5) * pitch, cy = by + (r + 0.5) * pitch;
      if (v < 0) {
        ctx.fillStyle = 'rgba(160,145,125,0.28)';
        ctx.beginPath();
        ctx.arc(cx, cy, pitch * 0.12, 0, TAU);
        ctx.fill();
        continue;
      }
      const delay = r * 38 + ((c * 37 + r * 11) % 9) * 22;
      const t = clamp((elapsed - delay) / 420, 0, 1);
      if (t < 1) running = true;
      if (t <= 0) continue;
      const ease = 1 - (1 - t) ** 3;
      ctx.globalAlpha = Math.min(1, t * 1.6);
      drawBead(ctx, cx, cy - (1 - ease) * pitch * 1.4, pitch * 0.46, styles[v].fill, pitch >= 9);
      ctx.globalAlpha = 1;
    }
  }
  return running;
}

function animateHero(now) {
  hero.frame = 0;
  if (drawHero(now)) hero.frame = requestAnimationFrame(animateHero);
}

function initHero() {
  const preset = PRESETS.find((p) => p.id === 'clawd-hello') || PRESETS[0];
  if (!preset) return;
  const source = toWorkingCanvas(presetCanvas(preset));
  source.pixelArt = true;
  hero.pattern = buildPattern(source, {
    width: preset.width, height: preset.height, fit: 'contain', adjust: { brightness: 0, contrast: 0, saturation: 0 },
    brand: BRANDS.mard ? 'mard' : 'free', colors: preset.colors, removeBg: false, despeckle: false,
  });
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  hero.start = performance.now() - (reduced ? 1e6 : -150);
  hero.frame = requestAnimationFrame(animateHero);
  new ResizeObserver(() => { if (!hero.frame) drawHero(performance.now()); }).observe(hero.canvas);
}

// ---------------------------------------------------------------------------
// Misc UI
// ---------------------------------------------------------------------------

let toastTimer = 0;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

function populateBrands() {
  const select = $('#brand');
  select.innerHTML = Object.values(BRANDS)
    .map((b) => `<option value="${b.key}">${escapeHtml(b.label)} · ${b.colors.length} 色</option>`)
    .join('') + '<option value="free">自由配色（不对应品牌）</option>';
}

function bindControls() {
  const s = state.settings;
  const onSetting = (key, value, { regenerate = false, redraw = false } = {}) => {
    s[key] = value;
    saveSettings();
    syncControls();
    if (regenerate) requestGenerate();
    if (redraw) { updateStats(); scheduleDraw(); }
  };

  $('#fileInput').addEventListener('change', (e) => {
    loadImageFile(e.target.files[0]);
    e.target.value = '';
  });
  $('#chooseButton').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#fileInput').click(); }
  });
  $('#newImage').addEventListener('click', () => $('#fileInput').click());
  $('#resumeButton').addEventListener('click', showWorkspace);
  $('#brandLink').addEventListener('click', (e) => {
    if (!document.body.classList.contains('in-workspace')) return;
    e.preventDefault();
    showLanding();
  });

  const zone = $('#dropZone');
  zone.addEventListener('click', () => $('#fileInput').click());
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#fileInput').click(); }
  });

  $$('#sizePresets button').forEach((b) => b.addEventListener('click', () => {
    setSizeFromLongest(s.boardSize * b.dataset.boards);
    requestGenerate(0);
  }));

  const applyDimension = (which, v, delay) => {
    const a = aspect();
    if (which === 'w') commitSize(v, s.lockRatio ? v / a : state.height);
    else commitSize(s.lockRatio ? v * a : state.width, v);
    requestGenerate(delay);
  };
  for (const [id, which] of [['#gridWidth', 'w'], ['#gridHeight', 'h']]) {
    const input = $(id);
    // While typing, only in-range values count (so "1" on the way to "120" is ignored);
    // on change, whatever is there gets clamped.
    input.addEventListener('input', () => {
      const v = parseInt(input.value, 10);
      if (v >= MIN_CELLS && v <= MAX_CELLS) applyDimension(which, v, 450);
    });
    input.addEventListener('change', () => {
      const v = parseInt(input.value, 10);
      if (Number.isFinite(v)) applyDimension(which, clamp(v, MIN_CELLS, MAX_CELLS), 0);
      else commitSize(state.width, state.height);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
  }

  $('#lockRatio').addEventListener('click', () => {
    onSetting('lockRatio', !s.lockRatio);
    if (s.lockRatio && state.source) {
      commitSize(state.width, state.width / aspect());
      requestGenerate(0);
    }
    toast(s.lockRatio ? '已锁定原图比例' : '已解除比例锁定，可以自由设定宽高');
  });

  $$('#fitMode button').forEach((b) => b.addEventListener('click', () => onSetting('fit', b.dataset.fit, { regenerate: true })));
  $$('#beadSize button').forEach((b) => b.addEventListener('click', () => onSetting('beadSize', +b.dataset.bead, { redraw: true })));
  $$('#viewMode button').forEach((b) => b.addEventListener('click', () => onSetting('view', b.dataset.view, { redraw: true })));

  $('#brand').addEventListener('change', (e) => onSetting('brand', e.target.value, { regenerate: true }));
  $('#colorCount').addEventListener('input', (e) => {
    s.colors = +e.target.value;
    $('#colorValue').textContent = `${s.colors} 色`;
    syncRangeFill(e.target);
    saveSettings();
    requestGenerate(60);
  });
  $('#removeBg').addEventListener('change', (e) => onSetting('removeBg', e.target.checked, { regenerate: true }));
  $('#despeckle').addEventListener('change', (e) => onSetting('despeckle', e.target.checked, { regenerate: true }));

  $$('[data-adjust]').forEach((input) => input.addEventListener('input', () => {
    state.adjust[input.id] = +input.value;
    syncAdjust();
    requestGenerate(60);
  }));
  $('#resetAdjust').addEventListener('click', () => {
    state.adjust = { brightness: 0, contrast: 0, saturation: 0 };
    syncAdjust();
    requestGenerate(0);
  });

  $('#boardSize').addEventListener('change', (e) => {
    const v = clamp(parseInt(e.target.value, 10) || DEFAULTS.boardSize, 10, 100);
    onSetting('boardSize', v, { redraw: true });
  });

  for (const key of ['showGrid', 'showCodes', 'showBoards']) {
    $(`#${key}`).addEventListener('change', (e) => onSetting(key, e.target.checked, { redraw: true }));
  }

  $('#patternTitle').addEventListener('input', (e) => { state.title = e.target.value.trim(); });
  $('#patternTitle').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

  $('#paletteList').addEventListener('click', (e) => {
    const item = e.target.closest('.palette-item');
    if (!item) return;
    const index = +item.dataset.index;
    if (e.target.closest('.done-toggle')) toggleDone(index);
    else setHighlight(index === state.highlight ? -1 : index);
  });
  $('#clearHighlight').addEventListener('click', () => setHighlight(-1));

  $('#downloadPng').addEventListener('click', downloadPng);
  $('#printPattern').addEventListener('click', printPattern);
  $('#copyList').addEventListener('click', copyList);
}

function bindGlobal() {
  // Drop anywhere on the page.
  const overlay = $('#dropOverlay');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay.classList.remove('hidden');
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.classList.add('hidden');
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.classList.add('hidden');
    const files = [...e.dataTransfer.files];
    loadImageFile(files.find((f) => f.type.startsWith('image/')) || files[0]);
  });

  // Paste an image from the clipboard.
  document.addEventListener('paste', (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.kind === 'file' && i.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    loadImageFile(item.getAsFile());
  });

  // Keyboard shortcuts for the viewer, unless the user is typing.
  document.addEventListener('keydown', (e) => {
    if (!state.pattern || $('#workspace').classList.contains('hidden')) return;
    if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '+' || e.key === '=') zoomAt(1.4);
    else if (e.key === '-' || e.key === '_') zoomAt(1 / 1.4);
    else if (e.key === '0') fitView();
    else if (e.key === 'Escape' && state.highlight >= 0) setHighlight(-1);
  });

  // Fold the wordmark once the page scrolls, like the blog does.
  const topbar = $('#topbar');
  const syncTopbar = () => topbar.classList.toggle('is-scrolled', window.scrollY > 40);
  window.addEventListener('scroll', syncTopbar, { passive: true });
  syncTopbar();
  const mid = $('.logo-mid');
  const measure = () => mid.style.setProperty('--logo-mid-w', `${mid.scrollWidth}px`);
  measure();
  window.addEventListener('resize', measure);
  document.fonts?.ready.then(() => {
    measure();
    scheduleDraw();
  });

  // ⌘P prints the pattern pages too, not just the button.
  window.addEventListener('beforeprint', () => {
    if (state.pattern?.total && !$('#workspace').classList.contains('hidden') && !$('#printRoot').childElementCount) buildPrintPages();
  });
  window.addEventListener('afterprint', () => {
    $('#printRoot').innerHTML = '';
    document.body.classList.remove('has-print');
  });
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

populateBrands();
renderPresets();
syncControls();
$('#hoverInfo').textContent = HOVER_HINT;
bindControls();
bindViewer();
bindGlobal();
initHero();
