// Decodes camera frames off the main thread.
// In:  { id, w, h, gray: Float32Array (transferred), mode: 'v1' | 'rays' } or { reset: true }
// Out: { id, ok, secret (hex), flags, corrected, mirrored, perspective, ellipse {cx, cy, a, b, theta}, contrast, stage,
//        ms, frames }
//   v1:   Bubble Code v1, every frame read on its own (bubble-code.js).
//   rays: try a cheap early read after 2 frames, then the full search every 4 frames.
//         the sum starts afresh when the ball is lost or after 48 frames without a reading.
import { decode } from './bubble-code.js?v=r3';
import { RayAccumulator } from './rays.js?v=early1';

let acc = null, misses = 0, patternTick = 0;
const now = () => performance.now();

self.onmessage = (e) => {
  if (e.data.reset) { acc = null; misses = 0; patternTick = 0; return; }
  const { id, w, h, gray, mode } = e.data;
  const t0 = now();
  const img = { w, h, v: gray };
  if (mode === 'rays') {
    // Sample the static fallback on the same camera stream as the primary rays.
    if (patternTick++ % 5 === 0) {
      const ring = decode(img);
      if (ring.ok) {
        acc = null; misses = 0;
        const el = ring.ellipse || ring.e;
        self.postMessage({ id, ok: true, pattern: 'rings', frames: 1, ms: now()-t0,
          secret: ring.secret.toString(16).padStart(16, '0'), flags: ring.flags,
          corrected: ring.corrected, mirrored: ring.mirrored, contrast: ring.contrast,
          ellipse: el && { cx: el.cx, cy: el.cy, a: el.a, b: el.b, theta: el.theta } });
        return;
      }
    }
    if (!acc) acc = new RayAccumulator();
    const found = acc.add(img);
    misses = found ? 0 : misses + 1;
    let r = { ok: false, stage: found ? 'adding up' : 'no ball' };
    if (found && acc.frames === 2) r = acc.read({ quick: true });
    else if (found && acc.frames % 4 === 0) r = acc.read();
    const p = acc.prev;
    const out = {
      id, ok: !!r.ok, ms: now() - t0, stage: r.ok ? '' : r.stage, frames: acc.frames, contrast: 0,
      secret: r.ok ? r.secret.toString(16).padStart(16, '0') : '', flags: r.flags, corrected: r.corrected, mirrored: r.mirrored,
      perspective: r.perspective ? Math.hypot(r.perspective[0], r.perspective[1]) : null,
      ellipse: p ? { cx: p.cx, cy: p.cy, a: p.a, b: p.b, theta: p.theta } : null,
    };
    if (r.ok || misses > 5 || acc.frames >= 48) { acc = null; misses = 0; }
    else if (found && acc.frames % 12 === 0) acc.reacquire();
    self.postMessage(out);
    return;
  }
  let r;
  try { r = decode(img); } catch (err) { r = { ok: false, stage: 'error: ' + err.message }; }
  const el = r.ellipse || r.e;
  self.postMessage({
    id, ok: !!r.ok, ms: now() - t0, stage: r.stage || '', contrast: r.contrast || 0,
    secret: r.ok ? r.secret.toString(16).padStart(16, '0') : '', flags: r.flags, corrected: r.corrected, mirrored: r.mirrored,
    perspective: r.inner ? Math.hypot(r.inner.vx, r.inner.vy) : null,
    ellipse: el ? { cx: el.cx, cy: el.cy, a: el.a, b: el.b, theta: el.theta } : null,
  });
};
