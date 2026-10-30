// v3.5.107 OIDC RS256 签名密钥（oidc-keys.js）单测：用 node:sqlite 内存库替身 ./db，
// 验证生成 / 复用 / 轮换 / JWKS / 按应用选择算法，并用 JWKS 公钥验签。
// 运行：node scratchpad/oidc-rs256-test.js（需已 npm install，用到 jsonwebtoken）
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const { DatabaseSync } = require('node:sqlite');

const mem = new DatabaseSync(':memory:');
const keysPath = path.join(__dirname, '..', 'server', 'oidc-keys.js');
const dbResolved = Module._resolveFilename('../server/db.js', { id: keysPath, filename: keysPath, paths: Module._nodeModulePaths(path.dirname(keysPath)) });
require.cache[dbResolved] = { id: dbResolved, filename: dbResolved, loaded: true, exports: { db: mem } };
delete process.env.OIDC_RSA_PRIVATE_KEY;
const K = require('../server/oidc-keys');
const jwt = require('jsonwebtoken');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };
const pubOf = (jwk) => crypto.createPublicKey({ key: jwk, format: 'jwk' });

// 首次用到即生成，之后复用同一把
const k1 = K.activeKey();
ok(/^[0-9a-f]{16}$/.test(k1.kid), 'kid 为 16 位十六进制');
ok(K.activeKey().kid === k1.kid, '复用同一把钥');
let set = K.jwks();
ok(set.keys.length === 1 && set.keys[0].kid === k1.kid && set.keys[0].alg === 'RS256' && set.keys[0].use === 'sig' && !set.keys[0].d, 'JWKS 只含公钥');

// 按应用选择算法：RS256 用平台私钥 + kid，可用 JWKS 公钥验；HS256 仍用 client_secret
const rsApp = { client_id: 'app_rs', client_secret: 's1', id_token_alg: 'RS256' };
const hsApp = { client_id: 'app_hs', client_secret: 's2', id_token_alg: 'HS256' };
const legacy = { client_id: 'app_old', client_secret: 's3' };
const payload = { sub: 'u1', aud: 'app_rs', iss: 'https://sso.example.com' };
const t1 = K.signForApp(payload, rsApp);
const h1 = JSON.parse(Buffer.from(t1.split('.')[0], 'base64url'));
ok(h1.alg === 'RS256' && h1.kid === k1.kid, 'RS256 头带 kid');
ok(jwt.verify(t1, pubOf(set.keys[0]), { algorithms: ['RS256'] }).sub === 'u1', 'JWKS 公钥验签通过');
let refused = false; try { jwt.verify(t1, 's1', { algorithms: ['HS256'] }); } catch (_) { refused = true; }
ok(refused, 'RS256 令牌不能当 HS256 用 client_secret 验');
const t2 = K.signForApp({ sub: 'u2' }, hsApp);
ok(JSON.parse(Buffer.from(t2.split('.')[0], 'base64url')).alg === 'HS256' && jwt.verify(t2, 's2').sub === 'u2', 'HS256 应用照旧用 client_secret');
ok(K.algFor(legacy) === 'HS256' && K.algFor({ id_token_alg: 'none' }) === 'HS256' && K.algFor({ id_token_alg: 'rs256' }) === 'RS256', '未设 / 非法值回落 HS256');

// 轮换：新钥签名，旧公钥仍在 JWKS（旧令牌照样能验）
const k2kid = K.rotate();
ok(k2kid !== k1.kid && K.activeKey().kid === k2kid, '轮换后用新钥');
set = K.jwks();
ok(set.keys.length === 2 && set.keys.some(k => k.kid === k1.kid), '退役的公钥仍在 JWKS');
const oldJwk = set.keys.find(k => k.kid === k1.kid);
ok(jwt.verify(t1, pubOf(oldJwk), { algorithms: ['RS256'] }).sub === 'u1', '轮换前的令牌仍可验');
// 退役超过保留期的公钥不再公开
mem.prepare("UPDATE oidc_signing_keys SET retired_at=datetime('now','-8 days') WHERE kid=?").run(k1.kid);
ok(K.jwks().keys.every(k => k.kid !== k1.kid), '退役超过 7 天的公钥移出 JWKS');

// 环境变量钥优先，且不允许经接口轮换
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
process.env.OIDC_RSA_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n');
const ek = K.activeKey();
ok(ek.env && ek.kid === K.kidOf(privateKey.export({ type: 'pkcs8', format: 'pem' })), '环境变量钥优先（支持 \\n 转义）');
ok(K.jwks().keys[0].kid === ek.kid, 'JWKS 首个为环境变量钥');
let threw = false; try { K.rotate(); } catch (_) { threw = true; }
ok(threw, '环境变量钥不能经接口轮换');
process.env.OIDC_RSA_PRIVATE_KEY = 'not a pem';
ok(K.activeKey().kid === k2kid, '环境变量钥无法解析时回落库里的钥');

console.log(`oidc-rs256: ${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
