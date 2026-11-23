// DockDrop pairing over WebRTC, authenticated by the orb's one-time secret. Used by the phone (role "guest", it scanned
// the orb) and by the computer (role "host", it shows the orb; host.html in a browser for tests, WebView2 inside
// DockOver later).
//
// 1. Both derive the room from the secret: room = hex(SHA-256("dockdrop-room-v1" || secret))[0..32]. The signalling
//    relay (worker/) only ever sees the room, never the secret.
// 2. Through the relay they exchange an offer / answer and ICE candidates and open a data channel; on the same network
//    the data goes straight between the two devices (DTLS-encrypted), not through the relay.
// 3. Each side sends HMAC-SHA256(secret, "dockdrop-auth-v1|<role>|<own DTLS fingerprint>|<peer's DTLS fingerprint>")
//    over the data channel and checks the other's. Fingerprints come from the SDPs each side actually used, so a relay
//    that swapped in its own endpoints would need the secret within seconds: pairing fails instead.
// 4. Then the channel is the paired link (next: exchange long-term device keys; DockDrop files; clipboard).

export const PROTOCOL = 'dockdrop-pair-v1';

const enc = new TextEncoder();
function hex(buf) { return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join(''); }
function secretBytes(secretHex) {
  const b = new Uint8Array(8);
  for (let i = 0; i < 8; i++) b[i] = parseInt(secretHex.substr(i * 2, 2), 16);
  return b;
}

export async function roomFor(secretHex) {
  const data = new Uint8Array([...enc.encode('dockdrop-room-v1'), ...secretBytes(secretHex)]);
  return hex(await crypto.subtle.digest('SHA-256', data)).slice(0, 32);
}

function fingerprint(sdp) {
  const m = /a=fingerprint:\S+ ([0-9A-Fa-f:]+)/.exec(sdp || '');
  return m ? m[1].toUpperCase() : '';
}

async function hmac(secretHex, text) {
  const key = await crypto.subtle.importKey('raw', secretBytes(secretHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(text)));
}

// opts: { signalUrl, secret (hex), role: 'host' | 'guest', name, onStatus(text), timeoutMs, peerWaitMs, signal }
// Resolves { channel, peerName } once authenticated; rejects on failure with Error.message one of:
//   'no peer' (nobody on the other side within peerWaitMs: the computer's pairing window is closed or its code changed),
//   'timeout', 'signalling unreachable', 'authentication failed', 'cancelled', 'room busy', or a WebRTC error.
export async function pair(opts) {
  const { signalUrl, secret, role, name = 'DockOver', onStatus = () => {}, timeoutMs = 30000, peerWaitMs = 12000, signal } = opts;
  const room = await roomFor(secret);
  const url = signalUrl.replace(/\/$/, '') + '/room/' + room + '?role=' + role;
  onStatus('正在连接配对服务…');
  const ws = new WebSocket(url);
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }] });
  const send = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
  pc.onicecandidate = (e) => { if (e.candidate) send({ t: 'ice', c: e.candidate }); };
  let channel = null;

  const done = new Promise((resolve, reject) => {
    let settled = false, peerSeen = false;
    const timers = [];
    const fail = (err) => { if (settled) return; settled = true; timers.forEach(clearTimeout); try { pc.close(); ws.close(); } catch {} reject(err); };
    timers.push(setTimeout(() => fail(new Error('timeout')), timeoutMs));
    if (peerWaitMs > 0) timers.push(setTimeout(() => { if (!peerSeen) fail(new Error('no peer')); }, peerWaitMs));
    if (signal) { if (signal.aborted) return fail(new Error('cancelled')); signal.addEventListener('abort', () => fail(new Error('cancelled'))); }
    ws.onopen = () => onStatus(role === 'guest' ? '正在等待电脑回应…' : '正在等待手机…');
    const authenticate = (ch) => {
      channel = ch;
      ch.onopen = async () => {
        onStatus('正在验证…');
        const local = fingerprint(pc.localDescription && pc.localDescription.sdp);
        const remote = fingerprint(pc.remoteDescription && pc.remoteDescription.sdp);
        if (!local || !remote) return fail(new Error('no DTLS fingerprint'));
        const mine = await hmac(secret, `dockdrop-auth-v1|${role}|${local}|${remote}`);
        ch.send(JSON.stringify({ t: 'auth', mac: mine, name, protocol: PROTOCOL }));
        ch.onmessage = async (e) => {
          let m; try { m = JSON.parse(e.data); } catch { return fail(new Error('bad message')); }
          if (m.t !== 'auth') return;
          const peerRole = role === 'host' ? 'guest' : 'host';
          const expect = await hmac(secret, `dockdrop-auth-v1|${peerRole}|${remote}|${local}`);
          if (m.mac !== expect) return fail(new Error('authentication failed'));
          if (settled) return;
          settled = true; timers.forEach(clearTimeout);
          try { ws.close(); } catch {}
          ch.onmessage = null;
          resolve({ channel: ch, peerName: String(m.name || '').slice(0, 64), pc });
        };
      };
      ch.onerror = () => fail(new Error('channel error'));
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
