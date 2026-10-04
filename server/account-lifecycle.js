// 账号注销 / 删除生命周期（v3.5.44）
//
//   申请（pending）──冷静期 / 等待期满 + 交接清单全部完成（+ 需审批的已批准或等待期满）──▶ 已删除（deleted）
//   已删除：账号停用、应用权限同步暂停，保留期内（默认 90 天）管理员可恢复
//   保留期满 ──▶ 彻底清除：账号行与个人数据一并删除，找不回来（审计存证链只留脱敏摘要）
//
// 两种发起方式：
//   · 本人注销（kind=self）：冷静期默认 30 天（ACCOUNT_DELETE_COOLDOWN_DAYS），期间账号照常可用、可随时撤销
//   · 管理员删除（kind=admin）：超级管理员 / 被授权「删除账号」的人立即执行；其他系统管理员发起的要上级审批，
//     或等待期（ACCOUNT_DELETE_ADMIN_WAIT_DAYS，默认 7 天）满后自动执行
// 预检：账号关联了重要应用（企业微信等外部通讯录账号、企业登录账号、组织 / 分组管理员职责、标为「须交接」的应用、名下设备）
// 时生成交接清单，每一项都标记完成后才会执行删除。
const crypto = require('crypto');
const { db, users } = require('./db');

let hooks = { onDeleted: null, onRestored: null, audit: null };
function init(h) { Object.assign(hooks, h || {}); }

function intEnv(key, def, min, max) {
  const n = parseInt(process.env[key], 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}
function config() {
  return {
    cooldown_days: intEnv('ACCOUNT_DELETE_COOLDOWN_DAYS', 30, 0, 365),
    retain_days: intEnv('ACCOUNT_DELETE_RETAIN_DAYS', 90, 0, 3650),
    admin_wait_days: intEnv('ACCOUNT_DELETE_ADMIN_WAIT_DAYS', 7, 0, 365),
  };
}
// 与 SQLite datetime('now') 同格式（UTC，'YYYY-MM-DD HH:MM:SS'），可直接字符串比较
const sqlTime = (ms = Date.now()) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const afterDays = d => sqlTime(Date.now() + d * 86400000);

const PLATFORM_ZH = { wecom: '企业微信', feishu: '飞书', dingtalk: '钉钉' };

// 预检：需要先交接的重要关联
function preflight(user) {
  const items = [];
  const extKeys = new Set();
  for (const l of db.prepare(`SELECT l.source_id, l.ext_id, d.label, d.type, s.name AS org
      FROM dir_source_links l JOIN dir_sync_sources d ON d.id=l.source_id LEFT JOIN oauth_subjects s ON s.id=d.subject_id
      WHERE l.user_id=?`).all(user.id)) {
    extKeys.add(l.ext_id);
    items.push({ key: `ext:${l.source_id}:${l.ext_id}`, kind: 'external',
      label: `${l.org || ''} · ${l.label || l.type} 的账号 ${l.ext_id}：在${PLATFORM_ZH[l.type] || l.type}里办理离职 / 交接` });
  }
  for (const o of db.prepare('SELECT provider, open_id FROM user_oauth WHERE user_id=?').all(user.id)) {
    const platform = String(o.provider).split(':')[0];
    if (!PLATFORM_ZH[platform] || extKeys.has(o.open_id)) continue;
    items.push({ key: `bind:${o.provider}:${o.open_id}`, kind: 'external',
      label: `${PLATFORM_ZH[platform]}登录账号 ${o.open_id}：在${PLATFORM_ZH[platform]}里办理离职 / 交接` });
  }
  for (const r of db.prepare('SELECT a.subject_id, s.name FROM oauth_subject_admins a JOIN oauth_subjects s ON s.id=a.subject_id WHERE a.user_id=?').all(user.id))
    items.push({ key: `orgadmin:${r.subject_id}`, kind: 'role', label: `组织「${r.name}」的组织管理员职责已交接` });
  for (const r of db.prepare('SELECT a.group_id, g.name FROM group_admins a JOIN user_groups g ON g.id=a.group_id WHERE a.user_id=?').all(user.id))
    items.push({ key: `groupadmin:${r.group_id}`, kind: 'role', label: `分组「${r.name}」的分组管理员职责已交接` });
  for (const a of db.prepare(`SELECT a.id, a.name FROM apps a JOIN user_app_auth ua ON ua.app_id=a.id
      WHERE ua.user_id=? AND COALESCE(a.handover_required,0)=1`).all(user.id))
    items.push({ key: `app:${a.id}`, kind: 'app', label: `应用「${a.name}」里的数据 / 职责已交接` });
  for (const d of db.prepare('SELECT id, name FROM devices WHERE owner_user_id=?').all(user.id))
    items.push({ key: `device:${d.id}`, kind: 'device', label: `设备「${d.name}」已回收或转交` });
  return items;
}

const reqStmts = {
  pendingOf: db.prepare("SELECT * FROM account_deletions WHERE user_id=? AND status='pending' ORDER BY created_at DESC"),
  latestOf:  db.prepare('SELECT * FROM account_deletions WHERE user_id=? ORDER BY created_at DESC'),
  get:       db.prepare('SELECT * FROM account_deletions WHERE id=?'),
};
function parseReq(r) {
  if (!r) return null;
  let checklist = [];
  try { checklist = JSON.parse(r.checklist || '[]'); } catch (_) {}
  return { ...r, checklist, checklist_done: checklist.every(i => i.done) };
}
const pendingOf = uid => parseReq(reqStmts.pendingOf.get(uid));
const getReq = id => parseReq(reqStmts.get.get(id));

function fail(msg, status = 400) { const e = new Error(msg); e.status = status; throw e; }

// 发起注销 / 删除。immediate=true 时立即可执行（仍需交接清单完成）
function request(user, { kind, by = null, reason = '', needsApproval = false, immediate = false }) {
  if (!user) fail('用户不存在', 404);
  if (user.is_public) fail('公共账号不走注销流程，请在分组的公共账号管理里删除');
  if (user.deletion_state === 'deleted') fail('该账号已删除');
  if (pendingOf(user.id)) fail('该账号已有进行中的注销 / 删除申请');
  const c = config();
  const execute_at = immediate ? sqlTime() : afterDays(kind === 'self' ? c.cooldown_days : c.admin_wait_days);
  const checklist = preflight(user).map(i => ({ ...i, done: false }));
  const id = crypto.randomUUID();
  db.transaction(() => {
    db.prepare(`INSERT INTO account_deletions (id,user_id,kind,requested_by,reason,status,needs_approval,checklist,execute_at)
      VALUES (?,?,?,?,?,'pending',?,?,?)`).run(id, user.id, kind, by, String(reason || '').slice(0, 300), needsApproval ? 1 : 0, JSON.stringify(checklist), execute_at);
    db.prepare("UPDATE users SET deletion_state='pending', updated_at=datetime('now') WHERE id=?").run(user.id);
  })();
  log(kind === 'self' ? 'account.deletion_requested' : 'account.deletion_requested', user, by, { kind, needs_approval: !!needsApproval, execute_at, checklist: checklist.length });
  tryExecute(id);
  return getReq(id);
}

function setChecklist(id, key, done, by) {
  const r = getReq(id);
  if (!r || r.status !== 'pending') fail('申请不存在或已结束', 404);
  const it = r.checklist.find(i => i.key === key);
  if (!it) fail('交接项不存在', 404);
  it.done = !!done; it.done_by = done ? by : null; it.done_at = done ? sqlTime() : null;
  db.prepare("UPDATE account_deletions SET checklist=?, updated_at=datetime('now') WHERE id=?").run(JSON.stringify(r.checklist), id);
  tryExecute(id);
  return getReq(id);
}

function approve(id, by) {
  const r = getReq(id);
  if (!r || r.status !== 'pending') fail('申请不存在或已结束', 404);
  db.prepare("UPDATE account_deletions SET approved_by=?, execute_at=MIN(execute_at, datetime('now')), updated_at=datetime('now') WHERE id=?").run(by, id);
  const u = users.findById.get(r.user_id);
  log('account.deletion_approved', u, by, { id });
  tryExecute(id);
  return getReq(id);
}

function endPending(id, status, by, event) {
  const r = getReq(id);
  if (!r || r.status !== 'pending') fail('申请不存在或已结束', 404);
  db.transaction(() => {
    db.prepare("UPDATE account_deletions SET status=?, updated_at=datetime('now') WHERE id=?").run(status, id);
    db.prepare("UPDATE users SET deletion_state=NULL, updated_at=datetime('now') WHERE id=? AND deletion_state='pending'").run(r.user_id);
  })();
  log(event, users.findById.get(r.user_id), by, { id });
  return getReq(id);
}
const cancel = (id, by) => endPending(id, 'cancelled', by, 'account.deletion_cancelled');
const reject = (id, by) => endPending(id, 'rejected', by, 'account.deletion_rejected');

// 到时间 + 清单完成（+ 需审批的已批准，或等待期满）→ 执行删除
function tryExecute(id) {
  const r = getReq(id);
  if (!r || r.status !== 'pending' || !r.checklist_done) return false;
  if (r.execute_at > sqlTime()) return false;
  executeDeletion(r);
  return true;
}
function executeDeletion(r) {
  const u = users.findById.get(r.user_id);
  if (!u) return;
  const purge_at = afterDays(config().retain_days);
  db.transaction(() => {
    db.prepare(`UPDATE users SET status='disabled', deletion_state='deleted', deleted_at=datetime('now'), purge_at=?, updated_at=datetime('now') WHERE id=?`).run(purge_at, u.id);
    db.prepare("UPDATE account_deletions SET status='done', executed_at=datetime('now'), updated_at=datetime('now') WHERE id=?").run(r.id);
  })();
  log('account.deleted', u, r.approved_by || r.requested_by, { id: r.id, kind: r.kind, purge_at });
  if (hooks.onDeleted) { try { hooks.onDeleted(users.findById.get(u.id)); } catch (_) {} }
}

// 保留期内恢复
function restore(user, by) {
  if (!user || user.deletion_state !== 'deleted') fail('该账号不是「已删除」状态');
  if (user.purge_at && user.purge_at <= sqlTime()) fail('已过保留期，无法恢复');
  db.transaction(() => {
    db.prepare(`UPDATE users SET status='active', deletion_state=NULL, deleted_at=NULL, purge_at=NULL, updated_at=datetime('now') WHERE id=?`).run(user.id);
    db.prepare("UPDATE account_deletions SET status='restored', updated_at=datetime('now') WHERE user_id=? AND status='done'").run(user.id);
  })();
  log('account.restored', user, by, {});
  if (hooks.onRestored) { try { hooks.onRestored(users.findById.get(user.id)); } catch (_) {} }
}

// 彻底清除：遍历所有表，删个人数据、把对他的引用置空；最后删账号行（外键 CASCADE 收尾）
function purge(user, by = 'system') {
  if (!user) return;
  const NULLABLE_REFS = ['owner_user_id', 'created_by', 'granted_by', 'requested_by', 'approved_by', 'issued_by', 'escort_user_id', 'done_by'];
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
    .map(r => r.name).filter(n => n !== 'users' && n !== 'audit_chain');
  let deletedRow = true;
  db.transaction(() => {
    try { db.prepare('DELETE FROM memo_attachments WHERE memo_id IN (SELECT id FROM memos WHERE owner_id=?)').run(user.id); } catch (_) {}
    for (const t of tables) {
      const cols = db.prepare(`PRAGMA table_info("${t}")`).all();
      for (const c of cols) {
        if (c.name === 'user_id' || c.name === 'owner_id') db.prepare(`DELETE FROM "${t}" WHERE "${c.name}"=?`).run(user.id);
        else if (NULLABLE_REFS.includes(c.name)) {
          if (c.notnull) db.prepare(`DELETE FROM "${t}" WHERE "${c.name}"=?`).run(user.id);
          else db.prepare(`UPDATE "${t}" SET "${c.name}"=NULL WHERE "${c.name}"=?`).run(user.id);
        }
      }
    }
    db.prepare('UPDATE users SET merged_into=NULL WHERE merged_into=?').run(user.id);
    try { db.prepare('DELETE FROM users WHERE id=?').run(user.id); }
    catch (_) {
      // 万一还有没想到的外键引用：退化成匿名墓碑（个人信息全部抹掉）
      deletedRow = false;
      db.prepare(`UPDATE users SET name='已删除用户', email=NULL, phone=NULL, password_hash=NULL, twofa_secret=NULL, twofa_enabled=0,
        kyc_verified=0, kyc_name=NULL, kyc_id_tail=NULL, kyc_provider=NULL, kyc_pseudonym=NULL, kyc_name_hash=NULL, uid_code=NULL,
        deletion_state='purged', status='disabled', updated_at=datetime('now') WHERE id=?`).run(user.id);
    }
  })();
  log('account.purged', user, by, { row_deleted: deletedRow });
}

// 定时：执行到期的申请、清除过了保留期的账号
function tick() {
  const out = { executed: 0, purged: 0 };
  for (const r of db.prepare("SELECT id FROM account_deletions WHERE status='pending' AND execute_at<=?").all(sqlTime())) {
    try { if (tryExecute(r.id)) out.executed++; } catch (_) {}
  }
  for (const u of db.prepare("SELECT * FROM users WHERE deletion_state='deleted' AND purge_at IS NOT NULL AND purge_at<=?").all(sqlTime())) {
    try { purge(u); out.purged++; } catch (_) {}
  }
  return out;
}

function log(event, user, by, detail) {
  if (!hooks.audit) return;
  try { hooks.audit(event, { subject: String(user ? user.uid_seq : ''), actor: by ? 'user:' + (users.findById.get(by)?.uid_seq || by) : 'system', detail }); } catch (_) {}
}

module.exports = { init, config, preflight, request, setChecklist, approve, cancel, reject, tryExecute, restore, purge, tick, pendingOf, getReq, sqlTime };
