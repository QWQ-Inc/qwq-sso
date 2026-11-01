// v3.5.108 导入兼容性判断单测：cmpSemver + computeCompat（纯函数，从 backup.js 取）
const b = require('../server/backup.js');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('  ✗ ' + n); } };

// ── cmpSemver ──
ok('3.5.107 > 3.5.106', b.cmpSemver('3.5.107', '3.5.106') === 1);
ok('3.5.106 < 3.5.107', b.cmpSemver('3.5.106', '3.5.107') === -1);
ok('相等', b.cmpSemver('3.5.107', '3.5.107') === 0);
ok('4 段 3.5.107.1 > 3.5.107', b.cmpSemver('3.5.107.1', '3.5.107') === 1);
ok('3.10.0 > 3.9.9（数值非字典序）', b.cmpSemver('3.10.0', '3.9.9') === 1);

// ── computeCompat 方向 ──
const live = { users: ['id', 'name'], apps: ['id', 'client_id'] };
// 升级（备份旧）
let c = b.computeCompat({ backupVersion: '3.5.105', currentVersion: '3.5.108', backupSchemaVer: 0, currentSchemaVer: 1, backupTables: { users: ['id', 'name'] }, liveTables: live });
ok('备份旧 → upgrade', c.direction === 'upgrade');
ok('升级无 unusable', c.has_unusable === false);
// 同版
c = b.computeCompat({ backupVersion: '3.5.108', currentVersion: '3.5.108', backupTables: live, liveTables: live });
ok('同版 → same', c.direction === 'same');
// 降级：schema 版本优先
c = b.computeCompat({ backupVersion: '3.5.108', currentVersion: '3.5.108', backupSchemaVer: 5, currentSchemaVer: 1, backupTables: live, liveTables: live });
ok('schema 版本高 → downgrade（即便语义版本相同）', c.direction === 'downgrade');

// ── 降级 + 认不得的表/列 ──
const backNewer = {
  users: ['id', 'name', 'new_flag'],       // 多一列 new_flag
  apps: ['id', 'client_id'],
  shiny_feature: ['id', 'data'],           // 整张新表
};
c = b.computeCompat({ backupVersion: '3.5.120', currentVersion: '3.5.108', backupSchemaVer: 9, currentSchemaVer: 1, backupTables: backNewer, liveTables: live });
ok('降级方向', c.direction === 'downgrade');
ok('认不得整表 shiny_feature', c.unknown_tables.length === 1 && c.unknown_tables[0] === 'shiny_feature');
ok('认不得列 users.new_flag', c.unknown_columns.users && c.unknown_columns.users[0] === 'new_flag');
ok('has_unusable=true', c.has_unusable === true);
ok('共享表 apps 无缺列', !c.unknown_columns.apps);

// ── 降级但结构无新增（纯语义降级，无 unusable）──
c = b.computeCompat({ backupVersion: '3.5.109', currentVersion: '3.5.108', backupSchemaVer: 2, currentSchemaVer: 1, backupTables: live, liveTables: live });
ok('降级但无新表新列 → has_unusable=false', c.direction === 'downgrade' && c.has_unusable === false);

// ── 无版本信息（旧 .db.gz，无 MANIFEST、user_version=0）→ 回退表对比，不误判降级 ──
c = b.computeCompat({ backupVersion: '', currentVersion: '3.5.108', backupSchemaVer: 0, currentSchemaVer: 1, backupTables: { users: ['id', 'name'] }, liveTables: live });
ok('旧备份无版本信息 → 不判降级（same/upgrade）', c.direction !== 'downgrade');

console.log('\n' + (fail ? ('✗ ' + fail + ' 失败, ' + pass + ' 通过') : ('✓ 全部 ' + pass + ' 项通过')));
process.exit(fail ? 1 : 0);
