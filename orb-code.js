// DockOver Orb Code for the browser: a line-by-line port of src/pairing/orb_code.h (keep the two in step).
// The phone's scanner page decodes camera frames with it, on the phone (no image ever leaves the device).
// Works as an ES module in browsers and in Node (tests).

export const kRings = 3, kSlots = 32, kBits = kRings * kSlots;
export const kRingRadius = [1.30, 1.48, 1.78];
export const kGapRadius = [1.39, 1.63, 1.93];
export const kRingHalfWidth = 0.045;
export const kArcFill = 0.78;
export const kSync = 0xB4;

export function crc16(bytes, n) {
  let c = 0xFFFF;
  for (let i = 0; i < n; i++) {
    c ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF;
  }
  return c;
}

let whiteningCache = null;
export function whitening() {
  if (whiteningCache) return whiteningCache;
  const w = new Uint8Array(kBits - 8);
  let s = 0x5B;
  for (let i = 0; i < w.length; i++) { const bit = ((s >> 6) ^ (s >> 5)) & 1; s = ((s << 1) | bit) & 0x7F; w[i] = bit; }
  return (whiteningCache = w);
}

// payload: { version, flags, secret: BigInt }
export function encode(p) {
  const d = new Uint8Array(11);
  d[0] = ((p.version & 15) << 4) | (p.flags & 15);
  for (let i = 0; i < 8; i++) d[1 + i] = Number((p.secret >> BigInt(56 - 8 * i)) & 0xFFn);
  const crc = crc16(d, 9);
  d[9] = crc >> 8; d[10] = crc & 0xFF;
  const bits = new Uint8Array(kBits);
  for (let i = 0; i < 8; i++) bits[i] = (kSync >> (7 - i)) & 1;
  const w = whitening();
  for (let i = 0; i < 88; i++) bits[8 + i] = ((d[i >> 3] >> (7 - (i & 7))) & 1) ^ w[i];
  return bits;
}

// Payload from sampled slots ([ring * 32 + slot] as seen, unknown rotation / mirror), or null.
export function decodeBits(seen) {
  const w = whitening();
  for (let m = 0; m < 2; m++) for (let r = 0; r < kSlots; r++) {
    const at = (i) => {
      const ring = Math.floor(i / kSlots), slot = i % kSlots;
      const s = m ? (((r - slot) % kSlots) + kSlots) % kSlots : (slot + r) % kSlots;
      return seen[ring * kSlots + s];
    };
    let sync = 0;
    for (let i = 0; i < 8; i++) sync = (sync << 1) | at(i);
    if (sync !== kSync) continue;
    const d = new Uint8Array(11);
    for (let i = 0; i < 88; i++) d[i >> 3] |= (at(8 + i) ^ w[i]) << (7 - (i & 7));
    if (crc16(d, 9) !== ((d[9] << 8) | d[10])) continue;
    let secret = 0n;
    for (let i = 0; i < 8; i++) secret = (secret << 8n) | BigInt(d[1 + i]);
    return { version: d[0] >> 4, flags: d[0] & 15, secret, rotation: r, mirrored: m === 1 };
  }
  return null;
}

// ---- image decoder --------------------------------------------------------------------------------------------------
// img: { w, h, v: Float32Array } brightness 0..1 (max of R, G, B: the orb glows blue)
export function grayFromRGBA(data, w, h) {
  const v = new Float32Array(w * h);
  for (let i = 0, j = 0; i < v.length; i++, j += 4) v[i] = Math.max(data[j], data[j + 1], data[j + 2]) / 255;
  return { w, h, v };
}

function at(img, x, y) {
  x = x < 0 ? 0 : x >= img.w ? img.w - 1 : x;
  y = y < 0 ? 0 : y >= img.h ? img.h - 1 : y;
  return img.v[y * img.w + x];
}
function bilinear(img, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  return (at(img, x0, y0) * (1 - fx) + at(img, x0 + 1, y0) * fx) * (1 - fy) + (at(img, x0, y0 + 1) * (1 - fx) + at(img, x0 + 1, y0 + 1) * fx) * fy;
}

export function ringScore(img, x0, y0, sc, per = 6) {
  const bins = kSlots * 2;
  let score = 0;
  const v = new Float64Array(bins);
  for (let j = 0; j < 6; j++) {
    const r = (j < 3 ? kRingRadius[j] : kGapRadius[j - 3]) * sc;
    let m = 0;
    for (let b = 0; b < bins; b++) {
      let s2 = 0;
      for (let k = 0; k < per; k++) {
        const a = 2 * Math.PI * (b + (k + 0.5) / per) / bins;
        s2 += bilinear(img, x0 + r * Math.cos(a), y0 + r * Math.sin(a));
      }
      v[b] = s2 / per; m += v[b];
    }
    m /= bins;
    let vr = 0; for (let b = 0; b < bins; b++) vr += (v[b] - m) * (v[b] - m);
    score += (j < 3 ? 1 : -1) * vr / bins;
  }
  const ringMean = (r) => { let m = 0; for (let k = 0; k < 48; k++) { const a = 2 * Math.PI * (k + 0.5) / 48; m += bilinear(img, x0 + r * Math.cos(a), y0 + r * Math.sin(a)); } return m / 48; };
  const contrast = ringMean(0.55 * sc) - ringMean(1.14 * sc);
  const gate = Math.min(Math.max(contrast / 0.06, 0), 1);
  return score * gate * gate * (3 - 2 * gate);
}

function boxBlur(img, rb) {
  const t = new Float32Array(img.v.length), o = new Float32Array(img.v.length);
  for (let y = 0; y < img.h; y++) {
    let acc = 0, n = 0;
    for (let x = -rb; x < img.w + rb; x++) {
      if (x + rb < img.w) { acc += at(img, x + rb, y); n++; }
      if (x - rb - 1 >= 0) { acc -= at(img, x - rb - 1, y); n--; }
      if (x >= 0 && x < img.w && n > 0) t[y * img.w + x] = acc / n;
    }
  }
  const ti = { w: img.w, h: img.h, v: t };
  for (let x = 0; x < img.w; x++) {
    let acc = 0, n = 0;
    for (let y = -rb; y < img.h + rb; y++) {
      if (y + rb < img.h) { acc += at(ti, x, y + rb); n++; }
      if (y - rb - 1 >= 0) { acc -= at(ti, x, y - rb - 1); n--; }
      if (y >= 0 && y < img.h && n > 0) o[y * img.w + x] = acc / n;
    }
  }
  return { w: img.w, h: img.h, v: o };
}

// Steps as in orb_code.h. hint: { cx, cy, radius } from the previous frame (live scanning): skips the global search.
export function decodeImage(img, hint = null) {
  if (img.w < 32 || img.h < 32) return null;
  let cx, cy, s0;
  const maxS = Math.min(img.w, img.h) / 4;
  if (hint && hint.radius > 0) {
    cx = hint.cx; cy = hint.cy; s0 = hint.radius;
  } else {
    const cell = Math.max(2, Math.floor(Math.min(img.w, img.h) / 64));
    const gw = Math.floor(img.w / cell), gh = Math.floor(img.h / cell);
    const g = new Float64Array(gw * gh);
    for (let y = 0; y < gh * cell; y++) for (let x = 0; x < gw * cell; x++) g[Math.floor(y / cell) * gw + Math.floor(x / cell)] += img.v[y * img.w + x];
    const W = gw + 1, I = new Float64Array(W * (gh + 1));
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) I[(y + 1) * W + x + 1] = g[y * gw + x] + I[y * W + x + 1] + I[(y + 1) * W + x] - I[y * W + x];
    const boxMean = (x0, y0, x1, y1) => {
      x0 = Math.max(x0, 0); y0 = Math.max(y0, 0); x1 = Math.min(x1, gw - 1); y1 = Math.min(y1, gh - 1);
      if (x1 < x0 || y1 < y0) return 0;
      return (I[(y1 + 1) * W + x1 + 1] - I[y0 * W + x1 + 1] - I[(y1 + 1) * W + x0] + I[y0 * W + x0]) / ((x1 - x0 + 1) * (y1 - y0 + 1));
    };
    let best = -1e18; cx = img.w / 2; cy = img.h / 2; s0 = 0;
    for (let h = Math.max(2, Math.floor(Math.min(gw, gh) / 16)); h * 2.4 * 2 < Math.min(gw, gh); h++) {
      const H = Math.floor(h * 2.4 + 0.5);
      for (let y = H; y < gh - H; y++) for (let x = H; x < gw - H; x++) {
        const resp = boxMean(x - h, y - h, x + h, y + h) - boxMean(x - H, y - H, x + H, y + H);
        if (resp > best) { best = resp; cx = (x + 0.5) * cell; cy = (y + 0.5) * cell; s0 = h * cell / 0.9; }
      }
    }
    if (s0 <= 0) return null;
  }
  let bestS = 0, bestScore = -1e9;
  if (!hint) {
    const soft = boxBlur(img, Math.max(1, Math.floor(0.05 * s0 + 0.5)));
    const x0 = cx, y0 = cy; let bx = cx, by = cy;
    for (let sc = s0 * 0.6; sc < Math.min(s0 * 1.5, maxS); sc *= 1.025) {
      const step = Math.max(0.75, 0.06 * sc);
      for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) {
        const v = ringScore(soft, x0 + dx * step, y0 + dy * step, sc, 2);
        if (v > bestScore) { bestScore = v; bestS = sc; bx = x0 + dx * step; by = y0 + dy * step; }
      }
    }
    cx = bx; cy = by;
  } else {
    bestS = s0;
  }
  if (bestS <= 0) return null;
  bestScore = ringScore(img, cx, cy, bestS);
  for (let it = hint ? 1 : 0; it < 4; it++) {
    const step = Math.max(0.3, bestS * 0.04 / (1 << it));
    let bx = cx, by = cy;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const v = ringScore(img, cx + dx * step, cy + dy * step, bestS);
      if (v > bestScore) { bestScore = v; bx = cx + dx * step; by = cy + dy * step; }
    }
    cx = bx; cy = by;
    for (let k = -6; k <= 6; k++) {
      const sc = bestS * (1 + k * 0.006 / (1 << it));
      const v = ringScore(img, cx, cy, sc);
      if (v > bestScore) { bestScore = v; bestS = sc; }
    }
  }
  if (bestScore <= 0) return null;
  const slotMeans = (ring, phase) => {
    const rr = kRingRadius[ring] * bestS, hw = kRingHalfWidth * bestS, val = new Float64Array(kSlots);
    for (let slot = 0; slot < kSlots; slot++) {
      let s = 0, n = 0;
      for (let k = -4; k <= 4; k++) {
        const a = 2 * Math.PI * (slot + 0.5 + phase + k * 0.06) / kSlots;
        for (let j = -2; j <= 2; j++) { const r = rr + hw * j / 2; s += bilinear(img, cx + r * Math.cos(a), cy + r * Math.sin(a)); n++; }
      }
      val[slot] = s / n;
    }
    return val;
  };
  let bestPhase = 0, bestVar = -1;
  for (let k = 0; k < 16; k++) {
    const phase = k / 16 - 0.5;
    let vr = 0;
    for (let ring = 0; ring < kRings; ring++) {
      const val = slotMeans(ring, phase);
      let m = 0; for (const x of val) m += x; m /= kSlots;
      for (const x of val) vr += (x - m) * (x - m);
    }
    if (vr > bestVar) { bestVar = vr; bestPhase = phase; }
  }
  const seen = new Uint8Array(kBits);
  for (let ring = 0; ring < kRings; ring++) {
    const val = slotMeans(ring, bestPhase);
    const sorted = Array.from(val).sort((a, b) => a - b);
    let gap = -1, thr = 0;
    for (let i = 3; i < kSlots - 3; i++) if (sorted[i + 1] - sorted[i] > gap) { gap = sorted[i + 1] - sorted[i]; thr = 0.5 * (sorted[i + 1] + sorted[i]); }
    for (let slot = 0; slot < kSlots; slot++) seen[ring * kSlots + slot] = val[slot] > thr ? 1 : 0;
  }
  const p = decodeBits(seen);
  const geom = { cx, cy, radius: bestS };
  return p ? { ...p, ...geom } : { fail: true, ...geom };
}
