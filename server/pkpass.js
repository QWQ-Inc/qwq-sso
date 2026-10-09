// Apple Wallet（.pkpass）生成（v3.5.10·阶段一）
// 为访客通行码生成并签名一张 Apple Wallet pass，条码=访客码 QR。
// ⚠️ 必须用 Apple「Pass Type ID 证书」签名——未配置齐全则 isConfigured()=false，功能隐藏。
// 签名/打包交给成熟库 passkit-generator（懒加载，未装不影响服务启动）。
const zlib = require('zlib');

// E = env getter（默认全局；v3.5.91 起按组织覆盖时传该组织的 orgEnvGetter）
const env = (k) => String(process.env[k] || '').trim();
function envCfg(E = env) {
  return {
    passTypeId: E('APPLE_PASS_TYPE_ID'),
    teamId: E('APPLE_TEAM_ID'),
    cert: E('APPLE_PASS_CERT'),
    key: E('APPLE_PASS_KEY'),
    keyPass: E('APPLE_PASS_KEY_PASSWORD'),
    wwdr: E('APPLE_WWDR_CERT'),
    org: E('PKPASS_ORG_NAME') || E('FOOTER_DISTRIBUTOR') || 'QWQ SSO',
    bg: E('PKPASS_BG_COLOR') || 'rgb(26,127,55)',
  };
}
function isConfigured(E = env) {
  const c = envCfg(E);
  return !!(c.passTypeId && c.teamId && c.cert && c.key && c.wwdr);
}

// ── 自生成一张纯色 PNG 图标（避免往仓库塞二进制；管理员可后续换成品牌图） ──
const _CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = _CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function solidPng(size, rgb) {
  const [r, g, b] = rgb;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0; // filter type 0
    for (let x = 0; x < size; x++) {
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGB
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}
function parseRgb(s) {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(s || '');
  return m ? [+m[1], +m[2], +m[3]] : [26, 127, 55];
}

// 生成一张访客码 Wallet pass，返回 Buffer（.pkpass）。p = visitor_passes 行；doorNames = 门名数组。
async function buildVisitorPass(p, doorNames, baseUrl, E = env) {
  if (!isConfigured(E)) throw new Error('未配置 Apple Wallet 证书');
  const c = envCfg(E);
  let PKPass;
  try { ({ PKPass } = require('passkit-generator')); }
  catch (_) { throw new Error('服务端缺少 passkit-generator 依赖（请部署安装）'); }

  const iconRgb = parseRgb(c.bg);
  const passJson = {
    formatVersion: 1,
    passTypeIdentifier: c.passTypeId,
    teamIdentifier: c.teamId,
    organizationName: c.org,
    serialNumber: p.id,
    description: '访客通行码',
    foregroundColor: 'rgb(255,255,255)',
    backgroundColor: c.bg,
    labelColor: 'rgb(255,255,255)',
    barcodes: [{ message: p.code, format: 'PKBarcodeFormatQR', messageEncoding: 'iso-8859-1', altText: p.code }],
    generic: {
      primaryFields: [{ key: 'visitor', label: '访客', value: p.visitor_name || '访客' }],
      secondaryFields: [{ key: 'valid', label: '有效期', value: (p.valid_to ? String(p.valid_to).replace('T', ' ').slice(0, 16) : '长期') }],
      auxiliaryFields: [{ key: 'doors', label: '可通行', value: (doorNames && doorNames.length ? doorNames.join('、') : '—') }],
    },
  };
  const icon = solidPng(29, iconRgb), icon2 = solidPng(58, iconRgb), icon3 = solidPng(87, iconRgb);
  const buffers = {
    'pass.json': Buffer.from(JSON.stringify(passJson)),
    'icon.png': icon, 'icon@2x.png': icon2, 'icon@3x.png': icon3,
    'logo.png': icon, 'logo@2x.png': icon2,
  };
  const certs = { wwdr: c.wwdr, signerCert: c.cert, signerKey: c.key };
  if (c.keyPass) certs.signerKeyPassphrase = c.keyPass;
  const pass = new PKPass(buffers, certs);
  return pass.getAsBuffer();
}

module.exports = { isConfigured, buildVisitorPass, solidPng };
