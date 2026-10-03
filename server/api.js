/**
 * API 路由 - 所有业务接口
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db, nextUidSeq, users, oauth, oauthProviders, oauthSubjects, orgMembers, appOrgs, appIcons, appFolders, appVisibleToUser, appVisibleInSession, memos, memoAtt, access, devices, verify, otp, logs, apps, idp, twofa, webauthn, announcements, documents, apiKeys, env, points } = require('./db');
const accessCore = require('./access');
const { validateAttachment, isLinkAllowed, linkWhitelist, maxAttachBytes } = require('./memo-util');
const { PLATFORMS: OAUTH_META } = require('./oauth-meta');
const { signToken, signShortToken, verifyToken, requireAuth, requireAdmin, requireApiKey } = require('./auth');
const totp = require('./twofa');
const { subjectGateError } = require('./org-policy');
// 短信与邮件统一走 QWQ Message 分发中心（v3.3.3 起不再直连服务商）
const { sendSmsCode, sendEmailCode, sendEmail, isConfigured: hasMessageHub } = require('./message');
// 组织专属短信/邮件凭证（v3.5.15）：某组织 msg_config 覆盖（空=回退全局）
function subjectMsgCfg(sid) {
  if (!sid) return undefined;
  try { const s = oauthSubjects.get.get(sid); return s && s.msg_config ? JSON.parse(s.msg_config) : undefined; } catch (_) { return undefined; }
}
// 某用户所属组织里第一个配了专属短信凭证的，用它（无则全局）。用于「成员上下文」的发送。
function userMsgCfg(user) {
  try {
    for (const o of (orgMembers.ofUser.all(user.id) || [])) {
      const cfg = subjectMsgCfg(o.id);
      if (cfg && Object.keys(cfg).length) return cfg;
    }
  } catch (_) {}
  return undefined;
}
// 组织专属实名(KYC)凭证（v3.5.16）：某组织 kyc_config 覆盖（空=回退全局）
function subjectKycCfg(sid) {
  if (!sid) return undefined;
  try { const s = oauthSubjects.get.get(sid); return s && s.kyc_config ? JSON.parse(s.kyc_config) : undefined; } catch (_) { return undefined; }
}
// 某用户所属组织里第一个配了专属 KYC 凭证的，用它（无则全局）。
function userKycCfg(user) {
  try {
    for (const o of (orgMembers.ofUser.all(user.id) || [])) {
      const cfg = subjectKycCfg(o.id);
      if (cfg && Object.keys(cfg).length) return cfg;
    }
  } catch (_) {}
  return undefined;
}

// ── org-first 登录（v3.5.17）──
// 「直接登录到某组织」：组织须 enabled 且 allow_direct_login=1 才作为公开的直登目标。
// 登录页发验证码时按此组织的专属短信/邮件凭证下发（公开面，只认已 opt-in 的组织）。
function directLoginSubject(orgId) {
  if (!orgId) return null;
  try { const s = oauthSubjects.get.get(orgId); return (s && s.enabled && s.allow_direct_login) ? s : null; } catch (_) { return null; }
}
function directLoginMsgCfg(orgId) {
  const s = directLoginSubject(orgId);
  if (!s || !s.msg_config) return undefined;
  try { const c = JSON.parse(s.msg_config); return Object.keys(c).length ? c : undefined; } catch (_) { return undefined; }
}
// 组织码（v3.5.18）：不显性组织靠它在登录页搜索。允许直登的组织若还没码则生成一个唯一短码并持久化。
function ensureOrgCode(s) {
  if (!s) return '';
  if (s.org_code) return s.org_code;
  if (!s.allow_direct_login) return '';
  const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混字符
  for (let i = 0; i < 20; i++) {
    const code = Array.from(crypto.randomBytes(8)).map(b => ALPH[b % ALPH.length]).join('');
    if (!oauthSubjects.byOrgCode.get(code)) { try { oauthSubjects.setOrgCode.run(code, s.id); s.org_code = code; return code; } catch (_) {} }
  }
  return '';
}
// 已登录用户的「当前组织」上下文：仅当用户确为该组织成员时，才用该组织的专属凭证；否则回退其所属组织里第一个。
function memberMsgCfg(user, orgId) {
  if (orgId && orgMembers.get.get(orgId, user.id)) { const c = subjectMsgCfg(orgId); if (c && Object.keys(c).length) return c; }
  return userMsgCfg(user);
}
function memberKycCfg(user, orgId) {
  if (orgId && orgMembers.get.get(orgId, user.id)) { const c = subjectKycCfg(orgId); if (c && Object.keys(c).length) return c; }
  return userKycCfg(user);
}
// 联系方式脱敏（跨组织成员池只给脱敏值，不泄露完整邮箱/手机）
function maskEmail(e) {
  const s = String(e || ''); const at = s.indexOf('@'); if (at < 1) return s ? '***' : '';
  const name = s.slice(0, at), dom = s.slice(at);
  return (name.length <= 2 ? name[0] + '*' : name.slice(0, 2) + '*'.repeat(Math.max(1, name.length - 2))) + dom;
}
function maskPhone(p) {
  const s = String(p || ''); if (s.length < 7) return s ? '***' : '';
  return s.slice(0, 3) + '****' + s.slice(-4);
}

const router = express.Router();
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const isPhone = s => /^1[3-9]\d{9}$/.test(s);

// ──────────────────────────────────────────
// 邮箱域名白/黑名单
//
// 由两个环境变量控制：
//   EMAIL_DOMAIN_MODE = off | whitelist | blacklist   （缺省 off，即不限制）
//   EMAIL_DOMAIN_LIST = example.com, foo.cn           （逗号分隔，不带 @）
//
// ⚠️ 策略只作用于「新账号进入系统」的路径：发验证码、注册、验证码自动注册。
// 已存在账号的密码登录**不拦截**——否则管理员事后加一条黑名单就会把
// 已有用户直接锁死在门外，那是误伤而不是策略。
// ──────────────────────────────────────────
function emailDomainPolicy() {
  const mode = (process.env.EMAIL_DOMAIN_MODE || 'off').trim().toLowerCase();
  const list = (process.env.EMAIL_DOMAIN_LIST || '')
    .split(',')
    .map(s => s.trim().toLowerCase().replace(/^@/, ''))   // 容忍管理员填成 @example.com
    .filter(Boolean);
  return { mode: ['whitelist', 'blacklist'].includes(mode) ? mode : 'off', list };
}

/** 返回 null 表示放行，否则返回给用户看的错误文案 */
function checkEmailDomain(email) {
  const { mode, list } = emailDomainPolicy();
  if (mode === 'off' || !list.length) return null;

  const domain = String(email).split('@').pop().trim().toLowerCase();
  // 子域也算命中：sub.example.com 属于 example.com
  const hit = list.some(d => domain === d || domain.endsWith('.' + d));

  if (mode === 'whitelist' && !hit) {
    return `当前仅允许以下邮箱域注册或登录：${list.map(d => '@' + d).join('、')}`;
  }
  if (mode === 'blacklist' && hit) {
    return `邮箱域 @${domain} 已被管理员禁用，请更换其他邮箱`;
  }
  return null;
}
const genCode = () => String(Math.floor(100000 + Math.random() * 900000));

function logLogin(data) {
  try {
    logs.insert.run({
      id: uuidv4(), user_id: data.userId||null, user_name: data.userName||null,
      uid_seq: data.uidSeq||null, method: data.method,
      app_name: data.appName||'本系统', ip: data.ip||null,
      user_agent: data.ua||null, status: data.status||'success',
      fail_reason: data.failReason||null,
    });
  } catch(_) {}
}

function safeUser(u) {
  if (!u) return null;
  // twofa_secret 是敏感密钥，绝不能随用户对象下发
  const { password_hash, twofa_secret, ...safe } = u;
  return safe;
}

// 用户的等级标识符（A1/U3…），2FA 强制策略按它匹配
function levelTag(u) {
  return (u.role === 'admin' ? 'A' : 'U') + (u.role === 'admin' ? (u.admin_level || 3) : (u.user_level || 4));
}

// 管理员强制开启 2FA 的等级列表：环境变量 TWOFA_REQUIRED_LEVELS，逗号分隔，如 "A1,A2,U1"
function twofaRequiredLevels() {
  return String(process.env.TWOFA_REQUIRED_LEVELS || '')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
}
// 该用户是否被强制要求开启 2FA（且当前还没开）
function mustSetup2fa(u) {
  if (u.twofa_enabled) return false;
  return twofaRequiredLevels().includes(levelTag(u));
}

/**
 * 登录凭据校验通过后的统一收口：
 * - 开了 2FA 的用户：不直接发正式 token，改发 5 分钟的中间态令牌，前端再走动态码校验
 * - 没开的：直接发正式 token；若被强制要求开启，带上 mustSetup2fa 让前端引导绑定
 */
function finishLogin(res, user, req, method, extra = {}) {
  const ua = req.headers['user-agent'];
  // org-scoped 登录（v3.5.20）：token 带 org/org_scoped，2FA 中间态也要带上，过二段后仍保留
  const org = extra.org || null, orgScoped = !!extra.org_scoped;
  if (user.twofa_enabled) {
    const twofa_token = signShortToken({ uid: user.id, stage: '2fa', method, org, org_scoped: orgScoped });
    return res.json({ success: true, twofa_required: true, twofa_token });
  }
  logLogin({ userId: user.id, userName: user.name, uidSeq: String(user.uid_seq), method, ip: req.ip, ua });
  const token = signToken({ uid: user.id, name: user.name, role: user.role, adminLevel: user.admin_level, ...(org ? { org, org_scoped: orgScoped } : {}) });
  return res.json({ success: true, token, user: safeUser(user), mustSetup2fa: mustSetup2fa(user), org, org_scoped: orgScoped });
}

// ── 短信验证码 ──
router.post('/sms/send', async (req, res) => {
  const { phone } = req.body;
  if (!phone || !isPhone(phone)) return res.status(400).json({ error: '手机号格式不正确' });
  const code = genCode();
  const expire = parseInt(process.env.SMS_CODE_EXPIRE || '300');
  otp.clean.run(Date.now());
  otp.set.run(`sms:${phone}`, code, Date.now() + expire * 1000);

  // org-first 登录（v3.5.17）：登录到某组织时，用该组织专属短信凭证下发（仅限已 opt-in 直登的组织）
  const orgCfg = directLoginMsgCfg(req.body.org);
  // 是否真发：看分发中心是否已配置（不看 NODE_ENV，见 CLAUDE.md）
  const hasSms = hasMessageHub(orgCfg);

  if (hasSms) {
    try {
      await sendSmsCode(phone, code, orgCfg);
    } catch (e) {
      console.error('[SMS] 发送失败:', e.message);
      return res.status(500).json({ error: `短信发送失败：${e.message}` });
    }
  } else {
    console.log(`[DEV SMS] 验证码 → ${phone} : ${code}（未配置 QWQ Message，仅打印）`);
  }

  res.json({ success: true, expires: expire, dev: !hasSms });
});

router.post('/sms/verify', (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ error: '参数缺失' });
  const entry = otp.get.get(`sms:${phone}`);
  if (!entry || Date.now() > entry.expire_at) { otp.del.run(`sms:${phone}`); return res.status(400).json({ error: '验证码不存在或已过期' }); }
  otp.incAtt.run(`sms:${phone}`);
  if (entry.attempts >= 5) return res.status(400).json({ error: '错误次数过多，请重新获取' });
  if (entry.code !== code) return res.status(400).json({ error: '验证码错误' });
  otp.del.run(`sms:${phone}`);
  let user = users.findByPhone.get(phone);
  if (!user) {
    user = users.create({ name: `用户${phone.slice(-4)}`, phone });
  }
  if (user.status === 'disabled') return res.status(403).json({ error: '账号已停用，请联系管理员' });
  return finishLogin(res, user, req, '短信验证码');
});

// ── 邮箱验证码 ──
router.post('/email/send-code', async (req, res) => {
  const { email } = req.body;
  if (!email || !isEmail(email)) return res.status(400).json({ error: '邮箱格式不正确' });
  const domainErr = checkEmailDomain(email);
  if (domainErr) return res.status(403).json({ error: domainErr });
  const code = genCode();
  const expire = parseInt(process.env.EMAIL_CODE_EXPIRE || '600');
  otp.set.run(`email:${email}`, code, Date.now() + expire * 1000);

  // org-first 登录（v3.5.17）：登录到某组织时，用该组织专属邮件凭证下发（仅限已 opt-in 直登的组织）
  const orgCfg = directLoginMsgCfg(req.body.org);
  // 是否真发：看分发中心是否已配置（不看 NODE_ENV，见 CLAUDE.md）
  const hasEmail = hasMessageHub(orgCfg);

  if (hasEmail) {
    try {
      await sendEmailCode(email, code, orgCfg);
    } catch (e) {
      console.error('[EMAIL] 发送失败:', e.message);
      return res.status(500).json({ error: `邮件发送失败：${e.message}` });
    }
  } else {
    // 未配置分发中心：开发模式，打印到控制台
    console.log(`[DEV EMAIL] 验证码 → ${email} : ${code}（未配置 QWQ Message，仅打印）`);
  }

  res.json({ success: true, expires: expire, dev: !hasEmail });
});

router.post('/email/verify-code', (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json({ error: '参数缺失' });
  const entry = otp.get.get(`email:${email}`);
  if (!entry || Date.now() > entry.expire_at) { otp.del.run(`email:${email}`); return res.status(400).json({ error: '验证码不存在或已过期' }); }
  otp.incAtt.run(`email:${email}`);
  if (entry.attempts >= 5) return res.status(400).json({ error: '错误次数过多' });
  if (entry.code !== code) return res.status(400).json({ error: '验证码错误' });
  otp.del.run(`email:${email}`);
  let user = users.findByEmail.get(email);
  if (!user) {
    // 这条路径会自动建号，等同注册，所以要过域名策略；
    // 已存在的账号不再校验，避免事后加黑名单把老用户锁死
    const domainErr = checkEmailDomain(email);
    if (domainErr) return res.status(403).json({ error: domainErr });
    user = users.create({ name: email.split('@')[0], email });
  }
  if (user.status === 'disabled') return res.status(403).json({ error: '账号已停用' });
  return finishLogin(res, user, req, '邮箱验证码');
});

// ── 账号密码注册/登录（邮箱或手机号均可）──
async function handleRegister(req, res) {
  const { email, phone, password, name } = req.body;

  // 账号可以是邮箱或手机号。登录页「账号类型」选手机号时前端发的就是 phone，
  // v3.3.3.2 之前这里只认 email，导致手机号注册必然报「邮箱格式不正确」。
  const byPhone = !email && !!phone;
  if (byPhone) {
    if (!isPhone(phone)) return res.status(400).json({ error: '手机号格式不正确' });
    if (users.findByPhone.get(phone)) return res.status(400).json({ error: '该手机号已注册' });
  } else {
    if (!email || !isEmail(email)) return res.status(400).json({ error: '邮箱格式不正确' });
    const domainErr = checkEmailDomain(email);   // 域名策略只作用于邮箱
    if (domainErr) return res.status(403).json({ error: domainErr });
    if (users.findByEmail.get(email)) return res.status(400).json({ error: '该邮箱已注册' });
  }
  if (!password || password.length < 6) return res.status(400).json({ error: '密码至少6位' });

  const hash = await bcrypt.hash(password, 12);
  const user = users.create({
    name: name || (byPhone ? `用户${String(phone).slice(-4)}` : email.split('@')[0]),
    email: byPhone ? null : email,
    phone: byPhone ? phone : null,
    password_hash: hash,
  });
  return finishLogin(res, user, req, byPhone ? '手机注册' : '邮箱注册');
}

router.post('/email/register',   handleRegister);   // 旧路径，保留兼容
router.post('/account/register', handleRegister);   // 语义更准的别名

// ══════════════════════════════════════════
// 2FA（TOTP 二次验证）
// ══════════════════════════════════════════

// 登录第二步：用中间态令牌 + 动态码（或恢复码）换正式 token
router.post('/2fa/login-verify', (req, res) => {
  const { twofa_token, code, recovery_code } = req.body;
  const { valid, data } = verifyToken(twofa_token || '');
  if (!valid || data.stage !== '2fa') return res.status(401).json({ error: '验证会话已过期，请重新登录' });
  const user = users.findById.get(data.uid);
  if (!user || !user.twofa_enabled || !user.twofa_secret) return res.status(400).json({ error: '账号状态异常，请重新登录' });
  if (user.status === 'disabled') return res.status(403).json({ error: '账号已停用，请联系管理员' });

  let ok = false, viaRecovery = false;
  if (recovery_code) {
    const row = twofa.findCode.get(user.id, totp.hashRecoveryCode(recovery_code));
    if (row) { twofa.useCode.run(row.id); ok = true; viaRecovery = true; }
  } else {
    ok = totp.verifyToken(user.twofa_secret, code);
  }
  if (!ok) {
    logLogin({ userId: user.id, userName: user.name, uidSeq: String(user.uid_seq), method: data.method || '账号密码', ip: req.ip, ua: req.headers['user-agent'], status: 'failed', failReason: '2FA 验证失败' });
    return res.status(401).json({ error: recovery_code ? '恢复码无效或已使用' : '动态验证码不正确' });
  }
  logLogin({ userId: user.id, userName: user.name, uidSeq: String(user.uid_seq), method: (data.method || '账号密码') + (viaRecovery ? '+恢复码' : '+2FA'), ip: req.ip, ua: req.headers['user-agent'] });
  // org-scoped 登录（v3.5.20）：从中间态令牌把 org/org_scoped 带进正式 token
  const org = data.org || null, orgScoped = !!data.org_scoped;
  const token = signToken({ uid: user.id, name: user.name, role: user.role, adminLevel: user.admin_level, ...(org ? { org, org_scoped: orgScoped } : {}) });
  const remaining = twofa.countCodes.get(user.id).n;
  res.json({ success: true, token, user: safeUser(user), recoveryCodesLeft: remaining, org, org_scoped: orgScoped });
});

// 我的 2FA 状态
router.get('/user/2fa/status', requireAuth, (req, res) => {
  const user = users.findById.get(req.user.uid);
  res.json({
    success: true,
    enabled: !!user.twofa_enabled,
    mustSetup: mustSetup2fa(user),
    recoveryCodesLeft: user.twofa_enabled ? twofa.countCodes.get(user.id).n : 0,
  });
});

// 发起绑定：生成一个待启用密钥（不落库，返回给前端；启用时再校验并持久化）
router.post('/user/2fa/setup', requireAuth, noPublic, (req, res) => {
  const user = users.findById.get(req.user.uid);
  if (user.twofa_enabled) return res.status(400).json({ error: '已开启 2FA，如需重置请先关闭' });
  const secret = totp.generateSecret();
  const label  = user.email || user.phone || user.name || ('uid' + user.uid_seq);
  const issuer = process.env.TWOFA_ISSUER || 'QWQ SSO';
  res.json({ success: true, secret, otpauth: totp.otpauthUri(secret, label, issuer) });
});

// 确认绑定：校验一次动态码，通过则启用并下发恢复码（仅此一次明文）
router.post('/user/2fa/enable', requireAuth, noPublic, (req, res) => {
  const user = users.findById.get(req.user.uid);
  if (user.twofa_enabled) return res.status(400).json({ error: '已开启 2FA' });
  const { secret, code } = req.body;
  if (!secret || !/^[A-Z2-7]+$/.test(secret)) return res.status(400).json({ error: '密钥无效，请重新发起绑定' });
  if (!totp.verifyToken(secret, code)) return res.status(400).json({ error: '动态验证码不正确，请确认 App 时间同步后重试' });

  users.set2fa.run(1, secret, user.id);
  twofa.clearCodes.run(user.id);
  const codes = totp.generateRecoveryCodes(10);
  const insertAll = db.transaction(list => list.forEach(c => twofa.insertCode.run(uuidv4(), user.id, totp.hashRecoveryCode(c))));
  insertAll(codes);
  res.json({ success: true, recoveryCodes: codes });
});

// 关闭 2FA：需要当前动态码或恢复码确认（防他人趁登录态偷偷关掉）
router.post('/user/2fa/disable', requireAuth, noPublic, (req, res) => {
  const user = users.findById.get(req.user.uid);
  if (!user.twofa_enabled) return res.json({ success: true });
  if (mustSetup2fa({ ...user, twofa_enabled: 0 })) {
    return res.status(403).json({ error: '管理员已要求你的等级必须开启 2FA，无法关闭' });
  }
  const { code, recovery_code } = req.body;
  let ok = false;
  if (recovery_code) ok = !!twofa.findCode.get(user.id, totp.hashRecoveryCode(recovery_code));
  else ok = totp.verifyToken(user.twofa_secret, code);
  if (!ok) return res.status(401).json({ error: '验证码不正确，无法关闭' });
  users.set2fa.run(0, null, user.id);
  twofa.clearCodes.run(user.id);
  res.json({ success: true });
});

// 重新生成恢复码（作废旧的），需当前动态码确认
router.post('/user/2fa/recovery/regenerate', requireAuth, noPublic, (req, res) => {
  const user = users.findById.get(req.user.uid);
  if (!user.twofa_enabled) return res.status(400).json({ error: '未开启 2FA' });
  if (!totp.verifyToken(user.twofa_secret, req.body.code)) return res.status(401).json({ error: '动态验证码不正确' });
  twofa.clearCodes.run(user.id);
  const codes = totp.generateRecoveryCodes(10);
  const insertAll = db.transaction(list => list.forEach(c => twofa.insertCode.run(uuidv4(), user.id, totp.hashRecoveryCode(c))));
  insertAll(codes);
  res.json({ success: true, recoveryCodes: codes });
});

// 按任意标识符解析用户：邮箱 / 手机号 / UID（#00001 或 1）/ 用户名。
// 返回用户行；重名返回 AMBIGUOUS；找不到返回 null。
const AMBIGUOUS = Symbol('ambiguous');
function resolveUser(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  // 公共账号不能自己登录（无凭据，只能被授权成员切换使用），登录解析一律排除
  const notPub = u => (u && !u.is_public) ? u : null;
  if (s.includes('@'))            return notPub(users.findByEmail.get(s));   // 邮箱
  if (/^1[3-9]\d{9}$/.test(s))    return notPub(users.findByPhone.get(s));   // 手机号
  // 自定义 UID（uid_code，如 QWQ-00042 / 随机数字串）——精确匹配，去掉可能带的 #
  const byCode = notPub(users.findByUidCode.get(s)) || notPub(users.findByUidCode.get(s.replace(/^#/, '')));
  if (byCode) return byCode;
  const digits = s.replace(/^#/, '');
  if (/^\d+$/.test(digits)) {                                                // 旧数字 UID（#00001 / 00001 / 1），向后兼容
    const bySeq = notPub(users.findByUidSeq.get(parseInt(digits, 10)));
    if (bySeq) return bySeq;                                                 // 纯数字但非有效 UID → 继续当用户名试
  }
  const byName = users.findByName.all(s).filter(u => !u.is_public);          // 用户名（可能重名）
  if (byName.length === 1) return byName[0];
  if (byName.length > 1)   return AMBIGUOUS;
  return null;
}

// 账号密码登录：邮箱 / 手机号 / UID / 用户名 均可
// （路径沿用 /email/login 是为了兼容既有调用方，实际不限邮箱；同时提供语义更准的别名）
async function handlePasswordLogin(req, res) {
  const { email, phone, account, password } = req.body;
  const identifier = String(account || email || phone || '').trim();
  const method = '账号密码';
  const badMsg = '账号或密码不正确';

  if (!identifier || !password) {
    return res.status(400).json({ error: '请输入账号和密码' });
  }

  const resolved = resolveUser(identifier);
  if (resolved === AMBIGUOUS) {
    return res.status(400).json({ error: '该用户名对应多个账号，请改用邮箱 / 手机号 / UID 登录' });
  }
  const user = resolved;
  const ua = req.headers['user-agent'];

  if (!user) {
    logLogin({ method, ip: req.ip, ua, status: 'failed', failReason: '账号不存在' });
    return res.status(401).json({ error: badMsg });
  }
  // 验证码注册的账号没有密码，单独提示，否则用户会一直以为是密码记错了
  if (!user.password_hash) {
    logLogin({ userId: user.id, userName: user.name, uidSeq: String(user.uid_seq), method, ip: req.ip, ua, status: 'failed', failReason: '未设置密码' });
    return res.status(401).json({ error: '该账号未设置密码，请改用验证码登录，登录后可在账号设定中设置密码' });
  }
  if (user.status === 'disabled') {
    logLogin({ userId: user.id, method, ip: req.ip, ua, status: 'disabled' });
    return res.status(403).json({ error: '账号已停用，请联系管理员' });
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    logLogin({ userId: user.id, userName: user.name, uidSeq: String(user.uid_seq), method, ip: req.ip, ua, status: 'failed', failReason: '密码错误' });
    return res.status(401).json({ error: badMsg });
  }
  return finishLogin(res, user, req, method);
}

router.post('/email/login',   handlePasswordLogin);   // 旧路径，保留兼容
router.post('/account/login', handlePasswordLogin);   // 语义更准的别名

// ── 登录到组织（IAM 用户，v3.5.20）──
// 复用平台账号但「限定到某组织」：用组织自有密码（优先）或——仅当组织非独立安全时——回退平台密码。
// 独立安全组织 → org-scoped 会话（不可切换，前端锁定）；非独立组织 → 普通会话但带 org 上下文。
async function handleOrgLogin(req, res) {
  const { account, password, org } = req.body || {};
  const ua = req.headers['user-agent'];
  const badMsg = '账号或密码不正确';
  if (!account || !password || !org) return res.status(400).json({ error: '请选择组织并填写账号和密码' });
  const s = directLoginSubject(org);   // enabled + allow_direct_login
  if (!s) return res.status(400).json({ error: '该组织未开放登录' });
  // 组织登录策略（IP 白名单 / 登录时段，v3.5.24）：组织级、与用户无关，先于密码校验——拒绝不泄露密码对错
  const gate = subjectGateError(s, req.ip);
  if (gate) {
    logLogin({ method: '组织登录·' + s.name, ip: req.ip, ua, status: 'failed', failReason: gate === 'ip_denied' ? '不在组织 IP 白名单内' : '不在组织允许登录时段内' });
    return res.status(403).json({ error: gate === 'ip_denied'
      ? '当前网络不在该组织允许的登录 IP 范围内'
      : `当前不在该组织允许的登录时段内（${s.login_start}~${s.login_end}）`, code: gate });
  }
  const resolved = resolveUser(String(account).trim());
  if (resolved === AMBIGUOUS) return res.status(400).json({ error: '该用户名对应多个账号，请改用邮箱 / 手机号 / UID' });
  const user = resolved;
  const member = user ? orgMembers.get.get(s.id, user.id) : null;
  if (!user || !member) { logLogin({ method: '组织登录', ip: req.ip, ua, status: 'failed', failReason: '非该组织成员' }); return res.status(401).json({ error: badMsg }); }
  if (user.status === 'disabled') { logLogin({ userId: user.id, method: '组织登录', ip: req.ip, ua, status: 'disabled' }); return res.status(403).json({ error: '账号已停用，请联系管理员' }); }

  // 成员设了组织密码 → 只认组织密码（优先独立功能）；没设 → 回退平台密码，
  // 除非组织额外开了「必须组织密码」管控（v3.5.27：独立安全不再隐含此项，改为组织可选的附加管控）
  let ok = false;
  if (member.password_hash) {
    ok = await bcrypt.compare(password, member.password_hash);
  } else if (!s.require_org_password && user.password_hash) {
    ok = await bcrypt.compare(password, user.password_hash);
  } else if (s.require_org_password) {
    return res.status(401).json({ error: '该组织要求使用组织密码登录，请联系组织管理员设置组织密码' });
  } else {
    return res.status(401).json({ error: '该账号未设置密码，请改用验证码登录' });
  }
  if (!ok) { logLogin({ userId: user.id, userName: user.name, uidSeq: String(user.uid_seq), method: '组织登录·' + s.name, ip: req.ip, ua, status: 'failed', failReason: badMsg }); return res.status(401).json({ error: badMsg }); }

  // 组织「强制两步验证」策略（v3.5.24 起与三方登录通道一致：只看 require_2fa，不再要求同时开独立安全）
  if (s.require_2fa && !user.twofa_enabled) {
    return res.status(403).json({ error: '该组织要求两步验证，请先在账号设定里开启两步验证后再登录' });
  }
  // org_scoped：独立安全组织锁定（不可切换）；非独立组织带 org 但不锁定（安全策略与平台相同，可切换）
  return finishLogin(res, user, req, '组织登录·' + s.name, { org: s.id, org_scoped: !!s.independent_security });
}
router.post('/account/org-login', handleOrgLogin);

// ── 登录到组织：验证码通道（v3.5.26）──
// 账号=邮箱/手机号；验证码由 /sms/send、/email/send-code（带 org）下发，走该组织专属消息凭证。
// 规则与密码通道一致：组织 IP/时段门先行；只认已存在且为本组织成员的账号（绝不自动建号）；
// 组织可用附加管控 deny_code_login 关掉本通道；强制 2FA 照常；org_scoped 同密码通道（独立安全=锁定）。
async function handleOrgCodeLogin(req, res) {
  const { account, code, org } = req.body || {};
  const ua = req.headers['user-agent'];
  const ident = String(account || '').trim();
  if (!ident || !code || !org) return res.status(400).json({ error: '请选择组织并填写邮箱/手机号和验证码' });
  const s = directLoginSubject(org);
  if (!s) return res.status(400).json({ error: '该组织未开放登录' });
  const method = '组织登录·验证码·' + s.name;
  const gate = subjectGateError(s, req.ip);
  if (gate) {
    logLogin({ method, ip: req.ip, ua, status: 'failed', failReason: gate === 'ip_denied' ? '不在组织 IP 白名单内' : '不在组织允许登录时段内' });
    return res.status(403).json({ error: gate === 'ip_denied'
      ? '当前网络不在该组织允许的登录 IP 范围内'
      : `当前不在该组织允许的登录时段内（${s.login_start}~${s.login_end}）`, code: gate });
  }
  if (s.deny_code_login) return res.status(400).json({ error: '该组织不允许验证码登录，请使用密码登录' });
  const byEmail = isEmail(ident), byPhone = !byEmail && isPhone(ident);
  if (!byEmail && !byPhone) return res.status(400).json({ error: '验证码登录请填写邮箱或手机号' });
  const key = (byEmail ? 'email:' : 'sms:') + ident;
  const entry = otp.get.get(key);
  if (!entry || Date.now() > entry.expire_at) { otp.del.run(key); return res.status(400).json({ error: '验证码不存在或已过期' }); }
  otp.incAtt.run(key);
  if (entry.attempts >= 5) { otp.del.run(key); return res.status(400).json({ error: '错误次数过多，请重新获取' }); }
  if (entry.code !== String(code).trim()) return res.status(400).json({ error: '验证码错误' });
  otp.del.run(key);
  const user = byEmail ? users.findByEmail.get(ident) : users.findByPhone.get(ident);
  const member = (user && !user.is_public) ? orgMembers.get.get(s.id, user.id) : null;
  if (!member) { logLogin({ method, ip: req.ip, ua, status: 'failed', failReason: '非该组织成员' }); return res.status(401).json({ error: '该账号不是此组织的成员' }); }
  if (user.status === 'disabled') { logLogin({ userId: user.id, method, ip: req.ip, ua, status: 'disabled' }); return res.status(403).json({ error: '账号已停用，请联系管理员' }); }
  if (s.require_2fa && !user.twofa_enabled) {
    return res.status(403).json({ error: '该组织要求两步验证，请先在账号设定里开启两步验证后再登录' });
  }
  return finishLogin(res, user, req, method, { org: s.id, org_scoped: !!s.independent_security });
}
router.post('/account/org-login-code', handleOrgCodeLogin);

// ── 忘记密码（公开，无需登录）──
// 隐私：无论账号是否存在都返回同样的成功文案，不泄露账号存在性。
// 验证码存在 reset:<userId> 下，重置时校验。
router.post('/public/forgot-password/send', async (req, res) => {
  const generic = { success: true, message: '若该账号存在且绑定了邮箱或手机，验证码已发送' };
  const identifier = String(req.body.account || '').trim();
  const user = identifier ? resolveUser(identifier) : null;
  if (!user || user === AMBIGUOUS) return res.json(generic);

  const channel = user.email ? 'email' : (user.phone ? 'sms' : null);
  const target  = user.email || user.phone;
  if (!channel) return res.json(generic);   // 纯第三方登录账号，没有可下发的渠道

  const code   = genCode();
  const expire = parseInt(process.env[channel === 'email' ? 'EMAIL_CODE_EXPIRE' : 'SMS_CODE_EXPIRE'] || (channel === 'email' ? '600' : '300'));
  otp.set.run(`reset:${user.id}`, code, Date.now() + expire * 1000);
  if (hasMessageHub()) {
    try { if (channel === 'email') await sendEmailCode(target, code); else await sendSmsCode(target, code); }
    catch (e) { console.error('[FORGOT] 发送失败:', e.message); }   // 不把细节回传，避免探测
  } else {
    console.log(`[DEV RESET OTP] ${target} → ${code}`);
  }
  res.json(generic);
});

router.post('/public/forgot-password/reset', async (req, res) => {
  const { account, code, new_password } = req.body;
  if (!new_password || new_password.length < 8) return res.status(400).json({ error: '新密码至少 8 位' });
  const badCode = { error: '验证码无效或已过期' };
  const user = account ? resolveUser(String(account).trim()) : null;
  if (!user || user === AMBIGUOUS) return res.status(400).json(badCode);

  const key = `reset:${user.id}`;
  const entry = otp.get.get(key);
  if (!entry || Date.now() > entry.expire_at) { otp.del.run(key); return res.status(400).json(badCode); }
  otp.incAtt.run(key);
  if (entry.attempts >= 5) { otp.del.run(key); return res.status(400).json({ error: '错误次数过多，请重新获取验证码' }); }
  if (entry.code !== code) return res.status(400).json({ error: '验证码不正确' });
  otp.del.run(key);
  users.updatePassword.run(await bcrypt.hash(new_password, 12), user.id);
  logLogin({ userId: user.id, userName: user.name, uidSeq: String(user.uid_seq), method: '找回密码', ip: req.ip, ua: req.headers['user-agent'], status: 'success' });
  res.json({ success: true });
});

// ── 用户信息 ──
// ── KYC 实名认证接口 ──
const { createKycSession, verifyKycDirect, verifyDiditWebhook, verifyStripeWebhook, queryAlipayCertify, identityHashes, kycHmac, normName, normId, kycPseudonymEnabled, envGetter: kycEnvGetter } = require('./kyc');
const { audit, actorOf, verifyChain: auditVerifyChain, list: auditList, bySubject: auditBySubject } = require('./audit');

// ── 账号撤销主动推送（v3.5.11）：SSO 主动把「停用/删除/撤销」事件签名推给应用的撤销回调 ──
// 应用据此停用/删除本地账号（解决 introspection 拉取不适用、应用无 IAM 的问题）。
// ⚠️ 只能推给配置了 deprovision_url 的应用；完全无集成点的黑盒应用无法主动控制。
async function deprovisionPush(app, payload) {
  if (!app || !app.deprovision_url || !/^https?:\/\//i.test(app.deprovision_url)) return false;
  const body = JSON.stringify({ ...payload, app_id: app.id, ts: Math.floor(Date.now() / 1000) });
  const sig = require('crypto').createHmac('sha256', app.client_secret || '').update(body).digest('hex');
  try {
    const r = await fetch(app.deprovision_url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-QWQ-Signature': 'sha256=' + sig }, body });
    return r.ok;
  } catch (_) { return false; }
}
// 把某用户的「停用/删除」推给他授权过的所有应用（自定义 webhook + 标准 Back-Channel Logout 两手）
function deprovisionUserAllApps(user, event) {
  try {
    const bcl = require('./provider').backchannelLogout;
    for (const a of apps.getUserApps.all(user.id)) {
      deprovisionPush(a, { event, sub: user.id, uid: user.uid_seq, uid_code: user.uid_code || null });
      if (bcl) bcl(a, user.id);
    }
  } catch (_) {}
}

// 支付宝实人认证待确认记录：发起时存 certify_id + 姓名/尾号 + 身份哈希，用户核身回跳后查询落库
try {
  db.exec(`CREATE TABLE IF NOT EXISTS kyc_pending (
    user_id    TEXT PRIMARY KEY,
    provider   TEXT NOT NULL,
    certify_id TEXT NOT NULL,
    name       TEXT NOT NULL DEFAULT '',
    id_tail    TEXT NOT NULL DEFAULT '',
    pseudonym  TEXT,
    name_hash  TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
} catch (_) {}
try { db.exec('ALTER TABLE kyc_pending ADD COLUMN pseudonym TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE kyc_pending ADD COLUMN name_hash TEXT'); } catch (_) {}
// 二次/多次实名：发起「重新核验」会话时打的标记。回调/webhook 完成时即便已实名也放行并记一次事件。
try { db.exec('ALTER TABLE kyc_pending ADD COLUMN reverify INTEGER NOT NULL DEFAULT 0'); } catch (_) {}
try { db.exec('ALTER TABLE kyc_pending ADD COLUMN source TEXT'); } catch (_) {}
// org-first（v3.5.17）：发起支付宝会话时用的组织上下文，回调查询要用同一套组织凭证签名
try { db.exec('ALTER TABLE kyc_pending ADD COLUMN org_id TEXT'); } catch (_) {}
// 实名认证事件流水（每次认证/二次核验落一条，供审计与「多次实名」历史）
try {
  db.exec(`CREATE TABLE IF NOT EXISTS kyc_events (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    provider   TEXT,
    status     TEXT NOT NULL DEFAULT 'verified',   -- verified | reverified
    reverify   INTEGER NOT NULL DEFAULT 0,
    source     TEXT,                                -- self | admin | api
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
} catch (_) {}
const kycEvents = {
  insert: db.prepare('INSERT INTO kyc_events (id,user_id,provider,status,reverify,source) VALUES (?,?,?,?,?,?)'),
  byUser: db.prepare('SELECT id,provider,status,reverify,source,created_at FROM kyc_events WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 100'),
  countByUser: db.prepare('SELECT COUNT(*) n FROM kyc_events WHERE user_id=?'),
};
const kycPending = {
  set:    db.prepare(`INSERT INTO kyc_pending (user_id,provider,certify_id,name,id_tail,pseudonym,name_hash,reverify,source) VALUES (?,?,?,?,?,?,?,?,?)
                      ON CONFLICT(user_id) DO UPDATE SET provider=excluded.provider,certify_id=excluded.certify_id,name=excluded.name,id_tail=excluded.id_tail,pseudonym=excluded.pseudonym,name_hash=excluded.name_hash,reverify=excluded.reverify,source=excluded.source,created_at=datetime('now')`),
  get:    db.prepare('SELECT * FROM kyc_pending WHERE user_id=?'),
  remove: db.prepare('DELETE FROM kyc_pending WHERE user_id=?'),
  setOrg: db.prepare('UPDATE kyc_pending SET org_id=? WHERE user_id=?'),
};
// 统一写入 KYC 结果（含假名/姓名哈希）——各服务商完成点复用。reverify/source 可选，用于记事件。
function finalizeKyc(userId, { maskedName, idTail, provider, pseudonym, nameHash, reverify = false, source = 'self' }) {
  db.prepare(`UPDATE users SET kyc_verified=1, kyc_name=?, kyc_id_tail=?, kyc_provider=?,
    kyc_pseudonym=COALESCE(?,kyc_pseudonym), kyc_name_hash=COALESCE(?,kyc_name_hash),
    kyc_verified_at=datetime('now'), updated_at=datetime('now') WHERE id=?`)
    .run(maskedName, idTail, provider, pseudonym || null, nameHash || null, userId);
  try { kycEvents.insert.run(uuidv4(), userId, provider || '—', reverify ? 'reverified' : 'verified', reverify ? 1 : 0, source); } catch (_) {}
  const u = users.findById.get(userId);
  audit(reverify ? 'kyc.reverified' : 'kyc.verified', {
    subject: u ? u.uid_seq : userId, actor: `source:${source}`,
    detail: { provider: provider || '—', id_tail: idTail || null },
  });
}
// 判断本次完成是否应放行 finalize：未实名，或存在「重新核验」pending 标记
function kycShouldFinalize(user, pend) {
  return !!(user && (!user.kyc_verified || (pend && pend.reverify)));
}
const maskName = nm => !nm ? '—' : (nm.length <= 2 ? nm[0] + '*' : nm[0] + '*'.repeat(nm.length - 2) + nm.slice(-1));

// 用户端：发起 KYC 认证（会话跳转模式 - Didit / Stripe）
router.post('/user/kyc/session', requireAuth, noPublic, async (req, res) => {
  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.kyc_verified) return res.status(400).json({ error: '已完成实名认证' });

  // 支付宝实人认证需要姓名+身份证号（发起前收集）；不传则只在 Didit/Stripe 里轮询
  const name     = (req.body?.name || '').trim();
  const idNumber = (req.body?.id_number || '').trim();

  try {
    const callbackUrl = `${process.env.BASE_URL || ''}/auth/kyc/callback?user_id=${user.id}`;
    const { result } = await createKycSession(user.id, callbackUrl, { name, idNumber, orgKyc: memberKycCfg(user, req.body?.org) });
    // 支付宝：结果不随回跳带回，需在 callback 里用 certify_id 查询。
    // 在此（有完整证件号）算好假名/姓名哈希存进 pending，回跳成功后落库——避免把原文写进库。
    if (result.provider === 'alipay') {
      const h = identityHashes(name, idNumber);
      kycPending.set.run(user.id, 'alipay', result.session_id, name, idNumber.slice(-4), h.pseudonym, h.nameHash, 0, 'self');
      // 记录组织上下文（成员才算数），回调查询用同一套凭证
      const ctxOrg = (req.body?.org && orgMembers.get.get(req.body.org, user.id)) ? req.body.org : null;
      if (ctxOrg) kycPending.setOrg.run(ctxOrg, user.id);
    }
    res.json({ success: true, redirect_url: result.redirect_url, provider: result.provider, session_id: result.session_id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 管理端：向指定用户发送实名认证链接（优先短信+邮箱双通道同时发送）
router.post('/admin/users/:id/send-kyc-link', requireAdmin(2), async (req, res) => {
  const user = users.findById.get(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.kyc_verified) return res.status(400).json({ error: '该用户已完成实名认证' });
  if (!user.phone && !user.email) return res.status(400).json({ error: '用户未绑定手机或邮箱，无法发送认证链接' });

  let redirectUrl, provider;
  try {
    const callbackUrl = `${process.env.BASE_URL || ''}/auth/kyc/callback?user_id=${user.id}`;
    const { result } = await createKycSession(user.id, callbackUrl, { orgKyc: userKycCfg(user) });
    redirectUrl = result.redirect_url;
    provider    = result.provider;
  } catch (e) {
    return res.status(500).json({ error: `生成认证链接失败：${e.message}` });
  }

  // 双通道同时发送（不做轮询选择，短信和邮箱都配置了就都发）
  const results = { sms: null, email: null };
  const sendTasks = [];
  const orgCfg = userMsgCfg(user);   // 成员所属组织若配了专属短信/邮件凭证，用它

  if (user.phone) {
    // 短信通道：需要短信服务商预先审核过「实名认证通知」类模板，
    // 模板内容形如「请点击链接完成实名认证：{1}」，{1} 处填入短链接
    sendTasks.push(
      sendSmsCode(user.phone, redirectUrl, orgCfg)
        .then(() => { results.sms = 'sent'; })
        .catch(e => { results.sms = `failed: ${e.message}`; })
    );
  }
  if (user.email) {
    sendTasks.push(
      sendEmail(
        user.email,
        '请完成实名认证',
        `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 20px;">
          <h2 style="color:#111;">实名认证提醒</h2>
          <p style="color:#555;line-height:1.7;">您的账号尚未完成实名认证，请点击下方按钮前往完成：</p>
          <a href="${redirectUrl}" style="display:inline-block;margin:16px 0;padding:12px 28px;background:#5A8A00;color:#fff;text-decoration:none;border-radius:4px;font-weight:600;">立即认证</a>
          <p style="color:#999;font-size:12px;">如果按钮无法点击，请复制以下链接到浏览器打开：<br>${redirectUrl}</p>
        </div>`,
        orgCfg
      )
        .then(() => { results.email = 'sent'; })
        .catch(e => { results.email = `failed: ${e.message}`; })
    );
  }

  await Promise.all(sendTasks);

  const anySuccess = results.sms === 'sent' || results.email === 'sent';
  if (!anySuccess) {
    return res.status(500).json({ error: '短信和邮箱均发送失败', detail: results });
  }

  res.json({ success: true, provider, results, redirect_url: redirectUrl });
});
router.post('/user/kyc/direct', requireAuth, noPublic, async (req, res) => {
  const { name, id_number } = req.body;
  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.kyc_verified) return res.status(400).json({ error: '已完成实名认证' });
  if (!name?.trim() || !id_number?.trim()) return res.status(400).json({ error: '姓名和身份证号为必填' });

  try {
    await verifyKycDirect(name.trim(), id_number.trim(), memberKycCfg(user, req.body?.org));
    // 写入认证结果（含假名/姓名哈希，供去重与姓名比对）
    const h = identityHashes(name, id_number);
    finalizeKyc(user.id, { maskedName: maskName(name.trim()), idTail: id_number.slice(-4), provider: '服务商直接认证', pseudonym: h.pseudonym, nameHash: h.nameHash });
    res.json({ success: true, message: '实名认证成功' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Webhook 回调：Didit 认证结果
router.post('/webhook/kyc/didit', express.raw({ type: '*/*' }), (req, res) => {
  const sig    = req.headers['x-didit-signature'] || req.headers['x-webhook-signature'] || '';
  const secret = process.env.DIDIT_WEBHOOK_SECRET;
  if (secret && sig && !verifyDiditWebhook(req.body, sig, secret)) {
    return res.status(400).json({ error: 'Invalid signature' });
  }
  try {
    const payload = JSON.parse(req.body.toString());
    const userId  = payload.vendor_data || payload.session?.vendor_data;
    const status  = payload.status;
    if (userId && (status === 'Approved' || status === 'approved')) {
      const user = users.findById.get(userId);
      const pend = kycPending.get.get(userId);
      if (kycShouldFinalize(user, pend)) {
        const docData = payload.kyc_result?.id_verification || {};
        const name    = docData.full_name || '';
        const idNum   = docData.document_number || '';
        const h = identityHashes(name, idNum);
        finalizeKyc(userId, { maskedName: maskName(name) || '—', idTail: idNum.slice(-4) || '—', provider: 'Didit', pseudonym: h.pseudonym, nameHash: h.nameHash, reverify: !!pend?.reverify, source: pend?.source || 'self' });
        if (pend) kycPending.remove.run(userId);
      }
    }
    recordCall('kyc_didit', status === 'Approved' || status === 'approved');
  } catch (_) {}
  res.json({ received: true });
});

// Webhook 回调：Stripe Identity 认证结果
router.post('/webhook/kyc/stripe', express.raw({ type: '*/*' }), (req, res) => {
  const sig    = req.headers['stripe-signature'] || '';
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (secret && sig && !verifyStripeWebhook(req.body.toString(), sig, secret)) {
    return res.status(400).json({ error: 'Invalid signature' });
  }
  try {
    const event   = JSON.parse(req.body.toString());
    const session = event.data?.object;
    const userId  = session?.metadata?.user_id;
    if (userId && event.type === 'identity.verification_session.verified') {
      const user = users.findById.get(userId);
      const pend = kycPending.get.get(userId);
      if (kycShouldFinalize(user, pend)) {
        const outputs = session.verified_outputs || {};
        const name    = outputs.name ? `${outputs.name.last_name || ''}${outputs.name.first_name || ''}` : '';
        const idNum   = outputs.id_number || outputs.document?.number || '';
        const h = identityHashes(name, idNum);
        finalizeKyc(userId, { maskedName: maskName(name) || '—', idTail: idNum.slice(-4) || '—', provider: 'Stripe Identity', pseudonym: h.pseudonym, nameHash: h.nameHash, reverify: !!pend?.reverify, source: pend?.source || 'self' });
        if (pend) kycPending.remove.run(userId);
      }
      recordCall('kyc_stripe', true);
    } else if (event.type === 'identity.verification_session.requires_input') {
      recordCall('kyc_stripe', false);
    }
  } catch (_) {}
  res.json({ received: true });
});

// KYC 认证完成跳转页（用户完成 Didit/Stripe 后跳回）
router.get('/auth/kyc/callback', async (req, res) => {
  const { user_id, status } = req.query;
  let success = status === 'Approved' || status === 'verified';

  // 支付宝：回跳时不带结果，用发起时存的 certify_id 主动查询并落库
  const pending = user_id ? kycPending.get.get(user_id) : null;
  if (pending && pending.provider === 'alipay') {
    try {
      // 查询要用与发起 initialize 时同一套（组织专属）支付宝凭证签名：
      // 优先 pending 记下的组织上下文（org-first），否则回退该用户所属组织
      const qUser = users.findById.get(user_id);
      const orgKyc = pending.org_id ? subjectKycCfg(pending.org_id) : (qUser ? userKycCfg(qUser) : null);
      const { passed } = await queryAlipayCertify(pending.certify_id, kycEnvGetter(orgKyc));
      recordCall('kyc_alipay', passed);
      if (passed) {
        const user = users.findById.get(user_id);
        if (kycShouldFinalize(user, pending)) {
          finalizeKyc(user_id, { maskedName: maskName(pending.name), idTail: pending.id_tail || '—', provider: '支付宝实人认证', pseudonym: pending.pseudonym, nameHash: pending.name_hash, reverify: !!pending.reverify, source: pending.source || 'self' });
        }
        success = true;
      }
    } catch (_) { /* 查询失败当作 pending，用户可重试 */ }
    kycPending.remove.run(user_id);
  }

  res.redirect(`/dashboard.html?kyc_result=${success ? 'success' : 'pending'}&user_id=${user_id}`);
});
// ── 等级管理（持久化）──
try {
  db.exec(`CREATE TABLE IF NOT EXISTS user_levels (
    id       TEXT PRIMARY KEY,
    grp      TEXT NOT NULL DEFAULT 'user',
    num      INTEGER NOT NULL,
    name     TEXT NOT NULL,
    badge    TEXT NOT NULL DEFAULT '👤',
    descr    TEXT NOT NULL DEFAULT '',
    perms    TEXT NOT NULL DEFAULT '[]',
    UNIQUE(grp, num)
  )`);
  const cnt = db.prepare('SELECT COUNT(*) n FROM user_levels').get().n;
  if (cnt === 0) {
    const defaults = [
      ['user',1,'VIP 会员','👑','最高用户等级，享有全部用户侧服务及优先支持通道。','["login","checkin","points","app_market","login_log","bind_oauth","api_access","realname"]'],
      ['user',2,'高级用户','⭐','积累足量积分或完成实名认证后可晋升，解锁 API 接入权限。','["login","checkin","points","app_market","login_log","bind_oauth","api_access","realname"]'],
      ['user',3,'认证用户','✅','完成实名认证的标准用户，可绑定三方账号并接入应用市场。','["login","checkin","points","app_market","login_log","bind_oauth","realname"]'],
      ['user',4,'普通用户','👤','默认注册后所属等级，可使用基础登录与签到服务。','["login","checkin","points","login_log"]'],
      ['user',5,'受限用户','🔒','因违规或未完成初始设置而受限，仅保留基础登录权限。','["login"]'],
      ['admin',1,'超级管理员','🛡️','拥有平台全部权限，包括系统配置、等级管理与所有管理功能。','["login","checkin","points","app_market","login_log","bind_oauth","api_access","realname","adm_users","adm_apps","adm_logs","adm_levels","sys_config"]'],
      ['admin',2,'运营管理员','📋','负责日常用户与应用管理，可查看全量日志，不可修改系统配置。','["login","checkin","points","app_market","login_log","bind_oauth","api_access","realname","adm_users","adm_apps","adm_logs"]'],
      ['admin',3,'只读管理员','👁️','仅可查看用户信息与日志，无编辑与审核权限。','["login","login_log","adm_users","adm_logs"]'],
    ];
    const ins = db.prepare('INSERT INTO user_levels (id,grp,num,name,badge,descr,perms) VALUES (?,?,?,?,?,?,?)');
    defaults.forEach(d => ins.run(uuidv4(), ...d));
  }
} catch(_) {}

router.get('/admin/levels', requireAdmin(1), (req, res) => {
  const rows = db.prepare('SELECT * FROM user_levels ORDER BY grp, num').all();
  const withCounts = rows.map(l => {
    const n = l.grp === 'admin'
      ? db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND admin_level=?").get(l.num).n
      : db.prepare("SELECT COUNT(*) n FROM users WHERE role!='admin' AND user_level=?").get(l.num).n;
    return { ...l, user_count: n, level_tag: (l.grp === 'admin' ? 'A' : 'U') + l.num };
  });
  res.json({ success: true, levels: withCounts });
});

router.post('/admin/levels', requireAdmin(1), (req, res) => {
  const { grp, num, name, badge, descr, perms } = req.body;
  if (!['user','admin'].includes(grp)) return res.status(400).json({ error: '组别无效' });
  const n = parseInt(num);
  if (isNaN(n) || n < 1 || n > 9) return res.status(400).json({ error: '等级数字必须为 1-9 的一位数字' });
  if (!name?.trim()) return res.status(400).json({ error: '等级名称必填' });
  const exists = db.prepare('SELECT 1 FROM user_levels WHERE grp=? AND num=?').get(grp, n);
  if (exists) return res.status(400).json({ error: `${grp === 'admin' ? 'A' : 'U'}${n} 等级已存在` });
  db.prepare('INSERT INTO user_levels (id,grp,num,name,badge,descr,perms) VALUES (?,?,?,?,?,?,?)')
    .run(uuidv4(), grp, n, name.trim(), badge || '👤', descr || '', JSON.stringify(perms || []));
  res.json({ success: true });
});

router.patch('/admin/levels/:id', requireAdmin(1), (req, res) => {
  const { name, badge, descr, perms } = req.body;
  const lv = db.prepare('SELECT * FROM user_levels WHERE id=?').get(req.params.id);
  if (!lv) return res.status(404).json({ error: '等级不存在' });
  db.prepare('UPDATE user_levels SET name=?,badge=?,descr=?,perms=? WHERE id=?')
    .run(name?.trim() || lv.name, badge || lv.badge, descr ?? lv.descr,
         perms ? JSON.stringify(perms) : lv.perms, lv.id);
  res.json({ success: true });
});

router.delete('/admin/levels/:id', requireAdmin(1), (req, res) => {
  const lv = db.prepare('SELECT * FROM user_levels WHERE id=?').get(req.params.id);
  if (!lv) return res.status(404).json({ error: '等级不存在' });
  const n = lv.grp === 'admin'
    ? db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND admin_level=?").get(lv.num).n
    : db.prepare("SELECT COUNT(*) n FROM users WHERE role!='admin' AND user_level=?").get(lv.num).n;
  if (n > 0) return res.status(400).json({ error: `该等级下还有 ${n} 名用户，请先迁移后再删除` });
  db.prepare('DELETE FROM user_levels WHERE id=?').run(lv.id);
  res.json({ success: true });
});

const { getAllStats, resetStats, recordCall } = require('./poller');

router.get('/admin/provider-stats', requireAdmin(2), (req, res) => {
  res.json({ success: true, stats: getAllStats() });
});

router.delete('/admin/provider-stats/:provider', requireAdmin(2), (req, res) => {
  resetStats(decodeURIComponent(req.params.provider));
  res.json({ success: true });
});

// ── API 调用日志表 ──
try {
  db.exec(`CREATE TABLE IF NOT EXISTS api_call_logs (
    id          TEXT PRIMARY KEY,
    direction   TEXT NOT NULL DEFAULT 'inbound',
    method      TEXT, path TEXT, provider TEXT,
    status      INTEGER, success INTEGER NOT NULL DEFAULT 1,
    error_msg   TEXT, duration_ms INTEGER, ip TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
} catch(_) {}

// ── 记录入站 API 调用的中间件（在路由之前）──
router.use((req, res, next) => {
  const start = Date.now();
  const origEnd = res.end.bind(res);
  res.end = function(...args) {
    try {
      if (!req.path.startsWith('/public/') && req.path !== '/') {
        db.prepare("INSERT OR IGNORE INTO api_call_logs (id,direction,method,path,status,success,duration_ms,ip) VALUES (?,?,?,?,?,?,?,?)")
          .run(uuidv4(), 'inbound', req.method, req.path, res.statusCode, res.statusCode < 400 ? 1 : 0, Date.now()-start, req.ip);
      }
    } catch(_) {}
    return origEnd(...args);
  };
  next();
});

// ── 管理端：API 调用日志 ──
router.get('/admin/api-call-logs', requireAdmin(2), (req, res) => {
  const { direction, limit = 100 } = req.query;
  const where = direction ? 'WHERE direction=?' : '';
  const params = direction ? [direction, parseInt(limit)] : [parseInt(limit)];
  const logs  = db.prepare(`SELECT * FROM api_call_logs ${where} ORDER BY created_at DESC LIMIT ?`).all(...params);
  const stats = db.prepare("SELECT direction, SUM(success) as ok, COUNT(*)-SUM(success) as fail, COUNT(*) as total FROM api_call_logs GROUP BY direction").all();
  res.json({ success: true, logs, stats });
});

// ── 公开接口：已配置的登录平台（无需鉴权）──
// 登录页据此渲染「账号所属域」下拉框：白名单模式给固定选项，黑名单模式给排除提示
router.get('/public/email-domain-policy', (req, res) => {
  const { mode, list } = emailDomainPolicy();
  res.json({ success: true, mode: list.length ? mode : 'off', domains: list });
});

// ── 水印策略（管理员在系统配置里定，或经开放 API /v1/watermark 改）──
// 显示范围 scope：逗号分隔的页面标识（dashboard=整个控制台 / login / home / apps / shop / account / memo / kyc），或 all。
// 文本模板变量：{name} {uid} {email} {date} {time} {datetime}（登录页无用户，用户类变量解析为空）。
function watermarkPolicy() {
  const e = process.env;
  const on = /^(on|1|true|yes|开|开启|启用|是|y)$/i.test(String(e.WATERMARK_ENABLED || '').trim());
  const clampNum = (v, def, min, max) => {
    const n = parseFloat(v); if (!isFinite(n)) return def;
    return Math.min(max, Math.max(min, n));
  };
  const scope = String(e.WATERMARK_SCOPE || 'dashboard').split(/[，,]/).map(s => s.trim().toLowerCase()).filter(Boolean);
  const color = /^#[0-9a-fA-F]{3,8}$/.test(String(e.WATERMARK_COLOR || '').trim()) ? e.WATERMARK_COLOR.trim() : '#000000';
  return {
    enabled: on,
    scope: scope.length ? scope : ['dashboard'],
    text: String(e.WATERMARK_TEXT || '{name} {uid} {datetime}').slice(0, 200),
    opacity: clampNum(e.WATERMARK_OPACITY, 0.12, 0.01, 1),
    angle: clampNum(e.WATERMARK_ANGLE, -22, -90, 90),
    size: clampNum(e.WATERMARK_SIZE, 14, 8, 48),
    gap: clampNum(e.WATERMARK_GAP, 180, 60, 600),
    color,
  };
}
router.get('/public/watermark', (req, res) => {
  res.json({ success: true, watermark: watermarkPolicy() });
});

router.get('/public/configured-platforms', (req, res) => {
  // 各平台对应的必须环境变量 key
  const platformEnvKeys = {
    wechat:      'WECHAT_APP_ID',
    wecom:       'WECOM_CORP_ID',
    feishu:      'FEISHU_APP_ID',
    dingtalk:    'DINGTALK_CLIENT_ID',
    douyin:      'DOUYIN_CLIENT_KEY',
    kuaishou:    'KUAISHOU_APP_ID',
    xiaohongshu: 'XHS_CLIENT_ID',
    bilibili:    'BILIBILI_CLIENT_ID',
    google:      'GOOGLE_CLIENT_ID',
    apple:       'APPLE_CLIENT_ID',
    github:      'GITHUB_CLIENT_ID',
    microsoft:   'MICROSOFT_CLIENT_ID',
    qq:          'QQ_APP_ID',
  };
  const configured = [];
  for (const [platform, envKey] of Object.entries(platformEnvKeys)) {
    // 先查数据库，再查进程环境变量
    const row = env.get.get(envKey);
    const val = row?.value || process.env[envKey];
    if (val && val.trim()) configured.push(platform);
  }
  // 登录页在一个都没配置时兜底显示微信+企业微信；?raw=1（如账号绑定页）不兜底，只给真实配置的
  if (configured.length === 0 && !req.query.raw) configured.push('wechat', 'wecom');
  res.json({ success: true, platforms: configured });
});

// ══════════════════════════════════════════
// 三方登录「登录方式」列表（多主体）——登录页 / 账号绑定页用
// 每个渠道可有：环境变量配的「默认主体」(instance_id=null) + 若干数据库额外主体。
// 只下发公开字段（平台、实例 id、主体名、扫码用的 appid/redirect），绝不含 secret。
// ══════════════════════════════════════════
function envConfigured(platform) {
  const meta = OAUTH_META[platform];
  if (!meta) return false;
  const row = env.get.get(meta.primary);
  const val = row?.value || process.env[meta.primary];
  return !!(val && String(val).trim());
}
function instancePublic(platform, inst) {
  const meta = OAUTH_META[platform];
  let cfg = {}; try { cfg = JSON.parse(inst.config || '{}'); } catch (_) {}
  const out = { platform, instance_id: inst.id, label: inst.label || '', enabled: !!inst.enabled };
  if (meta && meta.qr) {   // 扫码渠道：附上公开的 appid/redirect（非 secret）
    out.qr = {};
    for (const [k, field] of Object.entries(meta.qr)) out.qr[k] = cfg[field] || '';
  }
  return out;
}
function defaultPublic(platform) {
  const meta = OAUTH_META[platform];
  const out = { platform, instance_id: null, label: '', enabled: true };
  if (meta && meta.qr) {
    out.qr = {};
    for (const [k, field] of Object.entries(meta.qr)) {
      const row = env.get.get(field);
      out.qr[k] = row?.value || process.env[field] || '';
    }
  }
  return out;
}
router.get('/public/login-methods', (req, res) => {
  const methods = [];
  for (const platform of Object.keys(OAUTH_META)) {
    if (envConfigured(platform)) methods.push(defaultPublic(platform));
    for (const inst of oauthProviders.enabledByPlatform.all(platform)) {
      methods.push(instancePublic(platform, inst));
    }
  }
  // 一个都没配置时，登录页兜底（与 configured-platforms 一致）；?raw=1 不兜底
  if (methods.length === 0 && !req.query.raw) {
    methods.push(defaultPublic('wechat'), defaultPublic('wecom'));
  }
  res.json({ success: true, methods });
});

// org-first 登录（v3.5.17）：登录页「直接登录到某组织」可选项。
// 只列 enabled 且 allow_direct_login=1 的组织，只给 id/name（无任何凭证/成员信息）。
router.get('/public/orgs', (req, res) => {
  let orgs = [];
  try {
    orgs = oauthSubjects.all.all()
      .filter(s => s.enabled && s.allow_direct_login && (s.direct_listed == null ? true : s.direct_listed))  // 仅显性
      .map(s => ({ id: s.id, name: s.name }));
  } catch (_) {}
  res.json({ success: true, orgs });
});

// org-first（v3.5.18）：按组织码查「不显性」组织——登录页输入组织码即可直登未列出的组织（适用于临时）。
router.get('/public/org-by-code', (req, res) => {
  const code = String(req.query.code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: '请输入组织码' });
  let s = null;
  try { s = oauthSubjects.byOrgCode.get(code); } catch (_) {}
  if (!s || !s.enabled || !s.allow_direct_login) return res.status(404).json({ error: '组织码无效或该组织未开放直接登录' });
  res.json({ success: true, org: { id: s.id, name: s.name } });
});

// ══════════════════════════════════════════
// 管理端：三方登录「多主体」CRUD（读 Lv.3，写 Lv.2）
// 每个实例是某平台的一个额外登录主体；secret 字段读取时打码。
// ══════════════════════════════════════════
function maskOauthConfig(platform, cfg) {
  const meta = OAUTH_META[platform];
  const secret = new Set((meta && meta.secret) || []);
  const out = {};
  for (const [k, v] of Object.entries(cfg || {})) {
    out[k] = (secret.has(k) && v) ? '•'.repeat(8) : v;
  }
  return out;
}
function isMaskedVal(v) { return typeof v === 'string' && v.length > 0 && /^•+$/.test(v); }

function oauthPlatformsMeta() {
  return Object.entries(OAUTH_META).map(([k, m]) => ({
    key: k, label: m.label, fields: m.fields, secret: m.secret, env_configured: envConfigured(k),
  }));
}
function credView(r) {
  let cfg = {}; try { cfg = JSON.parse(r.config || '{}'); } catch (_) {}
  return {
    id: r.id, subject_id: r.subject_id, platform: r.platform, label: r.label,
    enabled: !!r.enabled, sort_weight: r.sort_weight, created_at: r.created_at,
    config: maskOauthConfig(r.platform, cfg),
  };
}

// 主体（组织）+ 其下凭证。同一主体下不同凭证登录进来的用户会「同人识别合并」。
router.get('/admin/oauth-subjects', requireAdmin(3), (req, res) => {
  const subjects = oauthSubjects.all.all().map(s => ({
    id: s.id, name: s.name, enabled: !!s.enabled, sort_weight: s.sort_weight,
    // 每主体登录策略
    require_2fa: !!s.require_2fa, ip_allow: s.ip_allow || '', login_start: s.login_start || '', login_end: s.login_end || '',
    // 组织专属凭证（短信/邮件）+ 是否允许直接登录
    msg_config: (() => { try { return s.msg_config ? JSON.parse(s.msg_config) : {}; } catch (_) { return {}; } })(),
    kyc_config: (() => { try { return s.kyc_config ? JSON.parse(s.kyc_config) : {}; } catch (_) { return {}; } })(),
    allow_direct_login: !!s.allow_direct_login,
    members_open: !!s.members_open,
    independent_security: !!s.independent_security,
    require_org_password: !!s.require_org_password,
    deny_code_login: !!s.deny_code_login,
    direct_listed: s.direct_listed == null ? true : !!s.direct_listed,
    org_code: s.allow_direct_login ? ensureOrgCode(s) : (s.org_code || ''),
    // 成员数 / 开放应用数（卡片上直接显示，更直观）
    member_count: orgMembers.countBySubject.get(s.id).n,
    open_app_count: appOrgs.countBySubject.get(s.id).n,
    admin_count: oauthSubjects.admins.all(s.id).length,
    credentials: oauthProviders.bySubject.all(s.id).map(credView),
  }));
  res.json({ success: true, data: subjects, platforms: oauthPlatformsMeta() });
});

router.post('/admin/oauth-subjects', requireAdmin(2), (req, res) => {
  const { name, enabled, sort_weight } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: '请填写主体名称' });
  const id = uuidv4();
  oauthSubjects.insert.run(id, String(name).trim(), enabled === false ? 0 : 1, Number.isFinite(+sort_weight) ? +sort_weight : 0);
  res.json({ success: true, id });
});

router.patch('/admin/oauth-subjects/:id', requireAdmin(2), (req, res) => {
  const row = oauthSubjects.get.get(req.params.id);
  if (!row) return res.status(404).json({ error: '主体不存在' });
  const { name, enabled, sort_weight, require_2fa, ip_allow, login_start, login_end } = req.body || {};
  oauthSubjects.update.run(
    name != null ? String(name).trim() : row.name,
    enabled == null ? row.enabled : (enabled ? 1 : 0),
    Number.isFinite(+sort_weight) ? +sort_weight : row.sort_weight,
    row.id);
  // 登录策略（任一字段传了就整体更新；HH:MM 校验，非法则清空该项）
  if (require_2fa !== undefined || ip_allow !== undefined || login_start !== undefined || login_end !== undefined) {
    const hhmm = v => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.trim())) ? v.trim() : '';
    oauthSubjects.setPolicy.run(
      (require_2fa !== undefined ? (require_2fa ? 1 : 0) : row.require_2fa),
      (ip_allow !== undefined ? String(ip_allow || '').trim() : (row.ip_allow || '')),
      (login_start !== undefined ? hhmm(login_start) : (row.login_start || '')),
      (login_end !== undefined ? hhmm(login_end) : (row.login_end || '')),
      row.id);
  }
  // 组织专属凭证（短信/邮件）+ 是否允许直接登录（v3.5.15）
  if (req.body.msg_config !== undefined) {
    const mc = req.body.msg_config;
    oauthSubjects.setMsgConfig.run(mc && typeof mc === 'object' && Object.keys(mc).length ? JSON.stringify(mc) : null, row.id);
  }
  // 组织专属实名(KYC)凭证（v3.5.16）
  if (req.body.kyc_config !== undefined) {
    const kc = req.body.kyc_config;
    oauthSubjects.setKycConfig.run(kc && typeof kc === 'object' && Object.keys(kc).length ? JSON.stringify(kc) : null, row.id);
  }
  if (req.body.allow_direct_login !== undefined) oauthSubjects.setDirectLogin.run(req.body.allow_direct_login ? 1 : 0, row.id);
  if (req.body.members_open !== undefined) oauthSubjects.setMembersOpen.run(req.body.members_open ? 1 : 0, row.id);   // v3.5.18 成员开放
  if (req.body.independent_security !== undefined) oauthSubjects.setIndependentSecurity.run(req.body.independent_security ? 1 : 0, row.id); // v3.5.20 独立安全
  if (req.body.require_org_password !== undefined || req.body.deny_code_login !== undefined) {   // v3.5.27 组织附加管控
    oauthSubjects.setOrgControls.run(
      req.body.require_org_password !== undefined ? (req.body.require_org_password ? 1 : 0) : (row.require_org_password || 0),
      req.body.deny_code_login !== undefined ? (req.body.deny_code_login ? 1 : 0) : (row.deny_code_login || 0), row.id);
  }
  if (req.body.direct_listed !== undefined) oauthSubjects.setDirectListed.run(req.body.direct_listed ? 1 : 0, row.id); // v3.5.18 登录页是否显性列出
  // 开了直登就确保有组织码（不显性组织靠它被搜索到）
  if (req.body.allow_direct_login) ensureOrgCode(oauthSubjects.get.get(row.id));
  res.json({ success: true });
});

router.delete('/admin/oauth-subjects/:id', requireAdmin(2), (req, res) => {
  const row = oauthSubjects.get.get(req.params.id);
  if (!row) return res.status(404).json({ error: '主体不存在' });
  oauthProviders.removeBySubject.run(row.id);   // 连带删除其下所有凭证（登录入口消失；已绑用户 user_oauth 行保留可查）
  orgMembers.removeBySubject.run(row.id);        // 连带清成员关系
  appOrgs.removeBySubject.run(row.id);           // 连带清应用开放关系
  oauthSubjects.clearAdmins.run(row.id);         // 连带清组织管理员
  oauthSubjects.remove.run(row.id);
  res.json({ success: true });
});

// 兼容/辅助：全部凭证平铺列表
router.get('/admin/oauth-providers', requireAdmin(3), (req, res) => {
  res.json({ success: true, data: oauthProviders.all.all().map(credView), platforms: oauthPlatformsMeta() });
});

// 新增一套凭证到某主体下
router.post('/admin/oauth-providers', requireAdmin(2), (req, res) => {
  const { subject_id, platform, label, config, enabled, sort_weight } = req.body || {};
  const meta = OAUTH_META[platform];
  if (!meta) return res.status(400).json({ error: '未知平台' });
  const subj = subject_id && oauthSubjects.get.get(subject_id);
  if (!subj) return res.status(400).json({ error: '请选择所属主体' });
  const cfg = {};
  for (const f of meta.fields) {
    const v = config?.[f];
    if (v != null && v !== '' && !isMaskedVal(v)) cfg[f] = String(v);
  }
  if (!cfg[meta.primary]) return res.status(400).json({ error: `请填写 ${meta.primary}` });
  const id = uuidv4();
  oauthProviders.insert.run(id, subj.id, platform, String(label || '').trim(), JSON.stringify(cfg),
    enabled === false ? 0 : 1, Number.isFinite(+sort_weight) ? +sort_weight : 0);
  res.json({ success: true, id });
});

router.patch('/admin/oauth-providers/:id', requireAdmin(2), (req, res) => {
  const row = oauthProviders.get.get(req.params.id);
  if (!row) return res.status(404).json({ error: '凭证不存在' });
  const meta = OAUTH_META[row.platform];
  const { label, config, enabled, sort_weight, subject_id } = req.body || {};
  let cur = {}; try { cur = JSON.parse(row.config || '{}'); } catch (_) {}
  if (config && meta) {
    for (const f of meta.fields) {
      if (!(f in config)) continue;
      const v = config[f];
      if (isMaskedVal(v)) continue;                 // 打码串不覆盖
      if (v == null || v === '') { delete cur[f]; } // 清空
      else cur[f] = String(v);
    }
  }
  if (meta && !cur[meta.primary]) return res.status(400).json({ error: `请填写 ${meta.primary}` });
  oauthProviders.update.run(
    label != null ? String(label).trim() : row.label,
    JSON.stringify(cur),
    enabled == null ? row.enabled : (enabled ? 1 : 0),
    Number.isFinite(+sort_weight) ? +sort_weight : row.sort_weight,
    row.id);
  // 允许把凭证挪到另一个主体（改变互通归属）
  if (subject_id && subject_id !== row.subject_id && oauthSubjects.get.get(subject_id)) {
    oauthProviders.setSubject.run(subject_id, row.id);
  }
  res.json({ success: true });
});

router.delete('/admin/oauth-providers/:id', requireAdmin(2), (req, res) => {
  const row = oauthProviders.get.get(req.params.id);
  if (!row) return res.status(404).json({ error: '凭证不存在' });
  oauthProviders.remove.run(row.id);
  res.json({ success: true });
});

// ══════════════════════════════════════════
// 组织成员（IAM）——组织=主体。读 Lv.3 / 写 Lv.2
// ══════════════════════════════════════════
// 按组织的 org_uid 规则自动生成一个未占用的组织内标识
function genOrgUid(subject) {
  const prefix = subject.uid_prefix || '';
  const len = Math.min(Math.max(subject.uid_len || 4, 1), 24);
  for (let i = 0; i < 50; i++) {
    oauthSubjects.bumpUidSeq.run(subject.id);
    const seq = oauthSubjects.get.get(subject.id).uid_seq;
    const uid = prefix + String(seq).padStart(len, '0');
    if (!orgMembers.orgUidTaken.get(subject.id, uid, '')) return uid;
  }
  return null;
}

router.get('/admin/orgs', requireAdmin(3), (req, res) => {
  const data = oauthSubjects.all.all().map(s => ({
    id: s.id, name: s.name, enabled: !!s.enabled,
    uid_prefix: s.uid_prefix || '', uid_len: s.uid_len || 4,
    members: orgMembers.countBySubject.get(s.id).n,
  }));
  res.json({ success: true, data });
});

router.get('/admin/orgs/:sid/members', requireAuth, (req, res) => {
  const s = oauthSubjects.get.get(req.params.sid);
  if (!s) return res.status(404).json({ error: '组织不存在' });
  if (!canManageOrg(req, s.id, false)) return res.status(403).json({ error: '无权管理该组织' });
  res.json({ success: true, org: { id: s.id, name: s.name, uid_prefix: s.uid_prefix || '', uid_len: s.uid_len || 4, members_open: !!s.members_open }, members: orgMembers.listBySubject.all(s.id) });
});

// 可复用成员池（v3.5.18）：列出其他「成员开放」组织里的成员，供本组织管理员复用（避免重复建号）。
// 只给脱敏联系方式 + 来源组织名；加入仍走 POST /members（按 UID 复用同一自然人账号）。
router.get('/admin/orgs/:sid/shareable', requireAuth, (req, res) => {
  const s = oauthSubjects.get.get(req.params.sid);
  if (!s) return res.status(404).json({ error: '组织不存在' });
  if (!canManageOrg(req, s.id, false)) return res.status(403).json({ error: '无权管理该组织' });
  const q = String(req.query.q || '').trim().toLowerCase();
  let pool = orgMembers.shareableFor.all(s.id, s.id);
  if (q) {
    pool = pool.filter(u =>
      (u.name || '').toLowerCase().includes(q) ||
      (u.email || '').toLowerCase().includes(q) ||
      (u.phone || '').includes(q) ||
      (u.uid_code || '').toLowerCase().includes(q) ||
      String(u.uid_seq) === q.replace(/^#/, ''));
  }
  const data = pool.map(u => ({
    uid: u.uid_code || String(u.uid_seq),       // 复用时用它作为 account 传回 POST /members
    name: u.name,
    email: maskEmail(u.email),
    phone: maskPhone(u.phone),
    from_orgs: u.from_orgs || '',
  }));
  res.json({ success: true, data });
});

// 加成员：account 支持邮箱/手机/UID/用户名；org_uid 可指定，留空则按规则自动生成
router.post('/admin/orgs/:sid/members', requireAuth, (req, res) => {
  const s = oauthSubjects.get.get(req.params.sid);
  if (!s) return res.status(404).json({ error: '组织不存在' });
  if (!canManageOrg(req, s.id)) return res.status(403).json({ error: '无权管理该组织' });
  const r = resolveUser(String(req.body?.account || '').trim());
  if (r === 'AMBIGUOUS') return res.status(400).json({ error: '账号有重名，请改用邮箱/手机号/UID' });
  if (!r) return res.status(404).json({ error: '用户不存在' });
  if (r.is_public) return res.status(400).json({ error: '公共账号不能作为组织成员' });
  if (orgMembers.get.get(s.id, r.id)) return res.status(400).json({ error: '该用户已是本组织成员' });
  let orgUid = String(req.body?.org_uid || '').trim() || null;
  let source = 'manual';
  if (orgUid) {
    if (orgMembers.orgUidTaken.get(s.id, orgUid, '')) return res.status(400).json({ error: '该组织内 UID 已被占用' });
  } else if (s.uid_prefix || req.body?.auto_uid) {
    orgUid = genOrgUid(s); source = 'auto';
  }
  orgMembers.add.run(s.id, r.id, orgUid, source);
  res.json({ success: true, org_uid: orgUid });
});

router.patch('/admin/orgs/:sid/members/:uid', requireAuth, (req, res) => {
  const s = oauthSubjects.get.get(req.params.sid);
  if (!s) return res.status(404).json({ error: '组织不存在' });
  if (!canManageOrg(req, s.id)) return res.status(403).json({ error: '无权管理该组织' });
  const target = findRealUserByUid(req.params.uid);
  if (!target || !orgMembers.get.get(s.id, target.id)) return res.status(404).json({ error: '成员不存在' });
  const orgUid = String(req.body?.org_uid || '').trim() || null;
  if (orgUid && orgMembers.orgUidTaken.get(s.id, orgUid, target.id)) return res.status(400).json({ error: '该组织内 UID 已被占用' });
  orgMembers.setOrgUid.run(orgUid, s.id, target.id);
  res.json({ success: true });
});

router.delete('/admin/orgs/:sid/members/:uid', requireAuth, (req, res) => {
  if (!canManageOrg(req, req.params.sid)) return res.status(403).json({ error: '无权管理该组织' });
  const target = findRealUserByUid(req.params.uid);
  if (!target) return res.status(404).json({ error: '成员不存在' });
  orgMembers.remove.run(req.params.sid, target.id);
  res.json({ success: true });
});

// 组织自有密码（v3.5.20）：组织管理员给成员设/改组织内登录密码（独立于平台密码）。
router.put('/admin/orgs/:sid/members/:uid/password', requireAuth, async (req, res) => {
  const s = oauthSubjects.get.get(req.params.sid);
  if (!s) return res.status(404).json({ error: '组织不存在' });
  if (!canManageOrg(req, s.id)) return res.status(403).json({ error: '无权管理该组织' });
  const target = findRealUserByUid(req.params.uid);
  if (!target || !orgMembers.get.get(s.id, target.id)) return res.status(404).json({ error: '成员不存在' });
  const pw = String(req.body?.password || '');
  if (pw.length < 6) return res.status(400).json({ error: '组织密码至少 6 位' });
  const hash = await bcrypt.hash(pw, 12);
  orgMembers.setPassword.run(hash, s.id, target.id);
  audit('org.member_password_set', { subject: target.uid_seq, actor: actorOf(req), detail: { org: s.name } });
  res.json({ success: true });
});
// 清除组织自有密码（成员回退到平台密码登录，前提是组织非独立安全）
router.delete('/admin/orgs/:sid/members/:uid/password', requireAuth, (req, res) => {
  const s = oauthSubjects.get.get(req.params.sid);
  if (!s) return res.status(404).json({ error: '组织不存在' });
  if (!canManageOrg(req, s.id)) return res.status(403).json({ error: '无权管理该组织' });
  const target = findRealUserByUid(req.params.uid);
  if (!target || !orgMembers.get.get(s.id, target.id)) return res.status(404).json({ error: '成员不存在' });
  orgMembers.setPassword.run(null, s.id, target.id);
  audit('org.member_password_cleared', { subject: target.uid_seq, actor: actorOf(req), detail: { org: s.name } });
  res.json({ success: true });
});

// 组织内 UID 自动生成规则
router.patch('/admin/orgs/:sid/uid-rule', requireAuth, (req, res) => {
  const s = oauthSubjects.get.get(req.params.sid);
  if (!s) return res.status(404).json({ error: '组织不存在' });
  if (!canManageOrg(req, s.id)) return res.status(403).json({ error: '无权管理该组织' });
  const prefix = String(req.body?.uid_prefix || '').slice(0, 16);
  const len = Math.min(Math.max(parseInt(req.body?.uid_len) || 4, 1), 24);
  oauthSubjects.setUidRule.run(prefix, len, s.id);
  res.json({ success: true });
});

// 组织管理员（v3.5.8）：系统管理员指定，从该组织成员里选。套用「分组管理员」的概念。
router.get('/admin/orgs/:sid/admins', requireAdmin(3), (req, res) => {
  if (!oauthSubjects.get.get(req.params.sid)) return res.status(404).json({ error: '组织不存在' });
  const ids = oauthSubjects.admins.all(req.params.sid).map(r => r.user_id);
  res.json({ success: true, admin_ids: ids });
});
router.put('/admin/orgs/:sid/admins', requireAdmin(2), (req, res) => {
  const s = oauthSubjects.get.get(req.params.sid);
  if (!s) return res.status(404).json({ error: '组织不存在' });
  const wanted = Array.isArray(req.body?.user_ids) ? req.body.user_ids.map(String) : [];
  db.transaction(() => {
    oauthSubjects.clearAdmins.run(s.id);
    for (const uid of wanted) {
      // 只接受「本组织成员」为管理员
      if (orgMembers.get.get(s.id, uid)) oauthSubjects.addAdmin.run(s.id, uid);
    }
  })();
  res.json({ success: true });
});

// 我管理的组织（真实用户视角）：组织管理员在用户端管理自己组织的成员
router.get('/account/managed-orgs', requireAuth, (req, res) => {
  // 系统管理员看全部组织；否则看自己是组织管理员的
  const list = isSysAdmin(req, 3) ? oauthSubjects.all.all() : myManagedOrgs(req);
  res.json({ success: true, orgs: list.map(s => ({
    id: s.id, name: s.name, uid_prefix: s.uid_prefix || '', uid_len: s.uid_len || 4,
    members: orgMembers.listBySubject.all(s.id),
  })) });
});

// 应用「开放给哪些组织」——空 = 全局（通用）应用
router.get('/admin/apps/:id/orgs', requireAdmin(3), (req, res) => {
  res.json({ success: true, subject_ids: appOrgs.forApp.all(req.params.id).map(r => r.subject_id) });
});
router.put('/admin/apps/:id/orgs', requireAdmin(2), (req, res) => {
  const app = apps.findById.get(req.params.id);
  if (!app) return res.status(404).json({ error: '应用不存在' });
  const ids = Array.isArray(req.body?.subject_ids) ? req.body.subject_ids : [];
  db.transaction(() => {
    appOrgs.clearApp.run(app.id);
    for (const sid of ids) { if (oauthSubjects.get.get(sid)) appOrgs.add.run(app.id, sid); }
  })();
  res.json({ success: true });
});

// 反向视角：某登录主体「开放了哪些应用」——从主体侧管理更直观
router.get('/admin/orgs/:sid/apps', requireAuth, (req, res) => {
  if (!oauthSubjects.get.get(req.params.sid)) return res.status(404).json({ error: '主体不存在' });
  if (!canManageOrg(req, req.params.sid, false)) return res.status(403).json({ error: '无权管理该组织' });
  const list = apps.findEnabled.all().map(a => ({
    id: a.id, name: a.name,
    open: !!appOrgs.openToSubject.get(a.id, req.params.sid),
    global: !appOrgs.isRestricted.get(a.id),   // 该应用当前是否全局（无任何组织限制）
  }));
  res.json({ success: true, apps: list });
});
router.put('/admin/orgs/:sid/apps', requireAuth, (req, res) => {
  const sid = req.params.sid;
  if (!oauthSubjects.get.get(sid)) return res.status(404).json({ error: '主体不存在' });
  if (!canManageOrg(req, sid)) return res.status(403).json({ error: '无权管理该组织' });
  const ids = new Set(Array.isArray(req.body?.app_ids) ? req.body.app_ids : []);
  db.transaction(() => {
    for (const a of apps.findEnabled.all()) {
      if (ids.has(a.id)) appOrgs.add.run(a.id, sid);
      else appOrgs.removeOne.run(a.id, sid);
    }
  })();
  res.json({ success: true });
});

// 用户端：我所属的组织（含组织内 UID）
router.get('/user/orgs', requireAuth, (req, res) => {
  res.json({ success: true, orgs: orgMembers.ofUser.all(req.user.uid) });
});

// ══════════════════════════════════════════
// 备忘录（个人；可标签/转交/带图片·文件·链接附件）
// ══════════════════════════════════════════
const MEMO_TAGS = t => String(t || '').split(/[，,]/).map(s => s.trim()).filter(Boolean).slice(0, 20).join(',');
function memoView(m, withAtt) {
  const v = { id: m.id, owner_id: m.owner_id, title: m.title, body: m.body,
    tags: m.tags ? m.tags.split(',') : [], created_at: m.created_at, updated_at: m.updated_at,
    attachments: memoAtt.countByMemo.get(m.id).n };
  if (m.owner_name !== undefined) { v.owner_name = m.owner_name; v.owner_uid_seq = m.owner_uid_seq; }
  if (withAtt) v.attachments = memoAtt.byMemo.all(m.id);
  return v;
}
// 备忘录管理权限：哪一级（含）以上的管理员才能查看/管理他人的备忘录。
// 默认仅超级管理员（Lv.1），可用 MEMO_ADMIN_LEVEL 放宽（如 2 = Lv.1/Lv.2）。夹 1~9。
function memoAdminLevel() {
  const n = parseInt(process.env.MEMO_ADMIN_LEVEL, 10);
  return (Number.isInteger(n) && n >= 1 && n <= 9) ? n : 1;
}
function canMemoAdmin(user) {
  return !!user && user.role === 'admin' && (user.adminLevel || 99) <= memoAdminLevel();
}
// 本人可访问自己的；管理员需达到 memoAdminLevel 才能越权访问他人的（noPublic：公共账号无个人备忘录）
function memoOf(req, res) {
  const m = memos.get.get(req.params.id);
  if (!m) { res.status(404).json({ error: '备忘录不存在' }); return null; }
  if (m.owner_id !== req.user.uid && !canMemoAdmin(req.user)) { res.status(403).json({ error: '无权访问该备忘录' }); return null; }
  return m;
}

router.get('/memos', requireAuth, noPublic, (req, res) => {
  const list = memos.byOwner.all(req.user.uid).map(m => memoView(m, false));
  res.json({ success: true, memos: list, link_whitelist: linkWhitelist() });
});
router.get('/memos/:id', requireAuth, noPublic, (req, res) => {
  const m = memoOf(req, res); if (!m) return;
  res.json({ success: true, memo: memoView(m, true) });
});
router.post('/memos', requireAuth, noPublic, (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 200);
  const body = String(req.body?.body || '').slice(0, 20000);
  if (!title && !body) return res.status(400).json({ error: '标题和内容不能都为空' });
  const id = uuidv4();
  memos.insert.run(id, req.user.uid, title, body, MEMO_TAGS(req.body?.tags));
  res.json({ success: true, id });
});
router.patch('/memos/:id', requireAuth, noPublic, (req, res) => {
  const m = memoOf(req, res); if (!m) return;
  memos.update.run(
    req.body?.title != null ? String(req.body.title).trim().slice(0, 200) : m.title,
    req.body?.body != null ? String(req.body.body).slice(0, 20000) : m.body,
    req.body?.tags != null ? MEMO_TAGS(req.body.tags) : m.tags,
    m.id);
  res.json({ success: true });
});
router.delete('/memos/:id', requireAuth, noPublic, (req, res) => {
  const m = memoOf(req, res); if (!m) return;
  memoAtt.removeByMemo.run(m.id);
  memos.remove.run(m.id);
  res.json({ success: true });
});
// 转交给某用户：所有权移交（自己不再拥有，对方收到）
router.post('/memos/:id/transfer', requireAuth, noPublic, (req, res) => {
  const m = memoOf(req, res); if (!m) return;
  const r = resolveUser(String(req.body?.account || '').trim());
  if (r === 'AMBIGUOUS') return res.status(400).json({ error: '账号有重名，请改用邮箱/手机号/UID' });
  if (!r) return res.status(404).json({ error: '目标用户不存在' });
  if (r.is_public) return res.status(400).json({ error: '不能转交给公共账号' });
  if (r.id === m.owner_id) return res.status(400).json({ error: '该备忘录已属于此用户' });
  const from = m.owner_id;
  memos.setOwner.run(r.id, m.id);
  audit('memo.transferred', { subject: r.uid_seq, actor: actorOf(req), detail: { memo: m.id, from_user: from, title: m.title } });
  res.json({ success: true });
});
// 加外部/站内链接（白名单校验）
router.post('/memos/:id/links', requireAuth, noPublic, (req, res) => {
  const m = memoOf(req, res); if (!m) return;
  const url = String(req.body?.url || '').trim();
  const label = String(req.body?.label || '').trim().slice(0, 200);
  if (!isLinkAllowed(url)) return res.status(400).json({ error: '该链接不在允许范围（默认仅放行白名单内网域，站内相对链接除外）' });
  const id = uuidv4();
  memoAtt.insert.run(id, m.id, 'link', label || url, null, 0, url, null);
  res.json({ success: true, id });
});
// 上传图片/文件（原始字节；?filename=）——白名单类型 + magic bytes 双校验
router.post('/memos/:id/attachments', requireAuth, noPublic, express.raw({ type: () => true, limit: 12 * 1024 * 1024 }), (req, res) => {
  const m = memoOf(req, res); if (!m) return;
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  if (!buf || !buf.length) return res.status(400).json({ error: '未收到文件内容' });
  if (buf.length > maxAttachBytes()) return res.status(413).json({ error: `附件超过大小上限（${Math.round(maxAttachBytes() / 1048576)}MB）` });
  const filename = String(req.query.filename || 'file').slice(0, 200).replace(/[\r\n\x00]/g, '');
  const v = validateAttachment(filename, buf);
  if (!v.ok) return res.status(400).json({ error: v.error });
  if (memoAtt.countByMemo.get(m.id).n >= 30) return res.status(400).json({ error: '单条备忘录附件不超过 30 个' });
  const id = uuidv4();
  memoAtt.insert.run(id, m.id, v.kind, filename, v.mime, buf.length, null, buf);
  memos.update.run(m.title, m.body, m.tags, m.id);   // bump updated_at
  res.json({ success: true, id, kind: v.kind, filename, mime: v.mime, size: buf.length });
});
// 取附件内容（图片内联预览；文档强制下载）——owner/admin
router.get('/memos/:id/attachments/:aid', requireAuth, noPublic, (req, res) => {
  const m = memoOf(req, res); if (!m) return;
  const a = memoAtt.get.get(req.params.aid, m.id);
  if (!a || a.kind === 'link' || !a.data) return res.status(404).json({ error: '附件不存在' });
  res.setHeader('Content-Type', a.mime || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // 图片和 PDF 允许内联查看；其余（docx 等）强制下载，防在站内直接执行/渲染
  const inline = a.kind === 'image' || a.mime === 'application/pdf';
  const dispName = encodeURIComponent(a.filename || 'file');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${dispName}`);
  res.send(a.data);
});
router.delete('/memos/:id/attachments/:aid', requireAuth, noPublic, (req, res) => {
  const m = memoOf(req, res); if (!m) return;
  memoAtt.remove.run(req.params.aid, m.id);
  res.json({ success: true });
});

// 管理端：查看全部备忘录。权限按 memoAdminLevel()（默认仅超管 Lv.1），运行时按环境变量动态判定
router.get('/admin/memos', requireAuth, (req, res) => {
  if (!canMemoAdmin(req.user)) return res.status(403).json({ error: `备忘录管理需管理员 Lv.${memoAdminLevel()} 或更高` });
  res.json({ success: true, memos: memos.all.all().map(m => memoView(m, false)) });
});

// 外部通讯录同步：批量把成员 upsert 进某组织（不存在的用户按 email/phone 建号）
function importOrgMembers(subject, rows, opts = {}) {
  const results = [];
  const seen = new Set();
  for (const raw of (Array.isArray(rows) ? rows : [])) {
    const email = String(raw?.email || '').trim();
    const phone = String(raw?.phone || '').trim();
    const name = String(raw?.name || '').trim();
    let orgUid = String(raw?.org_uid || '').trim() || null;
    if (email && !isEmail(email)) { results.push({ email, status: 'error', error: '邮箱格式不正确' }); continue; }
    if (phone && !isPhone(phone)) { results.push({ phone, status: 'error', error: '手机号格式不正确' }); continue; }
    if (!email && !phone) { results.push({ status: 'error', error: '缺少 email 或 phone' }); continue; }
    let user = (email && users.findByEmail.get(email)) || (phone && users.findByPhone.get(phone)) || null;
    if (user && user.is_public) { results.push({ email, phone, status: 'error', error: '命中公共账号，跳过' }); continue; }
    let created = false;
    if (!user) {
      user = users.create({ name: name || (email ? email.split('@')[0] : '用户' + phone.slice(-4)), email: email || null, phone: phone || null });
      created = true;
    } else if (name && !user.name) {
      db.prepare('UPDATE users SET name=? WHERE id=?').run(name, user.id);
    }
    seen.add(user.id);
    if (orgUid && orgMembers.orgUidTaken.get(subject.id, orgUid, user.id)) {
      results.push({ email, phone, uid: user.uid_seq, status: 'error', error: '组织内 UID 冲突' }); continue;
    }
    const existing = orgMembers.get.get(subject.id, user.id);
    if (!existing) {
      if (!orgUid && subject.uid_prefix) orgUid = genOrgUid(subject);
      orgMembers.add.run(subject.id, user.id, orgUid, 'import');
    } else if (orgUid) {
      orgMembers.setOrgUid.run(orgUid, subject.id, user.id);
    }
    results.push({ email, phone, uid: user.uid_seq, org_uid: orgUid || existing?.org_uid || null, status: created ? 'created' : (existing ? 'updated' : 'added') });
  }
  let removed = 0;
  if (opts.removeMissing) {
    // 只清「本次未出现 且 source=import」的成员，不动手动加入的成员
    for (const m of orgMembers.listBySubject.all(subject.id)) {
      if (m.source === 'import' && !seen.has(m.user_id)) { orgMembers.remove.run(subject.id, m.user_id); removed++; }
    }
  }
  return { total: results.length, ok: results.filter(r => r.status !== 'error').length, removed, results };
}

router.post('/admin/orgs/:sid/import', requireAuth, (req, res) => {
  const s = oauthSubjects.get.get(req.params.sid);
  if (!s) return res.status(404).json({ error: '组织不存在' });
  if (!canManageOrg(req, s.id)) return res.status(403).json({ error: '无权管理该组织' });
  const out = importOrgMembers(s, req.body?.members, { removeMissing: req.body?.remove_missing === true });
  audit('org.members_imported', { subject: s.id, actor: actorOf(req), detail: { total: out.total, ok: out.ok, removed: out.removed } });
  res.json({ success: true, ...out });
});

// 开放 API：外部通讯录同步（供 HR / 目录系统程序化对接）
router.post('/v1/orgs/:sid/members/import', requireApiKey('org:sync'), (req, res) => {
  if (req.isSandbox) return res.json({ success: true, total: 2, ok: 2, removed: 0, results: [{ email: 'a@x.com', status: 'created', org_uid: 'EMP0001' }, { email: 'b@x.com', status: 'updated', org_uid: 'EMP0002' }], _sandbox: true });
  const s = oauthSubjects.get.get(req.params.sid);
  if (!s) return res.status(404).json({ error: '组织不存在' });
  const out = importOrgMembers(s, req.body?.members, { removeMissing: req.body?.remove_missing === true });
  audit('org.members_imported', { subject: s.id, actor: actorOf(req), detail: { total: out.total, ok: out.ok, removed: out.removed } });
  res.json({ success: true, ...out });
});

// ══════════════════════════════════════════
// 站点法律文档（服务条款 / 隐私政策）
// ══════════════════════════════════════════
const DOC_KEYS = ['terms', 'privacy'];
const DOC_TITLES = { terms: '服务条款', privacy: '隐私政策' };

// 富文本净化：内容由管理员撰写（可信），但仍要挡住 XSS 向量，防止管理员账号被盗或误操作。
// 规则：去掉 <script>/<style>/<iframe> 等危险标签、所有 on* 事件属性、javascript: 协议。
function sanitizeHtml(html) {
  let s = String(html || '');
  s = s.replace(/<\s*(script|style|iframe|object|embed|link|meta|base)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '');
  s = s.replace(/<\s*(script|style|iframe|object|embed|link|meta|base)\b[^>]*\/?>/gi, '');
  s = s.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');   // onclick= 等
  s = s.replace(/(href|src)\s*=\s*("|')?\s*javascript:[^"'>\s]*/gi, '$1="#"');  // javascript: 协议
  return s;
}

const safeLink = u => (typeof u === 'string' && /^https?:\/\//i.test(u.trim())) ? u.trim().slice(0, 500) : '';

// 公开：登录页点「服务条款/隐私政策」时展示（无需登录）
router.get('/public/document/:key', (req, res) => {
  if (!DOC_KEYS.includes(req.params.key)) return res.status(404).json({ error: '文档不存在' });
  const row = documents.get.get(req.params.key);
  res.json({
    success: true,
    key: req.params.key,
    title: (row && row.title) || DOC_TITLES[req.params.key],
    content: (row && row.content) || '',
    link: (row && row.link) || '',          // 填了外链则前端直接跳外链，不弹富文本
    updated_at: row ? row.updated_at : null,
  });
});

// 管理端：读取两份文档
router.get('/admin/documents', requireAdmin(3), (req, res) => {
  const docs = DOC_KEYS.map(k => {
    const row = documents.get.get(k);
    return { key: k, title: (row && row.title) || DOC_TITLES[k], content: (row && row.content) || '', link: (row && row.link) || '', updated_at: row ? row.updated_at : null };
  });
  res.json({ success: true, documents: docs });
});

// 管理端：保存（净化后落库）
router.put('/admin/documents/:key', requireAdmin(2), (req, res) => {
  const key = req.params.key;
  if (!DOC_KEYS.includes(key)) return res.status(404).json({ error: '文档不存在' });
  const title = (req.body.title || DOC_TITLES[key]).slice(0, 100);
  const content = sanitizeHtml(req.body.content).slice(0, 200000);
  const link = safeLink(req.body.link);
  documents.upsert.run(key, title, content, link);
  res.json({ success: true, document: documents.get.get(key) });
});

// ══════════════════════════════════════════
// 公告
// ══════════════════════════════════════════

// 用户端：待弹出的公告（启用中、且未读或读的是旧版本）
router.get('/user/announcements/pending', requireAuth, (req, res) => {
  const list = announcements.findActive.all().filter(a => {
    const r = announcements.getRead.get(req.user.uid, a.id);
    return !r || r.read_version !== a.updated_at;   // 没读过，或读的是更新前的版本
  });
  res.json({ success: true, announcements: list });
});

// 用户端：标记已读（记下当前版本，之后再更新会重弹）
router.post('/user/announcements/:id/read', requireAuth, (req, res) => {
  const a = announcements.findById.get(req.params.id);
  if (!a) return res.status(404).json({ error: '公告不存在' });
  announcements.markRead.run(req.user.uid, a.id, a.updated_at);
  res.json({ success: true });
});

// 公告邮件群发（best-effort，不阻塞主流程）：发给所有有邮箱的真实用户。返回目标人数。
function broadcastAnnouncementEmail(a) {
  if (!hasMessageHub() || !a) return 0;
  const rows = db.prepare("SELECT email FROM users WHERE email IS NOT NULL AND email!='' AND is_public=0").all();
  const subject = `【公告】${a.title}`;
  const html = `<h2 style="margin:0 0 12px">${a.title}</h2>${a.content || ''}`;
  (async () => {
    for (const r of rows) { try { await sendEmail(r.email, subject, html); } catch (_) {} }
  })();
  return rows.length;
}

// 管理端 CRUD（Lv.2 可管理）
router.get('/admin/announcements', requireAdmin(3), (req, res) => {
  res.json({ success: true, announcements: announcements.findAll.all() });
});
router.post('/admin/announcements', requireAdmin(2), (req, res) => {
  const { title, content = '', level = 'info', active = true, link, send_email } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: '标题必填' });
  const lv = ['info', 'warn', 'urgent'].includes(level) ? level : 'info';
  const id = uuidv4();
  // 内容是富文本 HTML，净化后落库（同法律文档）
  announcements.insert.run({ id, title: title.trim(), content: sanitizeHtml(content), level: lv, active: active ? 1 : 0, link: safeLink(link) });
  const ann = announcements.findById.get(id);
  let emailed = 0;
  if (send_email) emailed = broadcastAnnouncementEmail(ann);
  res.json({ success: true, announcement: ann, emailed, email_configured: hasMessageHub() });
});
router.patch('/admin/announcements/:id', requireAdmin(2), (req, res) => {
  const a = announcements.findById.get(req.params.id);
  if (!a) return res.status(404).json({ error: '公告不存在' });
  const { title, content, level, active, link, send_email } = req.body;
  const lv = ['info', 'warn', 'urgent'].includes(level) ? level : a.level;
  // 更新 updated_at → 已读过的用户会重新弹出（这是"更新后重弹"的机制）
  announcements.update.run({
    id: a.id,
    title: (title ?? a.title).trim() || a.title,
    content: content !== undefined ? sanitizeHtml(content) : a.content,
    level: lv,
    active: active !== undefined ? (active ? 1 : 0) : a.active,
    link: link !== undefined ? safeLink(link) : (a.link || ''),
  });
  const ann = announcements.findById.get(a.id);
  let emailed = 0;
  if (send_email) emailed = broadcastAnnouncementEmail(ann);
  res.json({ success: true, announcement: ann, emailed, email_configured: hasMessageHub() });
});

// 管理端：对已有公告单独触发邮件群发
router.post('/admin/announcements/:id/email', requireAdmin(2), (req, res) => {
  const a = announcements.findById.get(req.params.id);
  if (!a) return res.status(404).json({ error: '公告不存在' });
  if (!hasMessageHub()) return res.status(400).json({ error: '消息分发中心未配置，无法群发邮件' });
  const emailed = broadcastAnnouncementEmail(a);
  res.json({ success: true, emailed });
});
router.delete('/admin/announcements/:id', requireAdmin(2), (req, res) => {
  announcements.clearReads.run(req.params.id);
  announcements.remove.run(req.params.id);
  res.json({ success: true });
});

router.get('/user/me', requireAuth, (req, res) => {
  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const oauthBinds = oauth.findByUser.all(user.id);
  res.json({ success: true, user: { ...safeUser(user), oauthBinds }, memo_admin_level: memoAdminLevel() });
});

router.post('/user/profile', requireAuth, noPublic, (req, res) => {
  const { name, phone, timezone } = req.body;
  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (phone && phone !== user.phone && users.findByPhone.get(phone)) return res.status(400).json({ error: '该手机号已被占用' });
  const updates = [];
  const vals = [];
  if (name)     { updates.push("name=?");     vals.push(name); }
  if (phone)    { updates.push("phone=?");    vals.push(phone); }
  if (timezone) { updates.push("timezone=?"); vals.push(timezone); }
  if (updates.length) {
    vals.push(user.id);
    db.prepare(`UPDATE users SET ${updates.join(',')},updated_at=datetime('now') WHERE id=?`).run(...vals);
  }
  res.json({ success: true });
});

// ── 修改绑定的邮箱 / 手机号：验证「新地址」的所有权（发码到新地址 → 确认）──
router.post('/user/contact/send-code', requireAuth, noPublic, async (req, res) => {
  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const type  = req.body?.type;
  const value = String(req.body?.value || '').trim();
  if (type === 'email') {
    if (!isEmail(value)) return res.status(400).json({ error: '邮箱格式不正确' });
    const domainErr = checkEmailDomain(value);
    if (domainErr) return res.status(403).json({ error: domainErr });
    if (value === user.email) return res.status(400).json({ error: '与当前邮箱相同' });
    const occ = users.findByEmail.get(value);
    if (occ && occ.id !== user.id) return res.status(400).json({ error: '该邮箱已被其他账号占用' });
  } else if (type === 'phone') {
    if (!isPhone(value)) return res.status(400).json({ error: '手机号格式不正确' });
    if (value === user.phone) return res.status(400).json({ error: '与当前手机号相同' });
    const occ = users.findByPhone.get(value);
    if (occ && occ.id !== user.id) return res.status(400).json({ error: '该手机号已被其他账号占用' });
  } else {
    return res.status(400).json({ error: 'type 必须是 email 或 phone' });
  }
  const code = genCode();
  const expire = parseInt((type === 'email' ? process.env.EMAIL_CODE_EXPIRE : process.env.SMS_CODE_EXPIRE) || (type === 'email' ? '600' : '300'));
  otp.clean.run(Date.now());
  otp.set.run(`chg:${type}:${user.id}:${value}`, code, Date.now() + expire * 1000);  // 绑定到「用户+新值」，防串用
  const has = hasMessageHub();
  if (has) {
    try { type === 'email' ? await sendEmailCode(value, code) : await sendSmsCode(value, code); }
    catch (e) { return res.status(500).json({ error: `验证码发送失败：${e.message}` }); }
  } else {
    console.log(`[DEV CHG] ${type} → ${value} : ${code}（未配置分发中心，仅打印）`);
  }
  res.json({ success: true, expires: expire, dev: !has });
});

router.post('/user/contact/verify', requireAuth, noPublic, (req, res) => {
  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const type  = req.body?.type;
  const value = String(req.body?.value || '').trim();
  const code  = String(req.body?.code || '').trim();
  if (type !== 'email' && type !== 'phone') return res.status(400).json({ error: 'type 无效' });
  const key = `chg:${type}:${user.id}:${value}`;
  const rec = otp.get.get(key);
  if (!rec) return res.status(400).json({ error: '验证码不存在或已过期，请重新获取' });
  if (rec.expire_at < Date.now()) { otp.del.run(key); return res.status(400).json({ error: '验证码已过期，请重新获取' }); }
  if (rec.attempts >= 5)          { otp.del.run(key); return res.status(400).json({ error: '错误次数过多，请重新获取' }); }
  if (rec.code !== code)          { otp.incAtt.run(key); return res.status(400).json({ error: '验证码错误' }); }
  otp.del.run(key);
  // 提交前再查一次占用（防并发抢注）
  const occ = type === 'email' ? users.findByEmail.get(value) : users.findByPhone.get(value);
  if (occ && occ.id !== user.id) return res.status(400).json({ error: `该${type === 'email' ? '邮箱' : '手机号'}已被占用` });
  db.prepare(`UPDATE users SET ${type}=?, updated_at=datetime('now') WHERE id=?`).run(value, user.id);
  res.json({ success: true, [type]: value });
});

// ── 已登录用户：发送验证码（用于重置密码等场景）──
router.post('/user/send-otp', requireAuth, async (req, res) => {
  const { via } = req.body; // 'email' | 'sms'
  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  const target = via === 'email' ? user.email : user.phone;
  if (!target) return res.status(400).json({ error: `账号未绑定${via === 'email' ? '邮箱' : '手机'}` });

  const code   = genCode();
  const expire = parseInt(process.env[via === 'email' ? 'EMAIL_CODE_EXPIRE' : 'SMS_CODE_EXPIRE'] || (via === 'email' ? '600' : '300'));
  otp.set.run(`${via}:${target}`, code, Date.now() + expire * 1000);

  if (hasMessageHub()) {
    try {
      if (via === 'email') await sendEmailCode(target, code);
      else                 await sendSmsCode(target, code);
    } catch (e) {
      return res.status(500).json({ error: `${via === 'email' ? '邮件' : '短信'}发送失败：${e.message}` });
    }
  } else {
    console.log(`[DEV ${via === 'email' ? 'EMAIL' : 'SMS'} OTP] ${target} → ${code}`);
  }

  res.json({ success: true, expires: expire });
});
router.get('/user/points-history', requireAuth, (req, res) => {
  const logs = db.prepare('SELECT * FROM points_log WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(req.user.uid);
  res.json({ success: true, logs });
});

// ── 用户端：重置密码（邮箱/手机验证码）──
router.post('/user/reset-password', requireAuth, async (req, res) => {
  const { new_password, code, via } = req.body;
  if (!new_password || new_password.length < 8) return res.status(400).json({ error: '新密码至少 8 位' });
  if (!code) return res.status(400).json({ error: '请提供验证码' });
  if (!via || !['email','sms'].includes(via)) return res.status(400).json({ error: '验证方式无效' });

  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  const target = via === 'email' ? user.email : user.phone;
  if (!target) return res.status(400).json({ error: `账号未绑定${via === 'email' ? '邮箱' : '手机'}` });

  const otpKey = `${via}:${target}`;
  const otpRow = db.prepare("SELECT * FROM otp_store WHERE key_name=? AND code=?").get(otpKey, code);
  if (!otpRow) return res.status(400).json({ error: '验证码错误或不存在' });
  if (otpRow.expire_at < Date.now()) {
    otp.del.run(otpKey);
    return res.status(400).json({ error: '验证码已过期，请重新发送' });
  }
  otp.del.run(otpKey);

  const hash = await bcrypt.hash(new_password, 12);
  db.prepare("UPDATE users SET password_hash=?,updated_at=datetime('now') WHERE id=?").run(hash, user.id);
  res.json({ success: true, message: '密码已重置' });
});

// ── 用户端：用户时区设置 ──
router.get('/user/timezone', requireAuth, (req, res) => {
  const user = users.findById.get(req.user.uid);
  res.json({ success: true, timezone: user?.timezone || 'auto' });
});

router.post('/user/checkin', requireAuth, noPublic, (req, res) => {
  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const today = new Date().toISOString().slice(0,10);
  if (user.last_checkin === today) return res.status(400).json({ error: '今日已签到' });
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0,10);
  if (user.last_checkin === yesterday) users.checkin.run(user.id);
  else users.resetStreak.run(user.id);
  const pts = 10;
  users.addPoints.run(pts, user.id);
  points.insert.run(uuidv4(), user.id, pts, '每日签到');
  const updated = users.findById.get(user.id);
  res.json({ success: true, points: pts, streak: updated.checkin_streak, total: updated.points });
});

router.delete('/user/kyc', requireAuth, noPublic, (req, res) => {
  const user = users.findById.get(req.user.uid);
  if (!user || !user.kyc_verified) return res.status(400).json({ error: '未实名认证' });
  users.clearKyc.run(user.id);
  audit('kyc.realname_deleted', { subject: user.uid_seq, actor: actorOf(req) });
  res.json({ success: true });
});

router.delete('/user/oauth/:provider', requireAuth, noPublic, (req, res) => {
  oauth.unbind.run(req.user.uid, req.params.provider);
  res.json({ success: true });
});

// 用户端登录日志的展示窗口与是否允许导出，由两个环境变量控制：
//   LOGINDATE_DAY    展示/导出的天数窗口，默认 30
//   LOGINDATE_EXPORT 是否允许用户导出，off/0/false/no 关闭，默认开
function loginLogConfig() {
  const n = parseInt(process.env.LOGINDATE_DAY, 10);
  const days = Number.isFinite(n) ? Math.max(1, Math.min(3650, n)) : 30;   // 非数字回落 30，0/负数夹到 1
  const raw  = String(process.env.LOGINDATE_EXPORT ?? 'on').trim().toLowerCase();
  const canExport = !['off', '0', 'false', 'no', ''].includes(raw);
  return { days, canExport };
}

router.get('/user/login-logs', requireAuth, (req, res) => {
  const { days, canExport } = loginLogConfig();
  const rows = logs.findByUserRecent.all(req.user.uid, `-${days} days`);
  res.json({ success: true, logs: rows, windowDays: days, canExport });
});

// 导出自己的登录日志为 CSV（在配置窗口内；LOGINDATE_EXPORT 关闭时拒绝）
router.get('/user/login-logs/export', requireAuth, (req, res) => {
  const { days, canExport } = loginLogConfig();
  if (!canExport) return res.status(403).json({ error: '管理员未开放登录日志导出' });
  const rows = logs.findByUserRecent.all(req.user.uid, `-${days} days`);

  const esc = v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = ['时间', '登录方式', '应用', 'IP', '设备', '状态', '失败原因'];
  const lines = rows.map(l => [
    l.created_at, l.method, l.app_name, l.ip, l.user_agent,
    l.status === 'success' ? '成功' : '失败', l.fail_reason,
  ].map(esc).join(','));
  // 前缀 UTF-8 BOM（U+FEFF），Excel 打开中文不乱码
  const csv = '﻿' + [header.join(','), ...lines].join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="my-login-logs-${days}d.csv"`);
  res.send(csv);
});

router.get('/user/points-log', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM points_log WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(req.user.uid);
  res.json({ success: true, logs: rows });
});

// ── 应用市场（用户端）──
router.get('/apps/market', requireAuth, (req, res) => {
  // 只显示：全局(通用)应用 + 开放给「我所属组织」的应用
  let list = apps.findEnabled.all().filter(a => appVisibleToUser(a.id, req.user.uid));
  // 指定了当前组织且我是其成员 → 进一步收窄为「全局应用 + 该组织开放的应用」
  // org-scoped 会话：强制锁定为当前组织，忽略前端传的 org（v3.5.26）
  const orgId = scopedOrgOf(req) || req.query.org;
  if (orgId && orgMembers.get.get(orgId, req.user.uid)) {
    list = list.filter(a => !appOrgs.isRestricted.get(a.id) || appOrgs.openToSubject.get(a.id, orgId));
  }
  res.json({ success: true, apps: list.map(a => ({ ...a, userAuthed: !!apps.isAuthed.get(req.user.uid, a.id) })) });
});
router.post('/apps/:id/auth', requireAuth, (req, res) => {
  const app = apps.findById.get(req.params.id);
  if (!app || app.status !== 'enabled') return res.status(404).json({ error: '应用不存在' });
  if (!appVisibleInSession(app.id, req.user.uid, scopedOrgOf(req))) return res.status(403).json({ error: '该应用未对你所属的组织开放' });
  if (!apps.isAuthed.get(req.user.uid, app.id)) { apps.authUser.run(req.user.uid, app.id); apps.incAuthUsers.run(app.id); }
  res.json({ success: true });
});
router.delete('/apps/:id/auth', requireAuth, (req, res) => {
  const had = apps.isAuthed.get(req.user.uid, req.params.id);
  apps.revokeAuth.run(req.user.uid, req.params.id);
  if (had) apps.decAuthUsers.run(req.params.id);
  // 撤销授权要连带吊销已发出的访问令牌，否则第三方还能继续拿数据
  idp.killTokens.run(req.params.id, req.user.uid);
  db.prepare('UPDATE oauth_auth_codes SET used=1 WHERE app_id=? AND user_id=? AND used=0')
    .run(req.params.id, req.user.uid);
  // 主动推送撤销：让应用停用本地账号（webhook + Back-Channel Logout）
  const app = apps.findById.get(req.params.id);
  deprovisionPush(app, { event: 'authorization.revoked', sub: req.user.uid });
  try { const bcl = require('./provider').backchannelLogout; if (bcl) bcl(app, req.user.uid); } catch (_) {}
  res.json({ success: true });
});
router.get('/apps/authed', requireAuth, (req, res) => {
  res.json({ success: true, apps: apps.getUserApps.all(req.user.uid) });
});

// ── SSO 验证 ──
router.post('/auth/verify', requireAuth, (req, res) => {
  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(401).json({ valid: false });
  res.json({ valid: true, user: safeUser(user) });
});

// ── 管理端 ──
router.get('/admin/stats', requireAdmin(3), (req, res) => {
  const total = users.countAll.get().n;
  const verified = users.countVerified.get().n;
  const todayActive = users.countActive.get().n;
  const newThisMonth = db.prepare("SELECT COUNT(*) as n FROM users WHERE strftime('%Y-%m',created_at)=strftime('%Y-%m','now')").get().n;
  const daily7 = db.prepare("SELECT date(created_at) as d,COUNT(*) as n FROM users WHERE date(created_at)>=date('now','-6 days') GROUP BY d ORDER BY d ASC").all();
  res.json({ success: true, stats: { total, verified, todayActive, newThisMonth, daily7 } });
});

router.get('/admin/users', requireAdmin(3), (req, res) => {
  const { status, q } = req.query;
  let rows;
  if (q) {
    // 支持 UID（纯数字）、昵称、邮箱、手机、组织搜索
    const isUid = /^\d+$/.test(q.trim());
    if (isUid) {
      rows = db.prepare("SELECT * FROM users WHERE is_public=0 AND (uid_seq=? OR name LIKE ? OR email LIKE ? OR phone LIKE ?) ORDER BY uid_seq")
        .all(parseInt(q), `%${q}%`, `%${q}%`, `%${q}%`);
    } else {
      rows = db.prepare("SELECT * FROM users WHERE is_public=0 AND (name LIKE ? OR email LIKE ? OR phone LIKE ? OR organization LIKE ?) ORDER BY uid_seq")
        .all(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
    }
  } else if (status) {
    rows = users.findByStatus.all(status);
  } else {
    rows = users.findAll.all();
  }
  res.json({ success: true, users: rows.map(u => {
    const s = safeUser(u);
    s.group = u.group_id ? groups.get.get(u.group_id) : null;
    s.tags = tags.ofUser.all(u.id);
    return s;
  }) });
});

router.get('/admin/users/:id', requireAdmin(3), (req, res) => {
  const user = users.findById.get(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({ success: true, user: { ...safeUser(user),
    group: user.group_id ? groups.get.get(user.group_id) : null,
    tags: tags.ofUser.all(user.id),
    oauthBinds: oauth.findByUser.all(user.id), apps: apps.getUserApps.all(user.id), loginLogs: logs.findByUser.all(user.id, 10) } });
});

router.patch('/admin/users/:id', requireAdmin(2), (req, res) => {
  const { name, email, phone, status, user_level, admin_level } = req.body;
  db.prepare("UPDATE users SET name=COALESCE(?,name),email=COALESCE(?,email),phone=COALESCE(?,phone),status=COALESCE(?,status),user_level=COALESCE(?,user_level),admin_level=COALESCE(?,admin_level),updated_at=datetime('now') WHERE id=?")
    .run(name,email,phone,status,user_level,admin_level,req.params.id);
  res.json({ success: true });
});

// ── 管理端：新建用户 ──
router.post('/admin/users', requireAdmin(2), async (req, res) => {
  const { name, email, password, phone, role = 'user', user_level = 4 } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: '用户名、邮箱、密码为必填' });
  if (password.length < 8) return res.status(400).json({ error: '密码至少 8 位' });
  const existing = users.findByEmail.get(email);
  if (existing) return res.status(400).json({ error: '该邮箱已被注册' });
  const nameExists = db.prepare('SELECT 1 FROM users WHERE name=?').get(name);
  if (nameExists) return res.status(400).json({ error: '该用户名已存在' });
  const hash = await bcrypt.hash(password, 12);
  const user = users.create({ name, email, phone: phone||null, password_hash: hash, role, admin_level: role==='admin'?2:null, user_level: parseInt(user_level)||4 });
  res.json({ success: true, id: user.id, uid_seq: user.uid_seq, uid_code: user.uid_code });
});

router.post('/admin/users/:id/disable', requireAdmin(2), (req, res) => {
  const target = users.findById.get(req.params.id);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  // 不能停用自己
  if (target.id === req.user.uid) return res.status(403).json({ error: '不能停用自己的账号' });
  // 管理员不能停用同级或更高级别管理员
  const operator = users.findById.get(req.user.uid);
  if (target.role === 'admin' && operator.role === 'admin') {
    if ((target.admin_level || 99) <= (operator.admin_level || 99)) {
      return res.status(403).json({ error: `无法停用同级或更高级别的管理员（对方 Lv.${target.admin_level}）` });
    }
  }
  db.prepare("UPDATE users SET status='disabled',updated_at=datetime('now') WHERE id=?").run(target.id);
  deprovisionUserAllApps(target, 'user.disabled');   // 主动推送停用给其授权应用
  res.json({ success: true });
});
router.post('/admin/users/:id/enable', requireAdmin(2), (req, res) => {
  db.prepare("UPDATE users SET status='active',updated_at=datetime('now') WHERE id=?").run(req.params.id);
  res.json({ success: true });
});
router.post('/admin/users/:id/reset-password', requireAdmin(2), async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: '密码至少6位' });
  users.updatePassword.run(await bcrypt.hash(password, 12), req.params.id);
  res.json({ success: true });
});
router.delete('/admin/users/:id/kyc', requireAdmin(2), (req, res) => {
  users.clearKyc.run(req.params.id);
  const u = users.findById.get(req.params.id);
  audit('kyc.realname_deleted', { subject: u ? u.uid_seq : req.params.id, actor: actorOf(req) });
  res.json({ success: true });
});
router.get('/admin/users/:id/logs', requireAdmin(3), (req, res) => {
  res.json({ success: true, logs: logs.findByUser.all(req.params.id, 50) });
});

// 管理端：审计存证链（列表 + 完整性校验）
router.get('/admin/audit', requireAdmin(3), (req, res) => {
  const { total, data } = auditList(parseInt(req.query.limit) || 50, parseInt(req.query.offset) || 0);
  res.json({ success: true, total, data, integrity: auditVerifyChain() });
});
router.get('/admin/audit/verify', requireAdmin(3), (req, res) => {
  res.json({ success: true, ...auditVerifyChain() });
});

// ══════════════════════════════════════════
// 设备管理（v3.5.21）：登记 + 台账。kind=apple|google|microsoft|access_controller|card_reader。
// 归属：用户 / 组织都可；门禁机/读卡器可关联现有门禁(access_doors)。系统管理员管全部，组织管理员管本组织设备。
// ══════════════════════════════════════════
const DEVICE_KINDS = ['apple', 'google', 'microsoft', 'access_controller', 'card_reader'];
const DEVICE_STATUS = ['active', 'disabled', 'lost'];
function canManageDevice(req, dev, write = true) {
  if (isSysAdmin(req, write ? 2 : 3)) return true;
  const so = scopedOrgOf(req);
  if (so && (!dev || dev.subject_id !== so)) return false;
  return !!(dev && dev.subject_id && oauthSubjects.isAdmin.get(dev.subject_id, req.user.uid));
}
// 把前端传的归属/关联字段解析成落库值（校验组织/门/所有者存在）。返回 {ok, val|error}
function resolveDeviceFields(req, body) {
  const kind = DEVICE_KINDS.includes(body.kind) ? body.kind : 'apple';
  const status = DEVICE_STATUS.includes(body.status) ? body.status : 'active';
  let subject_id = body.subject_id ? String(body.subject_id) : null;
  if (subject_id && !oauthSubjects.get.get(subject_id)) return { error: '所属组织不存在' };
  // 非系统管理员：只能把设备归到自己管理的组织
  if (!isSysAdmin(req, 2)) {
    if (!subject_id || !canManageOrg(req, subject_id)) return { error: '只能把设备归到你管理的组织' };
  }
  let owner_user_id = null;
  if (body.owner && String(body.owner).trim()) {
    const u = resolveUser(String(body.owner).trim());
    if (u === AMBIGUOUS) return { error: '所有者账号有重名，请用邮箱/手机/UID' };
    if (!u) return { error: '所有者账号不存在' };
    owner_user_id = u.id;
  }
  let door_id = body.door_id ? String(body.door_id) : null;
  if (door_id && !access.doorById.get(door_id)) return { error: '关联的门不存在' };
  if (door_id && !['access_controller', 'card_reader'].includes(kind)) door_id = null;  // 只有门禁机/读卡器能关联门
  return { val: {
    name: String(body.name || '').slice(0, 80),
    kind, serial: String(body.serial || '').slice(0, 128),
    owner_user_id, subject_id, door_id, status,
    tags: Array.isArray(body.tags) ? body.tags.join(',') : String(body.tags || ''),
    note: String(body.note || '').slice(0, 500),
  } };
}
// 列表：系统管理员看全部；组织管理员看自己管理组织的设备。附带可归属组织 + 门列表供表单用。
router.get('/admin/devices', requireAuth, (req, res) => {
  const sys = isSysAdmin(req, 3);
  if (!sys && !myManagedOrgs(req).length) return res.status(403).json({ error: '无权管理设备' });
  let list;
  if (sys) list = devices.all.all();
  else {
    const myOrgs = myManagedOrgs(req).map(o => o.id);
    list = myOrgs.length ? devices.bySubjects.all(JSON.stringify(myOrgs)) : [];
  }
  const orgs = sys ? oauthSubjects.all.all().map(s => ({ id: s.id, name: s.name }))
                   : myManagedOrgs(req).map(s => ({ id: s.id, name: s.name }));
  const doors = access.allDoors.all().map(d => ({ id: d.id, name: d.name }));
  res.json({ success: true, devices: list, orgs, doors, kinds: DEVICE_KINDS, can_all: sys });
});
router.post('/admin/devices', requireAuth, (req, res) => {
  const sys = isSysAdmin(req, 2);
  if (!sys && !myManagedOrgs(req).length) return res.status(403).json({ error: '无权管理设备' });
  const r = resolveDeviceFields(req, req.body || {});
  if (r.error) return res.status(400).json({ error: r.error });
  const id = uuidv4();
  devices.insert.run({ id, ...r.val });
  res.json({ success: true, id });
});
router.patch('/admin/devices/:id', requireAuth, (req, res) => {
  const dev = devices.get.get(req.params.id);
  if (!dev) return res.status(404).json({ error: '设备不存在' });
  if (!canManageDevice(req, dev)) return res.status(403).json({ error: '无权管理该设备' });
  const r = resolveDeviceFields(req, { ...dev, ...req.body });
  if (r.error) return res.status(400).json({ error: r.error });
  // 组织管理员不能把设备移出自己管理的组织范围（resolveDeviceFields 已校验目标组织）
  devices.update.run({ id: dev.id, ...r.val });
  res.json({ success: true });
});
router.delete('/admin/devices/:id', requireAuth, (req, res) => {
  const dev = devices.get.get(req.params.id);
  if (!dev) return res.status(404).json({ error: '设备不存在' });
  if (!canManageDevice(req, dev)) return res.status(403).json({ error: '无权管理该设备' });
  devices.remove.run(dev.id);
  res.json({ success: true });
});

// ══════════════════════════════════════════
// 用户分组 / 标签（与等级无关，纯组织维度）
// ══════════════════════════════════════════
const { groups, tags } = require('./db');
const safeColor = c => (typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c.trim())) ? c.trim() : '#888888';

// 分组
router.get('/admin/groups', requireAdmin(3), (req, res) => res.json({ success: true, groups: groups.all.all() }));
router.post('/admin/groups', requireAdmin(2), (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '分组名必填' });
  const id = uuidv4();
  groups.insert.run(id, name.slice(0, 40), safeColor(req.body.color));
  res.json({ success: true, group: groups.get.get(id) });
});
router.patch('/admin/groups/:id', requireAdmin(2), (req, res) => {
  const g = groups.get.get(req.params.id);
  if (!g) return res.status(404).json({ error: '分组不存在' });
  groups.update.run(((req.body.name ?? g.name).trim() || g.name).slice(0, 40), safeColor(req.body.color ?? g.color), g.id);
  res.json({ success: true, group: groups.get.get(g.id) });
});
router.delete('/admin/groups/:id', requireAdmin(2), (req, res) => {
  groups.clearFromUsers.run(req.params.id);   // 组内用户的 group_id 置空
  groups.clearAdmins.run(req.params.id);       // 清掉该分组的分组管理员
  // 连带删除该分组下的公共账号（及其成员/令牌）
  publicAccounts.byGroup.all(req.params.id).forEach(p => {
    publicAccounts.clearMembers.run(p.id);
    db.prepare('DELETE FROM oauth_access_tokens WHERE user_id=?').run(p.id);
    db.prepare('DELETE FROM user_app_auth WHERE user_id=?').run(p.id);
    publicAccounts.remove.run(p.id);
  });
  groups.remove.run(req.params.id);
  res.json({ success: true });
});

// 标签
router.get('/admin/tags', requireAdmin(3), (req, res) => res.json({ success: true, tags: tags.all.all() }));
router.post('/admin/tags', requireAdmin(2), (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '标签名必填' });
  const id = uuidv4();
  tags.insert.run(id, name.slice(0, 40), safeColor(req.body.color));
  res.json({ success: true, tag: tags.get.get(id) });
});
router.patch('/admin/tags/:id', requireAdmin(2), (req, res) => {
  const t = tags.get.get(req.params.id);
  if (!t) return res.status(404).json({ error: '标签不存在' });
  tags.update.run(((req.body.name ?? t.name).trim() || t.name).slice(0, 40), safeColor(req.body.color ?? t.color), t.id);
  res.json({ success: true, tag: tags.get.get(t.id) });
});
router.delete('/admin/tags/:id', requireAdmin(2), (req, res) => {
  tags.removeMap.run(req.params.id);
  tags.remove.run(req.params.id);
  res.json({ success: true });
});

// 给用户分配分组（一个）与标签（多个）
router.put('/admin/users/:id/group', requireAdmin(2), (req, res) => {
  const u = users.findById.get(req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const gid = req.body.group_id || null;
  if (gid && !groups.get.get(gid)) return res.status(400).json({ error: '分组不存在' });
  groups.setUser.run(gid, u.id);
  res.json({ success: true });
});
router.put('/admin/users/:id/tags', requireAdmin(2), (req, res) => {
  const u = users.findById.get(req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const ids = Array.isArray(req.body.tag_ids) ? req.body.tag_ids : [];
  const setTags = db.transaction(list => {
    tags.clearUser.run(u.id);
    list.forEach(tid => { if (tags.get.get(tid)) tags.addToUser.run(u.id, tid); });
  });
  setTags(ids);
  res.json({ success: true });
});

// ── 公共账号（共享账号）：分组管理员 / 系统管理员可管理 ──
const { publicAccounts } = require('./db');
const safePubUser = p => ({ id: p.id, name: p.name, uid_code: p.uid_code || null, uid_seq: p.uid_seq,
  owner_group_id: p.owner_group_id, member_count: p.member_count });

// 系统管理员判定（按等级）
const isSysAdmin = (req, maxLevel = 2) => !req.user.org_scoped && req.user.role === 'admin' && (req.user.adminLevel || 9) <= maxLevel;
// org-scoped 会话（v3.5.26）：组织管理员权限只限当前登录的组织
const scopedOrgOf = req => (req.user && req.user.org_scoped ? req.user.org : null);
function myManagedOrgs(req) {
  const list = oauthSubjects.managedBy.all(req.user.uid);
  const so = scopedOrgOf(req);
  return so ? list.filter(o => o.id === so) : list;
}
// 能否管理某分组：系统管理员 或 该分组的分组管理员
function canManageGroup(req, gid, write = true) {
  if (req.user.org_scoped) return false;           // 分组是平台维度，组织会话不能管
  if (isSysAdmin(req, write ? 2 : 3)) return true;
  return !!groups.isAdmin.get(gid, req.user.uid);
}
// 能否管理某登录主体(组织)：系统管理员 或 该组织的组织管理员（v3.5.8，套用分组管理员）
function canManageOrg(req, sid, write = true) {
  const so = scopedOrgOf(req);
  if (so && sid !== so) return false;              // 组织会话只能管当前组织
  if (isSysAdmin(req, write ? 2 : 3)) return true;
  return !!oauthSubjects.isAdmin.get(sid, req.user.uid);
}

// 某分组下的公共账号列表
router.get('/admin/groups/:gid/public-accounts', requireAuth, (req, res) => {
  if (!groups.get.get(req.params.gid)) return res.status(404).json({ error: '分组不存在' });
  if (!canManageGroup(req, req.params.gid, false)) return res.status(403).json({ error: '无权管理该分组' });
  res.json({ success: true, accounts: publicAccounts.byGroup.all(req.params.gid).map(safePubUser) });
});
// 在分组下建公共账号（本质是一条 is_public=1 的 users 行）
router.post('/admin/groups/:gid/public-accounts', requireAuth, (req, res) => {
  const g = groups.get.get(req.params.gid);
  if (!g) return res.status(404).json({ error: '分组不存在' });
  if (!canManageGroup(req, g.id)) return res.status(403).json({ error: '无权管理该分组' });
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: '公共账号名称必填' });
  const p = users.create({ name, is_public: true, owner_group_id: g.id, group_id: g.id });
  res.json({ success: true, account: safePubUser({ ...p, member_count: 0 }) });
});
// 公共账号详情 + 授权成员
router.get('/admin/public-accounts/:id', requireAuth, (req, res) => {
  const p = publicAccounts.get.get(req.params.id);
  if (!p) return res.status(404).json({ error: '公共账号不存在' });
  if (!canManageGroup(req, p.owner_group_id, false)) return res.status(403).json({ error: '无权管理该公共账号' });
  res.json({ success: true, account: safePubUser({ ...p, member_count: publicAccounts.members.all(p.id).length }),
    member_ids: publicAccounts.members.all(p.id).map(r => r.user_id) });
});
// 设置授权成员（全量覆盖；只收在本分组内的真实用户）
router.put('/admin/public-accounts/:id/members', requireAuth, (req, res) => {
  const p = publicAccounts.get.get(req.params.id);
  if (!p) return res.status(404).json({ error: '公共账号不存在' });
  if (!canManageGroup(req, p.owner_group_id)) return res.status(403).json({ error: '无权管理该公共账号' });
  const ids = Array.isArray(req.body.user_ids) ? req.body.user_ids : [];
  const setM = db.transaction(list => {
    publicAccounts.clearMembers.run(p.id);
    list.forEach(uid => {
      const u = users.findById.get(uid);
      // 只放行真实用户、且当前在该公共账号所属分组内、且不是公共账号本身
      if (u && !u.is_public && u.group_id === p.owner_group_id) publicAccounts.addMember.run(p.id, uid);
    });
  });
  setM(ids);
  res.json({ success: true, member_ids: publicAccounts.members.all(p.id).map(r => r.user_id) });
});
// 删除公共账号（连带清成员 + 吊销其令牌/授权）
router.delete('/admin/public-accounts/:id', requireAuth, (req, res) => {
  const p = publicAccounts.get.get(req.params.id);
  if (!p) return res.status(404).json({ error: '公共账号不存在' });
  if (!canManageGroup(req, p.owner_group_id)) return res.status(403).json({ error: '无权管理该公共账号' });
  publicAccounts.clearMembers.run(p.id);
  db.prepare('DELETE FROM user_app_auth WHERE user_id=?').run(p.id);
  db.prepare('DELETE FROM oauth_access_tokens WHERE user_id=?').run(p.id);
  publicAccounts.remove.run(p.id);
  res.json({ success: true });
});

// ── 分组管理员：系统管理员指定/查看（Lv.2 写、Lv.3 读）──
router.get('/admin/groups/:gid/admins', requireAdmin(3), (req, res) => {
  if (!groups.get.get(req.params.gid)) return res.status(404).json({ error: '分组不存在' });
  res.json({ success: true, admin_ids: groups.admins.all(req.params.gid).map(r => r.user_id) });
});
router.put('/admin/groups/:gid/admins', requireAdmin(2), (req, res) => {
  const g = groups.get.get(req.params.gid);
  if (!g) return res.status(404).json({ error: '分组不存在' });
  const ids = Array.isArray(req.body.user_ids) ? req.body.user_ids : [];
  const setA = db.transaction(list => {
    groups.clearAdmins.run(g.id);
    list.forEach(uid => {
      const u = users.findById.get(uid);
      // 分组管理员必须是本分组内的真实用户
      if (u && !u.is_public && u.group_id === g.id) groups.addAdmin.run(g.id, uid);
    });
  });
  setA(ids);
  res.json({ success: true, admin_ids: groups.admins.all(g.id).map(r => r.user_id) });
});

// ── 用户侧：我管理的分组（分组管理员用，含本组成员，供公共账号成员选择）──
router.get('/account/managed-groups', requireAuth, (req, res) => {
  const me = users.findById.get(req.user.uid);
  if (!me || me.is_public) return res.json({ success: true, groups: [] });
  // 系统管理员看全部分组；分组管理员看自己管的
  const list = isSysAdmin(req, 3) ? groups.all.all() : groups.managedBy.all(me.id);
  res.json({ success: true, groups: list.map(g => ({
    id: g.id, name: g.name, color: g.color,
    members: groups.membersOf.all(g.id).map(u => ({ id: u.id, name: u.name, email: u.email, uid_seq: u.uid_seq, uid_code: u.uid_code || null })),
  })) });
});

// ── 公共账号：用户侧（查看可用 + 切换）──
router.get('/account/public/available', requireAuth, (req, res) => {
  res.json({ success: true, accounts: publicAccounts.availableFor.all(req.user.uid) });
});
// 切换到公共账号：校验授权 + 仍在分组内 → 签发公共账号令牌（前端整会话切换过去）
router.post('/account/public/switch', requireAuth, (req, res) => {
  if (req.user.org_scoped) return res.status(403).json({ error: '组织会话不可切换到公共账号' });
  const me = users.findById.get(req.user.uid);
  if (!me || me.is_public) return res.status(403).json({ error: '当前身份不能切换公共账号' });
  const p = publicAccounts.get.get(req.body.public_id || '');
  if (!p) return res.status(404).json({ error: '公共账号不存在' });
  if (!publicAccounts.isMember.get(p.id, me.id)) return res.status(403).json({ error: '你没有该公共账号的使用权限' });
  if (me.group_id !== p.owner_group_id) return res.status(403).json({ error: '你已不在该公共账号所属分组，无法切换' });
  if (p.status !== 'active') return res.status(403).json({ error: '该公共账号已被停用' });
  const token = signToken({ uid: p.id, name: p.name, role: 'user', pub: true, switchedFrom: me.id, switchedName: me.name });
  res.json({ success: true, token, account: { id: p.id, name: p.name, uid_code: p.uid_code || null, uid_seq: p.uid_seq } });
});

// 应用发起地址只放行 http/https（复用公告那套 safeLink 校验）
const safeLaunchUrl = u => safeLink(u);

// 公共账号仅保留基础功能：挡住商城/积分/转账等经济类接口
function noPublic(req, res, next) {
  const u = users.findById.get(req.user.uid);
  if (u && u.is_public) return res.status(403).json({ error: '公共账号仅支持基础功能（如第三方登录），不能使用商城 / 积分 / 转账' });
  next();
}
// 必传 scope：只放行合法 scope（openid 天然必传，不必显式配），去重后空格分隔
const VALID_SCOPES = ['openid','profile','email','phone','kyc','org'];
const safeRequiredScopes = v => {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[\s,]+/);
  return [...new Set(arr.map(s => s.trim()).filter(s => VALID_SCOPES.includes(s) && s !== 'openid'))].join(' ');
};
router.get('/admin/apps', requireAdmin(3), (req, res) => { res.json({ success: true, apps: apps.findAll.all() }); });
router.post('/admin/apps', requireAdmin(2), (req, res) => {
  const { name, icon='📦', icon_bg='#F0F0F0', description='', callback_url, launch_url='', required_scopes='', visible=false, status } = req.body;
  if (!name || !callback_url) return res.status(400).json({ error: '名称和回调地址必填' });
  // 管理员自建应用时可直接启用；只有第三方通过申请入口提交的才默认待审核。
  // 早期这里写死 'pending'，导致管理员选「直接启用」也不生效，应用一直无法用于 OIDC。
  const initStatus = ['enabled', 'pending', 'disabled'].includes(status) ? status : 'enabled';
  const id = uuidv4();
  const client_id = 'app_' + crypto.randomBytes(6).toString('hex');
  const client_secret = crypto.randomBytes(32).toString('hex');
  apps.insert.run({ id, name, icon, icon_bg, description, client_id, client_secret, callback_url, launch_url: safeLaunchUrl(launch_url), required_scopes: safeRequiredScopes(required_scopes), status: initStatus, visible: visible?1:0 });
  if (req.body.category !== undefined) db.prepare('UPDATE apps SET category=? WHERE id=?').run(String(req.body.category || '').trim(), id);
  if (req.body.deprovision_url !== undefined) db.prepare('UPDATE apps SET deprovision_url=? WHERE id=?').run(safeLaunchUrl(req.body.deprovision_url), id);
  if (req.body.backchannel_logout_uri !== undefined) db.prepare('UPDATE apps SET backchannel_logout_uri=? WHERE id=?').run(safeLaunchUrl(req.body.backchannel_logout_uri), id);
  res.json({ success: true, app: apps.findById.get(id) });
});
// 重新生成 client_secret（密钥泄露时轮换；旧密钥立即失效）
router.post('/admin/apps/:id/regenerate-secret', requireAdmin(2), (req, res) => {
  const app = apps.findById.get(req.params.id);
  if (!app) return res.status(404).json({ error: '应用不存在' });
  const client_secret = crypto.randomBytes(32).toString('hex');
  db.prepare("UPDATE apps SET client_secret=?, updated_at=datetime('now') WHERE id=?").run(client_secret, app.id);
  res.json({ success: true, client_secret });
});
router.patch('/admin/apps/:id', requireAdmin(2), (req, res) => {
  const app = apps.findById.get(req.params.id);
  if (!app) return res.status(404).json({ error: '应用不存在' });
  const { name, icon, icon_bg, description, callback_url, launch_url, required_scopes, status, visible } = req.body;
  apps.update.run({ id: app.id, name:name??app.name, icon:icon??app.icon, icon_bg:icon_bg??app.icon_bg, description:description??app.description, callback_url:callback_url??app.callback_url, launch_url:launch_url!==undefined?safeLaunchUrl(launch_url):(app.launch_url||''), required_scopes:required_scopes!==undefined?safeRequiredScopes(required_scopes):(app.required_scopes||''), status:status??app.status, visible:visible!==undefined?(visible?1:0):app.visible });
  if (req.body.category !== undefined) db.prepare('UPDATE apps SET category=? WHERE id=?').run(String(req.body.category || '').trim(), app.id);
  if (req.body.deprovision_url !== undefined) db.prepare('UPDATE apps SET deprovision_url=? WHERE id=?').run(safeLaunchUrl(req.body.deprovision_url), app.id);
  if (req.body.backchannel_logout_uri !== undefined) db.prepare('UPDATE apps SET backchannel_logout_uri=? WHERE id=?').run(safeLaunchUrl(req.body.backchannel_logout_uri), app.id);
  res.json({ success: true, app: apps.findById.get(app.id) });
});
// 手动把「撤销某用户账号」推给某应用（SSO 主动控制）
router.post('/admin/apps/:id/deprovision', requireAdmin(2), async (req, res) => {
  const app = apps.findById.get(req.params.id);
  if (!app) return res.status(404).json({ error: '应用不存在' });
  if (!app.deprovision_url) return res.status(400).json({ error: '该应用未配置账号撤销回调地址' });
  const u = findRealUserByUid(String(req.body?.uid || '').trim());
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const ok = await deprovisionPush(app, { event: 'account.revoked', sub: u.id, uid: u.uid_seq, uid_code: u.uid_code || null });
  audit('app.deprovision_pushed', { subject: String(u.uid_seq), actor: actorOf(req), detail: { app: app.name, ok } });
  res.json({ success: ok, delivered: ok });
});
router.post('/admin/apps/:id/approve', requireAdmin(2), (req, res) => {
  apps.approve.run(req.params.id); res.json({ success: true });
});

router.post('/admin/apps/:id/reject', requireAdmin(2), (req, res) => {
  const { reason } = req.body;
  db.prepare("UPDATE apps SET status='rejected',updated_at=datetime('now') WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

router.delete('/admin/apps/:id', requireAdmin(2), (req, res) => {
  db.prepare('DELETE FROM user_app_auth WHERE app_id=?').run(req.params.id);
  appIcons.remove.run(req.params.id); appFolders.removeApp.run(req.params.id);   // v3.5.28 图标 / 文件夹连带清
  db.prepare('DELETE FROM apps WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── 应用图片图标（v3.5.28）──
// 上传原始字节（?filename= 带扩展名），只收 png/jpg/gif/webp（复用备忘录的扩展名白名单 + magic bytes 校验；SVG 不收，防 XSS）。
const APP_ICON_MAX = 512 * 1024;
router.post('/admin/apps/:id/icon', requireAdmin(2), express.raw({ type: () => true, limit: 2 * 1024 * 1024 }), (req, res) => {
  const app = apps.findById.get(req.params.id);
  if (!app) return res.status(404).json({ error: '应用不存在' });
  const buf = req.body;
  if (!buf || !buf.length) return res.status(400).json({ error: '空文件' });
  if (buf.length > APP_ICON_MAX) return res.status(413).json({ error: '图标不能超过 512KB' });
  const v = validateAttachment(String(req.query.filename || 'icon.png'), buf);
  if (!v.ok) return res.status(400).json({ error: v.error });
  if (v.kind !== 'image') return res.status(400).json({ error: '图标只接受图片（png/jpg/gif/webp）' });
  appIcons.upsert.run(app.id, v.mime, buf);
  const url = `/api/public/app-icon/${encodeURIComponent(app.id)}?v=${Date.now().toString(36)}`;
  appIcons.setUrl.run(url, app.id);
  res.json({ success: true, icon_url: url });
});
router.delete('/admin/apps/:id/icon', requireAdmin(2), (req, res) => {
  appIcons.remove.run(req.params.id); appIcons.setUrl.run(null, req.params.id);
  res.json({ success: true });
});
// 公开读取（应用图标本就展示在登录过渡页/授权页，不属敏感数据）；带 ?v= 的地址可长缓存
router.get('/public/app-icon/:id', (req, res) => {
  const ic = appIcons.get.get(req.params.id);
  if (!ic) return res.status(404).end();
  res.set('Content-Type', ic.mime);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(ic.data);
});

// ── 我的应用文件夹（v3.5.28，个人整理用；只影响自己的展示，不改可见性/授权）──
router.get('/user/app-folders', requireAuth, (req, res) => {
  const items = appFolders.items.all(req.user.uid);
  const folders = appFolders.list.all(req.user.uid).map(f => ({ ...f, app_ids: items.filter(i => i.folder_id === f.id).map(i => i.app_id) }));
  res.json({ success: true, folders });
});
router.post('/user/app-folders', requireAuth, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 30);
  if (!name) return res.status(400).json({ error: '请填写文件夹名称' });
  if (appFolders.list.all(req.user.uid).length >= 50) return res.status(400).json({ error: '文件夹太多了（上限 50）' });
  const id = uuidv4();
  appFolders.insert.run(id, req.user.uid, name, 0);
  const ids = Array.isArray(req.body?.app_ids) ? req.body.app_ids.map(String).slice(0, 200) : [];
  ids.forEach(a => appFolders.assign.run(req.user.uid, a, id));
  res.json({ success: true, id });
});
router.patch('/user/app-folders/:id', requireAuth, (req, res) => {
  if (!appFolders.get.get(req.params.id, req.user.uid)) return res.status(404).json({ error: '文件夹不存在' });
  const name = String(req.body?.name || '').trim().slice(0, 30);
  if (!name) return res.status(400).json({ error: '请填写文件夹名称' });
  appFolders.rename.run(name, req.params.id, req.user.uid);
  res.json({ success: true });
});
// 删文件夹：里面的应用回到「未归类」，不会被删/取消授权
router.delete('/user/app-folders/:id', requireAuth, (req, res) => {
  appFolders.clearFolder.run(req.params.id, req.user.uid);
  appFolders.remove.run(req.params.id, req.user.uid);
  res.json({ success: true });
});
// 把某应用放进某文件夹（folder_id 为空 = 移出到未归类）
router.put('/user/app-folders/assign', requireAuth, (req, res) => {
  const appId = String(req.body?.app_id || '');
  if (!appId) return res.status(400).json({ error: '缺少 app_id' });
  const fid = req.body?.folder_id ? String(req.body.folder_id) : '';
  if (!fid) { appFolders.unassign.run(req.user.uid, appId); return res.json({ success: true }); }
  if (!appFolders.get.get(fid, req.user.uid)) return res.status(404).json({ error: '文件夹不存在' });
  appFolders.assign.run(req.user.uid, appId, fid);
  res.json({ success: true });
});

router.get('/admin/logs', requireAdmin(3), (req, res) => { res.json({ success: true, logs: logs.findAll.all() }); });

router.get('/admin/api-keys', requireAdmin(1), (req, res) => { res.json({ success: true, keys: apiKeys.findAll.all() }); });
router.post('/admin/api-keys', requireAdmin(1), (req, res) => {
  const { name, scopes = [], key_type = 'live', trusted_ips = '' } = req.body;
  if (!name) return res.status(400).json({ error: '密钥名称必填' });

  const prefix = key_type === 'test' ? 'sk_test_' : 'sk_live_';
  const token  = prefix + crypto.randomBytes(20).toString('hex');
  const hash   = crypto.createHash('sha256').update(token).digest('hex');
  const id     = uuidv4();

  const ips = key_type === 'test' ? '*' : (trusted_ips?.trim() || '');
  // 测试密钥明文保存供随时查看；实际密钥只存哈希，绝不明文落库
  const plain = key_type === 'test' ? token : null;

  db.prepare("INSERT INTO api_keys (id,name,token_hash,token_prefix,scopes,status,created_by,key_type,trusted_ips,token_plain) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, name, hash, token.slice(0, key_type === 'test' ? 15 : 18), JSON.stringify(scopes), 'active', req.user.uid, key_type, ips, plain);

  res.json({ success: true, token, key_type });
});

router.patch('/admin/api-keys/:id/trusted-ips', requireAdmin(1), (req, res) => {
  const { trusted_ips } = req.body;
  db.prepare("UPDATE api_keys SET trusted_ips=? WHERE id=?").run(trusted_ips?.trim() || '', req.params.id);
  res.json({ success: true });
});

// 撤销密钥（软删除，历史永久保留，无论测试或实际密钥）
router.delete('/admin/api-keys/:id', requireAdmin(1), (req, res) => {
  const key = db.prepare("SELECT * FROM api_keys WHERE id=?").get(req.params.id);
  if (!key) return res.status(404).json({ error: '密钥不存在' });
  apiKeys.revoke.run(req.params.id);
  res.json({ success: true });
});

router.get('/admin/env', requireAdmin(1), (req, res) => {
  const rows = env.getAll.all(); const map = {};
  rows.forEach(r => { map[r.key_name] = r.value; });
  // 同时返回 env 和 vars 两个 key，兼容不同前端调用
  res.json({ success: true, env: map, vars: map });
});
router.post('/admin/env', requireAdmin(1), (req, res) => {
  const { vars } = req.body;
  if (!vars || typeof vars !== 'object') return res.status(400).json({ error: '参数错误' });

  // 兜底防护：前端 secret 字段未展开时显示的是一串圆点（U+2022），
  // 历史上曾因直接提交输入框内容而把已存密钥整体覆盖成圆点。
  // 圆点串不可能是任何真实配置值，一律拒绝写入。
  const skipped = [];
  Object.entries(vars).forEach(([k, v]) => {
    const val = String(v ?? '');
    if (val.length && /^[•]+$/.test(val)) { skipped.push(k); return; }

    env.set.run(k, val);
    // 同步到当前进程环境变量，立即生效（无需重启）
    if (val.trim()) process.env[k] = val;
  });

  if (skipped.length) console.warn(`[ENV] 已忽略 ${skipped.length} 个打码占位值：${skipped.join(', ')}`);
  res.json({
    success: true,
    message: '环境变量已保存并立即生效',
    ...(skipped.length ? { skipped } : {}),
  });
});

// ── 开放 API（第三方 API Key 调用）──
// ── 沙盒 mock 数据（测试密钥调用返回，不暴露真实数据）──
const SANDBOX = {
  user: (uid) => ({
    id: 'sandbox-user-id', uid_seq: parseInt(uid) || 142, name: '沙盒测试用户',
    email: 'sandbox@example.com', phone: '138****0000', role: 'user',
    user_level: 3, level_tag: 'U3', points: 1000, status: 'active',
    kyc_verified: 0, created_at: '2026-01-01 00:00:00', _sandbox: true,
  }),
  users: () => ({ total: 3, page: 1, _sandbox: true, data: [
    { id:'sb-1', uid_seq:1, name:'沙盒用户A', role:'user',  user_level:3, level_tag:'U3', status:'active', _sandbox:true },
    { id:'sb-2', uid_seq:2, name:'沙盒用户B', role:'user',  user_level:5, level_tag:'U5', status:'active', _sandbox:true },
    { id:'sb-3', uid_seq:3, name:'沙盒管理员', role:'admin', admin_level:1, level_tag:'A1', status:'active', _sandbox:true },
  ]}),
  apps: () => ({ total: 1, _sandbox: true, data: [{ id:'sb-app', name:'沙盒应用', status:'enabled', _sandbox:true }] }),
  logs: () => ({ total: 2, _sandbox: true, data: [
    { id:'sb-log1', user_name:'沙盒用户A', method:'邮箱密码', status:'success', created_at:'2026-01-01 10:00:00' },
    { id:'sb-log2', user_name:'沙盒用户B', method:'微信扫码', status:'success', created_at:'2026-01-01 11:00:00' },
  ]}),
  doors: () => ({ total: 1, _sandbox: true, data: [
    { id:'sb-door', name:'沙盒大门', location:'一楼大厅', status:'enabled', _sandbox:true },
  ]}),
  accessVerify: () => ({ allow: true, result: 'allow', reason: 'ok', reason_text: '放行',
    user: { uid_seq: 142, name: '沙盒测试用户' }, door: { id: 'sb-door', name: '沙盒大门' }, _sandbox: true }),
  accessLogs: () => ({ total: 1, _sandbox: true, data: [
    { id:'sb-acc1', door_name:'沙盒大门', user_name:'沙盒用户A', method:'qr', result:'allow', reason:'ok', created_at:'2026-01-01 10:00:00' },
  ]}),
};

router.get('/v1/auth/verify', requireApiKey('auth:verify'), (req, res) => {
  if (req.isSandbox) return res.json({ valid: true, user: SANDBOX.user('142'), _sandbox: true });
  const token = req.headers['x-user-token'];
  if (!token) return res.status(400).json({ error: 'x-user-token 请求头缺失' });
  const { verifyToken } = require('./auth');
  const { valid, data } = verifyToken(token);
  if (!valid) return res.status(401).json({ valid: false });
  const user = users.findById.get(data.uid);
  if (!user) return res.status(401).json({ valid: false });
  res.json({ valid: true, user: levelTagUser(user) });
});
router.get('/v1/users', requireApiKey('users:read'), (req, res) => {
  if (req.isSandbox) return res.json(SANDBOX.users());
  const { status, page=1, limit=20, level_tag } = req.query;
  const lim = Math.min(Math.max(parseInt(limit) || 20, 1), 100);
  const off = (Math.max(parseInt(page) || 1, 1) - 1) * lim;
  // 动态 WHERE：公共账号一律排除（is_public=1 是共享身份不是自然人）；筛选下沉进 SQL，
  // 保证「分页结果」与「total」都对得上 level_tag / status（此前 level_tag 是分页后过滤，跨页会漏、total 也不含筛选）
  const where = ['is_public=0'];
  const args = [];
  if (status) { where.push('status=?'); args.push(status); }
  if (level_tag) {
    const m = String(level_tag).toUpperCase().match(/^([UA])(\d)$/);
    if (m) {
      const [, t, lv] = m;
      if (t === 'A') { where.push("role='admin' AND admin_level=?"); args.push(parseInt(lv)); }
      else           { where.push("role!='admin' AND user_level=?"); args.push(parseInt(lv)); }
    } else {
      return res.status(400).json({ error: 'level_tag 格式应为 U1~U9 / A1~A9' });
    }
  }
  const whereSql = 'WHERE ' + where.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) n FROM users ${whereSql}`).get(...args).n;
  const rows  = db.prepare(`SELECT * FROM users ${whereSql} ORDER BY uid_seq LIMIT ? OFFSET ?`).all(...args, lim, off);
  res.json({ total, page: parseInt(page) || 1, data: rows.map(levelTagUser) });
});
router.get('/v1/users/:uid', requireApiKey('users:read'), (req, res) => {
  if (req.isSandbox) return res.json(SANDBOX.user(req.params.uid));
  const user = db.prepare('SELECT * FROM users WHERE (uid_seq=? OR id=? OR uid_code=?) AND is_public=0').get(req.params.uid, req.params.uid, req.params.uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json(levelTagUser(user));
});
router.post('/v1/users/:uid/disable', requireApiKey('users:write'), (req, res) => {
  if (req.isSandbox) return res.json({ success: true, _sandbox: true });
  db.prepare("UPDATE users SET status='disabled' WHERE uid_seq=? OR id=?").run(req.params.uid,req.params.uid);
  audit('user.disabled', { subject: req.params.uid, actor: actorOf(req) });
  const du = findRealUserByUid(req.params.uid); if (du) deprovisionUserAllApps(du, 'user.disabled');
  res.json({ success: true });
});
router.post('/v1/users/:uid/enable', requireApiKey('users:write'), (req, res) => {
  if (req.isSandbox) return res.json({ success: true, _sandbox: true });
  db.prepare("UPDATE users SET status='active' WHERE uid_seq=? OR id=?").run(req.params.uid,req.params.uid);
  audit('user.enabled', { subject: req.params.uid, actor: actorOf(req) });
  res.json({ success: true });
});
router.delete('/v1/users/:uid/realname', requireApiKey('users:kyc'), (req, res) => {
  if (req.isSandbox) return res.json({ success: true, _sandbox: true });
  db.prepare("UPDATE users SET kyc_verified=0,kyc_name=NULL,kyc_id_tail=NULL,kyc_pseudonym=NULL,kyc_name_hash=NULL WHERE uid_seq=? OR id=?").run(req.params.uid,req.params.uid);
  audit('kyc.realname_deleted', { subject: req.params.uid, actor: actorOf(req) });
  res.json({ success: true });
});

// S-02 · 实名姓名比对（只回布尔，绝不下发原文）。id_no 可选，比对哈希不比对明文。
router.post('/v1/kyc/match', requireApiKey('users:kyc'), (req, res) => {
  if (req.isSandbox) return res.json({ matched: true, _sandbox: true });
  if (!kycPseudonymEnabled()) return res.status(503).json({ error: '服务端未配置 KYC_PSEUDONYM_SECRET，无法进行比对' });
  const { uid, name, id_no } = req.body || {};
  if (!uid || !name) return res.status(400).json({ error: 'uid 和 name 必填' });
  const user = db.prepare('SELECT * FROM users WHERE (uid_seq=? OR id=? OR uid_code=?) AND is_public=0').get(uid, uid, uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (!user.kyc_verified || !user.kyc_name_hash) return res.json({ matched: false, reason: 'not_verified' });
  const nameOk = kycHmac('name', normName(name)) === user.kyc_name_hash;
  let idOk = true;
  if (id_no != null && String(id_no).trim() !== '') {
    idOk = !!user.kyc_pseudonym && kycHmac('pid', 'IDENTITY_CARD|' + normId(id_no)) === user.kyc_pseudonym;
  }
  res.json({ matched: nameOk && idOk });
});

// ── 实名认证开放 API（强实名门禁 / 发起会话 / 二次·多次实名 / 服务端直提核验）──
function kycStatusView(u) {
  return {
    uid: u.uid_seq, verified: !!u.kyc_verified,
    name_masked: u.kyc_name || null, id_tail: u.kyc_id_tail || null,
    provider: u.kyc_provider || null, verified_at: u.kyc_verified_at || null,
    events: kycEvents.countByUser.get(u.id).n,
  };
}

// 查实名状态（供应用做「强实名」门禁判断）
router.get('/v1/users/:uid/kyc', requireApiKey('kyc:read'), (req, res) => {
  if (req.isSandbox) return res.json({ uid: 142, verified: true, name_masked: '张*', id_tail: '1234', provider: '服务商直接认证', verified_at: '2026-01-01 10:00:00', events: 1, _sandbox: true });
  const u = findRealUserByUid(req.params.uid);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  res.json(kycStatusView(u));
});

// 实名认证历史（二次 / 多次实名审计）
router.get('/v1/users/:uid/kyc/events', requireApiKey('kyc:read'), (req, res) => {
  if (req.isSandbox) return res.json({ total: 1, data: [{ id: 'sb', provider: '服务商直接认证', status: 'verified', reverify: 0, source: 'api', created_at: '2026-01-01 10:00:00' }], _sandbox: true });
  const u = findRealUserByUid(req.params.uid);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  res.json({ total: kycEvents.countByUser.get(u.id).n, data: kycEvents.byUser.all(u.id) });
});

// 发起实名会话：返回让用户去人脸核身的跳转 URL（走 5 服务商轮询）。
// reverify=true 时对已实名用户也放行（二次/多次实名，如敏感操作前的新鲜核身）。
router.post('/v1/users/:uid/kyc/session', requireApiKey('kyc:session'), async (req, res) => {
  if (req.isSandbox) return res.json({ success: true, provider: 'didit', redirect_url: 'https://verify.example/sandbox', session_id: 'sb_sess', _sandbox: true });
  const u = findRealUserByUid(req.params.uid);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const reverify = req.body?.reverify === true || req.body?.reverify === 'true' || req.body?.reverify === 1;
  if (u.kyc_verified && !reverify) return res.status(400).json({ error: '用户已完成实名认证（如需重新核验请传 reverify:true）' });
  const name = (req.body?.name || '').trim();
  const idNumber = (req.body?.id_number || '').trim();
  try {
    const callbackUrl = `${process.env.BASE_URL || ''}/auth/kyc/callback?user_id=${u.id}`;
    // 组织专属 KYC 凭证：显式传 org（主体 id）优先，否则按该用户所属组织
    const orgKyc = req.body?.org ? subjectKycCfg(req.body.org) : userKycCfg(u);
    const { result } = await createKycSession(u.id, callbackUrl, { name, idNumber, orgKyc });
    // pending：alipay 需回跳后查询落库；reverify 需让完成点（webhook/callback）放行并记事件
    if (result.provider === 'alipay' && name && idNumber) {
      const h = identityHashes(name, idNumber);
      kycPending.set.run(u.id, 'alipay', result.session_id, name, idNumber.slice(-4), h.pseudonym, h.nameHash, reverify ? 1 : 0, 'api');
      if (req.body?.org) kycPending.setOrg.run(req.body.org, u.id);   // 回调查询用同一组织凭证
    } else if (reverify) {
      kycPending.set.run(u.id, result.provider || '', result.session_id || '', '', '', null, null, 1, 'api');
    }
    audit(reverify ? 'kyc.reverify_requested' : 'kyc.session_started', { subject: u.uid_seq, actor: actorOf(req), detail: { provider: result.provider } });
    res.json({ success: true, provider: result.provider, redirect_url: result.redirect_url, session_id: result.session_id, reverify });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 服务端直提核验（姓名+身份证号两要素，走阿里云/火山「直认证」型，不需用户扫脸）。
// 已实名用户再调即视为二次核验，记一条 reverified 事件。
router.post('/v1/users/:uid/kyc/verify', requireApiKey('kyc:verify'), async (req, res) => {
  if (req.isSandbox) return res.json({ success: true, verified: true, _sandbox: true });
  const u = findRealUserByUid(req.params.uid);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const { name, id_number } = req.body || {};
  if (!name || !name.trim() || !id_number || !id_number.trim()) return res.status(400).json({ error: 'name 和 id_number 必填' });
  const reverify = !!u.kyc_verified;
  try {
    const orgKyc = req.body?.org ? subjectKycCfg(req.body.org) : userKycCfg(u);
    await verifyKycDirect(name.trim(), id_number.trim(), orgKyc);
    const h = identityHashes(name, id_number);
    finalizeKyc(u.id, { maskedName: maskName(name.trim()), idTail: id_number.slice(-4), provider: '服务商直接认证', pseudonym: h.pseudonym, nameHash: h.nameHash, reverify, source: 'api' });
    res.json({ success: true, verified: true, reverify });
  } catch (e) { res.status(400).json({ success: false, verified: false, error: e.message }); }
});

// ── 审计存证链开放 API ──
// 校验整条存证链是否完好（任何篡改都会 ok:false 并指出断裂位置）
router.get('/v1/audit/verify', requireApiKey('audit:read'), (req, res) => {
  if (req.isSandbox) return res.json({ ok: true, count: 3, head: 'sandbox_head_hash', _sandbox: true });
  res.json(auditVerifyChain());
});
// 查某用户的存证事件（按 uid_seq）
router.get('/v1/users/:uid/audit', requireApiKey('audit:read'), (req, res) => {
  if (req.isSandbox) return res.json({ _sandbox: true, total: 1, data: [{ seq: 1, event_type: 'kyc.verified', actor: 'source:api', detail: '{"provider":"服务商直接认证"}', created_at: '2026-01-01 10:00:00' }] });
  const u = findRealUserByUid(req.params.uid);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const data = auditBySubject(u.uid_seq, Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 500));
  res.json({ total: data.length, data });
});

// ── 水印策略开放 API：程序化读取 / 修改水印配置 ──
router.get('/v1/watermark', requireApiKey('config:read'), (req, res) => {
  if (req.isSandbox) return res.json({ _sandbox: true, watermark: watermarkPolicy() });
  res.json({ success: true, watermark: watermarkPolicy() });
});
router.put('/v1/watermark', requireApiKey('config:write'), (req, res) => {
  if (req.isSandbox) return res.json({ success: true, _sandbox: true, watermark: watermarkPolicy() });
  const b = req.body || {};
  // 只接受这些键，逐个写入 env_config 并同步 process.env（与 /admin/env 一致）
  const map = {
    enabled: 'WATERMARK_ENABLED', scope: 'WATERMARK_SCOPE', text: 'WATERMARK_TEXT',
    opacity: 'WATERMARK_OPACITY', angle: 'WATERMARK_ANGLE', size: 'WATERMARK_SIZE',
    gap: 'WATERMARK_GAP', color: 'WATERMARK_COLOR',
  };
  Object.entries(map).forEach(([field, envKey]) => {
    if (b[field] == null) return;
    let val = b[field];
    if (field === 'enabled') val = (val === true || /^(on|1|true|yes)$/i.test(String(val))) ? 'on' : 'off';
    else if (Array.isArray(val)) val = val.join(',');
    val = String(val).slice(0, 300);
    env.set.run(envKey, val);
    if (val.trim()) process.env[envKey] = val; else delete process.env[envKey];
  });
  res.json({ success: true, watermark: watermarkPolicy() });
});

router.get('/v1/apps', requireApiKey('apps:read'), (req, res) => {
  if (req.isSandbox) return res.json(SANDBOX.apps());
  res.json({ total: apps.findAll.all().length, data: apps.findAll.all() });
});
router.post('/v1/sms/send', requireApiKey('sms:send'), async (req, res) => {
  if (req.isSandbox) return res.json({ success: true, msgId: 'sandbox_sms_' + Date.now(), _sandbox: true });
  const { phone } = req.body;
  if (!phone || !isPhone(phone)) return res.status(400).json({ error: '手机号格式不正确' });
  try { const code = genCode(); await sendSmsCode(phone, code); res.json({ success: true, msgId: 'sms_'+Date.now() }); }
  catch (e) { res.status(500).json({ error: '短信发送失败' }); }
});
router.get('/v1/logs', requireApiKey('logs:read'), (req, res) => {
  if (req.isSandbox) return res.json(SANDBOX.logs());
  const rows = logs.findAll.all(); res.json({ total: rows.length, data: rows });
});

// 用户对象加等级标识符（U3 / A1）
function levelTagUser(u) {
  const s = safeUser(u);
  if (!s) return s;
  s.level_tag = u.role === 'admin' ? `A${u.admin_level || 9}` : `U${u.user_level || 9}`;
  return s;
}

// ──────────────────────────────────────────
// 积分商城 - 建表
// ──────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS shop_goods (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    icon           TEXT NOT NULL DEFAULT '🎁',
    description    TEXT NOT NULL DEFAULT '',
    note           TEXT,
    cost           INTEGER NOT NULL DEFAULT 100,
    stock          INTEGER NOT NULL DEFAULT -1,
    exchange_count INTEGER NOT NULL DEFAULT 0,
    status         TEXT NOT NULL DEFAULT 'on',
    sort_weight    INTEGER NOT NULL DEFAULT 0,
    -- 兑换码发放模式
    redeem_mode    TEXT NOT NULL DEFAULT 'code',    -- code=兑换码发放 | direct=直接到账
    allow_instant  INTEGER NOT NULL DEFAULT 1,       -- 是否允许当场兑换
    redirect_url   TEXT,                             -- 当场兑换跳转地址
    allow_transfer INTEGER NOT NULL DEFAULT 1,       -- 是否允许转送他人
    transfer_fee   INTEGER NOT NULL DEFAULT 0,       -- 转送扣除积分
    allow_discard  INTEGER NOT NULL DEFAULT 1,       -- 是否允许丢弃
    is_blind_box   INTEGER NOT NULL DEFAULT 0,       -- 是否为盲盒
    open_instantly INTEGER NOT NULL DEFAULT 1,       -- 盲盒是否当场打开
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 盲盒奖励配置
  CREATE TABLE IF NOT EXISTS blind_box_rewards (
    id          TEXT PRIMARY KEY,
    goods_id    TEXT NOT NULL REFERENCES shop_goods(id) ON DELETE CASCADE,
    type        TEXT NOT NULL DEFAULT 'points',  -- points | deduct_points | goods | redeem_code | nothing
    value       INTEGER,                          -- 积分数量（正负）
    goods_ref   TEXT,                             -- 关联商品 ID（type=goods）
    label       TEXT NOT NULL DEFAULT '神秘奖励', -- 前端显示名称
    weight      INTEGER NOT NULL DEFAULT 10,      -- 概率权重
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 用户持有的兑换券（商品兑换后生成）
  CREATE TABLE IF NOT EXISTS user_coupons (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    goods_id     TEXT NOT NULL,
    goods_name   TEXT NOT NULL,
    goods_icon   TEXT NOT NULL DEFAULT '🎁',
    coupon_code  TEXT UNIQUE NOT NULL,           -- 唯一兑换码
    status       TEXT NOT NULL DEFAULT 'unused', -- unused | used | transferred | discarded
    redirect_url TEXT,
    allow_instant  INTEGER NOT NULL DEFAULT 1,
    allow_transfer INTEGER NOT NULL DEFAULT 1,
    allow_discard  INTEGER NOT NULL DEFAULT 1,
    transfer_fee   INTEGER NOT NULL DEFAULT 0,
    obtained_at  TEXT NOT NULL DEFAULT (datetime('now')),
    used_at      TEXT,
    transferred_to TEXT                          -- 转送给谁的 user_id
  );

  CREATE TABLE IF NOT EXISTS shop_records (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_name   TEXT,
    uid_seq     INTEGER,
    goods_id    TEXT NOT NULL,
    goods_name  TEXT NOT NULL,
    goods_icon  TEXT NOT NULL DEFAULT '🎁',
    cost        INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    note        TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 兑换码表
  CREATE TABLE IF NOT EXISTS redeem_codes (
    id          TEXT PRIMARY KEY,
    code        TEXT UNIQUE NOT NULL,
    type        TEXT NOT NULL DEFAULT 'points',  -- points | feature
    value       INTEGER NOT NULL DEFAULT 0,       -- 积分数量 or 功能次数
    feature_key TEXT,                             -- type=feature 时的功能标识
    max_uses    INTEGER NOT NULL DEFAULT 1,        -- 最大使用次数（-1=无限）
    used_count  INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'active',   -- active | disabled | expired
    expire_at   TEXT,                             -- 过期时间，null=永不过期
    note        TEXT,
    created_by  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 兑换码使用记录
  CREATE TABLE IF NOT EXISTS redeem_records (
    id          TEXT PRIMARY KEY,
    code_id     TEXT NOT NULL REFERENCES redeem_codes(id),
    code        TEXT NOT NULL,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    user_name   TEXT,
    uid_seq     INTEGER,
    type        TEXT NOT NULL,
    value       INTEGER NOT NULL,
    feature_key TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 功能使用次数余额（如实名认证剩余次数）
  CREATE TABLE IF NOT EXISTS feature_quota (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    feature_key TEXT NOT NULL,
    quota       INTEGER NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, feature_key)
  );

  -- 积分与商城配置表
  CREATE TABLE IF NOT EXISTS shop_config (
    key_name  TEXT PRIMARY KEY,
    value     TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// 插入默认配置（不覆盖已有值）
const defaultConfigs = {
  'checkin_points':      '10',
  'checkin_enabled':     '1',
  'checkin_period':      'day',
  'checkin_min':         '1',
  'checkin_max':         '10',
  'redeem_code_on':      '1',
  'kyc_cost_type':       'free',
  'kyc_cost_value':      '0',
  'kyc_feature_key':     'kyc',
  'transfer_enabled':    '1',
  'transfer_max_once':   '20',
  'transfer_month_limit':'3',
  'transfer_show_uid':   '1',
};
Object.entries(defaultConfigs).forEach(([k, v]) => {
  const existing = db.prepare('SELECT 1 FROM shop_config WHERE key_name=?').get(k);
  if (!existing) db.prepare("INSERT INTO shop_config (key_name,value) VALUES (?,?)").run(k, v);
});

// 获取配置辅助函数
function shopCfg(key) {
  const row = db.prepare('SELECT value FROM shop_config WHERE key_name=?').get(key);
  return row?.value ?? null;
}

// ── 用户端：获取商城配置 ──
router.get('/shop/config', requireAuth, (req, res) => {
  res.json({
    success: true,
    checkin_points:  parseInt(shopCfg('checkin_points') || '10'),
    redeem_code_on:  shopCfg('redeem_code_on') === '1',
    kyc_cost_type:   shopCfg('kyc_cost_type')  || 'free',
    kyc_cost_value:  parseInt(shopCfg('kyc_cost_value') || '0'),
  });
});

// ── 用户端：获取商品列表 ──
router.get('/shop/goods', requireAuth, (req, res) => {
  const goods = db.prepare("SELECT * FROM shop_goods WHERE status='on' ORDER BY sort_weight DESC, created_at ASC").all();
  res.json({ success: true, goods });
});

// ── 用户端：兑换商品（生成兑换券 or 盲盒）──
// ── 兑换核心逻辑（用户端路由 + 开放 API 共用）──
// 返回 { ok:true, remain, ...result } 或 { ok:false, status, error }
function performExchange(user, goods) {
  if (!goods || goods.status !== 'on') return { ok: false, status: 404, error: '商品不存在或已下架' };
  if (goods.stock === 0) return { ok: false, status: 400, error: '商品库存不足' };
  if (!user) return { ok: false, status: 404, error: '用户不存在' };
  if (user.points < goods.cost) return { ok: false, status: 400, error: `积分不足，还需 ${goods.cost - user.points} 积分` };

  // 生成兑换券唯一码
  function genCouponCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const seg = () => Array.from({length:4}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
    return `${seg()}-${seg()}-${seg()}`;
  }

  let result = {};

  db.transaction(() => {
    // 扣积分 + 减库存
    users.addPoints.run(-goods.cost, user.id);
    points.insert.run(uuidv4(), user.id, -goods.cost, `兑换商品：${goods.name}`);
    if (goods.stock > 0) db.prepare("UPDATE shop_goods SET stock=stock-1,exchange_count=exchange_count+1,updated_at=datetime('now') WHERE id=?").run(goods.id);
    else db.prepare("UPDATE shop_goods SET exchange_count=exchange_count+1,updated_at=datetime('now') WHERE id=?").run(goods.id);

    // 记录兑换记录
    db.prepare('INSERT INTO shop_records (id,user_id,user_name,uid_seq,goods_id,goods_name,goods_icon,cost,status) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(uuidv4(), user.id, user.name, user.uid_seq, goods.id, goods.name, goods.icon, goods.cost, 'done');

    if (goods.is_blind_box) {
      // ── 盲盒逻辑 ──
      const rewards = db.prepare('SELECT * FROM blind_box_rewards WHERE goods_id=?').all(goods.id);
      if (!rewards.length) {
        result = { type: 'blind_box', opened: false, message: '盲盒暂无奖励配置，请联系管理员' };
        return;
      }
      // 加权随机选一个奖励
      const totalWeight = rewards.reduce((s, r) => s + r.weight, 0);
      let rand = Math.random() * totalWeight;
      let chosen = rewards[0];
      for (const r of rewards) { rand -= r.weight; if (rand <= 0) { chosen = r; break; } }

      result = { type: 'blind_box', reward: chosen, opened: goods.open_instantly === 1 };

      if (goods.open_instantly) {
        // 当场执行奖励
        if (chosen.type === 'points') {
          users.addPoints.run(chosen.value, user.id);
          points.insert.run(uuidv4(), user.id, chosen.value, `盲盒奖励：${chosen.label}`);
          result.executed = true;
        } else if (chosen.type === 'deduct_points') {
          const deduct = Math.min(user.points - goods.cost, chosen.value); // 不让积分为负
          if (deduct > 0) { users.addPoints.run(-deduct, user.id); points.insert.run(uuidv4(), user.id, -deduct, `盲盒扣除：${chosen.label}`); }
          result.executed = true; result.deducted = deduct;
        } else if (chosen.type === 'goods' && chosen.goods_ref) {
          // 发放另一个商品的兑换券
          const refGoods = db.prepare('SELECT * FROM shop_goods WHERE id=?').get(chosen.goods_ref);
          if (refGoods) {
            const couponCode = genCouponCode();
            db.prepare('INSERT INTO user_coupons (id,user_id,goods_id,goods_name,goods_icon,coupon_code,status,redirect_url,allow_instant,allow_transfer,allow_discard,transfer_fee) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
              .run(uuidv4(), user.id, refGoods.id, refGoods.name, refGoods.icon, couponCode, 'unused', refGoods.redirect_url, refGoods.allow_instant, refGoods.allow_transfer, refGoods.allow_discard, refGoods.transfer_fee);
            result.coupon = { code: couponCode, goods_name: refGoods.name };
          }
          result.executed = true;
        } else if (chosen.type === 'nothing') {
          result.executed = true; result.message = chosen.label;
        }
      } else {
        // 不当场打开：生成一个特殊盲盒券，稍后开启
        const couponCode = genCouponCode();
        db.prepare('INSERT INTO user_coupons (id,user_id,goods_id,goods_name,goods_icon,coupon_code,status,allow_instant,allow_transfer,allow_discard,transfer_fee) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
          .run(uuidv4(), user.id, goods.id, `【盲盒】${goods.name}`, goods.icon, couponCode, 'unused', 1, goods.allow_transfer, goods.allow_discard, goods.transfer_fee);
        // 把奖励信息存到 coupon 的 note 字段
        db.prepare("UPDATE user_coupons SET redirect_url=? WHERE coupon_code=?").run(JSON.stringify(chosen), couponCode);
        result.coupon = { code: couponCode, is_blind: true };
      }

    } else {
      // ── 普通商品：生成兑换券 ──
      const couponCode = genCouponCode();
      db.prepare('INSERT INTO user_coupons (id,user_id,goods_id,goods_name,goods_icon,coupon_code,status,redirect_url,allow_instant,allow_transfer,allow_discard,transfer_fee) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(uuidv4(), user.id, goods.id, goods.name, goods.icon, couponCode, 'unused',
          goods.redirect_url, goods.allow_instant, goods.allow_transfer, goods.allow_discard, goods.transfer_fee);
      result = { type: 'coupon', coupon: { code: couponCode, goods_name: goods.name, allow_instant: goods.allow_instant, redirect_url: goods.redirect_url } };
    }
  })();

  const updated = users.findById.get(user.id);
  return { ok: true, remain: updated.points, ...result };
}

router.post('/shop/exchange/:id', requireAuth, noPublic, async (req, res) => {
  const goods = db.prepare('SELECT * FROM shop_goods WHERE id=?').get(req.params.id);
  const user = users.findById.get(req.user.uid);
  const r = performExchange(user, goods);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const { ok, ...rest } = r;
  res.json({ success: true, ...rest });
});

// ── 用户端：我的兑换券 ──
router.get('/user/coupons', requireAuth, (req, res) => {
  const coupons = db.prepare("SELECT * FROM user_coupons WHERE user_id=? ORDER BY obtained_at DESC").all(req.user.uid);
  res.json({ success: true, coupons });
});

// ── 用户端：使用兑换券（当场兑换）──
router.post('/user/coupons/:code/use', requireAuth, (req, res) => {
  const c = db.prepare("SELECT * FROM user_coupons WHERE coupon_code=? AND user_id=?").get(req.params.code, req.user.uid);
  if (!c) return res.status(404).json({ error: '兑换券不存在' });
  if (c.status !== 'unused') return res.status(400).json({ error: `兑换券已${c.status==='used'?'使用':c.status==='transferred'?'转送':c.status==='discarded'?'丢弃':'失效'}` });
  if (!c.allow_instant) return res.status(403).json({ error: '该兑换券不允许当场兑换' });

  db.prepare("UPDATE user_coupons SET status='used',used_at=datetime('now') WHERE coupon_code=?").run(c.coupon_code);
  const redirect = c.redirect_url && !c.redirect_url.startsWith('{') ? c.redirect_url : null;
  res.json({ success: true, redirect_url: redirect, message: redirect ? '即将跳转使用' : '兑换券已核销' });
});

// ── 用户端：丢弃兑换券 ──
router.post('/user/coupons/:code/discard', requireAuth, (req, res) => {
  const c = db.prepare("SELECT * FROM user_coupons WHERE coupon_code=? AND user_id=?").get(req.params.code, req.user.uid);
  if (!c) return res.status(404).json({ error: '兑换券不存在' });
  if (c.status !== 'unused') return res.status(400).json({ error: '兑换券已不可操作' });
  if (!c.allow_discard) return res.status(403).json({ error: '该兑换券不允许丢弃' });
  db.prepare("UPDATE user_coupons SET status='discarded' WHERE coupon_code=?").run(c.coupon_code);
  res.json({ success: true });
});

// ── 用户端：转送兑换券给他人 ──
router.post('/user/coupons/:code/transfer', requireAuth, noPublic, async (req, res) => {
  const { to_uid, to_name, password } = req.body;
  const c = db.prepare("SELECT * FROM user_coupons WHERE coupon_code=? AND user_id=?").get(req.params.code, req.user.uid);
  if (!c) return res.status(404).json({ error: '兑换券不存在' });
  if (c.status !== 'unused') return res.status(400).json({ error: '兑换券已不可操作' });
  if (!c.allow_transfer) return res.status(403).json({ error: '该兑换券不允许转送' });
  if (!to_uid || !to_name) return res.status(400).json({ error: '请提供收件人 UID 和用户名' });
  if (!password) return res.status(400).json({ error: '请输入登录密码确认转送' });

  // 验密
  const fromUser = users.findById.get(req.user.uid);
  const pwOk = await bcrypt.compare(password, fromUser.password_hash || '');
  if (!pwOk) return res.status(401).json({ error: '密码错误' });

  // 查找收件人
  const toUser = db.prepare('SELECT * FROM users WHERE (uid_seq=? OR id=?) AND name=?').get(to_uid, to_uid, to_name.trim());
  if (!toUser) return res.status(404).json({ error: 'UID 与用户名不匹配' });
  if (toUser.id === req.user.uid) return res.status(400).json({ error: '不能转送给自己' });

  // 扣除转送手续费
  if (c.transfer_fee > 0) {
    if (fromUser.points < c.transfer_fee) return res.status(400).json({ error: `积分不足，转送需手续费 ${c.transfer_fee} 分` });
    users.addPoints.run(-c.transfer_fee, fromUser.id);
    points.insert.run(uuidv4(), fromUser.id, -c.transfer_fee, `转送兑换券手续费（${c.goods_name}）`);
  }

  // 记录转送日志（发送方 + 接收方）
  const toUidStr = `#${String(toUser.uid_seq).padStart(5,'0')}`;
  const fromUidStr = `#${String(fromUser.uid_seq).padStart(5,'0')}`;
  points.insert.run(uuidv4(), fromUser.id, 0, `转送兑换券给 ${toUser.name}（${toUidStr}）：${c.goods_name}`);
  points.insert.run(uuidv4(), toUser.id,   0, `收到 ${fromUser.name}（${fromUidStr}）转送的兑换券：${c.goods_name}`);

  db.prepare("UPDATE user_coupons SET user_id=?,status='unused',transferred_to=? WHERE coupon_code=?")
    .run(toUser.id, req.user.uid, c.coupon_code);

  res.json({ success: true, to_name: toUser.name, fee: c.transfer_fee });
});

// ── 开放 API：核验用户兑换券 ──
router.get('/v1/coupon/verify', requireApiKey('redeem:verify'), (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: '请提供兑换券码' });
  const c = db.prepare('SELECT * FROM user_coupons WHERE coupon_code=?').get(code.trim().toUpperCase());
  if (!c) return res.json({ valid: false, reason: '兑换券不存在' });
  if (c.status !== 'unused') return res.json({ valid: false, reason: `状态：${c.status}` });
  res.json({ valid: true, goods_name: c.goods_name, user_id: c.user_id });
});

// ── 开放 API：核销用户兑换券（第三方系统调用）──
router.post('/v1/coupon/use', requireApiKey('redeem:verify'), (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: '请提供兑换券码' });
  const c = db.prepare('SELECT * FROM user_coupons WHERE coupon_code=?').get(code.trim().toUpperCase());
  if (!c) return res.status(404).json({ error: '兑换券不存在' });
  if (c.status !== 'unused') return res.status(400).json({ error: `兑换券已${c.status}` });
  db.prepare("UPDATE user_coupons SET status='used',used_at=datetime('now') WHERE coupon_code=?").run(c.coupon_code);
  res.json({ success: true, goods_name: c.goods_name, user_id: c.user_id });
});

// ── 管理端：盲盒奖励配置 ──
router.get('/admin/shop/goods/:id/rewards', requireAdmin(2), (req, res) => {
  const rewards = db.prepare('SELECT * FROM blind_box_rewards WHERE goods_id=? ORDER BY weight DESC').all(req.params.id);
  res.json({ success: true, rewards });
});

router.post('/admin/shop/goods/:id/rewards', requireAdmin(2), (req, res) => {
  const { type, value, goods_ref, label, weight } = req.body;
  if (!type || !label) return res.status(400).json({ error: '类型和显示名称为必填' });
  const id = uuidv4();
  db.prepare('INSERT INTO blind_box_rewards (id,goods_id,type,value,goods_ref,label,weight) VALUES (?,?,?,?,?,?,?)')
    .run(id, req.params.id, type, parseInt(value)||0, goods_ref||null, label, parseInt(weight)||10);
  res.json({ success: true, id });
});

router.delete('/admin/shop/goods/:id/rewards/:rid', requireAdmin(2), (req, res) => {
  db.prepare('DELETE FROM blind_box_rewards WHERE id=? AND goods_id=?').run(req.params.rid, req.params.id);
  res.json({ success: true });
});

// ── 管理端：查看用户兑换券 ──
router.get('/admin/shop/coupons', requireAdmin(3), (req, res) => {
  const { user_id } = req.query;
  const coupons = user_id
    ? db.prepare('SELECT * FROM user_coupons WHERE user_id=? ORDER BY obtained_at DESC').all(user_id)
    : db.prepare('SELECT * FROM user_coupons ORDER BY obtained_at DESC LIMIT 200').all();
  res.json({ success: true, coupons });
});

// ── 管理端：手动作废用户兑换券 ──
router.patch('/admin/shop/coupons/:code', requireAdmin(2), (req, res) => {
  const { status } = req.body;
  db.prepare("UPDATE user_coupons SET status=? WHERE coupon_code=?").run(status, req.params.code);
  res.json({ success: true });
});

// ── 用户端：兑换记录 ──
router.get('/shop/records', requireAuth, (req, res) => {
  const records = db.prepare('SELECT * FROM shop_records WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(req.user.uid);
  res.json({ success: true, records });
});

// ── 用户端：使用兑换码 ──
router.post('/shop/redeem', requireAuth, noPublic, (req, res) => {
  // 检查兑换码功能是否开启
  if (shopCfg('redeem_code_on') !== '1') {
    return res.status(403).json({ error: '兑换码功能暂未开放' });
  }

  const { code } = req.body;
  if (!code?.trim()) return res.status(400).json({ error: '请输入兑换码' });

  const codeRow = db.prepare("SELECT * FROM redeem_codes WHERE code=? AND status='active'").get(code.trim().toUpperCase());
  if (!codeRow) return res.status(404).json({ error: '兑换码不存在或已失效' });

  // 检查过期
  if (codeRow.expire_at && new Date(codeRow.expire_at) < new Date()) {
    db.prepare("UPDATE redeem_codes SET status='expired' WHERE id=?").run(codeRow.id);
    return res.status(400).json({ error: '兑换码已过期' });
  }
  // 检查使用次数
  if (codeRow.max_uses !== -1 && codeRow.used_count >= codeRow.max_uses) {
    return res.status(400).json({ error: '该兑换码已达使用上限' });
  }
  // 检查是否已使用过（同一用户）
  const usedBefore = db.prepare('SELECT 1 FROM redeem_records WHERE code_id=? AND user_id=?').get(codeRow.id, req.user.uid);
  if (usedBefore) return res.status(400).json({ error: '你已使用过该兑换码' });

  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  // 执行兑换（事务）
  db.transaction(() => {
    if (codeRow.type === 'points') {
      users.addPoints.run(codeRow.value, user.id);
      points.insert.run(uuidv4(), user.id, codeRow.value, `兑换码奖励：${code}`);
    } else if (codeRow.type === 'feature') {
      db.prepare(`INSERT INTO feature_quota (user_id,feature_key,quota,updated_at)
        VALUES (?,?,?,datetime('now'))
        ON CONFLICT(user_id,feature_key) DO UPDATE SET quota=quota+?,updated_at=datetime('now')`)
        .run(user.id, codeRow.feature_key, codeRow.value, codeRow.value);
    }
    db.prepare('UPDATE redeem_codes SET used_count=used_count+1 WHERE id=?').run(codeRow.id);
    if (codeRow.max_uses !== -1 && codeRow.used_count + 1 >= codeRow.max_uses) {
      db.prepare("UPDATE redeem_codes SET status='disabled' WHERE id=?").run(codeRow.id);
    }
    db.prepare('INSERT INTO redeem_records (id,code_id,code,user_id,user_name,uid_seq,type,value,feature_key) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(uuidv4(), codeRow.id, code.trim().toUpperCase(), user.id, user.name, user.uid_seq,
        codeRow.type, codeRow.value, codeRow.feature_key || null);
  })();

  const updated = users.findById.get(user.id);
  const result = {
    success: true,
    type: codeRow.type,
    value: codeRow.value,
    feature_key: codeRow.feature_key,
    points_now: updated.points,
  };
  if (codeRow.type === 'points') {
    result.message = `🎉 成功兑换 +${codeRow.value} 积分！当前积分：${updated.points}`;
  } else {
    result.message = `🎉 成功兑换「${codeRow.feature_key}」使用次数 +${codeRow.value} 次！`;
  }
  res.json(result);
});

// ── 用户端：查询功能次数余额 ──
router.get('/shop/quota/:feature_key', requireAuth, (req, res) => {
  const row = db.prepare('SELECT quota FROM feature_quota WHERE user_id=? AND feature_key=?').get(req.user.uid, req.params.feature_key);
  res.json({ success: true, quota: row?.quota || 0 });
});

// ── 用户端：兑换码使用记录 ──
router.get('/shop/redeem-records', requireAuth, (req, res) => {
  const records = db.prepare('SELECT * FROM redeem_records WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(req.user.uid);
  res.json({ success: true, records });
});

// ── 修改签到接口：读取配置积分、周期、随机区间 ──
// 签到周期判断 + 执行（用户端 /user/checkin/v2 与开放 API /v1 共用）
function _checkinIsSamePeriod(a, b, p) {
  if (!a) return false;
  const getWeek = d => { const s = new Date(d.getFullYear(), 0, 1); return Math.ceil(((d - s) / 86400000 + s.getDay() + 1) / 7); };
  if (p === 'hour')    return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate() && a.getHours()===b.getHours();
  if (p === 'day')     return a.toISOString().slice(0,10) === b.toISOString().slice(0,10);
  if (p === 'week')    return a.getFullYear()===b.getFullYear() && getWeek(a)===getWeek(b);
  if (p === 'month')   return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth();
  if (p === 'quarter') return a.getFullYear()===b.getFullYear() && Math.floor(a.getMonth()/3)===Math.floor(b.getMonth()/3);
  if (p === 'year')    return a.getFullYear()===b.getFullYear();
  return false;
}
/** 给某用户执行一次签到。返回 {ok:true, points, min, max, streak, total} 或 {ok:false, status, error}。 */
function performCheckin(user) {
  if (shopCfg('checkin_enabled') === '0') return { ok: false, status: 403, error: '签到功能暂未开放' };
  const period = shopCfg('checkin_period') || 'day';
  const now = new Date();
  const lastCheckin = user.last_checkin ? new Date(user.last_checkin) : null;
  if (lastCheckin && _checkinIsSamePeriod(lastCheckin, now, period)) {
    const periodLabel = {hour:'小时',day:'天',week:'周',month:'月',quarter:'季度',year:'年'}[period]||'天';
    return { ok: false, status: 400, error: `本${periodLabel}已签到` };
  }
  const minPts = Math.max(1, parseInt(shopCfg('checkin_min') || '1'));
  const maxPts = Math.max(minPts, parseInt(shopCfg('checkin_max') || shopCfg('checkin_points') || '10'));
  const pts = minPts === maxPts ? minPts : Math.floor(Math.random() * (maxPts - minPts + 1)) + minPts;
  // 连续签到：last_checkin 存完整 ISO，比较取日期部分
  const yesterday = new Date(now - 86400000).toISOString().slice(0,10);
  const lastDay   = lastCheckin ? lastCheckin.toISOString().slice(0,10) : null;
  if (lastDay === yesterday) users.checkin.run(user.id);
  else users.resetStreak.run(user.id);
  users.addPoints.run(pts, user.id);
  points.insert.run(uuidv4(), user.id, pts, '每日签到');
  db.prepare("UPDATE users SET last_checkin=? WHERE id=?").run(now.toISOString(), user.id);
  const updated = users.findById.get(user.id);
  return { ok: true, points: pts, min: minPts, max: maxPts, streak: updated.checkin_streak, total: updated.points };
}

router.post('/user/checkin/v2', requireAuth, noPublic, (req, res) => {
  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const r = performCheckin(user);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json({ success: true, points: r.points, min: r.min, max: r.max, streak: r.streak, total: r.total });
});

// ── 管理端：商品管理 ──
router.get('/admin/shop/goods', requireAdmin(3), (req, res) => {
  const goods = db.prepare('SELECT * FROM shop_goods ORDER BY sort_weight DESC, created_at ASC').all();
  res.json({ success: true, goods });
});

router.get('/admin/shop/goods/:id', requireAdmin(3), (req, res) => {
  const goods = db.prepare('SELECT * FROM shop_goods WHERE id=?').get(req.params.id);
  if (!goods) return res.status(404).json({ error: '商品不存在' });
  res.json({ success: true, goods });
});

router.post('/admin/shop/goods', requireAdmin(2), (req, res) => {
  const { name, icon = '🎁', description = '', note = '', cost, stock = -1, status = 'on', sort_weight = 0, category = '' } = req.body;
  if (!name || !cost) return res.status(400).json({ error: '商品名称和积分为必填' });
  const id = uuidv4();
  db.prepare('INSERT INTO shop_goods (id,name,icon,description,note,cost,stock,status,sort_weight,category) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, name, icon, description, note, cost, stock, status, sort_weight, String(category || '').trim());
  res.json({ success: true, goods: db.prepare('SELECT * FROM shop_goods WHERE id=?').get(id) });
});

router.patch('/admin/shop/goods/:id', requireAdmin(2), (req, res) => {
  const goods = db.prepare('SELECT * FROM shop_goods WHERE id=?').get(req.params.id);
  if (!goods) return res.status(404).json({ error: '商品不存在' });
  const { name, icon, description, note, cost, stock, status, sort_weight, category } = req.body;
  db.prepare(`UPDATE shop_goods SET
    name=COALESCE(?,name), icon=COALESCE(?,icon), description=COALESCE(?,description),
    note=COALESCE(?,note), cost=COALESCE(?,cost), stock=COALESCE(?,stock),
    status=COALESCE(?,status), sort_weight=COALESCE(?,sort_weight),
    category=COALESCE(?,category),
    updated_at=datetime('now') WHERE id=?`)
    .run(name??null, icon??null, description??null, note??null, cost??null, stock??null, status??null, sort_weight??null,
         category!==undefined?String(category||'').trim():null, goods.id);
  res.json({ success: true });
});

// ── 管理端：兑换记录 ──
router.get('/admin/shop/records', requireAdmin(3), (req, res) => {
  const records = db.prepare('SELECT * FROM shop_records ORDER BY created_at DESC LIMIT 200').all();
  res.json({ success: true, records });
});

router.patch('/admin/shop/records/:id', requireAdmin(2), (req, res) => {
  const { status, note } = req.body;
  db.prepare("UPDATE shop_records SET status=COALESCE(?,status),note=COALESCE(?,note),updated_at=datetime('now') WHERE id=?")
    .run(status ?? null, note ?? null, req.params.id);
  res.json({ success: true });
});

// ── 管理端：兑换码管理 ──
router.get('/admin/shop/codes', requireAdmin(2), (req, res) => {
  const codes = db.prepare('SELECT * FROM redeem_codes ORDER BY created_at DESC').all();
  res.json({ success: true, codes });
});

router.post('/admin/shop/codes', requireAdmin(2), (req, res) => {
  const { type = 'points', value, feature_key, max_uses = 1, expire_at, note, count = 1 } = req.body;
  if (!value || value <= 0) return res.status(400).json({ error: '兑换价值必须大于 0' });
  if (type === 'feature' && !feature_key) return res.status(400).json({ error: 'feature 类型需指定 feature_key' });

  const generated = [];
  const num = Math.min(parseInt(count) || 1, 500); // 单次最多批量生成 500 个
  for (let i = 0; i < num; i++) {
    const code = generateCode();
    const id = uuidv4();
    db.prepare(`INSERT INTO redeem_codes (id,code,type,value,feature_key,max_uses,status,expire_at,note,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(id, code, type, parseInt(value), feature_key || null, parseInt(max_uses) || 1, 'active', expire_at || null, note || null, req.user.uid);
    generated.push(code);
  }
  res.json({ success: true, codes: generated, count: generated.length });
});

router.patch('/admin/shop/codes/:id', requireAdmin(2), (req, res) => {
  const { status, expire_at, note, max_uses } = req.body;
  db.prepare(`UPDATE redeem_codes SET
    status=COALESCE(?,status), expire_at=COALESCE(?,expire_at),
    note=COALESCE(?,note), max_uses=COALESCE(?,max_uses)
    WHERE id=?`)
    .run(status ?? null, expire_at ?? null, note ?? null, max_uses ?? null, req.params.id);
  res.json({ success: true });
});

router.get('/admin/shop/redeem-records', requireAdmin(3), (req, res) => {
  const records = db.prepare('SELECT * FROM redeem_records ORDER BY created_at DESC LIMIT 300').all();
  res.json({ success: true, records });
});

// ── 管理端：商城/积分配置 ──
router.get('/admin/shop/config', requireAdmin(2), (req, res) => {
  const rows = db.prepare('SELECT * FROM shop_config').all();
  const cfg = {};
  rows.forEach(r => { cfg[r.key_name] = r.value; });
  res.json({ success: true, config: cfg });
});

router.post('/admin/shop/config', requireAdmin(2), (req, res) => {
  const { checkin_enabled, checkin_period, checkin_min, checkin_max,
          redeem_code_on, kyc_cost_type, kyc_cost_value, kyc_feature_key,
          sms_poll_strategy, email_poll_strategy, kyc_poll_strategy } = req.body;
  const updates = {};
  if (checkin_enabled !== undefined) updates['checkin_enabled']  = checkin_enabled ? '1' : '0';
  if (checkin_period  !== undefined) updates['checkin_period']   = ['hour','day','week','month','quarter','year'].includes(checkin_period) ? checkin_period : 'day';
  if (checkin_min     !== undefined) updates['checkin_min']      = String(Math.max(1, parseInt(checkin_min)||1));
  if (checkin_max     !== undefined) updates['checkin_max']      = String(Math.max(parseInt(updates['checkin_min']||'1'), parseInt(checkin_max)||10));
  if (redeem_code_on  !== undefined) updates['redeem_code_on']   = redeem_code_on ? '1' : '0';
  if (kyc_cost_type   !== undefined) updates['kyc_cost_type']    = ['free','points','redeem_code'].includes(kyc_cost_type) ? kyc_cost_type : 'free';
  if (kyc_cost_value  !== undefined) updates['kyc_cost_value']   = String(Math.max(0, parseInt(kyc_cost_value)||0));
  if (kyc_feature_key !== undefined) updates['kyc_feature_key']  = kyc_feature_key;
  if (sms_poll_strategy   !== undefined) updates['sms_poll_strategy']   = ['least','sequential','single','user_choice'].includes(sms_poll_strategy)   ? sms_poll_strategy   : 'least';
  if (email_poll_strategy !== undefined) updates['email_poll_strategy'] = ['least','sequential','single','user_choice'].includes(email_poll_strategy) ? email_poll_strategy : 'least';
  if (kyc_poll_strategy   !== undefined) updates['kyc_poll_strategy']   = ['least','sequential','single','user_choice'].includes(kyc_poll_strategy)   ? kyc_poll_strategy   : 'least';
  // single 模式下的指定服务商
  if (req.body.sms_single_provider)   updates['sms_single_provider']   = req.body.sms_single_provider;
  if (req.body.email_single_provider) updates['email_single_provider'] = req.body.email_single_provider;
  if (req.body.kyc_single_provider)   updates['kyc_single_provider']   = req.body.kyc_single_provider;
  Object.entries(updates).forEach(([k, v]) =>
    db.prepare("INSERT OR REPLACE INTO shop_config (key_name,value,updated_at) VALUES (?,?,datetime('now'))").run(k, v)
  );
  res.json({ success: true });
});

// 生成随机兑换码（格式：XXXX-XXXX-XXXX）
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆字符
  const seg = () => Array.from({length: 4}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${seg()}-${seg()}-${seg()}`;
}

// ──────────────────────────────────────────
// 开发模拟登录（仅 setup 未完成时可用）
// ──────────────────────────────────────────
router.post('/dev/login', async (req, res) => {
  const { isSetupDone } = require('./db');

  // setup 完成后直接拒绝，不论任何情况
  if (isSetupDone()) {
    return res.status(403).json({ error: '系统已完成配置，模拟登录已关闭' });
  }

  const { role = 'user' } = req.body;

  // 模拟账号配置
  const DEV_ACCOUNTS = {
    admin: { email: 'admin@dev.local',  name: '开发管理员', role: 'admin', admin_level: 1, user_level: 1 },
    ops:   { email: 'ops@dev.local',    name: '运营管理员', role: 'admin', admin_level: 2, user_level: 1 },
    user:  { email: 'user@dev.local',   name: '测试用户',   role: 'user',  admin_level: null, user_level: 4 },
    vip:   { email: 'vip@dev.local',    name: 'VIP用户',    role: 'user',  admin_level: null, user_level: 1 },
  };

  const acc = DEV_ACCOUNTS[role];
  if (!acc) return res.status(400).json({ error: '无效的角色参数' });

  // 查找或自动创建模拟账号
  let user = users.findByEmail.get(acc.email);
  if (!user) {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('dev-password-' + role, 6); // 轮次低，仅开发用
    user = users.create({
      name: acc.name, email: acc.email, password_hash: hash,
      role: acc.role, admin_level: acc.admin_level, user_level: acc.user_level,
    });
    // 给 VIP/admin 预置一些积分，方便测试商城
    if (user && ['admin','vip'].includes(role)) {
      users.addPoints.run(500, user.id);
    }
  }

  // 记录模拟登录日志
  try {
    logs.insert.run({
      id: uuidv4(), user_id: user.id, user_name: user.name,
      uid_seq: String(user.uid_seq), method: `开发模拟登录（${role}）`,
      app_name: '本系统', ip: req.ip, user_agent: req.headers['user-agent'],
      status: 'success', fail_reason: null,
    });
  } catch(_) {}
  const token = signToken({
    uid: user.id, name: user.name,
    role: user.role, adminLevel: user.admin_level,
    _dev: true, // 携带标记，方便识别
  });

  // 不含敏感字段的用户数据
  const { password_hash, twofa_secret, ...safeUserObj } = user;
  res.json({ success: true, token, user: safeUserObj, _dev: true });
});

// ── 退出登录（客户端清除 token，服务端记录日志）──
router.post('/user/logout', requireAuth, (req, res) => {
  try {
    logs.insert.run({
      id: uuidv4(), user_id: req.user.uid, user_name: null,
      uid_seq: null, method: '退出登录', app_name: '本系统',
      ip: req.ip, user_agent: req.headers['user-agent'],
      status: 'success', fail_reason: null,
    });
  } catch(_) {}
  res.json({ success: true });
});

// ── 检查用户名是否唯一 ──
router.get('/user/check-name', requireAuth, (req, res) => {
  const { name } = req.query;
  if (!name?.trim()) return res.status(400).json({ error: '用户名不能为空' });
  const existing = db.prepare('SELECT id FROM users WHERE name=? AND id!=?').get(name.trim(), req.user.uid);
  res.json({ available: !existing });
});

// ── 积分转账 ──
router.post('/shop/transfer', requireAuth, noPublic, async (req, res) => {
  const { to_uid, to_name, amount, password } = req.body;
  const pts = parseInt(amount);
  if (!to_uid || !to_name) return res.status(400).json({ error: '请输入收款用户 UID 和用户名' });
  if (!pts || pts < 1)    return res.status(400).json({ error: '转账积分至少 1 分' });
  if (!password)          return res.status(400).json({ error: '请输入登录密码以确认转账' });

  // 读取转账配置
  const maxOnce    = parseInt(shopCfg('transfer_max_once')    || '20');
  const monthLimit = parseInt(shopCfg('transfer_month_limit') || '3');
  const enabled    = shopCfg('transfer_enabled') !== '0';
  if (!enabled) return res.status(403).json({ error: '积分转账功能已关闭' });
  if (pts > maxOnce) return res.status(400).json({ error: `单次最多转账 ${maxOnce} 积分` });

  // 验证发起人密码
  const fromUser = users.findById.get(req.user.uid);
  if (!fromUser) return res.status(404).json({ error: '用户不存在' });
  if (!fromUser.password_hash) return res.status(400).json({ error: '账号未设置密码，无法发起转账' });
  const pwOk = await bcrypt.compare(password, fromUser.password_hash);
  if (!pwOk) return res.status(401).json({ error: '密码错误，转账已取消' });

  // 检查本月发起次数
  const monthCount = db.prepare(`
    SELECT COUNT(*) as n FROM points_log
    WHERE user_id=? AND reason LIKE '转账给%'
    AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
  `).get(fromUser.id).n;
  if (monthCount >= monthLimit) return res.status(400).json({ error: `本月转账次数已达上限（${monthLimit} 次）` });

  // 查找收款用户：UID 和昵称必须同时匹配
  const toUser = db.prepare(
    'SELECT * FROM users WHERE (uid_seq=? OR id=?) AND name=?'
  ).get(to_uid, to_uid, to_name.trim());
  if (!toUser) return res.status(404).json({ error: 'UID 与用户名不匹配，请确认后重试' });
  if (toUser.id === fromUser.id) return res.status(400).json({ error: '不能给自己转账' });
  if (toUser.status === 'disabled') return res.status(400).json({ error: '收款用户已停用' });
  if (fromUser.points < pts) return res.status(400).json({ error: `积分不足，当前 ${fromUser.points} 分` });

  // 执行转账（事务）
  db.transaction(() => {
    users.addPoints.run(-pts, fromUser.id);
    users.addPoints.run(pts, toUser.id);
    points.insert.run(uuidv4(), fromUser.id, -pts, `积分转账给 ${toUser.name}（#${String(toUser.uid_seq).padStart(5,'0')}）`);
    points.insert.run(uuidv4(), toUser.id,   pts, `收到 ${fromUser.name}（#${String(fromUser.uid_seq).padStart(5,'0')}）转来的积分`);
  })();

  const updated = users.findById.get(fromUser.id);
  res.json({ success: true, remain: updated.points, to_name: toUser.name });
});

// ── 查找用户（转账用，始终要求 UID+昵称匹配）──
router.get('/shop/find-user', requireAuth, (req, res) => {
  const uid  = String(req.query.uid  || '').trim().replace(/^#/, '');
  const name = String(req.query.name || '').trim();
  if (!uid || !name) return res.status(400).json({ error: '请同时输入 UID 和用户名' });
  // UID 仍精确（转账安全），用户名改为部分匹配（包含即可，不必一字不差）
  const u = db.prepare(
    "SELECT id,uid_seq,name,status FROM users WHERE (uid_seq=? OR uid_code=? OR id=?) AND name LIKE ? AND is_public=0"
  ).get(/^\d+$/.test(uid) ? parseInt(uid, 10) : -1, uid, uid, '%' + name + '%');
  if (!u) return res.status(404).json({ error: '未找到匹配的用户（UID 与用户名对不上）' });
  res.json({ success: true, user: { uid_seq: u.uid_seq, name: u.name, status: u.status } });
});

// ── 管理端：积分转账配置 ──
router.post('/admin/shop/transfer-config', requireAdmin(2), (req, res) => {
  const { enabled, max_once, month_limit, show_uid } = req.body;
  if (enabled   !== undefined) db.prepare("INSERT OR REPLACE INTO shop_config(key_name,value) VALUES('transfer_enabled',?)").run(enabled ? '1' : '0');
  if (max_once  !== undefined) db.prepare("INSERT OR REPLACE INTO shop_config(key_name,value) VALUES('transfer_max_once',?)").run(String(parseInt(max_once)||20));
  if (month_limit!==undefined) db.prepare("INSERT OR REPLACE INTO shop_config(key_name,value) VALUES('transfer_month_limit',?)").run(String(parseInt(month_limit)||3));
  if (show_uid  !== undefined) db.prepare("INSERT OR REPLACE INTO shop_config(key_name,value) VALUES('transfer_show_uid',?)").run(show_uid ? '1' : '0');
  res.json({ success: true });
});

// ── 管理端：设置用户能否改用户名 / 邮箱 / 手机 ──
router.patch('/admin/users/:id/permissions', requireAdmin(2), (req, res) => {
  const { can_rename, can_change_email, can_change_phone } = req.body;
  const user = users.findById.get(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (can_rename      !== undefined) db.prepare("UPDATE users SET can_rename=? WHERE id=?").run(can_rename      ? 1 : 0, user.id);
  if (can_change_email!== undefined) db.prepare("UPDATE users SET can_change_email=? WHERE id=?").run(can_change_email ? 1 : 0, user.id);
  if (can_change_phone!== undefined) db.prepare("UPDATE users SET can_change_phone=? WHERE id=?").run(can_change_phone ? 1 : 0, user.id);
  res.json({ success: true });
});

// ── 管理端：积分划转（增减任意用户积分）──
router.post('/admin/users/:id/points', requireAdmin(2), (req, res) => {
  const { delta, reason } = req.body;
  const pts = parseInt(delta);
  if (!pts || pts === 0) return res.status(400).json({ error: '积分变动量不能为 0' });
  const user = users.findById.get(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (user.points + pts < 0) return res.status(400).json({ error: `扣除后积分将为负数（当前 ${user.points}）` });
  users.addPoints.run(pts, user.id);
  points.insert.run(uuidv4(), user.id, pts, reason || (pts > 0 ? '管理员增加积分' : '管理员扣减积分'));
  const updated = users.findById.get(user.id);
  res.json({ success: true, points: updated.points });
});

// ── 管理端：作废兑换码 + 可选撤销已兑换积分 ──
router.post('/admin/shop/codes/:id/revoke', requireAdmin(2), (req, res) => {
  const { recall_points = false } = req.body; // 是否撤销已兑换积分
  const code = db.prepare('SELECT * FROM redeem_codes WHERE id=?').get(req.params.id);
  if (!code) return res.status(404).json({ error: '兑换码不存在' });

  db.transaction(() => {
    // 将兑换码标记为已作废
    db.prepare("UPDATE redeem_codes SET status='revoked' WHERE id=?").run(code.id);

    if (recall_points && code.type === 'points') {
      // 撤销所有使用该码的积分
      const records = db.prepare('SELECT * FROM redeem_records WHERE code_id=?').all(code.id);
      records.forEach(r => {
        const u = users.findById.get(r.user_id);
        if (!u) return;
        const deduct = Math.min(u.points, code.value); // 最多扣到 0
        if (deduct > 0) {
          users.addPoints.run(-deduct, u.id);
          points.insert.run(uuidv4(), u.id, -deduct, `兑换码积分撤销（${code.code}）`);
        }
      });
    }
  })();

  res.json({ success: true, recall_points });
});

// ── 解绑保护：检查是否为最后一个登录方式 ──
router.delete('/user/oauth/:provider', requireAuth, noPublic, (req, res) => {
  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  // 统计当前登录方式数量
  const oauthCount = db.prepare('SELECT COUNT(*) as n FROM user_oauth WHERE user_id=?').get(user.id).n;
  const hasEmail   = !!user.email && !!user.password_hash;
  const hasPhone   = !!user.phone;
  const totalMethods = oauthCount + (hasEmail ? 1 : 0) + (hasPhone ? 1 : 0);

  if (totalMethods <= 1) {
    return res.status(400).json({ error: '至少保留一种登录方式，无法解绑' });
  }

  db.prepare('DELETE FROM user_oauth WHERE user_id=? AND provider=?').run(user.id, req.params.provider);
  res.json({ success: true });
});

// ── 系统时区配置 ──
router.get('/admin/config/timezone', requireAdmin(2), (req, res) => {
  const tz = db.prepare("SELECT value FROM shop_config WHERE key_name='system_timezone'").get();
  res.json({ success: true, timezone: tz?.value || 'auto' });
});
router.post('/admin/config/timezone', requireAdmin(2), (req, res) => {
  const { timezone } = req.body;
  if (!timezone) return res.status(400).json({ error: '时区不能为空' });
  db.prepare("INSERT OR REPLACE INTO shop_config(key_name,value) VALUES('system_timezone',?)").run(timezone);
  res.json({ success: true });
});

// ── 开放 API：核验兑换码有效性 ──
router.get('/v1/redeem/verify', requireApiKey('redeem:verify'), (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: '请提供兑换码' });
  const c = db.prepare("SELECT * FROM redeem_codes WHERE code=?").get(code.trim().toUpperCase());
  if (!c) return res.json({ valid: false, reason: '兑换码不存在' });
  if (c.status !== 'active') return res.json({ valid: false, reason: `兑换码状态：${c.status}` });
  if (c.expire_at && new Date(c.expire_at) < new Date()) return res.json({ valid: false, reason: '已过期' });
  if (c.max_uses !== -1 && c.used_count >= c.max_uses) return res.json({ valid: false, reason: '已达使用上限' });
  res.json({ valid: true, type: c.type, value: c.value, feature_key: c.feature_key, remaining: c.max_uses === -1 ? -1 : c.max_uses - c.used_count });
});

// ══════════════════════════════════════════════════════════
// 自主功能开放 API：积分 / 商城（供第三方系统程序化对接）
// 均排除公共账号（is_public=1 是共享身份，不是自然人）
// ══════════════════════════════════════════════════════════
const findRealUserByUid = uid => db.prepare('SELECT * FROM users WHERE (uid_seq=? OR id=? OR uid_code=?) AND is_public=0').get(uid, uid, uid);

// 查用户积分余额
router.get('/v1/users/:uid/points', requireApiKey('points:read'), (req, res) => {
  if (req.isSandbox) return res.json({ uid_seq: 142, name: '沙盒用户', points: 1000, checkin_streak: 5, _sandbox: true });
  const u = findRealUserByUid(req.params.uid);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  res.json({ id: u.id, uid_seq: u.uid_seq, uid_code: u.uid_code || null, name: u.name, points: u.points || 0, checkin_streak: u.checkin_streak || 0 });
});

// 查用户积分明细（最近 50 条）
router.get('/v1/users/:uid/points/logs', requireApiKey('points:read'), (req, res) => {
  if (req.isSandbox) return res.json({ _sandbox: true, total: 1, data: [{ delta: 10, reason: '每日签到', created_at: '2026-01-01 10:00:00' }] });
  const u = findRealUserByUid(req.params.uid);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const rows = points.findByUser.all(u.id);
  res.json({ total: rows.length, data: rows.map(r => ({ delta: r.delta, reason: r.reason, created_at: r.created_at })) });
});

// 调整用户积分（增加/扣减），记入积分明细
router.post('/v1/users/:uid/points', requireApiKey('points:write'), (req, res) => {
  if (req.isSandbox) return res.json({ success: true, points: 1010, delta: 10, _sandbox: true });
  const u = findRealUserByUid(req.params.uid);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const delta = parseInt(req.body?.delta, 10);
  if (!Number.isInteger(delta) || delta === 0) return res.status(400).json({ error: 'delta 必须是非零整数（正数增加、负数扣减）' });
  const reason = String(req.body?.reason || '').trim().slice(0, 200) || (delta > 0 ? 'API 增加积分' : 'API 扣减积分');
  const cur = u.points || 0;
  if (cur + delta < 0) return res.status(400).json({ error: `积分不足：当前 ${cur}，无法扣减 ${-delta}` });
  db.transaction(() => {
    users.addPoints.run(delta, u.id);
    points.insert.run(uuidv4(), u.id, delta, reason);
  })();
  const after = users.findById.get(u.id).points;
  audit('points.adjusted', { subject: u.uid_seq, actor: actorOf(req), detail: { delta, reason, balance_after: after } });
  res.json({ success: true, points: after, delta });
});

// 商城在售商品目录
router.get('/v1/shop/goods', requireApiKey('shop:read'), (req, res) => {
  if (req.isSandbox) return res.json({ _sandbox: true, total: 1, data: [{ id: 'sb-g', name: '沙盒商品', icon: '🎁', cost: 100, stock: -1, status: 'on', is_blind_box: 0 }] });
  const rows = db.prepare("SELECT id,name,icon,description,note,cost,stock,exchange_count,status,is_blind_box FROM shop_goods WHERE status='on' ORDER BY sort_weight DESC, created_at ASC").all();
  res.json({ total: rows.length, data: rows });
});

// 查用户持有的兑换券
router.get('/v1/users/:uid/coupons', requireApiKey('shop:read'), (req, res) => {
  if (req.isSandbox) return res.json({ _sandbox: true, total: 1, data: [{ coupon_code: 'SB-DEMO-0001', goods_name: '沙盒商品', status: 'unused', obtained_at: '2026-01-01 10:00:00' }] });
  const u = findRealUserByUid(req.params.uid);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const rows = db.prepare("SELECT coupon_code,goods_name,goods_icon,status,obtained_at,used_at FROM user_coupons WHERE user_id=? ORDER BY obtained_at DESC").all(u.id);
  res.json({ total: rows.length, data: rows });
});

// 查用户签到状态
router.get('/v1/users/:uid/checkin', requireApiKey('points:read'), (req, res) => {
  if (req.isSandbox) return res.json({ uid_seq: 142, checkin_streak: 5, last_checkin: '2026-01-01', checked_in_today: true, _sandbox: true });
  const u = findRealUserByUid(req.params.uid);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const today = new Date().toISOString().slice(0, 10);
  const lastDay = u.last_checkin ? new Date(u.last_checkin).toISOString().slice(0, 10) : null;
  res.json({ uid_seq: u.uid_seq, checkin_streak: u.checkin_streak || 0, last_checkin: lastDay, checked_in_today: lastDay === today });
});

// 代用户签到（发积分，遵循管理端配置的周期/随机区间）
router.post('/v1/users/:uid/checkin', requireApiKey('points:write'), (req, res) => {
  if (req.isSandbox) return res.json({ success: true, points: 10, streak: 6, total: 1010, _sandbox: true });
  const u = findRealUserByUid(req.params.uid);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const r = performCheckin(u);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json({ success: true, points: r.points, min: r.min, max: r.max, streak: r.streak, total: r.total });
});

// 等级 / 分组 / 标签目录（只读，供第三方展示映射用；只给名称等级，不给内部权限）
router.get('/v1/levels', requireApiKey('users:read'), (req, res) => {
  if (req.isSandbox) return res.json({ _sandbox: true, data: [{ grp: 'user', num: 3, name: '认证用户', badge: '✅', level_tag: 'U3' }] });
  const rows = db.prepare('SELECT grp,num,name,badge,descr FROM user_levels ORDER BY grp,num').all();
  res.json({ total: rows.length, data: rows.map(l => ({ ...l, level_tag: (l.grp === 'admin' ? 'A' : 'U') + l.num })) });
});
router.get('/v1/groups', requireApiKey('users:read'), (req, res) => {
  if (req.isSandbox) return res.json({ _sandbox: true, data: [{ id: 'sb-g', name: '正式员工', color: '#0071E3' }] });
  res.json({ total: groups.all.all().length, data: groups.all.all().map(g => ({ id: g.id, name: g.name, color: g.color, user_count: g.user_count })) });
});
router.get('/v1/tags', requireApiKey('users:read'), (req, res) => {
  if (req.isSandbox) return res.json({ _sandbox: true, data: [{ id: 'sb-t', name: '北京', color: '#34C759' }] });
  res.json({ total: tags.all.all().length, data: tags.all.all().map(t => ({ id: t.id, name: t.name, color: t.color })) });
});
// 查某用户的分组 / 标签（组织维度，仅名称）
router.get('/v1/users/:uid/org', requireApiKey('users:read'), (req, res) => {
  if (req.isSandbox) return res.json({ _sandbox: true, group: { id: 'sb-g', name: '正式员工', color: '#0071E3' }, tags: [{ id: 'sb-t', name: '北京', color: '#34C759' }] });
  const u = findRealUserByUid(req.params.uid);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const g = u.group_id ? groups.get.get(u.group_id) : null;
  res.json({ group: g ? { id: g.id, name: g.name, color: g.color } : null, tags: tags.ofUser.all(u.id).map(t => ({ id: t.id, name: t.name, color: t.color })) });
});

// 盲盒目录（含各奖励项的展示名与概率权重，不含内部配置）
router.get('/v1/shop/blind-boxes', requireApiKey('shop:read'), (req, res) => {
  if (req.isSandbox) return res.json({ _sandbox: true, data: [{ id: 'sb-bb', name: '神秘盲盒', cost: 200, rewards: [{ label: '积分大奖', weight: 5 }, { label: '谢谢参与', weight: 20 }] }] });
  const boxes = db.prepare("SELECT id,name,icon,cost,stock,status FROM shop_goods WHERE is_blind_box=1 AND status='on' ORDER BY sort_weight DESC").all();
  const data = boxes.map(b => ({
    ...b,
    rewards: db.prepare('SELECT label,weight FROM blind_box_rewards WHERE goods_id=? ORDER BY weight DESC').all(b.id),
  }));
  res.json({ total: data.length, data });
});

// 积分排行榜（默认前 20，最多 100；排除公共账号）
router.get('/v1/points/leaderboard', requireApiKey('points:read'), (req, res) => {
  if (req.isSandbox) return res.json({ _sandbox: true, data: [{ rank: 1, uid_seq: 1, name: '沙盒用户A', points: 9999 }] });
  const lim = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
  const rows = db.prepare("SELECT uid_seq,uid_code,name,points FROM users WHERE is_public=0 ORDER BY points DESC, uid_seq ASC LIMIT ?").all(lim);
  res.json({ total: rows.length, data: rows.map((r, i) => ({ rank: i + 1, uid_seq: r.uid_seq, uid_code: r.uid_code || null, name: r.name, points: r.points || 0 })) });
});

// 用户的商城兑换记录
router.get('/v1/users/:uid/shop/records', requireApiKey('shop:read'), (req, res) => {
  if (req.isSandbox) return res.json({ _sandbox: true, total: 1, data: [{ goods_name: '沙盒商品', cost: 100, status: 'done', created_at: '2026-01-01 10:00:00' }] });
  const u = findRealUserByUid(req.params.uid);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const rows = db.prepare("SELECT goods_id,goods_name,goods_icon,cost,status,created_at FROM shop_records WHERE user_id=? ORDER BY created_at DESC LIMIT 100").all(u.id);
  res.json({ total: rows.length, data: rows });
});

// 代用户兑换商品 / 开盲盒（扣积分 + 减库存 + 发券；盲盒走加权随机，即开则当场结算）
router.post('/v1/users/:uid/shop/exchange/:goods_id', requireApiKey('shop:write'), (req, res) => {
  if (req.isSandbox) return res.json({ _sandbox: true, success: true, remain: 900, type: 'coupon', coupon: { code: 'SB-DEMO-0001', goods_name: '沙盒商品', allow_instant: 1 } });
  const u = findRealUserByUid(req.params.uid);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const goods = db.prepare('SELECT * FROM shop_goods WHERE id=?').get(req.params.goods_id);
  const r = performExchange(u, goods);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const { ok, ...rest } = r;
  res.json({ success: true, ...rest });
});

// ══════════════════════════════════════════════════════════
// 身份核验（v3.5.12）：核验员扫对方动态码 → 返回脱敏身份卡
// ══════════════════════════════════════════════════════════
function maskPersonName(name) {
  const chars = [...String(name || '').trim()];
  if (chars.length <= 1) return chars.join('');
  if (chars.length === 2) return chars[0] + '*';
  return chars[0] + '*'.repeat(chars.length - 2) + chars[chars.length - 1];
}
function maskValue(v) {
  const s = String(v || '');
  if (s.length <= 1) return s ? '*' : '';
  if (s.length === 2) return s[0] + '*';
  return s[0] + '*'.repeat(Math.max(1, s.length - 2)) + s[s.length - 1];
}
function verifyNowInRange(from, to) {
  const now = new Date();
  if (from && new Date(String(from).replace(' ', 'T')) > now) return false;
  if (to && new Date(String(to).replace(' ', 'T')) < now) return false;
  return true;
}
// 返回 { ok, admin, subjectId } 或 { ok:false }
function verifierOf(req) {
  const u = users.findById.get(req.user.uid);
  if (u && u.role === 'admin') return { ok: true, admin: true, subjectId: null };
  const active = verify.verifiersOfUser.all(req.user.uid).find(r => verifyNowInRange(r.valid_from, r.valid_to));
  return active ? { ok: true, admin: false, subjectId: active.subject_id || null } : { ok: false };
}
function buildVerifyCard(user) {
  const orgs = orgMembers.ofUser.all(user.id) || [];
  const g = user.group_id ? groups.get.get(user.group_id) : null;
  const vals = {}; verify.valuesOfUser.all(user.id).forEach(r => { vals[r.field_id] = r.value; });
  const fields = verify.fieldsEnabled.all().map(f => {
    let v = vals[f.id] || '';
    if (f.kind === 'date' && v) v = String(v).slice(0, 7);          // 生日只给年-月
    if (f.masked && v) v = maskValue(v);
    return { label: f.label, value: v };
  }).filter(f => f.value);
  return {
    name_masked: maskPersonName(user.name), uid: user.uid_code || ('#' + String(user.uid_seq || '').padStart(5, '0')),
    subject: orgs.length ? orgs[0].name : null, group: g ? g.name : null, fields,
  };
}
// 本人是否为核验员（前端据此点亮「身份核验」菜单）
router.get('/user/verify/status', requireAuth, (req, res) => {
  res.json({ success: true, verifier: verifierOf(req).ok });
});
// 扫码核验：核验员扫对方动态码（qr1，只读不消耗）
router.post('/verify/scan', requireAuth, noPublic, (req, res) => {
  const vr = verifierOf(req);
  if (!vr.ok) return res.status(403).json({ error: '你没有身份核验权限' });
  const code = String(req.body?.code || '').trim();
  if (!code.startsWith('qr1.')) return res.status(400).json({ error: '请扫描用户的动态身份码（门禁同款码）' });
  const parsed = accessCore.verifyQr(code, { consume: false });
  if (!parsed.ok) return res.json({ ok: false, reason: parsed.reason, reason_text: accessCore.REASON_LABEL[parsed.reason] || parsed.reason });
  const user = users.findById.get(parsed.payload.u);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (vr.subjectId && !orgMembers.get.get(vr.subjectId, user.id)) return res.json({ ok: false, error: '对方不在你可核验的组织内' });
  audit('verify.checked', { subject: String(user.uid_seq), actor: 'verifier:' + req.user.uid });
  res.json({ ok: true, card: buildVerifyCard(user) });
});

// ── 管理端：核验字段 ──
router.get('/admin/verify/fields', requireAdmin(3), (req, res) => {
  res.json({ success: true, fields: verify.fieldsAll.all() });
});
router.post('/admin/verify/fields', requireAdmin(2), (req, res) => {
  const label = String(req.body?.label || '').trim();
  if (!label) return res.status(400).json({ error: '请填写字段名称' });
  let key = String(req.body?.field_key || '').trim().replace(/[^a-zA-Z0-9_]/g, '') || ('f_' + Date.now().toString(36));
  if (verify.fieldByKey.get(key)) return res.status(409).json({ error: '字段标识已存在' });
  const id = uuidv4();
  verify.insertField.run({ id, field_key: key, label: label.slice(0, 40),
    kind: ['text', 'date'].includes(req.body?.kind) ? req.body.kind : 'text',
    masked: req.body?.masked ? 1 : 0, sort_order: parseInt(req.body?.sort_order, 10) || 0, enabled: req.body?.enabled === false ? 0 : 1 });
  res.json({ success: true, id });
});
router.patch('/admin/verify/fields/:id', requireAdmin(2), (req, res) => {
  const f = verify.fieldGet.get(req.params.id);
  if (!f) return res.status(404).json({ error: '字段不存在' });
  verify.updateField.run({ id: f.id,
    label: req.body?.label != null ? String(req.body.label).trim().slice(0, 40) : f.label,
    kind: ['text', 'date'].includes(req.body?.kind) ? req.body.kind : f.kind,
    masked: req.body?.masked != null ? (req.body.masked ? 1 : 0) : f.masked,
    sort_order: req.body?.sort_order != null ? (parseInt(req.body.sort_order, 10) || 0) : f.sort_order,
    enabled: req.body?.enabled != null ? (req.body.enabled ? 1 : 0) : f.enabled });
  res.json({ success: true });
});
router.delete('/admin/verify/fields/:id', requireAdmin(2), (req, res) => {
  verify.removeValuesByField.run(req.params.id);
  verify.removeField.run(req.params.id);
  res.json({ success: true });
});

// ── 管理端：核验员授权 ──
router.get('/admin/verify/verifiers', requireAdmin(3), (req, res) => {
  res.json({ success: true, verifiers: verify.verifiersAll.all() });
});
router.post('/admin/verify/verifiers', requireAdmin(2), (req, res) => {
  const u = resolveUser(String(req.body?.account || '').trim());
  if (!u || u === AMBIGUOUS) return res.status(404).json({ error: u === AMBIGUOUS ? '账号不唯一，请用邮箱/手机/UID' : '用户不存在' });
  const okDT = s => s === '' || /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2})?$/.test(s);
  const vf = String(req.body?.valid_from || '').trim(), vt = String(req.body?.valid_to || '').trim();
  if (!okDT(vf) || !okDT(vt)) return res.status(400).json({ error: '时间格式应为 YYYY-MM-DD[ HH:MM]' });
  const sid = req.body?.subject_id && oauthSubjects.get.get(req.body.subject_id) ? req.body.subject_id : null;
  const id = uuidv4();
  verify.insertVerifier.run({ id, user_id: u.id, subject_id: sid, valid_from: vf, valid_to: vt, note: String(req.body?.note || '').trim().slice(0, 100) });
  res.json({ success: true, id });
});
router.delete('/admin/verify/verifiers/:id', requireAdmin(2), (req, res) => {
  verify.removeVerifier.run(req.params.id);
  res.json({ success: true });
});

// ── 管理端：某用户的核验字段值 ──
router.get('/admin/verify/values/:uid', requireAdmin(3), (req, res) => {
  const u = findRealUserByUid(req.params.uid);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const values = {}; verify.valuesOfUser.all(u.id).forEach(r => { values[r.field_id] = r.value; });
  res.json({ success: true, user: { name: u.name, uid_seq: u.uid_seq }, fields: verify.fieldsAll.all(), values });
});
router.put('/admin/verify/values/:uid', requireAdmin(2), (req, res) => {
  const u = findRealUserByUid(req.params.uid);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const vals = req.body?.values || {};
  db.transaction(() => {
    for (const f of verify.fieldsAll.all()) {
      const v = vals[f.id];
      if (v != null && String(v).trim() !== '') verify.setValue.run(u.id, f.id, String(v).trim().slice(0, 200));
      else verify.delValue.run(u.id, f.id);
    }
  })();
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════
// 门禁（v3.5.0）：动态二维码 + 授权规则（拒绝优先）+ 设备校验 + 通行记录
// ══════════════════════════════════════════════════════════
function accessClientIp(req) {
  return (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.ip || '';
}
function writeAccessLog({ door, user, method, ev, ip, name }) {
  const uname = user ? user.name : (name || null);
  try {
    access.insertLog.run({
      id: uuidv4(),
      door_id:   door ? door.id : null,
      door_name: door ? door.name : null,
      user_id:   user ? user.id : null,
      user_name: uname,
      uid_seq:   user ? user.uid_seq : null,
      method:    method || 'qr',
      result:    ev.allow ? 'allow' : 'deny',
      reason:    ev.reason || '',
      ip:        ip || '',
    });
  } catch (_) {}
  try {
    audit(ev.allow ? 'access.granted' : 'access.denied', {
      subject: user ? String(user.uid_seq) : (name ? ('访客:' + name) : ''),
      actor: 'door:' + (door ? door.id : '?'),
      detail: { door: door ? door.name : '', method: method || 'qr', reason: ev.reason },
    });
  } catch (_) {}
}
// 规则展示标签（best-effort，随渲染实时解析，避免存储名改了对不上）
function accessRuleLabel(type, value) {
  try {
    switch (type) {
      case 'all':   return '所有登录用户';
      case 'user': { const u = findRealUserByUid(value); return u ? `${u.name}（#${String(u.uid_seq).padStart(5, '0')}）` : ('用户 ' + value); }
      case 'group': { const g = groups.get.get(value); return g ? ('分组：' + g.name) : ('分组 ' + value); }
      case 'tag':   { const t = tags.get.get(value); return t ? ('标签：' + t.name) : ('标签 ' + value); }
      case 'level': return '等级：' + String(value).toUpperCase();
      case 'org':   { const s = oauthSubjects.get.get(value); return s ? ('组织：' + s.name) : ('组织 ' + value); }
      default:      return String(value);
    }
  } catch (_) { return String(value); }
}
const ACCESS_GRANT_TYPES = ['all', 'org', 'group', 'tag', 'level', 'user'];
const okHHMM = s => s === '' || /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s || '').trim());
function safeWeekdays(s) {
  return String(s || '').split(/[，,]/).map(x => x.trim()).filter(x => /^[0-6]$/.test(x)).join(',');
}

// ── 用户端：出示动态开门码 / 查我能开的门 ──
router.post('/user/access/qr', requireAuth, (req, res) => {
  const u = users.findById.get(req.user.uid);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (u.status && u.status !== 'active') return res.status(403).json({ error: '账号已被禁用' });
  const r = accessCore.signQr(u);
  res.json({ success: true, code: r.code, expires_in: r.expires_in, exp: r.exp });
});
router.get('/user/access/doors', requireAuth, (req, res) => {
  const u = users.findById.get(req.user.uid);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  res.json({ success: true, doors: accessCore.doorsForUser(u) });
});

// ── 管理端：门 CRUD ──
router.get('/admin/access/doors', requireAdmin(3), (req, res) => {
  const rows = access.allDoors.all().map(d => ({
    ...d,
    rule_count: access.countRulesByDoor.get(d.id).n,
    subject_name: d.subject_id ? (oauthSubjects.get.get(d.subject_id)?.name || null) : null,
  }));
  res.json({ success: true, doors: rows });
});
router.post('/admin/access/doors', requireAdmin(2), (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: '请填写门/通道名称' });
  const id = uuidv4();
  const status = ['enabled', 'disabled'].includes(req.body?.status) ? req.body.status : 'enabled';
  access.insertDoor.run({
    id, name: name.slice(0, 60),
    location: String(req.body?.location || '').trim().slice(0, 120),
    subject_id: req.body?.subject_id || null,
    status, note: String(req.body?.note || '').trim().slice(0, 300),
  });
  res.json({ success: true, door: access.doorById.get(id) });
});
router.patch('/admin/access/doors/:id', requireAdmin(2), (req, res) => {
  const d = access.doorById.get(req.params.id);
  if (!d) return res.status(404).json({ error: '门不存在' });
  const name = req.body?.name != null ? String(req.body.name).trim().slice(0, 60) : d.name;
  if (!name) return res.status(400).json({ error: '名称不能为空' });
  access.updateDoor.run({
    id: d.id, name,
    location: req.body?.location != null ? String(req.body.location).trim().slice(0, 120) : d.location,
    subject_id: req.body?.subject_id !== undefined ? (req.body.subject_id || null) : d.subject_id,
    status: ['enabled', 'disabled'].includes(req.body?.status) ? req.body.status : d.status,
    note: req.body?.note != null ? String(req.body.note).trim().slice(0, 300) : d.note,
  });
  res.json({ success: true, door: access.doorById.get(d.id) });
});
router.delete('/admin/access/doors/:id', requireAdmin(2), (req, res) => {
  access.removeRulesByDoor.run(req.params.id);
  access.removeDoor.run(req.params.id);
  res.json({ success: true });
});

// ── 管理端：授权规则 ──
router.get('/admin/access/doors/:id/rules', requireAdmin(3), (req, res) => {
  if (!access.doorById.get(req.params.id)) return res.status(404).json({ error: '门不存在' });
  const rules = access.rulesByDoor.all(req.params.id).map(r => ({ ...r, label: accessRuleLabel(r.grant_type, r.grant_value) }));
  res.json({ success: true, rules });
});
router.post('/admin/access/doors/:id/rules', requireAdmin(2), (req, res) => {
  const door = access.doorById.get(req.params.id);
  if (!door) return res.status(404).json({ error: '门不存在' });
  const grant_type = req.body?.grant_type;
  if (!ACCESS_GRANT_TYPES.includes(grant_type)) return res.status(400).json({ error: 'grant_type 不合法' });
  let grant_value = String(req.body?.grant_value || '').trim();
  if (grant_type !== 'all' && !grant_value) return res.status(400).json({ error: '请选择授权对象' });
  if (grant_type === 'all') grant_value = '';
  if (grant_type === 'level' && !/^[UA][1-9]$/i.test(grant_value)) return res.status(400).json({ error: '等级格式应为 U1~U9 / A1~A9' });
  const effect = ['allow', 'deny'].includes(req.body?.effect) ? req.body.effect : 'allow';
  const time_start = String(req.body?.time_start || '').trim();
  const time_end = String(req.body?.time_end || '').trim();
  if (!okHHMM(time_start) || !okHHMM(time_end)) return res.status(400).json({ error: '时段格式应为 HH:MM' });
  const okDate = s => s === '' || /^\d{4}-\d{2}-\d{2}$/.test(s);
  const valid_from = String(req.body?.valid_from || '').trim().slice(0, 10);
  const valid_to = String(req.body?.valid_to || '').trim().slice(0, 10);
  if (!okDate(valid_from) || !okDate(valid_to)) return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD' });
  const id = uuidv4();
  access.insertRule.run({
    id, door_id: door.id, grant_type, grant_value: grant_type === 'level' ? grant_value.toUpperCase() : grant_value,
    effect, weekdays: safeWeekdays(req.body?.weekdays), time_start, time_end, valid_from, valid_to,
    label: accessRuleLabel(grant_type, grant_value),
  });
  res.json({ success: true, rule: { ...access.rulesByDoor.all(door.id).find(r => r.id === id) } });
});
router.delete('/admin/access/doors/:id/rules/:rid', requireAdmin(2), (req, res) => {
  access.removeRule.run(req.params.rid, req.params.id);
  res.json({ success: true });
});

// ── 管理端：通行记录 ──
router.get('/admin/access/logs', requireAdmin(3), (req, res) => {
  const lim = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 500);
  const rows = req.query.door_id ? access.logsByDoor.all(req.query.door_id, lim) : access.logsAll.all(lim);
  res.json({ success: true, total: rows.length, data: rows });
});

// ── 管理端：实体卡 / NFC 绑定 ──
router.get('/admin/access/cards', requireAdmin(3), (req, res) => {
  res.json({ success: true, cards: access.allCards.all() });
});
// 随机生成一个未被占用的卡号（10 位十六进制，大写）
router.get('/admin/access/cards/gen', requireAdmin(2), (req, res) => {
  const crypto = require('crypto');
  let card_no = '';
  for (let i = 0; i < 20; i++) {
    const c = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 位
    if (!access.cardByNo.get(c)) { card_no = c; break; }
  }
  if (!card_no) return res.status(500).json({ error: '生成失败，请重试' });
  res.json({ success: true, card_no });
});
router.post('/admin/access/cards', requireAdmin(2), (req, res) => {
  const card_no = String(req.body?.card_no || '').trim();
  const account = String(req.body?.account || '').trim();
  if (!card_no || !account) return res.status(400).json({ error: '卡号和用户账号必填' });
  if (access.cardByNo.get(card_no)) return res.status(409).json({ error: '该卡号已绑定' });
  const u = resolveUser(account);
  if (!u || u === AMBIGUOUS) return res.status(404).json({ error: u === AMBIGUOUS ? '账号不唯一，请用邮箱/手机/UID' : '用户不存在' });
  const id = uuidv4();
  access.insertCard.run({ id, card_no, user_id: u.id, label: String(req.body?.label || '').trim().slice(0, 60), status: 'active' });
  res.json({ success: true, id });
});
router.patch('/admin/access/cards/:id', requireAdmin(2), (req, res) => {
  const status = ['active', 'disabled'].includes(req.body?.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: 'status 只能是 active / disabled' });
  access.setCardStatus.run(status, req.params.id);
  res.json({ success: true });
});
router.delete('/admin/access/cards/:id', requireAdmin(2), (req, res) => {
  access.removeCard.run(req.params.id);
  res.json({ success: true });
});

// ── 人脸录入（独立于 KYC；自愿、可删；系统只存+下发，比对在门禁人脸一体机本地做）──
// 用户端：查状态 / 录入（原始字节）/ 预览 / 删除
router.get('/user/access/face', requireAuth, noPublic, (req, res) => {
  const f = access.faceMeta.get(req.user.uid);
  res.json({ success: true, enrolled: !!f, status: f?.status || null, updated_at: f?.updated_at || null });
});
router.get('/user/access/face/image', requireAuth, noPublic, (req, res) => {
  const f = access.faceGet.get(req.user.uid);
  if (!f || !f.data) return res.status(404).json({ error: '未录入人脸' });
  res.setHeader('Content-Type', f.mime || 'image/jpeg');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(Buffer.from(f.data));
});
router.post('/user/access/face', requireAuth, noPublic, express.raw({ type: () => true, limit: 12 * 1024 * 1024 }), (req, res) => {
  const buf = req.body;
  if (!buf || !buf.length) return res.status(400).json({ error: '空文件' });
  if (buf.length > maxAttachBytes()) return res.status(413).json({ error: `图片超过上限（${Math.round(maxAttachBytes() / 1048576)}MB）` });
  const filename = String(req.query.filename || 'face.jpg');
  const v = validateAttachment(filename, buf);
  if (!v.ok) return res.status(400).json({ error: v.error });
  if (v.kind !== 'image') return res.status(400).json({ error: '人脸只接受图片（png/jpg/webp 等）' });
  access.faceUpsert.run({ user_id: req.user.uid, mime: v.mime, size: buf.length, data: buf });
  const u = users.findById.get(req.user.uid);
  audit('access.face_enrolled', { subject: u ? String(u.uid_seq) : '', actor: actorOf(req), detail: { source: 'self' } });
  res.json({ success: true });
});
router.delete('/user/access/face', requireAuth, noPublic, (req, res) => {
  access.faceDelete.run(req.user.uid);
  const u = users.findById.get(req.user.uid);
  audit('access.face_deleted', { subject: u ? String(u.uid_seq) : '', actor: actorOf(req), detail: { source: 'self' } });
  res.json({ success: true });
});

// 管理端：人脸库（元数据列表 / 预览 / 删除 / 启停）
router.get('/admin/access/faces', requireAdmin(3), (req, res) => {
  res.json({ success: true, faces: access.facesAll.all() });
});
router.get('/admin/access/faces/:uid/image', requireAdmin(3), (req, res) => {
  const u = findRealUserByUid(req.params.uid);
  const f = u && access.faceGet.get(u.id);
  if (!f || !f.data) return res.status(404).json({ error: '未录入人脸' });
  res.setHeader('Content-Type', f.mime || 'image/jpeg');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(Buffer.from(f.data));
});
router.patch('/admin/access/faces/:uid', requireAdmin(2), (req, res) => {
  const status = ['active', 'disabled'].includes(req.body?.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: 'status 只能是 active / disabled' });
  const u = findRealUserByUid(req.params.uid);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  access.faceSetStatus.run(status, u.id);
  res.json({ success: true });
});
router.delete('/admin/access/faces/:uid', requireAdmin(2), (req, res) => {
  const u = findRealUserByUid(req.params.uid);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  access.faceDelete.run(u.id);
  audit('access.face_deleted', { subject: String(u.uid_seq), actor: actorOf(req), detail: { source: 'admin' } });
  res.json({ success: true });
});

// 开放 API：人脸一体机同步人脸库
router.get('/v1/access/faces', requireApiKey('access:read'), (req, res) => {
  if (req.isSandbox) return res.json({ total: 1, data: [{ uid_seq: 142, uid_code: null, name: '沙盒用户', updated_at: '2026-01-01 10:00:00' }], _sandbox: true });
  let rows = access.facesActive.all();
  const since = String(req.query.since || '').trim();
  if (since) rows = rows.filter(r => (r.updated_at || '') > since);   // 增量同步
  res.json({ total: rows.length, data: rows.map(r => ({ uid_seq: r.user_uid_seq, uid_code: r.user_uid_code || null, name: r.user_name, updated_at: r.updated_at })) });
});
router.get('/v1/access/faces/:uid/image', requireApiKey('access:read'), (req, res) => {
  if (req.isSandbox) return res.status(404).json({ error: '沙盒无图片', _sandbox: true });
  const u = findRealUserByUid(req.params.uid);
  const f = u && access.faceGet.get(u.id);
  if (!f || f.status !== 'active' || !f.data) return res.status(404).json({ error: '未录入人脸' });
  res.setHeader('Content-Type', f.mime || 'image/jpeg');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(Buffer.from(f.data));
});

// ── 访客通行码（主人邀请：管理员 + 分组/组织管理员可签发；记录签发人，可追溯）──
function canIssuePass(req) {
  if (req.user?.org_scoped) return myManagedOrgs(req).length > 0;   // 组织会话：仅当前组织的组织管理员
  if (req.user?.role === 'admin') return true;
  try {
    return groups.managedBy.all(req.user.uid).length > 0
        || oauthSubjects.managedBy.all(req.user.uid).length > 0;   // 组织管理员也可签发（v3.5.8）
  } catch (_) { return false; }
}
function genPassCode() { return 'VP-' + require('crypto').randomBytes(5).toString('hex').toUpperCase(); }
function passView(p) {
  const doorNames = String(p.door_ids || '').split(',').map(s => s.trim()).filter(Boolean)
    .map(id => access.doorById.get(id)?.name || id);
  return { ...p, door_names: doorNames };
}
router.get('/access/passes', requireAuth, (req, res) => {
  if (!canIssuePass(req)) return res.status(403).json({ error: '无签发访客码的权限' });
  const rows = req.user.role === 'admin' ? access.passAll.all() : access.passByIssuer.all(req.user.uid);
  res.json({ success: true, passes: rows.map(passView) });
});
router.post('/access/passes', requireAuth, (req, res) => {
  if (!canIssuePass(req)) return res.status(403).json({ error: '无签发访客码的权限' });
  const visitor_name = String(req.body?.visitor_name || '').trim();
  if (!visitor_name) return res.status(400).json({ error: '请填写访客姓名' });
  const doorIds = (Array.isArray(req.body?.door_ids) ? req.body.door_ids : [])
    .map(x => String(x).trim()).filter(id => access.doorById.get(id));   // 只保留存在的门
  if (!doorIds.length) return res.status(400).json({ error: '请至少选择一扇可通行的门' });
  const maxUses = Math.max(0, parseInt(req.body?.max_uses, 10) || 0);
  const me = users.findById.get(req.user.uid);
  const id = uuidv4(), code = genPassCode();
  access.insertPass.run({
    id, code, visitor_name: visitor_name.slice(0, 40),
    visitor_phone: String(req.body?.visitor_phone || '').trim().slice(0, 20),
    door_ids: doorIds.join(','),
    issued_by: req.user.uid, issued_by_name: me ? me.name : '',
    valid_from: String(req.body?.valid_from || '').trim().slice(0, 19),
    valid_to: String(req.body?.valid_to || '').trim().slice(0, 19),
    max_uses: maxUses, note: String(req.body?.note || '').trim().slice(0, 200),
  });
  audit('access.pass_issued', { subject: '访客:' + visitor_name, actor: actorOf(req), detail: { doors: doorIds.length, by: me ? me.name : '' } });
  res.json({ success: true, id, code });
});
router.delete('/access/passes/:id', requireAuth, (req, res) => {
  if (!canIssuePass(req)) return res.status(403).json({ error: '无权限' });
  const p = access.passById.get(req.params.id);
  if (!p) return res.status(404).json({ error: '访客码不存在' });
  if (req.user.role !== 'admin' && p.issued_by !== req.user.uid) return res.status(403).json({ error: '只能撤销自己签发的访客码' });
  access.revokePass.run(p.id);
  audit('access.pass_revoked', { subject: '访客:' + p.visitor_name, actor: actorOf(req) });
  res.json({ success: true });
});
// 公开：访客扫码页展示凭证信息（最小披露，不含签发人/电话）
router.get('/public/pass/:code', (req, res) => {
  const p = access.passByCode.get(String(req.params.code).trim());
  if (!p) return res.json({ ok: false });
  const doorNames = String(p.door_ids || '').split(',').map(s => s.trim()).filter(Boolean)
    .map(id => access.doorById.get(id)?.name || id);
  res.json({ ok: true, visitor_name: p.visitor_name, valid_from: p.valid_from, valid_to: p.valid_to,
    doors: doorNames, status: p.status, code: p.code, wallet: pkpass.isConfigured() });
});
// 访客码 → Apple Wallet（.pkpass）：iOS 打开此地址即可「添加到钱包」
const pkpass = require('./pkpass');
router.get('/public/pass/:code/pkpass', async (req, res) => {
  if (!pkpass.isConfigured()) return res.status(501).json({ error: '本系统未配置 Apple Wallet 证书' });
  const p = access.passByCode.get(String(req.params.code).trim());
  if (!p) return res.status(404).json({ error: '访客码不存在' });
  if (p.status !== 'active') return res.status(410).json({ error: '访客码已失效' });
  const doorNames = String(p.door_ids || '').split(',').map(s => s.trim()).filter(Boolean)
    .map(id => access.doorById.get(id)?.name || id);
  try {
    const buf = await pkpass.buildVisitorPass(p, doorNames);
    res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
    res.setHeader('Content-Disposition', `attachment; filename="pass-${p.code}.pkpass"`);
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 跨系统联邦（v3.5.5）：登记伙伴（共享密钥配对）+ 开放门集 + 签发跨域访客码 ──
function fedView(p) {
  const ids = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
  return {
    id: p.id, name: p.name, peer_code: p.peer_code, secret: p.secret, base_url: p.base_url,
    door_ids: ids(p.door_ids), app_ids: ids(p.app_ids),
    door_names: ids(p.door_ids).map(id => access.doorById.get(id)?.name || id),
    app_names: ids(p.app_ids).map(id => apps.findById.get(id)?.name || id),
    valid_until: p.valid_until, status: p.status, note: p.note, created_at: p.created_at,
  };
}
router.get('/admin/access/peers', requireAdmin(3), (req, res) => {
  res.json({ success: true, peers: access.fedAll.all().map(fedView) });
});
router.post('/admin/access/peers', requireAdmin(2), (req, res) => {
  const crypto = require('crypto');
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: '请填写伙伴名称' });
  const peer_code = String(req.body?.peer_code || '').trim() || ('fp_' + crypto.randomBytes(6).toString('hex'));
  if (access.fedByCode.get(peer_code)) return res.status(409).json({ error: '该 peer_code 已存在' });
  const secret = String(req.body?.secret || '').trim() || crypto.randomBytes(24).toString('hex');
  const doorIds = (Array.isArray(req.body?.door_ids) ? req.body.door_ids : []).map(x => String(x).trim()).filter(id => access.doorById.get(id));
  const appIds = (Array.isArray(req.body?.app_ids) ? req.body.app_ids : []).map(x => String(x).trim()).filter(id => apps.findById.get(id));
  const id = uuidv4();
  access.insertFed.run({
    id, name: name.slice(0, 60), peer_code, secret,
    base_url: String(req.body?.base_url || '').trim().slice(0, 200),
    door_ids: doorIds.join(','), app_ids: appIds.join(','),
    valid_until: String(req.body?.valid_until || '').trim().slice(0, 19),
    note: String(req.body?.note || '').trim().slice(0, 200),
  });
  res.json({ success: true, id, peer: fedView(access.fedById.get(id)) });
});
router.patch('/admin/access/peers/:id', requireAdmin(2), (req, res) => {
  const p = access.fedById.get(req.params.id);
  if (!p) return res.status(404).json({ error: '伙伴不存在' });
  const doorIds = req.body?.door_ids !== undefined
    ? (Array.isArray(req.body.door_ids) ? req.body.door_ids : []).map(x => String(x).trim()).filter(id => access.doorById.get(id)).join(',')
    : p.door_ids;
  const appIds = req.body?.app_ids !== undefined
    ? (Array.isArray(req.body.app_ids) ? req.body.app_ids : []).map(x => String(x).trim()).filter(id => apps.findById.get(id)).join(',')
    : p.app_ids;
  access.updateFed.run({
    id: p.id,
    name: req.body?.name != null ? String(req.body.name).trim().slice(0, 60) : p.name,
    base_url: req.body?.base_url != null ? String(req.body.base_url).trim().slice(0, 200) : p.base_url,
    door_ids: doorIds, app_ids: appIds,
    valid_until: req.body?.valid_until != null ? String(req.body.valid_until).trim().slice(0, 19) : p.valid_until,
    status: ['active', 'disabled'].includes(req.body?.status) ? req.body.status : p.status,
    note: req.body?.note != null ? String(req.body.note).trim().slice(0, 200) : p.note,
  });
  res.json({ success: true, peer: fedView(access.fedById.get(p.id)) });
});
router.delete('/admin/access/peers/:id', requireAdmin(2), (req, res) => {
  const p = access.fedById.get(req.params.id);
  // 主动推送：撤销该伙伴 = 停用其所有临期账号，推给该伙伴开放过的应用（sub 前缀 fed:<peer_code>:）
  if (p) {
    for (const aid of String(p.app_ids || '').split(',').map(s => s.trim()).filter(Boolean)) {
      deprovisionPush(apps.findById.get(aid), { event: 'federation.revoked', peer_code: p.peer_code, sub_prefix: 'fed:' + p.peer_code + ':' });
    }
  }
  access.removeFed.run(req.params.id);
  res.json({ success: true });
});

// ── 联邦配对（v3.5.9）：生成跨域码 / 粘贴兑换 / 推送到伙伴域 ──
function thisBaseUrl(req) { return (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, ''); }
function hostOf(u) { try { return new URL(/^https?:\/\//.test(u) ? u : 'https://' + u).hostname.toLowerCase(); } catch (_) { return ''; } }
// 可用域白名单（env FED_ALLOWED_DOMAINS，逗号分隔域名/后缀；空=不接受任何推送）
function fedAllowedDomains() {
  return String(process.env.FED_ALLOWED_DOMAINS || '').split(/[，,]/).map(s => s.trim().toLowerCase().replace(/^\.+/, '')).filter(Boolean);
}
function fedDomainAllowed(domainOrUrl) {
  const host = hostOf(domainOrUrl); if (!host) return false;
  return fedAllowedDomains().some(d => host === d || host.endsWith('.' + d));
}
function genPeerPair() {
  const c = require('crypto');
  return { peer_code: 'fp_' + c.randomBytes(6).toString('hex'), secret: c.randomBytes(24).toString('hex') };
}
// 生成跨域码：本系统建一个 peer（代表对方），返回可交给对方粘贴/推送的 pc1 码
router.post('/admin/access/peers/pair-code', requireAdmin(2), (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: '请填写伙伴名称' });
  const { peer_code, secret } = genPeerPair();
  const doorIds = (Array.isArray(req.body?.door_ids) ? req.body.door_ids : []).map(x => String(x).trim()).filter(id => access.doorById.get(id));
  const appIds = (Array.isArray(req.body?.app_ids) ? req.body.app_ids : []).map(x => String(x).trim()).filter(id => apps.findById.get(id));
  const id = uuidv4();
  access.insertFed.run({
    id, name: name.slice(0, 60), peer_code, secret,
    base_url: String(req.body?.b_domain || '').trim().replace(/\/+$/, ''),
    door_ids: doorIds.join(','), app_ids: appIds.join(','),
    valid_until: String(req.body?.valid_until || '').trim().slice(0, 19), note: '',
  });
  const pair_code = accessCore.makePairCode({ peer_code, secret, domain: thisBaseUrl(req) });
  res.json({ success: true, id, peer_code, pair_code });
});
// 粘贴兑换：管理员亲自粘贴对方给的 pc1 码建立对等关系（不校验白名单——管理员亲自操作）
router.post('/admin/access/peers/redeem', requireAdmin(2), (req, res) => {
  const parsed = accessCore.parsePairCode(String(req.body?.pair_code || '').trim());
  if (!parsed) return res.status(400).json({ error: '跨域码无效' });
  if (access.fedByCode.get(parsed.peer_code)) return res.status(409).json({ error: '该伙伴已存在（peer_code 重复）' });
  const id = uuidv4();
  const name = String(req.body?.name || '').trim() || hostOf(parsed.domain) || '联邦伙伴';
  access.insertFed.run({
    id, name: name.slice(0, 60), peer_code: parsed.peer_code, secret: parsed.secret,
    base_url: (parsed.domain || '').replace(/\/+$/, ''), door_ids: '', app_ids: '', valid_until: '', note: '',
  });
  res.json({ success: true, id, peer: fedView(access.fedById.get(id)) });
});
// 推送到伙伴域：把某 peer 的配对码直接 POST 给对方的 /fed/pair/receive（对方按其可用域白名单决定是否接受）
router.post('/admin/access/peers/:id/push', requireAdmin(2), async (req, res) => {
  const p = access.fedById.get(req.params.id);
  if (!p) return res.status(404).json({ error: '伙伴不存在' });
  const bDomain = String(req.body?.b_domain || p.base_url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(bDomain)) return res.status(400).json({ error: '请填写伙伴域地址（https://…）' });
  const pair_code = accessCore.makePairCode({ peer_code: p.peer_code, secret: p.secret, domain: thisBaseUrl(req) });
  try {
    const r = await fetch(bDomain.replace(/\/+$/, '') + '/fed/pair/receive', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pair_code, from: thisBaseUrl(req) }),
    });
    const d = await r.json().catch(() => ({}));
    if (p.base_url !== bDomain) access.updateFed.run({ id: p.id, name: p.name, base_url: bDomain, door_ids: p.door_ids, app_ids: p.app_ids, valid_until: p.valid_until, status: p.status, note: p.note });
    if (!r.ok) return res.status(502).json({ error: '对方拒绝：' + (d.error || ('HTTP ' + r.status)) });
    res.json({ success: true, result: d });
  } catch (e) { res.status(502).json({ error: '无法连接伙伴域：' + e.message }); }
});

// 签发跨域访客码（我方作为签发方，对某伙伴签发）：管理员 / 分组管理员
router.post('/access/peers/:id/issue', requireAuth, (req, res) => {
  if (!canIssuePass(req)) return res.status(403).json({ error: '无签发权限' });
  const p = access.fedById.get(req.params.id);
  if (!p) return res.status(404).json({ error: '伙伴不存在' });
  if (p.status !== 'active') return res.status(400).json({ error: '该伙伴已停用' });
  const visitor = String(req.body?.visitor_name || '').trim();
  if (!visitor) return res.status(400).json({ error: '请填写访客姓名' });
  const ttl = Math.min(Math.max(parseInt(req.body?.ttl_hours, 10) || 24, 1), 24 * 30) * 3600;
  const { code, exp } = accessCore.signFedCode(p.peer_code, p.secret, visitor, ttl);
  audit('access.fed_issued', { subject: '跨域访客:' + visitor, actor: actorOf(req), detail: { peer: p.name } });
  res.json({ success: true, code, exp });
});

// ── 跨域应用登录·B 侧（v3.5.7）：登记伙伴(A)开放给我们的应用 + 用户一键跳转登录 ──
router.get('/admin/fed-apps', requireAdmin(3), (req, res) => {
  res.json({ success: true, apps: access.fedAppsAll.all() });
});
router.post('/admin/fed-apps', requireAdmin(2), (req, res) => {
  const peer = access.fedById.get(String(req.body?.peer_id || ''));
  if (!peer) return res.status(400).json({ error: '请选择有效的联邦伙伴' });
  const app_client_id = String(req.body?.app_client_id || '').trim();
  const callback_url = String(req.body?.callback_url || '').trim();
  const a_base_url = String(req.body?.a_base_url || peer.base_url || '').trim().replace(/\/+$/, '');
  if (!app_client_id || !callback_url || !a_base_url) return res.status(400).json({ error: '伙伴域地址 / 应用 client_id / 回调地址 必填' });
  if (!/^https?:\/\//.test(a_base_url) || !/^https?:\/\//.test(callback_url)) return res.status(400).json({ error: '地址需为 http(s)' });
  const id = uuidv4();
  access.fedAppInsert.run({
    id, peer_id: peer.id, a_base_url, app_client_id,
    app_name: String(req.body?.app_name || '').trim().slice(0, 60) || app_client_id,
    callback_url, scope: String(req.body?.scope || 'openid profile email').trim().slice(0, 200),
  });
  res.json({ success: true, id });
});
router.delete('/admin/fed-apps/:id', requireAdmin(2), (req, res) => {
  access.fedAppRemove.run(req.params.id);
  res.json({ success: true });
});
// 用户可见的伙伴应用
router.get('/user/fed-apps', requireAuth, (req, res) => {
  res.json({ success: true, apps: access.fedAppsAll.all().map(a => ({ id: a.id, app_name: a.app_name, peer_name: a.peer_name, a_base_url: a.a_base_url })) });
});
// 一键跳转登录：本系统给当前用户签联邦令牌，拼伙伴(A)的 /fed/launch 地址返回，前端跳转
router.post('/user/fed-apps/:id/launch', requireAuth, noPublic, (req, res) => {
  const fa = access.fedAppById.get(req.params.id);
  if (!fa) return res.status(404).json({ error: '伙伴应用不存在' });
  const peer = access.fedById.get(fa.peer_id);
  if (!peer || peer.status !== 'active') return res.status(400).json({ error: '联邦伙伴不可用' });
  const u = users.findById.get(req.user.uid);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const { token } = accessCore.signFedLaunch(peer.peer_code, peer.secret,
    { sub: u.uid_code || String(u.uid_seq), name: u.name, email: u.email, app: fa.app_client_id }, 300);
  const url = new URL(fa.a_base_url.replace(/\/+$/, '') + '/fed/launch');
  url.searchParams.set('peer', peer.peer_code);
  url.searchParams.set('token', token);
  url.searchParams.set('app', fa.app_client_id);
  url.searchParams.set('redirect_uri', fa.callback_url);
  url.searchParams.set('scope', fa.scope || 'openid profile email');
  res.json({ success: true, url: url.toString() });
});

// ── 系统版本更新（v3.5.6）──
const updater = require('./updater');
router.get('/admin/version', requireAdmin(3), async (req, res) => {
  const info = await updater.checkUpdate({ force: req.query.force === '1' });
  res.json({ success: true, ...info, selfhost_update: updater.selfhostEnabled() });
});
// 自托管一键更新：仅超管 + env SELFHOST_UPDATE=on；先备份 db 再 git pull + npm ci
router.post('/admin/version/apply', requireAdmin(1), async (req, res) => {
  if (!updater.selfhostEnabled()) return res.status(403).json({ error: '未开启自托管更新（线上 Zeabur 靠 git push 部署，不适用一键拉取）' });
  const r = await updater.applyUpdate();
  audit('system.update_applied', { actor: actorOf(req), detail: { ok: r.ok, restart: !!r.restart } });
  res.json({ success: r.ok, ...r });
});

// ── 开放 API：门禁设备接入 ──
// 扫动态码开门：设备读到二维码内容后调此接口；code 一次性消费防重放。
router.post('/v1/access/verify', requireApiKey('access:verify'), (req, res) => {
  if (req.isSandbox) return res.json({ ...SANDBOX.accessVerify(), _sandbox: true });
  const { door_id, code } = req.body || {};
  if (!door_id || !code) return res.status(400).json({ error: 'door_id 和 code 必填' });
  const door = access.doorById.get(door_id);
  if (!door) return res.status(404).json({ error: '门不存在' });
  const ip = accessClientIp(req);
  // 跨系统联邦码（ft1. 开头）：伙伴系统签发的跨域访客码，用登记的共享密钥验签
  if (String(code).startsWith('ft1.')) {
    const parsed = accessCore.fedParse(code);
    const peer = parsed && access.fedByCode.get(parsed.iss);
    let ev;
    if (!peer) ev = { allow: false, reason: 'fed_unknown' };
    else if (!accessCore.fedVerifySig(parsed.body, parsed.sig, peer.secret)) ev = { allow: false, reason: 'fed_bad_sig' };
    else ev = accessCore.evaluateFed(parsed, peer, door);
    const vname = (parsed?.v || '访客') + (peer ? ('@' + peer.name) : '');
    writeAccessLog({ door, user: null, method: 'federation', ev, ip, name: vname });
    return res.json({
      allow: ev.allow, result: ev.allow ? 'allow' : 'deny',
      reason: ev.reason, reason_text: accessCore.REASON_LABEL[ev.reason] || ev.reason,
      visitor: { name: parsed?.v || null, from: peer ? peer.name : null },
      door: { id: door.id, name: door.name },
    });
  }
  // 访客通行码（非 qr1./ft1. 开头）：静态时限凭证，不走一次性消费
  if (!String(code).startsWith('qr1.')) {
    const pass = access.passByCode.get(String(code).trim());
    const ev = accessCore.evaluatePass(pass, door);
    if (ev.allow) access.bumpPassUse.run(pass.id);
    writeAccessLog({ door, user: null, method: 'visitor', ev, ip, name: pass ? pass.visitor_name : null });
    return res.json({
      allow: ev.allow, result: ev.allow ? 'allow' : 'deny',
      reason: ev.reason, reason_text: accessCore.REASON_LABEL[ev.reason] || ev.reason,
      visitor: pass ? { name: pass.visitor_name, remaining: pass.max_uses > 0 ? Math.max(0, pass.max_uses - pass.used_count - (ev.allow ? 1 : 0)) : null } : null,
      door: { id: door.id, name: door.name },
    });
  }
  // 用户动态开门码（一次性消费）
  const vr = accessCore.verifyQr(code, { consume: true });
  if (!vr.ok) {
    const ev = { allow: false, reason: vr.reason };
    writeAccessLog({ door, user: null, method: 'qr', ev, ip });
    return res.json({ allow: false, result: 'deny', reason: vr.reason, reason_text: accessCore.REASON_LABEL[vr.reason] || vr.reason, door: { id: door.id, name: door.name } });
  }
  const user = users.findById.get(vr.payload.u);
  const ev = accessCore.evaluateAccess(user, door);
  writeAccessLog({ door, user, method: 'qr', ev, ip });
  res.json({
    allow: ev.allow, result: ev.allow ? 'allow' : 'deny',
    reason: ev.reason, reason_text: accessCore.REASON_LABEL[ev.reason] || ev.reason,
    user: user ? { uid_seq: user.uid_seq, uid_code: user.uid_code || null, name: user.name } : null,
    door: { id: door.id, name: door.name },
  });
});
// 直查校验（刷卡/人脸等）：设备解析出 card_no（实体卡/NFC）或 uid 后调。
router.post('/v1/access/check', requireApiKey('access:verify'), (req, res) => {
  if (req.isSandbox) return res.json({ ...SANDBOX.accessVerify(), _sandbox: true });
  const { door_id, uid, card_no, method } = req.body || {};
  if (!door_id || (!uid && !card_no)) return res.status(400).json({ error: 'door_id 必填，且 uid / card_no 至少一个' });
  const door = access.doorById.get(door_id);
  if (!door) return res.status(404).json({ error: '门不存在' });
  const ip = accessClientIp(req);
  let user = null, reasonNoUser = 'no_user';
  let m = method;
  if (card_no) {
    m = m || 'card';
    const card = access.cardByNo.get(String(card_no).trim());
    if (card && card.status === 'active') user = users.findById.get(card.user_id);
    else reasonNoUser = 'card_unknown';   // 卡未绑定或已停用
  } else {
    user = findRealUserByUid(uid);
  }
  m = ['card', 'face', 'remote', 'qr'].includes(m) ? m : 'card';
  const ev = user ? accessCore.evaluateAccess(user, door) : { allow: false, reason: reasonNoUser };
  writeAccessLog({ door, user, method: m, ev, ip });
  res.json({
    allow: ev.allow, result: ev.allow ? 'allow' : 'deny',
    reason: ev.reason, reason_text: accessCore.REASON_LABEL[ev.reason] || ev.reason,
    user: user ? { uid_seq: user.uid_seq, uid_code: user.uid_code || null, name: user.name } : null,
    door: { id: door.id, name: door.name },
  });
});
router.get('/v1/access/doors', requireApiKey('access:read'), (req, res) => {
  if (req.isSandbox) return res.json(SANDBOX.doors());
  const rows = access.enabledDoors.all().map(d => ({ id: d.id, name: d.name, location: d.location, status: d.status }));
  res.json({ total: rows.length, data: rows });
});
router.get('/v1/access/logs', requireApiKey('access:read'), (req, res) => {
  if (req.isSandbox) return res.json(SANDBOX.accessLogs());
  const lim = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 500);
  const rows = req.query.door_id ? access.logsByDoor.all(req.query.door_id, lim) : access.logsAll.all(lim);
  res.json({ total: rows.length, data: rows });
});

// ── 设备管理开放 API（v3.5.21）──
// 设备台账同步 + 心跳上报。心跳让门禁机/读卡器等在线设备刷新 last_seen。
router.get('/v1/devices', requireApiKey('device:read'), (req, res) => {
  if (req.isSandbox) return res.json({ _sandbox: true, total: 1, data: [{ id: 'dev_sb', name: '示例设备', kind: 'access_controller', serial: 'SB-0001', status: 'active', door_id: 'door_sb', last_seen: '2026-01-01 10:00:00' }] });
  let rows = devices.all.all();
  if (req.query.kind) rows = rows.filter(d => d.kind === req.query.kind);
  if (req.query.status) rows = rows.filter(d => d.status === req.query.status);
  res.json({ total: rows.length, data: rows.map(d => ({
    id: d.id, name: d.name, kind: d.kind, serial: d.serial, status: d.status,
    subject: d.subject_name || null, owner: d.owner_name || null, door_id: d.door_id || null,
    door: d.door_name || null, tags: d.tags || '', last_seen: d.last_seen || null,
  })) });
});
router.post('/v1/devices/:id/heartbeat', requireApiKey('device:read'), (req, res) => {
  if (req.isSandbox) return res.json({ success: true, _sandbox: true });
  const dev = devices.get.get(req.params.id);
  if (!dev) return res.status(404).json({ error: '设备不存在' });
  devices.touch.run(dev.id);
  res.json({ success: true, status: dev.status });
});

module.exports = router;
