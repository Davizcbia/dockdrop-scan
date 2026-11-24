const PROTOCOL = 'dockdrop-transfer-v1';
const CHUNK = 32 * 1024;
const MAX_FILE = 4 * 1024 ** 3;
const MAX_TEXT = 64 * 1024;

function control(channel, type, fields = {}) {
  channel.send(JSON.stringify({ protocol: PROTOCOL, type, ...fields }));
}

function parse(data) {
  if (typeof data !== 'string') return null;
  try {
    const msg = JSON.parse(data);
    return msg?.protocol === PROTOCOL ? msg : null;
  } catch {
    return null;
  }
}

export function validateTransfer(files, text) {
  if (files.some((file) => !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_FILE)) {
    throw new Error('单个文件最大为 4 GB。');
  }
  if (new TextEncoder().encode(text).length > MAX_TEXT || text.includes('\0')) {
    throw new Error('文字最多为 64 KB，且不能包含空字符。');
  }
}

export async function sendTransfer(channel, { files, text }, progress) {
  validateTransfer(files, text);
  let pending = null;
  function receive(event) {
    const msg = parse(event.data);
    if (pending && msg && (msg.type === pending.reply || msg.type === 'error')) pending.finish(msg);
  }
  function closed() { pending?.finish(null); }
  channel.addEventListener('message', receive);
  channel.addEventListener('close', closed);
  const wait = (reply, send, retry = false) => new Promise((resolve, reject) => {
    const finish = (msg) => {
      if (pending?.finish !== finish) return;
      clearTimeout(timeout);
      clearInterval(repeat);
      pending = null;
      if (msg?.type === reply) resolve();
      else reject(new Error(msg?.message || (retry ? '电脑还未准备好接收，请更新 DockDrop。' : '接收中断，请重新扫描后重试。')));
    };
    function transmit() {
      try { send(); } catch { finish(null); }
    }
    const timeout = setTimeout(() => finish(null), retry ? 4000 : 15000);
    const repeat = retry ? setInterval(transmit, 300) : null;
    pending = { reply, finish };
    transmit();
  });
  try {
    await wait('ready', () => control(channel, 'hello'), true);
    if (text.length <= 4096) {
      if (text) await wait('ack', () => control(channel, 'text', { text }));
    } else {
      for (let offset = 0; offset < text.length; offset += 4096) {
        const part = text.slice(offset, offset + 4096);
        await wait('ack', () => control(channel, 'text-piece', {text: part, last: offset + part.length === text.length}));
      }
    }
    const total = files.reduce((n, file) => n + file.size, 0);
    let sent = 0;
    for (const file of files) {
      progress(sent, total, file.name);
      await wait('ack', () => control(channel, 'begin', { name: file.name, size: file.size }));
      for (let offset = 0; offset < file.size; offset += CHUNK) {
        const bytes = await file.slice(offset, offset + CHUNK).arrayBuffer();
        await wait('ack', () => channel.send(bytes));
        sent += bytes.byteLength;
        progress(sent, total, file.name);
      }
      await wait('ack', () => control(channel, 'finish'));
    }
    await wait('ack', () => control(channel, 'done'));
  } catch (error) {
    if (channel.readyState === 'open') {
      try { control(channel, 'abort'); } catch {}
    }
    throw error;
  } finally {
    channel.removeEventListener('message', receive);
    channel.removeEventListener('close', closed);
  }
}

export function installTransferReceiver(channel, write, enabled = () => true) {
  channel.binaryType = 'arraybuffer';
  let openFile = false, sealed = false, busy = false, textParts = '';
  function onClose() {
    if (openFile && !busy) {
      openFile = false;
      write('receive-abort').catch(() => {});
    }
  }
  async function onMessage({ data }) {
    if (!enabled()) return;
    const msg = parse(data);
    if (busy || sealed || (!msg && !(data instanceof ArrayBuffer))) return;
    if (msg?.type === 'hello') {
      control(channel, 'ready');
      return;
    }
    busy = true;
    try {
      if (data instanceof ArrayBuffer && openFile && data.byteLength > 0 && data.byteLength <= CHUNK) {
        await write('receive-data', data);
      } else if (msg?.type === 'begin' && !openFile && typeof msg.name === 'string' && msg.name.length <= 255
        && Number.isSafeInteger(msg.size) && msg.size >= 0 && msg.size <= MAX_FILE) {
        await write(`receive-begin:${msg.size}:${msg.name}`);
        openFile = true;
      } else if (msg?.type === 'finish' && openFile) {
        await write('receive-finish');
        openFile = false;
      } else if (msg?.type === 'text' && !openFile && typeof msg.text === 'string') {
        validateTransfer([], msg.text);
        await write('receive-text:' + msg.text);
      } else if (msg?.type === 'text-piece' && !openFile && typeof msg.text === 'string' && msg.text.length > 0
          && msg.text.length <= 4096 && typeof msg.last === 'boolean' && textParts.length + msg.text.length <= MAX_TEXT) {
        textParts += msg.text;
        if (msg.last) {
          validateTransfer([], textParts);
          await write('receive-text:' + textParts);
          textParts = '';
        }
      } else if (msg?.type === 'done' && !openFile && !textParts) {
        await write('receive-done');
        sealed = true;
      } else if (msg?.type === 'abort') {
        await write('receive-abort');
        openFile = false;
        sealed = true;
        return;
      } else {
        throw new Error('接收的数据格式不完整。');
      }
      if (channel.readyState === 'open') control(channel, 'ack');
    } catch (error) {
      if (openFile) await write('receive-abort').catch(() => {});
      openFile = false;
      sealed = true;
      if (channel.readyState === 'open') control(channel, 'error', { message: error.message });
    } finally {
      busy = false;
      if (openFile && channel.readyState === 'closed') {
        openFile = false;
        write('receive-abort').catch(() => {});
      }
    }
  }
  channel.addEventListener('close', onClose);
  channel.addEventListener('message', onMessage);
  return () => {
    channel.removeEventListener('close', onClose);
    channel.removeEventListener('message', onMessage);
  };
}

// Install on an authenticated, ordered data channel. Each pairing serves one
// direction. Storage and selection are supplied by the host platform.
export function serveTransfer(channel, {readSelection, writeIncoming, onState = () => {}}) {
  let direction = null;
  const detach = installTransferReceiver(channel, async (message, bytes) => {
    direction = 'receive';
    await writeIncoming(message, bytes);
  }, () => direction !== 'send');
  async function pull({data}) {
    if (data !== 'dockdrop-pull:1' || direction) return;
    direction = 'send';
    try {
      channel.send('dockdrop-pull:accepted');
      const payload = await readSelection();
      if (!payload.files.length && !payload.text) {
        channel.send('dockdrop-pull:empty');
        return;
      }
      onState('out-start');
      await sendTransfer(channel, payload, () => {});
      onState('out-done');
    } catch {
      if (channel.readyState === 'open') channel.send('dockdrop-pull:failed');
      onState('out-failed');
    }
  }
  function dispose() {
    detach();
    channel.removeEventListener('message', pull);
    channel.removeEventListener('close', dispose);
  }
  channel.addEventListener('message', pull);
  channel.addEventListener('close', dispose);
  return dispose;
}

export function receiveTransfer(channel, progress = () => {}) {
  const maxBatch = 128 * 1024 ** 2;
  return new Promise((resolve, reject) => {
    const files = [];
    let text = '', current = null, total = 0, accepted = false;
    let retry, timer;
    const disposeReceiver = installTransferReceiver(channel, async (message, bytes) => {
      resetDeadline(20000, '接收超时，请重新扫描。');
      try {
        if (message === 'receive-data' && current) {
          if (bytes.byteLength > current.size - current.received) throw new Error('文件大小与电脑提供的信息不符。');
          current.parts.push(bytes);
          current.received += bytes.byteLength;
          progress(current.name, current.received, current.size);
        } else if (message.startsWith('receive-begin:')) {
          const [, sizeText, name] = /^receive-begin:(\d+):([\s\S]*)$/.exec(message) || [];
          const size = Number(sizeText);
          if (!name || /[\\/\u0000-\u001f]/.test(name) || name === '.' || name === '..'
              || !Number.isSafeInteger(size) || size > maxBatch - total || files.length >= 64) {
            throw new Error('收到无效文件，或本次接收超过 128 MB／64 个文件。');
          }
          total += size;
          current = {name, size, received: 0, parts: []};
          progress(name, 0, size);
        } else if (message === 'receive-finish' && current) {
          if (current.received !== current.size) throw new Error('文件接收不完整。');
          const file = new File(current.parts, current.name, {type: 'application/octet-stream'});
          files.push(file);
          current = null;
        } else if (message.startsWith('receive-text:')) {
          text = message.slice(13);
        } else if (message === 'receive-done') {
          finish({files, text});
        } else if (message === 'receive-abort') {
          finish(undefined, new Error('电脑中断了传输。'));
        }
      } catch (error) {
        finish(undefined, error);
        throw error;
      }
    }, () => accepted);
    function finish(result, error) {
      clearTimeout(timer);
      clearInterval(retry);
      channel.removeEventListener('message', onOffer);
      channel.removeEventListener('close', onClose);
      disposeReceiver();
      current = null;
      if (error) reject(error);
      else resolve(result);
    }
    function resetDeadline(ms, message) {
      clearTimeout(timer);
      timer = setTimeout(() => finish(undefined, new Error(message)), ms);
    }
    function onClose() { finish(undefined, new Error('连接已断开，请重新扫描。')); }
    function onOffer({data}) {
      if (data === 'dockdrop-pull:accepted') {
        accepted = true;
        clearInterval(retry);
        resetDeadline(20000, '电脑准备发送超时。');
      } else if (data === 'dockdrop-pull:empty') {
        finish({files, text});
      } else if (data === 'dockdrop-pull:failed') {
        finish(undefined, new Error('电脑未能完成发送。'));
      }
    }
    function pull() {
      if (channel.readyState === 'open') channel.send('dockdrop-pull:1');
      else onClose();
    }
    channel.addEventListener('message', onOffer);
    channel.addEventListener('close', onClose);
    retry = setInterval(pull, 300);
    timer = setTimeout(() => finish(null), 2500);
    pull();
  });
}
