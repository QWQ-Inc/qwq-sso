// OIDC 非对称签名密钥（v3.5.107）：id_token / logout_token 可按应用改用 RS256，
// 公钥经 JWKS（/oauth/jwks、/.well-known/jwks.json）公开，接入方（如 kube-apiserver 等
// 只认非对称签名的验证方）不必持有 client_secret 也能验签。默认仍是 HS256（client_secret），老应用不受影响。
//
// 密钥来源：环境变量 OIDC_RSA_PRIVATE_KEY（PEM，优先，便于多实例共用同一把）；没有则首次用到时生成
// 2048 位 RSA 存进 oidc_signing_keys 表。轮换：rotate() 生成新钥并让旧钥退役，退役的公钥在 JWKS 里再保留
// RETIRED_KEEP_DAYS 天，期间旧令牌仍能验签。
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { db } = require('./db');

const RETIRED_KEEP_DAYS = 7;

db.exec(`CREATE TABLE IF NOT EXISTS oidc_signing_keys (
  kid         TEXT PRIMARY KEY,
  private_pem TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  retired_at  TEXT
)`);

const stmts = {
  active:  db.prepare('SELECT * FROM oidc_signing_keys WHERE retired_at IS NULL ORDER BY created_at DESC LIMIT 1'),
  listPub: db.prepare("SELECT * FROM oidc_signing_keys WHERE retired_at IS NULL OR retired_at > datetime('now', ?) ORDER BY created_at DESC"),
  insert:  db.prepare('INSERT INTO oidc_signing_keys (kid, private_pem) VALUES (?, ?)'),
  retire:  db.prepare("UPDATE oidc_signing_keys SET retired_at=datetime('now') WHERE retired_at IS NULL AND kid<>?"),
};

// kid = 公钥 DER 的 SHA-256 前 16 个十六进制字符（同一把钥恒定）
function kidOf(privatePem) {
  const der = crypto.createPublicKey(privatePem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
}

function envKey() {
  const pem = String(process.env.OIDC_RSA_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
  if (!pem) return null;
  try { return { kid: kidOf(pem), private_pem: pem, env: true }; } catch (e) {
    console.warn('[OIDC] OIDC_RSA_PRIVATE_KEY 无法解析，改用库里的密钥：', e.message);
    return null;
  }
}

function generate() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const kid = kidOf(pem);
  stmts.insert.run(kid, pem);
  return { kid, private_pem: pem };
}

// 当前签名用的钥（没有就生成）
function activeKey() {
  return envKey() || stmts.active.get() || generate();
}

// 轮换：生成新钥，其余钥退役（公钥在 JWKS 里再留 RETIRED_KEEP_DAYS 天）。用了环境变量钥时不轮换。
function rotate() {
  if (envKey()) throw new Error('当前使用环境变量 OIDC_RSA_PRIVATE_KEY 的密钥，请更换该变量来轮换');
  const k = generate();
  stmts.retire.run(k.kid);
  return k.kid;
}

function toJwk(k) {
  const jwk = crypto.createPublicKey(k.private_pem).export({ format: 'jwk' });
  return { kty: jwk.kty, n: jwk.n, e: jwk.e, kid: k.kid, use: 'sig', alg: 'RS256' };
}

// JWKS：当前钥 + 退役不久的钥
function jwks() {
  const env = envKey();
  const rows = stmts.listPub.all(`-${RETIRED_KEEP_DAYS} days`);
  const keys = [];
  const seen = new Set();
  for (const k of [env, ...rows]) {
    if (!k || seen.has(k.kid)) continue;
    seen.add(k.kid);
    keys.push(toJwk(k));
  }
  if (!keys.length) keys.push(toJwk(activeKey()));
  return { keys };
}

// 应用选用的 id_token 签名算法（只认 RS256 / HS256，其他一律 HS256）
function algFor(app) {
  return String(app && app.id_token_alg || '').toUpperCase() === 'RS256' ? 'RS256' : 'HS256';
}

// 按应用的算法签发：RS256 用平台私钥 + kid，HS256 用应用的 client_secret（原行为）
function signForApp(payload, app) {
  if (algFor(app) === 'RS256') {
    const k = activeKey();
    return jwt.sign(payload, k.private_pem, { algorithm: 'RS256', keyid: k.kid });
  }
  return jwt.sign(payload, app.client_secret, { algorithm: 'HS256' });
}

module.exports = { activeKey, rotate, jwks, algFor, signForApp, kidOf, RETIRED_KEEP_DAYS };
