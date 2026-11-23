// Bubble Code v1 — the optical code that will live inside DockOver's Optical Bubble (Phase 1: the code alone, rendered
// flat; the glass comes in Phase 2). A circular, single-frame code: everything is read from one camera frame.
//
// Geometry (unit disc = the bubble, radius 1):
//   * quiet zone   r 1.00 .. 1.18   dark (the bubble's shadow / dark lens round it)
//   * rim          r 0.93 .. 1.00   bright all round: the finder (the bubble's rim highlight). Its outer edge is fitted
//                                   as an ellipse, so the code reads at any turn and a tilt of the phone (affine).
//   * guard band   r 0.85 .. 0.93   dark: separates the rim from the data and gives every angle a dark reference
//   * data rings   4 rings, centres r 0.785 / 0.665 / 0.545 / 0.425, band 0.10 each, 54 / 46 / 38 / 30 cells
//                  (cells roughly square), bright = 1, dark = 0: 168 cells
//   * gap          r 0.33 .. 0.375 dark
//   * inner ring   r 0.29 .. 0.33  bright all round: a second, concentric locator. A phone held at an angle sees the
//                                   bubble in perspective: the rim alone fixes it only up to an affine map, and at 30
//                                   degrees the inner rings land several pixels off. Rim plus inner ring fix the full
//                                   perspective (the projective map of the disc is set by two concentric circles).
//   * core         r < 0.29 left to the artwork (later: the glass's caustic core; it must stay below rim brightness)
// Bits: ring 0 cells 0..15 hold a fixed sync word (orientation and mirror); the other 152 cells carry a Reed-Solomon
// RS(19, 11) codeword over GF(256) (8 parity bytes: up to 4 damaged bytes corrected), whitened. Data: version (4) |
// flags (4) | secret (64) | spare (16).
// Thresholds are local: each cell is compared with the rim (bright) and the guard band (dark) at its own angle, so a
// brightness gradient, glare or exposure change across the bubble does not flip bits.
// Works in browsers and Node (tests).

export const RINGS = [{ r: 0.785, n: 54 }, { r: 0.665, n: 46 }, { r: 0.545, n: 38 }, { r: 0.425, n: 30 }];
export const BAND = 0.10;
export const RIM = [0.93, 1.0], GUARD = [0.85, 0.93], QUIET = 1.18, INNER = [0.29, 0.33];
export const SYNC = [1, 1, 1, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 0, 1, 1];  // 16 bits, good cyclic sidelobes
export const DATA_BYTES = 11, PARITY = 8, CODE_BYTES = DATA_BYTES + PARITY;
const TOTAL_CELLS = RINGS.reduce((a, r) => a + r.n, 0);

// ---- GF(256) and Reed-Solomon (after "Reed-Solomon codes for coders", primitive 0x11d, generator 2) ---------------
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{ let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; }
const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const gdiv = (a, b) => (a ? EXP[(LOG[a] + 255 - LOG[b]) % 255] : 0);
const gpow = (x, p) => EXP[((LOG[x] * p) % 255 + 255) % 255];
const ginv = (x) => EXP[255 - LOG[x]];
const pscale = (p, x) => p.map((c) => gmul(c, x));
const padd = (p, q) => { const r = new Array(Math.max(p.length, q.length)).fill(0); for (let i = 0; i < p.length; i++) r[i + r.length - p.length] = p[i]; for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i]; return r; };
const pmul = (p, q) => { const r = new Array(p.length + q.length - 1).fill(0); for (let j = 0; j < q.length; j++) for (let i = 0; i < p.length; i++) r[i + j] ^= gmul(p[i], q[j]); return r; };
const peval = (p, x) => { let y = p[0]; for (let i = 1; i < p.length; i++) y = gmul(y, x) ^ p[i]; return y; };
const pdiv = (dividend, divisor) => {
  const out = dividend.slice();
  for (let i = 0; i < dividend.length - (divisor.length - 1); i++) { const c = out[i]; if (c) for (let j = 1; j < divisor.length; j++) if (divisor[j]) out[i + j] ^= gmul(divisor[j], c); }
  const sep = out.length - (divisor.length - 1);
  return [out.slice(0, sep), out.slice(sep)];
};
let GEN = null;
const generator = () => { if (GEN) return GEN; let g = [1]; for (let i = 0; i < PARITY; i++) g = pmul(g, [1, gpow(2, i)]); return (GEN = g); };

export function rsEncode(data) {
  const g = generator(), out = data.concat(new Array(PARITY).fill(0));
  for (let i = 0; i < data.length; i++) { const c = out[i]; if (c) for (let j = 1; j < g.length; j++) out[i + j] ^= gmul(g[j], c); }
  for (let i = 0; i < data.length; i++) out[i] = data[i];
  return out;
}
const syndromes = (msg) => { const s = [0]; for (let i = 0; i < PARITY; i++) s.push(peval(msg, gpow(2, i))); return s; };
// Corrected codeword, or null (more than 4 bad bytes).
export function rsDecode(msgIn) {
  const msg = msgIn.slice();
  let synd = syndromes(msg);
  if (Math.max(...synd) === 0) return msg;
  // Berlekamp-Massey
  let errLoc = [1], oldLoc = [1];
  const shift = synd.length - PARITY;
  for (let i = 0; i < PARITY; i++) {
    const K = i + shift;
    let delta = synd[K];
    for (let j = 1; j < errLoc.length; j++) delta ^= gmul(errLoc[errLoc.length - 1 - j], synd[K - j]);
    oldLoc = oldLoc.concat([0]);
    if (delta) {
      if (oldLoc.length > errLoc.length) { const n = pscale(oldLoc, delta); oldLoc = pscale(errLoc, ginv(delta)); errLoc = n; }
      errLoc = padd(errLoc, pscale(oldLoc, delta));
    }
  }
  while (errLoc.length && errLoc[0] === 0) errLoc.shift();
  const errs = errLoc.length - 1;
  if (errs * 2 > PARITY) return null;
  // Chien search
  const rev = errLoc.slice().reverse(), pos = [];
  for (let i = 0; i < msg.length; i++) if (peval(rev, gpow(2, i)) === 0) pos.push(msg.length - 1 - i);
  if (pos.length !== errs) return null;
  // Forney
  const coefPos = pos.map((p) => msg.length - 1 - p);
  let eLoc = [1];
  for (const i of coefPos) eLoc = pmul(eLoc, padd([1], [gpow(2, i), 0]));
  const [, rem] = pdiv(pmul(synd.slice().reverse(), eLoc), [1].concat(new Array(eLoc.length).fill(0)));
  const errEval = rem.slice().reverse();
  const X = coefPos.map((c) => gpow(2, -(255 - c)));
  const E = new Array(msg.length).fill(0);
  for (let i = 0; i < X.length; i++) {
    const xinv = ginv(X[i]);
    let prime = 1;
    for (let j = 0; j < X.length; j++) if (j !== i) prime = gmul(prime, 1 ^ gmul(xinv, X[j]));
    if (!prime) return null;
    const y = gmul(X[i], peval(errEval.slice().reverse(), xinv));
    E[pos[i]] = gdiv(y, prime);
  }
  for (let i = 0; i < msg.length; i++) msg[i] ^= E[i];
  synd = syndromes(msg);
  return Math.max(...synd) === 0 ? msg : null;
}

// ---- payload <-> cells ----------------------------------------------------------------------------------------------
let WHITE = null;
const whitening = () => { if (WHITE) return WHITE; const w = new Uint8Array(CODE_BYTES * 8); let s = 0x5B; for (let i = 0; i < w.length; i++) { const b = ((s >> 6) ^ (s >> 5)) & 1; s = ((s << 1) | b) & 0x7f; w[i] = b; } return (WHITE = w); };

// payload: { version, flags, secret: BigInt, spare } -> cells[ring][index] (0/1)
export function encode(p) {
  const data = [((p.version & 15) << 4) | (p.flags & 15)];
  for (let i = 0; i < 8; i++) data.push(Number((p.secret >> BigInt(56 - 8 * i)) & 0xffn));
  data.push((p.spare || 0) >> 8 & 255, (p.spare || 0) & 255);
  const cw = rsEncode(data), w = whitening();
  const bits = [...SYNC];
  for (let i = 0; i < CODE_BYTES * 8; i++) bits.push(((cw[i >> 3] >> (7 - (i & 7))) & 1) ^ w[i]);
  const cells = []; let k = 0;
  for (const ring of RINGS) { const row = []; for (let j = 0; j < ring.n; j++) row.push(bits[k++]); cells.push(row); }
  return cells;
}

function bitsToPayload(bits) {  // bits after the sync word (152), whitened
  const w = whitening(), cw = new Array(CODE_BYTES).fill(0);
  for (let i = 0; i < CODE_BYTES * 8; i++) cw[i >> 3] |= (bits[i] ^ w[i]) << (7 - (i & 7));
  const fixed = rsDecode(cw);
  if (!fixed) return null;
  let secret = 0n;
  for (let i = 0; i < 8; i++) secret = (secret << 8n) | BigInt(fixed[1 + i]);
  let corrected = 0; for (let i = 0; i < CODE_BYTES; i++) if (fixed[i] !== cw[i]) corrected++;
  return { version: fixed[0] >> 4, flags: fixed[0] & 15, secret, spare: (fixed[9] << 8) | fixed[10], corrected };
}

// ---- rendering (flat, Phase 1; also the test pictures) ---------------------------------------------------------------
// Draws the code into an RGBA buffer of size x size with the bubble of radius R at (cx, cy). Bright cells are rounded
// arcs of light (gaps between cells), the rim a bright ring, the rest deep blue glass.
export function render(cells, size, opts = {}) {
  const { R = size * 0.38, cx = size / 2, cy = size / 2, bg = [12, 16, 28] } = opts;
  const out = new Uint8ClampedArray(size * size * 4);
  const lit = [210, 235, 255], dark = [16, 32, 70], rim = [235, 245, 255], quiet = [6, 9, 18], core = [28, 52, 110];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    // 2x2 supersampling
    let acc = [0, 0, 0];
    for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
      const dx = (x + 0.25 + sx * 0.5 - cx) / R, dy = (y + 0.25 + sy * 0.5 - cy) / R;
      const r = Math.hypot(dx, dy);
      let c;
      if (r >= QUIET) c = bg;
      else if (r >= RIM[1]) c = quiet;
      else if (r >= RIM[0]) c = rim;
      else if (r >= GUARD[0]) c = dark;
      else {
        c = r < INNER[0] ? core : r < INNER[1] ? rim : dark;
        let a = Math.atan2(dy, dx); if (a < 0) a += 2 * Math.PI;
        for (let k = 0; k < RINGS.length; k++) {
          const ring = RINGS[k];
          if (Math.abs(r - ring.r) > BAND / 2 * 0.86) continue;
          const f = a / (2 * Math.PI) * ring.n, j = Math.floor(f) % ring.n, fr = f - Math.floor(f);
          if (cells[k][j] && fr > 0.07 && fr < 0.93) c = lit;
        }
      }
      acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
    }
    const i = (y * size + x) * 4;
    out[i] = acc[0] / 4; out[i + 1] = acc[1] / 4; out[i + 2] = acc[2] / 4; out[i + 3] = 255;
  }
  return out;
}

// ---- decoding ------------------------------------------------------------------------------------------------------
// img: { w, h, v: Float32Array } brightness 0..1 (max of R, G, B)
export function grayFromRGBA(data, w, h) {
  const v = new Float32Array(w * h);
  for (let i = 0, j = 0; i < v.length; i++, j += 4) v[i] = Math.max(data[j], data[j + 1], data[j + 2]) / 255;
  return { w, h, v };
}
function at(img, x, y) { x = x < 0 ? 0 : x >= img.w ? img.w - 1 : x; y = y < 0 ? 0 : y >= img.h ? img.h - 1 : y; return img.v[y * img.w + x]; }
function bil(img, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  return (at(img, x0, y0) * (1 - fx) + at(img, x0 + 1, y0) * fx) * (1 - fy) + (at(img, x0, y0 + 1) * (1 - fx) + at(img, x0 + 1, y0 + 1) * fx) * fy;
}

// 1. The bubble's rough place and size: a bright disc in a dark surround (centre-surround boxes over several sizes).
function findBlob(img) {
  const cell = Math.max(2, Math.floor(Math.min(img.w, img.h) / 64));
  const gw = Math.floor(img.w / cell), gh = Math.floor(img.h / cell), W = gw + 1;
  const I = new Float64Array(W * (gh + 1));
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    let s = 0; for (let yy = 0; yy < cell; yy++) for (let xx = 0; xx < cell; xx++) s += img.v[(y * cell + yy) * img.w + x * cell + xx];
    I[(y + 1) * W + x + 1] = s + I[y * W + x + 1] + I[(y + 1) * W + x] - I[y * W + x];
  }
  const box = (x0, y0, x1, y1) => { x0 = Math.max(x0, 0); y0 = Math.max(y0, 0); x1 = Math.min(x1, gw - 1); y1 = Math.min(y1, gh - 1); if (x1 < x0 || y1 < y0) return 0; return (I[(y1 + 1) * W + x1 + 1] - I[y0 * W + x1 + 1] - I[(y1 + 1) * W + x0] + I[y0 * W + x0]) / ((x1 - x0 + 1) * (y1 - y0 + 1)); };
  let best = -1e9, bx = img.w / 2, by = img.h / 2, bs = 0;
  // up to a bubble that nearly fills the frame (the surround box is clipped at the frame's edge)
  for (let h = Math.max(2, Math.floor(Math.min(gw, gh) / 14)); h * 2.1 < Math.min(gw, gh); h++) {
    const H = Math.round(h * 1.5);
    const lo = Math.min(H, Math.floor(gw / 2) - 1), loY = Math.min(H, Math.floor(gh / 2) - 1);
    for (let y = Math.max(h, loY); y < gh - Math.max(h, loY); y++) for (let x = Math.max(h, lo); x < gw - Math.max(h, lo); x++) {
      const inner = box(x - h, y - h, x + h, y + h);
      const cnt = (x0, y0, x1, y1) => (Math.min(x1, gw - 1) - Math.max(x0, 0) + 1) * (Math.min(y1, gh - 1) - Math.max(y0, 0) + 1);
      const nAll = cnt(x - H, y - H, x + H, y + H), nIn = cnt(x - h, y - h, x + h, y + h);
      if (nAll - nIn < nIn * 0.3) continue;  // hardly any surround left in the frame
      const ring = (box(x - H, y - H, x + H, y + H) * nAll - inner * nIn) / (nAll - nIn);
      const v = inner - ring;
      if (v > best) { best = v; bx = (x + 0.5) * cell; by = (y + 0.5) * cell; bs = h * cell / 0.88; }
    }
  }
  return best > 0.04 ? { cx: bx, cy: by, s: bs } : null;
}

// 2. The rim's outer edge along rays from the centre, then an ellipse through those points (least squares conic,
//    the worst fifth dropped twice). A tilted phone sees the round bubble as an ellipse; the fit undoes it.
function fitRim(img, g) {
  const pts = [];
  const N = 72;
  for (let k = 0; k < N; k++) {
    const a = 2 * Math.PI * k / N, c = Math.cos(a), s = Math.sin(a);
    const r0 = g.s * 0.7, r1 = g.s * 1.45, step = Math.max(0.4, g.s / 200);
    let bestD = 0, bestR = -1, prev = null, prev2 = null;
    for (let r = r0; r < r1; r += step) {
      const v = bil(img, g.cx + r * c, g.cy + r * s);
      if (prev2 !== null) { const d = v - prev2; if (d < bestD) { bestD = d; bestR = r - step; } }
      prev2 = prev; prev = v;
    }
    if (bestR > 0 && bestD < -0.08) pts.push([g.cx + bestR * c, g.cy + bestR * s]);
  }
  if (pts.length < 20) return null;
  let use = pts, e = null;
  for (let it = 0; it < 3; it++) {
    e = fitEllipse(use, g.cx, g.cy);
    if (!e) return null;
    if (it < 2) {
      const res = use.map((p) => [p, Math.abs(ellipseRadiusRatio(e, p) - 1)]).sort((a, b) => a[1] - b[1]);
      use = res.slice(0, Math.max(20, Math.floor(res.length * 0.8))).map((x) => x[0]);
    }
  }
  return e;
}
// conic A x^2 + B xy + C y^2 + D x + E y = 1 (coordinates relative to (ox, oy)) -> centre, axes, angle
function fitEllipse(pts, ox, oy) {
  const M = Array.from({ length: 5 }, () => new Float64Array(6));
  for (const [px, py] of pts) {
    const x = px - ox, y = py - oy, row = [x * x, x * y, y * y, x, y];
    for (let i = 0; i < 5; i++) { for (let j = 0; j < 5; j++) M[i][j] += row[i] * row[j]; M[i][5] += row[i]; }
  }
  for (let i = 0; i < 5; i++) {  // Gauss-Jordan
    let piv = i; for (let r = i + 1; r < 5; r++) if (Math.abs(M[r][i]) > Math.abs(M[piv][i])) piv = r;
    [M[i], M[piv]] = [M[piv], M[i]];
    if (Math.abs(M[i][i]) < 1e-12) return null;
    for (let r = 0; r < 5; r++) if (r !== i) { const f = M[r][i] / M[i][i]; for (let c = i; c < 6; c++) M[r][c] -= f * M[i][c]; }
  }
  const [A, B, C, D, E] = [0, 1, 2, 3, 4].map((i) => M[i][5] / M[i][i]);
  const den = 4 * A * C - B * B;
  if (den <= 0) return null;
  const x0 = (B * E - 2 * C * D) / den, y0 = (B * D - 2 * A * E) / den;
  // about the centre: A u^2 + B uv + C v^2 = K, with K = 1 + Q(x0, y0) (since D x0 + E y0 = -2 Q at the centre)
  const K = 1 + A * x0 * x0 + B * x0 * y0 + C * y0 * y0;
  const theta = 0.5 * Math.atan2(B, A - C);
  const ct = Math.cos(theta), st = Math.sin(theta);
  const Ap = A * ct * ct + B * ct * st + C * st * st, Cp = A * st * st - B * ct * st + C * ct * ct;
  if (Ap <= 0 || Cp <= 0 || K <= 0) return null;
  return { cx: ox + x0, cy: oy + y0, a: Math.sqrt(K / Ap), b: Math.sqrt(K / Cp), theta };
}
function ellipseRadiusRatio(e, [px, py]) {
  const dx = px - e.cx, dy = py - e.cy, ct = Math.cos(e.theta), st = Math.sin(e.theta);
  const u = (dx * ct + dy * st) / e.a, v = (-dx * st + dy * ct) / e.b;
  return Math.hypot(u, v);
}
// unit-disc point (radius r, angle t) -> image, through the fitted ellipse
// The full map is image = A(boost(x)): `boost` is the projective map of the unit disc onto itself that moves the centre
// to (e.vx, e.vy) (a Lorentz boost on (x, y, 1); it keeps the unit circle), A the affine map of the unit circle onto
// the fitted rim ellipse. Any perspective view of the disc is A . boost . (turn / mirror), the turn found by the sync.
function boost(vx, vy, x, y) {
  const v2 = vx * vx + vy * vy;
  if (v2 < 1e-12) return [x, y];
  const g = 1 / Math.sqrt(1 - v2), vp = vx * x + vy * y, w = g * (1 + vp), k = (g - 1) * vp / v2 + g;
  return [(x + k * vx) / w, (y + k * vy) / w];
}
function mapPoint(e, r, t) {
  let x = r * Math.cos(t), y = r * Math.sin(t);
  if (e.vx || e.vy) [x, y] = boost(e.vx, e.vy, x, y);
  const u = x * e.a, v = y * e.b, ct = Math.cos(e.theta), st = Math.sin(e.theta);
  return [e.cx + u * ct - v * st, e.cy + u * st + v * ct];
}
// 3. Perspective: the inner ring's outer edge (bright -> dark going outwards) along rays in rim-normalised space, then
//    the boost (vx, vy) and radius rho that put those points on one circle once the boost is undone. Gauss-Newton,
//    outliers dropped. Returns { vx, vy } or null (no clear inner ring: the caller keeps the affine map).
function fitInner(img, e) {
  const pts = [], N = 64;
  for (let k = 0; k < N; k++) {
    const a = 2 * Math.PI * k / N, c = Math.cos(a), s = Math.sin(a);
    const ct = Math.cos(e.theta), st = Math.sin(e.theta);
    const at = (r) => {  // a little across the ray too (noise)
      let acc = 0;
      for (let q = -2; q <= 2; q++) {
        const aa = a + q * 0.025, u = r * Math.cos(aa) * e.a, v = r * Math.sin(aa) * e.b;
        acc += bil(img, e.cx + u * ct - v * st, e.cy + u * st + v * ct);
      }
      return acc / 5;
    };
    const r0 = 0.12, r1 = 0.5, M = 64, step = (r1 - r0) / M, val = [];
    for (let i = 0; i <= M; i++) val.push(at(r0 + i * step));
    const d = []; let dmin = 0;
    for (let i = 2; i < M - 1; i++) { d.push(val[i + 2] + val[i + 1] - val[i - 1] - val[i - 2]); dmin = Math.min(dmin, d[d.length - 1]); }
    if (dmin > -0.16) continue;
    // the innermost clear bright -> dark edge (local minimum of the derivative at half the ray's strongest)
    for (let i = 1; i < d.length - 1; i++) {
      if (d[i] < 0.5 * dmin && d[i] <= d[i - 1] && d[i] <= d[i + 1]) {
        // sub-step peak (parabola)
        const den = d[i - 1] - 2 * d[i] + d[i + 1], off = den > 0 ? 0.5 * (d[i - 1] - d[i + 1]) / den : 0;
        const r = r0 + (i + 2 + off) * step;
        pts.push([r * c, r * s]);
        break;
      }
    }
  }
  if (pts.length < 24) return null;
  let use = pts, vx = 0, vy = 0, rho = INNER[1];
  const resid = (p, X, Y, R) => { const [x, y] = boost(-X, -Y, p[0], p[1]); return Math.hypot(x, y) - R; };
  for (let round = 0; round < 3; round++) {
    for (let it = 0; it < 8; it++) {  // Gauss-Newton, numeric Jacobian
      const JtJ = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], Jtr = [0, 0, 0], h = 1e-5;
      for (const p of use) {
        const r0v = resid(p, vx, vy, rho);
        const J = [(resid(p, vx + h, vy, rho) - r0v) / h, (resid(p, vx, vy + h, rho) - r0v) / h, -1];
        for (let i = 0; i < 3; i++) { Jtr[i] += J[i] * r0v; for (let j = 0; j < 3; j++) JtJ[i][j] += J[i] * J[j]; }
      }
      const dlt = solve3(JtJ, Jtr);
      if (!dlt) return null;
      vx -= dlt[0]; vy -= dlt[1]; rho -= dlt[2];
      if (vx * vx + vy * vy > 0.25) return null;  // implausible: more than a steep view
      if (Math.abs(dlt[0]) + Math.abs(dlt[1]) < 1e-6) break;
    }
    if (round < 2) {
      const res = use.map((p) => [p, Math.abs(resid(p, vx, vy, rho))]).sort((a, b) => a[1] - b[1]);
      use = res.slice(0, Math.max(20, Math.floor(res.length * 0.8))).map((x) => x[0]);
    }
  }
  // the inner ring must actually be where it belongs, and round once the boost is undone
  if (Math.abs(rho - INNER[1]) > 0.06) return null;
  const rms = Math.sqrt(use.reduce((a, p) => a + resid(p, vx, vy, rho) ** 2, 0) / use.length);
  if (rms > 0.02) return null;
  return { vx, vy, rho, rms, n: pts.length };
}
function solve3(A, b) {
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  if (Math.abs(D) < 1e-15) return null;
  return [0, 1, 2].map((c) => det(A.map((row, r) => row.map((v, k) => (k === c ? b[r] : v)))) / D);
}
function sampleAt(img, e, r, t, dr, dt, n = 1) {  // mean over a small patch ((2n + 1)^2 points, spanning +-dr, +-dt)
  let s = 0;
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) { const [x, y] = mapPoint(e, r + i * dr / n, t + j * dt / n); s += bil(img, x, y); }
  return s / ((2 * n + 1) * (2 * n + 1));
}

// Full decode of one frame. Returns { ok, payload..., geometry, diagnostics } or { ok: false, stage }.
export function decode(img) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const g = findBlob(img);
  if (!g) return { ok: false, stage: 'no bubble' };
  let e = fitRim(img, g);
  if (!e) return { ok: false, stage: 'no rim', g };
  // refine once from the ellipse's own centre and size
  const e2 = fitRim(img, { cx: e.cx, cy: e.cy, s: (e.a + e.b) / 2 });
  if (e2) e = e2;
  // with the perspective from the inner ring first; the plain affine map if that fails (or there is no inner ring)
  const inner = fitInner(img, e);
  let r = null;
  if (inner) { r = readCode(img, { ...e, vx: inner.vx, vy: inner.vy }); if (r.ok) r.inner = inner; }
  if (!r || !r.ok) { const r2 = readCode(img, e); if (r2.ok || !r) r = r2; }
  r.ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return r;
}

function readCode(img, e) {
  // local references at every angle: rim (bright) and guard band (dark), 128 angles, smoothed
  const NA = 128, refB = new Float64Array(NA), refD = new Float64Array(NA);
  for (let k = 0; k < NA; k++) {
    const t = 2 * Math.PI * k / NA;
    refB[k] = sampleAt(img, e, 0.965, t, 0.008, 0.01);
    refD[k] = sampleAt(img, e, 0.89, t, 0.01, 0.01);
  }
  const ref = (arr, t) => { const f = ((t / (2 * Math.PI)) % 1 + 1) % 1 * NA, i = Math.floor(f), w = f - i; let s = 0; for (let d = -2; d <= 2; d++) s += arr[(i + d + NA) % NA] * (1 - w) + arr[(i + d + 1 + NA) % NA] * w; return s / 5; };
  const contrast = refB.reduce((a, b) => a + b, 0) / NA - refD.reduce((a, b) => a + b, 0) / NA;
  if (contrast < 0.08) return { ok: false, stage: 'low contrast', e };
  // cell value in -1..1 relative to the local references at its angle
  const cellVal = (k, j, t0, mir, fine = 1) => {
    const ring = RINGS[k];
    const t = t0 + (mir ? -1 : 1) * 2 * Math.PI * (j + 0.5) / ring.n;
    const v = sampleAt(img, e, ring.r, t, BAND * 0.22, 2 * Math.PI / ring.n * 0.24, fine);
    const b = ref(refB, t), d = ref(refD, t);
    return ((v - d) / Math.max(b - d, 0.03)) * 2 - 1;
  };
  // orientation: the angle (and mirror) at which ring 0 shows the sync word best; then read and correct
  const n0 = RINGS[0].n, cands = [];
  for (let mir = 0; mir < 2; mir++) for (let step = 0; step < n0 * 8; step++) {
    const t0 = 2 * Math.PI * step / (n0 * 8);
    let score = 0;
    for (let j = 0; j < SYNC.length; j++) score += (SYNC[j] ? 1 : -1) * cellVal(0, j, t0, mir);
    cands.push({ t0, mir, score });
  }
  cands.sort((a, b) => b.score - a.score);
  const tried = [];
  for (const c of cands) {
    if (tried.length >= 6) break;
    const near = (p) => { const d = Math.abs(((c.t0 - p.t0) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI); return p.mir === c.mir && d < 0.6 * 2 * Math.PI / n0; };
    if (tried.some(near)) continue;
    tried.push(c);
    const bits = [], conf = [];
    for (let k = 0; k < RINGS.length; k++) for (let j = k === 0 ? SYNC.length : 0; j < RINGS[k].n; j++) {
      const v = cellVal(k, j, c.t0, c.mir, 2);
      bits.push(v > 0 ? 1 : 0); conf.push(Math.abs(v));
    }
    let p = bitsToPayload(bits);
    // soft decision (Chase): when the hard reading fails, also try flipping the 4 least certain cells in every
    // combination (15 more Reed-Solomon tries; only for the best sync candidate)
    if (!p && tried.length === 1) {
      const weak = conf.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]).slice(0, 4).map((x) => x[1]);
      for (let m = 1; m < 16 && !p; m++) {
        const b2 = bits.slice();
        for (let q = 0; q < 4; q++) if (m & (1 << q)) b2[weak[q]] ^= 1;
        p = bitsToPayload(b2);
      }
    }
    if (p) return { ok: true, ...p, mirrored: !!c.mir, ellipse: e, contrast };
  }
  return { ok: false, stage: 'unreadable', e, contrast };
}

export const CELLS = TOTAL_CELLS;

// Test hooks (not used by the scanner).
export const _internals = { findBlob, fitRim, fitInner, sampleAt, mapPoint, boost };
