/**
 * Passkey（WebAuthn / FIDO2）—— 无密码登录 + 账号内绑定
 *
 * 密码学验证全部交给成熟库 @simplewebauthn/server，本文件只负责：
 *   - 生成注册/认证 options（把 challenge 存进 session）
 *   - 调库校验浏览器返回的 attestation/assertion
 *   - 凭据的存取（webauthn_credentials 表）与登录发 token
 *
 * RP ID / origin 从 BASE_URL（或请求 Host）推导，必须与实际访问的域名一致，
 * 否则浏览器会拒绝。WebAuthn 要求 HTTPS（localhost 例外）。
 */
const express = require('express');
const { randomUUID } = require('crypto');
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { users, webauthn } = require('./db');
const { signToken, requireAuth } = require('./auth');

const router = express.Router();

// RP ID / origin 必须与浏览器实际所在的域名一致，否则 navigator.credentials 会拒绝
// （常见坑：写死 BASE_URL，但用户用别的域名访问；或反代下 req.protocol 变 http）。
// 因此优先从「本次请求」推导：X-Forwarded-Host / Host + X-Forwarded-Proto。
function rpConfig(req) {
  const fwdHost  = (req.get('x-forwarded-host') || '').split(',')[0].trim();
  const host     = (fwdHost || req.get('host') || '').split(',')[0].trim();
  const fwdProto = (req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const proto    = fwdProto || req.protocol || 'https';

  let rpID, origin;
  if (host) {
    rpID   = host.split(':')[0];                 // 去掉端口
    origin = `${proto}://${host}`;
  } else {
    // 兜底：BASE_URL
    const base = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
    try { rpID = new URL(base).hostname; origin = new URL(base).origin; }
    catch (_) { rpID = 'localhost'; origin = base; }
  }
  return { rpID: rpID || 'localhost', origin, rpName: process.env.TWOFA_ISSUER || 'QWQ SSO' };
}

const b64 = buf => Buffer.from(buf).toString('base64');
const fromB64 = s => new Uint8Array(Buffer.from(s, 'base64'));

// 把库返回的凭据转成 verifyAuthenticationResponse 需要的形状
function toLibCredential(row) {
  return {
    id: row.cred_id,                       // base64url 字符串
    publicKey: fromB64(row.public_key),    // Uint8Array
    counter: row.counter,
    transports: row.transports ? JSON.parse(row.transports) : undefined,
  };
}

// ── 注册（绑定 Passkey，需登录）──
// 公共账号不允许自行设置 Passkey（登录方式仅管理员可设定）
function blockPublic(req, res, next) {
  const u = users.findById.get(req.user.uid);
  if (u && u.is_public) return res.status(403).json({ error: '公共账号不支持设置 Passkey' });
  next();
}

router.post('/register-options', requireAuth, blockPublic, async (req, res) => {
  const user = users.findById.get(req.user.uid);
  if (!user) return res.status(401).json({ error: '用户不存在' });
  const { rpID, rpName } = rpConfig(req);
  const existing = webauthn.listByUser.all(user.id);

  const options = await generateRegistrationOptions({
    rpName, rpID,
    userName: user.email || user.phone || user.name || ('uid' + user.uid_seq),
    userDisplayName: user.name || '',
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    excludeCredentials: existing.map(c => ({ id: c.cred_id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  req.session.passkeyReg = { challenge: options.challenge, uid: user.id };
  res.json(options);
});

router.post('/register-verify', requireAuth, blockPublic, async (req, res) => {
  const sess = req.session.passkeyReg;
  if (!sess || sess.uid !== req.user.uid) return res.status(400).json({ error: '注册会话已过期，请重试' });
  const { rpID, origin } = rpConfig(req);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: req.body.credential,
      expectedChallenge: sess.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });
  } catch (e) { return res.status(400).json({ error: 'Passkey 校验失败：' + e.message }); }
  delete req.session.passkeyReg;
  if (!verification.verified || !verification.registrationInfo) return res.status(400).json({ error: 'Passkey 校验未通过' });

  const cred = verification.registrationInfo.credential;
  if (webauthn.findByCredId.get(cred.id)) return res.status(400).json({ error: '该 Passkey 已绑定' });
  webauthn.insert.run({
    id: randomUUID(), user_id: req.user.uid, cred_id: cred.id,
    public_key: b64(cred.publicKey), counter: cred.counter || 0,
    transports: cred.transports ? JSON.stringify(cred.transports) : null,
    name: (req.body.name || '').slice(0, 40) || '我的 Passkey',
  });
  res.json({ success: true });
});

// ── 登录（无密码，无需先登录）──
router.post('/login-options', async (req, res) => {
  const { rpID } = rpConfig(req);
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
  req.session.passkeyAuth = { challenge: options.challenge };
  res.json(options);
});

router.post('/login-verify', async (req, res) => {
  const sess = req.session.passkeyAuth;
  if (!sess) return res.status(400).json({ error: '登录会话已过期，请重试' });
  const resp = req.body.credential;
  if (!resp || !resp.id) return res.status(400).json({ error: '无效的 Passkey 响应' });

  const row = webauthn.findByCredId.get(resp.id);
  if (!row) return res.status(401).json({ error: '该 Passkey 未在任何账号注册' });
  const user = users.findById.get(row.user_id);
  if (!user) return res.status(401).json({ error: '账号不存在' });
  if (user.status === 'disabled') return res.status(403).json({ error: '账号已停用，请联系管理员' });

  const { rpID, origin } = rpConfig(req);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: resp,
      expectedChallenge: sess.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: toLibCredential(row),
    });
  } catch (e) { return res.status(400).json({ error: 'Passkey 校验失败：' + e.message }); }
  delete req.session.passkeyAuth;
  if (!verification.verified) return res.status(401).json({ error: 'Passkey 校验未通过' });

  // 更新签名计数器（防重放）
  webauthn.updateCounter.run(verification.authenticationInfo.newCounter, row.id);

  // Passkey 本身即强认证（用户已通过设备验证），直接发正式 token，不再走 2FA
  try {
    const { logs } = require('./db');
    logs.insert.run({ id: randomUUID(), user_id: user.id, user_name: user.name, uid_seq: String(user.uid_seq),
      method: 'Passkey', app_name: '本系统', ip: null, user_agent: req.headers['user-agent'] || null, status: 'success', fail_reason: null });
  } catch (_) {}
  const token = signToken({ uid: user.id, name: user.name, role: user.role, adminLevel: user.admin_level });
  const { password_hash, twofa_secret, ...safe } = user;
  res.json({ success: true, token, user: safe });
});

// ── 管理自己的 Passkey ──
router.get('/list', requireAuth, (req, res) => {
  const list = webauthn.listByUser.all(req.user.uid).map(c => ({
    id: c.id, name: c.name, created_at: c.created_at, last_used_at: c.last_used_at,
  }));
  res.json({ success: true, passkeys: list });
});
router.post('/:id/rename', requireAuth, (req, res) => {
  webauthn.rename.run((req.body.name || '').slice(0, 40) || '我的 Passkey', req.params.id, req.user.uid);
  res.json({ success: true });
});
router.delete('/:id', requireAuth, (req, res) => {
  webauthn.remove.run(req.params.id, req.user.uid);
  res.json({ success: true });
});

module.exports = router;
