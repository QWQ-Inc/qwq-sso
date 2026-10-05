// syncWecom 联系方式灌入单测：stub ./contacts 做 spy，用 node:sqlite 建 syncWecom 需要的表，
// 注入 fetcher 返回两名成员（一个正常、一个 _idOnly），验证 importWecomContacts 只对正常成员调用且带对参数。
const path = require('path');
const Module = require('module');
const { DatabaseSync } = require('node:sqlite');

// ---- node:sqlite 兜一套 syncWecom 要用的表 ----
const sdb = new DatabaseSync(':memory:');
sdb.exec(`
CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT, phone TEXT, is_public INTEGER DEFAULT 0, deletion_state TEXT, updated_at TEXT);
CREATE TABLE user_oauth (id TEXT, user_id TEXT, provider TEXT, open_id TEXT, union_id TEXT);
CREATE TABLE oauth_providers (id TEXT, platform TEXT, label TEXT, config TEXT, folder_id TEXT, subject_id TEXT, sort_weight INTEGER DEFAULT 0, created_at TEXT);
CREATE TABLE org_folders (id TEXT PRIMARY KEY, name TEXT);
CREATE TABLE folder_cred_orgs (provider_id TEXT, subject_id TEXT);
CREATE TABLE oauth_subjects (id TEXT PRIMARY KEY, uid_prefix TEXT, max_phones INTEGER DEFAULT 0, max_emails INTEGER DEFAULT 0);
CREATE TABLE org_members (subject_id TEXT, user_id TEXT, org_uid TEXT, source TEXT, password_hash TEXT);
CREATE TABLE dir_sync_sources (id TEXT PRIMARY KEY, subject_id TEXT, parent_id TEXT, enabled INTEGER DEFAULT 1, type TEXT);
CREATE TABLE dir_source_links (source_id TEXT, ext_id TEXT, user_id TEXT, depts TEXT, ext_name TEXT, ext_union TEXT, updated_at TEXT, PRIMARY KEY(source_id,ext_id));
CREATE TABLE dir_sync_applied (source_id TEXT, user_id TEXT, kind TEXT, key TEXT, value TEXT, updated_at TEXT, PRIMARY KEY(source_id,user_id,kind,key));
CREATE TABLE identity_blocks (kind TEXT, conn_id TEXT, ext_id TEXT);
INSERT INTO oauth_subjects (id,uid_prefix) VALUES ('sub1','');
INSERT INTO dir_sync_sources (id,subject_id,type) VALUES ('src1','sub1','wecom');
`);

let uidN = 0;
const usersCreate = (o) => { const id = 'u' + (++uidN); sdb.prepare('INSERT INTO users (id,name,email,phone) VALUES (?,?,?,?)').run(id, o.name||null, o.email||null, o.phone||null); return sdb.prepare('SELECT * FROM users WHERE id=?').get(id); };

const P = (sql) => { const s = sdb.prepare(sql); return { get:(...a)=>s.get(...a), all:(...a)=>s.all(...a), run:(...a)=>s.run(...a) }; };
const dbMock = {
  db: sdb,
  users: { findById: P('SELECT * FROM users WHERE id=?'), findByEmail: P('SELECT * FROM users WHERE email=?'), findByPhone: P('SELECT * FROM users WHERE phone=?'), create: usersCreate },
  oauth: { findByProvider: P('SELECT u.* FROM users u JOIN user_oauth o ON u.id=o.user_id WHERE o.provider=? AND o.open_id=?'), bind: P('INSERT INTO user_oauth (id,user_id,provider,open_id,union_id) VALUES (?,?,?,?,?)'), unbind: P('DELETE FROM user_oauth WHERE user_id=? AND provider=?') },
  orgMembers: { get: P('SELECT * FROM org_members WHERE subject_id=? AND user_id=?'), add: P('INSERT INTO org_members (subject_id,user_id,org_uid,source) VALUES (?,?,?,?)'), setOrgUid: P('UPDATE org_members SET org_uid=? WHERE subject_id=? AND user_id=?'), setPassword: P('UPDATE org_members SET password_hash=? WHERE subject_id=? AND user_id=?'), remove: P('DELETE FROM org_members WHERE subject_id=? AND user_id=?'), listBySubject: P('SELECT * FROM org_members WHERE subject_id=?'), orgUidTaken: P('SELECT 1 FROM org_members WHERE subject_id=? AND org_uid=? AND user_id<>?') },
  oauthSubjects: { get: P('SELECT * FROM oauth_subjects WHERE id=?') },
};

// ---- spy 替掉 ./contacts ----
const importCalls = [];
const contactsStub = {
  importWecomContacts: (userId, m, subjectId) => { importCalls.push({ userId, m, subjectId }); },
  addContact: () => ({ ok: true }), listContacts: () => ({ phones: [], emails: [] }),
  contactLimits: () => ({ maxPhones: 10, maxEmails: 20 }), normPhone: v=>v, normEmail: v=>v,
};

const wecomPath = path.join(__dirname, '..', 'server', 'dirsync-wecom.js');
const inject = (req, exports) => { const r = Module._resolveFilename(req, { id: wecomPath, filename: wecomPath, paths: Module._nodeModulePaths(path.dirname(wecomPath)) }); require.cache[r] = { id:r, filename:r, loaded:true, exports }; };
inject('./db', dbMock);
inject('./contacts', contactsStub);

const W = require('../server/dirsync-wecom');

let pass=0, fail=0;
const ok = (name, cond) => { cond?pass++:fail++; console.log(`${cond?'✓':'✗'} ${name}`); };

(async () => {
  const source = sdb.prepare('SELECT * FROM dir_sync_sources WHERE id=?').get('src1');
  const subject = sdb.prepare('SELECT * FROM oauth_subjects WHERE id=?').get('sub1');
  const cfg = { corp_id: 'corpX', uid_mode: 'userid', bind_mode: 'none', remove_missing: false };
  const helpers = { isEmail: v => /@/.test(v), isPhone: v => /^1\d{10}$/.test(v), genOrgUid: () => null };
  // fetcher 返回：一个正常成员 + 一个 _idOnly 成员
  const fetcher = async () => ({
    members: [
      { userid: 'zhangsan', name: '张三', mobile: '13800000001', email: 'z@x.com', biz_mail: 'z@corp.com', status: 1, department: [1] },
      { userid: 'onlyid', name: 'onlyid', status: 1, department: [1], _idOnly: true },
    ],
    deptName: new Map([[1, '技术部']]),
    limited: false,
  });

  const out = await W.syncWecom(source, subject, cfg, helpers, fetcher, {});
  ok('同步建了 2 个号', out.created === 2);
  ok('正常成员触发 importWecomContacts', importCalls.length === 1);
  ok('灌联系方式用的是正常成员 userid', importCalls[0] && importCalls[0].m.userid === 'zhangsan');
  ok('带上 biz_mail', importCalls[0] && importCalls[0].m.biz_mail === 'z@corp.com');
  ok('subjectId 传对（用于按组织取上限）', importCalls[0] && importCalls[0].subjectId === 'sub1');
  ok('_idOnly 成员不灌联系方式（只拿到 UserId）', !importCalls.some(c => c.m.userid === 'onlyid'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
