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

// ── ZIP（导出用，标准 .zip，任何解压工具可开；无第三方依赖）──
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
let _crcTable;
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;   // Node ≥20.15 原生
  if (!_crcTable) { _crcTable = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); _crcTable[n] = c >>> 0; } }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = _crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
// entries: [{name, data(Buffer)}] → 一个 .zip Buffer（deflate 压缩、UTF-8 文件名）
function zipWrite(entries) {
  const parts = [], central = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const comp = zlib.deflateRawSync(e.data, { level: 6 });
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(e.data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}
// 读 .zip → { 文件名: Buffer }（只认 store/deflate）
function zipRead(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65536; i--) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('不是有效的 ZIP 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lhNameLen = buf.readUInt16LE(lho + 26), lhExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lhNameLen + lhExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);
    out[name] = method === 0 ? Buffer.from(comp) : zlib.inflateRawSync(comp);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
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

// ── 阿里云 OSS（兼容 S3 之外的对象存储，签名 V1 / HMAC-SHA1，不引 SDK）──
//   config: {region 或 endpoint, bucket, access_key_id, access_key_secret, prefix}
//   region 形如 oss-cn-hangzhou（会拼成 <region>.aliyuncs.com）；也可直接填 endpoint 主机名。
function ossHost(cfg) {
  let ep = String(cfg.endpoint || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!ep) ep = `${String(cfg.region || '').trim()}.aliyuncs.com`;
  return ep;
}
const ossPrefix = cfg => { const p = String(cfg.prefix || '').trim().replace(/^\/+|\/+$/g, ''); return p ? p + '/' : ''; };
function ossSign(cfg, method, key, { contentType = '', date, contentMd5 = '' }) {
  // StringToSign = VERB\nContent-MD5\nContent-Type\nDate\nCanonicalizedOSSHeaders(空)+CanonicalizedResource
  const resource = '/' + cfg.bucket + '/' + (key || '');
  const sts = [method, contentMd5, contentType, date, resource].join('\n');
  const sig = crypto.createHmac('sha1', String(cfg.access_key_secret)).update(sts).digest('base64');
  return `OSS ${cfg.access_key_id}:${sig}`;
}
async function ossRequest(cfg, method, key, { body, query } = {}) {
  const host = ossHost(cfg);
  const url = new URL(`https://${cfg.bucket}.${host}/` + (key ? key.split('/').map(encodeURIComponent).join('/') : ''));
  Object.entries(query || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const date = new Date().toUTCString();
  const contentType = body ? 'application/octet-stream' : '';
  const headers = { Date: date, Authorization: ossSign(cfg, method, key, { contentType, date }) };
  if (body) headers['Content-Type'] = contentType;
  const r = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(120000) });
  const buf = Buffer.from(await r.arrayBuffer());
  if (!r.ok) {
    const text = buf.toString('utf8');
    const code = (text.match(/<Code>([^<]+)<\/Code>/) || [])[1];
    const msg = (text.match(/<Message>([^<]+)<\/Message>/) || [])[1];
    throw new Error(`OSS ${method} 失败：HTTP ${r.status}${code ? ' ' + code : ''}${msg ? '（' + msg + '）' : ''}`);
  }
  return buf;
}
async function ossList(cfg) {
  const out = [];
  let marker = '';
  for (let i = 0; i < 20; i++) {
    const q = { prefix: ossPrefix(cfg), 'max-keys': '1000' };
    if (marker) q.marker = marker;
    const xml = (await ossRequest(cfg, 'GET', '', { query: q })).toString('utf8');
    let lastKey = '';
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const k = (m[1].match(/<Key>([^<]+)<\/Key>/) || [])[1];
      const size = Number((m[1].match(/<Size>(\d+)<\/Size>/) || [])[1] || 0);
      const lm = (m[1].match(/<LastModified>([^<]+)<\/LastModified>/) || [])[1];
      if (!k) continue;
      lastKey = k;
      if (FILE_RE.test(k.slice(ossPrefix(cfg).length))) out.push({ name: k.slice(ossPrefix(cfg).length), key: k, size, modified: lm });
    }
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
    marker = (xml.match(/<NextMarker>([^<]+)<\/NextMarker>/) || [])[1] || lastKey;
    if (!truncated || !marker) break;
  }
  return out.sort((a, b) => (a.name < b.name ? 1 : -1));
}

// ── 恢复（导入全站数据）相关 ──
const README_TXT = [
  'QWQ SSO 全站数据导出',
  '',
  '这是一份 QWQ SSO 的完整数据导出（整个数据库）。',
  '- sso.db       明文数据库（未加密导出时）',
  '- sso.db.enc   加密数据库（导出时填了口令；AES-256-GCM）',
  '- MANIFEST.json 导出信息（版本、时间、各表数量、是否加密）',
  '',
  '恢复：在管理端「数据备份 / 导出 · 导入」或安装向导页上传本 .zip 文件即可，',
  '系统会校验后用它覆盖全站数据并重启。加密导出需填当初的口令。',
  '也可命令行解密单独的 sso.db.enc：node server/backup.js decrypt sso.db.enc sso.db 口令',
].join('\n');

// 把一份导出/备份文件内容还原成 SQLite 库字节（支持 .zip 新格式 与 旧 .db.gz / .db.gz.enc）
function decodeBackup(buf, passphrase) {
  // 新格式：.zip（里面是 sso.db 或 sso.db.enc）
  if (buf.length >= 4 && buf.subarray(0, 4).equals(ZIP_MAGIC)) {
    const entries = zipRead(buf);
    let dbBytes;
    if (entries['sso.db.enc']) {
      if (!passphrase) { const e = new Error('这是加密导出，请提供解密口令'); e.needPass = true; throw e; }
      dbBytes = decrypt(entries['sso.db.enc'], passphrase);
    } else if (entries['sso.db']) {
      dbBytes = entries['sso.db'];
    } else throw new Error('ZIP 里找不到 sso.db（不是 QWQ SSO 的导出文件）');
    if (dbBytes.subarray(0, 15).toString('latin1') !== 'SQLite format 3') throw new Error('不是有效的 SQLite 备份文件');
    return dbBytes;
  }
  // 旧格式：.db.gz / .db.gz.enc（定时备份目标仍用它）
  let b = buf;
  if (b.length >= 6 && b.subarray(0, 6).equals(MAGIC)) {
    if (!passphrase) { const e = new Error('这是加密备份，请提供解密口令'); e.needPass = true; throw e; }
    b = decrypt(b, passphrase);
  }
  try { b = zlib.gunzipSync(b); }
  catch (_) { throw new Error('解压失败：文件可能已损坏，或是加密备份但没填对口令'); }
  if (b.subarray(0, 15).toString('latin1') !== 'SQLite format 3') throw new Error('不是有效的 SQLite 备份文件');
  return b;
}

// 生成一份 .zip 全站导出（含 sso.db[.enc] + MANIFEST.json + README.txt）
async function buildExportZip(db, dataDir, passphrase, meta = {}) {
  const tmp = path.join(dataDir, `.export-${process.pid}-${Date.now()}.db`);
  try {
    await db.backup(tmp);
    const raw = fs.readFileSync(tmp);
    let counts = {}; try { counts = inspectDbBuffer(raw, dataDir); } catch (_) {}
    const encrypted = !!passphrase;
    const manifest = { product: 'QWQ SSO', kind: 'full-export', version: meta.version || '',
      created_at: new Date().toISOString(), encrypted, db_file: encrypted ? 'sso.db.enc' : 'sso.db', counts };
    const entries = [
      { name: 'MANIFEST.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
      { name: 'README.txt', data: Buffer.from(README_TXT) },
      encrypted ? { name: 'sso.db.enc', data: encrypt(raw, passphrase) } : { name: 'sso.db', data: raw },
    ];
    return { buf: zipWrite(entries), name: `qwq-sso-${stamp()}.zip`, encrypted, counts };
  } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}
// 校验一份（已还原的）SQLite 库是否为本系统的合法备份，并返回概要（给管理员确认用）
function inspectDbBuffer(dbBuf, dataDir) {
  const Database = require('better-sqlite3');
  const tmp = path.join(dataDir, `.inspect-${process.pid}-${Date.now()}.db`);
  fs.writeFileSync(tmp, dbBuf);
  let ro;
  try {
    ro = new Database(tmp, { readonly: true, fileMustExist: true });
    const integ = ro.pragma('integrity_check', { simple: true });
    if (integ !== 'ok') throw new Error('数据库完整性校验未通过：' + integ);
    const has = n => { try { return !!ro.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(n); } catch (_) { return false; } };
    if (!has('users') || !has('env_config')) throw new Error('这不是 QWQ SSO 的数据库备份（缺少 users / env_config 表）');
    const cnt = n => { try { return ro.prepare(`SELECT COUNT(*) c FROM ${n}`).get().c; } catch (_) { return null; } };
    return { size: dbBuf.length, users: cnt('users'), apps: cnt('apps'), env_config: cnt('env_config'),
      oauth_providers: cnt('oauth_providers'), oauth_subjects: cnt('oauth_subjects') };
  } finally { try { ro && ro.close(); } catch (_) {} try { fs.unlinkSync(tmp); } catch (_) {} }
}
// 写「待恢复」文件：下次启动时 db.js 会在打开库之前用它替换现库
function stageRestore(dbFile, dbBuf) {
  const pending = dbFile + '.pending-restore';
  fs.writeFileSync(pending + '.tmp', dbBuf, { mode: 0o600 });
  fs.renameSync(pending + '.tmp', pending);   // 原子落地
  return pending;
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
  } else if (target.type === 'oss') {
    await ossRequest(cfg, 'PUT', ossPrefix(cfg) + file, { body: data });
    if (target.keep > 0) for (const f of (await ossList(cfg)).slice(target.keep)) { await ossRequest(cfg, 'DELETE', f.key); removed++; }
  } else throw new Error('未知的备份目标类型');
  return { file, size: data.length, encrypted: !!cfg.passphrase, removed };
}

async function list(target, cfg, dataDir) {
  if (target.type === 'local') return localList(cfg, dataDir);
  if (target.type === 'oss') return ossList(cfg);
  return r2List(cfg);
}
// 读取一份备份（本地直接读；R2 / OSS 下载）——下载给管理员 / 导入恢复
async function read(target, cfg, dataDir, name) {
  if (!FILE_RE.test(name)) throw new Error('文件名不对');
  if (target.type === 'local') return fs.readFileSync(path.join(localDir(cfg, dataDir), name));
  if (target.type === 'oss') return ossRequest(cfg, 'GET', ossPrefix(cfg) + name, {});
  const url = new URL(r2Base(cfg) + '/' + (r2Prefix(cfg) + name).split('/').map(encodeURIComponent).join('/'));
  const headers = sigv4({ method: 'GET', url: url.toString(), accessKey: cfg.access_key_id, secretKey: cfg.secret_access_key });
  delete headers.host;
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(120000) });
  if (!r.ok) throw new Error('R2 下载失败：HTTP ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

module.exports = { encrypt, decrypt, sigv4, snapshot, writeTo, list, read, stamp, localDir,
  ossHost, ossSign, decodeBackup, buildExportZip, inspectDbBuffer, stageRestore,
  zipWrite, zipRead, crc32, FILE_RE };

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
