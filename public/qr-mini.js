/**
 * 极简 QR 码生成器（字节模式，纠错等级 M，版本 1~10），无第三方依赖。
 * 返回一个布尔矩阵（true=黑）。供 TOTP 绑定页在浏览器本地生成二维码，
 * 密钥不出客户端。
 *
 * 实现遵循 ISO/IEC 18004。仅字节模式，够 otpauth URI 用。
 */
(function (root) {
  // ── GF(256) 伽罗华域 ──
  const EXP = new Array(512), LOG = new Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const gmul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

  // 生成多项式
  function rsGenPoly(deg) {
    let poly = [1];
    for (let i = 0; i < deg; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= gmul(poly[j], EXP[i]);
        next[j + 1] ^= poly[j];
      }
      poly = next;
    }
    return poly;
  }
  function rsEncode(data, ecLen) {
    // rsGenPoly 返回升幂 [g0..g_deg]（首项系数在末尾），
    // 除法需要首项(=1)在前，故反转成 [1, g_{deg-1}, ..., g0]
    const gen = rsGenPoly(ecLen).reverse();
    const res = new Array(ecLen).fill(0);
    for (const d of data) {
      const factor = d ^ res[0];
      res.shift(); res.push(0);
      if (factor !== 0) for (let i = 0; i < gen.length - 1; i++) res[i] ^= gmul(gen[i + 1], factor);
    }
    return res;
  }

  // 纠错等级 M：[ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data]
  const ECC_M = {
    1:[10,1,16,0,0], 2:[16,1,28,0,0], 3:[26,1,44,0,0], 4:[18,2,32,0,0], 5:[24,2,43,0,0],
    6:[16,4,27,0,0], 7:[18,4,31,0,0], 8:[22,2,38,2,39], 9:[22,3,36,2,37], 10:[26,4,43,1,44],
  };
  const ALIGN = {
    1:[], 2:[6,18], 3:[6,22], 4:[6,26], 5:[6,30], 6:[6,34],
    7:[6,22,38], 8:[6,24,42], 9:[6,26,46], 10:[6,28,50],
  };
  const totalData = v => { const [ec,b1,d1,b2,d2]=ECC_M[v]; return b1*d1+b2*d2; };

  function chooseVersion(byteLen) {
    for (let v = 1; v <= 10; v++) {
      const ccBits = v <= 9 ? 8 : 16;
      const cap = totalData(v) * 8 - 4 - ccBits;         // 可用比特
      if (byteLen * 8 <= cap) return v;
    }
    throw new Error('数据太长，超出本 QR 生成器支持范围');
  }

  // ── 比特缓冲 ──
  function BitBuf() { this.bits = []; }
  BitBuf.prototype.put = function (val, len) { for (let i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1); };

  function encodeData(str, version) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) { bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
      else { bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
    }
    const bb = new BitBuf();
    bb.put(0b0100, 4);                              // 字节模式
    bb.put(bytes.length, version <= 9 ? 8 : 16);    // 字符数
    for (const b of bytes) bb.put(b, 8);

    const totalBits = totalData(version) * 8;
    // 终止符
    for (let i = 0; i < 4 && bb.bits.length < totalBits; i++) bb.bits.push(0);
    // 补齐到字节
    while (bb.bits.length % 8 !== 0) bb.bits.push(0);
    // 填充字节 0xEC 0x11 交替
    const pads = [0xec, 0x11];
    let pi = 0;
    while (bb.bits.length < totalBits) { bb.put(pads[pi & 1], 8); pi++; }

    // 转字节
    const dataCw = [];
    for (let i = 0; i < bb.bits.length; i += 8) {
      let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bb.bits[i + j];
      dataCw.push(v);
    }
    return dataCw;
  }

  function interleave(dataCw, version) {
    const [ecLen, b1, d1, b2, d2] = ECC_M[version];
    const blocks = [];
    let idx = 0;
    for (let i = 0; i < b1; i++) { const d = dataCw.slice(idx, idx + d1); idx += d1; blocks.push({ d, ec: rsEncode(d, ecLen) }); }
    for (let i = 0; i < b2; i++) { const d = dataCw.slice(idx, idx + d2); idx += d2; blocks.push({ d, ec: rsEncode(d, ecLen) }); }
    const maxD = Math.max(d1, d2);
    const out = [];
    for (let i = 0; i < maxD; i++) for (const bl of blocks) if (i < bl.d.length) out.push(bl.d[i]);
    for (let i = 0; i < ecLen; i++) for (const bl of blocks) out.push(bl.ec[i]);
    return out;
  }

  // ── 矩阵放置 ──
  function buildMatrix(version, finalCw) {
    const size = version * 4 + 17;
    const m = Array.from({ length: size }, () => new Array(size).fill(null));   // null=未定
    const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (r, c, v) => { m[r][c] = v ? 1 : 0; reserved[r][c] = true; };

    // 定位图案（三个角）
    function finder(r, c) {
      for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const inRing = (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) || (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6));
        const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        set(rr, cc, inRing || inCore);
      }
    }
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

    // 定时图案
    for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }

    // 对齐图案
    const centers = ALIGN[version];
    for (const r of centers) for (const c of centers) {
      if ((r <= 7 && c <= 7) || (r <= 7 && c >= size - 8) || (r >= size - 8 && c <= 7)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++)
        set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }

    // 暗模块
    set(size - 8, 8, true);

    // 预留格式信息区（值稍后填）
    for (let i = 0; i < 9; i++) { if (!reserved[8][i]) reserved[8][i] = true; if (!reserved[i][8]) reserved[i][8] = true; }
    for (let i = 0; i < 8; i++) { reserved[8][size - 1 - i] = true; reserved[size - 1 - i][8] = true; }

    // 版本信息区（v≥7）
    if (version >= 7) {
      for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { reserved[i][size - 11 + j] = true; reserved[size - 11 + j][i] = true; }
    }

    // 数据比特放置（之字形）
    const bits = [];
    for (const cw of finalCw) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);
    let bi = 0, upward = true;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;    // 跳过定时列
      for (let i = 0; i < size; i++) {
        const row = upward ? size - 1 - i : i;
        for (let c = 0; c < 2; c++) {
          const cc = col - c;
          if (reserved[row][cc]) continue;
          m[row][cc] = bi < bits.length ? bits[bi] : 0; bi++;
        }
      }
      upward = !upward;
    }

    return { m, reserved, size };
  }

  function applyMask(m, reserved, size, mask) {
    const fn = [
      (r, c) => (r + c) % 2 === 0,
      (r, c) => r % 2 === 0,
      (r, c) => c % 3 === 0,
      (r, c) => (r + c) % 3 === 0,
      (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
      (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
      (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
      (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
    ][mask];
    const out = m.map(row => row.slice());
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++)
      if (!reserved[r][c] && fn(r, c)) out[r][c] ^= 1;
    return out;
  }

  // 格式信息（含掩码号），BCH(15,5) + 掩码 0x5412
  function formatBits(mask) {
    const eccLevelBits = 0b00;   // 等级 M
    let data = (eccLevelBits << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ (((rem >> 9) & 1) ? 0x537 : 0);
    let bits = ((data << 10) | rem) ^ 0x5412;
    // 放置时按「规范 bit i」顺序取，而 bits 的 bit0 是 LSB，二者相反，故反转 15 位
    let rev = 0; for (let i = 0; i < 15; i++) rev |= ((bits >> i) & 1) << (14 - i);
    return rev;
  }
  function placeFormat(m, size, mask) {
    const bits = formatBits(mask);
    const get = i => (bits >> i) & 1;
    // 左上
    for (let i = 0; i <= 5; i++) m[8][i] = get(i);
    m[8][7] = get(6); m[8][8] = get(7); m[7][8] = get(8);
    for (let i = 9; i <= 14; i++) m[14 - i][8] = get(i);
    // 右下/右上镜像
    for (let i = 0; i <= 7; i++) m[size - 1 - i][8] = get(i);
    for (let i = 8; i <= 14; i++) m[8][size - 15 + i] = get(i);
    m[size - 8][8] = 1;  // 暗模块保持
  }

  // 版本信息（v≥7），BCH(18,6)
  function placeVersion(m, size, version) {
    if (version < 7) return;
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ (((rem >> 11) & 1) ? 0x1f25 : 0);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = (bits >> i) & 1;
      const r = Math.floor(i / 3), c = i % 3;
      m[r][size - 11 + c] = bit;
      m[size - 11 + c][r] = bit;
    }
  }

  function penalty(m, size) {
    let p = 0;
    // 规则1：连续同色
    for (let r = 0; r < size; r++) for (const dir of [0, 1]) {
      let run = 1;
      for (let i = 1; i < size; i++) {
        const a = dir ? m[i][r] : m[r][i], b = dir ? m[i - 1][r] : m[r][i - 1];
        if (a === b) { run++; if (run === 5) p += 3; else if (run > 5) p += 1; }
        else run = 1;
      }
    }
    return p;   // 简化：只用规则1挑最优掩码，足够生成可扫码的 QR
  }

  function generate(str, forceMask) {
    const bytes = []; for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); if (c < 0x80) bytes.push(c); else if (c < 0x800) bytes.push(1, 1); else bytes.push(1, 1, 1); }
    const version = chooseVersion(bytes.length);
    const dataCw = encodeData(str, version);
    const finalCw = interleave(dataCw, version);
    const { m, reserved, size } = buildMatrix(version, finalCw);

    const build = (mask) => {
      const masked = applyMask(m, reserved, size, mask);
      placeFormat(masked, size, mask);
      placeVersion(masked, size, version);
      return masked;
    };
    if (typeof forceMask === 'number') return build(forceMask);

    let best = null, bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const masked = build(mask);
      const score = penalty(masked, size);
      if (score < bestScore) { bestScore = score; best = masked; }
    }
    return best;   // 布尔/0-1 矩阵
  }

  // 生成 SVG 字符串（黑模块 + 白底 + 静区）
  function toSvg(matrix, opts = {}) {
    const size = matrix.length;
    const quiet = opts.quiet ?? 4;
    const scale = opts.scale ?? 6;
    const dim = (size + quiet * 2) * scale;
    let rects = '';
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++)
      if (matrix[r][c]) rects += `<rect x="${(c + quiet) * scale}" y="${(r + quiet) * scale}" width="${scale}" height="${scale}"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}"><rect width="${dim}" height="${dim}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
  }

  // 生成 SVG，超出容量或异常时返回 null（调用方回退到手动录入密钥）
  function svg(str, opts) { try { return toSvg(generate(str), opts); } catch (_) { return null; } }
  const api = { generate, toSvg, svg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QRMini = api;
})(typeof window !== 'undefined' ? window : this);
