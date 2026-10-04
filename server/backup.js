// 数据备份（v3.5.46）：SQLite 在线快照 → gzip →（可选）加密 → 存到各个备份目标
//
//   目标类型：local（服务器本地目录）/ r2（Cloudflare R2，S3 兼容，SigV4 签名，不引 SDK）
//   可添加多个目标、同时开启；每个目标有自己的备份频率（小时）与保留份数。
//   一次运行只做一份快照，发给本次到期的所有目标。
//
// ⚠️ 备份里包含全部数据（含系统配置里的各种密钥），只有超级管理员能管理；存到外部存储桶时建议设置加密口令。
// 加密格式：'QWQBK1'(6) + salt(16) + iv(12) + tag(16) + AES-256-GCM 密文；密钥 = scrypt(口令, salt, 32)
// 解密：node server/backup.js decrypt <输入文件> <输出文件> <口令>   （输出是 .db.gz，再 gunzip 得到 sso.db）
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const MAGIC = Buffer.from('QWQBK1');
const FILE_RE = /^qwq-sso-\d{8}-\d{6}\.db\.gz(\.enc)?$/;

function encrypt(buf, passphrase) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(String(passphrase), salt, 32);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, c.getAuthTag(), enc]);
}
function decrypt(buf, passphrase) {
  if (!buf.subarray(0, 6).equals(MAGIC)) throw new Error('不是 QWQ SSO 加密备份');
  const salt = buf.subarray(6, 22), iv = buf.subarray(22, 34), tag = buf.subarray(34, 50);
  const key = crypto.scryptSync(String(passphrase), salt, 32);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.subarray(50)), d.final()]);
}

// ── SigV4（S3 / R2）──
const sha256hex = b => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const enc3986 = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
function sigv4({ method, url, headers = {}, body = '', accessKey, secretKey, region = 'auto', service = 's3', now = new Date() }) {
  const u = new URL(url);
  const amzdate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzdate.slice(0, 8);
  const payloadHash = sha256hex(body || '');
  const h = { ...headers, host: u.host, 'x-amz-date': amzdate, 'x-amz-content-sha256': payloadHash };
  const lower = {};
  for (const [k, v] of Object.entries(h)) lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  const signed = Object.keys(lower).sort();
  const canonHeaders = signed.map(k => `${k}:${lower[k]}\n`).join('');
  const canonQuery = [...u.searchParams.entries()].map(([k, v]) => [enc3986(k), enc3986(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonPath = u.pathname.split('/').map(seg => enc3986(decodeURIComponent(seg))).join('/');
  const creq = [method, canonPath, canonQuery, canonHeaders, signed.join(';'), payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const sts = ['AWS4-HMAC-SHA256', amzdate, scope, sha256hex(creq)].join('\n');
  const kSign = hmac(hmac(hmac(hmac('AWS4' + secretKey, date), region), service), 'aws4_request');
  const sig = crypto.createHmac('sha256', kSign).update(sts).digest('hex');
  return { ...h, Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signed.join(';')}, Signature=${sig}` };
}

function r2Base(cfg) {
  const ep = String(cfg.endpoint || '').trim().replace(/\/+$/, '') || `https://${cfg.account_id}.r2.cloudflarestorage.com`;
  return `${ep}/${encodeURIComponent(cfg.bucket)}`;
}
const r2Prefix = cfg => { const p = String(cfg.prefix || '').trim().replace(/^\/+|\/+$/g, ''); return p ? p + '/' : ''; };
async function r2Request(cfg, method, key, { body, query } = {}) {
  const url = new URL(r2Base(cfg) + (key ? '/' + key.split('/').map(encodeURIComponent).join('/') : ''));
  Object.entries(query || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const headers = sigv4({ method, url: url.toString(), body: body || '', accessKey: cfg.access_key_id, secretKey: cfg.secret_access_key,
    headers: body ? { 'content-type': 'application/octet-stream' } : {} });
  delete headers.host;   // fetch 自己会带 Host
  const r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(120000) });
  const text = await r.text();
  if (!r.ok) {
    const code = (text.match(/<Code>([^<]+)<\/Code>/) || [])[1];
    const msg = (text.match(/<Message>([^<]+)<\/Message>/) || [])[1];
    throw new Error(`R2 ${method} 失败：HTTP ${r.status}${code ? ' ' + code : ''}${msg ? '（' + msg + '）' : ''}`);
  }
  return text;
}
async function r2List(cfg) {
  const out = [];
  let token = '';
  for (let i = 0; i < 20; i++) {
    const q = { 'list-type': '2', prefix: r2Prefix(cfg) };
    if (token) q['continuation-token'] = token;
    const xml = await r2Request(cfg, 'GET', '', { query: q });
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const k = (m[1].match(/<Key>([^<]+)<\/Key>/) || [])[1];
      const size = Number((m[1].match(/<Size>(\d+)<\/Size>/) || [])[1] || 0);
      const lm = (m[1].match(/<LastModified>([^<]+)<\/LastModified>/) || [])[1];
      if (k && FILE_RE.test(k.slice(r2Prefix(cfg).length))) out.push({ name: k.slice(r2Prefix(cfg).length), key: k, size, modified: lm });
    }
    token = (xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/) || [])[1];
    if (!token) break;
  }
  return out.sort((a, b) => (a.name < b.name ? 1 : -1));
}

// ── 本地目录 ──
function localDir(cfg, dataDir) {
  const d = String(cfg.dir || '').trim();
  return d ? (path.isAbsolute(d) ? d : path.join(dataDir, d)) : path.join(dataDir, 'backups');
}
function localList(cfg, dataDir) {
  const dir = localDir(cfg, dataDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(n => FILE_RE.test(n)).map(n => {
    const st = fs.statSync(path.join(dir, n));
    return { name: n, size: st.size, modified: st.mtime.toISOString() };
  }).sort((a, b) => (a.name < b.name ? 1 : -1));
}

// 一份快照（gzip 后的 Buffer）
async function snapshot(db, dataDir) {
  const tmp = path.join(dataDir, `.backup-${process.pid}-${Date.now()}.db`);
  try {
    await db.backup(tmp);
    return zlib.gzipSync(fs.readFileSync(tmp), { level: 6 });
  } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

// 把一份快照写到一个目标，并按保留份数清理旧的
async function writeTo(target, cfg, gz, dataDir, name) {
  const data = cfg.passphrase ? encrypt(gz, cfg.passphrase) : gz;
  const file = name + (cfg.passphrase ? '.enc' : '');
  let removed = 0;
  if (target.type === 'local') {
    const dir = localDir(cfg, dataDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), data, { mode: 0o600 });
    if (target.keep > 0) for (const f of localList(cfg, dataDir).slice(target.keep)) { fs.unlinkSync(path.join(dir, f.name)); removed++; }
  } else if (target.type === 'r2') {
    await r2Request(cfg, 'PUT', r2Prefix(cfg) + file, { body: data });
    if (target.keep > 0) for (const f of (await r2List(cfg)).slice(target.keep)) { await r2Request(cfg, 'DELETE', f.key); removed++; }
  } else throw new Error('未知的备份目标类型');
  return { file, size: data.length, encrypted: !!cfg.passphrase, removed };
}

async function list(target, cfg, dataDir) {
  return target.type === 'local' ? localList(cfg, dataDir) : r2List(cfg);
}
// 读取一份备份（本地直接读；R2 下载）——下载给管理员
async function read(target, cfg, dataDir, name) {
  if (!FILE_RE.test(name)) throw new Error('文件名不对');
  if (target.type === 'local') return fs.readFileSync(path.join(localDir(cfg, dataDir), name));
  const url = new URL(r2Base(cfg) + '/' + (r2Prefix(cfg) + name).split('/').map(encodeURIComponent).join('/'));
  const headers = sigv4({ method: 'GET', url: url.toString(), accessKey: cfg.access_key_id, secretKey: cfg.secret_access_key });
  delete headers.host;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error('R2 下载失败：HTTP ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

module.exports = { encrypt, decrypt, sigv4, snapshot, writeTo, list, read, stamp, localDir, FILE_RE };

// 命令行：解密备份
if (require.main === module) {
  const [cmd, inFile, outFile, pass] = process.argv.slice(2);
  if (cmd !== 'decrypt' || !inFile || !outFile || !pass) {
    console.log('用法：node server/backup.js decrypt <qwq-sso-xxx.db.gz.enc> <输出.db.gz> <口令>\n然后：gunzip 输出.db.gz → 得到 SQLite 数据库文件');
    process.exit(1);
  }
  fs.writeFileSync(outFile, decrypt(fs.readFileSync(inFile), pass));
  console.log('已解密 →', outFile);
}
