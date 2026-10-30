// v3.5.106 门禁名单（membersOfDoor）单测：mock ./db 后 require ./access。
// 运行：node scratchpad/door-members-test.js
const path = require('path');
const Module = require('module');

const rulesByDoor = {};          // doorId -> [rule]
const orgMembership = new Set(); // `${subjectId}|${userId}`
const userTags = {};             // userId -> [{id}]
let ruleQueries = 0;
const dbMock = {
  access: { rulesByDoor: { all: (d) => { ruleQueries++; return rulesByDoor[d] || []; } } },
  orgMembers: { get: { get: (s, u) => orgMembership.has(`${s}|${u}`) ? {} : undefined }, deptOfUser: { all: () => [] } },
  tags: { ofUser: { all: (u) => userTags[u] || [] } },
};
const accessPath = path.join(__dirname, '..', 'server', 'access.js');
const dbResolved = Module._resolveFilename('../server/db.js', { id: accessPath, filename: accessPath, paths: Module._nodeModulePaths(path.dirname(accessPath)) });
require.cache[dbResolved] = { id: dbResolved, filename: dbResolved, loaded: true, exports: dbMock };
process.env.ACCESS_QR_SECRET = 'test-secret';
const A = require('../server/access');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✗ ' + m); } };
const ids = (list) => list.map(u => u.id).sort().join(',');

const users = [
  { id: 'a', uid_seq: 1, role: 'user', user_level: 3, group_id: 'g-ops', status: 'active' },
  { id: 'b', uid_seq: 2, role: 'user', user_level: 3, group_id: 'g-dev', status: 'active' },
  { id: 'c', uid_seq: 3, role: 'admin', admin_level: 2, group_id: null, status: 'active' },
  { id: 'd', uid_seq: 4, role: 'user', user_level: 3, group_id: 'g-ops', status: 'active' },
];
const door = { id: 'D1', name: '平台成员', status: 'enabled', kind: 'virtual' };

// 没有放行规则 → 没有人（也不逐人判定）
rulesByDoor.D1 = [];
ok(A.membersOfDoor(users, door).length === 0, '无放行规则无人');

// 按分组放行 + 逐人拒绝（拒绝优先）+ 按组织放行
rulesByDoor.D1 = [
  { effect: 'allow', grant_type: 'group', grant_value: 'g-ops' },
  { effect: 'deny', grant_type: 'user', grant_value: 'd' },
  { effect: 'allow', grant_type: 'org', grant_value: 'org-1' },
];
orgMembership.add('org-1|c');
ruleQueries = 0;
ok(ids(A.membersOfDoor(users, door)) === 'a,c', '分组 + 组织放行、逐人拒绝优先');
ok(ruleQueries === 1, '同一扇门只查一次规则（实际 ' + ruleQueries + ' 次）');

// 与逐人 gate 判定（evaluateAccess）一致
for (const u of users) {
  ok(A.evaluateAccess(u, door).allow === A.membersOfDoor([u], door).length > 0, '与 evaluateAccess 一致：' + u.id);
}

// 停用的门、停用的人
ok(A.membersOfDoor(users, { ...door, status: 'disabled' }).length === 0, '停用的门无人');
ok(ids(A.membersOfDoor([{ ...users[0], status: 'disabled' }, users[2]], door)) === 'c', '停用账号不在名单');

// 规则自己的时段生效；门级禁入时段不清空名单
rulesByDoor.D2 = [{ effect: 'allow', grant_type: 'all', grant_value: '', time_start: '09:00', time_end: '18:00' }];
const d2 = { id: 'D2', name: 'x', status: 'enabled', blackout: JSON.stringify([{ wd: [0, 1, 2, 3, 4, 5, 6] , s: '00:00', e: '23:59' }]) };
const noon = new Date(2026, 9, 30, 12, 0), night = new Date(2026, 9, 30, 22, 0);
ok(A.membersOfDoor(users, d2, noon).length === 4, '规则时段内全员');
ok(A.membersOfDoor(users, d2, night).length === 0, '规则时段外无人');
ok(A.inBlackout(d2.blackout, noon) && A.membersOfDoor(users, d2, noon).length === 4, '门级禁入时段不影响名单');

console.log(`door-members: ${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
