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

let stream = null, busy = false, frameId = 0, found = null, lastGeom = null, scanning = false;

function status(text) { const s = $('status'); s.textContent = text; s.hidden = !text; }

// The decoder gets the camera pixels under the finder circle (72 vmin wide, centred at 50 % / 46 % of the screen),
// mapped through the video's object-fit: cover.
function finderCrop(vw, vh) {
  const W = innerWidth, H = innerHeight;
  const scale = Math.max(W / vw, H / vh);              // screen px per video px
  const ox = (W - vw * scale) / 2, oy = (H - vh * scale) / 2;
  const sidePx = Math.min(W, H) * 0.72 * 1.12;         // a little margin round the finder
  const side = sidePx / scale;
  const cx = (W / 2 - ox) / scale, cy = (H * 0.46 - oy) / scale;
  return { x: cx - side / 2, y: cy - side / 2, side };
}

function grabFrame(source, sw, sh) {
  const c = finderCrop(sw, sh);
  grab.width = SIZE; grab.height = SIZE;
  gctx.drawImage(source, c.x, c.y, c.side, c.side, 0, 0, SIZE, SIZE);
  const d = gctx.getImageData(0, 0, SIZE, SIZE).data;
  const gray = new Float32Array(SIZE * SIZE);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = Math.max(d[j], d[j + 1], d[j + 2]) / 255;
  return gray;
}

function decode(gray) {
  return new Promise((resolve) => {
    const id = ++frameId;
    const on = (e) => { if (e.data.id === id) { worker.removeEventListener('message', on); resolve(e.data); } };
    worker.addEventListener('message', on);
    worker.postMessage({ id, w: SIZE, h: SIZE, gray }, [gray.buffer]);
  });
}

async function loop() {
  if (!scanning) return;
  if (!busy && video.readyState >= 2) {
    busy = true;
    const r = await decode(grabFrame(video, video.videoWidth, video.videoHeight));
    busy = false;
    lastGeom = r.radius > 0 ? r : null;
    finder.classList.toggle('locked', !!lastGeom);
    if (r.ok && scanning) return onFound(r);
  }
  requestAnimationFrame(loop);
}

async function startCamera() {
  if (!window.isSecureContext || !navigator.mediaDevices) {
    status('相机需要 HTTPS 页面'); return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
  } catch (e) {
    status('无法打开相机：' + (e.name === 'NotAllowedError' ? '请在设置里允许使用相机' : e.message)); return;
  }
  video.srcObject = stream;
  await video.play().catch(() => {});
  $('start').hidden = true; status('');
  scanning = true; requestAnimationFrame(loop);
}

function stopCamera() { scanning = false; if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; } }

// ---- success: the finder's light gathers into the middle and is drawn in (the orb's own animation, mirrored) --------
function absorb() {
  const ctx = fx.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  fx.width = innerWidth * dpr; fx.height = innerHeight * dpr;
  const cx = fx.width / 2, cy = fx.height * 0.46, R = Math.min(fx.width, fx.height) * 0.36;
  const n = 900, parts = [];
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, r = R * (0.55 + 0.5 * Math.random());
    parts.push({ a, r, d: Math.random() * 0.25, s: (0.6 + Math.random() * 1.6) * dpr, w: 2.2 + Math.random() * 1.5 });
  }
  const t0 = performance.now();
  return new Promise((resolve) => {
    const step = (now) => {
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
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.9);
        g.addColorStop(0, `rgba(170,220,255,${flash})`); g.addColorStop(1, 'rgba(170,220,255,0)');
        ctx.fillStyle = g; ctx.fillRect(0, 0, fx.width, fx.height);
      }
      if (t < 1.3) requestAnimationFrame(step); else { ctx.clearRect(0, 0, fx.width, fx.height); resolve(); }
    };
    requestAnimationFrame(step);
  });
}

async function onFound(r) {
  scanning = false;
  found = r;
  if (navigator.vibrate) navigator.vibrate(30);
  finder.classList.add('hidden');
  $('hint').textContent = '已识别';
  await absorb();
  stopCamera();
  if (!SIGNAL_URL) {
    showResult('已识别光点', `配对码 ${r.secret.slice(0, 4)}…${r.secret.slice(-4)}（配对服务还没配置，只测试了扫描）`);
    return;
  }
  try {
    const name = /iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android 手机' : '浏览器';
    const res = await pair({ signalUrl: SIGNAL_URL, secret: r.secret, role: 'guest', name, onStatus: status });
    status('');
    showResult('已连接', `已和 ${res.peerName || '电脑'} 配对。`);
    window.dockdropLink = res;  // next: device keys, DockDrop, clipboard
  } catch (e) {
    status('');
    showResult('没能连接', e.message === 'authentication failed' ? '验证失败：请重新扫描电脑上当前显示的光点。' : '请确认手机和电脑连着同一个网络，然后再试一次。（' + e.message + '）', true);
  }
}

function showResult(title, text, failed = false) {
  $('resultTitle').textContent = title; $('resultText').textContent = text;
  $('result').querySelector('.check').hidden = failed;
  $('result').hidden = false;
}

$('go').onclick = startCamera;
$('again').onclick = () => { $('result').hidden = true; finder.classList.remove('hidden', 'locked'); $('hint').textContent = '把光点放进圆圈里'; startCamera(); };

// Test without a camera: a screenshot of the orb (also ?image=<url>).
async function testImage(img) {
  $('start').hidden = true; status('正在识别图片…');
  const c = document.createElement('canvas');
  // center the picture in a square so the finder crop sees all of it
  const side = Math.max(img.naturalWidth, img.naturalHeight);
  c.width = side; c.height = side;
  const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, side, side);
  x.drawImage(img, (side - img.naturalWidth) / 2, (side - img.naturalHeight) / 2);
  grab.width = SIZE; grab.height = SIZE;
  gctx.drawImage(c, 0, 0, side, side, 0, 0, SIZE, SIZE);
  const d = gctx.getImageData(0, 0, SIZE, SIZE).data;
  const gray = new Float32Array(SIZE * SIZE);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = Math.max(d[j], d[j + 1], d[j + 2]) / 255;
  const r = await decode(gray);
  window.lastScan = r;
  if (r.ok) onFound(r); else { status(''); showResult('没有找到光点', '这张图里没有识别出配对光点。', true); }
}
$('file').onchange = (e) => {
  const f = e.target.files[0]; if (!f) return;
  const img = new Image(); img.onload = () => testImage(img); img.src = URL.createObjectURL(f);
};
const q = new URLSearchParams(location.search).get('image');
if (q) { const img = new Image(); img.onload = () => testImage(img); img.src = q; }
