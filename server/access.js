// 门禁核心逻辑（v3.5.0）
// ① 动态二维码：45 秒一次性签名码（HMAC-SHA256），代表「人」而非某扇门——
//    一个码能开用户有权限的所有门；门口校验时按该门的授权规则判定。jti 一次性消费防截图重放。
// ② 权限判定 evaluateAccess(user, door, now)：拒绝规则优先于允许规则（满足「按分组批量放行 + 单独排除某人」）。
const crypto = require('crypto');
const { access, orgMembers, tags } = require('./db');

const QR_TTL = 45; // 秒

function qrSecret() {
  return process.env.ACCESS_QR_SECRET || process.env.JWT_SECRET || 'qwqsso-access-dev-secret';
}
function b64u(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function hmac(data) { return b64u(crypto.createHmac('sha256', qrSecret()).update(data).digest()); }

// 为用户签一个动态开门码：qr1.<payload>.<sig>
function signQr(user, ttl = QR_TTL) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { u: user.id, s: user.uid_seq, j: crypto.randomBytes(9).toString('hex'), e: now + ttl };
  const body = b64u(JSON.stringify(payload));
  return { code: `qr1.${body}.${hmac(body)}`, expires_in: ttl, exp: payload.e };
}

// 校验开门码；consume=true 时一次性消费 jti（门口校验用），防重放。
// 返回 { ok, payload, reason }
function verifyQr(code, { consume = true } = {}) {
  if (typeof code !== 'string') return { ok: false, reason: 'bad_code' };
  const parts = code.split('.');
  if (parts.length !== 3 || parts[0] !== 'qr1') return { ok: false, reason: 'bad_code' };
  const [, body, sig] = parts;
  if (hmac(body) !== sig) return { ok: false, reason: 'bad_sig' };
  let payload;
  try { payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
  catch (_) { return { ok: false, reason: 'bad_code' }; }
  const now = Math.floor(Date.now() / 1000);
  if (!payload || !payload.e || payload.e < now) return { ok: false, reason: 'expired' };
  if (!payload.j || !payload.u) return { ok: false, reason: 'bad_code' };
  if (consume) {
    if (access.qrUsed.get(payload.j)) return { ok: false, reason: 'replayed' };
    access.qrUse.run(payload.j, payload.e);
    if (Math.random() < 0.05) { try { access.qrClean.run(now); } catch (_) {} } // 偶尔清理过期 jti
  }
  return { ok: true, payload };
}

function levelTagOf(user) {
  if (!user) return '';
  return user.role === 'admin' ? ('A' + (user.admin_level || 1)) : ('U' + (user.user_level || 1));
}

// 规则是否命中该用户（不含时段，时段单独判）
function ruleMatchesUser(rule, user) {
  switch (rule.grant_type) {
    case 'all':   return true;
    case 'user':  return String(rule.grant_value) === String(user.id)
                      || String(rule.grant_value) === String(user.uid_seq)
                      || String(rule.grant_value) === String(user.uid_code || '');
    case 'group': return !!user.group_id && String(user.group_id) === String(rule.grant_value);
    case 'level': return String(rule.grant_value).toUpperCase() === levelTagOf(user);
    case 'org':   return !!orgMembers.get.get(rule.grant_value, user.id);
    case 'tag':   return (tags.ofUser.all(user.id) || []).some(t => String(t.id) === String(rule.grant_value));
    default:      return false;
  }
}

function hhmmToMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

// 规则的时段/星期是否命中当前时间（空=不限）
function withinSchedule(rule, now = new Date()) {
  // 星期
  const wd = String(rule.weekdays || '').split(/[，,]/).map(s => s.trim()).filter(s => s !== '');
  if (wd.length) {
    if (!wd.map(Number).includes(now.getDay())) return false;
  }
  // 时段（支持跨夜：start>end 视为当晚到次日）
  const start = hhmmToMin(rule.time_start), end = hhmmToMin(rule.time_end);
  if (start != null && end != null) {
    const cur = now.getHours() * 60 + now.getMinutes();
    if (start <= end) { if (cur < start || cur >= end) return false; }
    else { if (cur < start && cur >= end) return false; } // 跨夜
  }
  return true;
}

// 判定用户能否在 now 通过 door。返回 { allow, reason }
function evaluateAccess(user, door, now = new Date()) {
  if (!user) return { allow: false, reason: 'no_user' };
  if (user.status && user.status !== 'active') return { allow: false, reason: 'user_disabled' };
  if (!door) return { allow: false, reason: 'no_door' };
  if (door.status !== 'enabled') return { allow: false, reason: 'door_disabled' };

  const rules = access.rulesByDoor.all(door.id);
  // 拒绝优先：命中任一 deny 规则（且在其时段内）→ 直接拒
  for (const r of rules) {
    if (r.effect === 'deny' && ruleMatchesUser(r, user) && withinSchedule(r, now)) {
      return { allow: false, reason: 'denied_by_rule' };
    }
  }
  // 允许：命中任一 allow 规则且在时段内 → 放行
  let matchedButOffHours = false;
  for (const r of rules) {
    if (r.effect !== 'deny' && ruleMatchesUser(r, user)) {
      if (withinSchedule(r, now)) return { allow: true, reason: 'ok' };
      matchedButOffHours = true;
    }
  }
  return { allow: false, reason: matchedButOffHours ? 'out_of_schedule' : 'not_authorized' };
}

// 某用户当前能通行的门（用于 App「我能开的门」列表）
function doorsForUser(user, now = new Date()) {
  return access.enabledDoors.all()
    .map(d => ({ door: d, ev: evaluateAccess(user, d, now) }))
    .filter(x => x.ev.allow)
    .map(x => ({ id: x.door.id, name: x.door.name, location: x.door.location }));
}

const REASON_LABEL = {
  ok: '放行', no_user: '用户不存在', user_disabled: '用户已被禁用', no_door: '门不存在',
  door_disabled: '门禁已停用', denied_by_rule: '被拒绝规则命中', out_of_schedule: '不在允许时段',
  not_authorized: '无通行权限', bad_code: '无效开门码', bad_sig: '开门码签名错误',
  expired: '开门码已过期', replayed: '开门码已被使用', card_unknown: '卡未绑定或已停用',
};

module.exports = {
  QR_TTL, signQr, verifyQr, evaluateAccess, doorsForUser,
  ruleMatchesUser, withinSchedule, levelTagOf, REASON_LABEL,
};
