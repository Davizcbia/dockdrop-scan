// Decodes Bubble Code frames off the main thread.
// In:  { id, w, h, gray: Float32Array (transferred) }
// Out: { id, ok, secret (hex), flags, corrected, mirrored, perspective, ellipse {cx, cy, a, b, theta}, contrast, stage, ms }
import { decode } from './bubble-code.js';

self.onmessage = (e) => {
  const { id, w, h, gray } = e.data;
  const t0 = performance.now();
  let r;
  try { r = decode({ w, h, v: gray }); } catch (err) { r = { ok: false, stage: 'error: ' + err.message }; }
  const ms = performance.now() - t0;
  const el = r.ellipse || r.e;
  self.postMessage({
    id, ok: !!r.ok, ms, stage: r.stage || '', contrast: r.contrast || 0,
    secret: r.ok ? r.secret.toString(16).padStart(16, '0') : '', flags: r.flags, corrected: r.corrected, mirrored: r.mirrored,
    perspective: r.inner ? Math.hypot(r.inner.vx, r.inner.vy) : null,
    ellipse: el ? { cx: el.cx, cy: el.cy, a: el.a, b: el.b, theta: el.theta } : null,
  });
};
