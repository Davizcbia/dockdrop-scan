// Optical Bubble scanner (Phase 1: does the code scan on real phones?). The camera, live decoding in a worker, live
// diagnostics, then the same pairing as before (../pair.js). Also the QR fallback: the phone's own camera app opens
// this page with #s=<secret>, and it pairs straight away.
import { SIGNAL_URL as CONFIG_SIGNAL } from '../config.js';
import { pair } from '../pair.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const SIGNAL_URL = params.get('signal') || CONFIG_SIGNAL;
const video = $('video'), fx = $('fx'), finder = $('finder');
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
const grab = document.createElement('canvas');
const gctx = grab.getContext('2d', { willReadFrequently: true });
const SIZE = 400;  // decoded square (px)
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const DEBUG = params.get('debug') !== '0';  // Phase 1: diagnostics on unless ?debug=0

let stream = null, scanning = false, busy = false, frameId = 0, pairing = null;
// statistics for this camera session
let st = null;
const newStats = () => ({ t0: performance.now(), firstFrame: 0, frames: 0, decoded: 0, found: 0, ok: 0, msSum: 0, last: null, zoom: 1, reads: [], fpsT: performance.now(), fpsN: 0, fps: 0, camFps: 0, res: '' });

function status(text, { spin = false, cancel = false } = {}) {
  $('statusText').textContent = text || '';
  $('spinner').hidden = !spin;
  $('cancel').hidden = !cancel;
  $('status').hidden = !text;
}
function hint(text) { $('hint').textContent = text; }
function showSheet(el) { el.hidden = false; void el.getBoundingClientRect(); setTimeout(() => el.classList.add('show'), 16); }
function hideSheet(el) {
  if (el.hidden) return Promise.resolve();
  el.classList.remove('show');
  return new Promise((r) => setTimeout(() => { el.hidden = true; r(); }, reducedMotion ? 200 : 320));
}

// The part of the camera picture to decode: the finder's square (84 vmin round 50 % / 46 % of the screen), through the
// video's object-fit: cover. zoom 2 takes the middle half of it at twice the resolution (a bubble far away).
let cropScreen = null;
function crop(zoom) {
  const vw = video.videoWidth, vh = video.videoHeight, W = innerWidth, H = innerHeight;
  const scale = Math.max(W / vw, H / vh), ox = (W - vw * scale) / 2, oy = (H - vh * scale) / 2;
  const sidePx = Math.min(W, H) * 0.92 / zoom, side = sidePx / scale;
  const cx = (W / 2 - ox) / scale, cy = (H * 0.46 - oy) / scale;
  cropScreen = { left: W / 2 - sidePx / 2, top: H * 0.46 - sidePx / 2, side: sidePx };
  return { x: cx - side / 2, y: cy - side / 2, side };
}
function grabFrame(zoom) {
  const c = crop(zoom);
  grab.width = SIZE; grab.height = SIZE;
  gctx.fillStyle = '#000'; gctx.fillRect(0, 0, SIZE, SIZE);
  gctx.drawImage(video, c.x, c.y, c.side, c.side, 0, 0, SIZE, SIZE);
  const d = gctx.getImageData(0, 0, SIZE, SIZE).data, gray = new Float32Array(SIZE * SIZE);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = Math.max(d[j], d[j + 1], d[j + 2]) / 255;
  return { gray, screen: { ...cropScreen } };
}
function decode(gray) {
  return new Promise((resolve) => {
    const id = ++frameId;
    const on = (e) => { if (e.data.id === id) { worker.removeEventListener('message', on); resolve(e.data); } };
    worker.addEventListener('message', on);
    worker.postMessage({ id, w: SIZE, h: SIZE, gray }, [gray.buffer]);
  });
}

// Accepting a reading: a Reed-Solomon codeword that needed no correction is certain (all 8 check bytes agree by
// chance 1 in 2^64); one that was corrected must be read the same twice within 2 s.
function accept(r) {
  if (r.corrected === 0) return true;
  const now = performance.now();
  st.reads = st.reads.filter((x) => now - x.t < 2000);
  const again = st.reads.some((x) => x.secret === r.secret);
  st.reads.push({ secret: r.secret, t: now });
  return again;
}

function drawOverlay(r, screen) {
  const dpr = window.devicePixelRatio || 1;
  if (fx.width !== innerWidth * dpr) { fx.width = innerWidth * dpr; fx.height = innerHeight * dpr; }
  const ctx = fx.getContext('2d');
  ctx.clearRect(0, 0, fx.width, fx.height);
  if (!DEBUG || !r || !r.ellipse) return;
  const k = screen.side / SIZE * dpr, e = r.ellipse;
  ctx.save();
  ctx.translate((screen.left + e.cx * screen.side / SIZE) * dpr, (screen.top + e.cy * screen.side / SIZE) * dpr);
  ctx.rotate(e.theta);
  ctx.strokeStyle = r.ok ? 'rgba(120,255,170,0.9)' : 'rgba(255,200,90,0.8)'; ctx.lineWidth = 2 * dpr;
  ctx.beginPath(); ctx.ellipse(0, 0, e.a * k, e.b * k, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

function showDiag() {
  if (!DEBUG || !st) return;
  const now = performance.now(), l = st.last;
  $('diag').hidden = false;
  $('diag').textContent =
    `相机 ${st.res} @ ${st.camFps ? st.camFps.toFixed(0) : '?'} fps · 解码 ${st.fps.toFixed(1)} 帧/s · 平均 ${(st.msSum / Math.max(1, st.decoded)).toFixed(0)} ms\n` +
    `已解码 ${st.decoded} 帧 · 找到光泡 ${st.found} · 读出 ${st.ok} · 用时 ${((now - st.t0) / 1000).toFixed(1)} s · 缩放 ${st.zoom}x\n` +
    (l ? `上一帧：${l.ok ? '读出 …' + l.secret.slice(-4) + (l.corrected ? `（纠正 ${l.corrected} 字节）` : '') : (l.stage || '-')}` +
         `${l.ellipse ? ` · 半径 ${((l.ellipse.a + l.ellipse.b) / 2).toFixed(0)} px` : ''}${l.contrast ? ` · 对比 ${l.contrast.toFixed(2)}` : ''}` +
         `${l.perspective != null ? ` · 透视 ${l.perspective.toFixed(3)}` : ''}${l.mirrored ? ' · 镜像' : ''}` : '');
}

// QR in the camera too, where the browser can (BarcodeDetector: Android Chrome / Samsung Internet; not iOS Safari).
let qrDetector = null;
if ('BarcodeDetector' in window) {
  BarcodeDetector.getSupportedFormats().then((f) => { if (f.includes('qr_code')) qrDetector = new BarcodeDetector({ formats: ['qr_code'] }); }).catch(() => {});
}
let qrBusy = false, qrTick = 0;
function tryQR() {
  if (!qrDetector || qrBusy || ++qrTick % 6) return;
  qrBusy = true;
  qrDetector.detect(video).then((codes) => {
    qrBusy = false;
    for (const c of codes) { const m = /#s=([0-9a-f]{16})/.exec(c.rawValue || ''); if (m && scanning) { found({ secret: m[1], via: 'qr' }); return; } }
  }).catch(() => { qrBusy = false; });
}

function loop() {
  if (!scanning) return;
  if (video.readyState >= 2) {
    if (!st.firstFrame) st.firstFrame = performance.now();
    tryQR();
    if (!busy) {
      busy = true;
      // a bubble that is small in the picture: every other frame looks at the middle at twice the resolution
      const zoom = st.last && st.last.ellipse ? (st.last.ellipse.a < 34 && st.zoom === 1 ? 2 : st.last.ellipse.a > 170 && st.zoom === 2 ? 1 : st.zoom) : (st.frames % 2 ? 2 : 1);
      st.zoom = zoom; st.frames++;
      const { gray, screen } = grabFrame(zoom);
      decode(gray).then((r) => {
        busy = false;
        if (!scanning) return;
        st.decoded++; st.msSum += r.ms; st.fpsN++;
        const now = performance.now();
        if (now - st.fpsT > 1000) { st.fps = st.fpsN * 1000 / (now - st.fpsT); st.fpsN = 0; st.fpsT = now; }
        if (r.ellipse) st.found++;
        st.last = r;
        drawOverlay(r, screen);
        finder.classList.toggle('locked', !!r.ellipse);
        hint(r.ellipse ? '找到光泡，保持不动' : '把光泡放进圆圈里');
        if (r.ok) { st.ok++; if (accept(r)) { found({ ...r, via: 'bubble' }); return; } }
        showDiag();
      });
    }
  }
  requestAnimationFrame(loop);
}

async function startCamera() {
  if (!window.isSecureContext || !navigator.mediaDevices) { status('相机需要 HTTPS 页面'); return; }
  status('正在打开相机…', { spin: true });
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
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
  hint('把光泡放进圆圈里');
  st = newStats();
  const s = stream.getVideoTracks()[0].getSettings ? stream.getVideoTracks()[0].getSettings() : {};
  st.res = `${s.width || video.videoWidth}x${s.height || video.videoHeight}`; st.camFps = s.frameRate || 0;
  scanning = true; requestAnimationFrame(loop);
}
function stopCamera() { scanning = false; if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; } video.srcObject = null; drawOverlay(null); }

async function backToStart() {
  if (pairing) { pairing.abort(); pairing = null; }
  stopCamera();
  status(''); $('diag').hidden = true;
  $('close').hidden = true;
  await hideSheet($('result'));
  finder.classList.remove('hidden', 'locked');
  hint('把光泡放进圆圈里');
  showSheet($('start'));
}

const ERRORS = {
  'no peer': ['电脑没有回应', '这个光泡可能已经过期（每分钟换一次）。请对准电脑上当前的光泡重新扫描。'],
  'timeout': ['连接超时', '请确认手机和电脑连着同一个网络，然后再试一次。'],
  'signalling unreachable': ['连不上配对服务', '请检查手机的网络连接，然后再试一次。'],
  'authentication failed': ['验证没有通过', '请重新扫描电脑上当前显示的光泡。'],
  'room busy': ['这个光泡正在和别的设备配对', '请等一下，或等电脑换一个新的光泡。'],
};

async function found(r) {
  scanning = false;
  const scanT = st ? (performance.now() - (st.firstFrame || st.t0)) / 1000 : 0;
  const metrics = st ? `识别：${r.via === 'qr' ? '二维码' : '光泡'} · 第一帧后 ${scanT.toFixed(2)} s · 解码 ${st.decoded} 帧 · 平均 ${(st.msSum / Math.max(1, st.decoded)).toFixed(0)} ms` + (r.corrected ? ` · 纠正 ${r.corrected} 字节` : '') : '识别：备用二维码（相机应用）';
  if (navigator.vibrate) navigator.vibrate(20);
  finder.classList.add('hidden'); $('diag').hidden = true;
  hint('已识别');
  stopCamera();
  if (!SIGNAL_URL) { showResult('已识别光泡', `配对码 …${r.secret.slice(-4)}（配对服务未配置，只测试了扫描）`, false, metrics); return; }
  const ctl = new AbortController(); pairing = ctl;
  const t0 = performance.now();
  try {
    const name = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document ? 'iPad' : /Android/.test(navigator.userAgent) ? 'Android 手机' : '浏览器';
    status('正在连接…', { spin: true, cancel: true });
    const res = await pair({ signalUrl: SIGNAL_URL, secret: r.secret, role: 'guest', name, signal: ctl.signal, onStatus: (t) => status(t, { spin: true, cancel: true }) });
    pairing = null; status(''); $('close').hidden = true;
    if (navigator.vibrate) navigator.vibrate([12, 60, 12]);
    showResult('已连接', `已和 ${res.peerName || '电脑'} 配对。`, false, metrics + `\n握手 ${((performance.now() - t0) / 1000).toFixed(2)} s`);
    window.dockdropLink = res;
  } catch (e) {
    pairing = null;
    if (e.message === 'cancelled') return;
    status(''); $('close').hidden = true;
    const [title, text] = ERRORS[e.message] || ['没能连接', '请确认手机和电脑连着同一个网络，然后再试一次。（' + e.message + '）'];
    showResult(title, text, true, metrics);
  }
}

function showResult(title, text, failed = false, metrics = '') {
  $('resultTitle').textContent = title;
  $('resultText').textContent = text;
  if (metrics) { const m = document.createElement('span'); m.className = 'metrics'; m.textContent = metrics; $('resultText').appendChild(m); }
  const check = $('result').querySelector('.check');
  check.hidden = failed;
  finder.classList.add('hidden');
  const path = check.querySelector('path'); path.style.animation = 'none'; void path.getBoundingClientRect(); path.style.animation = '';
  showSheet($('result'));
}

$('go').onclick = startCamera;
$('close').onclick = backToStart;
$('cancel').onclick = backToStart;
$('again').onclick = async () => { await hideSheet($('result')); startCamera(); };

// QR fallback: opened by the phone's camera app with the secret in the fragment (never sent to any server). Pair at once
// and drop the fragment, so a reload does not reuse the one-time code.
{
  const m = /(?:^#|&)s=([0-9a-f]{16})/.exec(location.hash);
  if (m) {
    history.replaceState(null, '', location.pathname + location.search);
    hideSheet($('start')).then(() => found({ secret: m[1], via: 'qr-app' }));
  }
}
window.bubbleStats = () => st;  // tests
