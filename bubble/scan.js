// Optical Bubble scanner (Phase 1: does the code scan on real phones?). The camera decodes in a worker, then uses the shared pairing protocol (../pair.js). Also the QR fallback: the phone's own camera app opens
// this page with #s=<secret>, and it pairs straight away.
import { SIGNAL_URL as CONFIG_SIGNAL } from '../config.js';
import { pair, ringDoorbell, DOORBELL_CAPABILITY } from '../pair.js?v=doorbell1';
import { startCameraGlass } from './glass.js?v=glass1';
import { receiveTransfer, sendTransfer, validateTransfer } from './transfer.js?v=remember1';
import { contentsLabel, locale, t, transferError } from './locale.js?v=remember1';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const SIGNAL_URL = params.get('signal') || CONFIG_SIGNAL;
const TRUST_STORE = 'dockdrop.trustedComputers.v1';
const TRUST_CAPABILITY = 'remember-phone-v1';
const saveAllowed = !params.has('signal');
const SHOW_METRICS = params.get('debug') === '1';
const video = $('video'), focus = $('focus');
const worker = new Worker(new URL('./worker.js?v=pool1', import.meta.url), { type: 'module' });
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

function validComputer(value) {
  return value && /^[a-f0-9]{32}$/.test(value.id) && /^[a-f0-9]{64}$/.test(value.secret)
    && typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 64
    && (value.doorbell === undefined || /^[a-f0-9]{64}$/.test(value.doorbell));
}
// The computer's doorbell (see pair.js): it arrives on the channel ("dockdrop-doorbell:<hex>"), possibly before this phone
// knows under which entry to keep it (a new pairing is saved a moment later). Kept here until adoptDoorbell() saves it.
function watchDoorbell(connection) {
  const box = { value: null, onValue: null };
  connection.channel.addEventListener('message', ({data}) => {
    const prefix = 'dockdrop-doorbell:';
    if (typeof data !== 'string' || !data.startsWith(prefix) || !/^[a-f0-9]{64}$/.test(data.slice(prefix.length))) return;
    box.value = data.slice(prefix.length);
    box.onValue?.();
  });
  return box;
}
function adoptDoorbell(connection, box, computerId) {
  const save = () => {
    const entries = savedComputers();
    const entry = entries.find((item) => item.id === computerId);
    if (!entry || !box.value) return;
    entry.doorbell = box.value;
    if (saveComputers(entries) && connection.channel.readyState === 'open') connection.channel.send('dockdrop-doorbell:ok');
  };
  if (box.value) save(); else box.onValue = save;
}
function savedComputers() {
  if (!saveAllowed) return [];
  try {
    const entries = JSON.parse(localStorage.getItem(TRUST_STORE));
    return Array.isArray(entries) ? entries.filter(validComputer).slice(0, 12) : [];
  } catch { return []; }
}
function saveComputers(entries) {
  try {
    localStorage.setItem(TRUST_STORE, JSON.stringify(entries.slice(0, 12)));
    renderSavedComputers();
    return true;
  } catch {
    return false;
  }
}
function rememberComputer(connection, signal) {
  return new Promise((resolve) => {
    const {channel} = connection;
    let retry, timeout;
    function finish(value) {
      clearInterval(retry);
      clearTimeout(timeout);
      signal.removeEventListener('abort', stop);
      channel.removeEventListener('message', receive);
      channel.removeEventListener('close', stop);
      resolve(value);
    }
    function stop() { finish(null); }
    function receive({data}) {
      if (data === 'dockdrop-remember:error') return stop();
      const prefix = 'dockdrop-remember:ok:';
      if (typeof data !== 'string' || !data.startsWith(prefix)) return;
      try {
        const value = JSON.parse(data.slice(prefix.length));
        finish(validComputer(value) ? value : null);
      } catch { stop(); }
    }
    function request() {
      if (channel.readyState !== 'open') return stop();
      channel.send('dockdrop-remember:request');
    }
    if (signal.aborted) return stop();
    signal.addEventListener('abort', stop, {once: true});
    channel.addEventListener('close', stop);
    channel.addEventListener('message', receive);
    retry = setInterval(request, 350);
    timeout = setTimeout(stop, 6500);
    request();
  });
}
function renderSavedComputers() {
  const list = $('savedList');
  list.replaceChildren();
  const computers = savedComputers();
  $('savedDevices').hidden = scanOnly || !computers.length;
  for (const computer of computers) {
    const row = document.createElement('div');
    row.className = 'saved-device';
    const connectButton = document.createElement('button');
    connectButton.type = 'button';
    connectButton.className = 'button secondary';
    connectButton.textContent = computer.name;
    connectButton.onclick = async () => {
      if (pairing || $('go').disabled) return;
      if (!prepareDraft()) return;
      $('go').disabled = true;
      await hideSheet($('start'));
      $('go').disabled = false;
      await connect({secret: computer.secret, computer}, '');
    };
    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'link';
    forget.textContent = t('移除');
    forget.setAttribute('aria-label', t('移除 {device}', {device: computer.name}));
    forget.onclick = () => {
      if (!confirm(t('移除这台电脑？下次连接需要重新扫码。'))) return;
      if (!saveComputers(savedComputers().filter(item => item.id !== computer.id)))
        status('无法保存设备设置。');
    };
    row.append(connectButton, forget);
    list.append(row);
  }
}

function status(text, { spin = false, cancel = false } = {}) {
  $('statusText').textContent = text ? t(text) : '';
  $('spinner').hidden = !spin;
  $('cancel').hidden = !cancel;
  $('status').hidden = !text;
}
function hint(text = '') {
  const label = $('hint');
  const message = text ? (scanOnly ? t('测试模式 · {hint}', {hint: t(text)}) : t(text)) : '';
  if (label.textContent !== message) label.textContent = message;
  label.hidden = !message;
}
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
  if (MODE === 'rays' && r.pattern !== 'rings') return true;  // the sum of many frames, Reed-Solomon checked; the pairing's HMAC checks again
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
let qrBusy = false, qrTick = 0, qrWorker, nextSoftwareRead = 0;
const qrCanvas = document.createElement('canvas');
const qrContext = qrCanvas.getContext('2d', { willReadFrequently: true });
function acceptQr(value, session) {
  const match = /^https:\/\/davizcbia\.github\.io\/dockdrop-scan\/bubble\/#s=([0-9a-f]{16})$/i.exec(value);
  if (!match || !scanning || session !== st) return false;
  found({ secret: match[1].toLowerCase(), via: 'qr' });
  return true;
}
function readGlassQr(session) {
  if (performance.now() < nextSoftwareRead || !video.videoWidth || !video.videoHeight) return;
  nextSoftwareRead = performance.now() + 700;
  const scale = Math.min(1, 800 / Math.max(video.videoWidth, video.videoHeight));
  qrCanvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  qrCanvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  qrContext.drawImage(video, 0, 0, qrCanvas.width, qrCanvas.height);
  const frame = qrContext.getImageData(0, 0, qrCanvas.width, qrCanvas.height);
  qrWorker ||= new Worker(new URL('./qr-worker.js', import.meta.url));
  qrWorker.onmessage = ({ data }) => { qrBusy = false; acceptQr(data, session); };
  qrWorker.onerror = () => { qrBusy = false; qrWorker.terminate(); qrWorker = null; };
  qrWorker.postMessage(frame, [frame.data.buffer]);
  qrBusy = true;
}
function tryQR() {
  if (qrBusy || ++qrTick % 6) return;
  const session = st;
  if (!qrDetector) { readGlassQr(session); return; }
  qrBusy = true;
  qrDetector.detect(video).then((codes) => {
    qrBusy = false;
    if (scanning && session === st && !codes.some(c => acceptQr(c.rawValue, session))) readGlassQr(session);
  }).catch(() => {
    qrBusy = false;
    if (scanning && session === st) readGlassQr(session);
  });
}

function scheduleScan() {
  cameraFrame = useVideoFrames ? video.requestVideoFrameCallback(loop) : requestAnimationFrame(loop);
}

function loop() {
  if (!scanning) return;
  if (video.readyState >= 2) {
    if (!st.firstFrame) {
      st.firstFrame = performance.now();
      showCamera();
    }
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
        hint(r.ellipse ? '找到光泡，保持不动' : '');
        if (r.ok) { st.ok++; if (accept(r)) { found({ ...r, via: 'bubble' }); return; } }
      });
    }
  }
  if (st.firstFrame) scheduleScan();
  else cameraFrame = requestAnimationFrame(loop);
}

function prepareDraft() {
  draft = receiveMode ? {files: [], text: ''} : {files: [...$('sendFiles').files], text: $('sendText').value};
  try { validateTransfer(draft.files, draft.text); }
  catch (error) { status(transferError(error.message)); return false; }
  return true;
}

async function startCamera() {
  const button = $('go');
  if (button.disabled || stream) return;
  if (!prepareDraft()) return;
  if (!window.isSecureContext || !navigator.mediaDevices) { status('相机需要 HTTPS 页面'); return; }
  button.disabled = true;
  status('正在打开相机…', { spin: true });
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
  } catch (e) {
    button.disabled = false;
    status(e.name === 'NotAllowedError' ? '没有相机权限：请在浏览器设置里允许本网站使用相机' : '无法打开相机');
    return;
  }
  video.srcObject = stream;
  const openingStream = stream;
  try {
    await video.play();
  } catch {
    if (stream === openingStream) {
      stopCamera();
      status('无法打开相机');
    }
    return;
  }
  if (stream !== openingStream) return;
  st = newStats();
  worker.postMessage({ reset: true });
  scanning = true;
  // Poll readiness on the first paint, then use video-frame callbacks for decoding.
  cameraFrame = requestAnimationFrame(loop);
}

function showCamera() {
  video.classList.add('camera-ready');
  $('start').classList.remove('show');
  $('start').hidden = true;
  $('go').disabled = false;
  status('');
  $('close').hidden = false;
  hint();
  focus.hidden = false;
  glassFrame = requestAnimationFrame(() => {
    if (scanning) stopGlass = startCameraGlass(video, [$('close'), document.querySelector('.top.scan-control')]);
  });
}
function stopCamera() {
  scanning = false;
  if (useVideoFrames && st?.firstFrame) video.cancelVideoFrameCallback(cameraFrame);
  else cancelAnimationFrame(cameraFrame);
  video.classList.remove('camera-ready');
  $('go').disabled = false;
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
  renderSavedComputers();
  hint();
  showSheet($('start'));
}

const ERRORS = {
  'no peer': ['电脑没有回应', '这个光泡可能已经过期（每分钟换一次）。请对准电脑上当前的光泡重新扫描。'],
  'timeout': ['连接超时', '请确认手机和电脑连着同一个网络，然后再试一次。'],
  'signalling unreachable': ['连不上配对服务', '请检查手机的网络连接，然后再试一次。'],
  'authentication failed': ['验证没有通过', '请重新扫描电脑上当前显示的光泡。'],
  'room busy': ['这个光泡正在和别的设备配对', '请等一下，或等电脑换一个新的光泡。'],
};

function vibrate(pattern) {
  if (document.visibilityState !== 'visible' || typeof navigator.vibrate !== 'function') return;
  navigator.vibrate(pattern);
}

async function found(r) {
  scanning = false;
  const scanT = st ? (performance.now() - (st.firstFrame || st.t0)) / 1000 : 0;
  const lockT = st?.firstLock ? (st.firstLock - st.firstFrame) / 1000 : null;
  const metrics = st ? [
    t('识别：{source} · 第一帧后 {time} s · 定位 {found}/{decoded} 帧 · 平均 {average} ms', {
      source: t(r.via === 'qr' ? '二维码' : '光泡'), time: scanT.toFixed(2), found: st.found,
      decoded: st.decoded, average: (st.msSum / Math.max(1, st.decoded)).toFixed(0),
    }),
    lockT == null ? '' : t('首次定位 {time} s', {time: lockT.toFixed(2)}),
    r.corrected ? t('纠正 {count} 字节', {count: r.corrected}) : '',
  ].filter(Boolean).join(' · ') : t('识别：备用二维码（相机应用）');
  vibrate(20);
  hint('已识别');
  stopCamera();
  if (!SIGNAL_URL || scanOnly) {
    const text = SIGNAL_URL
      ? '这是只读码的测试模式。点「继续配对」后，电脑才会收到连接结果。'
      : '配对服务尚未配置。';
    showResult('已读码，未配对', t('配对码 …{code}。', {code: r.secret.slice(-4)}) + '\n' + t(text), false, metrics);
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
  const remembered = Boolean(r.computer);
  hint(remembered ? '正在连接…' : '已识别，正在配对');
  const ctl = new AbortController(); pairing = ctl;
  const t0 = performance.now();
  try {
    const name = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document ? 'iPad' : t(/Android/.test(navigator.userAgent) ? 'Android 手机' : '浏览器');
    status('正在连接…', { spin: true, cancel: true });
    // A computer with a doorbell no longer waits in this phone's room: knock (a few times, in case its doorbell socket is
    // reconnecting) while waiting here, and it joins.
    let knocking = Boolean(remembered && r.computer.doorbell && saveAllowed);
    if (knocking) (async () => {
      for (let i = 0; i < 4 && knocking && !ctl.signal.aborted; i++) {
        await ringDoorbell({signalUrl: SIGNAL_URL, doorbell: r.computer.doorbell, phoneId: r.computer.id}).catch(() => false);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    })();
    let res;
    try {
      res = await pair({signalUrl: SIGNAL_URL, secret: r.secret, role: 'guest', name, remembered,
        capabilities: [DOORBELL_CAPABILITY],
        signal: ctl.signal, onStatus: (text) => status(text, {spin: true, cancel: true})});
    } finally { knocking = false; }
    const doorbell = watchDoorbell(res);
    if (remembered) adoptDoorbell(res, doorbell, r.computer.id);
    let trustStatus = '';
    if (!remembered && saveAllowed && res.peerCapabilities.includes(TRUST_CAPABILITY)
        && confirm(t('记住这台电脑？下次无需扫码。'))) {
      status('正在保存这台电脑…', {spin: true, cancel: true});
      const computer = await rememberComputer(res, ctl.signal);
      const saved = computer && saveComputers([computer, ...savedComputers().filter(item => item.id !== computer.id)]);
      if (saved) adoptDoorbell(res, doorbell, computer.id);
      trustStatus = saved ? '已记住这台电脑。' : '无法记住这台电脑，本次连接仍可使用。';
    }
    if (ctl.signal.aborted) {
      res.pc.close();
      return;
    }
    pairing = null; status(''); $('close').hidden = true;
    if (!remembered) vibrate([18, 55, 18]);
    const details = metrics + '\n' + t('握手 {time} s', {time: ((performance.now() - t0) / 1000).toFixed(2)});
    if (draft.files.length || draft.text) {
      await transmit(res, details, remembered, trustStatus);
      return;
    }
    if (receiveMode && await acceptDesktopTransfer(res, details, r.via === 'qr-app', remembered, trustStatus)) return;
    hint('已连接');
    showResult('已连接', t('已和 {device} 连接。', {device: t(res.peerName || '电脑')}) + (trustStatus ? '\n' + t(trustStatus) : ''), false, details);
    window.dockdropLink = res;
  } catch (e) {
    pairing = null;
    if (e.message === 'cancelled') return;
    status(''); $('close').hidden = true;
    const [title, text] = remembered
      ? ['没能连接', '请在电脑上打开 DockDrop。如果这台手机已被移除，请重新扫码。']
      : ERRORS[e.message] || ['没能连接', '请确认手机和电脑连着同一个网络，然后再试一次。'];
    showResult(title, text, true, metrics);
  }
}

async function transmit(connection, metrics, remembered, trustStatus) {
  activeTransfer = connection;
  const payload = draft;
  hint('正在发送');
  status('正在等待电脑接收…', { spin: true, cancel: true });
  try {
    await sendTransfer(connection.channel, payload, (bytes, total, name) => {
      const progress = total ? ` · ${Math.floor(100 * bytes / total)}%` : '';
      status(t('正在发送 {name}{progress}', {name, progress}), { spin: true, cancel: true });
    }, () => {}, remembered ? 45000 : 4000);
    if (activeTransfer !== connection) return;
    $('sendFiles').value = '';
    $('sendText').value = '';
    draft = { files: [], text: '' };
    hint('已发送');
    vibrate([30, 60, 30]);
    const receipt = t('电脑已接收{contents}。', {contents: contentsLabel(payload.files.length, Boolean(payload.text))});
    showResult('已发送', receipt + (trustStatus ? '\n' + t(trustStatus) : ''), false, metrics);
    window.dockdropLink = connection;
  } catch (error) {
    if (activeTransfer !== connection) return;
    connection.pc.close();
    hint('发送未完成');
    showResult('发送未完成', transferError(error.message), true, metrics);
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
    value.setAttribute('aria-label', t('收到的文字'));
    const copy = document.createElement('button');
    copy.className = 'button secondary';
    copy.textContent = t('复制文字');
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = t('已复制');
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
    link.textContent = t('保存 {name}', {name: file.name});
    panel.append(link);
  }
  panel.hidden = false;
}

async function acceptDesktopTransfer(connection, metrics, fromQr, remembered, trustStatus) {
  activeTransfer = connection;
  hint('等待电脑发送');
  status('正在检查电脑要发送的内容…', { spin: true, cancel: true });
  try {
    const result = await receiveTransfer(connection.channel, (name, received, size) => {
      const progress = size ? ` · ${Math.floor(100 * received / size)}%` : '';
      status(t('正在接收 {name}{progress}', {name, progress}), { spin: true, cancel: true });
    }, remembered ? 45000 : 20000);
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
      showResult('没有待发送内容', '请先在电脑端选文件或加入剪贴板文字，再连接。', true, metrics);
      connection.pc.close();
      return true;
    }
    hint('已接收');
    showResult('已接收', t('收到{contents}。', {contents: contentsLabel(files.length, Boolean(text))}) + (trustStatus ? '\n' + t(trustStatus) : ''), false, metrics);
    showReceived(files, text);
    vibrate([30, 60, 30]);
    window.dockdropLink = connection;
    return true;
  } catch (error) {
    if (activeTransfer === connection) {
      connection.pc.close();
      hint('接收未完成');
      showResult('接收未完成', transferError(error.message), true, metrics);
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
  $('resultTitle').textContent = t(title);
  $('resultText').textContent = t(text);
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
  syncFoldHeight();
  $('modeSend').setAttribute('aria-pressed', String(!receive));
  $('modeReceive').setAttribute('aria-pressed', String(receive));
  $('transferMode').toggleAttribute('data-receive', receive);
  $('transferFields').inert = receive;
}
// Track the fields' natural height (it changes when the text box is resized) so the fold can animate to it.
function syncFoldHeight() {
  $('transferFields').style.setProperty('--fold-open', `${document.querySelector('.transfer-fields').offsetHeight}px`);
}
syncFoldHeight();
new ResizeObserver(syncFoldHeight).observe(document.querySelector('.transfer-fields'));
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

document.documentElement.lang = locale;
document.title = t(document.title);
for (const selector of ['#modeSend', '#modeReceive', 'label[for="sendFiles"]', 'label[for="sendText"]',
  '#go', '#savedTitle', '#resultTitle', '#continuePair', '#again', '#cancel']) {
  const el = document.querySelector(selector);
  el.textContent = t(el.textContent);
}
for (const id of ['transferMode', 'close']) {
  const el = $(id);
  el.setAttribute('aria-label', t(el.getAttribute('aria-label')));
}
$('sendText').placeholder = t($('sendText').placeholder);
hint(scanOnly ? '只读码' : '');
renderSavedComputers();

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
