// Fused code (experiment, docky-bubble --code-lines): the Bubble Code v1 layout with the finder drawn as the glass's own
// features (bright edge ring, shaded border, faint caustic ring round the core) and the data as faint thin lines - one
// per cell, a little brighter for 1, a little darker for 0. One frame is too faint to read; the scanner:
//   1. finds the bubble in every frame from the finder (strong enough on its own: rim ellipse + inner-ring perspective);
//   2. reads each data ring as a line signal - the line against the glass just inside and outside it, so slow changes
//      in the picture cancel - sampled all round and filed by its angle in the camera picture;
//   3. adds those signals up frame after frame (the moving glass averages away, the lines stay);
//   4. reads the sum like a v1 code: sync word -> turn and mirror, then Reed-Solomon.
import { findRing, RINGS, SYNC, _internals } from './bubble-code.js';

const { findBlob, fitRim, fitInner, sampleAt, mapPoint, bitsToPayload } = _internals;
const OVERS = 8;  // samples per cell round each ring

// The bubble's geometry in one frame, or null.
export function locate(img) {
  const hints = [];
  const b = findBlob(img); if (b) hints.push(b);
  for (const h of findRing(img)) hints.push(h);
  let best = null;
  for (const g of hints) {
    let e = fitRim(img, g);
    if (!e) continue;
    const e2 = fitRim(img, { cx: e.cx, cy: e.cy, s: (e.a + e.b) / 2, e });
    if (e2) e = e2;
    // the finder must be there: rim brighter than the guard band all round
    let rim = 0, guard = 0;
    for (let k = 0; k < 48; k++) { const t = 2 * Math.PI * k / 48; rim += sampleAt(img, e, 0.965, t, 0.008, 0.01); guard += sampleAt(img, e, 0.89, t, 0.01, 0.01); }
    const contrast = (rim - guard) / 48;
    if (contrast < 0.05) continue;
    const fits = fitInner(img, e);
    const geo = fits.length ? { ...e, vx: fits[0].vx, vy: fits[0].vy } : e;
    if (!best || contrast > best.contrast) best = { e: geo, contrast };
    if (contrast > 0.12) break;
  }
  return best;
}

export class LineAccumulator {
  constructor() {
    this.frames = 0;
    this.sum = RINGS.map((r) => new Float64Array(r.n * OVERS));
    this.cnt = RINGS.map((r) => new Float64Array(r.n * OVERS));
  }
  // Adds one frame; false if the bubble was not found in it.
  add(img) {
    const loc = locate(img);
    if (!loc) return false;
    const e = loc.e, [ox, oy] = mapPoint(e, 0, 0);
    RINGS.forEach((ring, k) => {
      const S = ring.n * OVERS, dt = 2 * Math.PI / ring.n * 0.12;
      for (let i = 0; i < S; i++) {
        const t = 2 * Math.PI * (i + 0.5) / S;
        const line = sampleAt(img, e, ring.r, t, 0.006, dt);
        const side = 0.5 * (sampleAt(img, e, ring.r - 0.05, t, 0.006, dt) + sampleAt(img, e, ring.r + 0.05, t, 0.006, dt));
        const [x, y] = mapPoint(e, ring.r, t);
        let phi = Math.atan2(y - oy, x - ox); if (phi < 0) phi += 2 * Math.PI;
        const bin = Math.floor(phi / (2 * Math.PI) * S) % S;
        this.sum[k][bin] += line - side; this.cnt[k][bin]++;
      }
    });
    this.frames++;
    return true;
  }
  // The sum read as a code: { ok, secret, ... } or { ok: false, stage }.
  read() {
    if (!this.frames) return { ok: false, stage: 'no frames' };
    const sig = this.sum.map((s, k) => {
      const out = new Float64Array(s.length);
      for (let i = 0; i < s.length; i++) out[i] = this.cnt[k][i] ? s[i] / this.cnt[k][i] : 0;
      // fill empty bins from their neighbours
      for (let i = 0; i < out.length; i++) if (!this.cnt[k][i]) { const a = out[(i + out.length - 1) % out.length], b = out[(i + 1) % out.length]; out[i] = 0.5 * (a + b); }
      return out;
    });
    // a cell's value at angle phi: the mean over the middle half of the cell
    const cell = (k, phi) => {
      const S = sig[k].length, w = Math.max(1, Math.round(OVERS * 0.25));
      const c = ((phi / (2 * Math.PI)) % 1 + 1) % 1 * S;
      let s = 0; for (let d = -w; d <= w; d++) s += sig[k][(Math.round(c) + d + S * 4) % S];
      return s / (2 * w + 1);
    };
    const val = (k, j, t0, mir) => cell(k, t0 + (mir ? -1 : 1) * 2 * Math.PI * (j + 0.5) / RINGS[k].n);
    // scale: typical size of a cell value (for the soft decision)
    const n0 = RINGS[0].n, cands = [];
    for (let mir = 0; mir < 2; mir++) for (let st = 0; st < n0 * OVERS; st++) {
      const t0 = 2 * Math.PI * st / (n0 * OVERS);
      let score = 0;
      for (let j = 0; j < SYNC.length; j++) score += (SYNC[j] ? 1 : -1) * val(0, j, t0, mir);
      cands.push({ t0, mir, score });
    }
    cands.sort((a, b) => b.score - a.score);
    const tried = [];
    for (const c of cands) {
      if (tried.length >= 6) break;
      if (tried.some((p) => p.mir === c.mir && Math.abs(((c.t0 - p.t0) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI) < 0.6 * 2 * Math.PI / n0)) continue;
      tried.push(c);
      const bits = [], conf = [];
      for (let k = 0; k < RINGS.length; k++) for (let j = k === 0 ? SYNC.length : 0; j < RINGS[k].n; j++) { const v = val(k, j, c.t0, c.mir); bits.push(v > 0 ? 1 : 0); conf.push(Math.abs(v)); }
      let p = bitsToPayload(bits);
      if (!p && tried.length === 1) {  // soft decision: the 4 least certain cells in every combination
        const weak = conf.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]).slice(0, 4).map((x) => x[1]);
        for (let m = 1; m < 16 && !p; m++) { const b2 = bits.slice(); for (let q = 0; q < 4; q++) if (m & (1 << q)) b2[weak[q]] ^= 1; p = bitsToPayload(b2); }
      }
      if (p) return { ok: true, ...p, mirrored: !!c.mir, frames: this.frames };
    }
    return { ok: false, stage: 'unreadable', frames: this.frames };
  }
}
