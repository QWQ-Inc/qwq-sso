// 限权管理员判定单测（v3.5.74）：生效时段 + 应用/组织范围
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(":memory:");
db.exec(`CREATE TABLE limited_admins (id TEXT PRIMARY KEY, user_id TEXT, apps TEXT, scope_type TEXT, scope_id TEXT, valid_from TEXT, valid_to TEXT, note TEXT, created_by TEXT, created_at TEXT);`);
const byUser = db.prepare("SELECT * FROM limited_admins WHERE user_id=?");
const insert = db.prepare("INSERT INTO limited_admins (id,user_id,apps,scope_type,scope_id,valid_from,valid_to,note,created_by) VALUES (?,?,?,?,?,?,?,?,?)");

function limitedAdminOf(uid, now = Date.now()) {
  for (const g of byUser.all(uid)) {
    if (g.valid_from && Date.parse(g.valid_from) > now) continue;
    if (g.valid_to && Date.parse(g.valid_to) < now) continue;
    return g;
  }
  return null;
}
const appsOf = g => { try { return JSON.parse(g.apps || '[]'); } catch { return []; } };
function canApp(g, appId) { const l = appsOf(g); return l.length === 0 || l.includes(appId); }
function canScope(g, sid) { return g.scope_type === 'all' || g.scope_id === sid; }

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗'} ${n}`); };
const now = Date.parse("2026-10-06T12:00:00Z");

// 无授权
ok('无授权返回 null', limitedAdminOf('u0', now) === null);
// 有效期内
insert.run('g1','u1','[]','all',null,null,null,'','');
ok('不限范围生效', limitedAdminOf('u1', now)?.id === 'g1');
ok('不限范围能管任意应用', canApp(limitedAdminOf('u1', now), 'a1') === true);
// 时限：未到起始
insert.run('g2','u2','["a1"]','org','o1',"2026-10-07T00:00:00Z",null,'','');
ok('未到起始不生效', limitedAdminOf('u2', now) === null);
// 时限：已过截止
insert.run('g3','u3','["a1"]','org','o1',null,"2026-10-05T00:00:00Z",'','');
ok('已过截止不生效', limitedAdminOf('u3', now) === null);
// 时限：在窗口内
insert.run('g4','u4','["a1","a2"]','org','o1',"2026-10-06T00:00:00Z","2026-10-07T00:00:00Z",'','');
const g4 = limitedAdminOf('u4', now);
ok('窗口内生效', g4?.id === 'g4');
ok('限应用：能管 a1', canApp(g4, 'a1') === true);
ok('限应用：不能管 a3', canApp(g4, 'a3') === false);
ok('限组织：能管 o1', canScope(g4, 'o1') === true);
ok('限组织：不能管 o2', canScope(g4, 'o2') === false);
// 多授权：取第一条有效的
insert.run('g5','u5','["a1"]','org','o1',"2026-10-01T00:00:00Z","2026-10-02T00:00:00Z",'','');
insert.run('g6','u5','["a2"]','org','o2',"2026-10-05T00:00:00Z","2026-10-08T00:00:00Z",'','');
ok('多授权取生效的那条', limitedAdminOf('u5', now)?.id === 'g6');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
