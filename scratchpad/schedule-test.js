// 通讯录「每天固定时间点」调度判定单测（v3.5.73）
function _scheduleDue(times, lastAt, now = new Date()) {
  for (const t of (times || [])) {
    const p = t.split(':').map(Number);
    if (p.length !== 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const dueAt = new Date(now); dueAt.setHours(p[0], p[1], 0, 0);
    const last = Date.parse(lastAt || '') || 0;
    if (now >= dueAt && last < dueAt.getTime()) return true;
  }
  return false;
}
let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗'} ${n}`); };
const D = (h, m) => new Date(2026, 9, 6, h, m, 0);  // 本地 2026-10-06 hh:mm

// 到点且从未同步过 → 触发
ok('03:00 到点未同步触发', _scheduleDue(['03:00'], null, D(3, 0)) === true);
ok('03:00 过了 5 分钟仍触发（补跑）', _scheduleDue(['03:00'], null, D(3, 5)) === true);
// 已同步过（at 晚于该点）→ 不触发
ok('03:00 已同步过不触发', _scheduleDue(['03:00'], D(3, 5).toISOString(), D(3, 30)) === false);
// 还没到点 → 不触发
ok('14:00 未到 15:00 不触发', _scheduleDue(['15:00'], null, D(14, 0)) === false);
// 多时间点：03:00 过了但已同步，15:00 到点未同步 → 触发（15:00 那次）
ok('多时间点 03:00 已过 15:00 到点触发', _scheduleDue(['03:00','15:00'], D(3, 0).toISOString(), D(15, 5)) === true);
// 两个都同步过了 → 不触发
ok('两个时间点都同步过不触发', _scheduleDue(['03:00','15:00'], D(15, 5).toISOString(), D(16, 0)) === false);
// 空时间点数组 → 不触发（回退 interval_hours 由调用方处理）
ok('空数组不触发', _scheduleDue([], null, D(3, 0)) === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
