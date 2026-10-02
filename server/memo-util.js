/**
 * 备忘录附件与链接校验（v3.4.21）
 *
 * 附件白名单：只放行图片 / PDF / OOXML 文档（.docx/.xlsx/.pptx）/ 纯文本。
 * **宏格式一律拒绝**：.doc/.docm/.xls/.xlsm/.ppt/.pptm（旧 OLE 可带宏、新 *m 是启用宏的 OOXML），
 * 以及一切可执行/脚本（.exe/.js/.html/.svg 等本就不在白名单里）。
 * 双重校验：扩展名必须在白名单 + 文件头 magic bytes 必须与该类型相符（防改扩展名绕过）。
 *
 * 外部链接：默认只放行「白名单内网域」（env MEMO_LINK_DOMAINS，逗号分隔域名/后缀）；
 * 未配置则不允许任何外部链接。站内相对链接（/ 开头、非 //）始终允许。
 */

// 扩展名 → { mime, kind, magic:[候选头字节数组] | null(纯文本不校验头) }
const ATT_TYPES = {
  png:  { mime: 'image/png',  kind: 'image', magic: [[0x89, 0x50, 0x4E, 0x47]] },
  jpg:  { mime: 'image/jpeg', kind: 'image', magic: [[0xFF, 0xD8, 0xFF]] },
  jpeg: { mime: 'image/jpeg', kind: 'image', magic: [[0xFF, 0xD8, 0xFF]] },
  gif:  { mime: 'image/gif',  kind: 'image', magic: [[0x47, 0x49, 0x46, 0x38]] },
  webp: { mime: 'image/webp', kind: 'image', magic: [[0x52, 0x49, 0x46, 0x46]], riffWebp: true },
  pdf:  { mime: 'application/pdf', kind: 'file', magic: [[0x25, 0x50, 0x44, 0x46]] },   // %PDF
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',   kind: 'file', magic: [[0x50, 0x4B, 0x03, 0x04]] },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',         kind: 'file', magic: [[0x50, 0x4B, 0x03, 0x04]] },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', kind: 'file', magic: [[0x50, 0x4B, 0x03, 0x04]] },
  txt:  { mime: 'text/plain; charset=utf-8', kind: 'file', magic: null },
  csv:  { mime: 'text/csv; charset=utf-8',   kind: 'file', magic: null },
  md:   { mime: 'text/plain; charset=utf-8', kind: 'file', magic: null },
};

function extOf(filename) {
  const m = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

function startsWith(buf, bytes) {
  if (buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[i] !== bytes[i]) return false;
  return true;
}

// 返回 { ok, kind, mime, ext } 或 { ok:false, error }
function validateAttachment(filename, buf) {
  const ext = extOf(filename);
  const t = ATT_TYPES[ext];
  if (!t) return { ok: false, error: '不支持的文件类型（宏文档 .doc/.docm/.xlsm 等与可执行文件已禁止）' };
  if (!buf || !buf.length) return { ok: false, error: '空文件' };
  if (t.magic) {
    const hit = t.magic.some(sig => startsWith(buf, sig));
    if (!hit) return { ok: false, error: '文件内容与扩展名不符（可能被篡改）' };
    // webp: RIFF 头之外还要求偏移 8 处为 "WEBP"
    if (t.riffWebp && !(buf.length >= 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50)) {
      return { ok: false, error: 'WEBP 头校验失败' };
    }
  }
  return { ok: true, kind: t.kind, mime: t.mime, ext };
}

function linkWhitelist() {
  return String(process.env.MEMO_LINK_DOMAINS || '')
    .split(',').map(s => s.trim().toLowerCase().replace(/^\.+/, '')).filter(Boolean);
}

// 站内相对链接始终允许；外部 http(s) 链接必须命中白名单域（或其子域）；其余一律拒绝
function isLinkAllowed(url) {
  const raw = String(url || '').trim();
  if (!raw) return false;
  if (raw.startsWith('/') && !raw.startsWith('//')) return true;   // 站内相对
  let u;
  try { u = new URL(raw); } catch (_) { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;   // 挡 javascript:/data: 等
  const host = u.hostname.toLowerCase();
  const wl = linkWhitelist();
  if (!wl.length) return false;   // 默认：未配白名单 → 不允许任何外链
  return wl.some(d => host === d || host.endsWith('.' + d));
}

function maxAttachBytes() {
  const mb = parseFloat(process.env.MEMO_MAX_ATTACH_MB);
  const v = Number.isFinite(mb) && mb > 0 ? mb : 5;
  return Math.min(v, 12) * 1024 * 1024;   // 硬顶 12MB
}

module.exports = { validateAttachment, isLinkAllowed, linkWhitelist, maxAttachBytes, ATT_TYPES, extOf };
