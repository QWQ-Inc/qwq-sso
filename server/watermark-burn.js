// 把水印「烧进」导出的图片 / PDF（v3.5.33）
//
// 网页上的水印是 DOM 遮罩，只防截图/录屏；文件一旦下载就没水印了。这里在服务端下发附件时
// 直接把平铺水印合成进文件本身（图片像素 / PDF 每一页），绕过前端直接调接口也拿不到干净文件。
//
// 做法：先用 sharp(libvips + Pango) 把水印文字渲染成一块带透明度、已旋转的 PNG「瓦片」，
//   - 图片：sharp composite tile:true 平铺到原图上，按原格式输出；
//   - PDF：pdf-lib 把同一块 PNG 当图片铺满每一页（PDF 里不用嵌字体，中文也不会缺字）。
// 每次下发都带一个追踪码（写进水印文字 + 审计存证链），文件外泄后可按追踪码查到是谁、何时导出的。
//
// ⚠️ 字体：Zeabur 这类容器通常一个字体都没有，连英文都会渲染成「豆腐块」。所以必须显式给字体文件：
//   ① WATERMARK_FONT_PATH（填 - 表示不用中文字体）→ ② 常见系统 CJK 字体 →
//   ③ 下载缓存到数据目录（默认是钉死版本 + sha256 校验的 Noto Sans SC，WATERMARK_FONT_URL 可换 / 填 off 不下载）→
//   ④ 兜底：npm 依赖 dejavu-fonts-ttf 的 DejaVuSans（只有拉丁字符，此时把非 ASCII 去掉，保留 UID/邮箱/时间/追踪码）。
// ⚠️ sharp / pdf-lib 懒加载：没装不影响服务启动；开启了烧录却加载失败时调用方应「失败即拒绝」，不能退回原文件。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SYSTEM_FONTS = [
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
  '/usr/share/fonts/wqy-zenhei/wqy-zenhei.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf',
  '/System/Library/Fonts/PingFang.ttc',
  'C:\\Windows\\Fonts\\msyh.ttc',
];
const FONT_DIR = path.join(path.dirname(process.env.DB_PATH || path.join(__dirname, '../data/sso.db')), 'fonts');
const MAX_FONT_BYTES = 40 * 1024 * 1024;

// 默认中文字体：notofonts/noto-cjk 的 Sans2.004 发布（SIL OFL 1.1），钉死版本 + 校验哈希，防 CDN 内容被换
const DEFAULT_FONT_URL = 'https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@Sans2.004/Sans/SubsetOTF/SC/NotoSansSC-Regular.otf';
const DEFAULT_FONT_SHA256 = 'faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9';

let _fontDownloading = null;
function cachedFontFile(url) {
  const h = crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
  const ext = (/\.(ttf|otf|ttc)(\?|$)/i.exec(url) || [, 'ttf'])[1].toLowerCase();
  return path.join(FONT_DIR, `wm-${h}.${ext}`);
}
async function downloadFont(url, sha256) {
  const file = cachedFontFile(url);
  if (fs.existsSync(file)) return file;
  if (!/^https:\/\//i.test(url)) return null;
  if (_fontDownloading) return _fontDownloading;
  _fontDownloading = (async () => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_FONT_BYTES) throw new Error('字体文件过大');
      // 粗校验字体签名：TTF 00010000 / OTF 'OTTO' / TTC 'ttcf' / 'true'
      const sig = buf.subarray(0, 4).toString('latin1');
      if (!(sig === '\x00\x01\x00\x00' || sig === 'OTTO' || sig === 'ttcf' || sig === 'true')) throw new Error('不是 TTF/OTF/TTC 字体');
      if (sha256 && crypto.createHash('sha256').update(buf).digest('hex') !== sha256) throw new Error('字体文件校验不一致');
      fs.mkdirSync(FONT_DIR, { recursive: true });
      fs.writeFileSync(file, buf);
      return file;
    } catch (e) {
      console.warn('[水印] 字体下载失败：', e.message);
      return null;
    } finally { _fontDownloading = null; }
  })();
  return _fontDownloading;
}
/** 找一个能渲染中文的字体文件；找不到返回 null */
async function resolveCjkFont() {
  const p = String(process.env.WATERMARK_FONT_PATH || '').trim();
  if (p === '-') return null;
  if (p && fs.existsSync(p)) return p;
  for (const f of SYSTEM_FONTS) { try { if (fs.existsSync(f)) return f; } catch (_) {} }
  const url = String(process.env.WATERMARK_FONT_URL || '').trim();
  if (/^(off|0|false|no|关)$/i.test(url)) return null;
  return url ? downloadFont(url, null) : downloadFont(DEFAULT_FONT_URL, DEFAULT_FONT_SHA256);
}
/** 只有拉丁字符的兜底字体（npm 依赖随部署安装，保证任何机器都能出字） */
function latinFont() {
  try { return require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf'); } catch (_) { return null; }
}
/** → { file, cjk }：cjk=false 时调用方要把文字降成 ASCII */
async function resolveFont() {
  const cjk = await resolveCjkFont();
  if (cjk) return { file: cjk, cjk: true };
  const lat = latinFont();
  return lat ? { file: lat, cjk: false } : null;
}
/** 开启烧录时启动就预取字体，免得第一次导出要等下载 */
function prefetchFont() { if (isBurnOn()) resolveCjkFont().catch(() => {}); }

function isBurnOn() {
  return /^(on|1|true|yes|开|开启|启用|是|y)$/i.test(String(process.env.WATERMARK_BURN || '').trim());
}
function genTrace() { return crypto.randomBytes(4).toString('hex').toUpperCase(); }

/** 服务端解析水印模板（变量与前端一致）+ 追加追踪码 */
function resolveText(tpl, user, trace, now = new Date()) {
  let tz = user && user.timezone && user.timezone !== 'auto' ? user.timezone : (process.env.WATERMARK_TZ || 'Asia/Shanghai');
  const fmt = (opts) => {
    try { return new Intl.DateTimeFormat('sv-SE', { timeZone: tz, ...opts }).format(now); }
    catch (_) { tz = 'UTC'; return new Intl.DateTimeFormat('sv-SE', { timeZone: 'UTC', ...opts }).format(now); }
  };
  const date = fmt({ year: 'numeric', month: '2-digit', day: '2-digit' });
  const time = fmt({ hour: '2-digit', minute: '2-digit', hour12: false });
  const uid = user ? (user.uid_code || (user.uid_seq ? '#' + String(user.uid_seq).padStart(5, '0') : '')) : '';
  const vars = { name: user?.name || '', uid, email: user?.email || '', date, time, datetime: date + ' ' + time };
  const base = String(tpl || '{name} {uid} {datetime}').replace(/\{(name|uid|email|date|time|datetime)\}/g, (_, k) => vars[k] || '');
  return (base.replace(/\s+/g, ' ').trim() + ' · T' + trace).trim();
}
function asciiOnly(s) { return s.replace(/[^\x20-\x7e]/g, '').replace(/\s+/g, ' ').replace(/^[\s·]+/, '').trim(); }

function pangoEscape(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function hexToRgba(hex, opacity) {
  let s = String(hex || '#000000').replace('#', '');
  if (s.length === 3 || s.length === 4) s = s.split('').map(c => c + c).join('');
  const rgb = s.slice(0, 6).padEnd(6, '0');
  const baseA = s.length === 8 ? parseInt(s.slice(6, 8), 16) / 255 : 1;
  const a = Math.max(0.01, Math.min(1, baseA * opacity));
  return { rgb: '#' + rgb, alphaPct: Math.max(1, Math.round(a * 100)) };
}

function loadSharp() { return require('sharp'); }
function loadPdfLib() { return require('pdf-lib'); }

/**
 * 渲染一块平铺瓦片（PNG，带透明度、已旋转、四周留出间距）。
 * scale：按目标尺寸放大字号，避免大图上的水印小到看不见。
 */
const _tileCache = new Map();
async function renderTile(text, policy, scale = 1) {
  const sharp = loadSharp();
  const font = await resolveFont();
  if (!font) throw new Error('服务器上没有可用字体，无法渲染水印');
  let t = font.cjk ? text : asciiOnly(text);
  if (!t) t = 'QWQ SSO';
  const size = Math.round(policy.size * scale);
  const gap = Math.round(policy.gap * scale);
  const key = [t, font.file, size, gap, policy.angle, policy.color, policy.opacity].join('|');
  if (_tileCache.has(key)) return _tileCache.get(key);
  const { rgb, alphaPct } = hexToRgba(policy.color, policy.opacity);
  const markup = `<span foreground="${rgb}" fgalpha="${alphaPct}%">${pangoEscape(t)}</span>`;
  const textOpts = { text: markup, rgba: true, dpi: 72, font: 'sans ' + size, fontfile: font.file };
  const label = await sharp({ text: textOpts }).png().toBuffer();
  // 先旋转（透明底），再四周补间距，平铺时就是「斜着的一行行字」
  const rotated = await sharp(label).rotate(policy.angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer({ resolveWithObject: true });
  const pad = Math.round(gap / 2);
  const cell = await sharp(rotated.data)
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png().toBuffer({ resolveWithObject: true });
  // 错位平铺：隔行偏移半格，长文字时覆盖更均匀。周期是 (w, 2h)：在 2w×2h 画布上放
  // 第一行 (0,0)(w,0)、第二行 (w/2,h)，再截取 x∈[w/2, 3w/2) 这一段，就是一块可无缝平铺的瓦片
  const w = cell.info.width, h = cell.info.height, half = Math.floor(w / 2);
  const tile = await sharp({ create: { width: 2 * w, height: 2 * h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: cell.data, left: 0, top: 0 }, { input: cell.data, left: w, top: 0 }, { input: cell.data, left: half, top: h }])
    .png().toBuffer()
    .then(buf => sharp(buf).extract({ left: half, top: 0, width: w, height: 2 * h }).png().toBuffer({ resolveWithObject: true }));
  const out = { png: tile.data, width: tile.info.width, height: tile.info.height, cjk: font.cjk, text: t };
  if (_tileCache.size > 200) _tileCache.clear();
  _tileCache.set(key, out);
  return out;
}

const IMAGE_FORMATS = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp', 'image/gif': 'gif' };
function canBurn(mime) { return !!IMAGE_FORMATS[mime] || mime === 'application/pdf'; }

async function burnImage(buf, mime, text, policy) {
  const sharp = loadSharp();
  const fmt = IMAGE_FORMATS[mime];
  // rotate() 无参 = 按 EXIF 摆正，否则手机照片的水印方向会和画面对不上
  const base = sharp(buf, { animated: false }).rotate();
  const meta = await sharp(await base.clone().png().toBuffer()).metadata();
  const scale = Math.max(1, Math.min(meta.width, meta.height) / 900);
  const tile = await renderTile(text, policy, scale);
  let img = base.composite([{ input: tile.png, tile: true, blend: 'over' }]);
  if (fmt === 'jpeg') img = img.jpeg({ quality: 90 });
  else if (fmt === 'webp') img = img.webp({ quality: 90 });
  else if (fmt === 'gif') img = img.gif();
  else img = img.png();
  return { data: await img.toBuffer(), cjk: tile.cjk };
}

async function burnPdf(buf, text, policy) {
  const { PDFDocument } = loadPdfLib();
  const doc = await PDFDocument.load(buf, { updateMetadata: false });   // 加密 PDF 会抛错 → 调用方拒绝下发
  // 以 2 倍分辨率渲染瓦片、按一半尺寸画到页面上，打印也清晰
  const tile = await renderTile(text, policy, 2);
  const img = await doc.embedPng(tile.png);
  const tw = tile.width / 2, th = tile.height / 2;
  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    for (let y = 0; y < height + th; y += th) {
      for (let x = 0; x < width + tw; x += tw) page.drawImage(img, { x, y, width: tw, height: th });
    }
  }
  return { data: Buffer.from(await doc.save()), cjk: tile.cjk };
}

/**
 * 主入口：对可烧录类型返回带水印的新 Buffer；不可烧录（docx 等）返回 null。
 * 出错直接抛出——调用方开启烧录时应拒绝下发，绝不退回原文件。
 */
async function burn(buf, mime, { user, policy, trace }) {
  if (!canBurn(mime)) return null;
  const tpl = String(process.env.WATERMARK_BURN_TEXT || '').trim() || policy.text;
  const text = resolveText(tpl, user, trace);
  if (mime === 'application/pdf') return burnPdf(buf, text, policy);
  return burnImage(buf, mime, text, policy);
}

module.exports = { isBurnOn, canBurn, burn, genTrace, resolveText, asciiOnly, resolveFont, renderTile, prefetchFont, DEFAULT_FONT_URL };
