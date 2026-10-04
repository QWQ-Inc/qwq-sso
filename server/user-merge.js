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
function mergeUsers(targetId, sourceIds, { reason = '', onAppRevoked = null } = {}) {
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

  db.transaction(() => {
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
    }
  })();

  // 事务外：通知被合并账号授权过的应用「这个身份没了」（应用自己按 merged_into 决定怎么处理本地账号）
  if (onAppRevoked) for (const { s, list } of pushOut) for (const a of list) { try { onAppRevoked(a, s, target); } catch (_) {} }

  return { merged: sources.map(s => ({ id: s.id, uid_seq: s.uid_seq, name: s.name })), target: { id: target.id, uid_seq: target.uid_seq, name: target.name }, moved, reason };
}

module.exports = { mergeUsers, checkMerge, isShellAccount };
