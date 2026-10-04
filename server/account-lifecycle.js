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
// 时生成交接清单，每一项都完成后才会执行删除。
// v3.5.49：清单不再靠人打勾——能从系统里查到的都由系统核验：
//   · 通讯录成员（ext）：该成员在企业微信里已删除 / 禁用 / 离职（实时查企业微信，或同步已不再包含他）
//   · 组织 / 分组管理员（role）、名下设备（device）：数据库里这层关系真的没了
//   · 三方登录绑定（bind）：执行删除时由系统自动解除并封存，不挡执行
//   · 只有「重要应用」（app）系统查不到，要管理员确认（本人不能自己勾）
// 执行删除时：三方登录绑定、通讯录映射一律从账号上摘掉并封存（identity_blocks）——保留期内不能再用它登录、同步也不会给它重新建号；恢复账号时放回。
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
    items.push({ key: `ext:${l.source_id}:${l.ext_id}`, kind: 'external', check: 'ext', source_id: l.source_id, ext_id: l.ext_id,
      label: `${l.org || ''} · ${l.label || l.type} 的账号 ${l.ext_id}：在${PLATFORM_ZH[l.type] || l.type}里删除或禁用该成员（系统核验）` });
  }
  for (const o of db.prepare('SELECT provider, open_id FROM user_oauth WHERE user_id=?').all(user.id)) {
    const platform = String(o.provider).split(':')[0];
    if (!PLATFORM_ZH[platform] || extKeys.has(o.open_id)) continue;
    items.push({ key: `bind:${o.provider}:${o.open_id}`, kind: 'external', check: 'bind', auto: true, provider: o.provider, ext_id: o.open_id,
      label: `${PLATFORM_ZH[platform]}登录账号 ${o.open_id}：删除时系统自动解除绑定并封存（之后不能再用它登录）` });
  }
  for (const r of db.prepare('SELECT a.subject_id, s.name FROM oauth_subject_admins a JOIN oauth_subjects s ON s.id=a.subject_id WHERE a.user_id=?').all(user.id))
    items.push({ key: `orgadmin:${r.subject_id}`, kind: 'role', check: 'orgadmin', label: `组织「${r.name}」的组织管理员职责交给别人（取消他的组织管理员后自动完成）` });
  for (const r of db.prepare('SELECT a.group_id, g.name FROM group_admins a JOIN user_groups g ON g.id=a.group_id WHERE a.user_id=?').all(user.id))
    items.push({ key: `groupadmin:${r.group_id}`, kind: 'role', check: 'groupadmin', label: `分组「${r.name}」的分组管理员职责交给别人（取消他的分组管理员后自动完成）` });
  for (const a of db.prepare(`SELECT a.id, a.name FROM apps a JOIN user_app_auth ua ON ua.app_id=a.id
      WHERE ua.user_id=? AND COALESCE(a.handover_required,0)=1`).all(user.id))
    items.push({ key: `app:${a.id}`, kind: 'app', check: 'app', label: `应用「${a.name}」里的数据 / 职责已交接（由管理员确认）` });
  for (const d of db.prepare('SELECT id, name FROM devices WHERE owner_user_id=?').all(user.id))
    items.push({ key: `device:${d.id}`, kind: 'device', check: 'device', label: `设备「${d.name}」回收或转交（设备的所有者改掉后自动完成）` });
  return items;
}

const reqStmts = {
  pendingOf: db.prepare("SELECT * FROM account_deletions WHERE user_id=? AND status='pending' ORDER BY created_at DESC"),
  latestOf:  db.prepare('SELECT * FROM account_deletions WHERE user_id=? ORDER BY created_at DESC'),
  get:       db.prepare('SELECT * FROM account_deletions WHERE id=?'),
};
// 清单项是否完成：能核验的按数据库实际情况算，存的勾选只对 app 项有效
const DONE_WITH = { gone: '企业微信里已没有该成员', disabled: '企业微信里已禁用', quit: '企业微信里已退出企业', kept: '管理员确认只删本系统账号，企业微信成员保留' };
function itemCheck(i) {
  if (!i.check) {   // v3.5.48 之前生成的清单项：从 key 推回去
    const [k] = String(i.key).split(':');
    i.check = { ext: 'ext', bind: 'bind', orgadmin: 'orgadmin', groupadmin: 'groupadmin', app: 'app', device: 'device' }[k] || 'app';
    if (i.check === 'ext') { const m = String(i.key).match(/^ext:([^:]+):(.+)$/); if (m) { i.source_id = m[1]; i.ext_id = m[2]; } }
    if (i.check === 'bind') i.auto = true;
  }
  return i.check;
}
// 企业微信登录绑定对应的通讯录（同一企业配了同步源 / 文件夹通讯录才有）：有就能实时核验、禁用、删除这个成员（v3.5.57）
// 返回同步源 id（文件夹通讯录返回连接 id），优先有「管理用 Secret」的、启用的
function wecomSourceFor(provider) {
  const W = require('./dirsync-wecom');
  const corp = W.corpOfProvider(provider);
  if (!corp) return null;
  const rows = [...W.corpScope(corp).sources].map(id => db.prepare('SELECT * FROM dir_sync_sources WHERE id=?').get(id)).filter(Boolean)
    .map(s => (s.parent_id && db.prepare('SELECT * FROM dir_sync_sources WHERE id=?').get(s.parent_id)) || s);
  const score = s => { const c = W.effectiveCfg(s); return (c.write_secret ? 4 : 0) + (s.enabled ? 2 : 0) + (c.secret ? 1 : 0); };
  rows.sort((a, b) => score(b) - score(a));
  return rows[0] ? rows[0].id : null;
}
// v3.5.57 之前：企业微信登录绑定一律「删除时自动解除」，不挡执行——于是账号删了、企业微信里人还在职。
// 现在同企业有通讯录可查时，把它当成通讯录成员核验（旧申请里的这类项读取时一并升级）。
function upgradeBind(i) {
  if (itemCheck(i) !== 'bind') return i;
  let provider = i.provider, ext = i.ext_id;
  if (!provider) {   // 旧清单项只有 key：bind:wecom:<UserId> 或 bind:wecom:<凭证 id>:<UserId>
    const m = String(i.key).match(/^bind:wecom:(.+)$/); if (!m) return i;
    const j = m[1].indexOf(':'), cid = j > 0 ? m[1].slice(0, j) : '';
    if (cid && db.prepare("SELECT 1 FROM oauth_providers WHERE id=? AND platform='wecom'").get(cid)) { provider = 'wecom:' + cid; ext = m[1].slice(j + 1); }
    else { provider = 'wecom'; ext = m[1]; }
  }
  if (String(provider).split(':')[0] !== 'wecom') return i;
  const sid = wecomSourceFor(provider);
  if (!sid) return i;
  return { ...i, check: 'ext', auto: false, provider, ext_id: ext, source_id: sid,
    label: `企业微信登录账号 ${ext}：在企业微信里删除或禁用该成员（系统核验）` };
}
function evalItem(userId, i, executed) {
  if (!executed) i = upgradeBind(i);
  const c = itemCheck(i);
  const id = String(i.key).split(':').slice(1).join(':');
  let done = false, note = '';
  if (c === 'app') { done = !!i.done; note = i.done ? '管理员已确认' : '等待管理员确认'; }
  else if (c === 'bind') { done = true; note = executed ? '已解除并封存' : '删除时自动解除并封存'; }
  else if (c === 'ext') {
    const linked = i.provider   // 登录绑定升级来的：看绑定还在不在，而不是同步映射
      ? db.prepare('SELECT 1 FROM user_oauth WHERE provider=? AND open_id=? AND user_id=?').get(i.provider, i.ext_id, userId)
      : db.prepare('SELECT 1 FROM dir_source_links WHERE source_id=? AND ext_id=? AND user_id=?').get(i.source_id, i.ext_id, userId);
    const v = i.verified;
    if (v && DONE_WITH[v.status]) { done = true; note = DONE_WITH[v.status] + `（${String(v.at).slice(0, 16)} 核验）`; }
    else if (!linked) { done = true; note = executed ? '已解除并封存' : '同步已不再包含该成员'; }
    else note = v ? (v.status === 'active' ? `企业微信里该成员仍在职（${String(v.at).slice(0, 16)} 核验）` : `核验失败：${v.error || v.status}`) : '尚未核验';
  }
  else if (c === 'orgadmin') { done = !db.prepare('SELECT 1 FROM oauth_subject_admins WHERE subject_id=? AND user_id=?').get(id, userId); note = done ? '已不是组织管理员' : '仍是组织管理员'; }
  else if (c === 'groupadmin') { done = !db.prepare('SELECT 1 FROM group_admins WHERE group_id=? AND user_id=?').get(id, userId); note = done ? '已不是分组管理员' : '仍是分组管理员'; }
  else if (c === 'device') { done = !db.prepare('SELECT 1 FROM devices WHERE id=? AND owner_user_id=?').get(id, userId); note = done ? '设备已不在他名下' : '设备仍在他名下'; }
  if (executed && !done) { done = true; note = '已随账号删除处理'; }
  return { ...i, done, note, manual: c === 'app' };
}
function parseReq(r) {
  if (!r) return null;
  let checklist = [];
  try { checklist = JSON.parse(r.checklist || '[]'); } catch (_) {}
  checklist = checklist.map(i => evalItem(r.user_id, i, r.status === 'done'));
  const { ext_snapshot, ...rest } = r;
  return { ...rest, checklist, checklist_done: checklist.every(i => i.done) };
}
function saveChecklist(id, list) {
  const stored = list.map(({ done, note, manual, ...i }) => (i.check === 'app' ? { ...i, done } : i));
  db.prepare("UPDATE account_deletions SET checklist=?, updated_at=datetime('now') WHERE id=?").run(JSON.stringify(stored), id);
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

// 只有「重要应用」这类系统查不到的项能手动确认（由调用方保证是管理员）；其余由系统核验
function setChecklist(id, key, done, by) {
  const r = getReq(id);
  if (!r || r.status !== 'pending') fail('申请不存在或已结束', 404);
  const it = r.checklist.find(i => i.key === key);
  if (!it) fail('交接项不存在', 404);
  if (!it.manual) fail('这一项由系统核验，不能手动勾选：' + (it.check === 'ext' ? '先在企业微信里删除或禁用该成员，再点「重新核验」' : it.check === 'bind' ? '删除时会自动解除' : '处理完后会自动完成'));
  it.done = !!done; it.done_by = done ? by : null; it.done_at = done ? sqlTime() : null;
  saveChecklist(id, r.checklist);
  tryExecute(id);
  return getReq(id);
}
// 记下某个通讯录成员的实时核验结果（status: active / disabled / quit / gone / unknown）
function setVerification(id, key, verified) {
  const r = getReq(id);
  if (!r || r.status !== 'pending') fail('申请不存在或已结束', 404);
  const it = r.checklist.find(i => i.key === key);
  if (!it || it.check !== 'ext') fail('交接项不存在', 404);
  it.verified = { ...verified, at: sqlTime() };
  saveChecklist(id, r.checklist);
  tryExecute(id);
  return getReq(id);
}

// ── 三方身份摘除 / 封存 / 放回 ──
const blockId = () => crypto.randomUUID();
function connOf(sourceId) {
  const s = db.prepare('SELECT id, parent_id FROM dir_sync_sources WHERE id=?').get(sourceId);
  return s ? (s.parent_id || s.id) : sourceId;
}
// 执行删除时：三方登录绑定、通讯录映射从账号上摘掉（快照存进申请，恢复用），外部身份封存
function detachExternal(userId, deletionId) {
  const oauthRows = db.prepare('SELECT * FROM user_oauth WHERE user_id=?').all(userId);
  const linkRows = db.prepare('SELECT * FROM dir_source_links WHERE user_id=?').all(userId);
  if (!oauthRows.length && !linkRows.length) return { oauth: 0, links: 0 };
  db.transaction(() => {
    const ins = db.prepare('INSERT INTO identity_blocks (id,user_id,deletion_id,kind,provider,conn_id,ext_id) VALUES (?,?,?,?,?,?,?)');
    for (const o of oauthRows) ins.run(blockId(), userId, deletionId, 'oauth', o.provider, null, o.open_id);
    for (const l of linkRows) ins.run(blockId(), userId, deletionId, 'dir', null, connOf(l.source_id), l.ext_id);
    if (deletionId) {
      const prev = db.prepare('SELECT ext_snapshot FROM account_deletions WHERE id=?').get(deletionId);
      let snap = { oauth: [], links: [] }; try { if (prev && prev.ext_snapshot) snap = JSON.parse(prev.ext_snapshot); } catch (_) {}
      snap.oauth.push(...oauthRows); snap.links.push(...linkRows);
      db.prepare('UPDATE account_deletions SET ext_snapshot=? WHERE id=?').run(JSON.stringify(snap), deletionId);
    }
    db.prepare('DELETE FROM user_oauth WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM dir_source_links WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM dir_sync_applied WHERE user_id=?').run(userId);
  })();
  return { oauth: oauthRows.length, links: linkRows.length };
}
// 恢复账号时：解封并把绑定 / 映射放回（期间已被别人占用的跳过）
function reattachExternal(userId) {
  const out = { oauth: 0, links: 0, skipped: 0 };
  db.transaction(() => {
    for (const r of db.prepare("SELECT ext_snapshot FROM account_deletions WHERE user_id=? AND ext_snapshot IS NOT NULL ORDER BY created_at").all(userId)) {
      let snap = {}; try { snap = JSON.parse(r.ext_snapshot); } catch (_) {}
      for (const o of snap.oauth || []) {
        if (db.prepare('SELECT 1 FROM user_oauth WHERE provider=? AND open_id=?').get(o.provider, o.open_id)) { out.skipped++; continue; }
        const cols = Object.keys(o);
        db.prepare(`INSERT INTO user_oauth (${cols.map(c => '"' + c + '"').join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map(c => o[c]));
        out.oauth++;
      }
      for (const l of snap.links || []) {
        if (!db.prepare('SELECT 1 FROM dir_sync_sources WHERE id=?').get(l.source_id) || db.prepare('SELECT 1 FROM dir_source_links WHERE source_id=? AND ext_id=?').get(l.source_id, l.ext_id)) { out.skipped++; continue; }
        const cols = Object.keys(l);
        db.prepare(`INSERT INTO dir_source_links (${cols.map(c => '"' + c + '"').join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map(c => l[c]));
        out.links++;
      }
    }
    db.prepare('UPDATE account_deletions SET ext_snapshot=NULL WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM identity_blocks WHERE user_id=?').run(userId);
  })();
  return out;
}
// 该外部身份是否已封存（属于已删除的账号）
const isBlockedOauth = (provider, openId) => !!db.prepare("SELECT 1 FROM identity_blocks WHERE kind='oauth' AND provider=? AND ext_id=?").get(provider, openId);
const isBlockedDir = (connId, extId) => !!db.prepare("SELECT 1 FROM identity_blocks WHERE kind='dir' AND conn_id=? AND ext_id=?").get(connId, extId);
// 升级前已删除、绑定还挂着的账号：启动时补摘
function detachLegacyDeleted() {
  let n = 0;
  for (const u of db.prepare("SELECT id FROM users WHERE deletion_state='deleted' AND (EXISTS (SELECT 1 FROM user_oauth o WHERE o.user_id=users.id) OR EXISTS (SELECT 1 FROM dir_source_links l WHERE l.user_id=users.id))").all()) {
    const d = db.prepare("SELECT id FROM account_deletions WHERE user_id=? AND status='done' ORDER BY created_at DESC").get(u.id);
    try { const r = detachExternal(u.id, d ? d.id : null); if (r.oauth || r.links) n++; } catch (e) { console.warn('[删除账号补摘三方绑定]', u.id, e.message); }
  }
  return n;
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
  // 先通知（同步暂停企业微信成员要靠映射找到他），再把三方身份摘掉并封存
  if (hooks.onDeleted) { try { hooks.onDeleted(users.findById.get(u.id)); } catch (_) {} }
  const detached = detachExternal(u.id, r.id);
  log('account.deleted', u, r.approved_by || r.requested_by, { id: r.id, kind: r.kind, purge_at, detached });
}

// 保留期内恢复
function restore(user, by) {
  if (!user || user.deletion_state !== 'deleted') fail('该账号不是「已删除」状态');
  if (user.purge_at && user.purge_at <= sqlTime()) fail('已过保留期，无法恢复');
  db.transaction(() => {
    db.prepare(`UPDATE users SET status='active', deletion_state=NULL, deleted_at=NULL, purge_at=NULL, updated_at=datetime('now') WHERE id=?`).run(user.id);
    db.prepare("UPDATE account_deletions SET status='restored', updated_at=datetime('now') WHERE user_id=? AND status='done'").run(user.id);
  })();
  const reattached = reattachExternal(user.id);   // 先放回映射，再通知（同步启用企业微信成员要靠映射）
  log('account.restored', user, by, { reattached });
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

module.exports = { wecomSourceFor, detachExternal, reattachExternal, isBlockedOauth, isBlockedDir, detachLegacyDeleted, setVerification, connOf, init, config, preflight, request, setChecklist, approve, cancel, reject, tryExecute, restore, purge, tick, pendingOf, getReq, sqlTime };
