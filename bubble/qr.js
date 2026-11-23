// Minimal QR code encoder (ISO/IEC 18004): byte mode, error correction level M, versions 1-6 (up to 106 bytes), the
// mask with the lowest penalty. Enough for the fallback QR that carries the scanner URL with the one-time secret.
// The structure follows Project Nayuki's QR Code generator (MIT), written fresh and cut down.
// Works in browsers and Node (tests).

// level M: data codewords, EC codewords per block, blocks (versions 1..6)
const M_TABLE = [null, [16, 10, 1], [28, 16, 1], [44, 26, 1], [64, 18, 2], [86, 24, 2], [108, 16, 4]];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];

// GF(256), primitive 0x11d; QR's generator has roots 2^0 .. 2^(n-1)
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{ let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; }
const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
export function rsRemainder(data, n) {
  let g = [1];
  for (let i = 0; i < n; i++) {  // g *= (x - 2^i)
    const ng = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= gmul(g[j], EXP[i]); }
    g = ng;
  }
  const rem = new Array(n).fill(0);
  for (const b of data) {
    const f = b ^ rem[0];
    rem.shift(); rem.push(0);
    for (let j = 0; j < n; j++) rem[j] ^= gmul(g[j + 1], f);
  }
  return rem;
}

// Text (UTF-8) -> { size, dark: (x, y) => boolean, version, mask }
export function qrEncode(text) {
  const bytes = Array.from(new TextEncoder().encode(text));
  let version = 1;
  while (version <= 6 && bytes.length + 2 > M_TABLE[version][0]) version++;  // 4 + 8 header bits ~ 2 bytes
  if (version > 6) throw new Error('text too long for the QR fallback');
  const [dataCw, ecPer, blocks] = M_TABLE[version];
  // bit stream: mode 0100, 8-bit count, data, terminator, pad
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(4, 4); put(bytes.length, 8); for (const b of bytes) put(b, 8);
  put(0, Math.min(4, dataCw * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  for (let p = 0xec; bits.length < dataCw * 8; p ^= 0xec ^ 0x11) put(p, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  // blocks (all the same length up to version 6, level M), interleaved
  const per = dataCw / blocks, dBlocks = [], eBlocks = [];
  for (let b = 0; b < blocks; b++) { const d = data.slice(b * per, (b + 1) * per); dBlocks.push(d); eBlocks.push(rsRemainder(d, ecPer)); }
  const code = [];
  for (let i = 0; i < per; i++) for (const d of dBlocks) code.push(d[i]);
  for (let i = 0; i < ecPer; i++) for (const e of eBlocks) code.push(e[i]);

  const size = version * 4 + 17;
  const mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, d) => { mod[y][x] = d; fn[y][x] = true; };
  // timing patterns
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  // finder patterns with separators
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  // alignment patterns
  const al = ALIGN[version];
  for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  // format areas reserved (filled per mask below)
  const formatBits = (mask) => {
    const d = (0 << 3) | mask;  // level M = 00
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((d << 10) | rem) ^ 0x5412;
  };
  const drawFormat = (mask) => {
    const b = formatBits(mask), bit = (i) => ((b >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);  // the dark module
  };
  drawFormat(0);
  // data, zigzag from the bottom right
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
      if (fn[y][x]) continue;
      if (i < code.length * 8) mod[y][x] = ((code[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
      i++;  // remainder bits stay light
    }
  }
  const maskFn = [
    (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
    (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => (((x + y) % 2) + (x * y) % 3) % 2 === 0,
  ];
  const applyMask = (m) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && maskFn[m](x, y)) mod[y][x] = !mod[y][x]; };
  let best = 0, bestP = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m); drawFormat(m);
    const p = penalty(mod, size);
    if (p < bestP) { bestP = p; best = m; }
    applyMask(m);  // undo (XOR)
  }
  applyMask(best); drawFormat(best);
  return { size, version, mask: best, dark: (x, y) => mod[y][x], modules: mod };
}

function penalty(m, n) {
  let p = 0;
  const line = (get) => {
    for (let a = 0; a < n; a++) {
      let run = 1;
      for (let b = 1; b <= n; b++) {
        if (b < n && get(a, b) === get(a, b - 1)) run++;
        else { if (run >= 5) p += 3 + (run - 5); run = 1; }
      }
      // finder-like 1:1:3:1:1 with 4 light modules on one side
      for (let b = 0; b + 11 <= n; b++) {
        const s = Array.from({ length: 11 }, (_, k) => (get(a, b + k) ? 1 : 0)).join('');
        if (s === '10111010000' || s === '00001011101') p += 40;
      }
    }
  };
  line((a, b) => m[a][b]); line((a, b) => m[b][a]);
  for (let y = 0; y + 1 < n; y++) for (let x = 0; x + 1 < n; x++) { const c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3; }
  let dark = 0; for (const row of m) for (const c of row) if (c) dark++;
  p += 10 * Math.floor(Math.abs(dark * 20 - n * n * 10) / (n * n));
  return p;
}

// Draw into a 2D canvas context: modules of `scale` px, a 4-module quiet zone, light on dark or dark on light.
export function drawQR(ctx, qr, scale, { fg = '#000', bg = '#fff', quiet = 4 } = {}) {
  const side = (qr.size + quiet * 2) * scale;
  ctx.canvas.width = side; ctx.canvas.height = side;
  ctx.fillStyle = bg; ctx.fillRect(0, 0, side, side);
  ctx.fillStyle = fg;
  for (let y = 0; y < qr.size; y++) for (let x = 0; x < qr.size; x++) if (qr.dark(x, y)) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
}
