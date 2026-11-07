/**
 * 访问前缀门（v3.5.134）——把整个人机界面藏在一个保密路径后面。
 *
 * 设计：ACCESS_PREFIX 设了就开启。不知道前缀、也没有门票 cookie 的请求一律 404（装作不存在）。
 * 访问 /<前缀> 即「敲门」，种一枚绑定当前前缀的签名 cookie，之后用正常绝对路径即可。
 *
 * ⚠️ 本系统是 SSO/OIDC 提供方：机器对接端点必须对外可达，否则第三方登录全断。
 *    所以下面 EXEMPT 列的前缀一律放行（不进门禁），其余（登录页/控制台/setup/控制台 API）才隐藏。
 *    = 隐藏「人用的界面」，但不挡「机器对接」。
 *
 * 纯逻辑，不碰 DB / express，便于单测。中间件在 index.js 里薄封装。
 */
const crypto = require('crypto');

// 机器对接 / 公开端点：开门禁也要放行，否则 OIDC / 第三方登录 / 开放 API / 设备代理会断
const EXEMPT = ['/.well-known/', '/oauth/', '/auth/', '/fed/', '/api/v1/', '/api/public/', '/api/mdm/', '/api/print/'];

function normPrefix(p) {
  return String(p == null ? '' : p).replace(/^[\/\s]+|[\/\s]+$/g, '');
}
// 设置时的合法性：1~64 位，字母数字 _ -（避免路径注入 / 歧义）
function validPrefix(p) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(p);
}
function randomPrefix(len) {
  const n = Math.max(4, Math.min(32, len || 6));
  // 纯数字随机（便于口述，如 419198）
  let s = '';
  const b = crypto.randomBytes(n);
  for (let i = 0; i < n; i++) s += (b[i] % 10);
  return s;
}
function secret() {
  return process.env.SESSION_SECRET || process.env.JWT_SECRET || 'qwq-gate-dev-secret';
}
// 门票值：绑定前缀 + 服务端密钥，攻击者无法伪造；换前缀 / 换密钥即全部失效
function cookieToken(prefix) {
  return crypto.createHmac('sha256', secret()).update('gate:v1:' + prefix).digest('base64url');
}
function parseCookie(header, name) {
  const parts = String(header || '').split(';');
  for (const p of parts) {
    const s = p.trim();
    if (s.startsWith(name + '=')) return s.slice(name.length + 1);
  }
  return '';
}
function isExempt(path) {
  return EXEMPT.some(e => path === e.slice(0, -1) || path.startsWith(e));
}
/**
 * 判定一个请求该怎么处理。prefix 必须已归一化且非空（调用方先判「功能是否开启」）。
 * 返回 { action: 'exempt' | 'pass' | 'block', setCookie: bool }
 *   exempt：机器端点，直接放行、不种票、不剥前缀
 *   pass：有票 或 正在敲门（setCookie=true 时要种票），放行（随后由 stripUrl 剥前缀）
 *   block：没票也没敲门 → 404 隐藏
 */
function decide(reqPath, cookieHeader, prefix) {
  if (isExempt(reqPath)) return { action: 'exempt', setCookie: false };
  const hasTicket = parseCookie(cookieHeader, 'qwq_gate') === cookieToken(prefix);
  if (hasTicket) return { action: 'pass', setCookie: false };
  const pfx = '/' + prefix;
  const onPrefix = reqPath === pfx || reqPath.startsWith(pfx + '/');
  if (onPrefix) return { action: 'pass', setCookie: true };   // 敲门
  return { action: 'block', setCookie: false };
}
// 把 /<前缀>/x?y 重写成 /x?y（带前缀访问深链时用）；无前缀的原样返回
function stripUrl(url, prefix) {
  const pfx = '/' + prefix;
  if (url === pfx) return '/';
  if (url.startsWith(pfx + '/')) return url.slice(pfx.length);
  if (url.startsWith(pfx + '?')) return '/' + url.slice(pfx.length);
  return url;
}
function cookieHeader(prefix, secure) {
  return `qwq_gate=${cookieToken(prefix)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}` + (secure ? '; Secure' : '');
}
// 通用 404，不暴露「这里有门禁」
function notFoundHtml() {
  return '<!doctype html><html><head><meta charset="utf-8"><title>404 Not Found</title></head><body style="font-family:system-ui;text-align:center;padding:60px;color:#555"><h1 style="font-size:48px;margin:0">404</h1><p>Not Found</p></body></html>';
}

module.exports = { normPrefix, validPrefix, randomPrefix, cookieToken, parseCookie, isExempt, decide, stripUrl, cookieHeader, notFoundHtml, EXEMPT };
