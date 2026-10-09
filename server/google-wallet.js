/**
 * Google Wallet · 访客通行码（v3.5.91，零依赖）
 *
 * 把访客码做成 Google 钱包「通用卡券（Generic pass）」，访客点「添加到 Google 钱包」即可保存，扫码开门。
 * 复用 MDM 的那套 Google 服务账号（GOOGLE_SA_CLIENT_EMAIL + GOOGLE_SA_PRIVATE_KEY），外加一个
 * Google Wallet Issuer ID（GOOGLE_WALLET_ISSUER_ID，在 Google Pay & Wallet Console 申请）。
 *
 * 机制：用服务账号私钥 RS256 签一个「Save to Wallet」JWT（内联 class+object），
 *       链接 https://pay.google.com/gp/v/save/<JWT> 即保存按钮。无需预先建 class（JWT 内联即可）。
 *
 * E = env getter（默认全局；按组织覆盖时传该组织的 orgEnvGetter，v3.5.91 起 Wallet 也按组织）。
 */
'use strict';
const crypto = require('crypto');

const env = (k) => String(process.env[k] || '').trim();
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function safeId(s) { return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60); }

function isConfigured(E = env) {
  return !!(E('GOOGLE_SA_CLIENT_EMAIL') && E('GOOGLE_SA_PRIVATE_KEY') && E('GOOGLE_WALLET_ISSUER_ID'));
}

/**
 * 生成「添加到 Google 钱包」链接。
 * @param p         访客码行（code / visitor_name / valid_from / valid_to）
 * @param doorNames 可通行门名数组
 * @param opts      { orgName, bgColor }
 * @param E         env getter
 * @returns string  https://pay.google.com/gp/v/save/<jwt>
 */
function buildSaveLink(p, doorNames = [], opts = {}, E = env) {
  if (!isConfigured(E)) throw new Error('Google Wallet 未配置（GOOGLE_SA_* + GOOGLE_WALLET_ISSUER_ID）');
  const issuer = E('GOOGLE_WALLET_ISSUER_ID');
  const classId = `${issuer}.qwqaccess`;
  const objectId = `${issuer}.qwqpass_${safeId(p.code)}`;
  const bg = /^#[0-9a-fA-F]{6}$/.test(opts.bgColor || '') ? opts.bgColor : '#1a7f37';
  const zh = (value) => ({ defaultValue: { language: 'zh-CN', value: String(value || '') } });

  const genericClass = { id: classId };
  const text = [];
  if (doorNames.length) text.push({ id: 'doors', header: '可通行门', body: doorNames.join('、') });
  if (p.valid_to) text.push({ id: 'valid', header: '有效期', body: `${p.valid_from || ''} ~ ${p.valid_to}`.trim() });
  const genericObject = {
    id: objectId,
    classId,
    state: 'ACTIVE',
    cardTitle: zh(opts.orgName || 'QWQ SSO 访客通行'),
    header: zh(p.visitor_name || '访客'),
    hexBackgroundColor: bg,
    barcode: { type: 'QR_CODE', value: String(p.code || ''), alternateText: String(p.code || '') },
    textModulesData: text,
  };
  if (p.valid_to) {
    const iso = (d) => { try { return new Date(String(d).replace(' ', 'T') + 'Z').toISOString(); } catch (_) { return undefined; } };
    const start = p.valid_from ? iso(p.valid_from) : undefined;
    const end = iso(p.valid_to);
    if (end) genericObject.validTimeInterval = { start: start ? { date: start } : undefined, end: { date: end } };
  }

  const claims = {
    iss: E('GOOGLE_SA_CLIENT_EMAIL'),
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(Date.now() / 1000),
    payload: { genericClasses: [genericClass], genericObjects: [genericObject] },
  };
  const key = E('GOOGLE_SA_PRIVATE_KEY').replace(/\\n/g, '\n');
  const signingInput = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64url(JSON.stringify(claims));
  const sig = crypto.createSign('RSA-SHA256').update(signingInput).sign(key);
  const jwt = signingInput + '.' + b64url(sig);
  return 'https://pay.google.com/gp/v/save/' + jwt;
}

module.exports = { isConfigured, buildSaveLink };
