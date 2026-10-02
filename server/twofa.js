/**
 * 二次验证（2FA）—— TOTP（RFC 6238），兼容 Google Authenticator / 微软 Authenticator / Authy
 *
 * 刻意只用 Node 内置 crypto，不引第三方库（符合本项目最小依赖的调性）。
 * 算法：HMAC-SHA1 + 30 秒步长 + 6 位数字，与主流 App 默认一致。
 */
const crypto = require('crypto');

const STEP    = 30;   // 秒
const DIGITS  = 6;
const WINDOW  = 1;    // 允许前后各 1 个步长的时钟偏差

// ── Base32（RFC 4648，Authenticator 密钥用大写无填充）──
const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32_ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;                 // 忽略非法字符
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

/** 生成一个新密钥（base32 字符串，默认 20 字节熵） */
function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

/** HOTP：给定密钥与计数器算出 N 位数字码 */
function hotp(secretB32, counter, digits = DIGITS) {
  const key = base32Decode(secretB32);
  const buf = Buffer.alloc(8);
  // 64 位大端计数器
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) |
              (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % (10 ** digits)).padStart(digits, '0');
}

/** 当前时间点的 TOTP */
function totp(secretB32, forTime = Date.now(), digits = DIGITS) {
  return hotp(secretB32, Math.floor(forTime / 1000 / STEP), digits);
}

/**
 * 校验用户输入的验证码，允许 ±WINDOW 个步长的时钟偏差。
 * 用定长比较避免时序侧信道。
 */
function verifyToken(secretB32, token, window = WINDOW) {
  const t = String(token || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(t)) return false;
  const counter = Math.floor(Date.now() / 1000 / STEP);
  for (let i = -window; i <= window; i++) {
    const expected = hotp(secretB32, counter + i);
    if (expected.length === t.length &&
        crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(t))) return true;
  }
  return false;
}

/** 生成 otpauth:// 配置 URI（供前端渲染二维码给 App 扫） */
function otpauthUri(secretB32, accountLabel, issuer) {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  const params = new URLSearchParams({
    secret: secretB32, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP),
  });
  return `otpauth://totp/${label}?${params}`;
}

// ── 恢复码（防手机丢失锁死）──
/** 生成 n 个恢复码，返回明文数组（只在生成时给用户看一次） */
function generateRecoveryCodes(n = 10) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    // 形如 3f9a-8c2e，方便抄写
    const hex = crypto.randomBytes(4).toString('hex');
    codes.push(hex.slice(0, 4) + '-' + hex.slice(4));
  }
  return codes;
}

/** 恢复码存哈希（sha256，规范化去掉横杠与大小写） */
function hashRecoveryCode(code) {
  const norm = String(code).toLowerCase().replace(/[^a-z0-9]/g, '');
  return crypto.createHash('sha256').update(norm).digest('hex');
}

module.exports = {
  generateSecret, hotp, totp, verifyToken, otpauthUri,
  generateRecoveryCodes, hashRecoveryCode,
  base32Encode, base32Decode, STEP, DIGITS,
};
