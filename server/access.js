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
function hmacWith(data, secret) { return b64u(crypto.createHmac('sha256', secret).update(data).digest()); }
function hmac(data) { return hmacWith(data, qrSecret()); }

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

// 本地 YYYY-MM-DD
function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 规则的生效日期区间 / 时段 / 星期是否命中当前时间（空=不限）
function withinSchedule(rule, now = new Date()) {
  // 生效日期区间（活动期间整体开放：valid_from/valid_to 为 YYYY-MM-DD，含当天）
  const today = localDateStr(now);
  if (rule.valid_from && today < String(rule.valid_from).slice(0, 10)) return false;
  if (rule.valid_to && today > String(rule.valid_to).slice(0, 10)) return false;
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

// 访客通行码判定（与用户无关：时限 + 指定门 + 使用次数）
function evaluatePass(pass, door, now = new Date()) {
  if (!pass) return { allow: false, reason: 'pass_unknown' };
  if (pass.status !== 'active') return { allow: false, reason: 'pass_revoked' };
  const parse = s => s ? new Date(String(s).replace(' ', 'T')) : null;
  const from = parse(pass.valid_from), to = parse(pass.valid_to);
  if (from && now < from) return { allow: false, reason: 'pass_not_started' };
  if (to && now > to) return { allow: false, reason: 'pass_expired' };
  const doors = String(pass.door_ids || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!doors.length || !doors.includes(door.id)) return { allow: false, reason: 'pass_wrong_door' };
  if (pass.max_uses > 0 && (pass.used_count || 0) >= pass.max_uses) return { allow: false, reason: 'pass_used_up' };
  return { allow: true, reason: 'ok' };
}

// ── 跨系统联邦（v3.5.5）：共享密钥注册伙伴 + 签名跨域码 ──
// 跨域码 ft1.<payload>.<sig>，payload={iss:对方给的 peer_code, v:访客名, j:jti, e:exp}，用共享密钥 HMAC。
// 「谁开放门」由被访问方（host）在本地 peer.door_ids 决定；跨域码只证明「持有者经伙伴授权」。
function signFedCode(peerCode, secret, visitorName, ttlSec = 86400) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: peerCode, v: String(visitorName || '').slice(0, 40), j: crypto.randomBytes(6).toString('hex'), e: now + ttlSec };
  const body = b64u(JSON.stringify(payload));
  return { code: `ft1.${body}.${hmacWith(body, secret)}`, exp: payload.e };
}
function fedParse(code) {
  if (typeof code !== 'string') return null;
  const parts = code.split('.');
  if (parts.length !== 3 || parts[0] !== 'ft1') return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
  catch (_) { return null; }
  if (!payload || !payload.iss) return null;
  return { body: parts[1], sig: parts[2], ...payload };
}
function fedVerifySig(body, sig, secret) { return hmacWith(body, secret) === sig; }

// 跨域应用登录（v3.5.7）：签发方(B)给本域用户签一个「联邦登录令牌」带其身份断言，跳到伙伴(A)的 /fed/launch。
// fl1.<payload>.<sig>，payload={iss:peer_code, sub, name, email, app:client_id, e}。
function signFedLaunch(peerCode, secret, { sub, name, email, app }, ttlSec = 300) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: peerCode, sub: String(sub || ''), name: String(name || '').slice(0, 60), email: String(email || '').slice(0, 120), app: String(app || ''), e: now + ttlSec };
  const body = b64u(JSON.stringify(payload));
  return { token: `fl1.${body}.${hmacWith(body, secret)}`, exp: payload.e };
}
function fedLaunchParse(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'fl1') return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
  catch (_) { return null; }
  if (!payload || !payload.iss) return null;
  return { body: parts[1], sig: parts[2], ...payload };
}

// 跨域码判定（host 侧）：sig 已由调用方用 peer.secret 验过；这里查 peer 状态/有效期/门/码过期。
function evaluateFed(parsed, peer, door, now = new Date()) {
  if (!peer) return { allow: false, reason: 'fed_unknown' };
  if (peer.status !== 'active') return { allow: false, reason: 'fed_revoked' };
  const nowSec = Math.floor(now.getTime() / 1000);
  if (peer.valid_until) {
    const vu = new Date(String(peer.valid_until).replace(' ', 'T'));
    if (now > vu) return { allow: false, reason: 'fed_peer_expired' };
  }
  if (!parsed || !parsed.e || parsed.e < nowSec) return { allow: false, reason: 'fed_code_expired' };
  const doors = String(peer.door_ids || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!doors.length || !doors.includes(door.id)) return { allow: false, reason: 'fed_wrong_door' };
  return { allow: true, reason: 'ok' };
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
  pass_unknown: '访客码无效', pass_revoked: '访客码已撤销', pass_not_started: '访客码未到生效时间',
  pass_expired: '访客码已过期', pass_wrong_door: '访客码不含此门', pass_used_up: '访客码次数已用完',
  fed_unknown: '跨域伙伴未知', fed_revoked: '跨域伙伴已停用', fed_peer_expired: '跨域合作已到期',
  fed_code_expired: '跨域码已过期', fed_wrong_door: '跨域码不含此门', fed_bad_sig: '跨域码签名无效',
};

module.exports = {
  QR_TTL, signQr, verifyQr, evaluateAccess, evaluatePass, doorsForUser,
  signFedCode, fedParse, fedVerifySig, evaluateFed,
  signFedLaunch, fedLaunchParse,
  ruleMatchesUser, withinSchedule, levelTagOf, localDateStr, REASON_LABEL,
};
