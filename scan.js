// DockDrop scanner page: the camera, live decoding in a worker, the "absorbed" animation, then pairing.
import { SIGNAL_URL as CONFIG_SIGNAL } from './config.js';
import { pair } from './pair.js';

const $ = (id) => document.getElementById(id);
// ?signal=<ws url> overrides the configured relay (local tests: web/dev-server.mjs).
const SIGNAL_URL = new URLSearchParams(location.search).get('signal') || CONFIG_SIGNAL;
const video = $('video'), fx = $('fx'), finder = $('finder');
const worker = new Worker(new URL('./scan-worker.js', import.meta.url), { type: 'module' });
const grab = document.createElement('canvas');
const gctx = grab.getContext('2d', { willReadFrequently: true });
const SIZE = 360;  // decoded square (px): the finder's area of the camera picture
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

let stream = null, busy = false, frameId = 0, scanning = false, prevGeom = null, cropRect = null, pairing = null;
// Dynamic code (the orb's arcs flare one after another): every camera frame goes into a running maximum, so after about
// one flare cycle (1.2 s) the picture holds every arc; the decoder reads that picture (a static code reads at once).
let acc = null, accT = 0;
function accumulate(gray) {
  const now = performance.now();
  if (!acc || now - accT > 500) { acc = gray.slice(); accT = now; return; }  // first frame, or the camera stalled
  const fade = Math.pow(0.985, (now - accT) / 33.3);  // 1.5 % per 30 fps frame, whatever the camera's rate
  accT = now;
  for (let i = 0; i < acc.length; i++) { const a = acc[i] * fade; acc[i] = a > gray[i] ? a : gray[i]; }
}

// ---- status pill: what is happening, a spinner while waiting, and a way out ------------------------------------------
function status(text, { spin = false, cancel = false } = {}) {
  $('statusText').textContent = text || '';
  $('spinner').hidden = !spin;
  $('cancel').hidden = !cancel;
  $('status').hidden = !text;
}
function hint(text) { $('hint').textContent = text; }

// ---- sheets: rise in from the bottom, leave the same way ---------------------------------------------------------------
function showSheet(el) {
  el.hidden = false;
  void el.getBoundingClientRect();  // commit the hidden pose, then transition to shown (no rAF: works in a background tab)
  setTimeout(() => el.classList.add('show'), 16);
}
function hideSheet(el) {
  if (el.hidden) return Promise.resolve();
  el.classList.remove('show');
  return new Promise((r) => setTimeout(() => { el.hidden = true; r(); }, reducedMotion ? 200 : 320));
}

// The decoder gets the camera pixels under the finder circle (72 vmin wide, centred at 50 % / 46 % of the screen),
// mapped through the video's object-fit: cover. Also remembers where that square is on screen (for the animation).
function finderCrop(vw, vh) {
  const W = innerWidth, H = innerHeight;
  const scale = Math.max(W / vw, H / vh);              // screen px per video px
  const ox = (W - vw * scale) / 2, oy = (H - vh * scale) / 2;
  const sidePx = Math.min(W, H) * 0.72 * 1.12;         // a little margin round the finder
  const side = sidePx / scale;
  const cx = (W / 2 - ox) / scale, cy = (H * 0.46 - oy) / scale;
  cropRect = { left: W / 2 - sidePx / 2, top: H * 0.46 - sidePx / 2, side: sidePx };
  return { x: cx - side / 2, y: cy - side / 2, side };
}

function toGray() {
  const d = gctx.getImageData(0, 0, SIZE, SIZE).data;
  const gray = new Float32Array(SIZE * SIZE);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = Math.max(d[j], d[j + 1], d[j + 2]) / 255;
  return gray;
}

function grabFrame() {
  const c = finderCrop(video.videoWidth, video.videoHeight);
  grab.width = SIZE; grab.height = SIZE;
  gctx.drawImage(video, c.x, c.y, c.side, c.side, 0, 0, SIZE, SIZE);
  return toGray();
}

function decode(gray) {
  return new Promise((resolve) => {
    const id = ++frameId;
    const on = (e) => { if (e.data.id === id) { worker.removeEventListener('message', on); resolve(e.data); } };
    worker.addEventListener('message', on);
    worker.postMessage({ id, w: SIZE, h: SIZE, gray }, [gray.buffer]);
  });
}

// An orb is "in view" when two frames in a row find it in about the same place: the finder tightens and says so.
function steady(r) {
  const ok = r.radius > 12 && prevGeom && Math.hypot(r.cx - prevGeom.cx, r.cy - prevGeom.cy) < r.radius * 0.15 && Math.abs(r.radius - prevGeom.radius) < r.radius * 0.12;
  prevGeom = r.radius > 12 ? r : null;
  return ok;
}

async function loop() {
  if (!scanning) return;
  if (video.readyState >= 2) {
    accumulate(grabFrame());  // every frame (cheap); decoding runs whenever the worker is free
    if (!busy) {
      busy = true;
      decode(acc.slice()).then((r) => {
        busy = false;
        if (!scanning) return;
        if (r.ok) { onFound(r); return; }
        const lock = steady(r);
        finder.classList.toggle('locked', lock);
        hint(lock ? '找到光点，保持不动' : '把光点放进圆圈里');
      });
    }
  }
  requestAnimationFrame(loop);
}

async function startCamera() {
  if (!window.isSecureContext || !navigator.mediaDevices) { status('相机需要 HTTPS 页面'); return; }
  status('正在打开相机…', { spin: true });
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
  } catch (e) {
    status(e.name === 'NotAllowedError' ? '没有相机权限：请在浏览器设置里允许本网站使用相机' : '无法打开相机：' + e.message);
    return;
  }
  video.srcObject = stream;
  await video.play().catch(() => {});
  status('');
  await hideSheet($('start'));
  $('close').hidden = false;
  finder.classList.remove('hidden', 'locked');
  hint('把光点放进圆圈里');
  prevGeom = null; acc = null;
  scanning = true; requestAnimationFrame(loop);
}

function stopCamera() { scanning = false; if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; } video.srcObject = null; }

// Close (camera mode) and Cancel (while connecting): always a way back to the start.
async function backToStart() {
  if (pairing) { pairing.abort(); pairing = null; }
  stopCamera();
  status('');
  $('close').hidden = true;
  await hideSheet($('result'));
  finder.classList.remove('hidden', 'locked');
  hint('把光点放进圆圈里');
  showSheet($('start'));
}

// ---- success: the orb's light gathers where the orb is and is drawn in (the computer's animation, mirrored) ----------
function absorb(at) {
  const ctx = fx.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  fx.width = innerWidth * dpr; fx.height = innerHeight * dpr;
  if (reducedMotion) return new Promise((r) => setTimeout(r, 150));
  const cx = at.x * dpr, cy = at.y * dpr, R = Math.max(at.r * dpr * 1.6, 40 * dpr);
  const n = 900, parts = [];
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, r = R * (0.55 + 0.5 * Math.random());
    parts.push({ a, r, d: Math.random() * 0.25, s: (0.6 + Math.random() * 1.6) * dpr, w: 2.2 + Math.random() * 1.5 });
  }
  const t0 = performance.now();
  return new Promise((resolve) => {
    // rAF does not run in a hidden tab: never let the animation hold up pairing
    let finished = false;
    const finish = () => { if (!finished) { finished = true; ctx.clearRect(0, 0, fx.width, fx.height); resolve(); } };
    setTimeout(finish, 1500);
    const step = (now) => {
      if (finished) return;
      const t = (now - t0) / 1000;
      ctx.clearRect(0, 0, fx.width, fx.height);
      ctx.globalCompositeOperation = 'lighter';
      for (const p of parts) {
        const k = Math.min(1, Math.max(0, (t - p.d) / 0.75)), e = k * k * (3 - 2 * k);
        const r = p.r * Math.pow(1 - e, 1.4), a = p.a + e * p.w;
        const alpha = (1 - Math.max(0, (k - 0.85) / 0.15)) * 0.8;
        ctx.fillStyle = `rgba(${120 + 100 * e | 0},${190 + 50 * e | 0},255,${alpha})`;
        ctx.beginPath(); ctx.arc(cx + r * Math.cos(a), cy + r * Math.sin(a), p.s, 0, Math.PI * 2); ctx.fill();
      }
      const flash = Math.exp(-Math.pow((t - 1.0) / 0.1, 2));
      if (flash > 0.01) {
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.2);
        g.addColorStop(0, `rgba(170,220,255,${flash})`); g.addColorStop(1, 'rgba(170,220,255,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, fx.width, fx.height);
      }
      if (t < 1.3) requestAnimationFrame(step); else finish();
    };
    requestAnimationFrame(step);
  });
}

const ERRORS = {
  'no peer': ['电脑没有回应', '请确认电脑上的配对窗口还开着。光点每分钟会换一次，如果刚刚换过，请重新扫描。'],
  'timeout': ['连接超时', '请确认手机和电脑连着同一个网络，然后再试一次。'],
  'signalling unreachable': ['连不上配对服务', '请检查手机的网络连接，然后再试一次。'],
  'authentication failed': ['验证没有通过', '请重新扫描电脑上当前显示的光点。'],
  'room busy': ['这个光点正在和别的设备配对', '请等一下，或在电脑上换一个新的光点。'],
};

async function onFound(r) {
  scanning = false;
  // the orb's place on screen: the decoder's position inside the finder square (or the middle for a test image)
  const crop = cropRect || { left: innerWidth / 2 - 180, top: innerHeight * 0.46 - 180, side: 360 };
  const at = { x: crop.left + r.cx / SIZE * crop.side, y: crop.top + r.cy / SIZE * crop.side, r: r.radius / SIZE * crop.side };
  status('');
  if (navigator.vibrate) navigator.vibrate(20);  // the same frame the animation starts (cause and feedback together)
  finder.classList.add('hidden');
  hint('已识别');
  await absorb(at);
  stopCamera();
  if (!SIGNAL_URL) {
    $('close').hidden = true;
    showResult('已识别光点', `配对码 ${r.secret.slice(0, 4)}…${r.secret.slice(-4)}（配对服务还没配置，只测试了扫描）`);
    return;
  }
  const ctl = new AbortController(); pairing = ctl;
  try {
    const name = /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android 手机' : '浏览器';
    status('正在连接…', { spin: true, cancel: true });
    const res = await pair({ signalUrl: SIGNAL_URL, secret: r.secret, role: 'guest', name, signal: ctl.signal,
                             onStatus: (t) => status(t, { spin: true, cancel: true }) });
    pairing = null;
    status('');
    $('close').hidden = true;
    if (navigator.vibrate) navigator.vibrate([12, 60, 12]);
    showResult('已连接', `已和 ${res.peerName || '电脑'} 配对。`);
    window.dockdropLink = res;  // next: device keys, DockDrop, clipboard
  } catch (e) {
    pairing = null;
    if (e.message === 'cancelled') return;
    status('');
    $('close').hidden = true;
    const [title, text] = ERRORS[e.message] || ['没能连接', '请确认手机和电脑连着同一个网络，然后再试一次。（' + e.message + '）'];
    showResult(title, text, true);
  }
}

function showResult(title, text, failed = false) {
  $('resultTitle').textContent = title; $('resultText').textContent = text;
  const check = $('result').querySelector('.check');
  check.hidden = failed;
  finder.classList.add('hidden');
  // restart the checkmark's stroke animation each time
  const path = check.querySelector('path'); path.style.animation = 'none'; void path.getBoundingClientRect(); path.style.animation = '';
  showSheet($('result'));
}

$('go').onclick = startCamera;
$('close').onclick = backToStart;
$('cancel').onclick = backToStart;
$('again').onclick = async () => { await hideSheet($('result')); startCamera(); };

// Test without a camera: a screenshot of the orb (also ?image=<url>).
async function testImage(img) {
  await hideSheet($('start'));
  status('正在识别图片…', { spin: true });
  const c = document.createElement('canvas');
  const side = Math.max(img.naturalWidth, img.naturalHeight);  // centred in a square, as the finder would see it
  c.width = side; c.height = side;
  const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, side, side);
  x.drawImage(img, (side - img.naturalWidth) / 2, (side - img.naturalHeight) / 2);
  grab.width = SIZE; grab.height = SIZE;
  gctx.drawImage(c, 0, 0, side, side, 0, 0, SIZE, SIZE);
  cropRect = null;
  const r = await decode(toGray());
  window.lastScan = r;
  if (r.ok) onFound(r); else { status(''); showResult('没有找到光点', '这张图里没有识别出配对光点。', true); }
}
$('file').onchange = (e) => {
  const f = e.target.files[0]; if (!f) return;
  const img = new Image(); img.onload = () => testImage(img); img.src = URL.createObjectURL(f);
  e.target.value = '';
};
const q = new URLSearchParams(location.search).get('image');
if (q) { const img = new Image(); img.onload = () => testImage(img); img.src = q; }
