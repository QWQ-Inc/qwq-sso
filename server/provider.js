/**
 * QWQ SSO 作为「身份提供方」（OIDC Provider）
 *
 * ⚠️ 别和 oauth.js 搞混：
 *   - oauth.js  = 本系统作为「消费方」去登录微信/飞书/Google 等 13 个平台
 *   - provider.js（本文件）= 第三方应用反过来「用 QWQ SSO 登录」
 *
 * 实现标准 OAuth2 授权码流程 + OIDC，支持 PKCE。
 * id_token 用 HS256 以应用自己的 client_secret 签名（OIDC 对私密客户端允许的做法），
 * 好处是不需要维护 RSA 密钥对和 JWKS 端点，接入方用现成的 OIDC 客户端库即可验签。
 */
const express = require('express');
const crypto  = require('crypto');
const jwt     = require('jsonwebtoken');
const { db, idp, users, apps, groups, tags, appVisibleToUser, access } = require('./db');
const { audit } = require('./audit');
const { requireAuth } = require('./auth');
const accessCore = require('./access');

const router = express.Router();

const CODE_TTL   = 10 * 60 * 1000;      // 授权码 10 分钟
const TOKEN_TTL  = 2 * 60 * 60 * 1000;  // 访问令牌 2 小时

// ──────────────────────────────────────────
// scope 定义：决定「能拿到什么」，这是最小化披露的核心
// required=true 的用户不能取消勾选
// ──────────────────────────────────────────
const SCOPES = {
  openid:  { label: '确认你的身份',   descr: '获取你在本系统的唯一标识（不含任何个人资料）', required: true },
  profile: { label: '基本资料',       descr: '昵称、头像、UID、等级', required: false },
  email:   { label: '邮箱地址',       descr: '你绑定的邮箱', required: false },
  phone:   { label: '手机号',         descr: '你绑定的手机号', required: false },
  kyc:     { label: '实名认证状态',   descr: '是否已实名、姓名（脱敏）、证件号后四位', required: false, sensitive: true },
  org:     { label: '所属组织',       descr: '你在本系统的分组与标签（组织维度，不含权限等级）', required: false },
};
const ALL_SCOPES = Object.keys(SCOPES);

function parseScope(raw) {
  const list = String(raw ?? '').split(/[\s+]+/).filter(Boolean);
  const out = list.filter(s => ALL_SCOPES.includes(s));
  // 完全没传 scope → 按 OIDC 默认给 openid；
  // 传了就尊重原样（可以不含 openid = 纯 OAuth2 授权码模式，只发 access_token 不发 id_token）
  if (!list.length) return ['openid'];
  return [...new Set(out)];
}

/** 应用配置的「必传字段」scope（用户不可取消）。不强加 openid——是否走 OIDC 由请求的 scope 决定。 */
function appRequired(app) {
  const arr = String(app.required_scopes || '').split(/[\s,]+/).filter(s => ALL_SCOPES.includes(s));
  return [...new Set(arr)];
}

/** 某些必传 scope 依赖用户实际拥有的数据；缺了会让应用端映射失败，需拦下引导绑定。
 *  只对「身份映射类」字段判空：email / phone。其余 scope 总能给出（哪怕是 false/脱敏）。 */
function missingRequired(user, requiredArr) {
  const need = { email: '邮箱', phone: '手机号' };
  return requiredArr
    .filter(s => need[s] && !user[s === 'email' ? 'email' : 'phone'])
    .map(s => ({ scope: s, label: need[s] }));
}

/** 秒级 Unix 时间戳（把 SQLite 的 datetime 文本按 UTC 解析） */
function unixOf(dt) {
  if (!dt) return undefined;
  const ms = Date.parse(/[TZ]/.test(dt) ? dt : dt.replace(' ', 'T') + 'Z');
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

/** 按已授权 scope 过滤用户信息 —— 没授权的字段一个都不给 */
function claimsFor(user, scopeArr) {
  const c = { sub: user.id };
  if (scopeArr.includes('profile')) {
    c.name               = user.name || '';
    c.preferred_username = user.uid_code || user.name || String(user.uid_seq || '');
    c.picture            = user.avatar || null;
    c.uid                = String(user.uid_seq || '').padStart(5, '0');
    c.uid_code           = user.uid_code || null;   // 自定义 UID（老用户为 null）
    c.level_tag          = (user.role === 'admin' ? 'A' : 'U') + (user.role === 'admin' ? (user.admin_level || 3) : (user.user_level || 4));
    c.created_at         = user.created_at;
    const upd = unixOf(user.updated_at || user.created_at);
    if (upd !== undefined) c.updated_at = upd;       // OIDC 标准 profile claim（秒级）
  }
  if (scopeArr.includes('email')) {
    c.email = user.email || null;
    c.email_verified = !!user.email;
  }
  if (scopeArr.includes('phone')) {
    c.phone_number = user.phone || null;
    c.phone_number_verified = !!user.phone;
  }
  if (scopeArr.includes('kyc')) {
    c.kyc_verified = !!user.kyc_verified;
    // 姓名脱敏：张三 → 张*，欧阳明 → 欧**
    c.kyc_name    = user.kyc_name ? user.kyc_name[0] + '*'.repeat(Math.max(1, user.kyc_name.length - 1)) : null;
    c.kyc_id_tail = user.kyc_id_tail || null;
    // 假名化标识（S-08）：同一自然人跨账号恒定、不可逆、不泄露任何身份原文。仅已实名且配了密钥时有值
    if (user.kyc_pseudonym) c.kyc_pseudonym = user.kyc_pseudonym;
  }
  if (scopeArr.includes('org')) {
    // 分组（互斥，一人一个）+ 标签（可叠加）。只给名称，不下发内部 id / 权限。
    const g = user.group_id ? groups.get.get(user.group_id) : null;
    c.group  = g ? g.name : null;
    const ts = tags.ofUser.all(user.id) || [];
    c.groups = g ? [g.name] : [];      // 兼容多数 OIDC 客户端约定的 groups 数组
    c.tags   = ts.map(t => t.name);
  }
  return c;
}

/** 已授权直通中转页的倒计时秒数：env OIDC_LAUNCH_COUNTDOWN，默认 3，夹在 0~30（0=不倒计时直接跳） */
function launchCountdown() {
  const n = parseInt(process.env.OIDC_LAUNCH_COUNTDOWN, 10);
  if (Number.isNaN(n)) return 3;
  return Math.max(0, Math.min(30, n));
}

/** redirect_uri 必须与应用登记的完全一致（支持逗号分隔多个） */
function redirectAllowed(app, uri) {
  if (!uri) return false;
  return String(app.callback_url || '')
    .split(',').map(s => s.trim()).filter(Boolean)
    .includes(uri);
}

function baseUrl(req) {
  return (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

/** 把错误按 OAuth2 规范回跳给第三方；redirect_uri 不可信时才直接显示 */
function errBack(res, redirectUri, state, error, desc) {
  if (!redirectUri) return res.status(400).json({ error, error_description: desc });
  const u = new URL(redirectUri);
  u.searchParams.set('error', error);
  if (desc)  u.searchParams.set('error_description', desc);
  if (state) u.searchParams.set('state', state);
  return res.redirect(u.toString());
}

// ──────────────────────────────────────────
// 发现端点：接入方用现成 OIDC 库时会自动读这个
// ──────────────────────────────────────────
router.get('/.well-known/openid-configuration', (req, res) => {
  const b = baseUrl(req);
  res.json({
    issuer: b,
    authorization_endpoint: `${b}/oauth/authorize`,
    token_endpoint:         `${b}/oauth/token`,
    userinfo_endpoint:      `${b}/oauth/userinfo`,
    revocation_endpoint:    `${b}/oauth/revoke`,
    introspection_endpoint: `${b}/oauth/introspect`,
    scopes_supported:                     ALL_SCOPES,
    response_types_supported:             ['code'],
    grant_types_supported:                ['authorization_code'],
    subject_types_supported:              ['public'],
    id_token_signing_alg_values_supported:['HS256'],
    token_endpoint_auth_methods_supported:['client_secret_post', 'client_secret_basic'],
    code_challenge_methods_supported:     ['S256', 'plain'],
    claims_supported: ['sub','name','preferred_username','picture','uid','uid_code','level_tag',
                       'created_at','updated_at','email','email_verified',
                       'phone_number','phone_number_verified','kyc_verified','kyc_name','kyc_id_tail','kyc_pseudonym',
                       'group','groups','tags','auth_time','nonce','account_type','valid_until','from_peer'],
  });
});

// ──────────────────────────────────────────
// 1) 授权端点：第三方把用户跳到这里
// ──────────────────────────────────────────
router.get('/oauth/authorize', (req, res) => {
  const { client_id, redirect_uri, response_type, state, nonce,
          code_challenge, code_challenge_method, prompt } = req.query;

  const app = client_id ? idp.findAppByClientId.get(client_id) : null;
  // client_id / redirect_uri 有问题时绝不能回跳（可能是钓鱼），直接显示错误
  if (!app) return res.status(400).json({ error: 'invalid_client', error_description: 'client_id 无效' });
  if (!redirectAllowed(app, redirect_uri)) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'redirect_uri 未在应用中登记' });
  }
  if (app.status !== 'enabled') {
    return errBack(res, redirect_uri, state, 'access_denied', '该应用尚未启用或已被停用');
  }
  if (response_type !== 'code') {
    return errBack(res, redirect_uri, state, 'unsupported_response_type', '仅支持 response_type=code');
  }
  if (code_challenge && !['S256', 'plain'].includes(code_challenge_method || 'plain')) {
    return errBack(res, redirect_uri, state, 'invalid_request', 'code_challenge_method 不支持');
  }

  // 参数合法 → 交给同意页（静态页读 localStorage 里的 JWT 判断登录态）
  const q = new URLSearchParams({
    client_id, redirect_uri, scope: parseScope(req.query.scope).join(' '),
    state: state || '', nonce: nonce || '',
    code_challenge: code_challenge || '', code_challenge_method: code_challenge_method || '',
    prompt: prompt || '',
  });
  res.redirect(`/authorize.html?${q}`);
});

// ── 公开的应用展示信息（登录页过渡用，无需登录；只给名称/图标，绝不含任何用户数据）──
router.get('/oauth/app-info', (req, res) => {
  const app = idp.findAppByClientId.get(req.query.client_id || '');
  if (!app || app.status !== 'enabled') return res.status(404).json({ error: '应用不存在或未启用' });
  res.json({ success: true, app: { name: app.name, icon: app.icon, icon_bg: app.icon_bg, description: app.description } });
});

// ── 同意页拉取展示信息（需要登录态）──
router.get('/oauth/consent-info', requireAuth, (req, res) => {
  const app = idp.findAppByClientId.get(req.query.client_id || '');
  if (!app) return res.status(400).json({ error: 'client_id 无效' });
  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(401).json({ error: '用户不存在' });
  // 组织隔离：应用只开放给指定组织时，非成员在授权页就明确拒绝（而非走到 /oauth/consent 才 403）
  if (!appVisibleToUser(app.id, user.id)) return res.status(403).json({ error: '该应用未对你所属的组织开放' });

  const required = appRequired(app);
  // 展示的 scope = 应用申请的 ∪ 应用配置的必传（去重，openid 置顶）
  const asked = [...new Set([...parseScope(req.query.scope), ...required])];
  const granted = (idp.grantedScope.get(user.id, app.id)?.scope || '').split(' ').filter(Boolean);

  // 必传字段里，用户实际缺失的（如必传邮箱但没绑）→ 前端拦下引导绑定
  const missing = missingRequired(user, required);

  res.json({
    success: true,
    app:  { name: app.name, icon: app.icon, icon_bg: app.icon_bg, description: app.description },
    user: { name: user.name, avatar: user.avatar, uid: String(user.uid_seq || '').padStart(5, '0') },
    // 每一项都带说明，让用户清楚这次到底交出去什么；required=应用强制必传，不可取消
    scopes: asked.map(s => ({
      key: s, ...SCOPES[s],
      required: required.includes(s) || SCOPES[s]?.required,
      granted: granted.includes(s),
    })),
    // 缺失的必传字段：非空则前端展示「请先绑定」拦截页，不允许授权
    missingRequired: missing,
    // 之前授权过且本次（含必传）没有新权限、也不缺必传数据 → 前端可走免打扰直通
    alreadyGranted: !missing.length && asked.every(s => granted.includes(s)),
    // 已授权直通时的中转页倒计时秒数（管理员可配，0=不倒计时直接跳）
    countdown: launchCountdown(),
  });
});

// ── 用户点「同意」：签发授权码 ──
router.post('/oauth/consent', requireAuth, (req, res) => {
  const { client_id, redirect_uri, scope, state, nonce,
          code_challenge, code_challenge_method, approve } = req.body;

  const app = idp.findAppByClientId.get(client_id || '');
  if (!app || app.status !== 'enabled') return res.status(400).json({ error: '应用无效或未启用' });
  if (!redirectAllowed(app, redirect_uri))  return res.status(400).json({ error: 'redirect_uri 未登记' });

  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(401).json({ error: '用户不存在' });
  if (user.status !== 'active') return res.status(403).json({ error: '账号已被停用，无法授权' });
  // 组织隔离：应用若只开放给指定组织，非成员不得授权登录
  if (!appVisibleToUser(app.id, user.id)) return res.status(403).json({ error: '该应用未对你所属的组织开放' });

  if (!approve) {
    const u = new URL(redirect_uri);
    u.searchParams.set('error', 'access_denied');
    u.searchParams.set('error_description', '用户拒绝授权');
    if (state) u.searchParams.set('state', state);
    return res.json({ success: true, redirect: u.toString() });
  }

  // 必传字段兜底：即使前端被绕过，也强制把应用配置的必传 scope 并进去
  const required = appRequired(app);
  // 缺失的必传数据（如必传邮箱但用户没绑）→ 直接拒绝，不能签码，否则应用端映射失败
  const missing = missingRequired(user, required);
  if (missing.length) {
    return res.status(409).json({ error: '缺少该应用要求的必传信息：' + missing.map(m => m.label).join('、') + '，请先在账号设定里绑定后再登录', missingRequired: missing });
  }

  // 以用户实际勾选的为准，但强制并入必传 scope；parseScope 丢弃未知 scope 并补 openid
  const finalScope = [...new Set([...parseScope(scope), ...required])];

  idp.cleanCodes.run(Date.now());
  idp.killCodes.run(app.id, user.id);   // 作废该用户此前未使用的码

  const code = 'ac_' + crypto.randomBytes(32).toString('hex');
  idp.insertCode.run({
    code, app_id: app.id, user_id: user.id, redirect_uri,
    scope: finalScope.join(' '),
    nonce: nonce || null,
    code_challenge: code_challenge || null,
    challenge_method: code_challenge ? (code_challenge_method || 'plain') : null,
    expires_at: Date.now() + CODE_TTL,
  });

  // 记录授权关系（含本次实际授予的 scope）
  const isNew = !idp.grantedScope.get(user.id, app.id);
  idp.upsertGrant.run(user.id, app.id, finalScope.join(' '));
  if (isNew) apps.incAuthUsers.run(app.id);

  // 存证：用户对某应用的 OIDC 授权（外部系统审批 / 身份确认）
  audit('oidc.authorized', { subject: user.uid_seq, actor: `user:${user.id}`, detail: { app: app.name, client_id: app.client_id, scope: finalScope.join(' '), new_grant: isNew } });

  const u = new URL(redirect_uri);
  u.searchParams.set('code', code);
  if (state) u.searchParams.set('state', state);
  res.json({ success: true, redirect: u.toString() });
});

// ──────────────────────────────────────────
// 2) 令牌端点：第三方后端用 code 换 token
// ──────────────────────────────────────────
router.post('/oauth/token', (req, res) => {
  const noStore = () => res.set('Cache-Control', 'no-store').set('Pragma', 'no-cache');

  let { grant_type, code, redirect_uri, client_id, client_secret, code_verifier } = req.body;

  // 支持 HTTP Basic 方式传客户端凭据
  const basic = req.headers.authorization;
  if (basic?.startsWith('Basic ')) {
    const [id, secret] = Buffer.from(basic.slice(6), 'base64').toString('utf8').split(':');
    client_id     = client_id     || id;
    client_secret = client_secret || secret;
  }

  if (grant_type !== 'authorization_code') {
    return noStore().status(400).json({ error: 'unsupported_grant_type' });
  }

  const app = idp.findAppByClientId.get(client_id || '');
  if (!app) return noStore().status(401).json({ error: 'invalid_client' });

  // 定长比较，避免时序侧信道
  const okSecret = client_secret &&
    Buffer.byteLength(client_secret) === Buffer.byteLength(app.client_secret) &&
    crypto.timingSafeEqual(Buffer.from(client_secret), Buffer.from(app.client_secret));
  if (!okSecret) return noStore().status(401).json({ error: 'invalid_client', error_description: 'client_secret 不正确' });

  // 跨域应用登录：联邦授权码（不绑 users，claims 来自伙伴断言）走独立分支
  const fedRow = idp.findCode.get(code || '') ? null : access.fedCodeGet.get(code || '');
  if (fedRow) return handleFedToken(req, res, fedRow, app, { redirect_uri, code_verifier }, noStore);

  const row = idp.findCode.get(code || '');
  if (!row)                       return noStore().status(400).json({ error: 'invalid_grant', error_description: '授权码不存在' });
  if (row.used)                   return noStore().status(400).json({ error: 'invalid_grant', error_description: '授权码已被使用' });
  if (row.expires_at < Date.now())return noStore().status(400).json({ error: 'invalid_grant', error_description: '授权码已过期' });
  if (row.app_id !== app.id)      return noStore().status(400).json({ error: 'invalid_grant', error_description: '授权码不属于该应用' });
  if (row.redirect_uri !== redirect_uri) {
    return noStore().status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri 与授权时不一致' });
  }

  // PKCE 校验
  if (row.code_challenge) {
    if (!code_verifier) return noStore().status(400).json({ error: 'invalid_grant', error_description: '缺少 code_verifier' });
    const actual = row.challenge_method === 'S256'
      ? crypto.createHash('sha256').update(code_verifier).digest('base64url')
      : code_verifier;
    if (actual !== row.code_challenge) {
      return noStore().status(400).json({ error: 'invalid_grant', error_description: 'code_verifier 校验失败' });
    }
  }

  idp.useCode.run(row.code);   // 一次性

  const user = users.findById.get(row.user_id);
  if (!user || user.status !== 'active') {
    return noStore().status(400).json({ error: 'invalid_grant', error_description: '用户不存在或已停用' });
  }

  const scopeArr = row.scope.split(' ').filter(Boolean);
  const accessToken = 'at_' + crypto.randomBytes(32).toString('hex');
  const expiresAt   = Date.now() + TOKEN_TTL;

  idp.cleanTokens.run(Date.now());
  idp.insertToken.run(sha256(accessToken), app.id, user.id, row.scope, expiresAt);

  const now = Math.floor(Date.now() / 1000);
  const resp = {
    access_token: accessToken,
    token_type:   'Bearer',
    expires_in:   Math.floor(TOKEN_TTL / 1000),
    scope:        row.scope,
  };
  // 只有请求了 openid 才是 OIDC → 才签发 id_token；否则是纯 OAuth2，只给 access_token
  if (scopeArr.includes('openid')) {
    resp.id_token = jwt.sign({
      ...claimsFor(user, scopeArr),
      iss: baseUrl(req),
      aud: app.client_id,
      iat: now,
      auth_time: now,     // 本系统换码即视为完成认证的时刻
      exp: now + Math.floor(TOKEN_TTL / 1000),
      ...(row.nonce ? { nonce: row.nonce } : {}),
    }, app.client_secret, { algorithm: 'HS256' });
  }
  noStore().json(resp);
});

// ──────────────────────────────────────────
// 3) 用户信息端点
// ──────────────────────────────────────────
router.get('/oauth/userinfo', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'invalid_token' });

  const thash = sha256(auth.slice(7));
  const row = idp.findToken.get(thash);
  if (!row) {
    // 跨域应用登录：联邦令牌（claims 已在换码时裁剪好）
    const fedTok = access.fedTokenGet.get(thash);
    if (fedTok) {
      if (fedTok.expires_at < Date.now()) return res.status(401).json({ error: 'invalid_token', error_description: '令牌已过期' });
      try { return res.json(JSON.parse(fedTok.claims)); } catch (_) { return res.status(500).json({ error: 'server_error' }); }
    }
    return res.status(401).json({ error: 'invalid_token', error_description: '令牌无效' });
  }
  if (row.expires_at < Date.now()) return res.status(401).json({ error: 'invalid_token', error_description: '令牌已过期' });

  const user = users.findById.get(row.user_id);
  if (!user || user.status !== 'active') return res.status(401).json({ error: 'invalid_token' });

  // 用户可能在授权后又收回了权限，以当前授权关系和令牌 scope 的交集为准
  const stillGranted = (idp.grantedScope.get(user.id, row.app_id)?.scope || '').split(' ').filter(Boolean);
  const effective = row.scope.split(' ').filter(s => stillGranted.includes(s));
  if (!effective.length) return res.status(403).json({ error: 'insufficient_scope', error_description: '用户已撤销授权' });

  res.json(claimsFor(user, effective));
});

// ──────────────────────────────────────────
// 4) 应用启动（用户在控制台主动「打开」应用 = IdP 发起式登录）
//    前端带用户 JWT 调本接口，拿到跳转地址后自行 window.open。
//    - 应用填了 launch_url → 直接给它（应用自己会发起标准 OIDC，因已授权而静默直通）
//    - 没填 → 用应用登记的 callback_url 拼一条 /oauth/authorize 链接，
//      用户已授权时授权页会免打扰直通、把 code 送到应用回调
// ──────────────────────────────────────────
router.post('/oauth/launch', requireAuth, (req, res) => {
  const app = idp.findAppByClientId.get(req.body.client_id || '')
           || apps.findById.get(req.body.app_id || '');
  if (!app) return res.status(404).json({ error: '应用不存在' });
  if (app.status !== 'enabled') return res.status(403).json({ error: '该应用尚未启用' });
  // 组织隔离：应用若只开放给指定组织，非成员不得发起
  if (!appVisibleToUser(app.id, req.user.uid)) return res.status(403).json({ error: '该应用未对你所属的组织开放' });

  // 应用自建入口优先
  if (app.launch_url && /^https?:\/\//i.test(app.launch_url)) {
    return res.json({ success: true, mode: 'launch_url', url: app.launch_url });
  }

  // 回退：SSO 直接拼授权链接（IdP 发起式）
  const redirectUri = String(app.callback_url || '').split(',').map(s => s.trim()).filter(Boolean)[0];
  if (!redirectUri) return res.status(400).json({ error: '应用未配置回调地址，也未填发起地址，无法打开' });

  // 用户已授权过就沿用其授权范围（保证授权页静默直通）；否则给最小 openid+profile
  const granted = (idp.grantedScope.get(req.user.uid, app.id)?.scope || '').split(' ').filter(Boolean);
  const scope = (granted.length ? granted : ['openid', 'profile']).join(' ');

  const q = new URLSearchParams({
    client_id: app.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    state: 'idp_' + crypto.randomBytes(8).toString('hex'),
  });
  res.json({ success: true, mode: 'authorize', url: `${baseUrl(req)}/oauth/authorize?${q}` });
});

// ── 令牌自省（RFC 7662）：应用拿自己收到的 access_token 来查「是否仍有效/是不是临期/何时到期」──
//    让应用无需 IAM 写权限即可管理本地账号：联邦令牌 active 实时反映伙伴是否被撤销/到期。
router.post('/oauth/introspect', (req, res) => {
  let { token, client_id, client_secret } = req.body || {};
  const basic = req.headers.authorization;
  if (basic?.startsWith('Basic ')) {
    const [id, sec] = Buffer.from(basic.slice(6), 'base64').toString('utf8').split(':');
    client_id = client_id || id; client_secret = client_secret || sec;
  }
  const app = idp.findAppByClientId.get(client_id || '');
  if (!app) return res.status(401).json({ error: 'invalid_client' });
  const okSecret = client_secret &&
    Buffer.byteLength(client_secret) === Buffer.byteLength(app.client_secret) &&
    crypto.timingSafeEqual(Buffer.from(client_secret), Buffer.from(app.client_secret));
  if (!okSecret) return res.status(401).json({ error: 'invalid_client' });
  if (!token) return res.json({ active: false });

  const h = sha256(token);
  // 普通令牌（绑真实用户）
  const row = idp.findToken.get(h);
  if (row) {
    if (row.app_id !== app.id) return res.json({ active: false });   // 只能自省发给自己的令牌
    const user = users.findById.get(row.user_id);
    const stillGranted = (idp.grantedScope.get(row.user_id, row.app_id)?.scope || '');
    const active = !!user && user.status === 'active' && row.expires_at > Date.now() && !!stillGranted;
    return res.json(active
      ? { active: true, sub: user.id, scope: row.scope, token_type: 'Bearer', exp: Math.floor(row.expires_at / 1000), account_type: 'permanent', username: user.uid_code || String(user.uid_seq) }
      : { active: false });
  }
  // 联邦临期令牌（不绑用户，claims 自带）
  const ft = access.fedTokenGet.get(h);
  if (ft) {
    if (ft.app_id !== app.id) return res.json({ active: false });
    let claims = {}; try { claims = JSON.parse(ft.claims); } catch (_) {}
    const m = /^fed:([^:]+):/.exec(claims.sub || '');
    const peer = m ? access.fedByCode.get(m[1]) : null;
    const peerOk = !!peer && peer.status === 'active' && (!peer.valid_until || new Date(String(peer.valid_until).replace(' ', 'T')) > new Date());
    const active = ft.expires_at > Date.now() && peerOk;
    return res.json(active
      ? { active: true, sub: claims.sub, scope: ft.scope, token_type: 'Bearer', exp: Math.floor(ft.expires_at / 1000), account_type: 'federated', valid_until: peer.valid_until || undefined, from_peer: peer.name || claims.from_peer }
      : { active: false });
  }
  res.json({ active: false });
});

// ── 令牌吊销 ──
router.post('/oauth/revoke', (req, res) => {
  const { token } = req.body;
  if (token) db.prepare('DELETE FROM oauth_access_tokens WHERE token_hash=?').run(sha256(token));
  res.json({ success: true });   // 规范要求：无论令牌是否存在都返回成功
});

// ──────────────────────────────────────────
// 5) 跨域应用登录（v3.5.7）：伙伴(B)的用户用本系统(A)开放给 B 的 OIDC 应用
//    身份由 B 用共享密钥签名断言，不在 A 创建真实用户；授权码/令牌走独立 fed 表。
// ──────────────────────────────────────────
// 换码（联邦分支）：校验 app/redirect_uri/PKCE/过期/一次性，从 claims 出 id_token。
function handleFedToken(req, res, row, app, { redirect_uri, code_verifier }, noStore) {
  if (row.used)                   return noStore().status(400).json({ error: 'invalid_grant', error_description: '授权码已被使用' });
  if (row.expires_at < Date.now())return noStore().status(400).json({ error: 'invalid_grant', error_description: '授权码已过期' });
  if (row.app_id !== app.id)      return noStore().status(400).json({ error: 'invalid_grant', error_description: '授权码不属于该应用' });
  if (row.redirect_uri !== redirect_uri) return noStore().status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri 与授权时不一致' });
  if (row.code_challenge) {
    if (!code_verifier) return noStore().status(400).json({ error: 'invalid_grant', error_description: '缺少 code_verifier' });
    const actual = row.challenge_method === 'S256'
      ? crypto.createHash('sha256').update(code_verifier).digest('base64url') : code_verifier;
    if (actual !== row.code_challenge) return noStore().status(400).json({ error: 'invalid_grant', error_description: 'code_verifier 校验失败' });
  }
  access.fedCodeUse.run(row.code);

  let claims; try { claims = JSON.parse(row.claims); } catch (_) { claims = { sub: 'fed:unknown' }; }
  const scopeArr = row.scope.split(' ').filter(Boolean);
  const accessToken = 'at_' + crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + TOKEN_TTL;
  try { access.fedTokenClean.run(Date.now()); } catch (_) {}
  access.fedTokenInsert.run(sha256(accessToken), app.id, JSON.stringify(claims), row.scope, expiresAt);

  const now = Math.floor(Date.now() / 1000);
  const resp = { access_token: accessToken, token_type: 'Bearer', expires_in: Math.floor(TOKEN_TTL / 1000), scope: row.scope };
  if (scopeArr.includes('openid')) {
    resp.id_token = jwt.sign({
      ...claims, iss: baseUrl(req), aud: app.client_id, iat: now, auth_time: now,
      exp: now + Math.floor(TOKEN_TTL / 1000), ...(row.nonce ? { nonce: row.nonce } : {}),
    }, app.client_secret, { algorithm: 'HS256' });
  }
  noStore().json(resp);
}

// 伙伴跳转入口：B 把用户带着 fl1 令牌跳来这里 → 验签 → 落联邦授权码 → 回跳应用 callback
router.get('/fed/launch', (req, res) => {
  const { peer, token, app: clientId, redirect_uri, scope, state, nonce, code_challenge, code_challenge_method } = req.query;
  const fail = msg => res.status(400).send('跨域应用登录失败：' + msg);
  const parsed = accessCore.fedLaunchParse(token);
  if (!parsed || parsed.iss !== peer) return fail('令牌无效');
  const p = access.fedByCode.get(String(peer || ''));
  if (!p) return fail('未知的联邦伙伴');
  if (!accessCore.fedVerifySig(parsed.body, parsed.sig, p.secret)) return fail('令牌签名无效');
  if (p.status !== 'active') return fail('该联邦伙伴已停用');
  if (p.valid_until && new Date(String(p.valid_until).replace(' ', 'T')) < new Date()) return fail('联邦合作已到期');
  if (!parsed.e || parsed.e < Math.floor(Date.now() / 1000)) return fail('令牌已过期');

  const app = idp.findAppByClientId.get(String(clientId || ''));
  if (!app || app.status !== 'enabled') return fail('应用不存在或未启用');
  // A 必须已把该应用开放给这个伙伴
  const openApps = String(p.app_ids || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!openApps.includes(app.id)) return fail('该应用未对此伙伴开放');
  if (!redirectAllowed(app, redirect_uri)) return fail('redirect_uri 与应用登记不一致');

  // 按请求 scope 裁剪 claims（联邦访客只给伙伴断言的字段，不碰 A 本地用户数据）
  const reqScope = parseScope(scope || 'openid profile email');
  const claims = { sub: 'fed:' + p.peer_code + ':' + (parsed.sub || parsed.name || 'guest'), from_peer: p.name };
  // 生命周期声明：告诉应用这是「联邦临期身份」+ 失效时间，应用据此管理本地账号（无需 IAM 写权限）
  claims.account_type = 'federated';
  if (p.valid_until) claims.valid_until = p.valid_until;
  if (reqScope.includes('profile')) { claims.name = parsed.name || ''; claims.preferred_username = parsed.name || ''; }
  if (reqScope.includes('email') && parsed.email) { claims.email = parsed.email; claims.email_verified = false; } // 伙伴断言、本系统未独立验证

  const codeVal = 'fc_' + crypto.randomBytes(24).toString('hex');
  access.fedCodeInsert.run({
    code: codeVal, app_id: app.id, peer_id: p.id, claims: JSON.stringify(claims),
    redirect_uri, scope: reqScope.join(' ') || 'openid',
    nonce: nonce || null, code_challenge: code_challenge || null, challenge_method: code_challenge_method || null,
    expires_at: Date.now() + CODE_TTL,
  });
  try { audit('fed.app_login', { subject: 'fed:' + (parsed.name || parsed.sub), actor: 'peer:' + p.peer_code, detail: { app: app.name } }); } catch (_) {}
  const u = new URL(redirect_uri);
  u.searchParams.set('code', codeVal);
  if (state) u.searchParams.set('state', String(state));
  res.redirect(u.toString());
});

// ── 联邦配对·接收推送（v3.5.9）：伙伴域直接把配对码推来；仅接受「可用域」白名单内的来源 ──
router.post('/fed/pair/receive', express.json(), (req, res) => {
  const from = String(req.body?.from || '').trim();
  const allowed = String(process.env.FED_ALLOWED_DOMAINS || '').split(/[，,]/).map(s => s.trim().toLowerCase().replace(/^\.+/, '')).filter(Boolean);
  let host = ''; try { host = new URL(/^https?:\/\//.test(from) ? from : 'https://' + from).hostname.toLowerCase(); } catch (_) {}
  if (!host || !allowed.some(d => host === d || host.endsWith('.' + d))) {
    return res.status(403).json({ error: '来源域不在可用域白名单内（对方需在 FED_ALLOWED_DOMAINS 配置你的域）' });
  }
  const parsed = accessCore.parsePairCode(String(req.body?.code || '').trim());
  if (!parsed) return res.status(400).json({ error: '配对码无效' });
  if (access.fedByCode.get(parsed.peer_code)) return res.json({ success: true, already: true });  // 幂等
  const crypto2 = require('crypto');
  access.insertFed.run({
    id: crypto2.randomUUID(), name: host, peer_code: parsed.peer_code, secret: parsed.secret,
    base_url: (parsed.domain || from).replace(/\/+$/, ''), door_ids: '', app_ids: '', valid_until: '', note: '',
  });
  try { audit('fed.pair_received', { subject: host, actor: 'peer:' + host }); } catch (_) {}
  res.json({ success: true });
});

module.exports = router;
module.exports.SCOPES = SCOPES;
