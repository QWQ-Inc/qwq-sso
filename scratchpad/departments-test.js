// 正式树状部门单测（v3.5.68）：门禁 dept 判定（真 access.js）+ 部门 upsert 幂等 + 防循环
const path = require('path');
const Module = require('module');
const { DatabaseSync } = require('node:sqlite');

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗'} ${n}`); };

// ── ① access.js 的 ruleMatchesUser dept case（真模块 + mock ./db）──
const deptOfUser = {};  // userId -> [dept_id]
const dbMock = {
  access: {},
  orgMembers: {
    get: { get: () => undefined },
    deptOfUser: { all: (u) => (deptOfUser[u] || []).map(id => ({ dept_id: id })) },
  },
  tags: { ofUser: { all: () => [] } },
};
const ap = path.join(__dirname, '..', 'server', 'access.js');
const dbResolved = Module._resolveFilename('../server/db.js', { id: ap, filename: ap, paths: Module._nodeModulePaths(path.dirname(ap)) });
require.cache[dbResolved] = { id: dbResolved, filename: dbResolved, loaded: true, exports: dbMock };
const A = require('../server/access');

deptOfUser['u1'] = ['deptA'];
ok('门禁 dept 命中', A.ruleMatchesUser({ grant_type: 'dept', grant_value: 'deptA' }, { id: 'u1' }) === true);
ok('门禁 dept 别的部门不命中', A.ruleMatchesUser({ grant_type: 'dept', grant_value: 'deptB' }, { id: 'u1' }) === false);
ok('门禁 dept 无部门不命中', A.ruleMatchesUser({ grant_type: 'dept', grant_value: 'deptA' }, { id: 'u2' }) === false);
deptOfUser['u3'] = ['x', 'deptA'];
ok('门禁 dept 多部门命中其一', A.ruleMatchesUser({ grant_type: 'dept', grant_value: 'deptA' }, { id: 'u3' }) === true);

// ── ② 部门 upsert 幂等（复刻 syncWecom 建部门逻辑）+ 防循环（复刻 deptIsDescendant）──
const sdb = new DatabaseSync(':memory:');
sdb.exec(`CREATE TABLE org_departments (
  id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, name TEXT NOT NULL, parent_id TEXT,
  source TEXT NOT NULL DEFAULT 'manual', ext_id TEXT, sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE UNIQUE INDEX idx_org_depts_ext ON org_departments(subject_id, source, ext_id) WHERE ext_id IS NOT NULL;`);
const get = (id) => sdb.prepare('SELECT * FROM org_departments WHERE id=?').get(id);
const getByExt = (sid, src, ext) => sdb.prepare('SELECT * FROM org_departments WHERE subject_id=? AND source=? AND ext_id=?').get(sid, src, ext);
const ins = (id, name, sid, parent, src, ext, ord) => sdb.prepare('INSERT INTO org_departments (id,name,subject_id,parent_id,source,ext_id,sort_order) VALUES (?,?,?,?,?,?,?)').run(id, name, sid, parent, src, ext, ord);
const upd = (name, parent, id) => sdb.prepare('UPDATE org_departments SET name=?, parent_id=? WHERE id=?').run(name, parent, id);
const all = (sid) => sdb.prepare('SELECT * FROM org_departments WHERE subject_id=?').all(sid);

// 复刻 syncWecom 的建部门循环（getByExt 存在则 update，否则 insert）
function upsertTree(subjectId, source, deptTree) {
  const extToDeptId = new Map();
  for (const node of deptTree) {
    const extId = String(node.id);
    let dId = getByExt(subjectId, source, extId);
    const parentId = node.parent != null ? (extToDeptId.get(String(node.parent)) || null) : null;
    if (dId) { upd(node.name || extId, parentId, dId.id); }
    else { dId = { id: 'd' + (extToDeptId.size + 1) }; ins(dId.id, node.name || extId, subjectId, parentId, source, extId, node.order || 0); }
    extToDeptId.set(extId, dId.id);
  }
  return extToDeptId;
}

// 首轮：建 A → 子 B
upsertTree('org1', 'wecom', [{ id: 1, name: '技术部', parent: null }, { id: 2, name: '后端组', parent: 1 }]);
ok('首轮建 2 部门', all('org1').length === 2);
ok('B 的 parent 指向 A', (() => { const b = getByExt('org1', 'wecom', '2'); return b && b.parent_id === getByExt('org1', 'wecom', '1').id; })());
// 二轮：同 ext_id 幂等（不新建、改名 + 换父级生效）
upsertTree('org1', 'wecom', [{ id: 1, name: '研发部', parent: null }, { id: 2, name: '后端组', parent: null }]);
ok('同 ext_id 幂等（仍 2 部门）', all('org1').length === 2);
ok('改名生效（技术部→研发部）', getByExt('org1', 'wecom', '1').name === '研发部');
ok('换父级生效（B 提到顶级）', getByExt('org1', 'wecom', '2').parent_id === null);

// 防循环（复刻 deptIsDescendant）
function deptIsDescendant(deptId, ancestorId) {
  let cur = get(deptId); const seen = new Set();
  while (cur && cur.parent_id && !seen.has(cur.parent_id)) {
    seen.add(cur.parent_id);
    if (cur.parent_id === ancestorId) return true;
    cur = get(cur.parent_id);
  }
  return false;
}
// 建 A→B→C
ins('a', 'A', 'org1', null, 'manual', null, 0);
ins('b', 'B', 'org1', 'a', 'manual', null, 0);
ins('c', 'C', 'org1', 'b', 'manual', null, 0);
ok('C 是 A 的子孙', deptIsDescendant('c', 'a') === true);
ok('A 不是 C 的子孙', deptIsDescendant('a', 'c') === false);
ok('B 是 A 的子孙', deptIsDescendant('b', 'a') === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
