// Ray code (experiment, docky-bubble --code-rays): the 168 cells of a Bubble Code as faint beams of light from the
// bubble's centre - 28 directions x 6 segments along the radius - each a little brighter (1) or darker (0) than the
// glass halfway to the next beam - and a thin, even edge highlight on the ball; no finder rings. The scanner
//   1. finds the ball in every frame by its edge highlight (radial ridge search from several starting points, an
//      ellipse through the ridge, then tracking from frame to frame);
//   2. flattens the ball into polar coordinates through that ellipse (its symmetric form, so frames agree on angles)
//      and adds the polar pictures up frame after frame (the moving glass averages away, the beams stay);
//   3. reads the sum through a range of perspectives (the projective maps of the disc onto itself: a tilted phone),
//      keeping the one where the sync word fits best: each beam against halfway to its neighbours, turn and mirror
//      from the sync word, Reed-Solomon like any v1 code.
import { RINGS, SYNC, _internals } from './bubble-code.js?v=r3';

const { bitsToPayload, fitEllipse, ellipseRadiusRatio, bil } = _internals;
export const RAYS = 28, SEG = [0.86, 0.78, 0.70, 0.62, 0.54, 0.46, 0.38];  // 28 wide beams x 6 segments
const TOTAL = RINGS.reduce((a, r) => a + r.n, 0);
if (TOTAL !== RAYS * (SEG.length - 1)) throw new Error('ray layout must hold the v1 cells');
const RB = 40, R0 = 0.30, R1 = 0.94, AB = RAYS * 8;  // the polar picture: radius bins x angle bins (8 per beam)
const HALF = Math.PI / RAYS, COS_HALF = Math.cos(HALF), SIN_HALF = Math.sin(HALF);
const POLAR_COS = Float64Array.from({ length: AB }, (_, i) => Math.cos(2 * Math.PI * (i + 0.5) / AB));
const POLAR_SIN = Float64Array.from({ length: AB }, (_, i) => Math.sin(2 * Math.PI * (i + 0.5) / AB));

// Hoist the fixed Lorentz boost coefficients out of the inner sampling loop.
function perspectiveSampler(polar, vx, vy) {
  const v2 = vx * vx + vy * vy;
  if (v2 < 1e-12) return polar;
  const g = 1 / Math.sqrt(1 - v2), gain = (g - 1) / v2;
  return (x, y) => {
    const dot = vx * x + vy * y, w = g * (1 + dot), k = gain * dot + g;
    return polar((x + k * vx) / w, (y + k * vy) / w);
  };
}

function beamDifference(at, r, c, s) {
  return at(r * c, r * s) - 0.5 * (
    at(r * (c * COS_HALF + s * SIN_HALF), r * (s * COS_HALF - c * SIN_HALF)) +
    at(r * (c * COS_HALF - s * SIN_HALF), r * (s * COS_HALF + c * SIN_HALF)));
}

// ---- 1. finding the ball ------------------------------------------------------------------------------------------
const ellipseRange = (e, lo, hi) => (a) => { const da = a - e.theta, rho = 1 / Math.hypot(Math.cos(da) / e.a, Math.sin(da) / e.b); return [rho * lo, rho * hi]; };
export function locate(img, prev = null, dbg = null) {
  if (prev) {  // tracking: the last frame's ellipse, refined where the ridge is now
    const e = ridgeEllipse(img, prev.cx, prev.cy, ellipseRange(prev, 0.9, 1.1));
    if (e && Math.abs((e.a + e.b) / (prev.a + prev.b) - 1) < 0.15 && Math.hypot(e.cx - prev.cx, e.cy - prev.cy) < 0.25 * prev.a) {
      const e2 = ridgeEllipse(img, e.cx, e.cy, ellipseRange(e, 0.95, 1.05));
      return { ...(e2 || e), tracked: true };
    }
  }
  // Full search: from 5 x 5 starting points round the middle, the strongest ridge along each of 36 rays; an ellipse
  // through those peaks (outliers dropped); the start whose ellipse gathers the most strong, consistent peaks wins.
  const m = Math.min(img.w, img.h), dd = Math.max(2, m * 0.011);
  let best = null;
  for (let gy = -2; gy <= 2; gy++) for (let gx = -2; gx <= 2; gx++) {
    const cx = img.w / 2 + gx * m * 0.07, cy = img.h / 2 + gy * m * 0.07, pts = [];
    for (let k = 0; k < 36; k++) {
      const a = 2 * Math.PI * k / 36, c = Math.cos(a), s = Math.sin(a);
      let bv = 0.008, br = -1;
      for (let r = m * 0.05; r < m * 0.49; r += 1) {
        const x = cx + r * c, y = cy + r * s;
        if (x < 2 || y < 2 || x > img.w - 3 || y > img.h - 3) break;
        // a line, not an edge: brighter than both sides (an edge is brighter than one side only)
        const ac = (xx, yy) => (bil(img, xx - s * 1.2, yy + c * 1.2) + bil(img, xx, yy) + bil(img, xx + s * 1.2, yy - c * 1.2)) / 3;
        const v0 = ac(x, y), v = Math.min(v0 - ac(x - dd * c, y - dd * s), v0 - ac(x + dd * c, y + dd * s));
        if (v > bv) { bv = v; br = r; }
      }
      if (br > 0) pts.push([cx + br * c, cy + br * s, bv]);
    }
    if (dbg) dbg.push(`start ${gx},${gy}: ${pts.length} peaks`);
    if (pts.length < 14) continue;
    let use = pts.map((p) => [p[0], p[1]]), e = null;
    for (let it = 0; it < 3 && use.length >= 8; it++) {
      e = fitEllipse(use, cx, cy);
      if (!e) break;
      use = use.map((p) => [p, Math.abs(ellipseRadiusRatio(e, p) - 1)]).sort((x, y) => x[1] - y[1]).slice(0, Math.max(8, Math.floor(use.length * 0.75))).map((x) => x[0]);
    }
    if (!e || !(e.a > m * 0.04) || e.a > m * 0.5 || e.b > m * 0.5 || Math.min(e.a, e.b) / Math.max(e.a, e.b) < 0.55) continue;
    // the start must lie well inside its ellipse (rays from outside cross the rim twice and mislead the fit)
    if (ellipseRadiusRatio(e, [cx, cy]) > 0.5) continue;
    const tol = Math.max(0.03, 1.5 / Math.min(e.a, e.b));
    const inl = pts.filter((p) => Math.abs(ellipseRadiusRatio(e, p) - 1) < tol);
    const score = inl.reduce((acc, p) => acc + p[2], 0);
    if (dbg) dbg.push(`  ellipse ${[e.cx, e.cy, e.a, e.b].map((v) => v.toFixed(0)).join(',')} inliers ${inl.length} score ${score.toFixed(2)}`);
    if (inl.length >= 14 && (!best || score > best.score)) best = { e, score };
  }
  if (!best) return null;
  let e = ridgeEllipse(img, best.e.cx, best.e.cy, ellipseRange(best.e, 0.9, 1.1));
  if (!e) return null;
  return ridgeEllipse(img, e.cx, e.cy, ellipseRange(e, 0.95, 1.05)) || e;
}
function ridgeEllipse(img, cx, cy, range) {
  const pts = [];
  for (let k = 0; k < 72; k++) {
    const a = 2 * Math.PI * k / 72, c = Math.cos(a), s = Math.sin(a), [r0, r1] = range(a);
    const dd = Math.max(1.5, (r0 + r1) * 0.5 * 0.035), step = Math.max(0.3, (r1 - r0) / 60);
    const at = (r) => (bil(img, cx + r * c - r * s * 0.03, cy + r * s + r * c * 0.03) + bil(img, cx + r * c, cy + r * s) + bil(img, cx + r * c + r * s * 0.03, cy + r * s - r * c * 0.03)) / 3;
    const rs = [], vs = [];
    for (let r = r0; r <= r1; r += step) { const v0 = at(r); rs.push(r); vs.push(Math.min(v0 - at(r - dd), v0 - at(r + dd))); }
    let bi = -1, bv = 0.008;
    for (let i = 1; i < vs.length - 1; i++) if (vs[i] > bv && vs[i] >= vs[i - 1] && vs[i] >= vs[i + 1]) { bv = vs[i]; bi = i; }
    if (bi < 0) continue;
    const den = vs[bi - 1] - 2 * vs[bi] + vs[bi + 1], off = den < 0 ? 0.5 * (vs[bi - 1] - vs[bi + 1]) / den : 0;
    const r = rs[bi] + off * step;
    pts.push([cx + r * c, cy + r * s]);
  }
  if (pts.length < 24) return null;
  let use = pts, e = null;
  for (let it = 0; it < 3; it++) {
    e = fitEllipse(use, cx, cy);
    if (!e) return null;
    if (it < 2) use = use.map((p) => [p, Math.abs(ellipseRadiusRatio(e, p) - 1)]).sort((x, y) => x[1] - y[1]).slice(0, Math.max(20, Math.floor(use.length * 0.75))).map((x) => x[0]);
  }
  return e;
}

// ---- 2. adding frames up --------------------------------------------------------------------------------------------
export class RayAccumulator {
  constructor() {
    this.frames = 0;
    this.sum = new Float64Array(RB * AB);
    this.prev = null;
    this.lastLock = null;
  }
  add(img) {
    const old = this.lastLock;
    const e = locate(img, this.prev);
    this.prev = e;
    if (!e) return false;
    if (old && !e.tracked && (Math.hypot(e.cx - old.cx, e.cy - old.cy) > 0.30 * old.a ||
        Math.abs((e.a + e.b) / (old.a + old.b) - 1) >= 0.18 ||
        Math.abs(Math.min(e.a, e.b) / Math.max(e.a, e.b) - Math.min(old.a, old.b) / Math.max(old.a, old.b)) >= 0.12)) {
      // A substantially different framing should not inherit a stale polar image.
      this.sum.fill(0);
      this.frames = 0;
    }
    this.lastLock = e;
    // the ellipse as a symmetric map (R diag(a, b) R^T): unit circle -> ellipse, angles as in the picture
    const c = Math.cos(e.theta), s = Math.sin(e.theta);
    const m11 = e.a * c * c + e.b * s * s, m12 = (e.a - e.b) * c * s, m22 = e.a * s * s + e.b * c * c;
    for (let ri = 0; ri < RB; ri++) {
      const rho = R0 + (ri + 0.5) * (R1 - R0) / RB;
      for (let ai = 0; ai < AB; ai++) {
        const yx = rho * POLAR_COS[ai], yy = rho * POLAR_SIN[ai];
        this.sum[ri * AB + ai] += bil(img, e.cx + m11 * yx + m12 * yy, e.cy + m12 * yx + m22 * yy);
      }
    }
    this.frames++;
    return true;
  }

  reacquire() { this.prev = null; }

  // ---- 3. reading -------------------------------------------------------------------------------------------------
  read({ quick = false } = {}) {
    if (!this.frames) return { ok: false, stage: 'no frames' };
    const round = this.prev && Math.min(this.prev.a, this.prev.b) / Math.max(this.prev.a, this.prev.b) > 0.94;
    if (quick && !round) return { ok: false, stage: 'adding up', frames: this.frames };
    const P = this.sum.map((v) => v / this.frames);
    const polar = (x, y) => {  // the averaged picture at a point of the normalised disc (bilinear)
      const rho = Math.hypot(x, y);
      let fr = (rho - R0) / (R1 - R0) * RB - 0.5; fr = Math.max(0, Math.min(RB - 1.001, fr));
      let phi = Math.atan2(y, x); if (phi < 0) phi += 2 * Math.PI;
      const fa = phi / (2 * Math.PI) * AB - 0.5, ia = Math.floor(fa), wa = fa - ia, ir = Math.floor(fr), wr = fr - ir;
      const a0 = ((ia % AB) + AB) % AB, a1 = (a0 + 1) % AB;
      return (P[ir * AB + a0] * (1 - wa) + P[ir * AB + a1] * wa) * (1 - wr) + (P[(ir + 1) * AB + a0] * (1 - wa) + P[(ir + 1) * AB + a1] * wa) * wr;
    };
    const makeVal = (vx, vy) => {
      const at = perspectiveSampler(polar, vx, vy);
      // one cell: the beam against halfway to its neighbours, at 4 radii of its segment
      return (idx, t0, mir) => {
        const k = Math.floor(idx / RAYS), j = idx % RAYS, t = t0 + (mir ? -1 : 1) * 2 * Math.PI * (j + 0.5) / RAYS;
        const lo = SEG[k + 1] + 0.015, hi = SEG[k] - 0.015, c = Math.cos(t), s = Math.sin(t);
        let d = 0;
        for (let q = 0; q < 4; q++) d += beamDifference(at, lo + (hi - lo) * q / 3, c, s);
        return d / 4;
      };
    };
    const syncBest = (val, step) => {
      const out = [];
      for (let mir = 0; mir < 2; mir++) for (let st = 0; st < AB; st += step) {
        const t0 = 2 * Math.PI * st / AB;
        let score = 0;
        for (let j = 0; j < SYNC.length; j++) score += (SYNC[j] ? 1 : -1) * val(j, t0, mir);
        out.push({ t0, mir, score });
      }
      return out.sort((a, b) => b.score - a.score);
    };
    // The exact centre and perspective, from the data: the beams are sharpest when the map is right (a centre off by
    // half a pixel already costs many bits). Two measures, each searched coarse then fine, the best two of each tried:
    //   energy:  beam strength |d| summed over the 168 cells at the best of the 8 phases within a beam spacing (the
    //            beams' places are known up to that phase; a busy picture's texture does not line up with them);
    //   stripes: radial-stripe energy at every angle (best when the picture behind is smooth).
    const energy = (vx, vy) => {
      const val = makeVal(vx, vy);
      let best = 0;
      for (let ph = 0; ph < 8; ph++) {
        const t0 = 2 * Math.PI * ph / AB;
        let E = 0;
        for (let i = 0; i < TOTAL; i++) E += Math.abs(val(i, t0, 0));
        if (E > best) best = E;
      }
      return best;
    };
    const stripes = (vx, vy) => {  // radial-stripe energy at every angle (works when the picture is smooth)
      const at = perspectiveSampler(polar, vx, vy);
      let E = 0;
      for (let k = 0; k < SEG.length - 1; k++) for (let q = 0; q < 3; q++) {
        const r = SEG[k + 1] + 0.03 + (SEG[k] - SEG[k + 1] - 0.06) * q / 2;
        for (let i = 0; i < AB; i += 2) {
          const t = 2 * Math.PI * i / AB;
          const d = beamDifference(at, r, Math.cos(t), Math.sin(t));
          E += d * d;
        }
      }
      return E;
    };
    const search = (measure) => {
      const coarse = [];
      for (let iy = -6; iy <= 6; iy++) for (let ix = -6; ix <= 6; ix++) { const vx = ix * 0.025, vy = iy * 0.025; if (vx * vx + vy * vy < 0.0256) coarse.push({ vx, vy, E: measure(vx, vy) }); }
      coarse.sort((a, b) => b.E - a.E);
      const fine = [];
      for (const c0 of coarse.slice(0, 2)) for (let iy = -4; iy <= 4; iy++) for (let ix = -4; ix <= 4; ix++) { const vx = c0.vx + ix * 0.004, vy = c0.vy + iy * 0.004; fine.push({ vx, vy, E: measure(vx, vy) }); }
      return fine.sort((a, b) => b.E - a.E).slice(0, 2);
    };
    const tryPerspective = (vx, vy) => {
      const val = makeVal(vx, vy), cands = syncBest(val, 1), tried = [];
      for (const c of cands) {
        if (tried.length >= 4) break;
        if (tried.some((p) => p.mir === c.mir && Math.abs(((c.t0 - p.t0) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI) < 0.6 * 2 * Math.PI / RAYS)) continue;
        tried.push(c);
        for (const dl of [0, -0.5, 0.5]) {
          const t0 = c.t0 + dl * 2 * Math.PI / AB;
          const bits = [], conf = [];
          for (let i = SYNC.length; i < TOTAL; i++) { const v = val(i, t0, c.mir); bits.push(v > 0 ? 1 : 0); conf.push(Math.abs(v)); }
          let p = bitsToPayload(bits);
          if (!quick && !p && tried.length === 1 && dl === 0) {
            const weak = conf.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]).slice(0, 4).map((x) => x[1]);
            for (let mm = 1; mm < 16 && !p; mm++) { const b2 = bits.slice(); for (let q = 0; q < 4; q++) if (mm & (1 << q)) b2[weak[q]] ^= 1; p = bitsToPayload(b2); }
          }
          if (p && (!quick || p.corrected <= 1)) return { ok: true, ...p, mirrored: !!c.mir, frames: this.frames, perspective: [vx, vy] };
        }
      }
      return null;
    };
    // A near-round finder often needs no projective correction. Keep the
    // full perspective search for captures that fail the first attempt.
    if (round) {
      const result = tryPerspective(0, 0);
      if (result) return result;
    }
    if (quick) return { ok: false, stage: 'adding up', frames: this.frames };
    for (const { vx, vy } of [...search(energy), ...search(stripes)]) {
      const result = tryPerspective(vx, vy);
      if (result) return result;
    }
    return { ok: false, stage: 'unreadable', frames: this.frames };
  }
}
