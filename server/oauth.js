/**
 * OAuth 登录路由
 * 微信公众号 / 企业微信 / 飞书 / 钉钉
 * 抖音 / 快手 / 小红书 / Bilibili
 *
 * 文档参考：
 *   抖音:    https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/account-permission/oauth2/get-access-token
 *   快手:    https://open.kuaishou.com/platform/openApi?menuId=9
 *   小红书:  https://developers.xiaohongshu.com/docs/oauth2
 *   B站:     https://socialsisteryi.github.io/bilibili-API-collect/docs/login/OAuth2/
 */
const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { v4: uuidv4 } = require('uuid');
const { db, nextUidSeq, users, oauth, oauthProviders, oauthSubjects, state: stateStore, logs } = require('./db');
const { signToken, signShortToken, requireAuth } = require('./auth');

const router = express.Router();

// 每个 /auth 请求的上下文（让 findOrCreate 能读到 session 里的绑定意图，无需改 13 个回调）
const reqCtx = new AsyncLocalStorage();
router.use((req, res, next) => reqCtx.run(req, next));

// 绑定三方账号：登录态用户先调这里把「要绑到哪个用户」存进 session，再跳 /auth/<平台>?bind=1
router.post('/stash-bind', requireAuth, (req, res) => {
  if (!req.session) return res.status(500).json({ error: '会话不可用' });
  req.session.bindUserId = req.user.uid;
  req.session.bindExpire = Date.now() + 10 * 60 * 1000;   // 10 分钟内有效，防遗留
  res.json({ success: true });
});

// ──────────────────────────────────────────
// 登录后回跳地址（OIDC 授权流程用）
//
// 第三方登录要经过「本站 → 平台 → 回调」一圈服务端跳转，前端的 ?next=
// 没法一路带过去，所以在进入 /auth/* 时把它存进 session，登录成功后取出。
// 只接受站内相对路径，防止被构造成开放重定向把 token 带去外站。
// ──────────────────────────────────────────
function safeNextPath(raw) {
  if (typeof raw !== 'string') return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  return raw;
}

// 任何进入 /auth 且带 ?next= 的请求，把回跳地址记进 session。
// 回调请求本身不带 next，因此不会覆盖。
router.use((req, res, next) => {
  const nx = safeNextPath(req.query.next);
  if (nx && req.session) req.session.postLoginNext = nx;
  next();
});

// 扫码登录（微信/企业微信）的二维码直接指向平台，不经过 /auth/<平台> 入口，
// 所以 next 无从带上。登录页在展示二维码前先打这个端点，把 next 存进 session。
// （上面的中间件已完成存储，这里只需回一个空响应）
router.get('/stash-next', (req, res) => res.status(204).end());

// ──────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────
function genState() {
  return crypto.randomBytes(16).toString('hex');
}

// state 的 provider 列存的是「providerKey」：默认主体=平台名（如 wechat），
// 额外主体=平台名:实例id（如 wechat:uuid）。回调据此还原用哪套凭证 + 绑到哪个 provider。
function saveState(state, providerKey) {
  stateStore.set.run(state, providerKey, Date.now() + 10 * 60 * 1000);
}

function consumeState(state) {
  const row = stateStore.get.get(state);
  if (!row) return null;
  stateStore.del.run(state);
  if (Date.now() > row.expire_at) return null;
  return row;
}

// ──────────────────────────────────────────
// 三方登录「多主体」凭证解析
//   默认主体：读环境变量（与旧行为完全一致，零迁移）
//   额外主体：读 oauth_providers 表里该实例的 config JSON（键名与环境变量同名）
// 返回对象的属性名 = 该平台的环境变量名，处理器里把 process.env.X 换成 c.X 即可。
// ──────────────────────────────────────────
const { PLATFORMS: OAUTH_META } = require('./oauth-meta');

function getCred(platform, instanceId) {
  const meta = OAUTH_META[platform];
  const fields = meta && meta.fields;
  if (!fields) return null;
  if (instanceId) {
    const row = oauthProviders.get.get(instanceId);
    if (!row || row.platform !== platform || !row.enabled) return null;
    // 所属主体停用 → 整套凭证的登录入口都关闭（挡住绕过登录页直接打 /auth/<平台>?inst= 的情况）
    if (row.subject_id) {
      const subj = oauthSubjects.get.get(row.subject_id);
      if (subj && !subj.enabled) return null;
    }
    let cfg = {}; try { cfg = JSON.parse(row.config || '{}'); } catch (_) {}
    const out = { _instanceId: instanceId, _providerKey: `${platform}:${instanceId}`, _label: row.label || '' };
    fields.forEach(k => { out[k] = cfg[k] != null && cfg[k] !== '' ? cfg[k] : undefined; });
    return out;
  }
  const out = { _instanceId: null, _providerKey: platform, _label: '' };
  fields.forEach(k => { out[k] = process.env[k]; });
  return out;
}

// 从 state 里存的 providerKey 还原凭证
function credFromKey(providerKey) {
  const idx = providerKey.indexOf(':');
  const platform = idx < 0 ? providerKey : providerKey.slice(0, idx);
  const instanceId = idx < 0 ? null : providerKey.slice(idx + 1);
  return getCred(platform, instanceId);
}

// providerKey → 所属主体 id（env 默认凭证无主体，返回 null，即独立不合并）
function subjectOfProviderKey(providerKey) {
  const idx = providerKey.indexOf(':');
  if (idx < 0) return null;
  const credId = providerKey.slice(idx + 1);
  const row = oauthProviders.get.get(credId);
  return row ? (row.subject_id || null) : null;
}
// 某主体下全部凭证的 providerKey 列表（用于同人合并的查找范围）
function credentialKeysOfSubject(subjectId) {
  return oauthProviders.bySubject.all(subjectId).map(r => `${r.platform}:${r.id}`);
}
// 建号并绑定本次三方身份
function createBoundUser({ provider, openId, unionId, name, email }) {
  const newUser = users.create({ name: name || '', email: email || null });
  if (!name) {
    db.prepare("UPDATE users SET name=? WHERE id=?").run(`用户${newUser.uid_seq}`, newUser.id);
    newUser.name = `用户${newUser.uid_seq}`;
  }
  oauth.bind.run(uuidv4(), newUser.id, provider, openId, unionId);
  return newUser;
}

/** 查找或创建 OAuth 绑定用户，返回用户行 */
function findOrCreate({ provider, openId, unionId = null, name, avatar = null, email = null }) {
  // 0. 绑定模式：把本次三方身份绑到「当前登录用户」（stash-bind 存进 session），而不是登录/建号
  const creq = reqCtx.getStore();
  const bindUserId = creq?.session?.bindUserId;
  const bindOk = bindUserId && (!creq.session.bindExpire || creq.session.bindExpire > Date.now());
  if (bindOk) {
    const target = users.findById.get(bindUserId);
    const existing = oauth.findByProvider.get(provider, openId);
    if (existing && existing.id !== bindUserId) {
      creq._bind = { error: '该三方账号已被其他账号绑定' };
    } else if (!target || target.is_public) {
      creq._bind = { error: '登录态已失效，请重新登录后再绑定' };
    } else {
      oauth.bind.run(uuidv4(), target.id, provider, openId, unionId);
      creq._bind = { ok: true };
    }
    return target || null;
  }

  // 1. 按本凭证的 OAuth 绑定精确查找（同一凭证 + openid）
  let user = oauth.findByProvider.get(provider, openId);
  if (user) return user;

  // 2. 「主体」内同人识别合并
  const subjectId = subjectOfProviderKey(provider);
  if (subjectId) {
    // DB 凭证：只在【同一主体】内合并（跨主体保持数据隔离）。先按 unionid，再按邮箱。
    const keys = credentialKeysOfSubject(subjectId);
    if (keys.length) {
      const ph = keys.map(() => '?').join(',');
      let match = null;
      if (unionId) {
        match = db.prepare(`SELECT u.* FROM users u JOIN user_oauth o ON u.id=o.user_id
          WHERE o.union_id=? AND o.provider IN (${ph})`).get(unionId, ...keys);
      }
      if (!match && email) {
        match = db.prepare(`SELECT u.* FROM users u JOIN user_oauth o ON u.id=o.user_id
          WHERE u.email=? AND o.provider IN (${ph})`).get(email, ...keys);
      }
      if (match) {
        oauth.bind.run(uuidv4(), match.id, provider, openId, unionId);
        return match;
      }
    }
    // 同主体内没有同人 → 新建（不做全局邮箱合并，保持主体间隔离）
    return createBoundUser({ provider, openId, unionId, name, email });
  }

  // 3. env 默认凭证（无主体，单租户）：保持原有全局邮箱合并
  if (email) {
    const existing = users.findByEmail.get(email);
    if (existing) {
      oauth.bind.run(uuidv4(), existing.id, provider, openId, unionId);
      return existing;
    }
  }

  // 4. 全新用户
  return createBoundUser({ provider, openId, unionId, name, email });
}

/** 登录成功 → 跳转中间页（存 token 后再进 dashboard）*/
function loginSuccess(res, user) {
  // 绑定模式：不切换登录态，绑好后跳回控制台（成功/冲突都清掉一次性的 bind 标记）
  const creq = res.req;
  if (creq && creq._bind) {
    if (creq.session) { delete creq.session.bindUserId; delete creq.session.bindExpire; }
    const b = creq._bind;
    return res.redirect(b.ok
      ? '/dashboard.html?bind=success'
      : `/dashboard.html?bind=error&msg=${encodeURIComponent(b.error || '绑定失败')}`);
  }
  if (!user || user.status === 'disabled') {
    return res.redirect('/login.html?error=account_disabled');
  }
  try {
    logs.insert.run({
      id: uuidv4(),
      user_id: user.id, user_name: user.name, uid_seq: String(user.uid_seq),
      method: '第三方 OAuth', app_name: '本系统',
      ip: null, user_agent: null, status: 'success', fail_reason: null,
    });
  } catch (_) {}

  // 取出并清掉登录前记下的回跳地址（OIDC 授权流程会用到）
  let next = null;
  if (res.req?.session?.postLoginNext) {
    next = safeNextPath(res.req.session.postLoginNext);
    delete res.req.session.postLoginNext;
  }

  // 开了 2FA 的用户：第三方登录也要走二段，不能绕过（否则强制 2FA 形同虚设）。
  // 发 5 分钟中间态令牌，跳到登录页由前端浮层校验动态码，再换正式 token。
  if (user.twofa_enabled) {
    const pending = signShortToken({ uid: user.id, stage: '2fa', method: '第三方 OAuth' });
    const q = new URLSearchParams({ tfa: pending });
    if (next) q.set('next', next);
    return res.redirect(`/login.html?${q}`);
  }

  const token = signToken({ uid: user.id, name: user.name, role: user.role, adminLevel: user.admin_level });
  // 中间页拿 token 存进 localStorage 后再跳到 next；有 next 时它会跳过倒计时直接回授权页
  const q = new URLSearchParams({ token, name: user.name || '' });
  if (next) q.set('next', next);
  res.redirect(`/login-success.html?${q}`);
}

/** 统一错误处理 */
function oauthError(res, provider, err) {
  console.error(`[OAuth:${provider}]`, err.response?.data || err.message);
  res.redirect(`/login.html?error=${provider}_failed`);
}

// ══════════════════════════════════════════
// 微信公众号 OAuth2.0
// https://developers.weixin.qq.com/doc/offiaccount/OA_Web_Apps/Wechat_webpage_authorization.html
// ══════════════════════════════════════════
router.get('/wechat', (req, res) => {
  const c = getCred('wechat', req.query.inst);
  if (!c || !c.WECHAT_APP_ID) return res.redirect('/login.html?error=wechat_not_configured');
  const state = genState();
  saveState(state, c._providerKey);
  const p = new URLSearchParams({
    appid: c.WECHAT_APP_ID,
    redirect_uri: c.WECHAT_REDIRECT_URI,
    response_type: 'code', scope: 'snsapi_userinfo', state,
  });
  res.redirect(`https://open.weixin.qq.com/connect/oauth2/authorize?${p}#wechat_redirect`);
});

router.get('/wechat/callback', async (req, res) => {
  const { code, state } = req.query;
  const st = consumeState(state);
  if (!st) return res.redirect('/login.html?error=invalid_state');
  const c = credFromKey(st.provider);
  if (!c) return res.redirect('/login.html?error=wechat_not_configured');
  try {
    const t = (await axios.get('https://api.weixin.qq.com/sns/oauth2/access_token', {
      params: { appid: c.WECHAT_APP_ID, secret: c.WECHAT_APP_SECRET, code, grant_type: 'authorization_code' },
    })).data;
    const u = (await axios.get('https://api.weixin.qq.com/sns/userinfo', {
      params: { access_token: t.access_token, openid: t.openid, lang: 'zh_CN' },
    })).data;
    loginSuccess(res, findOrCreate({ provider: c._providerKey, openId: t.openid, unionId: u.unionid, name: u.nickname, avatar: u.headimgurl }));
  } catch (e) { oauthError(res, 'wechat', e); }
});

// ══════════════════════════════════════════
// 企业微信自建应用
// https://developer.work.weixin.qq.com/document/path/91335
// ══════════════════════════════════════════
router.get('/wecom', (req, res) => {
  const c = getCred('wecom', req.query.inst);
  if (!c || !c.WECOM_CORP_ID) return res.redirect('/login.html?error=wecom_not_configured');
  const state = genState();
  saveState(state, c._providerKey);
  const p = new URLSearchParams({
    appid: c.WECOM_CORP_ID, agentid: c.WECOM_AGENT_ID,
    redirect_uri: c.WECOM_REDIRECT_URI,
    response_type: 'code', scope: 'snsapi_privateinfo', state,
  });
  res.redirect(`https://open.weixin.qq.com/connect/oauth2/authorize?${p}#wechat_redirect`);
});

router.get('/wecom/callback', async (req, res) => {
  const { code, state } = req.query;
  const st = consumeState(state);
  if (!st) return res.redirect('/login.html?error=invalid_state');
  const c = credFromKey(st.provider);
  if (!c) return res.redirect('/login.html?error=wecom_not_configured');
  try {
    const { access_token } = (await axios.get('https://qyapi.weixin.qq.com/cgi-bin/gettoken', {
      params: { corpid: c.WECOM_CORP_ID, corpsecret: c.WECOM_APP_SECRET },
    })).data;
    const ui = (await axios.get('https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo', {
      params: { access_token, code },
    })).data;
    const userId = ui.userid || ui.openid;
    let name = userId, avatar = null;
    if (ui.userid) {
      const d = (await axios.get('https://qyapi.weixin.qq.com/cgi-bin/user/get', {
        params: { access_token, userid: userId },
      })).data;
      name = d.name || userId; avatar = d.avatar;
    }
    loginSuccess(res, findOrCreate({ provider: c._providerKey, openId: userId, name, avatar }));
  } catch (e) { oauthError(res, 'wecom', e); }
});

// ══════════════════════════════════════════
// 飞书自建应用
// https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/login/overview
// ══════════════════════════════════════════
router.get('/feishu', (req, res) => {
  const c = getCred('feishu', req.query.inst);
  if (!c || !c.FEISHU_APP_ID) return res.redirect('/login.html?error=feishu_not_configured');
  const state = genState();
  saveState(state, c._providerKey);
  const p = new URLSearchParams({
    client_id: c.FEISHU_APP_ID, redirect_uri: c.FEISHU_REDIRECT_URI,
    response_type: 'code', scope: 'contact:user.id:readonly', state,
  });
  res.redirect(`https://open.feishu.cn/open-apis/authen/v1/authorize?${p}`);
});

router.get('/feishu/callback', async (req, res) => {
  const { code, state } = req.query;
  const st = consumeState(state);
  if (!st) return res.redirect('/login.html?error=invalid_state');
  const c = credFromKey(st.provider);
  if (!c) return res.redirect('/login.html?error=feishu_not_configured');
  try {
    const appToken = (await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      app_id: c.FEISHU_APP_ID, app_secret: c.FEISHU_APP_SECRET,
    })).data.tenant_access_token;
    const userToken = (await axios.post('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
      grant_type: 'authorization_code', code,
      client_id: c.FEISHU_APP_ID, client_secret: c.FEISHU_APP_SECRET,
      redirect_uri: c.FEISHU_REDIRECT_URI,
    }, { headers: { Authorization: `Bearer ${appToken}` } })).data.data?.access_token;
    const info = (await axios.get('https://open.feishu.cn/open-apis/authen/v1/user_info', {
      headers: { Authorization: `Bearer ${userToken}` },
    })).data.data;
    loginSuccess(res, findOrCreate({
      provider: c._providerKey, openId: info.open_id,
      name: info.name || info.en_name, avatar: info.avatar_url,
      email: info.enterprise_email || info.email,
    }));
  } catch (e) { oauthError(res, 'feishu', e); }
});

// ══════════════════════════════════════════
// 钉钉 OAuth 2.0
// https://open.dingtalk.com/document/orgapp/obtain-identity-credentials
// ══════════════════════════════════════════
router.get('/dingtalk', (req, res) => {
  const c = getCred('dingtalk', req.query.inst);
  if (!c || !c.DINGTALK_CLIENT_ID) return res.redirect('/login.html?error=dingtalk_not_configured');
  const state = genState();
  saveState(state, c._providerKey);
  const p = new URLSearchParams({
    client_id: c.DINGTALK_CLIENT_ID, redirect_uri: c.DINGTALK_REDIRECT_URI,
    response_type: 'code', scope: 'openid', state, prompt: 'consent',
  });
  res.redirect(`https://login.dingtalk.com/oauth2/auth?${p}`);
});

router.get('/dingtalk/callback', async (req, res) => {
  const { code, state } = req.query;
  const st = consumeState(state);
  if (!st) return res.redirect('/login.html?error=invalid_state');
  const c = credFromKey(st.provider);
  if (!c) return res.redirect('/login.html?error=dingtalk_not_configured');
  try {
    const userToken = (await axios.post('https://api.dingtalk.com/v1.0/oauth2/userAccessToken', {
      clientId: c.DINGTALK_CLIENT_ID, clientSecret: c.DINGTALK_CLIENT_SECRET,
      code, grantType: 'authorization_code',
    })).data.accessToken;
    const info = (await axios.get('https://api.dingtalk.com/v1.0/contact/users/me', {
      headers: { 'x-acs-dingtalk-access-token': userToken },
    })).data;
    loginSuccess(res, findOrCreate({
      provider: c._providerKey, openId: info.unionId || info.openId,
      name: info.nick || info.name, avatar: info.avatarUrl, email: info.email,
    }));
  } catch (e) { oauthError(res, 'dingtalk', e); }
});

// ══════════════════════════════════════════
// 抖音开放平台 OAuth 2.0
// https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/account-permission/oauth2/get-access-token
// 注意：抖音开放平台仅对企业主体开放，需完成企业认证
// ══════════════════════════════════════════
router.get('/douyin', (req, res) => {
  const c = getCred('douyin', req.query.inst);
  if (!c || !c.DOUYIN_CLIENT_KEY) return res.redirect('/login.html?error=douyin_not_configured');
  const state = genState();
  saveState(state, c._providerKey);
  const p = new URLSearchParams({
    client_key: c.DOUYIN_CLIENT_KEY,
    redirect_uri: c.DOUYIN_REDIRECT_URI,
    response_type: 'code',
    scope: 'user_info',
    state,
  });
  res.redirect(`https://open.douyin.com/platform/oauth/connect?${p}`);
});

router.get('/douyin/callback', async (req, res) => {
  const { code, state } = req.query;
  const st = consumeState(state);
  if (!st) return res.redirect('/login.html?error=invalid_state');
  const c = credFromKey(st.provider);
  if (!c) return res.redirect('/login.html?error=douyin_not_configured');
  try {
    // Step 1: code 换 access_token
    const tokenResp = (await axios.post('https://open.douyin.com/oauth/access_token/', {
      client_key: c.DOUYIN_CLIENT_KEY,
      client_secret: c.DOUYIN_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
    })).data.data;

    // Step 2: 获取用户信息
    const userResp = (await axios.get('https://open.douyin.com/oauth/userinfo/', {
      params: {
        access_token: tokenResp.access_token,
        open_id: tokenResp.open_id,
      },
    })).data.data;

    loginSuccess(res, findOrCreate({
      provider: c._providerKey,
      openId: tokenResp.open_id,
      unionId: tokenResp.union_id || null,
      name: userResp.nickname || '抖音用户',
      avatar: userResp.avatar,
    }));
  } catch (e) { oauthError(res, 'douyin', e); }
});

// ══════════════════════════════════════════
// 快手开放平台 OAuth 2.0
// https://open.kuaishou.com/platform/openApi?menuId=9
// 注意：需在快手开放平台完成企业认证并创建应用
// ══════════════════════════════════════════
router.get('/kuaishou', (req, res) => {
  const c = getCred('kuaishou', req.query.inst);
  if (!c || !c.KUAISHOU_APP_ID) return res.redirect('/login.html?error=kuaishou_not_configured');
  const state = genState();
  saveState(state, c._providerKey);
  const p = new URLSearchParams({
    app_id: c.KUAISHOU_APP_ID,
    redirect_uri: c.KUAISHOU_REDIRECT_URI,
    response_type: 'code',
    scope: 'user_info',
    state,
  });
  res.redirect(`https://open.kuaishou.com/oauth2/connect?${p}`);
});

router.get('/kuaishou/callback', async (req, res) => {
  const { code, state } = req.query;
  const st = consumeState(state);
  if (!st) return res.redirect('/login.html?error=invalid_state');
  const c = credFromKey(st.provider);
  if (!c) return res.redirect('/login.html?error=kuaishou_not_configured');
  try {
    // Step 1: code 换 access_token
    const tokenData = (await axios.post('https://open.kuaishou.com/oauth2/access_token', {
      app_id: c.KUAISHOU_APP_ID,
      app_secret: c.KUAISHOU_APP_SECRET,
      code,
      grant_type: 'authorization_code',
    })).data;

    // Step 2: 获取用户信息
    const userInfo = (await axios.get('https://open.kuaishou.com/openapi/user_info', {
      params: { app_id: c.KUAISHOU_APP_ID, access_token: tokenData.access_token },
    })).data.user_info;

    loginSuccess(res, findOrCreate({
      provider: c._providerKey,
      openId: tokenData.open_id,
      name: userInfo.user_name || '快手用户',
      avatar: userInfo.head_url,
    }));
  } catch (e) { oauthError(res, 'kuaishou', e); }
});

// ══════════════════════════════════════════
// 小红书 OAuth 2.0
// https://developers.xiaohongshu.com/docs/oauth2
// 注意：小红书开放平台目前仅对合作机构开放，需申请接入资质
// ══════════════════════════════════════════
router.get('/xiaohongshu', (req, res) => {
  const c = getCred('xiaohongshu', req.query.inst);
  if (!c || !c.XHS_APP_ID) return res.redirect('/login.html?error=xiaohongshu_not_configured');
  const state = genState();
  saveState(state, c._providerKey);
  const p = new URLSearchParams({
    appid: c.XHS_APP_ID,
    redirect_uri: c.XHS_REDIRECT_URI,
    response_type: 'code',
    scope: 'user.info',
    state,
  });
  res.redirect(`https://oauth.xiaohongshu.com/oauth2/authorize?${p}`);
});

router.get('/xiaohongshu/callback', async (req, res) => {
  const { code, state } = req.query;
  const st = consumeState(state);
  if (!st) return res.redirect('/login.html?error=invalid_state');
  const c = credFromKey(st.provider);
  if (!c) return res.redirect('/login.html?error=xiaohongshu_not_configured');
  try {
    // Step 1: code 换 access_token
    const tokenData = (await axios.post('https://oauth.xiaohongshu.com/oauth2/access_token', null, {
      params: {
        appid: c.XHS_APP_ID,
        secret: c.XHS_APP_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: c.XHS_REDIRECT_URI,
      },
    })).data;

    // Step 2: 获取用户信息
    const userInfo = (await axios.get('https://openapi.xiaohongshu.com/api/sns/v1/user/info', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    })).data.data;

    loginSuccess(res, findOrCreate({
      provider: c._providerKey,
      openId: tokenData.user_id || userInfo.open_id,
      name: userInfo.nickname || '小红书用户',
      avatar: userInfo.avatar,
    }));
  } catch (e) { oauthError(res, 'xiaohongshu', e); }
});

// ══════════════════════════════════════════
// Bilibili OAuth 2.0
// https://socialsisteryi.github.io/bilibili-API-collect/docs/login/OAuth2/
// 注意：B站开放平台需申请成为合作开发者，普通账号不可直接接入
// ══════════════════════════════════════════
router.get('/bilibili', (req, res) => {
  const c = getCred('bilibili', req.query.inst);
  if (!c || !c.BILIBILI_CLIENT_ID) return res.redirect('/login.html?error=bilibili_not_configured');
  const state = genState();
  saveState(state, c._providerKey);
  const p = new URLSearchParams({
    client_id: c.BILIBILI_CLIENT_ID,
    redirect_uri: c.BILIBILI_REDIRECT_URI,
    response_type: 'code',
    scope: 'user:info',
    state,
  });
  res.redirect(`https://passport.bilibili.com/oauth2/authorize?${p}`);
});

router.get('/bilibili/callback', async (req, res) => {
  const { code, state } = req.query;
  const st = consumeState(state);
  if (!st) return res.redirect('/login.html?error=invalid_state');
  const c = credFromKey(st.provider);
  if (!c) return res.redirect('/login.html?error=bilibili_not_configured');
  try {
    // Step 1: code 换 access_token（需要 HMAC-SHA256 签名）
    const ts = Math.floor(Date.now() / 1000);
    const nonce = crypto.randomBytes(8).toString('hex');
    const signStr = `client_id=${c.BILIBILI_CLIENT_ID}&ts=${ts}&nonce=${nonce}`;
    const sign = crypto.createHmac('sha256', c.BILIBILI_CLIENT_SECRET)
      .update(signStr).digest('hex');

    const tokenData = (await axios.post('https://passport.bilibili.com/oauth2/access_token', {
      client_id: c.BILIBILI_CLIENT_ID,
      client_secret: c.BILIBILI_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: c.BILIBILI_REDIRECT_URI,
      ts, nonce, sign,
    })).data.data;

    // Step 2: 获取用户信息
    const userInfo = (await axios.get('https://passport.bilibili.com/oauth2/info', {
      params: {
        access_token: tokenData.access_token,
        client_id: c.BILIBILI_CLIENT_ID,
        ts, nonce, sign,
      },
    })).data.data;

    loginSuccess(res, findOrCreate({
      provider: c._providerKey,
      openId: String(userInfo.uid || userInfo.mid),
      name: userInfo.uname || 'B站用户',
      avatar: userInfo.face,
    }));
  } catch (e) { oauthError(res, 'bilibili', e); }
});

// ══════════════════════════════════════════
// Google OAuth 2.0
// 文档: https://developers.google.com/identity/protocols/oauth2/web-server
// 控制台: https://console.cloud.google.com → API 和服务 → 凭证 → 创建 OAuth 客户端
// 注意: 回调地址必须在 Google Cloud Console 中注册
// ══════════════════════════════════════════
router.get('/google', (req, res) => {
  const c = getCred('google', req.query.inst);
  if (!c || !c.GOOGLE_CLIENT_ID) return res.redirect('/login.html?error=google_not_configured');
  const state = genState();
  saveState(state, c._providerKey);
  const p = new URLSearchParams({
    client_id: c.GOOGLE_CLIENT_ID,
    redirect_uri: c.GOOGLE_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'offline',
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${p}`);
});

router.get('/google/callback', async (req, res) => {
  const { code, state } = req.query;
  const st = consumeState(state);
  if (!st) return res.redirect('/login.html?error=invalid_state');
  const c = credFromKey(st.provider);
  if (!c) return res.redirect('/login.html?error=google_not_configured');
  try {
    // Step 1: code 换 token
    const tokenData = (await axios.post('https://oauth2.googleapis.com/token', {
      code,
      client_id: c.GOOGLE_CLIENT_ID,
      client_secret: c.GOOGLE_CLIENT_SECRET,
      redirect_uri: c.GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    })).data;

    // Step 2: 从 id_token 解析用户信息（JWT payload，无需额外请求）
    const payload = JSON.parse(Buffer.from(tokenData.id_token.split('.')[1], 'base64').toString());

    loginSuccess(res, findOrCreate({
      provider: c._providerKey,
      openId: payload.sub,
      name: payload.name || payload.email?.split('@')[0] || 'Google 用户',
      avatar: payload.picture,
      email: payload.email,
    }));
  } catch (e) { oauthError(res, 'google', e); }
});

// ══════════════════════════════════════════
// Apple Sign In (Sign in with Apple)
// 文档: https://developer.apple.com/documentation/sign_in_with_apple/sign_in_with_apple_js
// 控制台: https://developer.apple.com → Certificates → Identifiers → Keys
// 注意:
//   1. 需要付费 Apple Developer 账号（$99/年）
//   2. 回调地址必须是 HTTPS，不支持 localhost
//   3. Apple 仅在用户首次授权时返回姓名和邮箱，之后不再返回
//   4. 需创建 Services ID（client_id）和 Key（生成 JWT client_secret）
// ══════════════════════════════════════════
router.get('/apple', (req, res) => {
  const c = getCred('apple', req.query.inst);
  if (!c || !c.APPLE_CLIENT_ID) return res.redirect('/login.html?error=apple_not_configured');
  const state = genState();
  saveState(state, c._providerKey);
  const nonce = crypto.randomBytes(16).toString('hex');
  const p = new URLSearchParams({
    client_id: c.APPLE_CLIENT_ID,        // Services ID，如 com.yourcompany.sso
    redirect_uri: c.APPLE_REDIRECT_URI,
    response_type: 'code id_token',
    response_mode: 'form_post',                    // Apple 强制要求 form_post
    scope: 'name email',
    state,
    nonce,
  });
  res.redirect(`https://appleid.apple.com/auth/authorize?${p}`);
});

// Apple 使用 form_post，所以回调是 POST
router.post('/apple/callback', async (req, res) => {
  const { code, state, id_token, user } = req.body;
  const st = consumeState(state);
  if (!st) return res.redirect('/login.html?error=invalid_state');
  const providerKey = st.provider || 'apple';
  try {
    // 解析 id_token 获取 sub（Apple 用户唯一 ID）
    // 生产环境应验证 id_token 签名（从 https://appleid.apple.com/auth/keys 获取公钥）
    const payload = JSON.parse(Buffer.from(id_token.split('.')[1], 'base64').toString());
    const appleUserId = payload.sub;
    const email = payload.email;

    // user 字段仅首次授权时存在（JSON 字符串）
    let name = 'Apple 用户';
    if (user) {
      try {
        const parsed = typeof user === 'string' ? JSON.parse(user) : user;
        const fn = parsed?.name?.firstName || '';
        const ln = parsed?.name?.lastName || '';
        name = (fn + ' ' + ln).trim() || email?.split('@')[0] || name;
      } catch (_) {}
    }

    loginSuccess(res, findOrCreate({
      provider: providerKey,
      openId: appleUserId,
      name,
      email,
    }));
  } catch (e) { oauthError(res, 'apple', e); }
});

// ── GitHub OAuth ──
router.get('/github', (req, res) => {
  const c = getCred('github', req.query.inst);
  if (!c || !c.GITHUB_CLIENT_ID) return res.redirect('/login.html?error=github_not_configured');
  const state = genState(); const scope = 'read:user user:email';
  saveState(state, c._providerKey);
  res.redirect(`https://github.com/login/oauth/authorize?client_id=${c.GITHUB_CLIENT_ID}&scope=${encodeURIComponent(scope)}&state=${state}`);
});
router.get('/github/callback', async (req, res) => {
  const { code, state } = req.query;
  const st = consumeState(state);
  if (!st) return res.redirect('/login.html?error=invalid_state');
  const c = credFromKey(st.provider);
  if (!c) return res.redirect('/login.html?error=github_not_configured');
  try {
    const tok = (await axios.post('https://github.com/login/oauth/access_token', { client_id: c.GITHUB_CLIENT_ID, client_secret: c.GITHUB_CLIENT_SECRET, code }, { headers: { Accept: 'application/json' } })).data;
    const user = (await axios.get('https://api.github.com/user', { headers: { Authorization: `Bearer ${tok.access_token}`, 'User-Agent': 'QWQ-SSO' } })).data;
    loginSuccess(res, findOrCreate({ provider: c._providerKey, openId: String(user.id), name: user.name || user.login, email: user.email, avatar: user.avatar_url }));
  } catch (e) { oauthError(res, 'github', e); }
});

// ── Microsoft OAuth ──
router.get('/microsoft', (req, res) => {
  const c = getCred('microsoft', req.query.inst);
  if (!c || !c.MICROSOFT_CLIENT_ID) return res.redirect('/login.html?error=microsoft_not_configured');
  const state = genState(); const tenant = c.MICROSOFT_TENANT || 'common';
  saveState(state, c._providerKey);
  const params = new URLSearchParams({ client_id: c.MICROSOFT_CLIENT_ID, response_type: 'code', scope: 'openid profile email User.Read', state, redirect_uri: `${process.env.BASE_URL}/auth/microsoft/callback` });
  res.redirect(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${params}`);
});
router.get('/microsoft/callback', async (req, res) => {
  const { code, state } = req.query;
  const st = consumeState(state);
  if (!st) return res.redirect('/login.html?error=invalid_state');
  const c = credFromKey(st.provider);
  if (!c) return res.redirect('/login.html?error=microsoft_not_configured');
  try {
    const tenant = c.MICROSOFT_TENANT || 'common';
    const tok = (await axios.post(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, new URLSearchParams({ client_id: c.MICROSOFT_CLIENT_ID, client_secret: c.MICROSOFT_CLIENT_SECRET, code, grant_type: 'authorization_code', redirect_uri: `${process.env.BASE_URL}/auth/microsoft/callback` }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).data;
    const profile = (await axios.get('https://graph.microsoft.com/v1.0/me', { headers: { Authorization: `Bearer ${tok.access_token}` } })).data;
    loginSuccess(res, findOrCreate({ provider: c._providerKey, openId: profile.id, name: profile.displayName, email: profile.mail || profile.userPrincipalName }));
  } catch (e) { oauthError(res, 'microsoft', e); }
});

// ── QQ OAuth ──
router.get('/qq', (req, res) => {
  const c = getCred('qq', req.query.inst);
  if (!c || !c.QQ_APP_ID) return res.redirect('/login.html?error=qq_not_configured');
  const state = genState();
  saveState(state, c._providerKey);
  const params = new URLSearchParams({ response_type: 'code', client_id: c.QQ_APP_ID, redirect_uri: `${process.env.BASE_URL}/auth/qq/callback`, scope: 'get_user_info', state });
  res.redirect(`https://graph.qq.com/oauth2.0/authorize?${params}`);
});
router.get('/qq/callback', async (req, res) => {
  const { code, state } = req.query;
  const st = consumeState(state);
  if (!st) return res.redirect('/login.html?error=invalid_state');
  const c = credFromKey(st.provider);
  if (!c) return res.redirect('/login.html?error=qq_not_configured');
  try {
    const tokRes = (await axios.get(`https://graph.qq.com/oauth2.0/token?grant_type=authorization_code&client_id=${c.QQ_APP_ID}&client_secret=${c.QQ_APP_SECRET}&code=${code}&redirect_uri=${encodeURIComponent(process.env.BASE_URL+'/auth/qq/callback')}`)).data;
    const access_token = new URLSearchParams(tokRes).get('access_token');
    const openidRes = (await axios.get(`https://graph.qq.com/oauth2.0/me?access_token=${access_token}`)).data;
    const openId = openidRes.match(/"openid"\s*:\s*"([^"]+)"/)?.[1];
    const info = (await axios.get(`https://graph.qq.com/user/get_user_info?access_token=${access_token}&oauth_consumer_key=${c.QQ_APP_ID}&openid=${openId}`)).data;
    loginSuccess(res, findOrCreate({ provider: c._providerKey, openId, name: info.nickname, avatar: info.figureurl_qq_2 }));
  } catch (e) { oauthError(res, 'qq', e); }
});

// ── CSDN OAuth（暂不支持标准 OAuth，预留入口）──
router.get('/csdn', (req, res) => {
  res.redirect('/login.html?error=csdn_not_configured');
});

module.exports = router;
