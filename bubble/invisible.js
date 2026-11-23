// Candidate B (experiment): the Bubble Code as an invisible watermark - the ball's brightness nudged up or down by a few
// per cent in the v1 layout. One frame shows nothing readable; the moving glass (ripples, caustics) averages away over
// frames while the static code adds up. So: align each frame to the first (phone shake), average, take away the slow
// picture (high-pass), find the code's rim ring, and read the result with the ordinary v1 decoder.
import { decode, findRing } from './bubble-code.js';

function boxBlur(v, w, h, k) {  // separable box blur, radius k
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let acc = 0; const row = y * w;
    for (let x = -k; x <= k; x++) acc += v[row + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = acc / (2 * k + 1);
      acc += v[row + Math.min(w - 1, x + k + 1)] - v[row + Math.max(0, x - k)];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -k; y <= k; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / (2 * k + 1);
      acc += tmp[Math.min(h - 1, y + k + 1) * w + x] - tmp[Math.max(0, y - k) * w + x];
    }
  }
  return out;
}
function gradMag(v, w, h, step) {  // gradient magnitude on a grid of `step` px
  const gw = Math.floor(w / step), gh = Math.floor(h / step), g = new Float32Array(gw * gh);
  for (let y = 1; y < gh - 1; y++) for (let x = 1; x < gw - 1; x++) {
    const at = (xx, yy) => v[(yy * step) * w + xx * step];
    g[y * gw + x] = Math.abs(at(x + 1, y) - at(x - 1, y)) + Math.abs(at(x, y + 1) - at(x, y - 1));
  }
  return { g, gw, gh };
}
function bilinear(v, w, h, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const at = (xx, yy) => v[Math.min(h - 1, Math.max(0, yy)) * w + Math.min(w - 1, Math.max(0, xx))];
  return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
}

export class Accumulator {
  constructor() { this.n = 0; }
  // img: { w, h, v } grey frames of the same size
  add(img) {
    const { w, h, v } = img;
    if (!this.n) {
      this.w = w; this.h = h; this.sum = Float32Array.from(v); this.first = Float32Array.from(v); this.n = 1;
      this.ref = gradMag(v, w, h, 2);
      return { dx: 0, dy: 0 };
    }
    // translation against the first frame: coarse on a 2 px grid (+-20 px), then +-2 px, then sub-pixel
    const cur = gradMag(v, w, h, 2), R = this.ref;
    const ssd = (dx, dy, g, gw, gh, rg) => {
      let s = 0, n = 0;
      for (let y = 4; y < gh - 4; y += 2) for (let x = 4; x < gw - 4; x += 2) {
        const xx = x + dx, yy = y + dy;
        if (xx < 1 || yy < 1 || xx >= gw - 1 || yy >= gh - 1) continue;
        const d = g[yy * gw + xx] - rg[y * gw + x]; s += d * d; n++;
      }
      return n ? s / n : 1e9;
    };
    let best = 1e18, bx = 0, by = 0;
    for (let dy = -10; dy <= 10; dy++) for (let dx = -10; dx <= 10; dx++) { const s = ssd(dx, dy, cur.g, cur.gw, cur.gh, R.g); if (s < best) { best = s; bx = dx; by = dy; } }
    // refine at full resolution round (2 bx, 2 by)
    const full = gradMag(v, w, h, 1), refFull = this.refFull || (this.refFull = gradMag(this.first, w, h, 1));
    const scores = {};
    let fx = 2 * bx, fy = 2 * by, fb = 1e18;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const s = ssd(2 * bx + dx, 2 * by + dy, full.g, full.gw, full.gh, refFull.g); scores[`${dx},${dy}`] = s;
      if (s < fb) { fb = s; fx = 2 * bx + dx; fy = 2 * by + dy; }
    }
    const sub = (a, b, c) => { const den = a - 2 * b + c; return den > 0 ? 0.5 * (a - c) / den : 0; };
    const ox = fx - 2 * bx, oy = fy - 2 * by;
    const sx = Math.abs(ox) < 2 ? sub(scores[`${ox - 1},${oy}`], fb, scores[`${ox + 1},${oy}`]) : 0;
    const sy = Math.abs(oy) < 2 ? sub(scores[`${ox},${oy - 1}`], fb, scores[`${ox},${oy + 1}`]) : 0;
    const dx = fx + sx, dy = fy + sy;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) this.sum[y * w + x] += bilinear(v, w, h, x + dx, y + dy);
    this.n++;
    return { dx, dy };
  }
  average() { const a = new Float32Array(this.sum.length); for (let i = 0; i < a.length; i++) a[i] = this.sum[i] / this.n; return { w: this.w, h: this.h, v: a }; }
}

// The slow picture taken away, then stretched to 0..1 round 0.5.
function highPass(img, k) {
  const { w, h, v } = img, lo = boxBlur(v, w, h, k), out = new Float32Array(w * h);
  let s2 = 0; for (let i = 0; i < v.length; i++) { const d = v[i] - lo[i]; out[i] = d; s2 += d * d; }
  const sd = Math.sqrt(s2 / v.length) || 1e-6;
  for (let i = 0; i < out.length; i++) out[i] = Math.min(1, Math.max(0, 0.5 + out[i] / (5 * sd)));
  return { w, h, v: out };
}
export function decodeInvisible(avg) {
  const t0 = performance.now();
  // ring candidates on a lightly high-passed picture; each may be the rim or the inner ring (0.31 of the rim)
  const hp5 = highPass(avg, 5);
  const tries = [];
  for (const c of findRing(hp5, { count: 4 })) { tries.push(c); tries.push({ ...c, s: c.s * 0.965 / 0.31 }); }
  let last = { ok: false, stage: 'no ring' };
  for (const h of tries) {
    if (h.s > Math.min(avg.w, avg.h) * 0.6) continue;
    const k = Math.max(4, Math.round(h.s * 0.22));
    const r = decode(highPass(avg, k), { hint: { cx: h.cx, cy: h.cy, s: h.s, ring: true } });
    if (r.ok) { r.ring = h; r.ms = performance.now() - t0; return r; }
    last = r;
  }
  last.ms = performance.now() - t0;
  return last;
}
