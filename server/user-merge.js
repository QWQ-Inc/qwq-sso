// 同一人多个账号合并（v3.5.41）
//
// 场景：一个人在企业微信（或类似通讯录）里有好几个账号（多个 UserId，或在多家企业里各有一个），
// 而企业微信拿不到手机/邮箱（2022 年起不下发），同步时没法认出是同一人 → 每个 UserId 各建了一个账号。
//
// 合并 = 把「被合并账号」身上的身份与归属搬到「保留账号」上，然后停用被合并账号并记下 merged_into：
//   · 登录绑定 user_oauth（所以之后用其中任何一个企业微信账号登录，都落到保留账号）
//   · 通讯录同步映射 dir_source_links（之后同步，这几个 UserId 都指向保留账号，不会再建号）
//   · 组织成员关系（保留账号已在该组织则去重；组织内 UID / 组织密码保留账号没有时接过来）
//   · 组织管理员 / 分组管理员 / 公共账号授权、Passkey、备忘录、门禁卡、积分（累加并记明细）
//   · 保留账号没有的邮箱 / 手机 / 实名信息接过来
// 被合并账号对第三方应用的授权与令牌作废（并按应用配置推送撤销），历史记录（登录日志等）留在原行上可查。
const crypto = require('crypto');
const { db, users } = require('./db');

const q = {
  memberships: db.prepare('SELECT * FROM org_members WHERE user_id=?'),
  memberOf:    db.prepare('SELECT * FROM org_members WHERE subject_id=? AND user_id=?'),
  orgCount:    db.prepare('SELECT COUNT(*) AS n FROM org_members WHERE user_id=?'),
  passkeys:    db.prepare('SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id=?'),
  hasFace:     db.prepare('SELECT 1 FROM access_faces WHERE user_id=?'),
};

// 「空壳账号」：同步/导入时自动建的、本人从没用它做过什么、也没有任何能单独登录的凭据。
// 用户本人证明了自己拥有它绑定的三方账号（比如用那个企业微信账号走一遍登录）时，可以直接并进本人账号。
function isShellAccount(u) {
  if (!u || u.is_public || u.role === 'admin') return false;
  if (u.password_hash || u.email || u.phone || u.kyc_verified || u.twofa_enabled) return false;
  if (q.passkeys.get(u.id).n) return false;
  return q.memberships.all(u.id).every(m => m.source !== 'manual');
}

// 合并前检查；返回错误文案或 null
function checkMerge(target, sources) {
  if (!target) return '保留账号不存在';
  if (target.is_public) return '公共账号不能参与合并';
  if (target.status === 'disabled' && target.merged_into) return '保留账号已被合并到别的账号';
  if (!sources.length) return '请至少选择一个要合并的账号';
  if (sources.length > 20) return '一次最多合并 20 个账号';
  const seen = new Set([target.id]);
  for (const s of sources) {
    if (!s) return '要合并的账号不存在';
    if (seen.has(s.id)) return '保留账号与要合并的账号不能重复';
    seen.add(s.id);
    if (s.is_public) return '公共账号不能参与合并';
    if (s.role === 'admin') return `「${s.name}」是管理员账号，不能被合并；请把它选为保留账号`;
    if (s.merged_into) return `「${s.name}」已经合并过了`;
    if (s.kyc_verified && target.kyc_verified && s.kyc_pseudonym && target.kyc_pseudonym && s.kyc_pseudonym !== target.kyc_pseudonym)
      return `「${s.name}」与保留账号实名的不是同一个人，不能合并`;
  }
  return null;
}

// 执行合并（事务）。返回 { merged, moved:{...} }
function mergeUsers(targetId, sourceIds, { reason = '', onAppRevoked = null, actor = '', actorUid = null, via = '' } = {}) {
  const target = users.findById.get(targetId);
  const sources = sourceIds.map(id => users.findById.get(id));
  const err = checkMerge(target, sources);
  if (err) { const e = new Error(err); e.status = 400; throw e; }

  const moved = { oauth: 0, links: 0, orgs: 0, points: 0 };
  const run = (sql, ...a) => db.prepare(sql).run(...a);
  const pushOut = [];   // 被合并账号授权过的应用（事务外推送撤销）
  try {
    const { apps } = require('./db');
    for (const s of sources) pushOut.push({ s, list: apps.getUserApps.all(s.id) });
  } catch (_) {}

  // v3.5.48：合并记录 + 改动日志（撤销用）。日志靠临时触发器记下事务里每一行的增删改，事务结束就拆掉触发器
  const mergeId = crypto.randomUUID();
  const days = undoDays();
  const stopJournal = days > 0 ? startJournal(mergeId) : () => {};
  try {
  db.transaction(() => {
    db.prepare('INSERT INTO merge_records (id,target_id,target,sources,via,actor,actor_uid,journal,undo_note) VALUES (?,?,?,?,?,?,?,?,?)').run(
      mergeId, target.id, JSON.stringify({ name: target.name, uid_seq: target.uid_seq, uid_code: target.uid_code || null }),
      JSON.stringify(sources.map(s => ({ id: s.id, uid_seq: s.uid_seq, uid_code: s.uid_code || null, name: s.name, email: s.email || null, phone: s.phone || null }))),
      via || null, actor || null, actorUid || null, days > 0 ? 1 : 0, reason || null);
    for (const s of sources) {
      const t = users.findById.get(target.id);   // 每轮取最新（邮箱/手机/实名可能刚接过来）
      moved.oauth += run('UPDATE user_oauth SET user_id=? WHERE user_id=?', t.id, s.id).changes;
      moved.links += run('UPDATE dir_source_links SET user_id=? WHERE user_id=?', t.id, s.id).changes;
      run('DELETE FROM dir_sync_applied WHERE user_id=?', s.id);   // 下次同步会按保留账号重新记

      // 组织成员关系
      for (const m of q.memberships.all(s.id)) {
        const tm = q.memberOf.get(m.subject_id, t.id);
        if (!tm) {
          run('UPDATE org_members SET user_id=? WHERE subject_id=? AND user_id=?', t.id, m.subject_id, s.id);
        } else {
          run('DELETE FROM org_members WHERE subject_id=? AND user_id=?', m.subject_id, s.id);
          if (!tm.org_uid && m.org_uid) run('UPDATE org_members SET org_uid=? WHERE subject_id=? AND user_id=?', m.org_uid, m.subject_id, t.id);
          if (!tm.password_hash && m.password_hash) run('UPDATE org_members SET password_hash=? WHERE subject_id=? AND user_id=?', m.password_hash, m.subject_id, t.id);
          if (tm.source === 'manual' && m.source !== 'manual') { /* 手动加入的保持手动，同步不会把他移出 */ }
        }
        moved.orgs++;
      }
      run('INSERT OR IGNORE INTO oauth_subject_admins (subject_id,user_id) SELECT subject_id, ? FROM oauth_subject_admins WHERE user_id=?', t.id, s.id);
      run('DELETE FROM oauth_subject_admins WHERE user_id=?', s.id);
      run('INSERT OR IGNORE INTO group_admins (group_id,user_id) SELECT group_id, ? FROM group_admins WHERE user_id=?', t.id, s.id);
      run('DELETE FROM group_admins WHERE user_id=?', s.id);
      run('INSERT OR IGNORE INTO public_account_members (public_id,user_id) SELECT public_id, ? FROM public_account_members WHERE user_id=?', t.id, s.id);
      run('DELETE FROM public_account_members WHERE user_id=?', s.id);

      // 本人的东西
      run('UPDATE webauthn_credentials SET user_id=? WHERE user_id=?', t.id, s.id);
      run('UPDATE memos SET owner_id=? WHERE owner_id=?', t.id, s.id);
      run('UPDATE access_cards SET user_id=? WHERE user_id=?', t.id, s.id);
      if (!q.hasFace.get(t.id)) run('UPDATE access_faces SET user_id=? WHERE user_id=?', t.id, s.id);
      const pts = Number(s.points || 0);
      if (pts > 0) {
        run("UPDATE users SET points=COALESCE(points,0)+?, updated_at=datetime('now') WHERE id=?", pts, t.id);
        run('INSERT INTO points_log (id,user_id,delta,reason) VALUES (?,?,?,?)', crypto.randomUUID(), t.id, pts, `账号合并：并入 ${s.name || ''} 的积分`);
        run('UPDATE users SET points=0 WHERE id=?', s.id);
        run('INSERT INTO points_log (id,user_id,delta,reason) VALUES (?,?,?,?)', crypto.randomUUID(), s.id, -pts, '账号合并：积分转入保留账号');
        moved.points += pts;
      }

      // 被合并账号对应用的授权、令牌作废
      run('DELETE FROM user_app_auth WHERE user_id=?', s.id);
      run('DELETE FROM oauth_access_tokens WHERE user_id=?', s.id);
      run('DELETE FROM oauth_auth_codes WHERE user_id=?', s.id);

      // 联系方式 / 实名：保留账号没有的接过来（先清被合并账号，避开唯一约束）
      const email = !t.email && s.email ? s.email : null;
      const phone = !t.phone && s.phone ? s.phone : null;
      run("UPDATE users SET status='disabled', merged_into=?, email=NULL, phone=NULL, updated_at=datetime('now') WHERE id=?", t.id, s.id);
      if (email) run('UPDATE users SET email=? WHERE id=?', email, t.id);
      if (phone) run('UPDATE users SET phone=? WHERE id=?', phone, t.id);
      if (!t.kyc_verified && s.kyc_verified) {
        run(`UPDATE users SET kyc_verified=1, kyc_name=?, kyc_id_tail=?, kyc_provider=?, kyc_verified_at=?, kyc_pseudonym=?, kyc_name_hash=? WHERE id=?`,
          s.kyc_name, s.kyc_id_tail, s.kyc_provider, s.kyc_verified_at, s.kyc_pseudonym, s.kyc_name_hash, t.id);
      }
      // v3.5.46.1：被合并账号不再保留——剩下的历史（登录日志、积分明细、兑换券、实名记录…）全部并到保留账号，然后删掉这个账号
      if (absorbAndDelete(s.id, t.id)) moved.deleted = (moved.deleted || 0) + 1;
    }
  })();
  } finally { stopJournal(); }

  // 事务外：通知被合并账号授权过的应用「这个身份没了」（应用自己按 merged_into 决定怎么处理本地账号）
  if (onAppRevoked) for (const { s, list } of pushOut) for (const a of list) { try { onAppRevoked(a, s, target); } catch (_) {} }

  return { merge_id: mergeId, undo_days: days, merged: sources.map(s => ({ id: s.id, uid_seq: s.uid_seq, name: s.name })), target: { id: target.id, uid_seq: target.uid_seq, name: target.name }, moved, reason };
}

// 把 sourceId 名下剩下的所有数据并到 targetId，再删掉 sourceId 这个账号行（须在事务里调用）。
// 返回 true = 账号行已删除；false = 仍有未知外键挡着，退化成抹掉个人信息的「已合并」占位（不会再出现在列表里）。
const NOT_MOVED = new Set(['twofa_recovery_codes', 'kyc_pending', 'account_deletions', 'dir_sync_applied',
  'user_app_auth', 'oauth_access_tokens', 'oauth_auth_codes', 'audit_chain', 'users']);   // 这些直接删掉，不转给保留账号
const REF_COLS = ['owner_user_id', 'created_by', 'granted_by', 'requested_by', 'approved_by', 'issued_by', 'escort_user_id', 'done_by'];
function absorbAndDelete(sourceId, targetId) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
  for (const t of tables) {
    if (t === 'users' || t === 'audit_chain') continue;
    const cols = db.prepare(`PRAGMA table_info("${t}")`).all().map(c => c.name);
    for (const c of ['user_id', 'owner_id']) {
      if (!cols.includes(c)) continue;
      if (!NOT_MOVED.has(t)) db.prepare(`UPDATE OR IGNORE "${t}" SET "${c}"=? WHERE "${c}"=?`).run(targetId, sourceId);
      db.prepare(`DELETE FROM "${t}" WHERE "${c}"=?`).run(sourceId);   // 撞了唯一约束没搬走的（保留账号已有同样一条）直接删
    }
    for (const c of REF_COLS) if (cols.includes(c)) db.prepare(`UPDATE "${t}" SET "${c}"=? WHERE "${c}"=?`).run(targetId, sourceId);
  }
  db.prepare('UPDATE users SET merged_into=? WHERE merged_into=?').run(targetId, sourceId);
  try { db.prepare('DELETE FROM users WHERE id=?').run(sourceId); return true; }
  catch (_) {
    db.prepare(`UPDATE users SET name='已合并账号', uid_code=NULL, password_hash=NULL, twofa_secret=NULL, twofa_enabled=0, kyc_verified=0,
      kyc_name=NULL, kyc_id_tail=NULL, kyc_pseudonym=NULL, kyc_name_hash=NULL, deletion_state='purged' WHERE id=?`).run(sourceId);
    return false;
  }
}

// 升级前已经合并过的账号（还留着「已合并」的那些）：启动时一次性并掉。保留账号已不存在的不动，交给注销清理流程。
function absorbLegacyMerged() {
  const rows = db.prepare(`SELECT s.id, s.merged_into FROM users s JOIN users t ON t.id=s.merged_into
    WHERE s.merged_into IS NOT NULL AND COALESCE(s.deletion_state,'')<>'purged'`).all();
  let n = 0;
  for (const r of rows) {
    try { db.transaction(() => { if (absorbAndDelete(r.id, r.merged_into)) n++; })(); } catch (e) { console.warn('[合并账号清理]', r.id, e.message); }
  }
  return n;
}

// ══════════════════════════════════════════
// 撤销合并（v3.5.48）
//   合并时：给每张表建临时触发器，把事务里的每次 INSERT / UPDATE / DELETE 记进 merge_journal（旧行、新行，BLOB 存 hex）。
//   撤销时：倒着放——插入的删掉、删除的原样插回（同 rowid）、修改的改回去。
//   修改只改回「合并后没再被动过」的字段（当前值 = 合并后的值）；合并之后又被改过的字段保留现值，计入 kept。
//   必须按时间倒序撤销：同一批账号后来又参与过、且还没撤销的合并，要先撤销那一次。
// ══════════════════════════════════════════
const JOURNAL_SKIP = new Set(['merge_journal', 'merge_records', 'audit_chain', 'sqlite_sequence']);
const qi = s => '"' + String(s).replace(/"/g, '""') + '"';
const ql = s => "'" + String(s).replace(/'/g, "''") + "'";
const colsOf = t => db.prepare(`PRAGMA table_info(${qi(t)})`).all().map(c => c.name);
function undoDays() {
  const v = parseInt(process.env.MERGE_UNDO_DAYS, 10);
  return Number.isFinite(v) ? Math.min(365, Math.max(0, v)) : 30;
}
function rowExpr(p, cols) {
  return 'json_object(' + cols.map(c => `${ql(c)}, json_array(typeof(${p}.${qi(c)}), CASE typeof(${p}.${qi(c)}) WHEN 'blob' THEN hex(${p}.${qi(c)}) ELSE ${p}.${qi(c)} END)`).join(', ') + ')';
}
function startJournal(mergeId) {
  const made = [];
  try {
    for (const { name: t, sql } of db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      if (JOURNAL_SKIP.has(t) || /WITHOUT\s+ROWID/i.test(sql || '')) continue;
      const cols = colsOf(t); if (!cols.length) continue;
      const k = '_mj' + made.length;
      const ins = (op, rid, o, n) => `INSERT INTO merge_journal (merge_id,tbl,op,rid,old_row,new_row) VALUES (${ql(mergeId)},${ql(t)},'${op}',${rid},${o},${n});`;
      db.exec(`CREATE TEMP TRIGGER ${k}i AFTER INSERT ON main.${qi(t)} BEGIN ${ins('I', 'NEW.rowid', 'NULL', 'NULL')} END`);
      db.exec(`CREATE TEMP TRIGGER ${k}u AFTER UPDATE ON main.${qi(t)} BEGIN ${ins('U', 'OLD.rowid', rowExpr('OLD', cols), rowExpr('NEW', cols))} END`);
      db.exec(`CREATE TEMP TRIGGER ${k}d AFTER DELETE ON main.${qi(t)} BEGIN ${ins('D', 'OLD.rowid', rowExpr('OLD', cols), 'NULL')} END`);
      made.push(k);
    }
  } catch (e) { stop(); throw e; }
  function stop() { for (const k of made) for (const x of 'iud') { try { db.exec(`DROP TRIGGER IF EXISTS temp.${k}${x}`); } catch (_) {} } }
  return stop;
}
const decodeVal = ([type, v]) => type === 'blob' ? Buffer.from(String(v), 'hex') : v;
const sameVal = (a, b) => (Buffer.isBuffer(a) || Buffer.isBuffer(b)) ? (Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b)) : a === b;

function getMerge(id) { return db.prepare('SELECT rowid AS _rid, * FROM merge_records WHERE id=?').get(id); }
function mergeIds(rec) { let src = []; try { src = JSON.parse(rec.sources || '[]'); } catch (_) {} return new Set([rec.target_id, ...src.map(x => x.id)]); }
// 能否撤销；返回错误文案或 null
function undoBlocker(rec) {
  if (!rec) return '合并记录不存在';
  if (rec.undone_at) return '这次合并已经撤销过了';
  if (!rec.journal) return '这次合并没有可用的改动日志（超过撤销期限，或发生在可撤销功能上线之前），不能撤销；只能从数据备份恢复';
  const ids = mergeIds(rec);
  for (const later of db.prepare('SELECT rowid AS _rid, * FROM merge_records WHERE rowid>? AND undone_at IS NULL').all(rec._rid)) {
    const lids = mergeIds(later);
    if ([...ids].some(x => lids.has(x))) return `这些账号之后又参与了一次合并（${String(later.created_at).slice(0, 16)}），请先撤销那一次`;
  }
  return null;
}
function undoMerge(mergeId, { by = null } = {}) {
  const rec = getMerge(mergeId);
  const err = undoBlocker(rec);
  if (err) { const e = new Error(err); e.status = 400; throw e; }
  const stats = { restored_rows: 0, kept_fields: 0, skipped: 0 };
  const colCache = {};
  const cols = t => colCache[t] || (colCache[t] = new Set(colsOf(t)));
  db.transaction(() => {
    db.pragma('defer_foreign_keys = ON');   // 倒放时父子行的顺序不一定对，外键到提交时再查
    for (const j of db.prepare('SELECT * FROM merge_journal WHERE merge_id=? ORDER BY seq DESC').all(mergeId)) {
      let have;
      try { have = cols(j.tbl); } catch (_) { stats.skipped++; continue; }
      if (!have.size) { stats.skipped++; continue; }
      const T = qi(j.tbl);
      if (j.op === 'I') {
        stats.restored_rows += db.prepare(`DELETE FROM ${T} WHERE rowid=?`).run(j.rid).changes;
      } else if (j.op === 'D') {
        const old = JSON.parse(j.old_row || '{}');
        const keys = Object.keys(old).filter(c => have.has(c));
        if (db.prepare(`SELECT 1 FROM ${T} WHERE rowid=?`).get(j.rid)) { stats.skipped++; continue; }
        db.prepare(`INSERT INTO ${T} (rowid, ${keys.map(qi).join(',')}) VALUES (?, ${keys.map(() => '?').join(',')})`).run(j.rid, ...keys.map(c => decodeVal(old[c])));
        stats.restored_rows++;
      } else if (j.op === 'U') {
        const old = JSON.parse(j.old_row || '{}'), neu = JSON.parse(j.new_row || '{}');
        const cur = db.prepare(`SELECT * FROM ${T} WHERE rowid=?`).get(j.rid);
        if (!cur) { stats.skipped++; continue; }
        const sets = [], vals = [];
        for (const c of Object.keys(old)) {
          if (!have.has(c) || !neu[c]) continue;
          const o = decodeVal(old[c]), n = decodeVal(neu[c]);
          if (sameVal(o, n)) continue;
          if (sameVal(cur[c], n)) { sets.push(`${qi(c)}=?`); vals.push(o); }
          else stats.kept_fields++;      // 合并后又被改过：保留现值
        }
        if (sets.length) { db.prepare(`UPDATE ${T} SET ${sets.join(',')} WHERE rowid=?`).run(...vals, j.rid); stats.restored_rows++; }
      }
    }
    db.prepare("UPDATE merge_records SET undone_at=datetime('now'), undone_by=?, journal=0 WHERE id=?").run(by, mergeId);
    db.prepare('DELETE FROM merge_journal WHERE merge_id=?').run(mergeId);
  })();
  return { record: getMerge(mergeId), stats };
}
// 过了撤销期限的日志清掉（里面有被删账号的完整数据）；保留账号已不存在的也清掉
function purgeMergeJournals() {
  const days = undoDays();
  const rows = db.prepare(`SELECT id FROM merge_records WHERE journal=1 AND (created_at < datetime('now', ?) OR target_id NOT IN (SELECT id FROM users))`).all(`-${days} days`);
  for (const r of rows) db.transaction(() => {
    db.prepare('DELETE FROM merge_journal WHERE merge_id=?').run(r.id);
    db.prepare('UPDATE merge_records SET journal=0 WHERE id=?').run(r.id);
  })();
  return rows.length;
}

module.exports = { mergeUsers, checkMerge, isShellAccount, absorbLegacyMerged, undoMerge, undoBlocker, getMerge, purgeMergeJournals, undoDays };
