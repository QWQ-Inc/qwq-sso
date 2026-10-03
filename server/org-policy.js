// 组织（登录主体）登录策略：IP 白名单 + 登录时段（v3.4.32 起三方登录通道执行，v3.5.24 起组织登录通道共用）
// 纯函数，oauth.js（三方登录 loginSuccess）与 api.js（/account/org-login）共用，避免两处判定漂移。
const { ipAllowed } = require('./auth');

/** 当前服务器本地时间是否在 [start,end] 时段内（HH:MM）；start>end 视为跨夜；配置无效则不拦 */
function withinLoginWindow(start, end, now = new Date()) {
  const m = s => { const [h, mi] = String(s).split(':').map(n => parseInt(n, 10)); return (h * 60 + mi); };
  const cur = now.getHours() * 60 + now.getMinutes();
  const a = m(start), b = m(end);
  if (isNaN(a) || isNaN(b)) return true;
  return a <= b ? (cur >= a && cur <= b) : (cur >= a || cur <= b);
}

/**
 * 组织级（与具体用户无关）的登录门：IP 白名单 + 登录时段。
 * 返回 null = 放行；否则 'ip_denied' | 'time_denied'。
 */
function subjectGateError(subj, ip, now = new Date()) {
  if (!subj) return null;
  if (subj.ip_allow && String(subj.ip_allow).trim()) {
    const clientIp = String(ip || '').replace('::ffff:', '');
    const list = String(subj.ip_allow).split(',').map(s => s.trim()).filter(Boolean);
    if (list.length && !ipAllowed(clientIp, list)) return 'ip_denied';
  }
  if (subj.login_start && subj.login_end && !withinLoginWindow(subj.login_start, subj.login_end, now)) return 'time_denied';
  return null;
}

module.exports = { withinLoginWindow, subjectGateError };
