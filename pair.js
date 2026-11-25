// The QR and remembered-device modes use separate room and HMAC domains.
// Both authenticate the actual WebRTC DTLS endpoints. The relay sees a room
// identifier and signalling, while pairing credentials stay on the endpoints.

export const PROTOCOL = 'dockdrop-pair-v1';

const enc = new TextEncoder();
function hex(buf) { return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join(''); }
function secretBytes(secretHex, remembered) {
  const length = remembered ? 64 : 16;
  if (typeof secretHex !== 'string' || secretHex.length !== length || !/^[a-f0-9]+$/i.test(secretHex))
    throw new Error('invalid pairing secret');
  return Uint8Array.from(secretHex.match(/../g), byte => parseInt(byte, 16));
}

export async function roomFor(secretHex, remembered = false) {
  const context = remembered ? 'dockdrop-remember-room-v1' : 'dockdrop-room-v1';
  const data = new Uint8Array([...enc.encode(context), ...secretBytes(secretHex, remembered)]);
  return hex(await crypto.subtle.digest('SHA-256', data)).slice(0, 32);
}

function fingerprint(sdp) {
  const m = /a=fingerprint:\S+ ([0-9A-Fa-f:]+)/.exec(sdp || '');
  return m ? m[1].toUpperCase() : '';
}

async function hmac(secretHex, remembered, text) {
  const key = await crypto.subtle.importKey('raw', secretBytes(secretHex, remembered), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

// Pairing takes a 16-character QR secret or a 64-character remembered secret.
// Resolves { channel, peerName, peerCapabilities, pc } once authenticated; rejects on failure with Error.message one of:
//   'no peer' (nobody on the other side within peerWaitMs: the computer's pairing window is closed or its code changed),
//   'timeout', 'signalling unreachable', 'authentication failed', 'cancelled', 'room busy', or a WebRTC error.
export async function pair(opts) {
  const { signalUrl, secret, role, remembered = false, capabilities = [], name = 'DockOver', onStatus = () => {}, timeoutMs = 30000, peerWaitMs = 12000, signal } = opts;
  const room = await roomFor(secret, remembered);
  if (signal?.aborted) throw new Error('cancelled');
  const authContext = remembered ? 'dockdrop-remember-auth-v1' : 'dockdrop-auth-v1';
  const url = signalUrl.replace(/\/$/, '') + '/room/' + room + '?role=' + role;
  onStatus('正在连接配对服务…');
  const ws = new WebSocket(url);
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] });
  const send = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
  pc.onicecandidate = (e) => { if (e.candidate) send({ t: 'ice', c: e.candidate }); };
  let channel = null;

  const done = new Promise((resolve, reject) => {
    let settled = false, peerSeen = false;
    const abort = () => fail(new Error('cancelled'));
    const timers = [];
    const fail = (err) => { if (settled) return; settled = true; timers.forEach(clearTimeout); signal?.removeEventListener('abort', abort); try { pc.close(); ws.close(); } catch {} reject(err); };
    timers.push(setTimeout(() => fail(new Error('timeout')), timeoutMs));
    if (peerWaitMs > 0) timers.push(setTimeout(() => { if (!peerSeen) fail(new Error('no peer')); }, peerWaitMs));
    if (signal) { if (signal.aborted) return fail(new Error('cancelled')); signal.addEventListener('abort', abort); }
    ws.onopen = () => onStatus(role === 'guest' ? '正在等待电脑回应…' : '正在等待手机…');
    const authenticate = (ch) => {
      if (channel || ch.label !== 'dockdrop' || !ch.ordered) {
        ch.close();
        return;
      }
      channel = ch;
      // The peer's auth can arrive while this side is still computing its own (the HMAC is async): listen from the
      // start and keep it, or it is lost and this side waits for ever while the peer reports success.
      let peerAuth = null, gotAuth;
      const authArrived = new Promise((r) => { gotAuth = r; });
      ch.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (m?.t === 'auth' && !peerAuth) { peerAuth = m; gotAuth(m); }
      };
      const onOpen = async () => {
        onStatus('正在验证…');
        const local = fingerprint(pc.localDescription && pc.localDescription.sdp);
        const remote = fingerprint(pc.remoteDescription && pc.remoteDescription.sdp);
        if (!local || !remote) return fail(new Error('no DTLS fingerprint'));
        const mine = await hmac(secret, remembered, `${authContext}|${role}|${local}|${remote}`);
        if (settled) return;
        ch.send(JSON.stringify({ t: 'auth', mac: mine, name, protocol: PROTOCOL, capabilities }));
        const m = await authArrived;
        const peerRole = role === 'host' ? 'guest' : 'host';
        const expect = await hmac(secret, remembered, `${authContext}|${peerRole}|${remote}|${local}`);
        if (m.mac !== expect) return fail(new Error('authentication failed'));
        if (settled) return;
        settled = true; timers.forEach(clearTimeout);
        signal?.removeEventListener('abort', abort);
        try { ws.close(); } catch {}
        ch.onmessage = null;
        resolve({ channel: ch, peerName: String(m.name || '').slice(0, 64), pc,
          peerCapabilities: Array.isArray(m.capabilities) ? m.capabilities : [] });
      };
      const open = () => onOpen().catch(fail);
      if (ch.readyState === 'open') open(); else ch.onopen = open;
      ch.onerror = () => fail(new Error('channel error'));
      ch.onclose = () => fail(new Error('channel closed'));
    };
    if (role === 'guest') authenticate(pc.createDataChannel('dockdrop', { ordered: true }));
    else pc.ondatachannel = (e) => authenticate(e.channel);

    ws.onerror = () => fail(new Error('signalling unreachable'));
    // The relay closes a room after 2 minutes: whoever is still waiting then fails instead of hanging (and retries).
    ws.onclose = (e) => { if (!channel || channel.readyState !== 'open') fail(new Error(e.code === 4409 ? 'room busy' : e.code === 4408 ? 'timeout' : 'signalling unreachable')); };
    ws.onmessage = async (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      try {
        if (m.t === 'peer') peerSeen = true;
        if (m.t === 'peer' && role === 'guest') {  // the host is there: offer
          onStatus('正在建立直连…');
          await pc.setLocalDescription(await pc.createOffer());
          send({ t: 'sdp', d: pc.localDescription });
        } else if (m.t === 'sdp') {
          await pc.setRemoteDescription(m.d);
          if (m.d.type === 'offer') {
            onStatus('正在建立直连…');
            await pc.setLocalDescription(await pc.createAnswer());
            send({ t: 'sdp', d: pc.localDescription });
          }
        } else if (m.t === 'ice') {
          await pc.addIceCandidate(m.c);
        }
      } catch (err) { fail(err); }
    };
  });
  return done;
}
