// 成员多联系方式单测：用 node:sqlite 建真表作为 ./db 的 mock，再 require ../server/contacts。
// 覆盖：addContact 去重/超上限/组织上限覆盖全局、normPhone/normEmail、importWecomContacts。
const path = require('path');
const Module = require('module');
const { DatabaseSync } = require('node:sqlite');

const sdb = new DatabaseSync(':memory:');
sdb.exec(`CREATE TABLE user_contacts (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual', is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE UNIQUE INDEX idx_uc ON user_contacts(user_id, kind, value);
CREATE TABLE oauth_subjects (id TEXT PRIMARY KEY, max_phones INTEGER DEFAULT 0, max_emails INTEGER DEFAULT 0);`);
sdb.exec("INSERT INTO oauth_subjects (id,max_phones,max_emails) VALUES ('orgA',2,3),('orgB',0,0)");

const P = (sql) => sdb.prepare(sql);
const G = (sql) => { const s = sdb.prepare(sql); return { get: (...a) => s.get(...a) }; };
const R = (sql) => { const s = sdb.prepare(sql); return { run: (...a) => s.run(...a) }; };
const A = (sql) => { const s = sdb.prepare(sql); return { all: (...a) => s.all(...a) }; };
const dbMock = {
  db: sdb,
  contacts: {
    byUser:     A('SELECT * FROM user_contacts WHERE user_id=? ORDER BY kind, is_primary DESC, created_at'),
    countKind:  G('SELECT COUNT(*) n FROM user_contacts WHERE user_id=? AND kind=?'),
    exists:     G('SELECT 1 FROM user_contacts WHERE user_id=? AND kind=? AND value=?'),
    insert:     R('INSERT OR IGNORE INTO user_contacts (id,user_id,kind,value,source,is_primary) VALUES (?,?,?,?,?,?)'),
  },
  oauthSubjects: { get: G('SELECT * FROM oauth_subjects WHERE id=?') },
};

const cPath = path.join(__dirname, '..', 'server', 'contacts.js');
const dbResolved = Module._resolveFilename('./db', { id: cPath, filename: cPath, paths: Module._nodeModulePaths(path.dirname(cPath)) });
require.cache[dbResolved] = { id: dbResolved, filename: dbResolved, loaded: true, exports: dbMock };
// uuid 可能未本地安装：拦截 require('uuid')
let _n = 0;
const _origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'uuid') return { v4: () => 'id' + (++_n) };
  return _origLoad.call(this, req, parent, isMain);
};

const C = require('../server/contacts');

let pass = 0, fail = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); (ok ? pass++ : fail++); console.log(`${ok ? '✓' : '✗'} ${name}` + (ok ? '' : ` — got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)); };

// normPhone / normEmail
eq('normPhone 合法', C.normPhone(' 13812345678 '), '13812345678');
eq('normPhone 非法', C.normPhone('12345'), null);
eq('normEmail 小写', C.normEmail(' A@X.COM '), 'a@x.com');
eq('normEmail 非法', C.normEmail('a@x'), null);

// addContact 基本
eq('加手机', C.addContact('u1', 'phone', '13800000001', 'manual', null).ok, true);
eq('重复跳过', C.addContact('u1', 'phone', '13800000001', 'manual', null).skip, 'dup');
eq('非法跳过', C.addContact('u1', 'phone', 'bad', 'manual', null).skip, 'bad');

// 全局上限：默认 phone 10；设环境变量到 1 验证
process.env.MEMBER_MAX_PHONES = '1';
eq('全局上限 phone=1 时超限', C.addContact('u1', 'phone', '13800000002', 'manual', null).skip, 'limit');
delete process.env.MEMBER_MAX_PHONES;

// 组织上限覆盖全局：orgA max_phones=2
eq('orgA 第2个手机可加', C.addContact('u2', 'phone', '13900000001', 'wecom', 'orgA').ok, true);
eq('orgA 第2个手机可加2', C.addContact('u2', 'phone', '13900000002', 'wecom', 'orgA').ok, true);
eq('orgA 第3个手机超限(cap=2)', C.addContact('u2', 'phone', '13900000003', 'wecom', 'orgA').skip, 'limit');
// orgA max_emails=3
eq('orgA email cap=3', (() => { C.addContact('u2','email','a@x.com','wecom','orgA'); C.addContact('u2','email','b@x.com','wecom','orgA'); C.addContact('u2','email','c@x.com','wecom','orgA'); return C.addContact('u2','email','d@x.com','wecom','orgA').skip; })(), 'limit');

// orgB max=0 → 回退全局(默认 phone10/email20)
eq('orgB 回退全局', C.addContact('u3', 'phone', '13700000001', 'wecom', 'orgB').ok, true);

// importWecomContacts：mobile + email + biz_mail
C.importWecomContacts('u4', { mobile: '13600000001', email: 'p@x.com', biz_mail: 'p@corp.com' }, null);
const u4 = C.listContacts('u4');
eq('import 1 phone', u4.phones.length, 1);
eq('import 2 email', u4.emails.length, 2);
eq('import biz_mail source', u4.emails.find(e => e.value === 'p@corp.com').source, 'wecom_biz');
// import 空字段跳过
C.importWecomContacts('u5', { mobile: '', email: null }, null);
eq('import 空字段不写', C.listContacts('u5').phones.length + C.listContacts('u5').emails.length, 0);
// import 重复不重复写
C.importWecomContacts('u4', { mobile: '13600000001' }, null);
eq('import 重复不翻倍', C.listContacts('u4').phones.length, 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
