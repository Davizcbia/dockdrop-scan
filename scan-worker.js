// Decodes camera frames off the main thread (the full search takes ~0.2 s; the page must stay smooth).
// Messages in:  { id, w, h, gray: Float32Array (transferred) }
// Messages out: { id, ok, secret (hex), flags, cx, cy, radius, ms }  (cx, cy, radius also when only the orb was found)
import { decodeImage } from './orb-code.js';

let hint = null, misses = 0;
self.onmessage = (e) => {
  const { id, w, h, gray } = e.data;
  const t0 = performance.now();
  const img = { w, h, v: gray };
  // Live: start from the last frame's orb (a few ms); every few misses, search the whole frame again.
  let r = hint ? decodeImage(img, hint) : null;
  if (!r || r.fail) r = decodeImage(img);
  const ms = performance.now() - t0;
  if (r && !r.fail) { hint = { cx: r.cx, cy: r.cy, radius: r.radius }; misses = 0; }
  else if (++misses > 3) hint = null;
  if (r && !r.fail) self.postMessage({ id, ok: true, secret: r.secret.toString(16).padStart(16, '0'), flags: r.flags, cx: r.cx, cy: r.cy, radius: r.radius, ms });
  else self.postMessage({ id, ok: false, cx: r ? r.cx : 0, cy: r ? r.cy : 0, radius: r ? r.radius : 0, ms });
};
