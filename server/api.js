/**
 * API 路由 - 所有业务接口
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db, nextUidSeq, users, oauth, oauthProviders, oauthSubjects, orgMembers, dirSources, orgFolders, verifyFiles, appOrgs, appIcons, appFolders, appVisibleToUser, appVisibleInSession, memos, memoAtt, access, devices, contacts, departments, smsChannels, verify, otp, logs, apps, idp, twofa, webauthn, announcements, documents, apiKeys, env, points, limitedAdmins } = require('./db');
const accessCore = require('./access');
const { validateAttachment, isLinkAllowed, linkWhitelist, maxAttachBytes } = require('./memo-util');
const contactUtil = require('./contacts');
const wmBurn = require('./watermark-burn');
wmBurn.prefetchFont();   // 开了「导出加水印」就在启动时把中文字体备好
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
// 解析某手机号区号对应的短信凭证（v3.5.71）：组织覆盖该区号 > 全局区号通道 > 组织默认(msg_config) > 全局 env
function smsOverrideFor(phone, orgId) {
  const p = parsePhone(phone);
  const cc = p ? p.cc : defaultPhoneCC();
  // 1. 组织覆盖该区号
  if (orgId) {
    try {
      const s = oauthSubjects.get.get(orgId);
      if (s && s.sms_channels) {
        const m = JSON.parse(s.sms_channels);
        if (m[cc] && typeof m[cc] === 'object' && Object.keys(m[cc]).length) return m[cc];
      }
    } catch (_) {}
  }
  // 2. 全局区号通道
  try {
    const ch = smsChannels.byCc.get(cc);
    if (ch && ch.enabled) { const c = JSON.parse(ch.config || '{}'); if (Object.keys(c).length) return c; }
  } catch (_) {}
  // 3. 组织默认（msg_config）或全局 env
  return orgId ? subjectMsgCfg(orgId) : undefined;
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
// v3.5.77：按 Host 识别「组织站点」（多租户分域）——显式域名优先，其次子域通配（<org_code>.<MULTITENANT_BASE_DOMAIN>）
function orgByHost(host) {
  const h = String(host || '').toLowerCase().trim().replace(/:\d+$/, '');
  if (!h) return null;
  try {
    const byDomain = oauthSubjects.byDomain.get(h);
    if (byDomain && byDomain.enabled) return byDomain;
  } catch (_) {}
  const base = String(process.env.MULTITENANT_BASE_DOMAIN || '').toLowerCase().trim();
  if (base && h.endsWith('.' + base)) {
    const sub = h.slice(0, -(base.length + 1));
    if (sub && sub !== 'www') {
      try {
        const byCode = oauthSubjects.byOrgCode.get(sub);
        if (byCode && byCode.enabled) return byCode;
      } catch (_) {}
    }
  }
  return null;
}
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
// 常见国家码前缀（按长度降序，先匹配长的；管理员在「区号短信通道」里新增的区号也能被 smsChannels 表命中）
const PHONE_CCS = ['+852','+853','+855','+856','+880','+886','+998','+996','+995','+994','+993','+992','+977','+976','+975','+974','+973','+972','+971','+970','+968','+967','+966','+965','+964','+963','+962','+961','+960','+94','+93','+92','+91','+90','+86','+84','+82','+81','+66','+65','+64','+63','+62','+61','+60','+58','+57','+56','+55','+54','+53','+52','+51','+49','+48','+47','+46','+45','+44','+43','+41','+40','+39','+36','+34','+33','+32','+31','+30','+27','+20','+7','+1'];
// 手机号（v3.5.71 起带国家码）：+86 严格校验 11 位；其他区号宽松校验本地号（4~15 位数字）
function parsePhone(s) {
  const t = String(s || '').trim();
  if (!t.startsWith('+')) return null;
  const cc = PHONE_CCS.find(c => t.startsWith(c));
  if (!cc) return null;
  const local = t.slice(cc.length);
  return local ? { cc, local } : null;
}
function defaultPhoneCC() {
  const v = String(process.env.DEFAULT_PHONE_CC || '+86').trim();
  return /^\+\d{1,4}$/.test(v) ? v : '+86';
}
// 归一化：裸大陆 11 位手机号补默认区号；已是带码则原样
function normalizePhone(s) {
  const t = String(s || '').trim();
  if (/^\+\d{1,4}\d{4,15}$/.test(t)) return t;
  if (/^1[3-9]\d{9}$/.test(t)) return defaultPhoneCC() + t;
  return t;
}
const isPhone = s => {
  const p = parsePhone(s);
  if (!p) return false;
  if (p.cc === '+86') return /^1[3-9]\d{9}$/.test(p.local);
  return /^\d{4,15}$/.test(p.local);
};

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

// ── 区号 → 短信通道（v3.5.71）──
// 每个国家码（+86/+1/+852…）可配一套 QWQ Message 凭证（URL/KEY/短信通道组/模板），发送时按手机号区号路由。
function smsChannelView(ch) {
  let cfg = {}; try { cfg = JSON.parse(ch.config || '{}'); } catch (_) {}
  const masked = { ...cfg };
  if (masked.QWQ_MESSAGE_KEY) masked.QWQ_MESSAGE_KEY = '••••••••';
  return { id: ch.id, country_code: ch.country_code, label: ch.label, enabled: !!ch.enabled, sort_order: ch.sort_order, config: masked };
}
router.get('/admin/sms-channels', requireAdmin(3), (req, res) => {
  res.json({ success: true, data: smsChannels.all.all().map(smsChannelView), default_cc: defaultPhoneCC() });
});
router.post('/admin/sms-channels', requireAdmin(2), (req, res) => {
  const cc = String(req.body?.country_code || '').trim();
  if (!/^\+\d{1,4}$/.test(cc)) return res.status(400).json({ error: '区号格式应为 +86 / +1 / +852' });
  if (smsChannels.byCc.get(cc)) return res.status(400).json({ error: '该区号已配置' });
  const cfg = req.body?.config && typeof req.body.config === 'object' ? req.body.config : {};
  const id = uuidv4();
  smsChannels.insert.run(id, cc, String(req.body?.label || '').slice(0, 60), JSON.stringify(cfg), req.body?.enabled === false ? 0 : 1, Number.isFinite(+req.body?.sort_order) ? +req.body.sort_order : 0);
  res.json({ success: true, id });
});
router.patch('/admin/sms-channels/:id', requireAdmin(2), (req, res) => {
  const ch = smsChannels.get.get(req.params.id);
  if (!ch) return res.status(404).json({ error: '区号通道不存在' });
  let oldCfg = {}; try { oldCfg = JSON.parse(ch.config || '{}'); } catch (_) {}
  const newCfg = { ...oldCfg };
  if (req.body?.config && typeof req.body.config === 'object') {
    for (const [k, v] of Object.entries(req.body.config)) {
      if (v == null || v === '') continue;
      if (/^•+$/.test(String(v))) continue;   // 打码串不覆盖
      newCfg[k] = v;
    }
  }
  const cc = String(req.body?.country_code || ch.country_code).trim();
  if (!/^\+\d{1,4}$/.test(cc)) return res.status(400).json({ error: '区号格式应为 +86 / +1 / +852' });
  if (cc !== ch.country_code && smsChannels.byCc.get(cc)) return res.status(400).json({ error: '该区号已配置' });
  smsChannels.update.run(cc, req.body?.label !== undefined ? String(req.body.label).slice(0, 60) : ch.label, JSON.stringify(newCfg), req.body?.enabled !== undefined ? (req.body.enabled ? 1 : 0) : ch.enabled, Number.isFinite(+req.body?.sort_order) ? +req.body.sort_order : ch.sort_order, ch.id);
  res.json({ success: true });
});
router.delete('/admin/sms-channels/:id', requireAdmin(2), (req, res) => {
  smsChannels.remove.run(req.params.id);
  res.json({ success: true });
});

// ── 短信验证码 ──
router.post('/sms/send', async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone || !isPhone(phone)) return res.status(400).json({ error: '手机号格式不正确' });
  const code = genCode();
  const expire = parseInt(process.env.SMS_CODE_EXPIRE || '300');
  otp.clean.run(Date.now());
  otp.set.run(`sms:${phone}`, code, Date.now() + expire * 1000);

  // v3.5.71：按手机号区号路由短信凭证（组织覆盖该区号 > 全局区号通道 > 组织默认 > 全局）
  const orgCfg = smsOverrideFor(phone, req.body?.org);
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
  const phone = normalizePhone(req.body?.phone);
  const { code } = req.body;
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
  const { email, password, name } = req.body;
  const phone = normalizePhone(req.body?.phone);   // v3.5.71 裸 11 位补默认区号

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
  if (/^1[3-9]\d{9}$/.test(s) || /^\+\d{1,4}\d{4,15}$/.test(s)) return notPub(users.findByPhone.get(normalizePhone(s)));   // 手机号（裸 11 位或带码）
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
  const byEmail = isEmail(ident), byPhone = !byEmail && isPhone(normalizePhone(ident));
  if (!byEmail && !byPhone) return res.status(400).json({ error: '验证码登录请填写邮箱或手机号' });
  const phoneIdent = normalizePhone(ident);   // v3.5.71 裸 11 位补默认区号，与 /sms/send 的 OTP 键一致
  const key = (byEmail ? 'email:' : 'sms:') + (byEmail ? ident : phoneIdent);
  const entry = otp.get.get(key);
  if (!entry || Date.now() > entry.expire_at) { otp.del.run(key); return res.status(400).json({ error: '验证码不存在或已过期' }); }
  otp.incAtt.run(key);
  if (entry.attempts >= 5) { otp.del.run(key); return res.status(400).json({ error: '错误次数过多，请重新获取' }); }
  if (entry.code !== String(code).trim()) return res.status(400).json({ error: '验证码错误' });
  otp.del.run(key);
  const user = byEmail ? users.findByEmail.get(ident) : users.findByPhone.get(phoneIdent);
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
const userMerge = require('./user-merge');
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

// ══════════════════════════════════════════
// 账号停用 / 删除时同步暂停应用权限（v3.5.44）
//   · 作废本系统签给它的 OIDC 令牌与授权码（JWT 会话由 requireAuth 每次查账号状态拦下）
//   · 推送撤销事件给授权过的应用（自定义 webhook + Back-Channel Logout）
//   · 同步源开了「停用时同步暂停」的企业微信：把它对应的成员设为禁用（恢复时再启用）
// ══════════════════════════════════════════
function pushExternalSuspend(user, enabled) {
  let rows = [];
  try {
    rows = db.prepare(`SELECT l.ext_id, d.* FROM dir_source_links l JOIN dir_sync_sources d ON d.id=l.source_id
      WHERE l.user_id=?`).all(user.id).map(r => ({ ...r, source_id: r.id }));
  } catch (_) {}
  const done = new Set();   // 同一份文件夹通讯录被几个组织套用：同一个成员只推一次
  for (const r of rows) {
    const drv = require('./dirsync').driver(r.type);   // 企业微信 / 飞书（v3.5.59）
    if (!drv) continue;
    const cfg = drv.effectiveCfg(r);
    if (!cfg.push_suspend) continue;
    const k = (r.parent_id || r.id) + '|' + r.ext_id;
    if (done.has(k)) continue; done.add(k);
    drv.setMemberEnabled(cfg, r.ext_id, enabled)
      .then(() => audit(enabled ? 'account.external_resumed' : 'account.external_suspended', { subject: String(user.uid_seq), actor: 'system', detail: { source: r.source_id, ext_id: r.ext_id } }))
      .catch(e => console.warn(`[同步暂停${drv.label}成员失败]`, r.ext_id, e.message));
  }
}
function onAccountSuspended(user, event = 'user.disabled') {
  try {
    db.prepare('DELETE FROM oauth_access_tokens WHERE user_id=?').run(user.id);
    db.prepare('DELETE FROM oauth_auth_codes WHERE user_id=?').run(user.id);
  } catch (_) {}
  deprovisionUserAllApps(user, event);
  pushExternalSuspend(user, false);
}
function onAccountResumed(user) { pushExternalSuspend(user, true); }

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
// 同一实名最多几个账号（v3.5.45，KYC_MAX_ACCOUNTS，默认 3，0 = 不限）。按假名 kyc_pseudonym 认同一人（需配 KYC_PSEUDONYM_SECRET）
function kycMaxAccounts() { const n = parseInt(process.env.KYC_MAX_ACCOUNTS, 10); return Number.isFinite(n) && n >= 0 ? Math.min(n, 100) : 3; }
const sameIdentityStmt = () => db.prepare(`SELECT * FROM users WHERE kyc_pseudonym=? AND id<>? AND kyc_verified=1 AND is_public=0
  AND status='active' AND merged_into IS NULL AND deletion_state IS NULL ORDER BY uid_seq`);
function kycLimitError(userId, pseudonym) {
  const max = kycMaxAccounts();
  if (!pseudonym || !max) return null;
  const n = sameIdentityStmt().all(pseudonym, userId).length;
  return n >= max ? `同一实名下已有 ${n} 个账号（最多 ${max} 个）。请登录其中一个账号，在「账号设定 → 实名认证」里把其他账号合并进来，或联系管理员` : null;
}
function finalizeKyc(userId, { maskedName, idTail, provider, pseudonym, nameHash, reverify = false, source = 'self' }) {
  const limitErr = kycLimitError(userId, pseudonym);
  if (limitErr) {
    const lu = users.findById.get(userId);
    audit('kyc.account_limit', { subject: lu ? lu.uid_seq : userId, actor: `source:${source}`, detail: { provider: provider || '—', max: kycMaxAccounts() } });
    return false;
  }
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
  return true;
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
    const h = identityHashes(name, id_number);
    const limitErr = kycLimitError(user.id, h.pseudonym);
    if (limitErr) return res.status(400).json({ error: limitErr });
    await verifyKycDirect(name.trim(), id_number.trim(), memberKycCfg(user, req.body?.org));
    // 写入认证结果（含假名/姓名哈希，供去重与姓名比对）
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
    burn: wmBurn.isBurnOn(),   // 导出的图片/PDF 是否烧录水印（与页面水印开关独立）
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
    if (val && val.trim() && !defaultDisabled(platform)) configured.push(platform);
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
// 本站默认凭证的启停（v3.5.36）：停用的平台记在 OAUTH_DEFAULT_DISABLED（逗号分隔），凭证本身保留
function defaultDisabled(platform) {
  return String(process.env.OAUTH_DEFAULT_DISABLED || '').split(',').map(x => x.trim()).filter(Boolean).includes(platform);
}
function envConfigured(platform) {
  const meta = OAUTH_META[platform];
  if (!meta) return false;
  if (defaultDisabled(platform)) return false;
  const row = env.get.get(meta.primary);
  const val = row?.value || process.env[meta.primary];
  return !!(val && String(val).trim());
}
function instancePublic(platform, inst) {
  const meta = OAUTH_META[platform];
  let cfg = {}; try { cfg = JSON.parse(inst.config || '{}'); } catch (_) {}
  const out = { platform, instance_id: inst.id, label: inst.label || inst.folder_name || '', enabled: !!inst.enabled };
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
// 应用内自动登录（v3.5.42）：在企业微信 / 微信 / 飞书 / 钉钉的内置浏览器里打开登录页时，
// 直接用该平台已配置的凭证登录。INAPP_AUTO_LOGIN：留空 / all = 四个平台都开；off = 关；也可填逗号列表（如 wecom,feishu）
const INAPP_PLATFORMS = ['wecom', 'wechat', 'feishu', 'dingtalk'];
function inappAutoPlatforms() {
  const v = String(process.env.INAPP_AUTO_LOGIN || '').trim().toLowerCase();
  if (!v || v === 'all' || v === 'on') return INAPP_PLATFORMS;
  if (['off', '0', 'false', 'no', 'none'].includes(v)) return [];
  return v.split(/[,，\s]+/).filter(p => INAPP_PLATFORMS.includes(p));
}
router.get('/public/login-methods', (req, res) => {
  const orgSite = orgByHost(req.headers.host);   // v3.5.77 组织站点（多租户分域）
  const methods = [];
  if (orgSite) {
    // 组织站点：只返回该组织的登录凭证（不返回默认主体/其他组织的凭证）
    for (const platform of Object.keys(OAUTH_META)) {
      for (const inst of oauthProviders.enabledByPlatform.all(platform)) {
        if (inst.subject_id === orgSite.id) methods.push(instancePublic(platform, inst));
      }
    }
  } else {
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
  }
  res.json({ success: true, methods, inapp_auto: inappAutoPlatforms(), org_site: orgSite ? { id: orgSite.id, name: orgSite.name } : null });
});

// org-first 登录（v3.5.17）：登录页「直接登录到某组织」可选项。
// 只列 enabled 且 allow_direct_login=1 的组织，只给 id/name（无任何凭证/成员信息）。
router.get('/public/orgs', (req, res) => {
  const orgSite = orgByHost(req.headers.host);   // v3.5.77 组织站点：只返回该组织
  let orgs = [];
  try {
    orgs = oauthSubjects.all.all()
      .filter(s => s.enabled && s.allow_direct_login && (s.direct_listed == null ? true : s.direct_listed))  // 仅显性
      .filter(s => !orgSite || s.id === orgSite.id)
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
    id: r.id, subject_id: r.subject_id, folder_id: r.folder_id || null, platform: r.platform, label: r.label,
    enabled: !!r.enabled, sort_weight: r.sort_weight, created_at: r.created_at,
    config: maskOauthConfig(r.platform, cfg),
  };
}

// 主体（组织）+ 其下凭证。同一主体下不同凭证登录进来的用户会「同人识别合并」。
router.get('/admin/oauth-subjects', requireAdmin(3), (req, res) => {
  const subjects = oauthSubjects.all.all().map(s => ({
    id: s.id, name: s.name, enabled: !!s.enabled, sort_weight: s.sort_weight,
    folder_id: s.folder_id || null,   // 组织文件夹（v3.5.38），null = 未归类
    // 每主体登录策略
    require_2fa: !!s.require_2fa, ip_allow: s.ip_allow || '', login_start: s.login_start || '', login_end: s.login_end || '',
    // 组织专属凭证（短信/邮件）+ 是否允许直接登录
    msg_config: (() => { try { return s.msg_config ? JSON.parse(s.msg_config) : {}; } catch (_) { return {}; } })(),
    sms_channels: (() => { try { return s.sms_channels ? JSON.parse(s.sms_channels) : {}; } catch (_) { return {}; } })(),
    kyc_config: (() => { try { return s.kyc_config ? JSON.parse(s.kyc_config) : {}; } catch (_) { return {}; } })(),
    allow_direct_login: !!s.allow_direct_login,
    members_open: !!s.members_open,
    independent_security: !!s.independent_security,
    require_org_password: !!s.require_org_password,
    deny_code_login: !!s.deny_code_login,
    direct_listed: s.direct_listed == null ? true : !!s.direct_listed,
    org_code: s.allow_direct_login ? ensureOrgCode(s) : (s.org_code || ''),
    // 成员多联系方式上限（0=用全局默认）
    max_phones: s.max_phones || 0, max_emails: s.max_emails || 0,
    // 独立站点域名（v3.5.77 多租户分域）
    domain: s.domain || '',
    // 成员数 / 开放应用数（卡片上直接显示，更直观）
    member_count: orgMembers.countBySubject.get(s.id).n,
    dir_sources: dirSources.bySubject.all(s.id).map(x => dirSourceView(x, s)),   // 通讯录同步源（v3.5.36，secret 已打码）
    open_app_count: appOrgs.countBySubject.get(s.id).n,
    admin_count: oauthSubjects.admins.all(s.id).length,
    credentials: oauthProviders.bySubject.all(s.id).map(credView),
  }));
  res.json({ success: true, data: subjects, folders: orgFolderList().map(f => ({ ...f, ...folderResources(f.id) })), platforms: oauthPlatformsMeta() });
});

// 组织名称唯一（v3.5.53）：比较时做 NFKC（全角括号 / 空格归一）+ 去空白 + 忽略大小写
const orgNameKey = (n) => String(n || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
function orgNameTaken(name, exceptId = '') {
  const k = orgNameKey(name);
  if (!k) return null;
  return db.prepare('SELECT id, name FROM oauth_subjects').all().find(r => r.id !== exceptId && orgNameKey(r.name) === k) || null;
}
router.post('/admin/oauth-subjects', requireAdmin(2), (req, res) => {
  const { name, enabled, sort_weight } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: '请填写主体名称' });
  const dup = orgNameTaken(name);
  if (dup) return res.status(409).json({ error: `组织名称「${dup.name}」已被占用，换一个名称`, code: 'name_taken', existing_id: dup.id });
  const folder = folderIdFromBody(req.body?.folder_id);
  if (folder === false) return res.status(400).json({ error: '文件夹不存在' });
  const id = uuidv4();
  oauthSubjects.insert.run(id, String(name).trim(), enabled === false ? 0 : 1, Number.isFinite(+sort_weight) ? +sort_weight : 0);
  if (folder) orgFolders.setSubject.run(folder, id);
  res.json({ success: true, id });
});

// ── 域名验证文件（v3.5.40）──
// 企业微信「可信域名」、微信公众号业务域名等，要求把平台给的验证文件放在域名根目录（如 /WW_verify_xxxx.txt）。
// 管理员在这里上传 / 粘贴，index.js 在根路径下对外提供；到期自动删除（默认 72 小时，0 = 永久）。
// ⚠️ 根目录文件能向任何平台「证明域名归属」，所以只给超级管理员（Lv.1），并写审计。
const VERIFY_FILE_EXTS = { txt: 'text/plain', html: 'text/plain', htm: 'text/plain', xml: 'application/xml', json: 'application/json' };
const VERIFY_FILE_MAX = 64 * 1024;
function verifyFileNameError(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) return '文件名只能用字母、数字、点、下划线、横线，不能带目录';
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (!name.includes('.') || !VERIFY_FILE_EXTS[ext]) return '只支持 .txt / .html / .htm / .xml / .json 文件';
  if (require('fs').existsSync(require('path').join(__dirname, '../public', name))) return '这个文件名和本站自带的页面重名了';
  return null;
}
function verifyFileView(f) {
  return { name: f.name, size: f.size ?? (f.content || '').length, expires_at: f.expires_at || null, note: f.note || '', created_at: f.created_at, updated_at: f.updated_at,
    expired: !!(f.expires_at && Date.parse(f.expires_at.replace(' ', 'T') + 'Z') <= Date.now()) };
}
function sqlTimeAfterHours(h) { return new Date(Date.now() + h * 3600e3).toISOString().slice(0, 19).replace('T', ' '); }
function ttlFromBody(v) {
  if (v === undefined || v === null || v === '') return 72;
  const h = Number(v);
  if (!Number.isFinite(h) || h < 0 || h > 8760) return null;
  return Math.round(h * 100) / 100;
}
router.get('/admin/verify-files', requireAdmin(1), (req, res) => {
  verifyFiles.purgeExpired.run();
  res.json({ success: true, files: verifyFiles.all.all().map(verifyFileView) });
});
router.get('/admin/verify-files/:name', requireAdmin(1), (req, res) => {
  const f = verifyFiles.get.get(req.params.name);
  if (!f) return res.status(404).json({ error: '文件不存在' });
  res.json({ success: true, file: { ...verifyFileView(f), content: f.content } });
});
router.post('/admin/verify-files', requireAdmin(1), (req, res) => {
  const name = String(req.body?.name || '').trim();
  const err = verifyFileNameError(name);
  if (err) return res.status(400).json({ error: err });
  const content = String(req.body?.content ?? '');
  if (!content.trim()) return res.status(400).json({ error: '文件内容不能为空' });
  if (Buffer.byteLength(content, 'utf8') > VERIFY_FILE_MAX) return res.status(400).json({ error: '文件太大了（上限 64KB）' });
  const ttl = ttlFromBody(req.body?.ttl_hours);
  if (ttl === null) return res.status(400).json({ error: '有效期应为 0~8760 小时（0 = 永久）' });
  const existed = !!verifyFiles.get.get(name);
  verifyFiles.upsert.run(name, content, ttl > 0 ? sqlTimeAfterHours(ttl) : null, String(req.body?.note || '').slice(0, 100), req.user.uid);
  audit('site.verify_file_' + (existed ? 'replaced' : 'added'), { actor: actorOf(req), detail: { name, ttl_hours: ttl, size: Buffer.byteLength(content, 'utf8') } });
  res.json({ success: true, file: verifyFileView(verifyFiles.get.get(name)), replaced: existed });
});
router.patch('/admin/verify-files/:name', requireAdmin(1), (req, res) => {
  const f = verifyFiles.get.get(req.params.name);
  if (!f) return res.status(404).json({ error: '文件不存在' });
  const ttl = ttlFromBody(req.body?.ttl_hours);
  if (ttl === null) return res.status(400).json({ error: '有效期应为 0~8760 小时（0 = 永久）' });
  verifyFiles.setExpiry.run(ttl > 0 ? sqlTimeAfterHours(ttl) : null, f.name);   // 从现在起重新计时
  audit('site.verify_file_extended', { actor: actorOf(req), detail: { name: f.name, ttl_hours: ttl } });
  res.json({ success: true, file: verifyFileView(verifyFiles.get.get(f.name)) });
});
router.delete('/admin/verify-files/:name', requireAdmin(1), (req, res) => {
  const f = verifyFiles.get.get(req.params.name);
  if (!f) return res.status(404).json({ error: '文件不存在' });
  verifyFiles.remove.run(f.name);
  audit('site.verify_file_removed', { actor: actorOf(req), detail: { name: f.name } });
  res.json({ success: true });
});
// 到期清理：每小时一次（读取时也会过滤掉过期的，这里只是把行删掉）
setInterval(() => { try { verifyFiles.purgeExpired.run(); } catch (_) {} }, 3600e3).unref();
// 给 index.js 在根路径下提供文件用
router.serveVerifyFile = (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const name = req.path.slice(1);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) || !name.includes('.')) return next();
  const ext = name.split('.').pop().toLowerCase();
  if (!VERIFY_FILE_EXTS[ext]) return next();
  let f;
  try { f = verifyFiles.active.get(name); } catch (_) { return next(); }
  if (!f) return next();
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.type(VERIFY_FILE_EXTS[ext] + '; charset=utf-8').send(f.content);   // .html 也按纯文本下发，免得根目录被当成可执行页面
};

// ── 组织文件夹（v3.5.38）：管理端把组织归类。一级、不嵌套；一个组织最多在一个文件夹 ──
function orgFolderList() {
  return orgFolders.all.all().map(f => ({ id: f.id, name: f.name, sort_weight: f.sort_weight, org_count: f.org_count }));
}
// body.folder_id → 文件夹 id / null（未归类）/ undefined（没传，不改）/ false（文件夹不存在）
function folderIdFromBody(v) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  return orgFolders.get.get(String(v)) ? String(v) : false;
}
router.get('/admin/org-folders', requireAdmin(3), (req, res) => res.json({ success: true, folders: orgFolderList() }));
router.post('/admin/org-folders', requireAdmin(2), (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: '请填写文件夹名称' });
  if (orgFolders.all.all().length >= 200) return res.status(400).json({ error: '文件夹太多了（上限 200）' });
  const id = uuidv4();
  orgFolders.insert.run(id, name, Number.isFinite(+req.body?.sort_weight) ? +req.body.sort_weight : 0);
  res.json({ success: true, folder: orgFolderList().find(f => f.id === id) });
});
router.patch('/admin/org-folders/:id', requireAdmin(2), (req, res) => {
  const f = orgFolders.get.get(req.params.id);
  if (!f) return res.status(404).json({ error: '文件夹不存在' });
  const name = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 40) : f.name;
  if (!name) return res.status(400).json({ error: '请填写文件夹名称' });
  orgFolders.update.run(name, Number.isFinite(+req.body?.sort_weight) ? +req.body.sort_weight : f.sort_weight, f.id);
  res.json({ success: true });
});
router.delete('/admin/org-folders/:id', requireAdmin(2), (req, res) => {
  const f = orgFolders.get.get(req.params.id);
  if (!f) return res.status(404).json({ error: '文件夹不存在' });
  // 文件夹上放着共用的通讯录 / 登录凭证（v3.5.47）：先删掉，免得组织里的套用和用户的登录绑定悬空
  const nc = dirSources.byFolder.all(f.id).length, np = oauthProviders.byFolder.all(f.id).length;
  if (nc || np) return res.status(400).json({ error: `文件夹上还有 ${nc} 份通讯录、${np} 套登录凭证，先删掉再删文件夹` });
  db.transaction(() => { orgFolders.unfileAll.run(f.id); orgFolders.remove.run(f.id); })();
  res.json({ success: true });   // 里面的组织回到「未归类」，组织本身不受影响
});

router.patch('/admin/oauth-subjects/:id', requireAdmin(2), (req, res) => {
  const row = oauthSubjects.get.get(req.params.id);
  if (!row) return res.status(404).json({ error: '主体不存在' });
  const folder = folderIdFromBody((req.body || {}).folder_id);
  if (folder === false) return res.status(400).json({ error: '文件夹不存在' });
  // 套用着当前文件夹通讯录的组织不能直接挪走（v3.5.47）
  if (folder !== undefined && (folder || null) !== (row.folder_id || null) && dirSources.bySubject.all(row.id).some(x => x.parent_id))
    return res.status(400).json({ error: '本组织在套用所在文件夹的通讯录，先在组织里删掉套用，再移出文件夹' });
  // 换了文件夹：原文件夹凭证的使用设定随之取消（v3.5.51）
  if (folder !== undefined && (folder || null) !== (row.folder_id || null))
    db.prepare("DELETE FROM folder_cred_orgs WHERE subject_id=? AND provider_id NOT IN (SELECT id FROM oauth_providers WHERE folder_id=?)").run(row.id, folder || '');
  const { name, enabled, sort_weight, require_2fa, ip_allow, login_start, login_end } = req.body || {};
  if (name != null) {
    if (!String(name).trim()) return res.status(400).json({ error: '请填写主体名称' });
    const dup = orgNameKey(name) !== orgNameKey(row.name) && orgNameTaken(name, row.id);
    if (dup) return res.status(409).json({ error: `组织名称「${dup.name}」已被占用，换一个名称`, code: 'name_taken', existing_id: dup.id });
  }
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
  // 组织覆盖某区号的短信凭证（v3.5.71）：JSON { "+86": {QWQ_MESSAGE_*...} }，空对象=清空回退全局
  if (req.body.sms_channels !== undefined) {
    const sc = req.body.sms_channels;
    oauthSubjects.setSmsChannels.run(sc && typeof sc === 'object' && Object.keys(sc).length ? JSON.stringify(sc) : null, row.id);
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
  if (folder !== undefined) orgFolders.setSubject.run(folder, row.id);   // 组织文件夹（v3.5.38），null = 移出到未归类
  if (req.body.direct_listed !== undefined) oauthSubjects.setDirectListed.run(req.body.direct_listed ? 1 : 0, row.id); // v3.5.18 登录页是否显性列出
  // 成员多联系方式上限（v3.5.63；0=回退全局）
  if (req.body.max_phones !== undefined || req.body.max_emails !== undefined) {
    const clamp = v => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? Math.min(50, n) : 0; };
    oauthSubjects.setContactLimits.run(
      req.body.max_phones !== undefined ? clamp(req.body.max_phones) : (row.max_phones || 0),
      req.body.max_emails !== undefined ? clamp(req.body.max_emails) : (row.max_emails || 0),
      row.id);
  }
  // v3.5.77：组织独立站点域名（多租户分域）
  if (req.body.domain !== undefined) {
    const domain = String(req.body.domain || '').trim().toLowerCase().slice(0, 200);
    oauthSubjects.setDomain.run(domain || null, row.id);
  }
  // 开了直登就确保有组织码（不显性组织靠它被搜索到）
  if (req.body.allow_direct_login) ensureOrgCode(oauthSubjects.get.get(row.id));
  res.json({ success: true });
});

router.delete('/admin/oauth-subjects/:id', requireAdmin(2), (req, res) => {
  const row = oauthSubjects.get.get(req.params.id);
  if (!row) return res.status(404).json({ error: '主体不存在' });
  oauthProviders.clearUsesBy.run(row.id);       // 连带取消它对文件夹凭证的使用设定（v3.5.51）
  oauthProviders.removeBySubject.run(row.id);   // 连带删除其下所有凭证（登录入口消失；已绑用户 user_oauth 行保留可查）
  orgMembers.removeBySubject.run(row.id);        // 连带清成员关系
  appOrgs.removeBySubject.run(row.id);           // 连带清应用开放关系
  dirSources.removeLinksBySubject.run(row.id);   // 连带清通讯录同步源、映射与「同步设过什么」记录
  dirSources.removeAppliedBySubject.run(row.id);
  dirSources.removeBySubject.run(row.id);
  oauthSubjects.clearAdmins.run(row.id);         // 连带清组织管理员
  oauthSubjects.remove.run(row.id);
  res.json({ success: true });
});

// ── 成员多联系方式（v3.5.63）──────────────────────────────
// 用户所属组织的第一个（用于取联系方式上限；无则 null = 用全局）
function firstSubjectOfUser(userId) {
  try { const r = orgMembers.subjectIdsOfUser.all(userId); return (r[0] && r[0].subject_id) || null; } catch (_) { return null; }
}
const SKIP_MSG = { bad: '格式不正确', dup: '该联系方式已存在', limit: '已达到数量上限' };

// 管理端：查看/增删某用户的联系方式
router.get('/admin/users/:id/contacts', requireAdmin(3), (req, res) => {
  const u = users.findById.get(req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  res.json({ success: true, data: contactUtil.listContacts(u.id) });
});
router.post('/admin/users/:id/contacts', requireAdmin(2), (req, res) => {
  const u = users.findById.get(req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const { kind, value } = req.body || {};
  const r = contactUtil.addContact(u.id, kind, value, 'manual', firstSubjectOfUser(u.id));
  if (!r.ok) return res.status(400).json({ error: SKIP_MSG[r.skip] || '添加失败' });
  res.json({ success: true, id: r.id });
});
router.delete('/admin/users/:id/contacts/:cid', requireAdmin(2), (req, res) => {
  const u = users.findById.get(req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  contacts.remove.run(req.params.cid, u.id);
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
    if (row.folder_id) db.prepare('UPDATE oauth_providers SET folder_id=NULL WHERE id=?').run(row.id);
  }
  res.json({ success: true });
});

router.delete('/admin/oauth-providers/:id', requireAdmin(2), (req, res) => {
  const row = oauthProviders.get.get(req.params.id);
  if (!row) return res.status(404).json({ error: '凭证不存在' });
  oauthProviders.remove.run(row.id);
  oauthProviders.clearUsesOf.run(row.id);
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
  if (!guardOrgWrite(req, s.id, false)) return;
  // 每个成员在本组织各同步源里对应的外部账号（企业微信 UserId 等）——一人多号时能看出来，好合并（v3.5.41）
  const ext = new Map();
  for (const l of db.prepare(`SELECT l.user_id, l.ext_id, d.label FROM dir_source_links l JOIN dir_sync_sources d ON d.id=l.source_id
      WHERE d.subject_id=? ORDER BY l.ext_id`).all(s.id)) {
    if (!ext.has(l.user_id)) ext.set(l.user_id, []);
    ext.get(l.user_id).push({ id: l.ext_id, source: l.label || '' });
  }
  const members = orgMembers.listBySubject.all(s.id).map(m => ({ ...m, ext_ids: ext.get(m.user_id) || [] }));
  res.json({ success: true, org: { id: s.id, name: s.name, uid_prefix: s.uid_prefix || '', uid_len: s.uid_len || 4, members_open: !!s.members_open }, members });
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
// v3.5.69 出站 provisioning：把成员 push 到本组织启用且有写权限的通讯录同步源（企业微信/飞书）。
// 建号（userid/open_id 已存在则增补部门，不覆盖多部门）；成功后写 dir_source_links 映射。
// 失败静默记 warn（不阻断加成员本身），返回每源结果供前端展示。
async function pushMemberToSources(subject, user, opts = {}) {
  const results = [];
  let rows = [];
  try { rows = dirSources.bySubject.all(subject.id).filter(s => s.enabled); } catch (_) {}
  for (const src of rows) {
    const drv = require('./dirsync').driver(src.type);
    if (!drv) continue;
    const cfg = drv.effectiveCfg(src);
    const canWrite = src.type === 'feishu' || !!cfg.write_secret;
    const label = src.label || drv.label || src.type;
    if (!canWrite) { results.push({ source_id: src.id, label, ok: false, error: '无写权限：企业微信建/删成员要用「通讯录同步」Secret（管理工具 → 通讯录同步 → 开启「API 编辑通讯录」），填到同步源「管理用 Secret」栏' }); continue; }
    let extId = opts.extId || crypto.randomBytes(4).toString('hex');
    const deptIds = drv.deptIdsOf(cfg);
    const rawMobile = opts.mobile || user.phone || '';
    const fields = {
      name: opts.name || user.name || '',
      // 企业微信 mobile 要裸 11 位（去掉 +86）；飞书要 +86（飞书 createMember 里会补）
      mobile: src.type === 'wecom' ? String(rawMobile).replace(/^\+86/, '') : rawMobile,
      email: opts.email || user.email || '',
    };
    if (src.type === 'wecom') { fields.userid = String(extId); fields.department = deptIds; }
    else {
      // 飞书要求 mobile 必填；没手机号的成员跳过飞书（企业微信仍建号），标 skipped 而非「失败」
      if (!String(rawMobile || '').trim()) {
        results.push({ source_id: src.id, label, ok: false, skipped: true, error: '成员无手机号，跳过飞书建号（飞书要求手机号必填，请先给成员补手机号）' });
        continue;
      }
      // 飞书 department_ids 必填、且不能是根部门 "0"。优先用「成员归属部门」的飞书 ext_id，否则回退同步范围（去掉根部门）
      let fds = (Array.isArray(deptIds) ? deptIds : []).map(x => String(x).trim()).filter(x => x && x !== '0');
      if (opts.deptId) {
        const dp = departments.get.get(String(opts.deptId));
        if (dp && dp.source === 'feishu' && dp.ext_id) fds = [String(dp.ext_id)];
      }
      fields.department_ids = fds;   // 飞书不传 user_id（组织内 UID 可能不合法），open_id 由飞书自动生成
    }
    try {
      const createdId = await drv.upsertMember(cfg, fields);
      dirSources.linkUpsert.run(src.id, createdId || extId, user.id, (deptIds || []).join(',') || null, opts.name || user.name || null);
      results.push({ source_id: src.id, label, ok: true, ext_id: createdId || extId });
    } catch (e) {
      console.warn(`[出站建号${label}失败]`, user.name, e.message);
      results.push({ source_id: src.id, label, ok: false, error: String(e.message || e).slice(0, 200) });
    }
  }
  return results;
}

// v3.5.69 出站删号：移出组织时，删掉该成员在本组织各同步源里的外部账号 + 映射（前端强确认后带 push 才调）
async function removeMemberFromSources(subject, user) {
  const results = [];
  let links = [];
  try {
    links = db.prepare(`SELECT l.source_id, l.ext_id, d.type, d.label FROM dir_source_links l JOIN dir_sync_sources d ON d.id=l.source_id WHERE d.subject_id=? AND l.user_id=?`).all(subject.id, user.id);
  } catch (_) {}
  for (const l of links) {
    const drv = require('./dirsync').driver(l.type);
    if (!drv) continue;
    const src = dirSources.get.get(l.source_id);
    const cfg = src ? drv.effectiveCfg(src) : {};
    const label = l.label || drv.label || l.type;
    try {
      await drv.deleteMember(cfg, l.ext_id);
      dirSources.linkDelete.run(l.source_id, l.ext_id);
      results.push({ source_id: l.source_id, label, ok: true, ext_id: l.ext_id });
    } catch (e) {
      console.warn(`[出站删号${label}失败]`, l.ext_id, e.message);
      results.push({ source_id: l.source_id, label, ok: false, error: String(e.message || e).slice(0, 200) });
    }
  }
  return results;
}

router.post('/admin/orgs/:sid/members', requireAuth, async (req, res) => {
  const s = oauthSubjects.get.get(req.params.sid);
  if (!s) return res.status(404).json({ error: '组织不存在' });
  if (!guardOrgWrite(req, s.id)) return;
  let r;
  if (req.body?.create) {
    // 按组织建成员（v3.5.67）：直接建一个平台账号并加入本组织
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const phone = normalizePhone(req.body?.phone);
    const password = String(req.body?.password || '');
    if (!name) return res.status(400).json({ error: '请填写姓名' });
    if (!email && !phone) return res.status(400).json({ error: '请至少填写邮箱或手机号' });
    if (email && !isEmail(email)) return res.status(400).json({ error: '邮箱格式不正确' });
    if (phone && !isPhone(phone)) return res.status(400).json({ error: '手机号格式不正确' });
    if (password && password.length < 8) return res.status(400).json({ error: '密码至少 8 位' });
    if (email && users.findByEmail.get(email)) return res.status(400).json({ error: '该邮箱已被注册' });
    if (phone && users.findByPhone.get(phone)) return res.status(400).json({ error: '该手机号已被注册' });
    const hash = password ? await bcrypt.hash(password, 12) : null;
    r = users.create({ name, email: email || null, phone: phone || null, password_hash: hash, role: 'user', user_level: 4 });
    // 把主邮箱/手机也灌进多联系方式，保持与导入一致
    if (email) { try { contactUtil.addContact(r.id, 'email', email, 'manual', s.id); } catch (_) {} }
    if (phone) { try { contactUtil.addContact(r.id, 'phone', phone, 'manual', s.id); } catch (_) {} }
  } else {
    r = resolveUser(String(req.body?.account || '').trim());
    if (r === 'AMBIGUOUS') return res.status(400).json({ error: '账号有重名，请改用邮箱/手机号/UID' });
    if (!r) return res.status(404).json({ error: '用户不存在（如需新建请用「新建并加入」）' });
    if (r.is_public) return res.status(400).json({ error: '公共账号不能作为组织成员' });
    if (orgMembers.get.get(s.id, r.id)) return res.status(400).json({ error: '该用户已是本组织成员' });
  }
  let orgUid = String(req.body?.org_uid || '').trim() || null;
  let source = req.body?.create ? 'manual' : 'manual';
  if (orgUid) {
    if (orgMembers.orgUidTaken.get(s.id, orgUid, '')) return res.status(400).json({ error: '该组织内 UID 已被占用' });
  } else if (s.uid_prefix || req.body?.auto_uid) {
    orgUid = genOrgUid(s); source = 'auto';
  }
  orgMembers.add.run(s.id, r.id, orgUid, source);
  const deptId = String(req.body?.dept_id || '').trim();
  if (deptId) {
    const dp = departments.get.get(deptId);
    if (!dp || dp.subject_id !== s.id) return res.status(400).json({ error: '部门不存在或不属于本组织' });
    orgMembers.setDeptId.run(deptId, s.id, r.id);
  }
  // v3.5.69 出站建号（前端勾了「同步到企业微信/飞书」才 push）
  let pushResults = null;
  if (req.body?.push) {
    pushResults = await pushMemberToSources(s, r, { extId: orgUid, name: r.name, mobile: r.phone, email: r.email, deptId });
  }
  res.json({ success: true, org_uid: orgUid, uid_seq: r.uid_seq, push_results: pushResults });
});

router.patch('/admin/orgs/:sid/members/:uid', requireAuth, (req, res) => {
  const s = oauthSubjects.get.get(req.params.sid);
  if (!s) return res.status(404).json({ error: '组织不存在' });
  if (!guardOrgWrite(req, s.id)) return;
  const target = findRealUserByUid(req.params.uid);
  if (!target || !orgMembers.get.get(s.id, target.id)) return res.status(404).json({ error: '成员不存在' });
  if (req.body?.org_uid !== undefined) {
    const orgUid = String(req.body?.org_uid || '').trim() || null;
    if (orgUid && orgMembers.orgUidTaken.get(s.id, orgUid, target.id)) return res.status(400).json({ error: '该组织内 UID 已被占用' });
    orgMembers.setOrgUid.run(orgUid, s.id, target.id);
  }
  if (req.body?.dept_id !== undefined) {
    const deptId = String(req.body?.dept_id || '').trim() || null;
    if (deptId) {
      const dp = departments.get.get(deptId);
      if (!dp || dp.subject_id !== s.id) return res.status(400).json({ error: '部门不存在或不属于本组织' });
    }
    orgMembers.setDeptId.run(deptId, s.id, target.id);   // v3.5.68 成员归属部门
    orgMembers.setPending.run(0, s.id, target.id);       // v3.5.75 手动改部门 = 完成分配，清除待分配/挂起
  }
  res.json({ success: true });
});

router.delete('/admin/orgs/:sid/members/:uid', requireAuth, async (req, res) => {
  const s = oauthSubjects.get.get(req.params.sid);
  if (!s) return res.status(404).json({ error: '组织不存在' });
  if (!guardOrgWrite(req, s.id)) return;
  const target = findRealUserByUid(req.params.uid);
  if (!target) return res.status(404).json({ error: '成员不存在' });
  // v3.5.69 出站删号（前端强确认后带 push 才删外部账号）
  let pushResults = null;
  if (req.body?.push) {
    pushResults = await removeMemberFromSources(s, target);
  }
  orgMembers.remove.run(s.id, target.id);
  res.json({ success: true, push_results: pushResults });
});

// v3.5.69 显式出站建号：把某成员 push 到本组织同步源（用于「加成员时没勾，事后补」）
router.post('/admin/orgs/:sid/members/:uid/push', requireAuth, async (req, res) => {
  const s = oauthSubjects.get.get(req.params.sid);
  if (!s) return res.status(404).json({ error: '组织不存在' });
  if (!canManageOrg(req, s.id)) return res.status(403).json({ error: '无权管理该组织' });
  const target = findRealUserByUid(req.params.uid);
  if (!target || !orgMembers.get.get(s.id, target.id)) return res.status(404).json({ error: '成员不存在' });
  const mem = orgMembers.get.get(s.id, target.id);
  const results = await pushMemberToSources(s, target, { extId: mem?.org_uid, name: target.name, mobile: target.phone, email: target.email, deptId: mem?.dept_id });
  res.json({ success: true, push_results: results });
});

// ── 待分配成员（v3.5.75）：同步源把成员拉进「待分配部门」后标记 pending=1，等人分配实际部门或挂起 ──
router.get('/admin/orgs/:sid/pending-members', requireAuth, (req, res) => {
  const s = oauthSubjects.get.get(req.params.sid);
  if (!s) return res.status(404).json({ error: '组织不存在' });
  if (!guardOrgWrite(req, s.id, false)) return;
  res.json({ success: true, members: orgMembers.pendingMembers.all(s.id) });
});
// 分配部门：给待分配成员指定实际部门（dept_id + pending=0），并出站把成员从「待分配部门」移到目标部门
router.post('/admin/orgs/:sid/pending-members/:uid/assign', requireAuth, async (req, res) => {
  const s = oauthSubjects.get.get(req.params.sid);
  if (!s) return res.status(404).json({ error: '组织不存在' });
  if (!guardOrgWrite(req, s.id)) return;
  const target = findRealUserByUid(req.params.uid);
  const mem = target && orgMembers.get.get(s.id, target.id);
  if (!target || !mem) return res.status(404).json({ error: '成员不存在' });
  if (mem.pending !== 1) return res.status(400).json({ error: '该成员不在待分配状态' });
  const deptId = String(req.body?.dept_id || '').trim();
  const dp = deptId ? departments.get.get(deptId) : null;
  if (!dp || dp.subject_id !== s.id) return res.status(400).json({ error: '部门不存在或不属于本组织' });
  orgMembers.setDeptId.run(deptId, s.id, target.id);
  orgMembers.setPending.run(0, s.id, target.id);
  // 出站移动：把成员从「待分配部门」移到目标部门（目标部门要有对应同步源类型的 ext_id）
  const push_results = [];
  let rows = [];
  try { rows = dirSources.bySubject.all(s.id).filter(x => x.enabled); } catch (_) {}
  for (const src of rows) {
    const drv = require('./dirsync').driver(src.type);
    if (!drv || !drv.moveMemberDept) continue;
    if (!dp.ext_id || dp.source !== src.type) continue;   // 手动部门无外部 id、或部门类型不匹配则不出站移动
    const link = db.prepare('SELECT * FROM dir_source_links WHERE source_id=? AND user_id=?').get(src.id, target.id);
    if (!link) continue;
    try {
      await drv.moveMemberDept(drv.effectiveCfg(src), link.ext_id, dp.ext_id);
      push_results.push({ source_id: src.id, label: src.label || drv.label, ok: true });
    } catch (e) {
      push_results.push({ source_id: src.id, label: src.label || drv.label, ok: false, error: String(e.message || e).slice(0, 200) });
    }
  }
  res.json({ success: true, push_results });
});
// 挂起：暂不分配（pending=2），从待分配列表移除，之后可在成员列表里重新处理
router.post('/admin/orgs/:sid/pending-members/:uid/suspend', requireAuth, (req, res) => {
  const s = oauthSubjects.get.get(req.params.sid);
  if (!s) return res.status(404).json({ error: '组织不存在' });
  if (!guardOrgWrite(req, s.id)) return;
  const target = findRealUserByUid(req.params.uid);
  const mem = target && orgMembers.get.get(s.id, target.id);
  if (!target || !mem) return res.status(404).json({ error: '成员不存在' });
  if (mem.pending !== 1) return res.status(400).json({ error: '该成员不在待分配状态' });
  orgMembers.setPending.run(2, s.id, target.id);
  res.json({ success: true });
});

// ── 组织树状部门（v3.5.68）──────────────────────────────
// 每组织一套部门树；canManageOrg 同成员接口。手动部门 source=manual、ext_id 空；通讯录同步建的 source=wecom|feishu。
function deptIsDescendant(deptId, ancestorId) {
  let cur = departments.get.get(deptId);
  const seen = new Set();
  while (cur && cur.parent_id && !seen.has(cur.parent_id)) {
    seen.add(cur.parent_id);
    if (cur.parent_id === ancestorId) return true;
    cur = departments.get.get(cur.parent_id);
  }
  return false;
}
router.get('/admin/orgs/:sid/departments', requireAuth, (req, res) => {
  const s = oauthSubjects.get.get(req.params.sid);
  if (!s) return res.status(404).json({ error: '组织不存在' });
  if (!canManageOrg(req, s.id, false)) return res.status(403).json({ error: '无权管理该组织' });
  const data = departments.bySubject.all(s.id);
  // v3.5.72：部门按通讯录连接隔离，把连接信息带回去供前端分组
  const sources = dirSources.bySubject.all(s.id).map(d => ({ id: d.id, label: d.label || d.type, type: d.type }));
  res.json({ success: true, data, sources });
});
router.post('/admin/orgs/:sid/departments', requireAuth, (req, res) => {
  const s = oauthSubjects.get.get(req.params.sid);
  if (!s) return res.status(404).json({ error: '组织不存在' });
  if (!canManageOrg(req, s.id)) return res.status(403).json({ error: '无权管理该组织' });
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: '请填写部门名称' });
  const parentId = String(req.body?.parent_id || '').trim() || null;
  if (parentId) {
    const p = departments.get.get(parentId);
    if (!p || p.subject_id !== s.id) return res.status(400).json({ error: '上级部门不存在或不属于本组织' });
    if (p.source !== 'manual') return res.status(400).json({ error: '上级部门是通讯录同步的，不能在其下新建手动部门' });
  }
  const id = uuidv4();
  departments.insert.run(id, name, s.id, parentId, 'manual', null, null, 0);
  res.json({ success: true, id });
});
router.patch('/admin/orgs/:sid/departments/:id', requireAuth, (req, res) => {
  const s = oauthSubjects.get.get(req.params.sid);
  if (!s) return res.status(404).json({ error: '组织不存在' });
  if (!canManageOrg(req, s.id)) return res.status(403).json({ error: '无权管理该组织' });
  const d = departments.get.get(req.params.id);
  if (!d || d.subject_id !== s.id) return res.status(404).json({ error: '部门不存在' });
  if (d.source !== 'manual') return res.status(400).json({ error: '同步部门由通讯录管理，不可手动修改' });
  const name = req.body?.name !== undefined ? String(req.body.name || '').trim() : d.name;
  if (!name) return res.status(400).json({ error: '请填写部门名称' });
  let parentId = d.parent_id;
  if (req.body?.parent_id !== undefined) {
    parentId = String(req.body?.parent_id || '').trim() || null;
    if (parentId) {
      const p = departments.get.get(parentId);
      if (!p || p.subject_id !== s.id) return res.status(400).json({ error: '上级部门不存在或不属于本组织' });
      if (p.source !== 'manual') return res.status(400).json({ error: '上级部门是通讯录同步的，不能移动到其下' });
      if (parentId === d.id || deptIsDescendant(d.id, parentId)) return res.status(400).json({ error: '不能把部门移到自己的子部门下' });
    }
  }
  departments.update.run(name, parentId, d.id);
  res.json({ success: true });
});
router.delete('/admin/orgs/:sid/departments/:id', requireAuth, (req, res) => {
  const s = oauthSubjects.get.get(req.params.sid);
  if (!s) return res.status(404).json({ error: '组织不存在' });
  if (!canManageOrg(req, s.id)) return res.status(403).json({ error: '无权管理该组织' });
  const d = departments.get.get(req.params.id);
  if (!d || d.subject_id !== s.id) return res.status(404).json({ error: '部门不存在' });
  if (d.source !== 'manual') return res.status(400).json({ error: '同步部门由通讯录管理，不可手动删除' });
  // 子部门上提到被删部门的父级；成员 dept_id 置空
  const children = departments.childrenOf.all(d.id);
  for (const c of children) departments.update.run(departments.get.get(c.id).name, d.parent_id, c.id);
  departments.clearMemberDeptByDept.run(d.id);
  departments.remove.run(d.id);
  res.json({ success: true });
});

// 成员登录凭证（v3.5.67）：给成员手动绑定/解绑一个三方登录（providerKey + open_id，如企业微信 UserId、飞书 open_id）。
// 以后该成员用这个三方登录就落到这个账号。同一 (provider, open_id) 已绑别人则拒绝。
router.get('/admin/orgs/:sid/members/:uid/credentials', requireAuth, (req, res) => {
  const s = oauthSubjects.get.get(req.params.sid);
  if (!s) return res.status(404).json({ error: '组织不存在' });
  if (!canManageOrg(req, s.id, false)) return res.status(403).json({ error: '无权管理该组织' });
  const target = findRealUserByUid(req.params.uid);
  if (!target || !orgMembers.get.get(s.id, target.id)) return res.status(404).json({ error: '成员不存在' });
  const binds = oauth.findByUser.all(target.id).map(b => ({ provider: b.provider, open_id: b.open_id }));
  res.json({ success: true, data: binds });
});
router.post('/admin/orgs/:sid/members/:uid/credentials', requireAuth, (req, res) => {
  const s = oauthSubjects.get.get(req.params.sid);
  if (!s) return res.status(404).json({ error: '组织不存在' });
  if (!canManageOrg(req, s.id)) return res.status(403).json({ error: '无权管理该组织' });
  const target = findRealUserByUid(req.params.uid);
  if (!target || !orgMembers.get.get(s.id, target.id)) return res.status(404).json({ error: '成员不存在' });
  const provider = String(req.body?.provider || '').trim();     // 平台名 或 平台名:实例id
  const openId = String(req.body?.open_id || '').trim();
  const platform = provider.split(':')[0];
  if (!OAUTH_META[platform]) return res.status(400).json({ error: '未知登录平台' });
  if (!openId) return res.status(400).json({ error: '请填写该成员在此平台的标识（如企业微信 UserId、飞书 open_id）' });
  const owner = oauth.findByProvider.get(provider, openId);
  if (owner && owner.id !== target.id) return res.status(400).json({ error: '该三方账号已绑定到其他用户' });
  oauth.bind.run(uuidv4(), target.id, provider, openId, null);
  res.json({ success: true });
});
router.delete('/admin/orgs/:sid/members/:uid/credentials', requireAuth, (req, res) => {
  const s = oauthSubjects.get.get(req.params.sid);
  if (!s) return res.status(404).json({ error: '组织不存在' });
  if (!canManageOrg(req, s.id)) return res.status(403).json({ error: '无权管理该组织' });
  const target = findRealUserByUid(req.params.uid);
  if (!target || !orgMembers.get.get(s.id, target.id)) return res.status(404).json({ error: '成员不存在' });
  const provider = String(req.body?.provider || req.query?.provider || '').trim();
  if (!provider) return res.status(400).json({ error: '缺少 provider' });
  oauth.unbind.run(target.id, provider);
  res.json({ success: true });
});

// 同一人多个账号合并（v3.5.41）：企业微信等通讯录里一人多号（多个 UserId）时，同步会各建一个账号，
// 组织管理员在成员列表里把它们合并成一个——登录绑定、同步映射、组织成员关系等搬到保留账号，其余停用。
// 组织管理员（非系统管理员）只能合并「只在本组织、没有平台密码 / 实名 / Passkey / 两步验证」的账号，
// 免得把别处有身份的人并走；系统管理员不受此限（管理员账号、实名不同人一律不能被合并）。
router.post('/admin/orgs/:sid/members/merge', requireAuth, (req, res) => {
  const s = oauthSubjects.get.get(req.params.sid);
  if (!s) return res.status(404).json({ error: '组织不存在' });
  if (!canManageOrg(req, s.id)) return res.status(403).json({ error: '无权管理该组织' });
  const targetId = String(req.body?.target || '');
  const sourceIds = [...new Set((Array.isArray(req.body?.sources) ? req.body.sources : []).map(String))].filter(id => id && id !== targetId);
  for (const id of [targetId, ...sourceIds]) {
    if (!orgMembers.get.get(s.id, id)) return res.status(400).json({ error: '只能合并本组织的成员' });
  }
  const target = users.findById.get(targetId);
  const sources = sourceIds.map(id => users.findById.get(id));
  const bad = userMerge.checkMerge(target, sources);
  if (bad) return res.status(400).json({ error: bad });
  if (!isSysAdmin(req, 2)) {
    for (const u of sources) {
      const why = db.prepare('SELECT COUNT(*) AS n FROM org_members WHERE user_id=?').get(u.id).n > 1 ? '还在其他组织里'
        : u.password_hash ? '设置了平台密码'
        : u.kyc_verified ? '已实名'
        : u.twofa_enabled ? '开了两步验证'
        : db.prepare('SELECT 1 FROM webauthn_credentials WHERE user_id=?').get(u.id) ? '绑了 Passkey' : '';
      if (why) return res.status(403).json({ error: `「${u.name}」${why}，需要系统管理员来合并` });
    }
  }
  try {
    const r = userMerge.mergeUsers(target.id, sources.map(u => u.id), {
      onAppRevoked: (a, from, to) => deprovisionPush(a, { event: 'user.merged', sub: from.id, uid: from.uid_seq, merged_into: to.id, merged_into_uid: to.uid_seq }),
      actor: actorOf(req), actorUid: req.user.uid, via: 'org_admin',
    });
    audit('user.merged', { subject: String(target.uid_seq), actor: actorOf(req),
      detail: { org: s.id, via: 'org_admin', merge_id: r.merge_id, sources: r.merged.map(m => m.uid_seq), moved: r.moved } });
    res.json({ success: true, ...r });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
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
router.get('/memos/:id/attachments/:aid', requireAuth, noPublic, async (req, res) => {
  const m = memoOf(req, res); if (!m) return;
  const a = memoAtt.get.get(req.params.aid, m.id);
  if (!a || a.kind === 'link' || !a.data) return res.status(404).json({ error: '附件不存在' });
  let data = a.data;
  // 缩略图（?thumb=1，备忘录列表里的小图）：缩到 120px 内，不烧水印也不记存证——这么小没有外泄价值，
  // 否则每打开一次备忘录就要为每张小图烧录 + 记一条审计。开了烧录却缩不了图（sharp 不可用）时不给原图。
  if (req.query.thumb === '1' && a.kind === 'image') {
    try {
      const thumb = await require('sharp')(Buffer.from(a.data), { animated: false }).rotate()
        .resize(120, 120, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 70 }).toBuffer();
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.send(thumb);
    } catch (_) {
      if (wmBurn.isBurnOn()) return res.status(404).json({ error: '缩略图不可用' });
    }
  }
  // 导出加水印（v3.5.33）：图片 / PDF 下发前把「当前查看人 + 时间 + 追踪码」烧进文件本身。
  // 失败即拒绝（绝不退回原文件）；docx 等无法烧录的类型照常下发。
  if (wmBurn.isBurnOn() && wmBurn.canBurn(a.mime)) {
    const trace = wmBurn.genTrace();
    const viewer = users.findById.get(req.user.uid);
    try {
      const out = await wmBurn.burn(Buffer.from(a.data), a.mime, { user: viewer, policy: watermarkPolicy(), trace });
      data = out.data;
      audit('file.watermarked', { subject: viewer ? String(viewer.uid_seq) : null, actor: actorOf(req),
        detail: { trace, memo: m.id, attachment: a.id, file: String(a.filename || '').slice(0, 80), mime: a.mime, cjk: out.cjk } });
    } catch (e) {
      console.warn('[水印] 烧录失败：', e.message);
      return res.status(500).json({ error: '水印处理失败，已拒绝下发该文件（' + e.message.slice(0, 80) + '）' });
    }
    res.setHeader('Cache-Control', 'no-store');   // 每次下发的水印（时间/追踪码）都不同，别缓存
  }
  res.setHeader('Content-Type', a.mime || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // 图片和 PDF 允许内联查看；其余（docx 等）强制下载，防在站内直接执行/渲染
  const inline = a.kind === 'image' || a.mime === 'application/pdf';
  const dispName = encodeURIComponent(a.filename || 'file');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${dispName}`);
  res.send(data);
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
    // 多手机/多邮箱：email/phone 为主值；emails[]/phones[] 为可选的更多联系方式（写进 user_contacts）
    const emailsIn = [raw?.email, ...(Array.isArray(raw?.emails) ? raw.emails : [])].map(x => String(x || '').trim()).filter(Boolean);
    const phonesIn = [raw?.phone, ...(Array.isArray(raw?.phones) ? raw.phones : [])].map(x => normalizePhone(x)).filter(Boolean);   // v3.5.71 归一化带码
    const goodEmails = [...new Set(emailsIn.map(e => e.toLowerCase()).filter(isEmail))];
    const goodPhones = [...new Set(phonesIn.filter(isPhone))];
    const email = goodEmails[0] || '';   // 第一个有效邮箱做主字段
    const phone = goodPhones[0] || '';    // 第一个有效手机做主字段
    const name = String(raw?.name || '').trim();
    let orgUid = String(raw?.org_uid || '').trim() || null;
    // 有填但一个都不合法 → 报错；完全没填 → 报错
    if (emailsIn.length && !goodEmails.length) { results.push({ email: emailsIn[0], status: 'error', error: '邮箱格式不正确' }); continue; }
    if (phonesIn.length && !goodPhones.length) { results.push({ phone: phonesIn[0], status: 'error', error: '手机号格式不正确' }); continue; }
    if (!email && !phone) { results.push({ status: 'error', error: '缺少 email 或 phone' }); continue; }
    let user = (email && users.findByEmail.get(email)) || (phone && users.findByPhone.get(phone)) || null;
    if (!user) { for (const e of goodEmails) { user = users.findByEmail.get(e); if (user) break; } }
    if (!user) { for (const p of goodPhones) { user = users.findByPhone.get(p); if (user) break; } }
    if (user && user.is_public) { results.push({ email, phone, status: 'error', error: '命中公共账号，跳过' }); continue; }
    let created = false;
    if (!user) {
      user = users.create({ name: name || (email ? email.split('@')[0] : '用户' + phone.slice(-4)), email: email || null, phone: phone || null });
      created = true;
    } else if (name && !user.name) {
      db.prepare('UPDATE users SET name=? WHERE id=?').run(name, user.id);
    }
    // 把这一行的全部手机/邮箱灌进多联系方式（去重 + 按组织上限，静默跳过），包括已做主字段的那个
    for (const e of goodEmails) { try { contactUtil.addContact(user.id, 'email', e, 'import', subject.id); } catch (_) {} }
    for (const p of goodPhones) { try { contactUtil.addContact(user.id, 'phone', p, 'import', subject.id); } catch (_) {} }
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
    results.push({ email, phone, uid: user.uid_seq, org_uid: orgUid || existing?.org_uid || null, contacts: goodEmails.length + goodPhones.length, status: created ? 'created' : (existing ? 'updated' : 'added') });
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
// 外部通讯录同步（v3.5.35，先做企业微信）：组织 ← 企业微信某部门（含子部门）的成员
// 配置存 oauth_subjects.dir_sync（JSON，含通讯录 secret），结果存 dir_sync_state。
// ══════════════════════════════════════════
const dirsyncWecom = require('./dirsync-wecom');
const dirsync = require('./dirsync');            // v3.5.59：按同步源 type 找驱动（企业微信 / 飞书）
const drvOf = (t) => dirsync.driver(t) || dirsync.driver('wecom');
const notifyHub = require('./notify');
const SECRET_MASK = '••••••••';
const DIR_TYPES = { wecom: '企业微信', feishu: '飞书' };   // 以后加钉钉：在这里登记 + 写对应的 dirsync-xxx.js + 在 dirsync.js 登记驱动
const _dirSyncRunning = new Set();               // 按组织加锁：同一组织的多个源不并发跑（会互相影响移出判断）
const parseJ = (t) => { try { return t ? JSON.parse(t) : null; } catch (_) { return null; } };
const FORCE_CONFIRM = '全部覆盖';                 // 强确认「全部覆盖同步」要求原样输入的口令
function dirSourceView(src, subject) {
  const drv = drvOf(src.type);
  const cfg = drv.effectiveCfg(src);
  const parent = src.parent_id ? dirSources.get.get(src.parent_id) : null;
  const { default_pw_hash, cb_aes_key, ...pub } = cfg;     // 默认组织密码只存哈希、回调 EncodingAESKey 打码，都不下发
  const bindProviders = subject && cfg.corp_id ? drv.bindProvidersFor(subject, cfg) : [];
  const cbSrc = parent || src;   // 套用文件夹通讯录的：回调地址 / 事件状态都在文件夹那份连接上
  return { id: src.id, subject_id: src.subject_id, type: src.type, type_label: DIR_TYPES[src.type] || src.type,
    label: src.label || DIR_TYPES[src.type] || src.type, enabled: !!src.enabled,
    // v3.5.47：套用的文件夹通讯录（连接字段只读，来自文件夹）
    parent_id: src.parent_id || null, parent_label: parent ? (parent.label || DIR_TYPES[parent.type]) : null,
    parent_enabled: parent ? !!parent.enabled : null, parent_missing: !!(src.parent_id && !parent),
    config: { ...pub, secret: cfg.secret ? SECRET_MASK : '', write_secret: cfg.write_secret ? SECRET_MASK : '', dept_ids: drv.deptIdsOf(cfg),
      bind_mode: cfg.bind_mode || 'auto', has_default_pw: !!default_pw_hash,
      cb_token: cfg.cb_token || '', cb_aes_key: cb_aes_key ? SECRET_MASK : '' },
    // 接收事件服务器（v3.5.39）：企业微信后台「通讯录同步 → 设置接收事件服务器」填这个地址（前面拼上本站域名）
    callback_path: `/api/public/dirsync/${src.type === 'feishu' ? 'feishu' : 'wecom'}/` + cbSrc.id,
    // 飞书：Verification Token 必填、Encrypt Key 可选；企业微信：Token + EncodingAESKey 都要
    callback_ready: src.type === 'feishu' ? !!cfg.cb_token : !!(cfg.cb_token && cb_aes_key),
    event_state: parseJ(cbSrc.event_state),
    state: parseJ(src.state),
    bind_provider: bindProviders[0] || null, bind_providers: bindProviders,
    running: _dirSyncRunning.has(src.subject_id), created_at: src.created_at };
}
// 文件夹上的通讯录连接（v3.5.47）：企业 ID / Secret / 回调；下面挂着各组织的「套用」
const cbReady = (type, cfg) => type === 'feishu' ? !!cfg.cb_token : !!(cfg.cb_token && cfg.cb_aes_key);
function dirConnView(conn) {
  const cfg = parseJ(conn.config) || {};
  const drv = drvOf(conn.type);
  return { id: conn.id, folder_id: conn.folder_id, type: conn.type, type_label: DIR_TYPES[conn.type] || conn.type,
    label: conn.label || DIR_TYPES[conn.type] || conn.type, enabled: !!conn.enabled,
    config: { corp_id: cfg.corp_id || '', secret: cfg.secret ? SECRET_MASK : '', write_secret: cfg.write_secret ? SECRET_MASK : '', push_suspend: !!cfg.push_suspend,
      cb_token: cfg.cb_token || '', cb_aes_key: cfg.cb_aes_key ? SECRET_MASK : '' },
    callback_path: `/api/public/dirsync/${conn.type === 'feishu' ? 'feishu' : 'wecom'}/` + conn.id,
    callback_ready: cbReady(conn.type, cfg),
    event_state: parseJ(conn.event_state),
    uses: dirSources.children.all(conn.id).map(u => {
      const o = oauthSubjects.get.get(u.subject_id); const uc = parseJ(u.config) || {};
      return { id: u.id, subject_id: u.subject_id, org_name: o ? o.name : '（已删除的组织）', label: u.label, enabled: !!u.enabled,
        dept_ids: drv.deptIdsOf(uc), dept_names: uc.dept_names || {}, state: parseJ(u.state), running: _dirSyncRunning.has(u.subject_id) };
    }),
    created_at: conn.created_at };
}
const isFolderConn = (src) => !!(src && src.folder_id && !src.subject_id);
// 同步范围（部门）：数组，兼容旧的单个 dept_id；顺带存部门名给列表展示
function dirScopeFromBody(b, old, type = 'wecom') {
  let ids = Array.isArray(b.dept_ids) ? b.dept_ids : (b.dept_id !== undefined ? [b.dept_id] : null);
  if (!ids) return { dept_ids: drvOf(type).deptIdsOf(old), dept_names: old.dept_names || {} };
  if (type === 'feishu') {   // 飞书部门 ID 是 open_department_id 字符串，根部门 "0"
    ids = [...new Set(ids.map(x => String(x).trim()).filter(x => /^[A-Za-z0-9_-]{1,64}$/.test(x)))].slice(0, 50);
    if (!ids.length) ids = ['0'];
  } else {
    ids = [...new Set(ids.map(x => parseInt(x, 10)).filter(x => x > 0))].slice(0, 50);
    if (!ids.length) ids = [1];
  }
  const names = {};
  const src = b.dept_names && typeof b.dept_names === 'object' ? b.dept_names : (old.dept_names || {});
  for (const id of ids) if (src[id]) names[id] = String(src[id]).slice(0, 60);
  return { dept_ids: ids, dept_names: names };
}
// 接收事件服务器（v3.5.39）：Token（≤32 位字母数字）+ EncodingAESKey（43 位）；AESKey 打码串/留空 = 不改，cb_clear = 关闭
function applyCbFields(cfg, b, old, type = 'wecom') {
  if (b.cb_clear) { delete cfg.cb_token; delete cfg.cb_aes_key; return null; }
  const tok = b.cb_token !== undefined ? String(b.cb_token).trim() : (old.cb_token || '');
  let aes = String(b.cb_aes_key ?? '').trim();
  if (!aes || /^•+$/.test(aes)) aes = old.cb_aes_key || '';
  if (type === 'feishu') {   // 飞书事件订阅：Verification Token 必填，Encrypt Key 可选（飞书后台生成，直接复制过来）
    if (b.cb_aes_clear) aes = '';
    if (tok && !/^[\x21-\x7e]{1,64}$/.test(tok)) return 'Verification Token 应为 1~64 位、不含空格';
    if (aes && !/^[\x21-\x7e]{1,64}$/.test(aes)) return 'Encrypt Key 应为 1~64 位、不含空格';
    if (aes && !tok) return '填了 Encrypt Key 也要填 Verification Token';
    if (tok) { cfg.cb_token = tok; if (aes) cfg.cb_aes_key = aes; else delete cfg.cb_aes_key; } else { delete cfg.cb_token; delete cfg.cb_aes_key; }
    return null;
  }
  if (tok && !/^[A-Za-z0-9]{1,32}$/.test(tok)) return '回调 Token 应为 1~32 位英文字母或数字';
  if (aes && !/^[A-Za-z0-9]{43}$/.test(aes)) return 'EncodingAESKey 应为 43 位英文字母或数字';
  if (!!tok !== !!aes) return '接收事件服务器的 Token 和 EncodingAESKey 要一起填（或都留空）';
  if (tok) { cfg.cb_token = tok; cfg.cb_aes_key = aes; } else { delete cfg.cb_token; delete cfg.cb_aes_key; }
  return null;
}
// 文件夹通讯录连接的配置：只有连接字段
function buildDirConnCfg(b, old, type = 'wecom') {
  old = old || {};
  const r = dirSourceCfgFromBody(b, old, type);
  if (r.error) return r;
  const cfg = { corp_id: r.cfg.corp_id, secret: r.cfg.secret };
  if (r.cfg.write_secret) cfg.write_secret = r.cfg.write_secret;
  if (r.cfg.push_suspend) cfg.push_suspend = true;
  const e = applyCbFields(cfg, b, old, type);
  return e ? { error: e } : { cfg };
}
// opts.use = 套用的文件夹连接配置（v3.5.47）：企业 ID / Secret 用文件夹的，自己只存组织级字段
async function buildDirSourceCfg(b, old, subject, opts = {}) {
  old = old || {};
  const type = opts.type || 'wecom';
  if (opts.use) b = { ...b, corp_id: opts.use.corp_id, secret: opts.use.secret };
  const r = dirSourceCfgFromBody(b, old, type);
  if (r.error) return r;
  const cfg = r.cfg;
  Object.assign(cfg, dirScopeFromBody(b, old, type));
  delete cfg.dept_id;
  // 同步后绑定到哪些登录凭证：auto（同企业的那个）/ custom（勾选）/ none（不绑）
  const mode = ['auto', 'custom', 'none'].includes(b.bind_mode) ? b.bind_mode : (old.bind_mode || 'auto');
  cfg.bind_mode = mode;
  if (mode === 'custom') {
    // 飞书只能绑同一个 App ID 的登录凭证（open_id 每个应用一份）
    const valid = new Set(drvOf(type).loginProviderChoices(subject).filter(x => type !== 'feishu' || x.corp_id === cfg.corp_id).map(x => x.key));
    const list = Array.isArray(b.bind_providers) ? b.bind_providers : (old.bind_providers || []);
    cfg.bind_providers = [...new Set(list.map(String))].filter(k => valid.has(k));
    if (!cfg.bind_providers.length) return { error: type === 'feishu' ? '请至少勾选一个同一 App ID 的飞书登录凭证，或改为「不绑定」' : '请至少勾选一个要绑定的登录凭证，或改为「不绑定」' };
  } else delete cfg.bind_providers;
  if (opts.use) {
    for (const k of dirsyncWecom.CONN_KEYS) delete cfg[k];   // 套用文件夹通讯录：连接字段不存在自己身上
  } else {
    const e = applyCbFields(cfg, b, old, type);
    if (e) return { error: e };
  }
  // 默认组织密码：只存 bcrypt 哈希；留空 = 不改，clear_default_password = 清除
  if (b.clear_default_password) delete cfg.default_pw_hash;
  else if (b.default_password) {
    const pw = String(b.default_password);
    if (pw.length < 6 || pw.length > 64) return { error: '默认组织密码 6~64 位' };
    cfg.default_pw_hash = await bcrypt.hash(pw, 12);
  } else if (old.default_pw_hash) cfg.default_pw_hash = old.default_pw_hash;
  return { cfg };
}
function dirSourceCfgFromBody(b, old, type = 'wecom') {
  old = old || {};
  const feishu = type === 'feishu';
  const corp_id = String(b.corp_id ?? old.corp_id ?? '').trim().slice(0, 64);
  if (feishu ? !/^cli_[A-Za-z0-9]{4,60}$/.test(corp_id) : !/^[A-Za-z0-9_-]{4,64}$/.test(corp_id)) return { error: feishu ? '请填写正确的飞书 App ID（cli_ 开头）' : '请填写正确的企业 ID（corpid）' };
  let secret = String(b.secret ?? '').trim();
  if (!secret || /^•+$/.test(secret)) secret = old.secret || '';   // 打码串 / 留空 = 不改
  if (!secret) return { error: feishu ? '请填写飞书应用的 App Secret' : '请填写读取通讯录用的 Secret（推荐自建应用 Secret）' };
  // 管理用 Secret（v3.5.50，可选）：企业微信「通讯录同步」Secret，禁用 / 启用 / 删除成员时用；打码串 / 留空 = 不改，clear_write_secret = 清除
  let write_secret = String(b.write_secret ?? '').trim();
  if (b.clear_write_secret || feishu) write_secret = '';   // 飞书读写用同一个应用
  else if (!write_secret || /^•+$/.test(write_secret)) write_secret = old.write_secret || '';
  return { cfg: {
    corp_id, secret: secret.slice(0, 200), ...(write_secret ? { write_secret: write_secret.slice(0, 200) } : {}),
    uid_mode: ['userid', 'rule', 'none'].includes(b.uid_mode) ? b.uid_mode : (old.uid_mode || 'userid'),
    remove_missing: b.remove_missing !== undefined ? b.remove_missing !== false : old.remove_missing !== false,
    // 只拿到 UserId（通讯录 Secret 受限）的成员也建账号（姓名先用 UserId 占位，拿到真名后自动替换；一人多号可在成员列表合并）
    idonly_create: b.idonly_create !== undefined ? b.idonly_create !== false : old.idonly_create !== false,
    // 本系统账号停用 / 删除时，同步把企业微信成员设为禁用（恢复时启用）。需有通讯录写权限的 Secret（v3.5.44，默认关）
    push_suspend: b.push_suspend !== undefined ? b.push_suspend === true : !!old.push_suspend,
    interval_hours: Math.min(168, Math.max(0, parseInt(b.interval_hours ?? old.interval_hours, 10) || 0)),
    // v3.5.73：每天固定时间点同步（["HH:MM", ...]，本地时间；非空时优先于 interval_hours）
    schedule_times: b.schedule_times !== undefined
      ? (Array.isArray(b.schedule_times) ? b.schedule_times : []).map(t => String(t).trim()).filter(t => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)).slice(0, 24)
      : (old.schedule_times || []),
    // v3.5.75：待分配部门 id（成员在这个部门 → 标记「待分配」，等人分配实际部门；空=不启用）
    pending_dept_id: b.pending_dept_id !== undefined ? String(b.pending_dept_id || '').trim().slice(0, 64) : (old.pending_dept_id || ''),
  } };
}
async function runDirSource(src, actor, opts = {}) {
  const subject = oauthSubjects.get.get(src.subject_id);
  if (!subject) throw Object.assign(new Error('组织不存在'), { status: 404 });
  if (src.parent_id) {
    const parent = dirSources.get.get(src.parent_id);
    if (!parent) throw Object.assign(new Error('套用的文件夹通讯录已被删除'), { status: 400 });
    if (!parent.enabled) throw Object.assign(new Error('套用的文件夹通讯录已停用'), { status: 400 });
  }
  const drv = dirsync.driver(src.type);
  if (!drv) throw Object.assign(new Error('暂不支持该类型的同步源'), { status: 400 });
  const cfg = drv.effectiveCfg(src);
  if (!cfg || !cfg.corp_id || !cfg.secret) throw Object.assign(new Error(src.type === 'feishu' ? '同步源配置不完整（App ID / App Secret）' : '同步源配置不完整（企业 ID / 通讯录 Secret）'), { status: 400 });
  if (_dirSyncRunning.has(subject.id)) throw Object.assign(new Error('该组织正在同步中，请稍后'), { status: 409 });
  _dirSyncRunning.add(subject.id);
  const at = new Date().toISOString();
  const prevState = parseJ(src.state) || {};
  const srcName = `${subject.name} · ${src.label || DIR_TYPES[src.type]}`;
  try {
    const out = await drv.sync(src, subject, cfg, { genOrgUid, isEmail, isPhone }, undefined, { force: !!opts.force });
    const state = { at, ok: true, total: out.total, created: out.created, linked: out.linked, added: out.added,
      removed: out.removed, skipped: out.skipped, bind_provider: out.bind_provider, bind_providers: out.bind_providers,
      bound: out.bound, pw_set: out.pw_set, kept: out.kept, conflicts: out.conflicts, force: out.force,
      limited: out.limited, unmatched: out.unmatched, created_idonly: out.created_idonly || 0, blocked: out.blocked || 0, duplicates: out.duplicates || 0, warning: out.warning,
      errors: out.errors.slice(0, 20) };
    dirSources.setState.run(JSON.stringify(state), src.id);
    // 通知（v3.5.52）：遗留重复账号数变了才推，免得定时同步每次都推一遍
    if (state.duplicates && state.duplicates !== prevState.duplicates)
      notifyHub.notify('dirsync', `通讯录同步发现 ${state.duplicates} 个人有重复账号`, [`同步源：${srcName}`, '到「组织管理」页顶部的「企业微信重复账号」里合并']);
    audit('org.dir_synced', { subject: subject.id, actor, detail: { source: src.type, source_id: src.id, label: src.label, force: out.force, total: out.total, created: out.created, added: out.added, removed: out.removed, bound: out.bound, pw_set: out.pw_set, kept: out.kept, errors: out.errors.length } });
    return state;
  } catch (e) {
    const err = String(e.message || e).slice(0, 300);
    dirSources.setState.run(JSON.stringify({ at, ok: false, error: err }), src.id);
    // 从正常变成失败、或失败原因变了才推（定时同步一直失败时不会每 10 分钟推一次）
    if (prevState.ok !== false || prevState.error !== err)
      notifyHub.notify('dirsync', '通讯录同步失败', [`同步源：${srcName}`, `原因：${err}`, `触发：${actor}`]);
    throw e;
  } finally {
    _dirSyncRunning.delete(subject.id);
  }
}
// 取同步源 + 校验对其所属组织的管理权
function dirSourceFor(req, res, write = true) {
  const src = dirSources.get.get(req.params.id);
  if (!src || isFolderConn(src)) { res.status(404).json({ error: '同步源不存在' }); return null; }
  if (!canManageOrg(req, src.subject_id, write)) { res.status(403).json({ error: '无权管理该组织' }); return null; }
  return src;
}
router.get('/admin/orgs/:sid/dir-sources', requireAuth, (req, res) => {
  const s = oauthSubjects.get.get(req.params.sid);
  if (!s) return res.status(404).json({ error: '组织不存在' });
  if (!canManageOrg(req, s.id, false)) return res.status(403).json({ error: '无权管理该组织' });
  res.json({ success: true, types: Object.entries(DIR_TYPES).map(([key, label]) => ({ key, label })),
    bind_choices: dirsyncWecom.loginProviderChoices(s), bind_choices_feishu: drvOf('feishu').loginProviderChoices(s), force_confirm: FORCE_CONFIRM,
    // 所在文件夹的通讯录连接（v3.5.47，可「套用」；只给名称与企业 ID）
    folder_connections: s.folder_id ? dirSources.byFolder.all(s.folder_id).map(c => ({ id: c.id, label: c.label || DIR_TYPES[c.type], type: c.type,
      corp_id: (parseJ(c.config) || {}).corp_id || '', enabled: !!c.enabled })) : [],
    can_use_folder: isSysAdmin(req, 2),
    sources: dirSources.bySubject.all(s.id).map(x => dirSourceView(x, s)) });
});
// 这个 Secret 能看到哪些部门（总公司账号只开了部分部门权限时，用来挑同步范围）。
// 编辑已有同步源时 secret 可留空/打码 = 用已存的。
router.post('/admin/orgs/:sid/dir-sources/scope-tree', requireAuth, async (req, res) => {
  const s = oauthSubjects.get.get(req.params.sid);
  if (!s) return res.status(404).json({ error: '组织不存在' });
  if (!canManageOrg(req, s.id)) return res.status(403).json({ error: '无权管理该组织' });
  const b = req.body || {};
  let old = {}, fromFolder = false, type = DIR_TYPES[b.type] ? String(b.type) : 'wecom';
  if (b.source_id) {
    const src = dirSources.get.get(b.source_id);
    if (!src || src.subject_id !== s.id) return res.status(404).json({ error: '同步源不存在' });
    old = drvOf(src.type).effectiveCfg(src); fromFolder = !!src.parent_id; type = src.type;
  } else if (b.parent_id) {   // 新建「套用」时：用文件夹连接的企业 ID / Secret
    const conn = dirSources.get.get(b.parent_id);
    if (!isFolderConn(conn) || conn.folder_id !== s.folder_id) return res.status(404).json({ error: '文件夹通讯录不存在' });
    old = parseJ(conn.config) || {}; fromFolder = true; type = conn.type;
  }
  if (fromFolder) {   // 文件夹通讯录：企业 ID / Secret 只用文件夹的；看整个企业的部门树只给系统管理员
    if (!isSysAdmin(req, 2)) return res.status(403).json({ error: '套用文件夹通讯录的同步范围需要系统管理员修改' });
    b.corp_id = ''; b.secret = '';
  }
  const corp_id = String(b.corp_id || old.corp_id || '').trim();
  let secret = String(b.secret || '').trim();
  if (!secret || /^•+$/.test(secret)) secret = old.secret || '';
  if (!corp_id || !secret) return res.status(400).json({ error: type === 'feishu' ? '请先填写飞书 App ID 与 App Secret' : '请先填写企业 ID 与通讯录 Secret' });
  try { const nodes = await drvOf(type).fetchScopeTree({ corp_id, secret }); res.json({ success: true, nodes, limited: !!nodes.limited, warning: nodes.limited ? drvOf(type).LIMITED_HINT : undefined }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
router.post('/admin/orgs/:sid/dir-sources', requireAuth, async (req, res) => {
  const s = oauthSubjects.get.get(req.params.sid);
  if (!s) return res.status(404).json({ error: '组织不存在' });
  if (!canManageOrg(req, s.id)) return res.status(403).json({ error: '无权管理该组织' });
  const type = String(req.body?.type || 'wecom');
  if (!DIR_TYPES[type]) return res.status(400).json({ error: '暂不支持该类型的同步源' });
  if (dirSources.bySubject.all(s.id).length >= 20) return res.status(400).json({ error: '同步源太多了（上限 20）' });
  // 套用文件夹通讯录（v3.5.47）：只有系统管理员能挑部门（文件夹的 Secret 看得到整个企业，组织管理员不能自己选范围）
  let conn = null;
  if (req.body?.parent_id) {
    if (!isSysAdmin(req, 2)) return res.status(403).json({ error: '套用文件夹通讯录需要系统管理员操作' });
    conn = dirSources.get.get(String(req.body.parent_id));
    if (!isFolderConn(conn) || !s.folder_id || conn.folder_id !== s.folder_id) return res.status(400).json({ error: '只能套用本组织所在文件夹的通讯录' });
    if (dirSources.children.all(conn.id).some(u => u.subject_id === s.id)) return res.status(400).json({ error: '本组织已经套用了这份通讯录' });
    if (req.body?.type && String(req.body.type) !== conn.type) return res.status(400).json({ error: `这份文件夹通讯录是${DIR_TYPES[conn.type] || conn.type}的` });
  }
  const useType = conn ? conn.type : type;   // 套用时类型跟着文件夹那份走
  const { cfg, error } = await buildDirSourceCfg(req.body || {}, null, s, conn ? { use: parseJ(conn.config) || {}, type: useType } : { type });
  if (error) return res.status(400).json({ error });
  const id = uuidv4();
  const label = String(req.body?.label || '').trim().slice(0, 40) || (conn ? (conn.label || DIR_TYPES[type]) : DIR_TYPES[type]);
  if (conn) dirSources.insertUse.run(id, s.id, conn.id, conn.type, label, JSON.stringify(cfg), req.body?.enabled === false ? 0 : 1);
  else dirSources.insert.run(id, s.id, type, label, JSON.stringify(cfg), req.body?.enabled === false ? 0 : 1);
  audit('org.dir_sync_configured', { subject: s.id, actor: actorOf(req), detail: { op: 'create', source: type, source_id: id, label, parent_id: conn ? conn.id : undefined, corp_id: conn ? (parseJ(conn.config) || {}).corp_id : cfg.corp_id, dept_ids: cfg.dept_ids, bind_mode: cfg.bind_mode, default_pw: !!cfg.default_pw_hash } });
  res.json({ success: true, source: dirSourceView(dirSources.get.get(id), s) });
});
router.patch('/admin/dir-sources/:id', requireAuth, async (req, res) => {
  const src = dirSourceFor(req, res); if (!src) return;
  const b = req.body || {};
  let cfg = parseJ(src.config) || {};
  const onlyToggle = Object.keys(b).every(k => k === 'enabled');
  if (!onlyToggle) {
    let use = null;
    if (src.parent_id) {
      if (!isSysAdmin(req, 2)) return res.status(403).json({ error: '套用文件夹通讯录的同步范围需要系统管理员修改' });
      const conn = dirSources.get.get(src.parent_id);
      if (!conn) return res.status(400).json({ error: '套用的文件夹通讯录已被删除' });
      use = parseJ(conn.config) || {};
    }
    const r = await buildDirSourceCfg(b, cfg, oauthSubjects.get.get(src.subject_id), use ? { use, type: src.type } : { type: src.type });
    if (r.error) return res.status(400).json({ error: r.error });
    cfg = r.cfg;
  }
  const label = b.label !== undefined ? (String(b.label).trim().slice(0, 40) || DIR_TYPES[src.type]) : src.label;
  const enabled = b.enabled !== undefined ? (b.enabled ? 1 : 0) : src.enabled;
  dirSources.update.run(label, JSON.stringify(cfg), enabled, src.id);
  audit('org.dir_sync_configured', { subject: src.subject_id, actor: actorOf(req), detail: { op: onlyToggle ? (enabled ? 'enable' : 'disable') : 'update', source_id: src.id, label, ...(onlyToggle ? {} : { dept_ids: cfg.dept_ids, bind_mode: cfg.bind_mode, default_pw: !!cfg.default_pw_hash, default_pw_changed: !!(b.default_password || b.clear_default_password) }) } });
  res.json({ success: true, source: dirSourceView(dirSources.get.get(src.id), oauthSubjects.get.get(src.subject_id)) });
});
router.delete('/admin/dir-sources/:id', requireAuth, (req, res) => {
  const src = dirSourceFor(req, res); if (!src) return;
  dirSources.removeLinks.run(src.id);
  dirSources.removeApplied.run(src.id);
  dirSources.remove.run(src.id);
  audit('org.dir_sync_configured', { subject: src.subject_id, actor: actorOf(req), detail: { op: 'delete', source_id: src.id, label: src.label } });
  res.json({ success: true });   // 已同步进来的成员保留（不随同步源删除而移出）
});
router.post('/admin/dir-sources/:id/run', requireAuth, async (req, res) => {
  const src = dirSourceFor(req, res); if (!src) return;
  if (!src.enabled) return res.status(400).json({ error: '该同步源已停用，先启用再同步' });
  // 全部覆盖同步：连成员被单独改过的登录绑定 / 组织密码也改回同步源的默认值——必须原样输入确认口令
  const force = !!req.body?.force;
  if (force && String(req.body?.confirm || '').trim() !== FORCE_CONFIRM) return res.status(400).json({ error: `全部覆盖同步需要输入确认口令「${FORCE_CONFIRM}」` });
  try { res.json({ success: true, state: await runDirSource(src, actorOf(req), { force }) }); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});
// ── 文件夹资源（v3.5.47）：通讯录连接 + 共用登录凭证，文件夹里的组织套用 ──
// 只有系统管理员能管（文件夹的 Secret 看得到整个企业）。组织管理员能看到 / 启停 / 立即同步自己组织的「套用」。
function folderConnFor(req, res) {
  const conn = dirSources.get.get(req.params.id);
  if (!isFolderConn(conn)) { res.status(404).json({ error: '文件夹通讯录不存在' }); return null; }
  return conn;
}
// 迁移提示：文件夹里各组织自己配的同步源 / 登录凭证，可以逐条确认后挪到文件夹上共用（不确认就照旧工作）
function folderMigrations(folderId) {
  const orgs = oauthSubjects.all.all().filter(s => s.folder_id === folderId);
  const conns = dirSources.byFolder.all(folderId);
  const items = [];
  for (const o of orgs) {
    for (const src of dirSources.bySubject.all(o.id)) {
      if (src.parent_id || !DIR_TYPES[src.type]) continue;
      const cfg = parseJ(src.config) || {};
      const same = conns.find(c => c.type === src.type && (parseJ(c.config) || {}).corp_id === cfg.corp_id);
      items.push({ kind: 'dir_source', id: src.id, org_id: o.id, org_name: o.name, type: src.type, label: src.label || DIR_TYPES[src.type],
        corp_id: cfg.corp_id || '', attach_to: same ? { id: same.id, label: same.label || DIR_TYPES[same.type] } : null,
        secret_differs: same ? (parseJ(same.config) || {}).secret !== cfg.secret : false });
    }
    for (const c of oauthProviders.bySubject.all(o.id)) {
      items.push({ kind: 'credential', id: c.id, org_id: o.id, org_name: o.name, platform: c.platform,
        platform_name: OAUTH_META[c.platform]?.label || c.platform, label: c.label || '',
        has_policy: !!(o.require_2fa || o.ip_allow || o.login_start || o.login_end) });
    }
  }
  return items;
}
function folderResources(folderId) {
  return {
    dir_connections: dirSources.byFolder.all(folderId).map(dirConnView),
    credentials: oauthProviders.byFolder.all(folderId).map(c => ({ ...credView(c),
      orgs: oauthProviders.orgsUsing.all(c.id).map(r => { const o = oauthSubjects.get.get(r.subject_id); return o ? { id: o.id, name: o.name } : null; }).filter(Boolean) })),
    migrations: folderMigrations(folderId),
  };
}
router.get('/admin/org-folders/:id/resources', requireAdmin(3), (req, res) => {
  const f = orgFolders.get.get(req.params.id);
  if (!f) return res.status(404).json({ error: '文件夹不存在' });
  res.json({ success: true, folder: { id: f.id, name: f.name }, ...folderResources(f.id), types: Object.entries(DIR_TYPES).map(([key, label]) => ({ key, label })) });
});
router.post('/admin/org-folders/:id/dir-sources', requireAdmin(2), (req, res) => {
  const f = orgFolders.get.get(req.params.id);
  if (!f) return res.status(404).json({ error: '文件夹不存在' });
  const type = String(req.body?.type || 'wecom');
  if (!DIR_TYPES[type]) return res.status(400).json({ error: '暂不支持该类型的同步源' });
  if (dirSources.byFolder.all(f.id).length >= 20) return res.status(400).json({ error: '通讯录连接太多了（上限 20）' });
  const { cfg, error } = buildDirConnCfg(req.body || {}, null, type);
  if (error) return res.status(400).json({ error });
  if (dirSources.byFolder.all(f.id).some(c => c.type === type && (parseJ(c.config) || {}).corp_id === cfg.corp_id)) return res.status(400).json({ error: type === 'feishu' ? '这个文件夹已经有这个飞书应用的通讯录了' : '这个文件夹已经有这家企业的通讯录了' });
  const id = uuidv4();
  const label = String(req.body?.label || '').trim().slice(0, 40) || DIR_TYPES[type];
  dirSources.insertFolder.run(id, f.id, type, label, JSON.stringify(cfg), req.body?.enabled === false ? 0 : 1);
  audit('folder.dir_conn_configured', { subject: f.id, actor: actorOf(req), detail: { op: 'create', conn_id: id, label, corp_id: cfg.corp_id } });
  res.json({ success: true, connection: dirConnView(dirSources.get.get(id)) });
});
router.patch('/admin/folder-dir-sources/:id', requireAdmin(2), (req, res) => {
  const conn = folderConnFor(req, res); if (!conn) return;
  const b = req.body || {};
  let cfg = parseJ(conn.config) || {};
  const onlyToggle = Object.keys(b).every(k => k === 'enabled');
  if (!onlyToggle) {
    const r = buildDirConnCfg(b, cfg, conn.type);
    if (r.error) return res.status(400).json({ error: r.error });
    if (r.cfg.corp_id !== cfg.corp_id && dirSources.children.all(conn.id).length) return res.status(400).json({ error: conn.type === 'feishu' ? '已有组织在套用这份通讯录，不能改 App ID（要换应用请新建一份）' : '已有组织在套用这份通讯录，不能改企业 ID（要换企业请新建一份）' });
    cfg = r.cfg;
  }
  const label = b.label !== undefined ? (String(b.label).trim().slice(0, 40) || DIR_TYPES[conn.type]) : conn.label;
  const enabled = b.enabled !== undefined ? (b.enabled ? 1 : 0) : conn.enabled;
  dirSources.update.run(label, JSON.stringify(cfg), enabled, conn.id);
  audit('folder.dir_conn_configured', { subject: conn.folder_id, actor: actorOf(req), detail: { op: onlyToggle ? (enabled ? 'enable' : 'disable') : 'update', conn_id: conn.id, label } });
  res.json({ success: true, connection: dirConnView(dirSources.get.get(conn.id)) });
});
router.delete('/admin/folder-dir-sources/:id', requireAdmin(2), (req, res) => {
  const conn = folderConnFor(req, res); if (!conn) return;
  const n = dirSources.children.all(conn.id).length;
  if (n) return res.status(400).json({ error: `还有 ${n} 个组织在套用这份通讯录，先在组织里删掉套用` });
  dirSources.remove.run(conn.id);
  audit('folder.dir_conn_configured', { subject: conn.folder_id, actor: actorOf(req), detail: { op: 'delete', conn_id: conn.id, label: conn.label } });
  res.json({ success: true });
});
router.post('/admin/folder-dir-sources/:id/scope-tree', requireAdmin(2), async (req, res) => {
  const conn = folderConnFor(req, res); if (!conn) return;
  const old = parseJ(conn.config) || {};
  const b = req.body || {};
  const corp_id = String(b.corp_id || old.corp_id || '').trim();
  let secret = String(b.secret || '').trim();
  if (!secret || /^•+$/.test(secret)) secret = old.secret || '';
  const drv = drvOf(conn.type);
  try { const nodes = await drv.fetchScopeTree({ corp_id, secret }); res.json({ success: true, nodes, limited: !!nodes.limited, warning: nodes.limited ? drv.LIMITED_HINT : undefined }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
// 立即同步：依次跑套用这份通讯录的所有启用组织
router.post('/admin/folder-dir-sources/:id/run', requireAdmin(2), async (req, res) => {
  const conn = folderConnFor(req, res); if (!conn) return;
  if (!conn.enabled) return res.status(400).json({ error: '这份通讯录已停用，先启用再同步' });
  const list = dirSources.children.all(conn.id).filter(u => u.enabled);
  if (!list.length) return res.status(400).json({ error: '还没有组织套用这份通讯录（或都停用了）' });
  const results = [];
  for (const u of list) {
    const o = oauthSubjects.get.get(u.subject_id);
    try { results.push({ source_id: u.id, org_name: o?.name, state: await runDirSource(u, actorOf(req)) }); }
    catch (e) { results.push({ source_id: u.id, org_name: o?.name, error: e.message }); }
  }
  res.json({ success: results.some(r => r.state), results });
});
// 文件夹共用的登录凭证
router.post('/admin/org-folders/:id/credentials', requireAdmin(2), (req, res) => {
  const f = orgFolders.get.get(req.params.id);
  if (!f) return res.status(404).json({ error: '文件夹不存在' });
  const { platform, label, config, enabled, sort_weight } = req.body || {};
  const meta = OAUTH_META[platform];
  if (!meta) return res.status(400).json({ error: '未知平台' });
  const cfg = {};
  for (const k of meta.fields) { const v = config?.[k]; if (v != null && v !== '' && !isMaskedVal(v)) cfg[k] = String(v); }
  if (!cfg[meta.primary]) return res.status(400).json({ error: `请填写 ${meta.primary}` });
  const id = uuidv4();
  oauthProviders.insertFolder.run(id, f.id, platform, String(label || '').trim(), JSON.stringify(cfg), enabled === false ? 0 : 1, Number.isFinite(+sort_weight) ? +sort_weight : 0);
  audit('folder.credential_added', { subject: f.id, actor: actorOf(req), detail: { credential: id, platform, label: String(label || '').trim() } });
  res.json({ success: true, id });
});
// 逐条迁移（需要原样输入确认词）：同步源 → 挂到文件夹的通讯录连接下（同一企业已有连接就并进去）；凭证 → 挪到文件夹共用
const MIGRATE_CONFIRM = '迁移';
router.post('/admin/org-folders/:id/migrate', requireAdmin(2), (req, res) => {
  const f = orgFolders.get.get(req.params.id);
  if (!f) return res.status(404).json({ error: '文件夹不存在' });
  const b = req.body || {};
  if (String(b.confirm || '').trim() !== MIGRATE_CONFIRM) return res.status(400).json({ error: `请输入确认词「${MIGRATE_CONFIRM}」` });
  const item = folderMigrations(f.id).find(x => x.kind === b.kind && x.id === b.id);
  if (!item) return res.status(404).json({ error: '这一项不在本文件夹的可迁移列表里（组织不在本文件夹，或已经迁过了）' });
  if (item.kind === 'credential') {
    oauthProviders.moveToFolder.run(f.id, item.id);
    audit('folder.migrated', { subject: f.id, actor: actorOf(req), detail: { kind: 'credential', id: item.id, from_org: item.org_id, platform: item.platform } });
    return res.json({ success: true, kind: 'credential' });
  }
  // v3.5.51：交给文件夹 ≠ 套用。连接字段（企业 ID / Secret / 回调）归文件夹，组织不再自己同步；
  // 要继续同步，由组织自己（或在文件夹面板上）设定套用并选部门。已有的组织成员保留不动。
  const src = dirSources.get.get(item.id);
  const cfg = parseJ(src.config) || {};
  let conn = item.attach_to ? dirSources.get.get(item.attach_to.id) : null;
  db.transaction(() => {
    if (!conn) {
      // 没有同企业连接：原同步源就地变成文件夹连接（id 不变 → 企业微信后台填的回调地址照旧可用）
      const connCfg = {};
      for (const k of dirsyncWecom.CONN_KEYS) if (cfg[k] !== undefined) connCfg[k] = cfg[k];
      db.prepare("UPDATE dir_sync_sources SET subject_id='', folder_id=?, parent_id=NULL, config=?, state=NULL, updated_at=datetime('now') WHERE id=?")
        .run(f.id, JSON.stringify(connCfg), src.id);
      conn = dirSources.get.get(src.id);
    } else {
      // 并进已有连接：它没设回调 / 管理用 Secret 时，把这一份的带过去；原同步源删掉，旧回调地址转到这份连接
      const cc = parseJ(conn.config) || {};
      let changed = false;
      if (!cbReady(conn.type, cc) && cbReady(src.type, cfg)) { cc.cb_token = cfg.cb_token; if (cfg.cb_aes_key) cc.cb_aes_key = cfg.cb_aes_key; else delete cc.cb_aes_key; changed = true; }
      if (!cc.write_secret && cfg.write_secret) { cc.write_secret = cfg.write_secret; changed = true; }
      if (changed) dirSources.update.run(conn.label, JSON.stringify(cc), conn.enabled, conn.id);
      // 映射挪到连接上：不参与任何组织的同步 / 移出，只作为「企业 + UserId → 账号」的认人依据，以后套用时认回同一账号
      db.prepare('UPDATE OR IGNORE dir_source_links SET source_id=? WHERE source_id=?').run(conn.id, src.id);
      dirSources.removeLinks.run(src.id);
      dirSources.remove.run(src.id);
      db.prepare('INSERT OR REPLACE INTO dir_source_alias (old_id, conn_id) VALUES (?,?)').run(src.id, conn.id);
      db.prepare('UPDATE dir_source_alias SET conn_id=? WHERE conn_id=?').run(conn.id, src.id);
    }
    dirSources.removeApplied.run(src.id);
  })();
  audit('folder.migrated', { subject: f.id, actor: actorOf(req), detail: { kind: 'dir_source', id: src.id, from_org: item.org_id, conn_id: conn.id, attached: !!item.attach_to, secret_differs: item.secret_differs } });
  res.json({ success: true, kind: 'dir_source', connection_id: conn.id, attached: !!item.attach_to, secret_differs: item.secret_differs });
});
// ── 文件夹资源给组织使用（v3.5.51）──
// 登录凭证：设定哪些组织使用（只能是文件夹里的组织）
function setFolderCredOrgs(cred, subjectIds, req) {
  const inFolder = new Set(oauthSubjects.all.all().filter(o => o.folder_id === cred.folder_id).map(o => o.id));
  const want = [...new Set((subjectIds || []).map(String))];
  const bad = want.find(id => !inFolder.has(id));
  if (bad) return '只能设定给这个文件夹里的组织';
  db.transaction(() => {
    oauthProviders.clearUsesOf.run(cred.id);
    for (const sid of want) oauthProviders.setUse.run(cred.id, sid);
  })();
  audit('folder.credential_orgs', { subject: cred.folder_id, actor: actorOf(req), detail: { credential: cred.id, orgs: want } });
  return null;
}
const folderCredFor = (id) => { const c = oauthProviders.get.get(id); return c && c.folder_id && !c.subject_id ? c : null; };
router.put('/admin/folder-credentials/:id/orgs', requireAdmin(2), (req, res) => {
  const cred = folderCredFor(req.params.id);
  if (!cred) return res.status(404).json({ error: '文件夹凭证不存在' });
  const err = setFolderCredOrgs(cred, Array.isArray(req.body?.subject_ids) ? req.body.subject_ids : [], req);
  if (err) return res.status(400).json({ error: err });
  res.json({ success: true, orgs: oauthProviders.orgsUsing.all(cred.id).map(r => r.subject_id) });
});
// 组织侧：使用 / 不再使用所在文件夹的某套凭证
router.post('/admin/orgs/:sid/folder-credentials/:cid', requireAdmin(2), (req, res) => {
  const o = oauthSubjects.get.get(req.params.sid);
  const cred = folderCredFor(req.params.cid);
  if (!o || !cred) return res.status(404).json({ error: '组织或文件夹凭证不存在' });
  if (o.folder_id !== cred.folder_id) return res.status(400).json({ error: '这个组织不在该凭证所在的文件夹里' });
  const cur = oauthProviders.orgsUsing.all(cred.id).map(r => r.subject_id).filter(x => x !== o.id);
  if (req.body?.use !== false) cur.push(o.id);
  const err = setFolderCredOrgs(cred, cur, req);
  if (err) return res.status(400).json({ error: err });
  res.json({ success: true, use: req.body?.use !== false });
});
// 按企业微信部门自动建组织：勾选的每个部门建一个组织（放进本文件夹）+ 套用这份通讯录、只同步该部门（含子部门），
// 同企业的文件夹登录凭证一并设定给新组织使用；run=true 时建完立即同步
router.post('/admin/folder-dir-sources/:id/create-orgs', requireAdmin(2), async (req, res) => {
  const conn = folderConnFor(req, res); if (!conn) return;
  const ccfg = parseJ(conn.config) || {};
  const feishu = conn.type === 'feishu';
  // 部门 ID：企业微信是正整数；飞书是 open_department_id 字符串（根部门 "0" 不能建成组织）
  const depts = (Array.isArray(req.body?.depts) ? req.body.depts : []).slice(0, 100)
    .map(d => ({ id: feishu ? String((d && d.id) || '').trim() : parseInt(d && d.id, 10), name: String((d && d.name) || '').trim().slice(0, 60) }))
    .filter(d => feishu ? /^[A-Za-z0-9_-]{1,64}$/.test(d.id) && d.id !== '0' : d.id > 0);
  if (!depts.length) return res.status(400).json({ error: '请勾选要建成组织的部门' });
  const bindCreds = req.body?.bind_creds !== false;
  const credKey = feishu ? 'FEISHU_APP_ID' : 'WECOM_CORP_ID';
  const creds = bindCreds ? oauthProviders.byFolder.all(conn.folder_id).filter(c => {
    if (c.platform !== conn.type) return false;
    try { return String(JSON.parse(c.config || '{}')[credKey] || '').toLowerCase() === String(ccfg.corp_id || '').toLowerCase(); } catch (_) { return false; }
  }) : [];
  const created = [], skipped = [], seen = new Set();
  for (const d of depts) {
    const name = d.name || ('部门 ' + d.id);
    const dup = orgNameTaken(name);
    if (dup || seen.has(orgNameKey(name))) { skipped.push({ dept_id: d.id, name, reason: '同名组织已存在', existing_id: dup ? dup.id : null }); continue; }
    seen.add(orgNameKey(name));
    const sid = uuidv4(), uid = uuidv4();
    db.transaction(() => {
      oauthSubjects.insert.run(sid, name, 1, 0);
      orgFolders.setSubject.run(conn.folder_id, sid);
      const useCfg = { dept_ids: [d.id], dept_names: d.name ? { [d.id]: d.name } : {}, bind_mode: 'auto', uid_mode: 'userid', remove_missing: true, idonly_create: true, interval_hours: 0 };
      dirSources.insertUse.run(uid, sid, conn.id, conn.type, conn.label || DIR_TYPES[conn.type], JSON.stringify(useCfg), 1);
      for (const c of creds) oauthProviders.setUse.run(c.id, sid);
    })();
    created.push({ org_id: sid, name, dept_id: d.id, source_id: uid });
  }
  if (!created.length) return res.status(409).json({ error: '勾选的部门都已有同名组织，没有新建', skipped });
  audit('folder.orgs_created', { subject: conn.folder_id, actor: actorOf(req), detail: { conn_id: conn.id, orgs: created.map(c => ({ id: c.org_id, name: c.name, dept: c.dept_id })), creds: creds.map(c => c.id) } });
  if (req.body?.run && conn.enabled) {
    for (const c of created) {
      try { c.state = await runDirSource(dirSources.get.get(c.source_id), actorOf(req)); }
      catch (e) { c.error = e.message; }
    }
  }
  res.json({ success: true, created, skipped, bound_creds: creds.length });
});
// 开放 API：把该组织所有启用的同步源依次跑一遍
router.post('/v1/orgs/:sid/dir-sync/run', requireApiKey('org:sync'), async (req, res) => {
  if (req.isSandbox) return res.json({ success: true, _sandbox: true, results: [{ source_id: 'sandbox-src', label: '企业微信', state: { at: new Date().toISOString(), ok: true, total: 2, created: 1, linked: 1, added: 2, removed: 0, skipped: 0, errors: [] } }] });
  const s = oauthSubjects.get.get(req.params.sid);
  if (!s) return res.status(404).json({ error: '组织不存在' });
  const list = dirSources.bySubject.all(s.id).filter(x => x.enabled);
  if (!list.length) return res.status(400).json({ error: '该组织没有启用的通讯录同步源' });
  const results = [];
  for (const src of list) {
    try { results.push({ source_id: src.id, label: src.label, state: await runDirSource(src, actorOf(req)) }); }
    catch (e) { results.push({ source_id: src.id, label: src.label, error: e.message }); }
  }
  res.json({ success: results.some(r => r.state), results });
});
// ── 接收事件服务器（v3.5.39）：企业微信通讯录变更实时回调 ──
// GET = 企业微信后台保存 URL 时的校验（验签 + 解密 echostr 原样返回）；POST = 事件推送（5 秒内回 success）。
// 收到成员/部门变更后不逐条改库，而是「防抖」后对该同步源跑一次全量同步：一阵批量变动只同步一次，
// 范围（所选部门）、移出、单独修改不覆盖等规则全部和手动/定时同步一致。改 UserId 的事件先就地改映射，免得被当成离开 + 新人。
const DIR_EVENT_DELAY = () => Math.min(600000, Math.max(200, parseInt(process.env.DIRSYNC_EVENT_DELAY_MS, 10) || 10000));
const _dirEventTimers = new Map();
function scheduleEventSync(sourceId, delay = DIR_EVENT_DELAY()) {
  clearTimeout(_dirEventTimers.get(sourceId));
  const t = setTimeout(() => {
    _dirEventTimers.delete(sourceId);
    const src = dirSources.get.get(sourceId);
    if (!src || !src.enabled) return;
    if (_dirSyncRunning.has(src.subject_id)) return scheduleEventSync(sourceId);   // 本组织正在同步，稍后再跑
    runDirSource(src, src.type + ':event').catch(e => console.warn('[通讯录事件同步]', src.label, e.message));
  }, delay);
  if (t.unref) t.unref();
  _dirEventTimers.set(sourceId, t);
}
// 企业微信回调的 query 自己解析：Express（qs）会把「+」当空格，而 echostr / 签名参数是 base64，
// 企业微信不一定把 + 编码成 %2B——被改成空格后验签和解密全失败（企业微信后台报「openapi回调地址请求不通过」）。
function wecomQuery(req) {
  const out = {};
  const qs = String(req.originalUrl || '').split('?')[1] || '';
  for (const kv of qs.split('&')) {
    if (!kv) continue;
    const i = kv.indexOf('=');
    const k = i < 0 ? kv : kv.slice(0, i), v = i < 0 ? '' : kv.slice(i + 1);
    try { out[decodeURIComponent(k)] = decodeURIComponent(v); } catch (_) { out[k] = v; }
  }
  return out;
}
// 记录最近一次企业微信「保存接收事件服务器」时的地址校验结果（成功/失败原因），方便排查
function noteVerifyAttempt(src, ok, reason, req) {
  try {
    const prev = parseJ(dirSources.get.get(src.id)?.event_state) || {};
    const next = { ...prev, last_verify: { at: new Date().toISOString(), ok, reason: reason || '', ip: req.ip || '' } };
    if (ok) next.verified_at = next.last_verify.at;
    dirSources.setEventState.run(JSON.stringify(next), src.id);
  } catch (_) {}
}
// 回调地址对应的连接与要同步的目标（v3.5.47）：
//   组织自己的同步源 → 它自己；文件夹连接 → 套用它的各组织；套用（迁移前的老地址）→ 转到它的文件夹连接
function dirEventSource(req) {
  let src = dirSources.get.get(req.params.id);
  if (!src) { const al = db.prepare('SELECT conn_id FROM dir_source_alias WHERE old_id=?').get(req.params.id); if (al) src = dirSources.get.get(al.conn_id); }   // v3.5.51：并进连接的旧同步源
  if (!src || src.type !== 'wecom') return null;
  if (src.parent_id) src = dirSources.get.get(src.parent_id);
  if (!src) return null;
  const cfg = parseJ(src.config) || {};
  if (!cfg.cb_token || !cfg.cb_aes_key) return null;
  const targets = isFolderConn(src) ? dirSources.children.all(src.id) : [src];
  return { src, cfg, targets };
}
router.get('/public/dirsync/wecom/:id', (req, res) => {
  let src = dirSources.get.get(req.params.id);
  if (!src) { const al = db.prepare('SELECT conn_id FROM dir_source_alias WHERE old_id=?').get(req.params.id); if (al) src = dirSources.get.get(al.conn_id); }
  if (src && src.parent_id) src = dirSources.get.get(src.parent_id) || src;
  const ctx = dirEventSource(req);
  if (!ctx) {
    if (src) noteVerifyAttempt(src, false, '本同步源还没保存 Token / EncodingAESKey（先在本系统保存，再去企业微信后台保存）', req);
    return res.status(404).type('text').send('not configured');
  }
  const q = wecomQuery(req);
  const echostr = String(q.echostr || '');
  try {
    if (!echostr) { noteVerifyAttempt(ctx.src, false, '请求里没有 echostr', req); return res.status(400).type('text').send('missing echostr'); }
    if (!dirsyncWecom.cbVerify(ctx.cfg.cb_token, q, echostr)) {
      noteVerifyAttempt(ctx.src, false, '签名不对：企业微信后台填的 Token 和本系统保存的不一致', req);
      return res.status(403).type('text').send('bad signature');
    }
    const { msg, receiveid } = dirsyncWecom.cbDecrypt(ctx.cfg.cb_aes_key, echostr);
    if (receiveid !== ctx.cfg.corp_id) {
      noteVerifyAttempt(ctx.src, false, `企业 ID 不符：请求来自 ${receiveid}，本同步源填的是 ${ctx.cfg.corp_id}`, req);
      return res.status(403).type('text').send('corp mismatch');
    }
    noteVerifyAttempt(ctx.src, true, '', req);
    res.type('text').send(msg);
  } catch (e) {
    noteVerifyAttempt(ctx.src, false, '解密失败：企业微信后台填的 EncodingAESKey 和本系统保存的不一致', req);
    res.status(400).type('text').send('decrypt failed');
  }
});
router.post('/public/dirsync/wecom/:id', express.text({ type: () => true, limit: '256kb' }), (req, res) => {
  const ctx = dirEventSource(req);
  if (!ctx) return res.status(404).type('text').send('not configured');
  const encrypt = dirsyncWecom.xmlField(typeof req.body === 'string' ? req.body : '', 'Encrypt');
  let msg;
  try {
    if (!encrypt || !dirsyncWecom.cbVerify(ctx.cfg.cb_token, wecomQuery(req), encrypt)) return res.status(403).type('text').send('bad signature');
    const d = dirsyncWecom.cbDecrypt(ctx.cfg.cb_aes_key, encrypt);
    if (d.receiveid !== ctx.cfg.corp_id) return res.status(403).type('text').send('corp mismatch');
    msg = d.msg;
  } catch (e) { return res.status(400).type('text').send('decrypt failed'); }
  // 企业微信要求 5 秒内回 success：这里只做轻量的本地改动（改 UserId 映射、记事件），全量同步交给防抖定时器异步跑
  const ev = dirsyncWecom.xmlField(msg, 'Event');
  const change = dirsyncWecom.xmlField(msg, 'ChangeType');
  const prev = parseJ(dirSources.get.get(ctx.src.id)?.event_state) || {};
  const state = { ...prev, at: new Date().toISOString(), event: ev, change_type: change, count: (prev.count || 0) + 1, ignored: false };
  if (ev !== 'change_contact' || !ctx.src.enabled) {
    state.ignored = true;   // 不是通讯录变更 / 同步源已停用：只记录不同步
  } else {
    const oldId = dirsyncWecom.xmlField(msg, 'UserID'), newId = dirsyncWecom.xmlField(msg, 'NewUserID');
    let queued = 0;
    for (const t of ctx.targets) {
      if (!t.enabled) continue;
      if (change === 'update_user' && newId) {
        try {
          const subject = oauthSubjects.get.get(t.subject_id);
          if (subject) {
            const r = dirsyncWecom.renameExtId(t, subject, dirsyncWecom.effectiveCfg(t), oldId, newId);
            if (r.renamed) state.renamed = { from: oldId, to: newId };
          }
        } catch (e) { console.warn('[通讯录事件] 改 UserId 失败：', e.message); state.error = String(e.message).slice(0, 200); }
      }
      scheduleEventSync(t.id); queued++;
    }
    state.queued = queued > 0;
    if (!queued) state.ignored = true;   // 文件夹连接还没有组织套用 / 都停用了
  }
  dirSources.setEventState.run(JSON.stringify(state), ctx.src.id);
  res.type('text').send('success');
});

// ── 飞书事件订阅（v3.5.59）：飞书开发者后台「事件与回调 → 事件配置」的请求地址 ──
//   保存时飞书先发 url_verification（要原样回 challenge）；之后通讯录变动推 contact.user.* / contact.department.* / contact.scope.*
//   和企业微信一样：不逐条改库，只记事件 + 防抖后跑一次全量同步
const FEISHU_SYNC_EVENTS = /^contact\.(user|department|scope)\./;
router.post('/public/dirsync/feishu/:id', express.text({ type: () => true, limit: '256kb' }), (req, res) => {
  // v3.5.60：地址可以是组织自己的同步源、文件夹连接，或迁移前的旧同步源（alias）/ 套用 id（都转到文件夹连接）
  let src = dirSources.get.get(req.params.id);
  if (!src) { const al = db.prepare('SELECT conn_id FROM dir_source_alias WHERE old_id=?').get(req.params.id); if (al) src = dirSources.get.get(al.conn_id); }
  if (src && src.parent_id) src = dirSources.get.get(src.parent_id);
  if (!src || src.type !== 'feishu') return res.status(404).json({ error: 'not configured' });
  const cfg = drvOf('feishu').effectiveCfg(src);
  const targets = isFolderConn(src) ? dirSources.children.all(src.id) : [src];
  if (!cfg.cb_token) {
    noteVerifyAttempt(src, false, '本同步源还没保存 Verification Token（先在本系统保存，再去飞书后台保存请求地址）', req);
    return res.status(404).json({ error: 'not configured' });
  }
  const raw = typeof req.body === 'string' ? req.body : (req.rawBody || JSON.stringify(req.body || {}));
  const ev = drvOf('feishu').parseEvent(cfg, req.headers, raw);
  if (!ev.ok) { noteVerifyAttempt(src, false, ev.reason, req); return res.status(403).json({ error: 'bad request' }); }
  if (ev.kind === 'challenge') { noteVerifyAttempt(src, true, '', req); return res.json({ challenge: ev.challenge }); }
  const prev = parseJ(dirSources.get.get(src.id)?.event_state) || {};
  const state = { ...prev, at: new Date().toISOString(), event: ev.event_type, change_type: ev.event_type, count: (prev.count || 0) + 1, ignored: false };
  if (ev.app_id && ev.app_id !== cfg.corp_id) { state.ignored = true; state.error = `事件来自应用 ${ev.app_id}，本同步源是 ${cfg.corp_id}`; }
  else if (!FEISHU_SYNC_EVENTS.test(ev.event_type) || !src.enabled) state.ignored = true;
  else {
    let queued = 0;
    for (const t of targets) { if (!t.enabled) continue; scheduleEventSync(t.id); queued++; }
    state.queued = queued > 0;
    if (!queued) state.ignored = true;   // 文件夹连接还没有组织套用 / 都停用了
  }
  dirSources.setEventState.run(JSON.stringify(state), src.id);
  res.json({ success: true });
});

// 定时同步：每 10 分钟看一眼。优先「每天固定时间点」（schedule_times，本地时间 HH:MM）；否则按 interval_hours。0 = 只手动。
function _scheduleDue(times, lastAt, now = new Date()) {
  for (const t of (times || [])) {
    const p = t.split(':').map(Number);
    if (p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const dueAt = new Date(now); dueAt.setHours(p[0], p[1], 0, 0);
    const last = Date.parse(lastAt || '') || 0;
    if (now >= dueAt && last < dueAt.getTime()) return true;
  }
  return false;
}
function runDueDirSyncs() {
  const now = new Date();
  for (const src of dirSources.dueList.all()) {
    if (src.parent_id) { const p = dirSources.get.get(src.parent_id); if (!p || !p.enabled) continue; }
    const cfg = dirsyncWecom.effectiveCfg(src);
    if (!cfg) continue;
    const st = parseJ(src.state) || {};
    const times = Array.isArray(cfg.schedule_times) ? cfg.schedule_times : [];
    if (times.length) {
      // 固定时间点：到点且「上次同步早于该点」才跑（上次同步 at 在 runDirSource 里更新，天然去重、漏跑会补一次）
      if (_scheduleDue(times, st.at, now)) runDirSource(src, 'system:scheduler').catch(e => console.warn('[通讯录同步]', src.label, e.message));
      continue;
    }
    if (!(cfg.interval_hours > 0)) continue;
    const last = Date.parse(st.at || '') || 0;
    if (Date.now() - last < cfg.interval_hours * 3600e3) continue;
    runDirSource(src, 'system:scheduler').catch(e => console.warn('[通讯录同步]', src.label, e.message));
  }
}
setInterval(runDueDirSyncs, 10 * 60 * 1000).unref();

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
  const st = notifyHub.status();
  res.json({ success: true, announcements: announcements.findAll.all(),
    webhook: { ready: st.ready, default_on: st.ready && st.categories.includes('announcement') }, email_configured: hasMessageHub() });
});
// 公告推到 Webhook / 群机器人：send_webhook true = 推（不看类别开关）/ false = 不推 / 不传 = 按「推送类别」里是否开了公告（v3.5.56）
function pushAnnouncement(ann, sendWebhook, updated) {
  if (!ann.active || sendWebhook === false) return false;
  const plain = String(ann.content || '').replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\n{2,}/g, '\n').trim();
  const args = ['announcement', `${updated ? '公告更新' : '公告'}：${ann.title}`, [plain.length > 300 ? plain.slice(0, 300) + '…' : plain, ann.link ? `详情：${ann.link}` : '']];
  return sendWebhook === true ? notifyHub.notifyForce(...args) : (!updated && notifyHub.notify(...args));
}
router.post('/admin/announcements', requireAdmin(2), (req, res) => {
  const { title, content = '', level = 'info', active = true, link, send_email, send_webhook } = req.body;
  if (!title || !title.trim()) return res.status(400).json({ error: '标题必填' });
  const lv = ['info', 'warn', 'urgent'].includes(level) ? level : 'info';
  const id = uuidv4();
  // 内容是富文本 HTML，净化后落库（同法律文档）
  announcements.insert.run({ id, title: title.trim(), content: sanitizeHtml(content), level: lv, active: active ? 1 : 0, link: safeLink(link) });
  const ann = announcements.findById.get(id);
  let emailed = 0;
  if (send_email) emailed = broadcastAnnouncementEmail(ann);
  const pushed = pushAnnouncement(ann, send_webhook === undefined ? undefined : !!send_webhook, false);
  res.json({ success: true, announcement: ann, emailed, email_configured: hasMessageHub(), webhook_pushed: !!pushed, webhook_ready: notifyHub.ready() });
});
// 系统通知（Webhook / 群机器人）发一条测试（v3.5.52）
router.post('/admin/notify/test', requireAdmin(1), async (req, res) => {
  try { const r = await notifyHub.testNotify(actorOf(req)); res.json({ success: true, method: r && r.method || null }); }
  catch (e) { res.status(e.status || 502).json({ error: e.message }); }
});
router.patch('/admin/announcements/:id', requireAdmin(2), (req, res) => {
  const a = announcements.findById.get(req.params.id);
  if (!a) return res.status(404).json({ error: '公告不存在' });
  const { title, content, level, active, link, send_email, send_webhook } = req.body;
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
  const pushed = send_webhook === true ? pushAnnouncement(ann, true, true) : false;   // 编辑时只有勾了才推
  res.json({ success: true, announcement: ann, emailed, email_configured: hasMessageHub(), webhook_pushed: !!pushed, webhook_ready: notifyHub.ready() });
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
  res.json({ success: true, user: { ...safeUser(user), oauthBinds, has_password: !!user.password_hash }, memo_admin_level: memoAdminLevel(), kyc_user_delete: kycUserDeleteAllowed(), limited_admin: !!limitedAdminOf(user), org_admin: !!(oauthSubjects.managedBy.all(user.id) || []).length });
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
  const value = type === 'phone' ? normalizePhone(req.body?.value) : String(req.body?.value || '').trim();
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
  const value = type === 'phone' ? normalizePhone(req.body?.value) : String(req.body?.value || '').trim();
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

// ── 用户端：成员多联系方式（v3.5.63）──────────────────────
// 额外联系方式仅作资料；真正要改「主联系方式」（登录用）仍走上面的 /user/contact/send-code + verify 验证码流程。
router.get('/user/contacts', requireAuth, noPublic, (req, res) => {
  res.json({ success: true, data: contactUtil.listContacts(req.user.uid) });
});
router.post('/user/contacts', requireAuth, noPublic, (req, res) => {
  const { kind, value } = req.body || {};
  const r = contactUtil.addContact(req.user.uid, kind, value, 'manual', firstSubjectOfUser(req.user.uid));
  if (!r.ok) return res.status(400).json({ error: SKIP_MSG[r.skip] || '添加失败' });
  res.json({ success: true, id: r.id });
});
router.delete('/user/contacts/:cid', requireAuth, noPublic, (req, res) => {
  contacts.remove.run(req.params.cid, req.user.uid);
  res.json({ success: true });
});
// 设为主要方式 → 镜像到 users.email/phone（登录标识），同 kind 其余取消主标记
router.put('/user/contacts/:cid/primary', requireAuth, noPublic, (req, res) => {
  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const row = contacts.getOne.get(req.params.cid, user.id);
  if (!row) return res.status(404).json({ error: '联系方式不存在' });
  const occ = row.kind === 'email' ? users.findByEmail.get(row.value) : users.findByPhone.get(row.value);
  if (occ && occ.id !== user.id) return res.status(400).json({ error: `该${row.kind === 'email' ? '邮箱' : '手机号'}已被其他账号占用` });
  contacts.clearPrimary.run(user.id, row.kind);
  contacts.setPrimary.run(row.id, user.id);
  db.prepare(`UPDATE users SET ${row.kind}=?, updated_at=datetime('now') WHERE id=?`).run(row.value, user.id);
  res.json({ success: true, kind: row.kind, value: row.value });
});
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

// 同一实名的其他账号（v3.5.45）：按实名认定为同一人，本人可把它们合并到当前账号
function siblingView(u) {
  return { id: u.id, uid: u.uid_code || '#' + String(u.uid_seq).padStart(5, '0'), name: u.name, created_at: u.created_at,
    email: maskEmail(u.email), phone: maskPhone(u.phone), role: u.role };
}
router.get('/user/kyc/siblings', requireAuth, noPublic, (req, res) => {
  const me = users.findById.get(req.user.uid);
  const list = me.kyc_verified && me.kyc_pseudonym ? sameIdentityStmt().all(me.kyc_pseudonym, me.id) : [];
  res.json({ success: true, enabled: !!me.kyc_pseudonym, max: kycMaxAccounts(), accounts: list.map(siblingView) });
});
router.post('/user/kyc/merge', requireAuth, noPublic, (req, res) => {
  if (req.user.org_scoped) return res.status(403).json({ error: '组织会话不能合并账号，请用个人账号登录' });
  const me = users.findById.get(req.user.uid);
  if (!me.kyc_verified || !me.kyc_pseudonym) return res.status(400).json({ error: '当前账号还没有实名认证（或系统未开启实名去重），无法按实名合并' });
  if (String(req.body?.confirm || '').trim() !== '合并账号') return res.status(400).json({ error: '请输入「合并账号」确认' });
  const ids = [...new Set((Array.isArray(req.body?.sources) ? req.body.sources : []).map(String))];
  const sources = ids.map(id => users.findById.get(id));
  if (!ids.length || sources.some(s => !s || s.kyc_pseudonym !== me.kyc_pseudonym || !s.kyc_verified))
    return res.status(400).json({ error: '只能合并与你实名相同的账号' });
  try {
    const r = userMerge.mergeUsers(me.id, ids, {
      onAppRevoked: (a, from, to) => deprovisionPush(a, { event: 'user.merged', sub: from.id, uid: from.uid_seq, merged_into: to.id, merged_into_uid: to.uid_seq }),
      actor: actorOf(req), actorUid: req.user.uid, via: 'kyc_self',
    });
    audit('user.merged', { subject: String(me.uid_seq), actor: actorOf(req), detail: { via: 'kyc_self', merge_id: r.merge_id, sources: r.merged.map(m => m.uid_seq), moved: r.moved } });
    res.json({ success: true, ...r });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// 超级管理员：任意两个（或多个）账号合并为同一人（不限组织）
// 用户管理勾选合并（v3.5.61）：先预览——每个账号的资料、能不能被并进别人、建议保留哪个
const mergeKeepScore = (u) => (u.role === 'admin' ? 64 : 0) + (u.password_hash ? 16 : 0) + (u.kyc_verified ? 8 : 0)
  + (u.twofa_enabled ? 4 : 0) + (u.email ? 2 : 0) + (u.phone ? 1 : 0);
// 一组待合并账号的视图：每人资料摘要 + 能否被并入 / 能否当保留账号 + 建议保留 + 整组冲突（v3.5.61 / v3.5.62）
function mergeGroupView(list) {
  const orgCnt = db.prepare('SELECT COUNT(*) n FROM org_members WHERE user_id=?');
  const bindCnt = db.prepare('SELECT COUNT(*) n FROM user_oauth WHERE user_id=?');
  const pkCnt = db.prepare('SELECT COUNT(*) n FROM webauthn_credentials WHERE user_id=?');
  const show = x => x.uid_code || '#' + String(x.uid_seq).padStart(5, '0');
  const sorted = [...list].sort((a, b) => mergeKeepScore(b) - mergeKeepScore(a) || (a.uid_seq || 0) - (b.uid_seq || 0));
  const view = list.map(u => {
    // 作为「被并入」的一方是否可以：用一个没有任何限制的虚拟保留账号试一下（只看它自己的条件）
    const err = userMerge.checkMerge({ id: '\0', name: '', status: 'active' }, [u]);
    const terr = userMerge.checkMerge(u, [{ id: '\0', name: '', status: 'active' }]);
    let pc = 0; try { pc = pkCnt.get(u.id).n; } catch (_) {}
    return { id: u.id, uid: show(u), name: u.name, email: u.email || null, phone: u.phone || null, status: u.status,
      admin: u.role === 'admin', has_pw: !!u.password_hash, kyc: !!u.kyc_verified, kyc_name: u.kyc_verified ? (u.kyc_name || '') : '',
      twofa: !!u.twofa_enabled, passkeys: pc, points: u.points || 0, orgs: orgCnt.get(u.id).n, bindings: bindCnt.get(u.id).n,
      created_at: u.created_at, can_be_source: !err, source_error: err || null, can_be_target: !terr, target_error: terr || null };
  });
  // 实名不同的人互相不能合并：两两比较
  const ps = list.filter(u => u.kyc_verified && u.kyc_pseudonym).map(u => u.kyc_pseudonym);
  const conflict = new Set(ps).size > 1 ? '勾选的账号里有实名信息不同的人，不能合并成一个账号' : null;
  const admins = list.filter(u => u.role === 'admin');
  const keep = sorted.find(u => !userMerge.checkMerge(u, [{ id: '\0', name: '', status: 'active' }])) || sorted[0];
  return { users: view, suggested: keep.id, conflict: conflict || (admins.length > 1 ? '这组里有两个以上管理员账号，管理员账号不能被合并（只能当保留账号）' : null) };
}

// ── 疑似重复账号（v3.5.62）：按线索把可能是同一人的账号分组，管理员批量确认合并或标记「不是同一人」 ──
// 强线索：同一实名假名、同一平台 unionid（微信 / 飞书 union_id，含通讯录映射的 ext_union）、同一企业微信企业 + UserId；
// 一般线索：姓名相同（NFKC、去空白、去掉结尾括号注记如「张三（企微）」）、邮箱 @ 前缀相同（≥4 位）。
// 实名假名不同的两人绝不连在一起；被标记「不是同一人」的两两组合也不连。
const SIMILAR_REASON = { kyc: '同一实名', union: '同一三方 unionid', corp: '企业微信同一 UserId', dirname: '外部通讯录姓名/UID 相同', name: '姓名相同', email: '邮箱相同', phone: '手机相同' };
const SIMILAR_STRONG = new Set(['kyc', 'union', 'corp']);
const pairKey = (x, y) => x < y ? [x, y] : [y, x];
function similarNameKey(n) {
  let k = String(n || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  for (let i = 0; i < 3; i++) k = k.replace(/[（(【\[][^（()）【】\[\]]*[)）】\]]$/, '');
  return k.length >= 2 ? k : '';
}
function findSimilarUsers() {
  const rows = db.prepare(`SELECT * FROM users WHERE is_public=0 AND merged_into IS NULL AND deletion_state IS NULL`).all();
  const byId = new Map(rows.map(u => [u.id, u]));
  const ignored = new Set(db.prepare('SELECT a, b FROM merge_ignore_pairs').all().map(r => r.a + '|' + r.b));
  const buckets = new Map();   // kind|key → Set(id)
  const put = (kind, key, id) => { if (!key || !byId.has(id)) return; const k = kind + '|' + key; if (!buckets.has(k)) buckets.set(k, new Set()); buckets.get(k).add(id); };
  for (const u of rows) {
    if (u.kyc_verified && u.kyc_pseudonym) put('kyc', u.kyc_pseudonym, u.id);
    put('name', similarNameKey(u.name), u.id);
    // 主字段邮箱/手机（完整值）作为线索；user_contacts 里的也一并纳入（见下）
    const em = String(u.email || '').trim().toLowerCase();
    if (em.includes('@')) put('email', em, u.id);
    const ph = String(u.phone || '').trim();
    if (ph.length >= 6) put('phone', ph, u.id);
  }
  // 多联系方式（v3.5.65）：同一手机/邮箱（含企业微信/飞书同步灌入的）判为疑似同人——跨平台同人就靠这个连上
  try {
    for (const c of db.prepare("SELECT user_id, kind, value FROM user_contacts WHERE value <> ''").all()) {
      const v = String(c.value || '').trim().toLowerCase();
      if (c.kind === 'email' && v.includes('@')) put('email', v, c.user_id);
      else if (c.kind === 'phone' && v.length >= 6) put('phone', v, c.user_id);
    }
  } catch (_) {}
  // 外部通讯录「应用内姓名 / 组织内UID」相同（v3.5.65）：如企微 UserId=MilkSU 与飞书 应用内姓名=MilkSU → 疑似同人
  const dirKey = s => { const k = String(s || '').normalize('NFKC').trim().toLowerCase(); return k.length >= 3 ? k : ''; };
  try { for (const l of db.prepare("SELECT user_id, ext_name FROM dir_source_links WHERE ext_name IS NOT NULL AND ext_name <> ''").all()) put('dirname', dirKey(l.ext_name), l.user_id); } catch (_) {}
  try { for (const m of db.prepare("SELECT user_id, org_uid FROM org_members WHERE org_uid IS NOT NULL AND org_uid <> ''").all()) put('dirname', dirKey(m.org_uid), m.user_id); } catch (_) {}
  for (const b of db.prepare("SELECT user_id, provider, union_id FROM user_oauth WHERE union_id IS NOT NULL AND union_id <> ''").all())
    put('union', String(b.provider).split(':')[0] + ':' + b.union_id, b.user_id);
  try { for (const l of db.prepare("SELECT user_id, ext_union FROM dir_source_links WHERE ext_union IS NOT NULL AND ext_union <> ''").all()) put('union', 'feishu:' + l.ext_union, l.user_id); } catch (_) {}
  try { for (const g of dirsyncWecom.findCorpDuplicates()) for (const u of g.users) put('corp', g.corp_id + ':' + String(g.ext_id).toLowerCase(), u.id); } catch (_) {}
  // 两两连边（同一桶里的人），记下原因；同名 / 同前缀的桶太大（>8 人）多半是常见名，不连
  const edges = new Map();   // a|b → Set(kind)
  for (const [k, set] of buckets) {
    const kind = k.split('|')[0], ids = [...set];
    if (ids.length < 2 || (!SIMILAR_STRONG.has(kind) && ids.length > 8)) continue;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = pairKey(ids[i], ids[j]); const ua = byId.get(a), ub = byId.get(b);
      if (ignored.has(a + '|' + b)) continue;
      if (ua.kyc_verified && ub.kyc_verified && ua.kyc_pseudonym && ub.kyc_pseudonym && ua.kyc_pseudonym !== ub.kyc_pseudonym) continue;
      if (ua.role === 'admin' && ub.role === 'admin') continue;
      const ek = a + '|' + b; if (!edges.has(ek)) edges.set(ek, new Set()); edges.get(ek).add(kind);
    }
  }
  // 并查集分组
  const parent = new Map(); const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const ek of edges.keys()) for (const id of ek.split('|')) if (!parent.has(id)) parent.set(id, id);
  for (const ek of edges.keys()) { const [a, b] = ek.split('|'); const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); }
  const groups = new Map();
  for (const id of parent.keys()) { const r = find(id); if (!groups.has(r)) groups.set(r, { ids: [], reasons: new Set() }); groups.get(r).ids.push(id); }
  for (const [ek, kinds] of edges) { const g = groups.get(find(ek.split('|')[0])); kinds.forEach(k => g.reasons.add(k)); }
  const out = [];
  for (const g of groups.values()) {
    if (g.ids.length > 21) continue;   // 太大的组不展示（多半是线索误连），请用勾选合并
    const list = g.ids.map(id => byId.get(id)).sort((a, b) => (a.uid_seq || 0) - (b.uid_seq || 0));
    const reasons = [...g.reasons];
    const strong = reasons.some(r => SIMILAR_STRONG.has(r));
    out.push({ key: list.map(u => u.id).sort().join(','), strong, reasons: reasons.map(r => ({ kind: r, label: SIMILAR_REASON[r] })), ...mergeGroupView(list) });
  }
  out.sort((a, b) => (b.strong - a.strong) || (b.users.length - a.users.length));
  return out;
}
router.get('/admin/users/similar', requireAdmin(1), (req, res) => {
  const groups = findSimilarUsers();
  res.json({ groups, ignored: db.prepare('SELECT COUNT(*) n FROM merge_ignore_pairs').get().n, undo_days: userMerge.undoDays() });
});
// 标记「不是同一人」：组里两两记下，以后不再连到一起
router.post('/admin/users/similar/ignore', requireAdmin(1), (req, res) => {
  const ins = db.prepare('INSERT OR IGNORE INTO merge_ignore_pairs (a, b, created_by) VALUES (?, ?, ?)');
  let n = 0;
  const groups = (Array.isArray(req.body?.groups) ? req.body.groups : []).slice(0, 200);
  db.transaction(() => {
    for (const g of groups) {
      const ids = [...new Set((Array.isArray(g?.ids) ? g.ids : []).map(String))].filter(id => users.findById.get(id)).slice(0, 21);
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) { const [a, b] = pairKey(ids[i], ids[j]); n += ins.run(a, b, req.user.uid).changes; }
    }
  })();
  if (!n && !groups.length) return res.status(400).json({ error: '没有选中要忽略的组' });
  audit('user.similar_ignored', { actor: actorOf(req), detail: { groups: groups.length, pairs: n } });
  res.json({ success: true, pairs: n });
});
router.post('/admin/users/similar/unignore', requireAdmin(1), (req, res) => {
  const r = db.prepare('DELETE FROM merge_ignore_pairs').run();
  audit('user.similar_unignored', { actor: actorOf(req), detail: { pairs: r.changes } });
  res.json({ success: true, pairs: r.changes });
});
// 批量合并：每组 {ids, target}；逐组 mergeUsers（各自一条可撤销的合并记录），失败的组不影响其他组
router.post('/admin/users/similar/merge', requireAdmin(1), (req, res) => {
  if (String(req.body?.confirm || '').trim() !== '合并账号') return res.status(400).json({ error: '请输入「合并账号」确认' });
  const groups = (Array.isArray(req.body?.groups) ? req.body.groups : []).slice(0, 200);
  if (!groups.length) return res.status(400).json({ error: '没有选中要合并的组' });
  const results = []; let done = 0, failed = 0;
  for (const g of groups) {
    const ids = [...new Set((Array.isArray(g?.ids) ? g.ids : []).map(String))];
    const target = users.findById.get(String(g?.target || ''));
    const label = target ? target.name : '';
    try {
      if (!target || !ids.includes(target.id)) throw Object.assign(new Error('保留账号不在这组里'), { status: 400 });
      if (ids.length < 2) throw Object.assign(new Error('一组至少两个账号'), { status: 400 });
      const srcs = ids.filter(id => id !== target.id).map(id => users.findById.get(id));
      if (srcs.some(x => !x)) throw Object.assign(new Error('有账号不存在（可能刚被删除或合并），请刷新'), { status: 400 });
      const r = userMerge.mergeUsers(target.id, srcs.map(x => x.id), {
        onAppRevoked: (a, from, to) => deprovisionPush(a, { event: 'user.merged', sub: from.id, uid: from.uid_seq, merged_into: to.id, merged_into_uid: to.uid_seq }),
        actor: actorOf(req), actorUid: req.user.uid, via: 'similar',
      });
      audit('user.merged', { subject: String(target.uid_seq), actor: actorOf(req), detail: { via: 'similar', merge_id: r.merge_id, sources: r.merged.map(m => m.uid_seq), moved: r.moved } });
      results.push({ name: label, ok: true, merged: r.merged.length, merge_id: r.merge_id }); done++;
    } catch (e) { results.push({ name: label, ok: false, error: e.message }); failed++; }
  }
  res.json({ success: true, done, failed, results });
});
router.post('/admin/users/merge/preview', requireAdmin(1), (req, res) => {
  const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(String))];
  if (ids.length < 2) return res.status(400).json({ error: '至少勾选两个账号才能合并' });
  if (ids.length > 21) return res.status(400).json({ error: '一次最多合并 21 个账号（1 个保留 + 20 个并入）' });
  const list = ids.map(id => users.findById.get(id));
  const miss = ids.filter((id, i) => !list[i]);
  if (miss.length) return res.status(404).json({ error: '有账号不存在（可能刚被删除或合并），请刷新列表' });
  res.json({ ...mergeGroupView(list), undo_days: userMerge.undoDays() });
});
router.post('/admin/users/merge', requireAdmin(1), (req, res) => {
  let target, sources = [];
  if (req.body?.target_id) {   // 勾选合并直接传账号 id（不会因重名认错人）
    target = users.findById.get(String(req.body.target_id));
    if (!target) return res.status(400).json({ error: '保留账号不存在' });
    for (const id of [...new Set((Array.isArray(req.body.source_ids) ? req.body.source_ids : []).map(String))]) {
      const s = users.findById.get(id);
      if (!s) return res.status(400).json({ error: '要合并的账号不存在（可能刚被删除或合并），请刷新列表' });
      if (s.id !== target.id) sources.push(s);
    }
  } else {
    target = resolveUser(String(req.body?.target || '').trim());
    if (!target || target === 'AMBIGUOUS') return res.status(400).json({ error: '保留账号找不到（或重名），请用 UID / 邮箱 / 手机' });
    for (const a of (Array.isArray(req.body?.sources) ? req.body.sources : [])) {
      const s = resolveUser(String(a || '').trim());
      if (!s || s === 'AMBIGUOUS') return res.status(400).json({ error: `账号「${a}」找不到（或重名）` });
      if (s.id !== target.id) sources.push(s);
    }
  }
  if (String(req.body?.confirm || '').trim() !== '合并账号') return res.status(400).json({ error: '请输入「合并账号」确认' });
  try {
    const r = userMerge.mergeUsers(target.id, sources.map(s => s.id), {
      onAppRevoked: (a, from, to) => deprovisionPush(a, { event: 'user.merged', sub: from.id, uid: from.uid_seq, merged_into: to.id, merged_into_uid: to.uid_seq }),
      actor: actorOf(req), actorUid: req.user.uid, via: req.body?.target_id ? 'user_list' : 'super_admin',
    });
    audit('user.merged', { subject: String(target.uid_seq), actor: actorOf(req), detail: { via: req.body?.target_id ? 'user_list' : 'super_admin', merge_id: r.merge_id, sources: r.merged.map(m => m.uid_seq), moved: r.moved } });
    res.json({ success: true, ...r });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// ── 企业微信重复账号（v3.5.50）──
// 同一企业的同一个 UserId 挂在了两个以上账号上（以前同步 / 用另一个登录凭证登录时没认出来，多建了号）。
// 列出来给系统管理员看；合并要超级管理员（跨组织合并），走 mergeUsers，可在期限内撤销。
function dirDupView(g) {
  const show = x => x.uid_code || '#' + String(x.uid_seq).padStart(5, '0');
  const orgsOf = db.prepare('SELECT s.name, m.source FROM org_members m JOIN oauth_subjects s ON s.id=m.subject_id WHERE m.user_id=?');
  return {
    key: g.corp_id + '|' + g.ext_id, corp_id: g.corp_id, ext_id: g.ext_id, suggested: g.users[0].id,
    users: g.users.map(u => ({ id: u.id, uid: show(u), name: u.name, email: u.email || null, phone: u.phone || null,
      admin: u.role === 'admin', has_pw: !!u.password_hash, kyc: !!u.kyc_verified, created_at: u.created_at,
      orgs: orgsOf.all(u.id).map(o => o.name) })),
  };
}
router.get('/admin/dir-duplicates', requireAdmin(3), (req, res) => {
  res.json({ groups: dirsyncWecom.findCorpDuplicates().map(dirDupView) });
});
router.post('/admin/dir-duplicates/merge', requireAdmin(1), (req, res) => {
  if (String(req.body?.confirm || '').trim() !== '合并账号') return res.status(400).json({ error: '请输入「合并账号」确认' });
  const want = new Map();   // key → 指定的保留账号 id（可空 = 用建议的）
  if (req.body?.all) for (const g of dirsyncWecom.findCorpDuplicates()) want.set(g.corp_id + '|' + g.ext_id, null);
  for (const it of (Array.isArray(req.body?.groups) ? req.body.groups : []).slice(0, 500)) {
    if (it && it.key) want.set(String(it.key), it.target ? String(it.target) : null);
  }
  if (!want.size) return res.status(400).json({ error: '没有选中要合并的重复账号' });
  const results = [];
  let done = 0, failed = 0;
  for (const g of dirsyncWecom.findCorpDuplicates()) {
    const key = g.corp_id + '|' + g.ext_id;
    if (!want.has(key)) continue;
    const t = want.get(key);
    const target = (t && g.users.find(u => u.id === t)) || g.users[0];
    const sources = g.users.filter(u => u.id !== target.id);
    try {
      const r = userMerge.mergeUsers(target.id, sources.map(s => s.id), {
        onAppRevoked: (a, from, to) => deprovisionPush(a, { event: 'user.merged', sub: from.id, uid: from.uid_seq, merged_into: to.id, merged_into_uid: to.uid_seq }),
        actor: actorOf(req), actorUid: req.user.uid, via: 'dir_duplicate',
      });
      audit('user.merged', { subject: String(target.uid_seq), actor: actorOf(req), detail: { via: 'dir_duplicate', merge_id: r.merge_id, ext_id: g.ext_id, sources: r.merged.map(m => m.uid_seq), moved: r.moved } });
      results.push({ ext_id: g.ext_id, name: target.name, ok: true, merged: r.merged.length, merge_id: r.merge_id });
      done++;
    } catch (e) {
      results.push({ ext_id: g.ext_id, name: target.name, ok: false, error: e.message });
      failed++;
    }
  }
  res.json({ success: true, done, failed, results });
});
// ── 合并记录与撤销合并（v3.5.48）──
// 系统管理员看全部；其他人只看自己做的合并。撤销：超级管理员，或做这次合并的人本人。
const MERGE_VIA = { org_admin: '组织成员合并', kyc_self: '本人按实名合并', super_admin: '超级管理员合并', self_bind: '绑定三方账号时自动并入空壳账号', dir_duplicate: '企业微信重复账号合并', user_list: '用户管理勾选合并', similar: '疑似重复账号批量合并' };
function mergeRecordView(req, r) {
  const t = users.findById.get(r.target_id);
  let target = {}, sources = [];
  try { target = JSON.parse(r.target || '{}'); } catch (_) {}
  try { sources = JSON.parse(r.sources || '[]'); } catch (_) {}
  const actor = r.actor_uid ? users.findById.get(r.actor_uid) : null;
  const undoer = r.undone_by ? users.findById.get(r.undone_by) : null;
  const blocker = userMerge.undoBlocker(r);
  const mayUndo = isSysAdmin(req, 1) || (r.actor_uid && r.actor_uid === req.user.uid);
  const showUid = x => x.uid_code || (x.uid_seq != null ? '#' + String(x.uid_seq).padStart(5, '0') : '');
  return { id: r.id, created_at: r.created_at, via: r.via, via_label: MERGE_VIA[r.via] || r.via || '',
    actor_name: actor ? `${actor.name}（${uidShow(actor)}）` : (r.actor || ''),
    target: { id: r.target_id, exists: !!t, name: t ? t.name : target.name, uid: t ? uidShow(t) : showUid(target) },
    sources: sources.map(x => ({ id: x.id, name: x.name, uid: showUid(x), exists: !!users.findById.get(x.id) })),
    undone_at: r.undone_at, undone_by_name: undoer ? `${undoer.name}（${uidShow(undoer)}）` : null,
    undo_until: r.journal ? new Date(Date.parse(String(r.created_at).replace(' ', 'T') + 'Z') + userMerge.undoDays() * 86400e3).toISOString() : null,
    can_undo: !blocker && !!mayUndo, undo_blocker: blocker };
}
// 可撤销功能上线前的合并：从审计存证里找出来，只展示（没有改动日志，不能撤销）
function legacyMerges(userUidSeq) {
  const rows = db.prepare(`SELECT subject, actor, detail, created_at FROM audit_chain WHERE event_type='user.merged' ${userUidSeq != null ? 'AND subject=?' : ''} ORDER BY seq DESC LIMIT 200`)
    .all(...(userUidSeq != null ? [String(userUidSeq)] : []));
  const out = [];
  for (const r of rows) {
    let d = {}; try { d = JSON.parse(r.detail || '{}'); } catch (_) {}
    if (d.merge_id) continue;
    const t = db.prepare('SELECT * FROM users WHERE uid_seq=?').get(Number(r.subject));
    out.push({ legacy: true, created_at: String(r.created_at).replace('T', ' ').slice(0, 19), via: d.via, via_label: MERGE_VIA[d.via] || d.via || '', actor_name: r.actor,
      target: { id: t ? t.id : null, exists: !!t, name: t ? t.name : '', uid: t ? uidShow(t) : '#' + String(r.subject).padStart(5, '0') },
      sources: (d.sources || []).map(n => ({ uid: '#' + String(n).padStart(5, '0'), name: '', exists: !!db.prepare('SELECT 1 FROM users WHERE uid_seq=?').get(Number(n)) })),
      can_undo: false, undo_blocker: '可撤销合并功能上线之前的合并，没有改动日志，不能撤销；只能从数据备份恢复' });
  }
  return out;
}
router.get('/admin/merges', requireAuth, (req, res) => {
  const all = isSysAdmin(req, 3);
  const u = req.query.user ? users.findById.get(String(req.query.user)) : null;
  if (req.query.user && !u) return res.status(404).json({ error: '用户不存在' });
  let rows = db.prepare(`SELECT rowid AS _rid, * FROM merge_records ${u ? 'WHERE target_id=?' : ''} ORDER BY rowid DESC LIMIT 200`).all(...(u ? [u.id] : []));
  if (!all) rows = rows.filter(r => r.actor_uid === req.user.uid);
  const merges = rows.map(r => mergeRecordView(req, r));
  if (all) merges.push(...legacyMerges(u ? u.uid_seq : null));
  res.json({ success: true, undo_days: userMerge.undoDays(), merges });
});
router.post('/admin/merges/:id/undo', requireAuth, (req, res) => {
  const r = userMerge.getMerge(req.params.id);
  if (!r) return res.status(404).json({ error: '合并记录不存在' });
  if (!isSysAdmin(req, 1) && r.actor_uid !== req.user.uid) return res.status(403).json({ error: '只有超级管理员或做这次合并的人能撤销' });
  if (String(req.body?.confirm || '').trim() !== '撤销合并') return res.status(400).json({ error: '请输入「撤销合并」确认' });
  try {
    const out = userMerge.undoMerge(r.id, { by: req.user.uid });
    let src = []; try { src = JSON.parse(r.sources || '[]'); } catch (_) {}
    const t = users.findById.get(r.target_id);
    audit('user.merge_undone', { subject: t ? String(t.uid_seq) : r.target_id, actor: actorOf(req), detail: { merge_id: r.id, sources: src.map(x => x.uid_seq), ...out.stats } });
    res.json({ success: true, stats: out.stats, merge: mergeRecordView(req, userMerge.getMerge(r.id)) });
  } catch (e) { res.status(e.status || 500).json({ error: '撤销失败：' + e.message }); }
});
setInterval(() => { try { userMerge.purgeMergeJournals(); } catch (e) { console.warn('[合并日志清理]', e.message); } }, 6 * 3600e3).unref();
setTimeout(() => { try { userMerge.purgeMergeJournals(); } catch (_) {} }, 8000).unref();

router.get('/admin/users/:id/siblings', requireAdmin(3), (req, res) => {
  const u = users.findById.get(req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  res.json({ success: true, accounts: u.kyc_pseudonym && u.kyc_verified ? sameIdentityStmt().all(u.kyc_pseudonym, u.id).map(siblingView) : [] });
});

// 用户自己删除实名：默认不允许（KYC_ALLOW_DELETE=true/on 才开放）——实名是账号与真人的深度绑定，删了再认证会被滥用来换绑身份
const kycUserDeleteAllowed = () => ['on', '1', 'true', 'yes'].includes(String(process.env.KYC_ALLOW_DELETE || '').trim().toLowerCase());
router.delete('/user/kyc', requireAuth, noPublic, (req, res) => {
  if (!kycUserDeleteAllowed()) return res.status(403).json({ error: '管理员未开放自行删除实名认证，如需删除请联系管理员' });
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

router.get('/admin/users', requireAdmin(3, { orgAdmin: true }), (req, res) => {
  const { status, q, org } = req.query;
  if (!orgAdminCanOrg(req, org)) return res.status(403).json({ error: '无权查看该组织' });   // v3.5.76 组织管理员限本组织
  let rows;
  if (org) {
    // v3.5.74.4：顶栏「当前组织」聚焦某组织时，用户管理只列该组织成员
    rows = db.prepare('SELECT u.* FROM users u JOIN org_members m ON m.user_id=u.id WHERE m.subject_id=? AND u.is_public=0 ORDER BY u.uid_seq').all(org);
  } else if (q) {
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
  // 已合并 / 已彻底清除的占位行不出现在列表里
  rows = rows.filter(u => !u.merged_into && u.deletion_state !== 'purged');
  res.json({ success: true, users: rows.map(u => {
    const s = safeUser(u);
    s.group = u.group_id ? groups.get.get(u.group_id) : null;
    s.tags = tags.ofUser.all(u.id);
    return s;
  }) });
});

// 账号详情补充（v3.5.43）：所属组织、登录凭证（平台 · 主体 · 三方 UID）、外部通讯录账号（含应用内姓名）
function userDetailExtras(user) {
  const orgs = db.prepare(`SELECT m.subject_id, s.name, m.org_uid, m.source, (m.password_hash IS NOT NULL) AS has_pw, s.folder_id,
      f.name AS folder_name, EXISTS(SELECT 1 FROM oauth_subject_admins a WHERE a.subject_id=m.subject_id AND a.user_id=m.user_id) AS is_admin
    FROM org_members m JOIN oauth_subjects s ON s.id=m.subject_id LEFT JOIN org_folders f ON f.id=s.folder_id
    WHERE m.user_id=? ORDER BY s.name`).all(user.id);
  const bindings = oauth.findByUser.all(user.id).map(o => {
    const [platform, credId] = String(o.provider).split(':');
    let cred = null;
    if (credId) cred = db.prepare(`SELECT p.label, p.subject_id, s.name AS subject_name FROM oauth_providers p LEFT JOIN oauth_subjects s ON s.id=p.subject_id WHERE p.id=?`).get(credId) || null;
    return { provider: o.provider, platform, platform_name: OAUTH_META[platform]?.label || platform,
      credential: credId ? (cred ? (cred.label || '') : '（已删除的凭证）') : '本站默认', subject_name: cred?.subject_name || null,
      open_id: o.open_id, union_id: o.union_id || null, bound_at: o.bound_at };
  });
  const ext_accounts = db.prepare(`SELECT l.ext_id, l.ext_name, l.depts, l.updated_at, d.label AS source_label, d.type, s.name AS org_name
    FROM dir_source_links l JOIN dir_sync_sources d ON d.id=l.source_id LEFT JOIN oauth_subjects s ON s.id=d.subject_id
    WHERE l.user_id=? ORDER BY s.name, l.ext_id`).all(user.id);
  return { orgs, bindings, ext_accounts, merged_into: user.merged_into || null };
}
router.get('/admin/users/:id', requireAdmin(3), (req, res) => {
  const user = users.findById.get(req.params.id);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json({ success: true, user: { ...safeUser(user),
    group: user.group_id ? groups.get.get(user.group_id) : null,
    tags: tags.ofUser.all(user.id),
    oauthBinds: oauth.findByUser.all(user.id), apps: apps.getUserApps.all(user.id), loginLogs: logs.findByUser.all(user.id, 10),
    ...userDetailExtras(user) },
    can: { kyc_clear: hasGrant(req, 'kyc.clear', user), delete: hasGrant(req, 'user.delete', user) } });
});

router.patch('/admin/users/:id', requireAdmin(2), (req, res) => {
  const { name, email, phone, status, user_level, admin_level } = req.body;
  db.prepare("UPDATE users SET name=COALESCE(?,name),email=COALESCE(?,email),phone=COALESCE(?,phone),status=COALESCE(?,status),user_level=COALESCE(?,user_level),admin_level=COALESCE(?,admin_level),updated_at=datetime('now') WHERE id=?")
    .run(name,email,phone,status,user_level,admin_level,req.params.id);
  res.json({ success: true });
});

// ── 管理端：新建用户 ──
router.post('/admin/users', requireAdmin(2), async (req, res) => {
  const { name, email, password, role = 'user', user_level = 4 } = req.body;
  const phone = normalizePhone(req.body?.phone);
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

router.post('/admin/users/:id/disable', requireAdmin(2, { orgAdmin: true }), (req, res) => {
  const target = users.findById.get(req.params.id);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  const denied = orgAdminMemberDenied(req, target);   // v3.5.79 组织管理员只能停用本组织成员
  if (denied) return res.status(403).json({ error: denied });
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
  onAccountSuspended(target, 'user.disabled');
  audit('user.disabled', { subject: String(target.uid_seq), actor: actorOf(req) });
  res.json({ success: true });
});
router.post('/admin/users/:id/enable', requireAdmin(2, { orgAdmin: true }), (req, res) => {
  const target = users.findById.get(req.params.id);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  const denied = orgAdminMemberDenied(req, target);   // v3.5.79 组织管理员只能启用本组织成员
  if (denied) return res.status(403).json({ error: denied });
  if (target.deletion_state === 'deleted') return res.status(400).json({ error: '该账号已删除，请用「恢复账号」' });
  if (target.merged_into) return res.status(400).json({ error: '该账号已合并到别的账号，不能启用' });
  db.prepare("UPDATE users SET status='active',updated_at=datetime('now') WHERE id=?").run(req.params.id);
  onAccountResumed(target);
  audit('user.enabled', { subject: String(target.uid_seq), actor: actorOf(req) });
  res.json({ success: true });
});
// ══════════════════════════════════════════
// 数据备份（v3.5.46）—— 快照 / 加密 / 本地与 R2 见 backup.js。仅超级管理员（备份里有全部数据和密钥）
// ══════════════════════════════════════════
const backup = require('./backup');
const { DATA_DIR } = require('./db');
const MASK = '••••••••';
function backupView(t) {
  let cfg = {}; let state = null;
  try { cfg = JSON.parse(t.config || '{}'); } catch (_) {}
  try { state = t.state ? JSON.parse(t.state) : null; } catch (_) {}
  const view = { ...cfg };
  if (view.secret_access_key) view.secret_access_key = MASK;
  view.has_passphrase = !!cfg.passphrase; delete view.passphrase;
  return { id: t.id, type: t.type, label: t.label, enabled: !!t.enabled, interval_hours: t.interval_hours, keep: t.keep,
    config: view, state, last_run_at: t.last_run_at, created_at: t.created_at,
    location: t.type === 'local' ? backup.localDir(cfg, DATA_DIR) : `r2://${cfg.bucket || ''}/${String(cfg.prefix || '').replace(/^\/+|\/+$/g, '')}` };
}
function backupCfgFromBody(type, b, old = {}) {
  const cfg = { ...old };
  if (type === 'local') {
    cfg.dir = String(b.dir ?? old.dir ?? '').trim().slice(0, 300);
  } else if (type === 'r2') {
    for (const k of ['account_id', 'bucket', 'access_key_id', 'prefix', 'endpoint']) if (b[k] !== undefined) cfg[k] = String(b[k] || '').trim().slice(0, 300);
    const sk = String(b.secret_access_key || '').trim();
    if (sk && sk !== MASK) cfg.secret_access_key = sk;
    if (!cfg.bucket || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(cfg.bucket)) return { error: '请填写正确的存储桶名称（小写字母、数字、连字符）' };
    if (!cfg.endpoint && !/^[a-f0-9]{32}$/i.test(cfg.account_id || '')) return { error: '请填写 Cloudflare 账户 ID（32 位），或自定义 Endpoint' };
    if (cfg.endpoint && !/^https:\/\//i.test(cfg.endpoint) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(cfg.endpoint)) return { error: 'Endpoint 必须是 https:// 地址' };
    if (!cfg.access_key_id || !cfg.secret_access_key) return { error: '请填写 R2 访问密钥 ID 与机密访问密钥' };
  } else return { error: '备份目标类型只能是 local / r2' };
  const pp = String(b.passphrase || '');
  if (b.clear_passphrase) delete cfg.passphrase;
  else if (pp && pp !== MASK) { if (pp.length < 8) return { error: '加密口令至少 8 位' }; cfg.passphrase = pp; }
  return { cfg };
}
const clampInt = (v, d, min, max) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
router.get('/admin/backups', requireAdmin(1), (req, res) => {
  res.json({ success: true, data_dir: DATA_DIR, targets: db.prepare('SELECT * FROM backup_targets ORDER BY created_at').all().map(backupView) });
});
router.post('/admin/backups', requireAdmin(1), (req, res) => {
  const b = req.body || {};
  const type = String(b.type || '');
  const label = String(b.label || '').trim().slice(0, 40) || (type === 'r2' ? 'R2 存储桶' : '本地目录');
  const r = backupCfgFromBody(type, b.config || {});
  if (r.error) return res.status(400).json({ error: r.error });
  const id = uuidv4();
  db.prepare('INSERT INTO backup_targets (id,type,label,config,enabled,interval_hours,keep) VALUES (?,?,?,?,?,?,?)')
    .run(id, type, label, JSON.stringify(r.cfg), b.enabled === false ? 0 : 1, clampInt(b.interval_hours, 24, 0, 720), clampInt(b.keep, 7, 0, 365));
  audit('backup.target_added', { subject: id, actor: actorOf(req), detail: { type, label } });
  res.json({ success: true, target: backupView(db.prepare('SELECT * FROM backup_targets WHERE id=?').get(id)) });
});
router.patch('/admin/backups/:id', requireAdmin(1), (req, res) => {
  const t = db.prepare('SELECT * FROM backup_targets WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: '备份目标不存在' });
  const b = req.body || {};
  let cfgJson = t.config;
  if (b.config) {
    let old = {}; try { old = JSON.parse(t.config || '{}'); } catch (_) {}
    const r = backupCfgFromBody(t.type, b.config, old);
    if (r.error) return res.status(400).json({ error: r.error });
    cfgJson = JSON.stringify(r.cfg);
  }
  db.prepare('UPDATE backup_targets SET label=?, config=?, enabled=?, interval_hours=?, keep=? WHERE id=?').run(
    b.label !== undefined ? (String(b.label).trim().slice(0, 40) || t.label) : t.label, cfgJson,
    b.enabled !== undefined ? (b.enabled ? 1 : 0) : t.enabled,
    b.interval_hours !== undefined ? clampInt(b.interval_hours, t.interval_hours, 0, 720) : t.interval_hours,
    b.keep !== undefined ? clampInt(b.keep, t.keep, 0, 365) : t.keep, t.id);
  res.json({ success: true, target: backupView(db.prepare('SELECT * FROM backup_targets WHERE id=?').get(t.id)) });
});
router.delete('/admin/backups/:id', requireAdmin(1), (req, res) => {
  const t = db.prepare('SELECT * FROM backup_targets WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: '备份目标不存在' });
  db.prepare('DELETE FROM backup_targets WHERE id=?').run(t.id);
  audit('backup.target_removed', { subject: t.id, actor: actorOf(req), detail: { type: t.type, label: t.label } });
  res.json({ success: true });
});
// 跑一次备份：一份快照写到所有给定目标；同一时间只跑一个
let backupRunning = false;
async function runBackups(targets, actor) {
  if (backupRunning) { const e = new Error('已有备份在进行中，请稍后'); e.status = 409; throw e; }
  backupRunning = true;
  const results = [];
  try {
    const gz = await backup.snapshot(db, DATA_DIR);
    const name = `qwq-sso-${backup.stamp()}.db.gz`;
    for (const t of targets) {
      let cfg = {}; try { cfg = JSON.parse(t.config || '{}'); } catch (_) {}
      let st;
      try { st = { ok: true, ...(await backup.writeTo(t, cfg, gz, DATA_DIR, name)) }; }
      catch (e) { st = { ok: false, error: e.message }; }
      st.at = new Date().toISOString();
      db.prepare("UPDATE backup_targets SET state=?, last_run_at=datetime('now') WHERE id=?").run(JSON.stringify(st), t.id);
      results.push({ id: t.id, label: t.label, ...st });
    }
  } finally { backupRunning = false; }
  audit('backup.run', { subject: 'backup', actor, detail: { raw_size: null, results: results.map(r => ({ label: r.label, ok: r.ok, file: r.file || null, error: r.error || null })) } });
  return results;
}
router.post('/admin/backups/run', requireAdmin(1), async (req, res) => {
  const id = req.body?.target_id;
  const targets = id ? db.prepare('SELECT * FROM backup_targets WHERE id=?').all(id) : db.prepare('SELECT * FROM backup_targets WHERE enabled=1').all();
  if (!targets.length) return res.status(400).json({ error: id ? '备份目标不存在' : '没有启用的备份目标' });
  try { res.json({ success: true, results: await runBackups(targets, actorOf(req)) }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.get('/admin/backups/:id/files', requireAdmin(1), async (req, res) => {
  const t = db.prepare('SELECT * FROM backup_targets WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: '备份目标不存在' });
  let cfg = {}; try { cfg = JSON.parse(t.config || '{}'); } catch (_) {}
  try { res.json({ success: true, files: await backup.list(t, cfg, DATA_DIR) }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
router.get('/admin/backups/:id/files/:name', requireAdmin(1), async (req, res) => {
  const t = db.prepare('SELECT * FROM backup_targets WHERE id=?').get(req.params.id);
  if (!t) return res.status(404).json({ error: '备份目标不存在' });
  let cfg = {}; try { cfg = JSON.parse(t.config || '{}'); } catch (_) {}
  try {
    const buf = await backup.read(t, cfg, DATA_DIR, req.params.name);
    audit('backup.downloaded', { subject: t.id, actor: actorOf(req), detail: { file: req.params.name } });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(buf);
  } catch (e) { res.status(/文件名/.test(e.message) ? 400 : 404).json({ error: e.message }); }
});
// 定时：每 10 分钟看哪些目标到点了（interval_hours>0），一份快照发给本次到期的全部目标
async function runDueBackups() {
  const due = db.prepare(`SELECT * FROM backup_targets WHERE enabled=1 AND interval_hours>0
    AND (last_run_at IS NULL OR last_run_at <= datetime('now', '-' || interval_hours || ' hours'))`).all();
  if (due.length) { try { await runBackups(due, 'system'); } catch (e) { console.warn('[定时备份]', e.message); } }
}
setInterval(runDueBackups, 10 * 60 * 1000).unref();

// ══════════════════════════════════════════
// 账号注销 / 删除（v3.5.44）—— 流程与状态见 account-lifecycle.js
// ══════════════════════════════════════════
const lifecycle = require('./account-lifecycle');
lifecycle.init({
  audit,
  onDeleted: u => onAccountSuspended(u, 'user.deleted'),
  onRestored: u => onAccountResumed(u),
});
setInterval(() => { try { lifecycle.tick(); } catch (e) { console.warn('[账号注销定时任务]', e.message); } }, 3600e3).unref();
setTimeout(() => { try { lifecycle.tick(); } catch (_) {} }, 5000).unref();
// v3.5.49：升级前已删除、三方绑定 / 通讯录映射还挂着的账号，启动时补摘并封存
setTimeout(() => { try { const n = lifecycle.detachLegacyDeleted(); if (n) console.log(`[删除账号] 已为 ${n} 个已删除账号解除三方绑定并封存`); } catch (e) { console.warn('[删除账号补摘]', e.message); } }, 4000).unref();
// v3.5.46.1：升级前合并留下的「已合并」账号，启动时并掉（历史记录转给保留账号后删除）
setTimeout(() => { try { const n = userMerge.absorbLegacyMerged(); if (n) console.log(`[合并账号清理] 已并掉 ${n} 个旧的已合并账号`); } catch (e) { console.warn('[合并账号清理]', e.message); } }, 3000).unref();

const uidShow = u => u.uid_code || '#' + String(u.uid_seq).padStart(5, '0');
function deletionView(r) {
  if (!r) return null;
  const u = users.findById.get(r.user_id);
  const by = r.requested_by ? users.findById.get(r.requested_by) : null;
  const ap = r.approved_by ? users.findById.get(r.approved_by) : null;
  return { ...r, user: u ? { id: u.id, name: u.name, uid: uidShow(u), uid_seq: u.uid_seq, deletion_state: u.deletion_state, purge_at: u.purge_at } : null,
    requested_by_name: by ? `${by.name}（${uidShow(by)}）` : null, approved_by_name: ap ? `${ap.name}（${uidShow(ap)}）` : null };
}
// 删除的分级：超管 / 被授权「删除账号」的人（对象在授权范围）→ 直接执行；其他系统管理员 → 需审批（或等待期满）
function deleteMode(req, target) {
  if (target.id === req.user.uid) return { error: '不能用管理端删除自己的账号，请在账号设定里注销' };
  if (target.role === 'admin') {
    const opLevel = req.user.role === 'admin' ? (req.user.adminLevel || 9) : 99;
    if ((target.admin_level || 99) <= opLevel) return { error: `不能删除同级或更高级别的管理员（对方 Lv.${target.admin_level}）` };
  }
  if (hasGrant(req, 'user.delete', target)) return { direct: true };
  if (isSysAdmin(req, 3)) return { direct: false };
  return { error: '删除账号需要超级管理员，或被授予「删除 / 注销账号」权限' };
}
// 能否审批 / 驳回某个待审批的删除：超管、被授权的人，或级别比发起人高的管理员
function canDecideDeletion(req, r) {
  const target = users.findById.get(r.user_id);
  if (target && hasGrant(req, 'user.delete', target)) return true;
  const requester = r.requested_by ? users.findById.get(r.requested_by) : null;
  return isSysAdmin(req, 3) && requester && requester.role === 'admin' && (req.user.adminLevel || 9) < (requester.admin_level || 9);
}

// 本人：查看注销状态 / 预检
router.get('/user/account/deletion', requireAuth, noPublic, (req, res) => {
  const u = users.findById.get(req.user.uid);
  const r = lifecycle.pendingOf(u.id);
  res.json({ success: true, config: lifecycle.config(), pending: deletionView(r), preflight: r ? null : lifecycle.preflight(u) });
});
// 本人：申请注销（输入「注销账号」确认；设了密码的要再输一次密码）
router.post('/user/account/deletion', requireAuth, noPublic, async (req, res) => {
  const u = users.findById.get(req.user.uid);
  if (req.user.org_scoped) return res.status(403).json({ error: '组织会话不能注销平台账号，请用个人账号登录' });
  if (String(req.body?.confirm || '').trim() !== '注销账号') return res.status(400).json({ error: '请输入「注销账号」确认' });
  if (u.password_hash && !(await bcrypt.compare(String(req.body?.password || ''), u.password_hash))) return res.status(400).json({ error: '密码不正确' });
  if (u.role === 'admin' && (u.admin_level || 9) <= 1 && db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND admin_level=1 AND status='active' AND id<>?").get(u.id).n === 0)
    return res.status(400).json({ error: '你是唯一的超级管理员，不能注销' });
  try {
    const r = lifecycle.request(u, { kind: 'self', by: u.id, reason: req.body?.reason });
    res.json({ success: true, pending: deletionView(r) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.delete('/user/account/deletion', requireAuth, noPublic, (req, res) => {
  const r = lifecycle.pendingOf(req.user.uid);
  if (!r) return res.status(404).json({ error: '没有进行中的注销申请' });
  if (r.kind !== 'self') return res.status(403).json({ error: '这是管理员发起的删除，请联系管理员' });
  lifecycle.cancel(r.id, req.user.uid);
  res.json({ success: true });
});
// v3.5.49：本人不能自己勾交接项（勾选证明不了什么）——外部账号由系统实时核验，「重要应用」由管理员确认
router.post('/user/account/deletion/checklist', requireAuth, noPublic, (req, res) => {
  res.status(403).json({ error: '交接项不能自己勾选：企业微信等外部账号由系统核验（在企业微信里删除或禁用后点「重新核验」），重要应用由管理员确认' });
});
router.post('/user/account/deletion/item', requireAuth, noPublic, async (req, res) => {
  const r = lifecycle.pendingOf(req.user.uid);
  if (!r) return res.status(404).json({ error: '没有进行中的注销申请' });
  if (req.body?.action !== 'recheck') return res.status(403).json({ error: '只能重新核验；其他处理请联系管理员' });
  try { await deletionItemAction(r, String(req.body?.key || ''), 'recheck', req, false); res.json({ success: true, pending: deletionView(lifecycle.getReq(r.id)) }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// 交接项处理（v3.5.49）：recheck 实时查企业微信成员状态；disable / remove_member 在企业微信里禁用 / 删除该成员（需有通讯录写权限的 Secret）；
// remove_role 取消组织 / 分组管理员；release_device 把设备从他名下拿掉。处理完由系统重新核验，不靠勾选
async function deletionItemAction(r, key, action, req, admin) {
  const it = r.checklist.find(i => i.key === key);
  if (!it) throw Object.assign(new Error('交接项不存在'), { status: 404 });
  if (r.status !== 'pending') throw Object.assign(new Error('申请已结束'), { status: 400 });
  const target = users.findById.get(r.user_id);
  const bad = msg => { throw Object.assign(new Error(msg), { status: 400 }); };
  if (it.check === 'ext') {
    if (!['recheck', 'disable', 'remove_member'].includes(action)) bad('不支持的操作');
    const src = dirSources.get.get(it.source_id);
    if (!src) { lifecycle.setVerification(r.id, key, { status: 'gone' }); return; }
    const drv = drvOf(src.type);
    const cfg = drv.effectiveCfg(src);
    if (action !== 'recheck') {
      if (!admin) bad(`只有管理员能在${drv.label}里操作成员`);
      try {
        if (action === 'disable') await drv.setMemberEnabled(cfg, it.ext_id, false);
        else await drv.deleteMember(cfg, it.ext_id);
      } catch (e) { bad((action === 'disable' ? '禁用' : '删除') + '失败：' + e.message + (src.type === 'feishu' ? '（飞书应用要开通「更新通讯录」权限并发布版本；也可以直接到飞书管理后台处理后再点「重新核验」）' : '（要在同步源里填「通讯录同步 Secret（管理用）」；也可以直接到企业微信后台处理后再点「重新核验」）')); }
      audit(action === 'disable' ? 'account.external_suspended' : 'account.external_removed', { subject: String(target?.uid_seq || ''), actor: actorOf(req), detail: { source: src.id, ext_id: it.ext_id, deletion: r.id } });
    }
    let v;
    // 自己刚调企业微信禁用 / 删除成功，就是证据（受限的「通讯录同步」Secret 能改成员、却读不到成员状态）
    if (action === 'disable') v = { status: 'disabled', via: 'api' };
    else if (action === 'remove_member') v = { status: 'gone', via: 'api' };
    else { try { v = await drv.memberStatus(cfg, it.ext_id); } catch (e) { v = { status: 'error', error: String(e.message || e).slice(0, 200) }; } }
    lifecycle.setVerification(r.id, key, v);
    return;
  }
  if (!admin) bad('这一项要管理员处理');
  const id = key.split(':').slice(1).join(':');
  if (it.check === 'orgadmin' && action === 'remove_role') db.prepare('DELETE FROM oauth_subject_admins WHERE subject_id=? AND user_id=?').run(id, r.user_id);
  else if (it.check === 'groupadmin' && action === 'remove_role') db.prepare('DELETE FROM group_admins WHERE group_id=? AND user_id=?').run(id, r.user_id);
  else if (it.check === 'device' && action === 'release_device') db.prepare("UPDATE devices SET owner_user_id=NULL, updated_at=datetime('now') WHERE id=? AND owner_user_id=?").run(id, r.user_id);
  else bad('不支持的操作');
  audit('account.handover_done', { subject: String(target?.uid_seq || ''), actor: actorOf(req), detail: { deletion: r.id, key, action } });
  lifecycle.tryExecute(r.id);
}

// ── 企业微信残留成员（v3.5.57）：账号在本系统已删除，企业微信里的成员却还在（之前登录绑定不挡删除、或升级前删的）──
// 来源：已删除账号被封存的外部身份（identity_blocks）——通讯录映射直接带着连接；企业微信登录绑定按企业找同步源。
// 同一 UserId 现在又对应着正常账号的（被别人用了）不列、也不让动。
function wecomLeftoverCandidates() {
  const rows = db.prepare(`SELECT b.kind, b.provider, b.conn_id, b.ext_id, u.id AS uid, u.name, u.uid_seq, u.uid_code, u.deleted_at
    FROM identity_blocks b JOIN users u ON u.id=b.user_id WHERE u.deletion_state='deleted' ORDER BY u.deleted_at DESC`).all();
  const map = new Map();
  for (const b of rows) {
    let sid = null;
    if (b.kind === 'dir') sid = b.conn_id;
    else if (dirsync.driverOfProvider(b.provider)) sid = lifecycle.wecomSourceFor(b.provider);   // 企业微信 / 飞书登录绑定：按企业 / 应用找同步源
    const src = sid && dirSources.get.get(sid);
    const drv = src && dirsync.driver(src.type);
    if (!drv) continue;
    const cfg = drv.effectiveCfg(src);
    const corp = String(cfg.corp_id || '').trim();
    const key = src.type + '|' + corp.toLowerCase() + '|' + String(b.ext_id).toLowerCase();
    if (map.has(key)) continue;
    if (drv.corpUsers(corp, b.ext_id).length) continue;   // 这个 UserId / open_id 现在属于正常账号
    map.set(key, { key, type: src.type, type_label: drv.label, source_id: src.id, source_label: src.label || drv.label, corp_id: corp, ext_id: b.ext_id, can_write: src.type === 'feishu' || !!cfg.write_secret, _drv: drv,
      user: { id: b.uid, name: b.name, uid: b.uid_code || '#' + String(b.uid_seq).padStart(5, '0'), deleted_at: b.deleted_at }, _cfg: cfg });
  }
  return [...map.values()];
}
const canLeftover = (req, item) => isSysAdmin(req, 3) || hasGrant(req, 'user.delete', users.findById.get(item.user.id));
router.get('/admin/deletions/leftovers', requireAuth, async (req, res) => {
  const list = wecomLeftoverCandidates().filter(i => canLeftover(req, i)).slice(0, 300);
  if (!isSysAdmin(req, 3) && !list.length && !db.prepare("SELECT 1 FROM admin_grants WHERE user_id=? AND perm='user.delete'").get(req.user.uid)) return res.status(403).json({ error: '无权查看' });
  let i = 0;
  const worker = async () => { while (i < list.length) { const it = list[i++];
    try { it.status = (await it._drv.memberStatus(it._cfg, it.ext_id)).status; } catch (e) { it.status = 'error'; it.error = String(e.message || e).slice(0, 200); } } };
  await Promise.all(Array.from({ length: Math.min(5, list.length) }, worker));
  const out = list.map(({ _cfg, _drv, ...x }) => x);
  res.json({ success: true, items: out, remaining: out.filter(x => x.status === 'active' || x.status === 'disabled' || x.status === 'quit' || x.status === 'error').length });
});
const LEFTOVER_VERB = { disable: '禁用', remove_member: '删除' };
router.post('/admin/deletions/leftovers/action', requireAuth, async (req, res) => {
  const action = String(req.body?.action || '');
  if (!LEFTOVER_VERB[action]) return res.status(400).json({ error: '不支持的操作' });
  const want = (Array.isArray(req.body?.items) ? req.body.items : []).slice(0, 200).map(x => String(x && x.key || '')).filter(Boolean);
  if (!want.length) return res.status(400).json({ error: '请先勾选' });
  const phrase = `${LEFTOVER_VERB[action]} ${want.length} 个${req.body?.platform === 'feishu' ? '飞书' : '企业微信'}成员`;
  if (String(req.body?.confirm || '').trim() !== phrase) return res.status(400).json({ error: `请原样输入「${phrase}」确认`, confirm_text: phrase });
  const byKey = new Map(wecomLeftoverCandidates().map(x => [x.key, x]));
  const results = [];
  for (const k of want) {
    const it = byKey.get(k);
    try {
      if (!it) throw new Error('不是已删除账号的残留成员（可能已恢复账号，或这个 UserId 现在属于别的账号）');
      if (!canLeftover(req, it)) throw new Error('无权操作');
      if (it.type !== (req.body?.platform === 'feishu' ? 'feishu' : 'wecom')) throw new Error('勾选里混了企业微信和飞书成员，请分开处理');
      if (action === 'disable') await it._drv.setMemberEnabled(it._cfg, it.ext_id, false);
      else await it._drv.deleteMember(it._cfg, it.ext_id);
      audit(action === 'disable' ? 'account.external_suspended' : 'account.external_removed', { subject: String(users.findById.get(it.user.id)?.uid_seq || ''), actor: actorOf(req), detail: { source: it.source_id, ext_id: it.ext_id, leftover: true } });
      results.push({ key: k, ext_id: it.ext_id, name: it.user.name, ok: true });
    } catch (e) { results.push({ key: k, ext_id: it ? it.ext_id : '', name: it ? it.user.name : '', ok: false, error: e.message + (/48002|48004|权限/.test(e.message) ? '（要在同步源里填「通讯录同步 Secret（管理用）」）' : '') }); }
  }
  res.json({ success: true, done: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results });
});

// ── 异常账号（v3.5.58）：账号在、却没有任何能登录的方式 ──
//   unbound  通讯录同步进来了（有映射），但没有登录绑定，也没有密码 / 邮箱 / 手机 / Passkey
//   no_login 在组织里，但没有任何登录方式（也没有组织密码），通讯录映射也没了
//   orphan   不在任何组织、没有映射、没有任何登录方式——多半是组织 / 同步源被删后留下的
// 管理员 / 公共账号 / 注销中 / 已删除 / 已合并的不算。
function anomalyAccounts() {
  const rows = db.prepare(`SELECT u.* FROM users u WHERE u.is_public=0 AND COALESCE(u.role,'user')<>'admin' AND u.merged_into IS NULL AND u.deletion_state IS NULL
    AND COALESCE(u.password_hash,'')='' AND COALESCE(u.email,'')='' AND COALESCE(u.phone,'')=''
    AND NOT EXISTS (SELECT 1 FROM user_oauth o WHERE o.user_id=u.id)
    AND NOT EXISTS (SELECT 1 FROM webauthn_credentials w WHERE w.user_id=u.id)
    ORDER BY u.uid_seq`).all();
  const out = [];
  for (const u of rows) {
    const orgs = db.prepare('SELECT s.name, m.password_hash FROM org_members m JOIN oauth_subjects s ON s.id=m.subject_id WHERE m.user_id=?').all(u.id);
    if (orgs.some(o => o.password_hash)) continue;   // 有组织密码：能「登录到组织」
    const links = db.prepare(`SELECT l.source_id, l.ext_id, l.ext_name, l.ext_union, d.label, d.type FROM dir_source_links l JOIN dir_sync_sources d ON d.id=l.source_id WHERE l.user_id=?`).all(u.id)
      .map(l => {
        const src = dirSources.get.get(l.source_id), drv = dirsync.driver(l.type), cfg = src && drv ? drv.effectiveCfg(src) : {};
        let bind = null;
        if (drv && cfg.corp_id) {   // 同一企业（飞书：同一 App ID）的登录凭证里，这个成员 ID 还没被占用的
          for (const p of drv.corpScope(cfg.corp_id).providers) {
            const taken = db.prepare('SELECT user_id FROM user_oauth WHERE provider=? AND open_id=? COLLATE NOCASE').get(p, l.ext_id);
            if (!taken) { bind = p; break; }
          }
        }
        return { source_id: l.source_id, type: l.type, source_label: l.label || (drv ? drv.label : l.type), ext_id: l.ext_id, ext_name: l.ext_name || null, ext_union: l.ext_union || null,
          can_write: l.type === 'feishu' || !!cfg.write_secret, bind_provider: bind };
      });
    const kind = links.length ? 'unbound' : orgs.length ? 'no_login' : 'orphan';
    out.push({ id: u.id, name: u.name, uid: uidShow(u), status: u.status, created_at: u.created_at, kind, orgs: orgs.map(o => o.name), links,
      can_bind: links.some(l => l.bind_provider) });
  }
  return out;
}
router.get('/admin/anomalies', requireAuth, (req, res) => {
  if (!isSysAdmin(req, 3) && !db.prepare("SELECT 1 FROM admin_grants WHERE user_id=? AND perm='user.delete'").get(req.user.uid)) return res.status(403).json({ error: '无权查看' });
  res.json({ success: true, items: anomalyAccounts() });
});
router.post('/admin/anomalies/action', requireAuth, async (req, res) => {
  const b = req.body || {}, action = String(b.action || '');
  if (!['bind', 'delete'].includes(action)) return res.status(400).json({ error: '不支持的操作' });
  if (action === 'bind' && !isSysAdmin(req, 2)) return res.status(403).json({ error: '需要 Lv.2 及以上管理员' });
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(String))].slice(0, 200);
  if (!ids.length) return res.status(400).json({ error: '请先勾选' });
  const wecom = ['remove', 'disable', 'keep'].includes(b.wecom) ? b.wecom : 'keep';
  if (action === 'delete') {
    const phrase = `删除 ${ids.length} 个异常账号`;
    if (String(b.confirm || '').trim() !== phrase) return res.status(400).json({ error: `请原样输入「${phrase}」确认`, confirm_text: phrase });
  }
  const byId = new Map(anomalyAccounts().map(a => [a.id, a]));   // 每次都重新判定：不再是异常账号的不动
  const results = [];
  for (const id of ids) {
    const a = byId.get(id), row = { id, name: a ? a.name : '', uid: a ? a.uid : '' };
    try {
      if (!a) throw new Error('已不是异常账号（可能已绑定 / 已删除）');
      if (action === 'bind') {
        const l = a.links.find(x => x.bind_provider);
        if (!l) throw new Error('这家企业没有可用的登录凭证（飞书要同一个 App ID），或这个成员 ID 已绑在别的账号上');
        oauth.bind.run(uuidv4(), a.id, l.bind_provider, l.ext_id, l.ext_union || null);
        audit('user.anomaly_bound', { subject: String(users.findById.get(a.id).uid_seq), actor: actorOf(req), detail: { provider: l.bind_provider, ext_id: l.ext_id } });
        row.bound = l.bind_provider;
      } else {
        const u = users.findById.get(a.id);
        const mode = deleteMode(req, u);
        if (mode.error) throw new Error(mode.error);
        // 先在企业微信里处理（失败就不删本系统账号，避免又留下残留）
        const ext = [];
        for (const l of a.links) {
          if (wecom === 'keep') { ext.push({ l, v: { status: 'kept', via: 'admin' } }); continue; }
          const src = dirSources.get.get(l.source_id); const drv = drvOf(l.type); const cfg = drv.effectiveCfg(src);
          try {
            if (wecom === 'disable') await drv.setMemberEnabled(cfg, l.ext_id, false);
            else await drv.deleteMember(cfg, l.ext_id);
          } catch (e) { if (!(wecom === 'remove' && drv.isGoneError(e))) throw new Error(`${drv.label}${wecom === 'disable' ? '禁用' : '删除'} ${l.ext_id} 失败：${e.message}${l.type === 'wecom' && !cfg.write_secret ? '（同步源没填「通讯录同步 Secret（管理用）」）' : ''}`); }
          audit(wecom === 'disable' ? 'account.external_suspended' : 'account.external_removed', { subject: String(u.uid_seq), actor: actorOf(req), detail: { source: l.source_id, ext_id: l.ext_id, anomaly: true } });
          ext.push({ l, v: { status: wecom === 'disable' ? 'disabled' : 'gone', via: 'api' } });
        }
        const r = lifecycle.request(u, { kind: 'admin', by: req.user.uid, reason: b.reason || '异常账号处理', needsApproval: !mode.direct, immediate: mode.direct });
        for (const { l, v } of ext) {
          const it = r.checklist.find(i => i.check === 'ext' && i.ext_id === l.ext_id);
          if (it && !it.done) { try { lifecycle.setVerification(r.id, it.key, v); } catch (_) {} }
        }
        row.state = users.findById.get(u.id).deletion_state;
        row.needs_approval = !mode.direct;
      }
      row.ok = true;
    } catch (e) { row.ok = false; row.error = e.message; }
    results.push(row);
  }
  audit('user.anomaly_action', { actor: actorOf(req), detail: { action, wecom: action === 'delete' ? wecom : undefined, total: ids.length, done: results.filter(r => r.ok).length } });
  res.json({ success: true, done: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results });
});

// 管理端：删除预检（交接清单 + 会直接执行还是要审批）
router.get('/admin/users/:id/deletion', requireAuth, (req, res) => {
  const u = users.findById.get(req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (!isSysAdmin(req, 3) && !hasGrant(req, 'user.delete', u)) return res.status(403).json({ error: '无权查看' });
  const mode = deleteMode(req, u);
  res.json({ success: true, config: lifecycle.config(), mode, pending: deletionView(lifecycle.pendingOf(u.id)),
    preflight: lifecycle.preflight(u), state: u.deletion_state || null, deleted_at: u.deleted_at || null, purge_at: u.purge_at || null,
    can_restore: u.deletion_state === 'deleted' && hasGrant(req, 'user.delete', u),
    can_purge: u.deletion_state === 'deleted' && isSysAdmin(req, 1),
    // 删除时摘下并封存的外部身份（v3.5.49）：保留期内不能用它们登录、同步也不会认回来
    blocked: db.prepare('SELECT kind, provider, conn_id, ext_id, created_at FROM identity_blocks WHERE user_id=? ORDER BY created_at').all(u.id).map(b => {
      const src = b.conn_id ? dirSources.get.get(b.conn_id) : null;
      const plat = b.provider ? String(b.provider).split(':')[0] : 'wecom';
      return { kind: b.kind, ext_id: b.ext_id, where: b.kind === 'dir' ? `${src ? (src.label || '通讯录') : '通讯录'}（通讯录成员）` : `${OAUTH_META[plat]?.label || plat}登录`, at: b.created_at };
    }) });
});
// 管理端：删除账号（强确认：原样输入对方 UID）
router.post('/admin/users/:id/delete', requireAuth, (req, res) => {
  const u = users.findById.get(req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const mode = deleteMode(req, u);
  if (mode.error) return res.status(403).json({ error: mode.error });
  if (String(req.body?.confirm || '').trim() !== uidShow(u)) return res.status(400).json({ error: `请原样输入对方 UID「${uidShow(u)}」确认` });
  try {
    const r = lifecycle.request(u, { kind: 'admin', by: req.user.uid, reason: req.body?.reason, needsApproval: !mode.direct, immediate: mode.direct });
    res.json({ success: true, deletion: deletionView(r), state: users.findById.get(u.id).deletion_state });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// ── 用户管理：批量操作（v3.5.55）──
// 逐条套用单个操作的同一套校验（停用不能停自己 / 同级或更高管理员；删除走 deleteMode；积分不能扣成负数），
// 一条失败不影响其他条，返回逐条结果。危险操作（停用 / 删除 / 积分）要原样输入「<动作> N 个账号」确认。
const BULK_DANGER = { disable: '停用', delete: '删除', points: '调整积分' };
router.post('/admin/users/bulk', requireAuth, (req, res) => {
  const b = req.body || {};
  const action = String(b.action || '');
  if (!['disable', 'enable', 'delete', 'group', 'tags_add', 'tags_remove', 'points'].includes(action)) return res.status(400).json({ error: '不支持的操作' });
  if (action !== 'delete' && !isSysAdmin(req, 2)) return res.status(403).json({ error: '需要 Lv.2 及以上管理员' });
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(String))];
  if (!ids.length) return res.status(400).json({ error: '请先勾选用户' });
  if (ids.length > 200) return res.status(400).json({ error: '一次最多 200 个账号' });
  if (BULK_DANGER[action]) {
    const want = `${BULK_DANGER[action]} ${ids.length} 个账号`;
    if (String(b.confirm || '').trim() !== want) return res.status(400).json({ error: `请原样输入「${want}」确认`, confirm_text: want });
  }
  // 参数预检（整批共用）
  let gid = null, tagIds = [], delta = 0;
  if (action === 'group') { gid = b.group_id || null; if (gid && !groups.get.get(gid)) return res.status(400).json({ error: '分组不存在' }); }
  if (action === 'tags_add' || action === 'tags_remove') {
    tagIds = (Array.isArray(b.tag_ids) ? b.tag_ids : []).filter(t => tags.get.get(t));
    if (!tagIds.length) return res.status(400).json({ error: '请选择标签' });
  }
  if (action === 'points') { delta = parseInt(b.delta, 10); if (!delta) return res.status(400).json({ error: '积分变动量不能为 0' }); }
  const operator = users.findById.get(req.user.uid);
  const results = [];
  for (const id of ids) {
    const u = users.findById.get(id);
    const row = { id, name: u ? (u.name || u.email || '') : '', uid: u ? uidShow(u) : '' };
    try {
      if (!u) throw Object.assign(new Error('用户不存在'), { status: 404 });
      if (u.is_public) throw new Error('公共账号请在分组里管理');
      if (action === 'disable') {
        if (u.id === req.user.uid) throw new Error('不能停用自己的账号');
        if (u.role === 'admin' && operator.role === 'admin' && (u.admin_level || 99) <= (operator.admin_level || 99)) throw new Error(`不能停用同级或更高级别的管理员（Lv.${u.admin_level}）`);
        if (u.status === 'disabled') { row.skipped = '已是停用状态'; }
        else {
          db.prepare("UPDATE users SET status='disabled',updated_at=datetime('now') WHERE id=?").run(u.id);
          onAccountSuspended(u, 'user.disabled');
          audit('user.disabled', { subject: String(u.uid_seq), actor: actorOf(req), detail: { bulk: true } });
        }
      } else if (action === 'enable') {
        if (u.deletion_state === 'deleted') throw new Error('已删除，请用「恢复账号」');
        if (u.merged_into) throw new Error('已合并到别的账号');
        if (u.status === 'active') { row.skipped = '已是正常状态'; }
        else {
          db.prepare("UPDATE users SET status='active',updated_at=datetime('now') WHERE id=?").run(u.id);
          onAccountResumed(u);
          audit('user.enabled', { subject: String(u.uid_seq), actor: actorOf(req), detail: { bulk: true } });
        }
      } else if (action === 'delete') {
        const mode = deleteMode(req, u);
        if (mode.error) throw new Error(mode.error);
        const r = lifecycle.request(u, { kind: 'admin', by: req.user.uid, reason: b.reason, needsApproval: !mode.direct, immediate: mode.direct });
        row.state = users.findById.get(u.id).deletion_state;
        row.needs_approval = !mode.direct; row.deletion_id = r.id;
      } else if (action === 'group') {
        groups.setUser.run(gid, u.id);
      } else if (action === 'tags_add') {
        const have = new Set(tags.ofUser.all(u.id).map(t => t.id));
        tagIds.forEach(t => { if (!have.has(t)) tags.addToUser.run(u.id, t); });
      } else if (action === 'tags_remove') {
        tagIds.forEach(t => db.prepare('DELETE FROM user_tag_map WHERE user_id=? AND tag_id=?').run(u.id, t));
      } else if (action === 'points') {
        if ((u.points || 0) + delta < 0) throw new Error(`扣除后积分将为负数（当前 ${u.points || 0}）`);
        users.addPoints.run(delta, u.id);
        points.insert.run(uuidv4(), u.id, delta, b.reason || (delta > 0 ? '管理员批量增加积分' : '管理员批量扣减积分'));
        audit('points.adjusted', { subject: String(u.uid_seq), actor: actorOf(req), detail: { delta, balance_after: (u.points || 0) + delta, bulk: true } });
      }
      row.ok = true;
    } catch (e) { row.ok = false; row.error = e.message; }
    results.push(row);
  }
  const done = results.filter(r => r.ok && !r.skipped).length;
  audit('user.bulk_action', { actor: actorOf(req), detail: { action, total: ids.length, done, failed: results.filter(r => !r.ok).length,
    ...(action === 'group' ? { group_id: gid } : {}), ...(tagIds.length ? { tag_ids: tagIds } : {}), ...(delta ? { delta } : {}) } });
  res.json({ success: true, action, done, skipped: results.filter(r => r.skipped).length, failed: results.filter(r => !r.ok).length, results });
});
router.get('/admin/deletions', requireAuth, (req, res) => {
  if (!isSysAdmin(req, 3) && !db.prepare("SELECT 1 FROM admin_grants WHERE user_id=? AND perm='user.delete'").get(req.user.uid)) return res.status(403).json({ error: '无权查看' });
  const status = ['pending', 'done', 'cancelled', 'rejected', 'restored'].includes(req.query.status) ? req.query.status : null;
  const rows = db.prepare(`SELECT * FROM account_deletions ${status ? 'WHERE status=?' : ''} ORDER BY created_at DESC LIMIT 200`).all(...(status ? [status] : []));
  res.json({ success: true, config: lifecycle.config(), deletions: rows.map(r => {
    const v = deletionView(lifecycle.getReq(r.id));
    return { ...v, can_decide: v.status === 'pending' && !!v.needs_approval && !v.approved_by && canDecideDeletion(req, v) };
  }) });
});
function deletionAction(fn) {
  return (req, res) => {
    const r = lifecycle.getReq(req.params.id);
    if (!r) return res.status(404).json({ error: '申请不存在' });
    try { res.json({ success: true, deletion: deletionView(fn(req, r)) }); }
    catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  };
}
const deny = msg => { const e = new Error(msg); e.status = 403; throw e; };
router.post('/admin/deletions/:id/approve', requireAuth, deletionAction((req, r) => {
  if (!r.needs_approval) deny('这条申请不需要审批');
  if (!canDecideDeletion(req, r)) deny('需要超级管理员、被授权的人，或比发起人级别更高的管理员来审批');
  return lifecycle.approve(r.id, req.user.uid);
}));
router.post('/admin/deletions/:id/reject', requireAuth, deletionAction((req, r) => {
  if (!canDecideDeletion(req, r)) deny('需要超级管理员、被授权的人，或比发起人级别更高的管理员来驳回');
  return lifecycle.reject(r.id, req.user.uid);
}));
router.post('/admin/deletions/:id/cancel', requireAuth, deletionAction((req, r) => {
  const target = users.findById.get(r.user_id);
  if (r.requested_by !== req.user.uid && !hasGrant(req, 'user.delete', target)) deny('只有发起人、超级管理员或被授权的人能撤回');
  return lifecycle.cancel(r.id, req.user.uid);
}));
router.post('/admin/deletions/:id/item', requireAuth, async (req, res) => {
  const r = lifecycle.getReq(req.params.id);
  if (!r) return res.status(404).json({ error: '申请不存在' });
  const target = users.findById.get(r.user_id);
  if (!isSysAdmin(req, 3) && !hasGrant(req, 'user.delete', target)) return res.status(403).json({ error: '无权操作' });
  try { await deletionItemAction(r, String(req.body?.key || ''), String(req.body?.action || ''), req, true); res.json({ success: true, deletion: deletionView(lifecycle.getReq(r.id)) }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
router.post('/admin/deletions/:id/checklist', requireAuth, deletionAction((req, r) => {
  const target = users.findById.get(r.user_id);
  if (!isSysAdmin(req, 3) && !hasGrant(req, 'user.delete', target)) deny('无权操作');
  return lifecycle.setChecklist(r.id, String(req.body?.key || ''), !!req.body?.done, req.user.uid);
}));
// 批量操作（v3.5.48）：勾选多条后一次执行，逐条返回结果。彻底清除 / 批准 / 恢复要原样输入确认词。
const BULK_CONFIRM = { purge: '彻底清除', approve: '批准删除', restore: '恢复账号' };
router.post('/admin/deletions/bulk', requireAuth, (req, res) => {
  const action = String(req.body?.action || '');
  if (!['purge', 'approve', 'reject', 'cancel', 'restore'].includes(action)) return res.status(400).json({ error: '不支持的操作' });
  const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(String))].slice(0, 200);
  if (!ids.length) return res.status(400).json({ error: '请先勾选' });
  if (BULK_CONFIRM[action] && String(req.body?.confirm || '').trim() !== BULK_CONFIRM[action]) return res.status(400).json({ error: `请输入「${BULK_CONFIRM[action]}」确认` });
  if (action === 'purge' && !isSysAdmin(req, 1)) return res.status(403).json({ error: '彻底清除只有超级管理员能做' });
  const results = [];
  for (const id of ids) {
    const r = lifecycle.getReq(id);
    const u = r ? users.findById.get(r.user_id) : null;
    const name = u ? `${u.name}（${uidShow(u)}）` : id;
    try {
      if (!r) deny('申请不存在');
      if (action === 'purge') {
        if (!u || u.deletion_state !== 'deleted') deny('不是「已删除」状态');
        lifecycle.purge(u, req.user.uid);
      } else if (action === 'restore') {
        if (!u) deny('账号已不存在');
        if (!hasGrant(req, 'user.delete', u)) deny('无权恢复');
        lifecycle.restore(u, req.user.uid);
      } else if (action === 'approve') {
        if (r.status !== 'pending' || !r.needs_approval) deny('这条不需要审批');
        if (!canDecideDeletion(req, r)) deny('无权审批');
        lifecycle.approve(r.id, req.user.uid);
      } else if (action === 'reject') {
        if (r.status !== 'pending') deny('不是进行中');
        if (!canDecideDeletion(req, r)) deny('无权驳回');
        lifecycle.reject(r.id, req.user.uid);
      } else if (action === 'cancel') {
        if (r.status !== 'pending') deny('不是进行中');
        if (r.requested_by !== req.user.uid && !hasGrant(req, 'user.delete', u)) deny('无权撤回');
        lifecycle.cancel(r.id, req.user.uid);
      }
      results.push({ id, name, ok: true });
    } catch (e) { results.push({ id, name, ok: false, error: e.message }); }
  }
  res.json({ success: results.some(x => x.ok), done: results.filter(x => x.ok).length, failed: results.filter(x => !x.ok).length, results });
});
router.post('/admin/users/:id/restore', requireAuth, (req, res) => {
  const u = users.findById.get(req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (!hasGrant(req, 'user.delete', u)) return res.status(403).json({ error: '恢复账号需要超级管理员，或被授予「删除 / 注销账号」权限' });
  try { lifecycle.restore(u, req.user.uid); res.json({ success: true }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
// 超级管理员：已删除的账号不等保留期，立即彻底清除（强确认）
router.post('/admin/users/:id/purge', requireAdmin(1), (req, res) => {
  const u = users.findById.get(req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (u.deletion_state !== 'deleted') return res.status(400).json({ error: '只有「已删除」的账号才能彻底清除' });
  if (String(req.body?.confirm || '').trim() !== '彻底清除') return res.status(400).json({ error: '请输入「彻底清除」确认' });
  lifecycle.purge(u, req.user.uid);
  res.json({ success: true });
});

router.post('/admin/users/:id/reset-password', requireAdmin(2, { orgAdmin: true }), async (req, res) => {
  const target = users.findById.get(req.params.id);
  if (!target) return res.status(404).json({ error: '用户不存在' });
  const denied = orgAdminMemberDenied(req, target);   // v3.5.79 组织管理员只能重置本组织成员密码
  if (denied) return res.status(403).json({ error: denied });
  const { password } = req.body;
  if (!password || password.length < 6) return res.status(400).json({ error: '密码至少6位' });
  users.updatePassword.run(await bcrypt.hash(password, 12), req.params.id);
  audit('user.password_reset', { subject: String(target.uid_seq), actor: actorOf(req) });
  res.json({ success: true });
});
// 清除实名（v3.5.43 收紧）：只有超级管理员，或被授予「清除实名认证」且对象在授权范围内的人
router.delete('/admin/users/:id/kyc', requireAuth, (req, res) => {
  const u = users.findById.get(req.params.id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (!hasGrant(req, 'kyc.clear', u)) return res.status(403).json({ error: '清除实名需要超级管理员，或被授予「清除实名认证」权限' });
  users.clearKyc.run(req.params.id);
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
// 水印追踪码反查（v3.5.33）：外泄文件上的「T + 8 位」→ 谁、何时、导出了哪个附件
router.get('/admin/audit/trace/:code', requireAdmin(3), (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase().replace(/^T/, '');
  if (!/^[0-9A-F]{8}$/.test(code)) return res.status(400).json({ error: '追踪码格式应为 T + 8 位十六进制，如 T1A2B3C4D' });
  const rows = db.prepare(`SELECT seq,event_type,subject,actor,detail,created_at FROM audit_chain
    WHERE event_type='file.watermarked' AND detail LIKE ? ORDER BY seq DESC LIMIT 5`).all('%"trace":"' + code + '"%');
  const data = rows.map(r => {
    let d = {}; try { d = JSON.parse(r.detail || '{}'); } catch (_) {}
    const u = r.subject ? db.prepare('SELECT name, uid_seq, uid_code, email FROM users WHERE uid_seq=?').get(parseInt(r.subject, 10)) : null;
    return { trace: 'T' + code, at: r.created_at, actor: r.actor, file: d.file, mime: d.mime, memo: d.memo, attachment: d.attachment,
      user: u ? { name: u.name, uid: u.uid_code || ('#' + String(u.uid_seq).padStart(5, '0')), email: u.email } : null };
  });
  res.json({ success: true, found: data.length > 0, data });
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
  const org = String(req.query?.org || '').trim();
  let list;
  if (sys) {
    list = org ? devices.bySubjects.all(JSON.stringify([org])) : devices.all.all();
  } else {
    const myOrgs = myManagedOrgs(req).map(o => o.id);
    const want = org && myOrgs.includes(org) ? [org] : myOrgs;   // 聚焦自己管的某组织；否则全部自己管的
    list = want.length ? devices.bySubjects.all(JSON.stringify(want)) : [];
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

// ══════════════════════════════════════════
// 管理权限授权（v3.5.43）：高危操作默认只有超级管理员（Lv.1）能做，其他人需超管授权，
// 授权可限定范围：全部 / 某组织（是其成员）/ 某分组 / 某标签 / 某组织文件夹（在该文件夹下任一组织）
// ══════════════════════════════════════════
const GRANT_PERMS = { 'kyc.clear': '清除实名认证', 'user.delete': '删除 / 注销账号' };
const GRANT_SCOPES = ['all', 'org', 'group', 'tag', 'folder'];
function grantCovers(g, target) {
  if (g.scope_type === 'all') return true;
  if (g.scope_type === 'org') return !!db.prepare('SELECT 1 FROM org_members WHERE subject_id=? AND user_id=?').get(g.scope_id, target.id);
  if (g.scope_type === 'group') return target.group_id === g.scope_id;
  if (g.scope_type === 'tag') return !!db.prepare('SELECT 1 FROM user_tag_map WHERE tag_id=? AND user_id=?').get(g.scope_id, target.id);
  if (g.scope_type === 'folder') return !!db.prepare(`SELECT 1 FROM org_members m JOIN oauth_subjects s ON s.id=m.subject_id
    WHERE s.folder_id=? AND m.user_id=?`).get(g.scope_id, target.id);
  return false;
}
function hasGrant(req, perm, target) {
  if (!req.user || req.user.org_scoped) return false;
  if (req.user.role === 'admin' && (req.user.adminLevel || 9) <= 1) return true;   // 超级管理员
  if (!target) return false;
  return db.prepare('SELECT * FROM admin_grants WHERE user_id=? AND perm=?').all(req.user.uid, perm).some(g => grantCovers(g, target));
}
function grantScopeName(g) {
  try {
    if (g.scope_type === 'all') return '全部用户';
    if (g.scope_type === 'org') return '组织：' + (oauthSubjects.get.get(g.scope_id)?.name || g.scope_id);
    if (g.scope_type === 'group') return '分组：' + (groups.get.get(g.scope_id)?.name || g.scope_id);
    if (g.scope_type === 'tag') return '标签：' + (tags.get.get(g.scope_id)?.name || g.scope_id);
    if (g.scope_type === 'folder') return '组织文件夹：' + (db.prepare('SELECT name FROM org_folders WHERE id=?').get(g.scope_id)?.name || g.scope_id);
  } catch (_) {}
  return g.scope_type;
}
router.get('/admin/grants', requireAdmin(1), (req, res) => {
  const rows = db.prepare(`SELECT g.*, u.name AS user_name, u.uid_seq, u.uid_code FROM admin_grants g LEFT JOIN users u ON u.id=g.user_id ORDER BY g.created_at DESC`).all();
  res.json({ success: true, perms: GRANT_PERMS, grants: rows.map(g => ({ ...g, perm_name: GRANT_PERMS[g.perm] || g.perm, scope_name: grantScopeName(g) })) });
});
router.post('/admin/grants', requireAdmin(1), (req, res) => {
  const perm = String(req.body?.perm || '');
  const scope_type = String(req.body?.scope_type || 'all');
  const scope_id = scope_type === 'all' ? null : String(req.body?.scope_id || '');
  if (!GRANT_PERMS[perm]) return res.status(400).json({ error: '未知权限' });
  if (!GRANT_SCOPES.includes(scope_type)) return res.status(400).json({ error: '未知范围' });
  const exists = { org: () => oauthSubjects.get.get(scope_id), group: () => groups.get.get(scope_id), tag: () => tags.get.get(scope_id),
    folder: () => db.prepare('SELECT 1 FROM org_folders WHERE id=?').get(scope_id) };
  if (scope_type !== 'all' && (!scope_id || !exists[scope_type]())) return res.status(400).json({ error: '范围对象不存在' });
  const u = resolveUser(String(req.body?.account || '').trim());
  if (u === 'AMBIGUOUS') return res.status(400).json({ error: '账号有重名，请改用邮箱/手机号/UID' });
  if (!u || u.is_public) return res.status(404).json({ error: '用户不存在' });
  const id = uuidv4();
  db.prepare('INSERT INTO admin_grants (id,user_id,perm,scope_type,scope_id,granted_by) VALUES (?,?,?,?,?,?)').run(id, u.id, perm, scope_type, scope_id, req.user.uid);
  audit('admin.grant_added', { subject: String(u.uid_seq), actor: actorOf(req), detail: { perm, scope_type, scope_id } });
  res.json({ success: true, id });
});
router.delete('/admin/grants/:id', requireAdmin(1), (req, res) => {
  const g = db.prepare('SELECT * FROM admin_grants WHERE id=?').get(req.params.id);
  if (!g) return res.status(404).json({ error: '授权不存在' });
  db.prepare('DELETE FROM admin_grants WHERE id=?').run(g.id);
  const u = users.findById.get(g.user_id);
  audit('admin.grant_removed', { subject: String(u ? u.uid_seq : g.user_id), actor: actorOf(req), detail: { perm: g.perm, scope_type: g.scope_type, scope_id: g.scope_id } });
  res.json({ success: true });
});

// ── 临时 / 限权管理员（v3.5.74）──
// 从管理员等级派生：限定应用范围 + 组织/分组范围 + 生效时段，到期自动失效。读=Lv.3，写按范围（见 limitedCanApp/limitedCanScope）。
const LIMITED_SCOPES = { all: '全部', org: '某个组织', group: '某个分组' };
function limitedScopeName(g) {
  if (g.scope_type === 'all') return '全部';
  const t = oauthSubjects.get.get(g.scope_id);
  if (t) return '组织：' + t.name;
  const grp = db.prepare('SELECT name FROM user_groups WHERE id=?').get(g.scope_id);
  return grp ? '分组：' + grp.name : (LIMITED_SCOPES[g.scope_type] || g.scope_type);
}
function limitedAdminView(g) {
  return { id: g.id, user_id: g.user_id, user_name: g.user_name || null, uid: g.uid_code || ('#' + String(g.uid_seq || '').padStart(5, '0')),
    apps: limitedAppsOf(g), scope_type: g.scope_type, scope_id: g.scope_id, scope_name: limitedScopeName(g),
    valid_from: g.valid_from || '', valid_to: g.valid_to || '', note: g.note || '', created_at: g.created_at,
    active: !(g.valid_from && Date.parse(g.valid_from) > Date.now()) && !(g.valid_to && Date.parse(g.valid_to) < Date.now()) };
}
router.get('/admin/limited-admins', requireAdmin(1), (req, res) => {
  res.json({ success: true, scopes: LIMITED_SCOPES, data: limitedAdmins.all.all().map(limitedAdminView) });
});
router.post('/admin/limited-admins', requireAdmin(1), (req, res) => {
  const account = String(req.body?.account || '').trim();
  const u = account ? resolveUser(account) : null;
  if (!u || u === AMBIGUOUS) return res.status(400).json({ error: u === AMBIGUOUS ? '账号不唯一，请用邮箱/手机/UID' : '请填写被授权人' });
  if (u.is_public) return res.status(400).json({ error: '公共账号不能设为管理员' });
  const appsList = (Array.isArray(req.body?.apps) ? req.body.apps : []).map(String).filter(x => apps.findById.get(x)).slice(0, 200);
  const scope_type = ['all', 'org', 'group'].includes(req.body?.scope_type) ? req.body.scope_type : 'all';
  const scope_id = scope_type === 'all' ? null : String(req.body?.scope_id || '').trim() || null;
  if (scope_type === 'org' && scope_id && !oauthSubjects.get.get(scope_id)) return res.status(400).json({ error: '组织不存在' });
  if (scope_type === 'group' && scope_id && !db.prepare('SELECT 1 FROM user_groups WHERE id=?').get(scope_id)) return res.status(400).json({ error: '分组不存在' });
  const valid_from = String(req.body?.valid_from || '').trim() || null;
  const valid_to = String(req.body?.valid_to || '').trim() || null;
  if (valid_to && valid_from && Date.parse(valid_to) < Date.parse(valid_from)) return res.status(400).json({ error: '截止时间早于起始时间' });
  const id = uuidv4();
  limitedAdmins.insert.run(id, u.id, JSON.stringify(appsList), scope_type, scope_id, valid_from, valid_to, String(req.body?.note || '').slice(0, 200), req.user.uid);
  audit('admin.limited_granted', { subject: String(u.uid_seq), actor: actorOf(req), detail: { apps: appsList, scope_type, scope_id, valid_from, valid_to } });
  res.json({ success: true, id });
});
router.delete('/admin/limited-admins/:id', requireAdmin(1), (req, res) => {
  const g = limitedAdmins.get.get(req.params.id);
  if (!g) return res.status(404).json({ error: '授权不存在' });
  limitedAdmins.remove.run(g.id);
  const u = users.findById.get(g.user_id);
  audit('admin.limited_revoked', { subject: String(u ? u.uid_seq : g.user_id), actor: actorOf(req), detail: { scope_type: g.scope_type, scope_id: g.scope_id } });
  res.json({ success: true });
});

// 系统管理员判定（按等级）
const isSysAdmin = (req, maxLevel = 2) => !req.user.org_scoped && req.user.role === 'admin' && (req.user.adminLevel || 9) <= maxLevel;
// 临时 / 限权管理员（v3.5.74）：在生效时段内、按应用 + 组织/分组范围授予管理员权限（读=Lv.3，写按范围）
function limitedAdminOf(user) {
  if (!user || !user.uid) return null;
  const now = Date.now();
  for (const g of limitedAdmins.byUser.all(user.uid)) {
    if (g.valid_from && Date.parse(g.valid_from) > now) continue;
    if (g.valid_to && Date.parse(g.valid_to) < now) continue;
    return g;
  }
  return null;
}
// 限权管理员是否可作为管理员会话（生效期内）。返回授权行或 null；命中则挂到 req._limitedAdmin。
function limitedAdminActive(req) {
  if (req.user.org_scoped) return null;
  const g = limitedAdminOf(req.user);
  if (g) req._limitedAdmin = g;
  return g;
}
function limitedAppsOf(g) { try { return JSON.parse(g.apps || '[]'); } catch (_) { return []; } }
// 限权管理员能否管某应用：不限应用 或 应用在授权列表内
function limitedCanApp(req, appId) {
  if (!req._limitedAdmin) return true;              // 非限权管理员（走原有 requireAdmin）不在此拦截
  const list = limitedAppsOf(req._limitedAdmin);
  return list.length === 0 || list.includes(appId);
}
// 限权管理员能否管某组织/分组：范围 all 或 scope_id 匹配
function limitedCanScope(req, sid) {
  if (!req._limitedAdmin) return true;
  const g = req._limitedAdmin;
  return g.scope_type === 'all' || g.scope_id === sid;
}
// 组织管理员（v3.5.76）：req._orgAdmin 是其管理的组织列表；org 参数必须在其范围内（非组织管理员不限制）
function orgAdminCanOrg(req, org) {
  if (!req._orgAdmin) return true;
  if (!org) return false;
  return req._orgAdmin.some(o => o.id === org);
}
// 组织管理员对某目标用户的写权限（v3.5.79 停用/启用/重置密码）：仅当 target 是其管理组织的成员、且非管理员、非公共账号。
// 返回 null=放行；返回字符串=拒绝原因。仅对组织管理员(req._orgAdmin)生效，系统管理员(req._orgAdmin 为空)不受限。
function orgAdminMemberDenied(req, target) {
  if (!req._orgAdmin) return null;
  if (!target) return '用户不存在';
  if (target.is_public) return '不能操作公共账号';
  if (target.role === 'admin') return '组织管理员不能操作管理员账号';
  if (!req._orgAdmin.some(o => orgMembers.get.get(o.id, target.id))) return '该用户不是你管理的组织的成员';
  return null;
}
// 组织管理员对某扇门的写权限（v3.5.79 门禁）：门必须归属其管理的某组织（全局门 subject_id 为空 → 组织管理员不可碰）。
function orgAdminDoorDenied(req, door) {
  if (!req._orgAdmin) return null;
  if (!door) return '门不存在';
  if (!door.subject_id || !req._orgAdmin.some(o => o.id === door.subject_id)) return '该门不属于你管理的组织';
  return null;
}
// 应用写权限：系统管理员(Lv.2) 直接过；限权管理员按应用范围拦（appId=null 表示新建，只有「不限应用」的能新建）
function guardAppWrite(req, res, appId) {
  if (isSysAdmin(req, 2)) return true;
  if (!limitedAdminActive(req)) { res.status(403).json({ error: '需要管理员权限' }); return false; }
  if (!limitedCanApp(req, appId)) { res.status(403).json({ error: '不在授权应用范围内' }); return false; }
  return true;
}
// 组织写权限（成员等）：系统管理员 或 该组织管理员 或 限权管理员（范围匹配）
function guardOrgWrite(req, sid, write = true) {
  if (canManageOrg(req, sid, write)) return true;
  if (limitedAdminActive(req) && limitedCanScope(req, sid)) return true;
  res.status(403).json({ error: '无权管理该组织' });
  return false;
}
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
router.post('/admin/apps', requireAuth, (req, res) => {
  if (!guardAppWrite(req, res, null)) return;
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
router.post('/admin/apps/:id/regenerate-secret', requireAuth, (req, res) => {
  const app = apps.findById.get(req.params.id);
  if (!app) return res.status(404).json({ error: '应用不存在' });
  if (!guardAppWrite(req, res, app.id)) return;
  const client_secret = crypto.randomBytes(32).toString('hex');
  db.prepare("UPDATE apps SET client_secret=?, updated_at=datetime('now') WHERE id=?").run(client_secret, app.id);
  res.json({ success: true, client_secret });
});
router.patch('/admin/apps/:id', requireAuth, (req, res) => {
  const app = apps.findById.get(req.params.id);
  if (!app) return res.status(404).json({ error: '应用不存在' });
  if (!guardAppWrite(req, res, app.id)) return;
  const { name, icon, icon_bg, description, callback_url, launch_url, required_scopes, status, visible } = req.body;
  apps.update.run({ id: app.id, name:name??app.name, icon:icon??app.icon, icon_bg:icon_bg??app.icon_bg, description:description??app.description, callback_url:callback_url??app.callback_url, launch_url:launch_url!==undefined?safeLaunchUrl(launch_url):(app.launch_url||''), required_scopes:required_scopes!==undefined?safeRequiredScopes(required_scopes):(app.required_scopes||''), status:status??app.status, visible:visible!==undefined?(visible?1:0):app.visible });
  if (req.body.category !== undefined) db.prepare('UPDATE apps SET category=? WHERE id=?').run(String(req.body.category || '').trim(), app.id);
  if (req.body.deprovision_url !== undefined) db.prepare('UPDATE apps SET deprovision_url=? WHERE id=?').run(safeLaunchUrl(req.body.deprovision_url), app.id);
  if (req.body.handover_required !== undefined) db.prepare('UPDATE apps SET handover_required=? WHERE id=?').run(req.body.handover_required ? 1 : 0, app.id);
  if (req.body.backchannel_logout_uri !== undefined) db.prepare('UPDATE apps SET backchannel_logout_uri=? WHERE id=?').run(safeLaunchUrl(req.body.backchannel_logout_uri), app.id);
  res.json({ success: true, app: apps.findById.get(app.id) });
});
// 手动把「撤销某用户账号」推给某应用（SSO 主动控制）
router.post('/admin/apps/:id/deprovision', requireAuth, async (req, res) => {
  const app = apps.findById.get(req.params.id);
  if (!app) return res.status(404).json({ error: '应用不存在' });
  if (!guardAppWrite(req, res, app.id)) return;
  if (!app.deprovision_url) return res.status(400).json({ error: '该应用未配置账号撤销回调地址' });
  const u = findRealUserByUid(String(req.body?.uid || '').trim());
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const ok = await deprovisionPush(app, { event: 'account.revoked', sub: u.id, uid: u.uid_seq, uid_code: u.uid_code || null });
  audit('app.deprovision_pushed', { subject: String(u.uid_seq), actor: actorOf(req), detail: { app: app.name, ok } });
  res.json({ success: ok, delivered: ok });
});
router.post('/admin/apps/:id/approve', requireAuth, (req, res) => {
  const app = apps.findById.get(req.params.id);
  if (!app) return res.status(404).json({ error: '应用不存在' });
  if (!guardAppWrite(req, res, app.id)) return;
  apps.approve.run(req.params.id); res.json({ success: true });
});

router.post('/admin/apps/:id/reject', requireAuth, (req, res) => {
  const app = apps.findById.get(req.params.id);
  if (!app) return res.status(404).json({ error: '应用不存在' });
  if (!guardAppWrite(req, res, app.id)) return;
  const { reason } = req.body;
  db.prepare("UPDATE apps SET status='rejected',updated_at=datetime('now') WHERE id=?").run(req.params.id);
  res.json({ success: true });
});

router.delete('/admin/apps/:id', requireAuth, (req, res) => {
  const app = apps.findById.get(req.params.id);
  if (!app) return res.status(404).json({ error: '应用不存在' });
  if (!guardAppWrite(req, res, app.id)) return;
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

// ── App 应用中心的内置工具（v3.5.30）：按权限告诉客户端显示哪些「管理类」磁贴 ──
// 只是入口不同：权限仍以各接口自己的校验为准（这里算错了最多是多显示/少显示一个磁贴）。
router.get('/user/app-center', requireAuth, (req, res) => {
  const sysRead = isSysAdmin(req, 3), sysWrite = isSysAdmin(req, 2);
  const managed = myManagedOrgs(req);
  const issue = canIssuePass(req);
  let passDoors = [];
  if (issue) {
    if (sysWrite) passDoors = access.enabledDoors.all().map(d => ({ id: d.id, name: d.name }));
    else { const u = users.findById.get(req.user.uid); passDoors = u ? accessCore.doorsForUser(u).map(d => ({ id: d.id, name: d.name })) : []; }
  }
  res.json({ success: true, tools: {
    users:   sysRead ? { write: sysWrite } : null,                        // 用户管理（系统管理员）
    devices: (sysRead || managed.length) ? { orgs: managed.map(o => ({ id: o.id, name: o.name })), all: sysRead } : null,  // 设备管理
    access:  (sysRead || issue) ? { admin: sysRead, passes: issue } : null,  // 门禁：管理员看门/记录；可签发者管访客码
    verify:  verifierOf(req).ok ? {} : null,                              // 身份核验（核验员，v3.5.32）
  }, pass_doors: passDoors });
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

router.get('/admin/logs', requireAdmin(3, { orgAdmin: true }), (req, res) => {
  if (req._orgAdmin) {
    // v3.5.76 组织管理员：只返回其管理的组织成员的登录日志
    const orgIds = req._orgAdmin.map(o => o.id);
    const ph = orgIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT l.* FROM login_logs l JOIN org_members m ON m.user_id=l.user_id WHERE m.subject_id IN (${ph}) ORDER BY l.created_at DESC LIMIT 500`).all(...orgIds);
    return res.json({ success: true, logs: rows });
  }
  res.json({ success: true, logs: logs.findAll.all() });
});

router.get('/admin/api-keys', requireAdmin(1), (req, res) => { res.json({ success: true, keys: apiKeys.findAll.all() }); });
router.post('/admin/api-keys', requireAdmin(2), (req, res) => {
  const { name, scopes = [], key_type = 'live', trusted_ips = '' } = req.body;
  if (!name) return res.status(400).json({ error: '密钥名称必填' });
  // v3.5.75.2：删除实名（users:kyc）是特殊高危权限——A2（运营管理员）创建的密钥不能直接授予，需 A1 创建/批准
  if (Array.isArray(scopes) && scopes.includes('users:kyc') && (req.user.adminLevel || 9) > 1) {
    return res.status(403).json({ error: '删除实名（users:kyc）属于特殊权限，需要超级管理员（A1）创建该密钥' });
  }

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

// ── 本站（默认主体）三方登录凭证：按平台逐个管理（v3.5.36，与组织的凭证同一种「列表 + 子页面」交互）──
// 值仍存在环境变量（env_config + process.env），这里只是按平台切片读写 + 启停开关。权限同系统配置（Lv.1）。
function setEnvVal(k, v) {
  env.set.run(k, v);
  if (String(v).trim()) process.env[k] = String(v); else delete process.env[k];
}
function envVal(k) { const row = env.get.get(k); return (row && row.value) || process.env[k] || ''; }
router.get('/admin/oauth-defaults', requireAdmin(1), (req, res) => {
  const list = Object.entries(OAUTH_META).map(([platform, meta]) => {
    const fields = meta.fields.map(k => {
      const v = envVal(k); const secret = (meta.secret || []).includes(k);
      return { key: k, secret, set: !!String(v).trim(), value: secret ? '' : v };
    });
    return { platform, label: meta.label, configured: !!String(envVal(meta.primary)).trim(),
      enabled: !defaultDisabled(platform), primary: meta.primary, fields };
  });
  res.json({ success: true, platforms: list });
});
router.put('/admin/oauth-defaults/:platform', requireAdmin(1), (req, res) => {
  const meta = OAUTH_META[req.params.platform];
  if (!meta) return res.status(404).json({ error: '未知平台' });
  const values = req.body?.values || {};
  if (values && typeof values === 'object') {
    const primaryNext = values[meta.primary] !== undefined ? String(values[meta.primary]).trim() : envVal(meta.primary);
    if (!primaryNext) return res.status(400).json({ error: `请填写 ${meta.primary}` });
    for (const k of meta.fields) {
      if (!(k in values)) continue;
      const v = String(values[k] ?? '').trim();
      const secret = (meta.secret || []).includes(k);
      if (/^•+$/.test(v)) continue;                 // 打码串不覆盖
      if (secret && !v) continue;                   // 密钥留空 = 保留原值
      setEnvVal(k, v);
    }
  }
  if (req.body?.enabled !== undefined) {
    const set = new Set(String(process.env.OAUTH_DEFAULT_DISABLED || '').split(',').map(x => x.trim()).filter(Boolean));
    if (req.body.enabled) set.delete(req.params.platform); else set.add(req.params.platform);
    setEnvVal('OAUTH_DEFAULT_DISABLED', [...set].join(','));
  }
  res.json({ success: true });
});
router.delete('/admin/oauth-defaults/:platform', requireAdmin(1), (req, res) => {
  const meta = OAUTH_META[req.params.platform];
  if (!meta) return res.status(404).json({ error: '未知平台' });
  meta.fields.forEach(k => setEnvVal(k, ''));
  const set = new Set(String(process.env.OAUTH_DEFAULT_DISABLED || '').split(',').map(x => x.trim()).filter(Boolean));
  set.delete(req.params.platform);
  setEnvVal('OAUTH_DEFAULT_DISABLED', [...set].join(','));
  res.json({ success: true });
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
// 某用户的多联系方式（v3.5.63；复用 users:read）
router.get('/v1/users/:uid/contacts', requireApiKey('users:read'), (req, res) => {
  if (req.isSandbox) return res.json({ _sandbox: true, phones: [{ value: '13800000000', source: 'wecom', is_primary: true }], emails: [{ value: 'a@x.com', source: 'wecom', is_primary: true }, { value: 'a@corp.com', source: 'wecom_biz', is_primary: false }] });
  const user = findRealUserByUid(req.params.uid);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  res.json(contactUtil.listContacts(user.id));
});
router.post('/v1/users/:uid/disable', requireApiKey('users:write'), (req, res) => {
  if (req.isSandbox) return res.json({ success: true, _sandbox: true });
  db.prepare("UPDATE users SET status='disabled' WHERE uid_seq=? OR id=?").run(req.params.uid,req.params.uid);
  audit('user.disabled', { subject: req.params.uid, actor: actorOf(req) });
  const du = findRealUserByUid(req.params.uid); if (du) onAccountSuspended(du, 'user.disabled');
  res.json({ success: true });
});
router.post('/v1/users/:uid/enable', requireApiKey('users:write'), (req, res) => {
  if (req.isSandbox) return res.json({ success: true, _sandbox: true });
  const eu = findRealUserByUid(req.params.uid);
  if (eu && (eu.deletion_state === 'deleted' || eu.merged_into)) return res.status(400).json({ error: '该账号已删除或已合并，不能启用' });
  db.prepare("UPDATE users SET status='active' WHERE uid_seq=? OR id=?").run(req.params.uid,req.params.uid);
  audit('user.enabled', { subject: req.params.uid, actor: actorOf(req) });
  if (eu) onAccountResumed(eu);
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
    const h = identityHashes(name, id_number);
    const limitErr = kycLimitError(u.id, h.pseudonym);
    if (limitErr) return res.status(400).json({ success: false, verified: false, error: limitErr });
    await verifyKycDirect(name.trim(), id_number.trim(), orgKyc);
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
    burn: 'WATERMARK_BURN', burn_text: 'WATERMARK_BURN_TEXT',
  };
  Object.entries(map).forEach(([field, envKey]) => {
    if (b[field] == null) return;
    let val = b[field];
    if (field === 'enabled' || field === 'burn') val = (val === true || /^(on|1|true|yes)$/i.test(String(val))) ? 'on' : 'off';
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
  const phone = normalizePhone(req.body?.phone);
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
  'leaderboard_on':      '1',
  'leaderboard_size':    '50',
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
    leaderboard_on:  shopCfg('leaderboard_on') !== '0',
  });
});

// ── 积分排行（v3.5.54）：默认开放，管理员可在「积分配置」关闭；关闭后用户端不显示该 tab、接口 403 ──
// 只算正常在用的真实账号：排除公共账号、停用、已合并、注销中 / 已删除
const RANK_WHERE = "is_public=0 AND status='active' AND merged_into IS NULL AND deletion_state IS NULL";
const leaderboardSize = () => Math.min(100, Math.max(10, parseInt(shopCfg('leaderboard_size'), 10) || 50));
function pointsLeaderboard(limit) {
  return db.prepare(`SELECT id, uid_seq, uid_code, name, avatar, points FROM users WHERE ${RANK_WHERE} ORDER BY points DESC, uid_seq ASC LIMIT ?`).all(limit)
    .map((r, i) => ({ ...r, points: r.points || 0, rank: i + 1 }));
}
function pointsRankOf(u) {
  const p = u.points || 0;
  return 1 + db.prepare(`SELECT COUNT(*) n FROM users WHERE ${RANK_WHERE} AND (COALESCE(points,0) > ? OR (COALESCE(points,0) = ? AND uid_seq < ?))`).get(p, p, u.uid_seq).n;
}
router.get('/shop/leaderboard', requireAuth, (req, res) => {
  if (shopCfg('leaderboard_on') === '0') return res.status(403).json({ error: '积分排行未开放' });
  const me = users.findById.get(req.user.uid);
  const size = leaderboardSize();
  const list = pointsLeaderboard(size).map(r => ({ rank: r.rank, uid_seq: r.uid_seq, uid_code: r.uid_code || null, name: r.name, avatar: r.avatar || null, points: r.points, me: !!me && r.id === me.id }));
  const ranked = me && !me.is_public && me.status === 'active' && !me.merged_into && !me.deletion_state;
  const total = db.prepare(`SELECT COUNT(*) n FROM users WHERE ${RANK_WHERE}`).get().n;
  res.json({ success: true, size, total, list, me: ranked ? { rank: pointsRankOf(me), points: me.points || 0 } : null });
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
          sms_poll_strategy, email_poll_strategy, kyc_poll_strategy, leaderboard_on, leaderboard_size } = req.body;
  const updates = {};
  if (leaderboard_on   !== undefined) updates['leaderboard_on']   = leaderboard_on ? '1' : '0';
  if (leaderboard_size !== undefined) updates['leaderboard_size'] = String(Math.min(100, Math.max(10, parseInt(leaderboard_size, 10) || 50)));
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
  const rows = pointsLeaderboard(lim);
  res.json({ total: rows.length, data: rows.map(r => ({ rank: r.rank, uid_seq: r.uid_seq, uid_code: r.uid_code || null, name: r.name, points: r.points })) });
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
      case 'dept':  { const d = departments.get.get(value); return d ? ('部门：' + d.name) : ('部门 ' + value); }
      default:      return String(value);
    }
  } catch (_) { return String(value); }
}
const ACCESS_GRANT_TYPES = ['all', 'org', 'group', 'tag', 'level', 'user', 'dept'];
const okHHMM = s => s === '' || /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s || '').trim());
function safeWeekdays(s) {
  return String(s || '').split(/[，,]/).map(x => x.trim()).filter(x => /^[0-6]$/.test(x)).join(',');
}

// ── 用户端：出示动态开门码 / 查我能开的门 ──
router.post('/user/access/qr', requireAuth, (req, res) => {
  const u = users.findById.get(req.user.uid);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  if (u.status && u.status !== 'active') return res.status(403).json({ error: '账号已被禁用' });
  // v3.5.29：带 door_id = 出该门的子码（只能开这一扇、有效期按门设定）；不带 = 主码（能开我有权限的所有门）
  const doorId = req.body?.door_id ? String(req.body.door_id) : '';
  if (doorId) {
    const door = access.doorById.get(doorId);
    if (!door) return res.status(404).json({ error: '门不存在' });
    const ev = accessCore.evaluateAccess(u, door);
    if (!ev.allow) return res.status(403).json({ error: accessCore.REASON_LABEL[ev.reason] || '无权通行此门', reason: ev.reason });
    const r = accessCore.signQr(u, accessCore.subTtl(door), door.id);
    return res.json({ success: true, code: r.code, expires_in: r.expires_in, exp: r.exp, door: { id: door.id, name: door.name } });
  }
  const r = accessCore.signQr(u);
  res.json({ success: true, code: r.code, expires_in: r.expires_in, exp: r.exp });
});
router.get('/user/access/doors', requireAuth, (req, res) => {
  const u = users.findById.get(req.user.uid);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  res.json({ success: true, doors: accessCore.doorsForUser(u) });
});

// ── 管理端：门 CRUD ──
router.get('/admin/access/doors', requireAdmin(3, { orgAdmin: true }), (req, res) => {
  const org = String(req.query?.org || '').trim();
  if (!orgAdminCanOrg(req, org)) return res.status(403).json({ error: '无权查看该组织' });   // v3.5.76 组织管理员限本组织
  const rows = access.allDoors.all()
    .filter(d => !org || d.subject_id === org)   // v3.5.70 聚焦组织时只显示该组织的门（全局门不显示）
    .map(d => ({
      ...d,
      rule_count: access.countRulesByDoor.get(d.id).n,
      subject_name: d.subject_id ? (oauthSubjects.get.get(d.subject_id)?.name || null) : null,
    }));
  res.json({ success: true, doors: rows });
});
// 门级策略（v3.5.29）：子码模式 / 子码有效期 / 访客须陪同 / 禁入时段
function applyDoorPolicy(id, body, cur) {
  const has = k => body && body[k] !== undefined;
  if (!['code_mode', 'sub_ttl', 'escort_required', 'blackout'].some(has)) return;
  const ttl = has('sub_ttl') ? parseInt(body.sub_ttl, 10) : (cur?.sub_ttl || 0);
  access.setDoorPolicy.run({
    id,
    code_mode: has('code_mode') ? (body.code_mode === 'sub_only' ? 'sub_only' : 'any') : (cur?.code_mode || 'any'),
    sub_ttl: Number.isFinite(ttl) && ttl > 0 ? Math.min(600, Math.max(15, ttl)) : 0,
    escort_required: has('escort_required') ? (body.escort_required ? 1 : 0) : (cur?.escort_required || 0),
    blackout: has('blackout') ? JSON.stringify(accessCore.normalizeWindows(body.blackout)) : (cur?.blackout || ''),
  });
}
router.post('/admin/access/doors', requireAdmin(2, { orgAdmin: true }), (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: '请填写门/通道名称' });
  // v3.5.79 组织管理员只能在自己管理的组织下建门（不能建全局门）
  if (req._orgAdmin && !orgAdminCanOrg(req, req.body?.subject_id)) return res.status(403).json({ error: '只能在你管理的组织下创建门' });
  const id = uuidv4();
  const status = ['enabled', 'disabled'].includes(req.body?.status) ? req.body.status : 'enabled';
  access.insertDoor.run({
    id, name: name.slice(0, 60),
    location: String(req.body?.location || '').trim().slice(0, 120),
    subject_id: req.body?.subject_id || null,
    status, note: String(req.body?.note || '').trim().slice(0, 300),
  });
  applyDoorPolicy(id, req.body, null);
  res.json({ success: true, door: access.doorById.get(id) });
});
router.patch('/admin/access/doors/:id', requireAdmin(2, { orgAdmin: true }), (req, res) => {
  const d = access.doorById.get(req.params.id);
  if (!d) return res.status(404).json({ error: '门不存在' });
  const denied = orgAdminDoorDenied(req, d);   // v3.5.79 组织管理员只能改本组织的门
  if (denied) return res.status(403).json({ error: denied });
  // 且不能把门移出自己的组织范围
  if (req._orgAdmin && req.body?.subject_id !== undefined && !orgAdminCanOrg(req, req.body.subject_id)) return res.status(403).json({ error: '只能把门归到你管理的组织' });
  const name = req.body?.name != null ? String(req.body.name).trim().slice(0, 60) : d.name;
  if (!name) return res.status(400).json({ error: '名称不能为空' });
  access.updateDoor.run({
    id: d.id, name,
    location: req.body?.location != null ? String(req.body.location).trim().slice(0, 120) : d.location,
    subject_id: req.body?.subject_id !== undefined ? (req.body.subject_id || null) : d.subject_id,
    status: ['enabled', 'disabled'].includes(req.body?.status) ? req.body.status : d.status,
    note: req.body?.note != null ? String(req.body.note).trim().slice(0, 300) : d.note,
  });
  applyDoorPolicy(d.id, req.body, d);
  res.json({ success: true, door: access.doorById.get(d.id) });
});
router.delete('/admin/access/doors/:id', requireAdmin(2, { orgAdmin: true }), (req, res) => {
  const denied = orgAdminDoorDenied(req, access.doorById.get(req.params.id));   // v3.5.79
  if (denied) return res.status(403).json({ error: denied });
  access.removeRulesByDoor.run(req.params.id);
  access.removeDoor.run(req.params.id);
  res.json({ success: true });
});

// ── 管理端：授权规则 ──
router.get('/admin/access/doors/:id/rules', requireAdmin(3, { orgAdmin: true }), (req, res) => {
  const door = access.doorById.get(req.params.id);
  if (!door) return res.status(404).json({ error: '门不存在' });
  const denied = orgAdminDoorDenied(req, door);   // v3.5.79 组织管理员只看本组织门的规则
  if (denied) return res.status(403).json({ error: denied });
  const rules = access.rulesByDoor.all(req.params.id).map(r => ({ ...r, label: accessRuleLabel(r.grant_type, r.grant_value) }));
  res.json({ success: true, rules });
});
router.post('/admin/access/doors/:id/rules', requireAdmin(2, { orgAdmin: true }), (req, res) => {
  const door = access.doorById.get(req.params.id);
  if (!door) return res.status(404).json({ error: '门不存在' });
  const denied = orgAdminDoorDenied(req, door);   // v3.5.79
  if (denied) return res.status(403).json({ error: denied });
  const grant_type = req.body?.grant_type;
  if (!ACCESS_GRANT_TYPES.includes(grant_type)) return res.status(400).json({ error: 'grant_type 不合法' });
  let grant_value = String(req.body?.grant_value || '').trim();
  if (grant_type !== 'all' && !grant_value) return res.status(400).json({ error: '请选择授权对象' });
  if (grant_type === 'all') grant_value = '';
  if (grant_type === 'level' && !/^[UA][1-9]$/i.test(grant_value)) return res.status(400).json({ error: '等级格式应为 U1~U9 / A1~A9' });
  if (grant_type === 'dept' && !departments.get.get(grant_value)) return res.status(400).json({ error: '部门不存在' });
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
router.delete('/admin/access/doors/:id/rules/:rid', requireAdmin(2, { orgAdmin: true }), (req, res) => {
  const denied = orgAdminDoorDenied(req, access.doorById.get(req.params.id));   // v3.5.79
  if (denied) return res.status(403).json({ error: denied });
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
  const org = String(req.query?.org || '').trim();
  res.json({ success: true, cards: org ? access.cardsByOrg.all(org) : access.allCards.all() });
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
  const org = String(req.query?.org || '').trim();
  res.json({ success: true, faces: org ? access.facesByOrg.all(org) : access.facesAll.all() });
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
  const esc = p.escort_user_id ? users.findById.get(p.escort_user_id) : null;
  return { ...p, door_names: doorNames, escort_name: esc ? esc.name : null };
}
router.get('/access/passes', requireAuth, (req, res) => {
  if (!canIssuePass(req)) return res.status(403).json({ error: '无签发访客码的权限' });
  const sys = isSysAdmin(req, 3);
  const org = String(req.query?.org || '').trim();
  let rows = sys ? access.passAll.all() : access.passByIssuer.all(req.user.uid);
  if (sys && org) {
    // v3.5.72：聚焦组织时只显示「有门属于该组织」的访客码
    const orgDoors = new Set(access.allDoors.all().filter(d => d.subject_id === org).map(d => d.id));
    rows = rows.filter(p => String(p.door_ids || '').split(',').some(id => orgDoors.has(id)));
  }
  res.json({ success: true, passes: rows.map(passView) });
});
router.post('/access/passes', requireAuth, (req, res) => {
  if (!canIssuePass(req)) return res.status(403).json({ error: '无签发访客码的权限' });
  const visitor_name = String(req.body?.visitor_name || '').trim();
  if (!visitor_name) return res.status(400).json({ error: '请填写访客姓名' });
  const doorIds = (Array.isArray(req.body?.door_ids) ? req.body.door_ids : [])
    .map(x => String(x).trim()).filter(id => access.doorById.get(id));   // 只保留存在的门
  if (!doorIds.length) return res.status(400).json({ error: '请至少选择一扇可通行的门' });
  // 非系统管理员（分组/组织管理员）只能把访客带进自己有权通行的门（v3.5.31）
  if (!isSysAdmin(req, 2)) {
    const meU = users.findById.get(req.user.uid);
    const mine = new Set(meU ? accessCore.doorsForUser(meU).map(d => d.id) : []);
    if (doorIds.some(id => !mine.has(id))) return res.status(403).json({ error: '只能签发你自己有权通行的门' });
  }
  const maxUses = Math.max(0, parseInt(req.body?.max_uses, 10) || 0);
  const me = users.findById.get(req.user.uid);
  // 指定陪同人（v3.5.29，可空：空则需陪同的门由签发人陪同）
  let escortId = null;
  if (req.body?.escort && String(req.body.escort).trim()) {
    const eu = resolveUser(String(req.body.escort).trim());
    if (eu === AMBIGUOUS) return res.status(400).json({ error: '陪同人账号有重名，请用邮箱/手机/UID' });
    if (!eu) return res.status(400).json({ error: '陪同人账号不存在' });
    escortId = eu.id;
  }
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
  access.setPassExtra.run(escortId, JSON.stringify(accessCore.normalizeWindows(req.body?.blackout)), id);
  audit('access.pass_issued', { subject: '访客:' + visitor_name, actor: actorOf(req), detail: { doors: doorIds.length, by: me ? me.name : '' } });
  res.json({ success: true, id, code });
});
router.delete('/access/passes/:id', requireAuth, (req, res) => {
  if (!canIssuePass(req)) return res.status(403).json({ error: '无权限' });
  const p = access.passById.get(req.params.id);
  if (!p) return res.status(404).json({ error: '访客码不存在' });
  if (!isSysAdmin(req, 2) && p.issued_by !== req.user.uid) return res.status(403).json({ error: '只能撤销自己签发的访客码' });
  access.revokePass.run(p.id);
  audit('access.pass_revoked', { subject: '访客:' + p.visitor_name, actor: actorOf(req) });
  res.json({ success: true });
});
// 公开：访客扫码页展示凭证信息（最小披露，不含签发人/电话）
router.get('/public/pass/:code', (req, res) => {
  const p = access.passByCode.get(String(req.params.code).trim());
  if (!p) return res.json({ ok: false });
  const doorIds = String(p.door_ids || '').split(',').map(s => s.trim()).filter(Boolean);
  const doorNames = doorIds.map(id => access.doorById.get(id)?.name || id);
  // door_list（v3.5.29）：访客页点某扇门出该门子码
  const doorList = doorIds.map(id => { const d = access.doorById.get(id); return d ? { id: d.id, name: d.name, sub_only: d.code_mode === 'sub_only', escort: !!(d.escort_required || p.escort_user_id) } : null; }).filter(Boolean);
  res.json({ ok: true, visitor_name: p.visitor_name, valid_from: p.valid_from, valid_to: p.valid_to,
    doors: doorNames, door_list: doorList, status: p.status, code: p.code, wallet: pkpass.isConfigured() });
});
// 访客某扇门的子码（v3.5.29）：持有访客码即可取（访客码本身就是凭证），子码短时一次性
router.post('/public/pass/:code/sub', (req, res) => {
  const p = access.passByCode.get(String(req.params.code).trim());
  if (!p || p.status !== 'active') return res.status(404).json({ error: '访客码无效' });
  const doorId = String(req.body?.door_id || '');
  if (!String(p.door_ids || '').split(',').map(s => s.trim()).includes(doorId)) return res.status(400).json({ error: '访客码不含此门' });
  const door = access.doorById.get(doorId);
  if (!door) return res.status(404).json({ error: '门不存在' });
  const r = accessCore.signVisitorSub(p, door);
  res.json({ success: true, code: r.code, expires_in: r.expires_in, door: { id: door.id, name: door.name } });
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
const ESCORT_WINDOW = 120;   // 访客验码通过后，等陪同人扫码的秒数
// 访客已通过凭证校验后：需陪同则挂起等陪同人，否则直接放行。返回给设备的响应体。
function passGrantOrEscort({ pass, door, ip, method }) {
  const needEscort = !!(door.escort_required || pass.escort_user_id);
  if (!needEscort) {
    access.bumpPassUse.run(pass.id);
    const ev = { allow: true, reason: 'ok' };
    writeAccessLog({ door, user: null, method, ev, ip, name: pass.visitor_name });
    return { allow: true, result: 'allow', reason: 'ok', reason_text: '放行',
      visitor: { name: pass.visitor_name, remaining: pass.max_uses > 0 ? Math.max(0, pass.max_uses - pass.used_count - 1) : null },
      door: { id: door.id, name: door.name } };
  }
  const escortId = pass.escort_user_id || pass.issued_by;
  const escort = escortId ? users.findById.get(escortId) : null;
  const ev = { allow: false, reason: 'need_escort' };
  writeAccessLog({ door, user: null, method, ev, ip, name: pass.visitor_name });
  if (!escort) return { allow: false, result: 'deny', reason: 'need_escort', reason_text: '需要陪同人，但该访客码没有可用的陪同人', door: { id: door.id, name: door.name } };
  const now = Math.floor(Date.now() / 1000);
  try { access.escortClean.run(now); } catch (_) {}
  access.escortDelPass.run(pass.id, door.id);
  access.escortInsert.run({ id: uuidv4(), door_id: door.id, pass_id: pass.id, escort_user_id: escort.id, visitor_name: pass.visitor_name, expire_at: now + ESCORT_WINDOW });
  return { allow: false, result: 'pending_escort', reason: 'need_escort',
    reason_text: `访客已核验，请陪同人「${escort.name}」在 ${ESCORT_WINDOW} 秒内于此门扫码带入`,
    visitor: { name: pass.visitor_name }, escort: { name: escort.name }, expires_in: ESCORT_WINDOW,
    door: { id: door.id, name: door.name } };
}
// 陪同人本人通过后：把这扇门上等他的访客一并放行（访客码凭证再核一次，防等待期间被撤销/用尽）
function completeEscorts(door, user, ip) {
  const now = Math.floor(Date.now() / 1000);
  const rows = access.escortFor.all(door.id, user.id, now);
  const done = [];
  for (const r of rows) {
    access.escortDel.run(r.id);
    const pass = access.passById.get(r.pass_id);
    const ev = accessCore.evaluatePass(pass, door);
    if (!ev.allow) { writeAccessLog({ door, user: null, method: 'visitor', ev, ip, name: r.visitor_name }); continue; }
    access.bumpPassUse.run(pass.id);
    writeAccessLog({ door, user: null, method: 'visitor', ev: { allow: true, reason: 'escort_ok' }, ip, name: r.visitor_name + '（陪同:' + user.name + '）' });
    done.push(r.visitor_name);
  }
  return done;
}
const denyBody = (door, reason) => ({ allow: false, result: 'deny', reason, reason_text: accessCore.REASON_LABEL[reason] || reason, door: { id: door.id, name: door.name } });

// 扫码开门：设备读到二维码内容后调此接口；动态码/子码一次性消费防重放。
// 码类型：qr1.=用户主码/门子码；vs1.=访客门子码；ft1.=跨域码；其余=静态访客码。
// v3.5.29：门级策略（禁入时段 / 只认子码）对所有类型生效；访客到「需陪同」的门先挂起，陪同人扫码才双双放行。
router.post('/v1/access/verify', requireApiKey('access:verify'), (req, res) => {
  if (req.isSandbox) return res.json({ ...SANDBOX.accessVerify(), _sandbox: true });
  const { door_id, code } = req.body || {};
  if (!door_id || !code) return res.status(400).json({ error: 'door_id 和 code 必填' });
  const door = access.doorById.get(door_id);
  if (!door) return res.status(404).json({ error: '门不存在' });
  const ip = accessClientIp(req);
  const c = String(code).trim();
  // 跨系统联邦码（ft1. 开头）：伙伴系统签发的跨域访客码，用登记的共享密钥验签（无子码机制，sub_only 门不收）
  if (c.startsWith('ft1.')) {
    const parsed = accessCore.fedParse(c);
    const peer = parsed && access.fedByCode.get(parsed.iss);
    let ev;
    const pol = accessCore.doorPolicyCheck(door, { isSub: false });
    if (pol) ev = { allow: false, reason: pol };
    else if (!peer) ev = { allow: false, reason: 'fed_unknown' };
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
  // 访客门子码（vs1.）：只能开签发时指定的那扇门
  if (c.startsWith('vs1.')) {
    const vr = accessCore.verifyVisitorSub(c, { consume: true });
    let reason = vr.ok ? null : vr.reason;
    const pass = vr.ok ? access.passByCode.get(String(vr.payload.c)) : null;
    if (!reason && !accessCore.doorMatches(vr.payload.d, door)) reason = 'wrong_door_code';
    if (!reason) reason = accessCore.doorPolicyCheck(door, { isSub: true });
    if (!reason) { const ev = accessCore.evaluatePass(pass, door); if (!ev.allow) reason = ev.reason; }
    if (reason) { writeAccessLog({ door, user: null, method: 'visitor', ev: { allow: false, reason }, ip, name: pass ? pass.visitor_name : null }); return res.json(denyBody(door, reason)); }
    return res.json(passGrantOrEscort({ pass, door, ip, method: 'visitor' }));
  }
  // 静态访客通行码（非 qr1./vs1./ft1.）：时限凭证，不走一次性消费；sub_only 门不收
  if (!c.startsWith('qr1.')) {
    const pass = access.passByCode.get(c);
    let reason = accessCore.doorPolicyCheck(door, { isSub: false });
    if (!reason) { const ev = accessCore.evaluatePass(pass, door); if (!ev.allow) reason = ev.reason; }
    if (reason) { writeAccessLog({ door, user: null, method: 'visitor', ev: { allow: false, reason }, ip, name: pass ? pass.visitor_name : null }); return res.json(denyBody(door, reason)); }
    return res.json(passGrantOrEscort({ pass, door, ip, method: 'visitor' }));
  }
  // 用户动态码：主码（无 d）或门子码（d=门 id），一次性消费
  const vr = accessCore.verifyQr(c, { consume: true });
  if (!vr.ok) {
    writeAccessLog({ door, user: null, method: 'qr', ev: { allow: false, reason: vr.reason }, ip });
    return res.json(denyBody(door, vr.reason));
  }
  const user = users.findById.get(vr.payload.u);
  let ev;
  if (vr.payload.d && !accessCore.doorMatches(vr.payload.d, door)) ev = { allow: false, reason: 'wrong_door_code' };
  else {
    const pol = accessCore.doorPolicyCheck(door, { isSub: !!vr.payload.d });
    ev = pol ? { allow: false, reason: pol } : accessCore.evaluateAccess(user, door);
  }
  writeAccessLog({ door, user, method: 'qr', ev, ip });
  const escorted = ev.allow && user ? completeEscorts(door, user, ip) : [];
  res.json({
    allow: ev.allow, result: ev.allow ? 'allow' : 'deny',
    reason: ev.reason, reason_text: accessCore.REASON_LABEL[ev.reason] || ev.reason,
    user: user ? { uid_seq: user.uid_seq, uid_code: user.uid_code || null, name: user.name } : null,
    ...(escorted.length ? { escorted } : {}),
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
  // 卡/人脸不是二维码，不受「只认子码」约束；禁入时段照样生效（v3.5.29）
  const black = door.blackout && accessCore.inBlackout(door.blackout) ? 'door_blackout' : null;
  const ev = !user ? { allow: false, reason: reasonNoUser } : black ? { allow: false, reason: black } : accessCore.evaluateAccess(user, door);
  writeAccessLog({ door, user, method: m, ev, ip });
  const escorted = ev.allow && user ? completeEscorts(door, user, ip) : [];
  res.json({
    allow: ev.allow, result: ev.allow ? 'allow' : 'deny',
    reason: ev.reason, reason_text: accessCore.REASON_LABEL[ev.reason] || ev.reason,
    user: user ? { uid_seq: user.uid_seq, uid_code: user.uid_code || null, name: user.name } : null,
    ...(escorted.length ? { escorted } : {}),
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
