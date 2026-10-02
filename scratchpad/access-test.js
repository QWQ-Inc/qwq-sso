// 门禁逻辑单测：mock ./db 后 require ./access，验证签名码/时段/规则匹配/判定。
const path = require('path');
const Module = require('module');

// in-memory stores
const usedJti = new Set();
const rulesByDoor = {};          // doorId -> [rule]
const orgMembership = new Set(); // `${subjectId}|${userId}`
const userTags = {};             // userId -> [{id}]

const dbMock = {
  access: {
    rulesByDoor: { all: (d) => rulesByDoor[d] || [] },
    enabledDoors: { all: () => Object.keys(rulesByDoor).map(id => ({ id, name: 'D' + id, location: '', status: 'enabled' })) },
    qrUsed: { get: (j) => usedJti.has(j) ? 1 : undefined },
    qrUse: { run: (j) => { usedJti.add(j); } },
    qrClean: { run: () => {} },
  },
  orgMembers: { get: { get: (s, u) => orgMembership.has(`${s}|${u}`) ? {} : undefined } },
  tags: { ofUser: { all: (u) => userTags[u] || [] } },
};

// inject mock into require cache for './db' as seen from server/access.js
const accessPath = path.join(__dirname, '..', 'server', 'access.js');
const dbResolved = Module._resolveFilename('../server/db.js', { id: accessPath, filename: accessPath, paths: Module._nodeModulePaths(path.dirname(accessPath)) });
require.cache[dbResolved] = { id: dbResolved, filename: dbResolved, loaded: true, exports: dbMock };

process.env.ACCESS_QR_SECRET = 'test-secret';
const A = require('../server/access');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  ✗ ' + m); } };

// 1. 签名码往返
const u = { id: 'u1', uid_seq: 42, role: 'user', user_level: 3, group_id: 'g1' };
const sig = A.signQr(u);
ok(/^qr1\./.test(sig.code), '签名码格式 qr1.');
const v1 = A.verifyQr(sig.code, { consume: true });
ok(v1.ok && v1.payload.u === 'u1', '首次校验通过');
const v2 = A.verifyQr(sig.code, { consume: true });
ok(!v2.ok && v2.reason === 'replayed', '二次校验被判重放');

// 2. 篡改签名
ok(!A.verifyQr(sig.code.slice(0, -2) + 'xx', { consume: false }).ok, '签名篡改被拒');
// 3. 过期
const expd = A.signQr(u, -1);
ok(A.verifyQr(expd.code, { consume: false }).reason === 'expired', '过期被拒');

// 4. 规则匹配
ok(A.ruleMatchesUser({ grant_type: 'all' }, u), 'all 命中');
ok(A.ruleMatchesUser({ grant_type: 'user', grant_value: '42' }, u), 'user 按 uid_seq 命中');
ok(A.ruleMatchesUser({ grant_type: 'user', grant_value: 'u1' }, u), 'user 按 id 命中');
ok(A.ruleMatchesUser({ grant_type: 'group', grant_value: 'g1' }, u), 'group 命中');
ok(!A.ruleMatchesUser({ grant_type: 'group', grant_value: 'g2' }, u), 'group 不命中');
ok(A.ruleMatchesUser({ grant_type: 'level', grant_value: 'U3' }, u), 'level U3 命中');
ok(!A.ruleMatchesUser({ grant_type: 'level', grant_value: 'U4' }, u), 'level U4 不命中');
const adm = { id: 'a1', uid_seq: 1, role: 'admin', admin_level: 1 };
ok(A.ruleMatchesUser({ grant_type: 'level', grant_value: 'A1' }, adm), 'level A1 命中管理员');
orgMembership.add('org1|u1');
ok(A.ruleMatchesUser({ grant_type: 'org', grant_value: 'org1' }, u), 'org 成员命中');
ok(!A.ruleMatchesUser({ grant_type: 'org', grant_value: 'org2' }, u), 'org 非成员不命中');
userTags['u1'] = [{ id: 't1' }];
ok(A.ruleMatchesUser({ grant_type: 'tag', grant_value: 't1' }, u), 'tag 命中');

// 5. 时段
const mon9 = new Date('2026-10-05T09:30:00'); // 周一 09:30 (本地)
ok(A.withinSchedule({ weekdays: '', time_start: '', time_end: '' }, mon9), '空时段=不限');
ok(A.withinSchedule({ weekdays: '1', time_start: '09:00', time_end: '18:00' }, mon9), '周一工作时段内');
ok(!A.withinSchedule({ weekdays: '2,3', time_start: '', time_end: '' }, mon9), '非指定星期不命中');
ok(!A.withinSchedule({ weekdays: '', time_start: '10:00', time_end: '18:00' }, mon9), '早于起始时间不命中');
const night = new Date('2026-10-05T23:30:00');
ok(A.withinSchedule({ weekdays: '', time_start: '22:00', time_end: '06:00' }, night), '跨夜时段 23:30 命中');
ok(!A.withinSchedule({ weekdays: '', time_start: '22:00', time_end: '06:00' }, mon9), '跨夜时段 09:30 不命中');

// 6. evaluateAccess：拒绝优先
rulesByDoor['d1'] = [
  { effect: 'allow', grant_type: 'group', grant_value: 'g1', weekdays: '', time_start: '', time_end: '' },
  { effect: 'deny', grant_type: 'user', grant_value: 'u1', weekdays: '', time_start: '', time_end: '' },
];
ok(!A.evaluateAccess(u, { id: 'd1', status: 'enabled' }).allow, '拒绝规则优先于允许');
rulesByDoor['d2'] = [{ effect: 'allow', grant_type: 'group', grant_value: 'g1', weekdays: '', time_start: '', time_end: '' }];
ok(A.evaluateAccess(u, { id: 'd2', status: 'enabled' }).allow, '分组放行');
ok(A.evaluateAccess({ id: 'x', uid_seq: 9, role: 'user', user_level: 5, group_id: 'g9' }, { id: 'd2', status: 'enabled' }).reason === 'not_authorized', '非成员 not_authorized');
ok(!A.evaluateAccess(u, { id: 'd2', status: 'disabled' }).allow, '门停用拒绝');
ok(A.evaluateAccess({ ...u, status: 'disabled' }, { id: 'd2', status: 'enabled' }).reason === 'user_disabled', '用户禁用拒绝');
rulesByDoor['d3'] = [{ effect: 'allow', grant_type: 'group', grant_value: 'g1', weekdays: '', time_start: '10:00', time_end: '18:00' }];
ok(A.evaluateAccess(u, { id: 'd3', status: 'enabled' }, mon9).reason === 'out_of_schedule', '命中但不在时段=out_of_schedule');

// 7. doorsForUser
const doors = A.doorsForUser(u);
ok(doors.some(d => d.id === 'd2') && !doors.some(d => d.id === 'd1'), 'doorsForUser 只列能过的门');

console.log(`\n门禁逻辑：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
