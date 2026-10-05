// 批量导入多手机/多邮箱单测（v3.5.66）：复刻 importOrgMembers 的多值逻辑 + 真实 addContact（node:sqlite），
// 验证：第一个有效手机/邮箱做主字段，全部手机/邮箱进 user_contacts（去重、按组织上限），已有用户按任一标识命中。
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(':memory:');
db.exec(`
CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT, phone TEXT, is_public INTEGER DEFAULT 0, uid_seq INTEGER);
CREATE TABLE user_contacts (id TEXT PRIMARY KEY, user_id TEXT, kind TEXT, value TEXT, source TEXT, is_primary INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
CREATE UNIQUE INDEX idx_uc ON user_contacts(user_id, kind, value);
CREATE TABLE org_members (subject_id TEXT, user_id TEXT, org_uid TEXT, source TEXT);
`);

const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim());
const isPhone = v => /^1[3-9]\d{9}$/.test(String(v).trim());

// 真实 addContact（与 server/contacts.js 同逻辑的最小版：去重 + 按组织上限）
let cN = 0;
const LIMITS = { maxPhones: 10, maxEmails: 20 };
function addContact(userId, kind, value, source) {
  const val = kind === 'phone' ? (isPhone(value) ? String(value).trim() : null) : (isEmail(value) ? String(value).trim().toLowerCase() : null);
  if (!val) return { ok: false, skip: 'bad' };
  if (db.prepare('SELECT 1 FROM user_contacts WHERE user_id=? AND kind=? AND value=?').get(userId, kind, val)) return { ok: false, skip: 'dup' };
  const cap = kind === 'phone' ? LIMITS.maxPhones : LIMITS.maxEmails;
  const n = db.prepare('SELECT COUNT(*) n FROM user_contacts WHERE user_id=? AND kind=?').get(userId, kind).n;
  if (n >= cap) return { ok: false, skip: 'limit' };
  db.prepare('INSERT OR IGNORE INTO user_contacts (id,user_id,kind,value,source,is_primary) VALUES (?,?,?,?,?,0)').run('c' + (++cN), userId, kind, val, source);
  return { ok: true };
}
const contactUtil = { addContact };

let uN = 0;
const users = {
  findByEmail: { get: (e) => db.prepare('SELECT * FROM users WHERE email=?').get(e) },
  findByPhone: { get: (p) => db.prepare('SELECT * FROM users WHERE phone=?').get(p) },
  create: (o) => { const id = 'u' + (++uN); const seq = 100 + uN; db.prepare('INSERT INTO users (id,name,email,phone,uid_seq) VALUES (?,?,?,?,?)').run(id, o.name || null, o.email || null, o.phone || null, seq); return db.prepare('SELECT * FROM users WHERE id=?').get(id); },
};
const orgMembers = {
  get: { get: (s, u) => db.prepare('SELECT * FROM org_members WHERE subject_id=? AND user_id=?').get(s, u) },
  add: { run: (s, u, uid, src) => db.prepare('INSERT INTO org_members (subject_id,user_id,org_uid,source) VALUES (?,?,?,?)').run(s, u, uid, src) },
  setOrgUid: { run: (uid, s, u) => db.prepare('UPDATE org_members SET org_uid=? WHERE subject_id=? AND user_id=?').run(uid, s, u) },
  orgUidTaken: { get: (s, uid, u) => db.prepare('SELECT 1 FROM org_members WHERE subject_id=? AND org_uid=? AND user_id<>?').get(s, uid, u) },
  listBySubject: { all: (s) => db.prepare('SELECT * FROM org_members WHERE subject_id=?').all(s) },
  remove: { run: (s, u) => db.prepare('DELETE FROM org_members WHERE subject_id=? AND user_id=?').run(s, u) },
};
const genOrgUid = () => null;

// ===== 复刻 importOrgMembers（与 api.js 实现保持一致）=====
function importOrgMembers(subject, rows, opts = {}) {
  const results = []; const seen = new Set();
  for (const raw of (Array.isArray(rows) ? rows : [])) {
    const emailsIn = [raw?.email, ...(Array.isArray(raw?.emails) ? raw.emails : [])].map(x => String(x || '').trim()).filter(Boolean);
    const phonesIn = [raw?.phone, ...(Array.isArray(raw?.phones) ? raw.phones : [])].map(x => String(x || '').trim()).filter(Boolean);
    const goodEmails = [...new Set(emailsIn.map(e => e.toLowerCase()).filter(isEmail))];
    const goodPhones = [...new Set(phonesIn.filter(isPhone))];
    const email = goodEmails[0] || ''; const phone = goodPhones[0] || '';
    const name = String(raw?.name || '').trim();
    let orgUid = String(raw?.org_uid || '').trim() || null;
    if (emailsIn.length && !goodEmails.length) { results.push({ email: emailsIn[0], status: 'error', error: '邮箱格式不正确' }); continue; }
    if (phonesIn.length && !goodPhones.length) { results.push({ phone: phonesIn[0], status: 'error', error: '手机号格式不正确' }); continue; }
    if (!email && !phone) { results.push({ status: 'error', error: '缺少 email 或 phone' }); continue; }
    let user = (email && users.findByEmail.get(email)) || (phone && users.findByPhone.get(phone)) || null;
    if (!user) { for (const e of goodEmails) { user = users.findByEmail.get(e); if (user) break; } }
    if (!user) { for (const p of goodPhones) { user = users.findByPhone.get(p); if (user) break; } }
    if (user && user.is_public) { results.push({ email, phone, status: 'error', error: '命中公共账号，跳过' }); continue; }
    let created = false;
    if (!user) { user = users.create({ name: name || (email ? email.split('@')[0] : '用户' + phone.slice(-4)), email: email || null, phone: phone || null }); created = true; }
    for (const e of goodEmails) { try { contactUtil.addContact(user.id, 'email', e, 'import', subject.id); } catch (_) {} }
    for (const p of goodPhones) { try { contactUtil.addContact(user.id, 'phone', p, 'import', subject.id); } catch (_) {} }
    seen.add(user.id);
    if (orgUid && orgMembers.orgUidTaken.get(subject.id, orgUid, user.id)) { results.push({ email, phone, uid: user.uid_seq, status: 'error', error: '组织内 UID 冲突' }); continue; }
    const existing = orgMembers.get.get(subject.id, user.id);
    if (!existing) { if (!orgUid && subject.uid_prefix) orgUid = genOrgUid(subject); orgMembers.add.run(subject.id, user.id, orgUid, 'import'); }
    else if (orgUid) orgMembers.setOrgUid.run(orgUid, subject.id, user.id);
    results.push({ email, phone, uid: user.uid_seq, org_uid: orgUid || existing?.org_uid || null, contacts: goodEmails.length + goodPhones.length, status: created ? 'created' : (existing ? 'updated' : 'added') });
  }
  let removed = 0;
  if (opts.removeMissing) for (const m of orgMembers.listBySubject.all(subject.id)) if (m.source === 'import' && !seen.has(m.user_id)) { orgMembers.remove.run(subject.id, m.user_id); removed++; }
  return { total: results.length, ok: results.filter(r => r.status !== 'error').length, removed, results };
}

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗'} ${n}`); };
const subject = { id: 'org1', uid_prefix: '' };
const cOf = (uid, kind) => db.prepare('SELECT value FROM user_contacts WHERE user_id=? AND kind=? ORDER BY value').all(uid, kind).map(r => r.value);

// 1. 多值行：第一个做主，全部进 user_contacts
let r1 = importOrgMembers(subject, [{ phones: ['13800000001', '13800000002'], emails: ['a@x.com', 'a@corp.com'], name: 'MilkSU' }]);
const u1 = db.prepare("SELECT * FROM users WHERE name='MilkSU'").get();
ok('主手机=第一个', u1.phone === '13800000001');
ok('主邮箱=第一个', u1.email === 'a@x.com');
ok('两个手机都进多联系方式', cOf(u1.id, 'phone').length === 2);
ok('两个邮箱都进多联系方式', cOf(u1.id, 'email').length === 2);
ok('结果 contacts 计数=4', r1.results[0].contacts === 4);

// 2. 去重：同一行里重复值只记一次（用全新标识避免命中上一条）
importOrgMembers(subject, [{ phones: ['13800000055', '13800000055'], emails: ['dup@x.com', 'DUP@X.COM'], name: 'DupCase' }]);
const u2 = db.prepare("SELECT * FROM users WHERE name='DupCase'").get();
ok('重复手机只记一次', cOf(u2.id, 'phone').length === 1);
ok('同邮箱大小写归一后只记一次', cOf(u2.id, 'email').length === 1 && cOf(u2.id, 'email')[0] === 'dup@x.com');

// 3. 已有用户按「数组里任一标识」命中（主字段是另一个）
const r3 = importOrgMembers(subject, [{ emails: ['b@x.com'], name: '老王' }]);
const ub = db.prepare("SELECT * FROM users WHERE name='老王'").get();
const r3b = importOrgMembers(subject, [{ phones: ['13900000009'], emails: ['new@x.com', 'b@x.com'], name: '老王改' }]);
ok('按数组里的旧邮箱命中同一人（不新建）', r3b.results[0].status === 'updated' || r3b.results[0].uid === ub.uid_seq);

// 4. 非法值报错
const r4 = importOrgMembers(subject, [{ phones: ['123'], name: '坏手机' }]);
ok('全非法手机 → error', r4.results[0].status === 'error');
const r5 = importOrgMembers(subject, [{ name: '没联系方式' }]);
ok('无 email/phone → error', r5.results[0].status === 'error');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
