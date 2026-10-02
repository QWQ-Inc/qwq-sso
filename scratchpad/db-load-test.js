// 用 node:sqlite 顶替 better-sqlite3，加载真实 db.js + access.js，验证所有建表/预编译语句（含门禁）无误。
const Module = require('module');
const { DatabaseSync } = require('node:sqlite');
class Stmt {
  constructor(s) { this.s = s; }
  run(...a) { const r = this.s.run(...a); return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }; }
  get(...a) { return this.s.get(...a); }
  all(...a) { return this.s.all(...a); }
  iterate(...a) { return this.s.iterate(...a); }
  pluck() { return this; }
}
class DB {
  constructor() { this.db = new DatabaseSync(':memory:'); }
  prepare(sql) { return new Stmt(this.db.prepare(sql)); }
  exec(sql) { this.db.exec(sql); }
  pragma() { return []; }
  transaction(fn) { const self = this; return function (...args) { self.db.exec('BEGIN'); try { const r = fn(...args); self.db.exec('COMMIT'); return r; } catch (e) { self.db.exec('ROLLBACK'); throw e; } }; }
  close() { this.db.close(); }
}
const orig = Module._load;
Module._load = function (req) { if (req === 'better-sqlite3') return DB; return orig.apply(this, arguments); };

const d = require('../server/db');
console.log('✓ db.js loaded; access 语句数:', Object.keys(d.access).length);

// 实际建一扇门 + 一条规则 + 一条日志，走真实预编译语句
const did = 'door-1';
d.access.insertDoor.run({ id: did, name: '测试门', location: '一楼', subject_id: null, status: 'enabled', note: '' });
d.access.insertRule.run({ id: 'r-1', door_id: did, grant_type: 'all', grant_value: '', effect: 'allow', weekdays: '', time_start: '', time_end: '', label: '所有登录用户' });
d.access.insertLog.run({ id: 'l-1', door_id: did, door_name: '测试门', user_id: 'u1', user_name: '张三', uid_seq: 1, method: 'qr', result: 'allow', reason: 'ok', ip: '127.0.0.1' });
console.log('✓ 门:', d.access.doorById.get(did).name, '| 规则数:', d.access.countRulesByDoor.get(did).n, '| 日志数:', d.access.logsAll.all(10).length);
d.access.qrUse.run('jti-1', 9999999999);
console.log('✓ qrUsed:', !!d.access.qrUsed.get('jti-1'));

const a = require('../server/access');
console.log('✓ access.js loaded; QR_TTL =', a.QR_TTL);
console.log('\n全部通过');
