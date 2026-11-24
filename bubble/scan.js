// Optical Bubble scanner (Phase 1: does the code scan on real phones?). The camera decodes in a worker, then uses the shared pairing protocol (../pair.js). Also the QR fallback: the phone's own camera app opens
// this page with #s=<secret>, and it pairs straight away.
import { SIGNAL_URL as CONFIG_SIGNAL } from '../config.js';
import { pair } from '../pair.js';
import { startCameraGlass } from './glass.js?v=glass1';
import { receiveTransfer, sendTransfer, validateTransfer } from './transfer.js?v=transfer2';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const SIGNAL_URL = params.get('signal') || CONFIG_SIGNAL;
const SHOW_METRICS = params.get('debug') === '1';
const video = $('video'), focus = $('focus');
const ALIGN_HINT = '将光泡对准画面中央';
const worker = new Worker(new URL('./worker.js?v=early1', import.meta.url), { type: 'module' });
const SIZE = 400;  // decoded square (px)
const grab = document.createElement('canvas');
grab.width = grab.height = SIZE;
const gctx = grab.getContext('2d', { willReadFrequently: true });
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
// The glass ball uses the faint ray code. ?mode=v1 selects the older code.
const MODE = params.get('mode') === 'v1' ? 'v1' : 'rays';
// ?nopair=1: only show what was read (tests without a computer waiting to pair)
let scanOnly = params.get('nopair') === '1';

let stream = null, scanning = false, busy = false, frameId = 0, pairing = null;
let cameraFrame, glassFrame, stopGlass;
const useVideoFrames = typeof video.requestVideoFrameCallback === 'function';
let pendingRead = null;
let activeTransfer = null;
let draft = { files: [], text: '' };
let receiveMode = false;
const downloadUrls = [];
// statistics for this camera session
let st = null;
const newStats = () => ({ t0: performance.now(), firstFrame: 0, firstLock: 0, frames: 0, decoded: 0, found: 0, ok: 0, msSum: 0, last: null, zoom: 1, reads: [] });

function status(text, { spin = false, cancel = false } = {}) {
  $('statusText').textContent = text || '';
  $('spinner').hidden = !spin;
  $('cancel').hidden = !cancel;
  $('status').hidden = !text;
}
function hint(text) { $('hint').textContent = scanOnly ? `测试模式 · ${text}` : text; }
function showSheet(el) { el.hidden = false; void el.getBoundingClientRect(); setTimeout(() => el.classList.add('show'), 16); }
function hideSheet(el) {
  if (el.hidden) return Promise.resolve();
  el.classList.remove('show');
  return new Promise((r) => setTimeout(() => { el.hidden = true; r(); }, reducedMotion ? 200 : 320));
}

// Crop around the center of the clear preview, accounting for object-fit: cover.
// Zoom 2 takes the middle half at twice the resolution for distant targets.
function crop(zoom) {
  const vw = video.videoWidth, vh = video.videoHeight, W = innerWidth, H = innerHeight;
  const scale = Math.max(W / vw, H / vh), ox = (W - vw * scale) / 2, oy = (H - vh * scale) / 2;
  const sidePx = Math.min(W, H) * 0.92 / zoom, side = sidePx / scale;
  const cx = (W / 2 - ox) / scale, cy = (H * 0.46 - oy) / scale;
  return { x: cx - side / 2, y: cy - side / 2, side };
}
function grabFrame(zoom) {
  const c = crop(zoom);
  gctx.fillStyle = '#000'; gctx.fillRect(0, 0, SIZE, SIZE);
  gctx.drawImage(video, c.x, c.y, c.side, c.side, 0, 0, SIZE, SIZE);
  const d = gctx.getImageData(0, 0, SIZE, SIZE).data, gray = new Float32Array(SIZE * SIZE);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = Math.max(d[j], d[j + 1], d[j + 2]) / 255;
  return gray;
}
function decode(gray) {
  return new Promise((resolve) => {
    const id = ++frameId;
    const on = (e) => { if (e.data.id === id) { worker.removeEventListener('message', on); resolve(e.data); } };
    worker.addEventListener('message', on);
    worker.postMessage({ id, w: SIZE, h: SIZE, gray, mode: MODE }, [gray.buffer]);
  });
}

// Accepting a reading: a Reed-Solomon codeword that needed no correction is certain (all 8 check bytes agree by
// chance 1 in 2^64); one that was corrected must be read the same twice within 2 s.
function accept(r) {
  if (MODE === 'rays') return true;  // the sum of many frames, Reed-Solomon checked; the pairing's HMAC checks again
  if (r.corrected === 0) return true;
  const now = performance.now();
  st.reads = st.reads.filter((x) => now - x.t < 2000);
  const again = st.reads.some((x) => x.secret === r.secret);
  st.reads.push({ secret: r.secret, t: now });
  return again;
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

function scheduleScan() {
  cameraFrame = useVideoFrames ? video.requestVideoFrameCallback(loop) : requestAnimationFrame(loop);
}

function loop() {
  if (!scanning) return;
  if (video.readyState >= 2) {
    if (!st.firstFrame) st.firstFrame = performance.now();
    tryQR();
    if (!busy) {
      busy = true;
      // a bubble that is small in the picture: every other frame looks at the middle at twice the resolution
      let zoom = st.last && st.last.ellipse ? (st.last.ellipse.a < 34 && st.zoom === 1 ? 2 : st.last.ellipse.a > 170 && st.zoom === 2 ? 1 : st.zoom) : (st.frames % 2 ? 2 : 1);
      if (MODE === 'rays') zoom = 1;  // the frames are added up: always the same crop
      st.zoom = zoom; st.frames++;
      const gray = grabFrame(zoom);
      const session = st;
      decode(gray).then((r) => {
        busy = false;
        if (!scanning || session !== st) return;
        st.decoded++; st.msSum += r.ms;
        if (r.ellipse) {
          if (!st.firstLock) st.firstLock = performance.now();
          st.found++;
        }
        st.last = r;
        hint(r.ellipse ? '找到光泡，保持不动' : ALIGN_HINT);
        if (r.ok) { st.ok++; if (accept(r)) { found({ ...r, via: 'bubble' }); return; } }
      });
    }
  }
  scheduleScan();
}

async function startCamera() {
  draft = receiveMode ? { files: [], text: '' } : { files: [...$('sendFiles').files], text: $('sendText').value };
  try { validateTransfer(draft.files, draft.text); }
  catch (error) { status(error.message); return; }
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
  hint(ALIGN_HINT);
  st = newStats();
  worker.postMessage({ reset: true });
  focus.hidden = false;
  scanning = true; scheduleScan();
  glassFrame = requestAnimationFrame(() => {
    if (scanning) stopGlass = startCameraGlass(video, [$('close'), document.querySelector('.top.scan-control')]);
  });
}
function stopCamera() {
  scanning = false;
  if (useVideoFrames) video.cancelVideoFrameCallback(cameraFrame);
  else cancelAnimationFrame(cameraFrame);
  cancelAnimationFrame(glassFrame);
  stopGlass?.();
  stopGlass = null;
  focus.hidden = true;
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  video.srcObject = null;
}

async function backToStart() {
  if (pairing) { pairing.abort(); pairing = null; }
  if (activeTransfer) { activeTransfer.pc.close(); activeTransfer = null; }
  if (window.dockdropLink) { window.dockdropLink.pc.close(); window.dockdropLink = null; }
  pendingRead = null;
  stopCamera();
  status('');
  $('close').hidden = true;
  await hideSheet($('result'));
  clearReceived();
  hint(ALIGN_HINT);
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
  const lockT = st?.firstLock ? (st.firstLock - st.firstFrame) / 1000 : null;
  const lock = lockT == null ? '' : ` · 首次定位 ${lockT.toFixed(2)} s`;
  const metrics = st ? `识别：${r.via === 'qr' ? '二维码' : '光泡'} · 第一帧后 ${scanT.toFixed(2)} s${lock} · 定位 ${st.found}/${st.decoded} 帧 · 平均 ${(st.msSum / Math.max(1, st.decoded)).toFixed(0)} ms` + (r.corrected ? ` · 纠正 ${r.corrected} 字节` : '') : '识别：备用二维码（相机应用）';
  if (navigator.vibrate) navigator.vibrate(20);
  hint('已识别');
  stopCamera();
  if (!SIGNAL_URL || scanOnly) {
    const text = SIGNAL_URL
      ? '这是只读码的测试模式。点「继续配对」后，电脑才会收到连接结果。'
      : '配对服务尚未配置。';
    showResult('已读码，未配对', `配对码 …${r.secret.slice(-4)}。\n${text}`, false, metrics);
    if (SIGNAL_URL) {
      pendingRead = { r, metrics };
      $('continuePair').hidden = false;
      $('again').classList.add('secondary');
    }
    return;
  }
  await connect(r, metrics);
}

async function connect(r, metrics) {
  hint('已识别，正在配对');
  const ctl = new AbortController(); pairing = ctl;
  const t0 = performance.now();
  try {
    const name = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document ? 'iPad' : /Android/.test(navigator.userAgent) ? 'Android 手机' : '浏览器';
    status('正在连接…', { spin: true, cancel: true });
    const res = await pair({ signalUrl: SIGNAL_URL, secret: r.secret, role: 'guest', name, signal: ctl.signal, onStatus: (t) => status(t, { spin: true, cancel: true }) });
    pairing = null; status(''); $('close').hidden = true;
    const details = metrics + `\n握手 ${((performance.now() - t0) / 1000).toFixed(2)} s`;
    if (draft.files.length || draft.text) {
      await transmit(res, details);
      return;
    }
    if (receiveMode && await acceptDesktopTransfer(res, details, r.via === 'qr-app')) return;
    hint('已连接');
    if (navigator.vibrate) navigator.vibrate([12, 60, 12]);
    showResult('已连接', `已和 ${res.peerName || '电脑'} 配对。`, false, details);
    window.dockdropLink = res;
  } catch (e) {
    pairing = null;
    if (e.message === 'cancelled') return;
    status(''); $('close').hidden = true;
    const [title, text] = ERRORS[e.message] || ['没能连接', '请确认手机和电脑连着同一个网络，然后再试一次。（' + e.message + '）'];
    showResult(title, text, true, metrics);
  }
}

async function transmit(connection, metrics) {
  activeTransfer = connection;
  const payload = draft;
  hint('正在发送');
  status('正在等待电脑接收…', { spin: true, cancel: true });
  try {
    await sendTransfer(connection.channel, payload, (bytes, total, name) => {
      const progress = total ? ` · ${Math.floor(100 * bytes / total)}%` : '';
      status(`正在发送 ${name}${progress}`, { spin: true, cancel: true });
    });
    if (activeTransfer !== connection) return;
    $('sendFiles').value = '';
    $('sendText').value = '';
    draft = { files: [], text: '' };
    hint('已发送');
    const count = payload.files.length;
    const sent = count ? `${count} 个文件${payload.text ? '和文字' : ''}` : '文字';
    showResult('已发送', `电脑已接收${sent}。`, false, metrics);
    window.dockdropLink = connection;
  } catch (error) {
    if (activeTransfer !== connection) return;
    connection.pc.close();
    hint('发送未完成');
    showResult('发送未完成', error.message, true, metrics);
  } finally {
    if (activeTransfer === connection) { activeTransfer = null; status(''); }
  }
}

function clearReceived() {
  for (const url of downloadUrls.splice(0)) URL.revokeObjectURL(url);
  $('received').replaceChildren();
  $('received').hidden = true;
}

function showReceived(files, text) {
  const panel = $('received');
  if (text) {
    const value = document.createElement('textarea');
    value.value = text;
    value.readOnly = true;
    value.rows = 2;
    value.setAttribute('aria-label', '收到的文字');
    const copy = document.createElement('button');
    copy.className = 'button secondary';
    copy.textContent = '复制文字';
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = '已复制';
      } catch {
        value.focus();
        value.select();
      }
    };
    panel.append(value, copy);
  }
  for (const file of files) {
    const link = document.createElement('a');
    const url = URL.createObjectURL(file);
    downloadUrls.push(url);
    link.href = url;
    link.download = file.name;
    link.textContent = `保存 ${file.name}`;
    panel.append(link);
  }
  panel.hidden = false;
}

async function acceptDesktopTransfer(connection, metrics, fromQr) {
  activeTransfer = connection;
  hint('等待电脑发送');
  status('正在检查电脑要发送的内容…', { spin: true, cancel: true });
  try {
    const result = await receiveTransfer(connection.channel, (name, received, size) => {
      const progress = size ? ` · ${Math.floor(100 * received / size)}%` : '';
      status(`正在接收 ${name}${progress}`, { spin: true, cancel: true });
    });
    if (activeTransfer !== connection) return true;
    if (!result) {
      if (fromQr) return false;
      showResult('已连接', '这台电脑的版本可能只支持配对。若要接收文件或文字，请更新电脑端。', false, metrics);
      connection.pc.close();
      return true;
    }
    const {files, text} = result;
    if (!files.length && !text) {
      if (fromQr) return false;
      hint('没有待发送内容');
      showResult('没有待发送内容', '请在电脑上重新打开 DockDrop，先选文件或加入剪贴板文字，再扫码。', true, metrics);
      connection.pc.close();
      return true;
    }
    hint('已接收');
    const summary = files.length ? `${files.length} 个文件${text ? '和文字' : ''}` : '文字';
    showResult('已接收', `收到${summary}。`, false, metrics);
    showReceived(files, text);
    window.dockdropLink = connection;
    return true;
  } catch (error) {
    if (activeTransfer === connection) {
      connection.pc.close();
      hint('接收未完成');
      showResult('接收未完成', error.message, true, metrics);
    }
    return true;
  } finally {
    if (activeTransfer === connection) { activeTransfer = null; status(''); }
  }
}

function showResult(title, text, failed = false, metrics = '') {
  clearReceived();
  $('continuePair').hidden = true;
  $('again').classList.remove('secondary');
  $('resultTitle').textContent = title;
  $('resultText').textContent = text;
  if (SHOW_METRICS && metrics) {
    const details = document.createElement('span');
    details.className = 'metrics';
    details.textContent = metrics;
    $('resultText').appendChild(details);
  }
  const check = $('result').querySelector('.check');
  check.hidden = failed;
  const path = check.querySelector('path'); path.style.animation = 'none'; void path.getBoundingClientRect(); path.style.animation = '';
  showSheet($('result'));
}

$('go').onclick = startCamera;
$('close').onclick = backToStart;
$('cancel').onclick = backToStart;
$('again').onclick = backToStart;
function setReceiveMode(receive) {
  receiveMode = receive;
  $('modeSend').setAttribute('aria-pressed', String(!receive));
  $('modeReceive').setAttribute('aria-pressed', String(receive));
  $('transferFields').hidden = receive;
  $('startText').textContent = receive
    ? '在电脑右键打开 DockDrop，选好要发送的文件或加入剪贴板文字，再扫描光泡。'
    : '准备好内容，在电脑桌面或资源管理器右键选择 DockDrop，再扫描光泡。';
}
$('modeSend').onclick = () => setReceiveMode(false);
$('modeReceive').onclick = () => setReceiveMode(true);
$('continuePair').onclick = async () => {
  const read = pendingRead;
  if (!read) return;
  pendingRead = null;
  scanOnly = false;
  const url = new URL(location.href);
  url.searchParams.delete('nopair');
  history.replaceState(null, '', url);
  await hideSheet($('result'));
  await connect(read.r, read.metrics);
};

if (scanOnly) {
  hint('只读码');
}

// QR fallback: opened by the phone's camera app with the secret in the fragment (never sent to any server). Pair at once
// and drop the fragment, so a reload does not reuse the one-time code.
{
  const m = /(?:^#|&)s=([0-9a-f]{16})/.exec(location.hash);
  if (m) {
    setReceiveMode(true);
    history.replaceState(null, '', location.pathname + location.search);
    hideSheet($('start')).then(() => found({ secret: m[1], via: 'qr-app' }));
  }
}
window.bubbleStats = () => st;  // tests
