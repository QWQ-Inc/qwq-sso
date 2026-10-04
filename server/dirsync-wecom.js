// 企业微信通讯录同步（v3.5.35）：把企业微信某个部门（含子部门）下的成员同步成本系统某个组织的成员。
//
// 企业微信没有标准 SCIM，这里走它自己的通讯录 API（拉取式）：
//   gettoken → department/list（部门名）→ user/list?fetch_child=1（成员详情）
//   user/list 被企业微信收紧权限时，回退 user/list_id（分页拿 userid）+ user/get（逐个取详情）
//
// 匹配同一自然人的顺序（越靠前越可靠）：
//   ① dir_sync_links（本组织历次同步留下的 UserId → 用户映射）
//   ② user_oauth（该企业微信的登录凭证下已绑定这个 UserId——用户以前用企业微信登录过）
//   ③ 邮箱（email / biz_mail）④ 手机 ⑤ 都没有 → 新建账号
// 同步后把 UserId 绑定到该企业微信的登录凭证（若本系统配了同一 corp 的企业微信登录），
// 这样成员之后用企业微信登录会落到同一个账号，而不是再建一个。
//
// 离职 / 禁用（status 2、5）或已不在同步范围的成员：从组织里移出（只动 source='wecom' 的成员，手动加入的不动）。
// ⚠️ 防误删：本次一个人都没拉到时不做任何移除（多半是权限/部门配置错了）。
const crypto = require('crypto');
const { db, users, oauth, orgMembers, oauthSubjects } = require('./db');

const linkGet    = db.prepare('SELECT * FROM dir_sync_links WHERE subject_id=? AND ext_id=?');
const linkUpsert = db.prepare(`INSERT INTO dir_sync_links (subject_id, ext_id, user_id, depts, updated_at) VALUES (?,?,?,?,datetime('now'))
  ON CONFLICT(subject_id, ext_id) DO UPDATE SET user_id=excluded.user_id, depts=excluded.depts, updated_at=datetime('now')`);
const linksOf    = db.prepare('SELECT * FROM dir_sync_links WHERE subject_id=?');
const linkDelete = db.prepare('DELETE FROM dir_sync_links WHERE subject_id=? AND ext_id=?');
const userOauthOf = db.prepare('SELECT open_id FROM user_oauth WHERE user_id=? AND provider=?');
const wecomCredsOf = db.prepare("SELECT id, config FROM oauth_providers WHERE platform='wecom' AND subject_id=?");

function apiBase() { return String(process.env.WECOM_API_BASE || 'https://qyapi.weixin.qq.com').replace(/\/+$/, ''); }

async function call(method, path, params, body) {
  const url = new URL(apiBase() + path);
  Object.entries(params || {}).forEach(([k, v]) => { if (v !== undefined && v !== null) url.searchParams.set(k, String(v)); });
  const r = await fetch(url, {
    method, signal: AbortSignal.timeout(20000),
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`企业微信接口 HTTP ${r.status}`), { errcode: -1 });
  if (j.errcode) throw Object.assign(new Error(`企业微信 ${path} 失败：${j.errcode} ${j.errmsg || ''}`.trim()), { errcode: j.errcode });
  return j;
}

/** 从企业微信拉取：部门树（以 root 为根）+ 成员（含子部门） */
async function fetchDirectory(cfg) {
  const { access_token } = await call('GET', '/cgi-bin/gettoken', { corpid: cfg.corp_id, corpsecret: cfg.secret });
  const root = parseInt(cfg.dept_id, 10) || 1;
  const depts = (await call('GET', '/cgi-bin/department/list', { access_token, id: root })).department || [];
  const deptName = new Map(depts.map(d => [d.id, d.name]));
  const inScope = new Set(depts.map(d => d.id)); inScope.add(root);
  let members;
  try {
    members = (await call('GET', '/cgi-bin/user/list', { access_token, department_id: root, fetch_child: 1 })).userlist || [];
  } catch (e) {
    // 新建的自建应用拿不到 user/list：退回 list_id 分页 + user/get
    const ids = [];
    let cursor = '';
    for (let guard = 0; guard < 100; guard++) {
      const j = await call('POST', '/cgi-bin/user/list_id', { access_token }, { cursor, limit: 10000 });
      for (const du of j.dept_user || []) if (inScope.has(du.department)) ids.push(du.userid);
      if (!j.next_cursor) break;
      cursor = j.next_cursor;
    }
    const uniq = [...new Set(ids)].slice(0, 5000);
    members = [];
    for (let i = 0; i < uniq.length; i += 5) {
      const batch = await Promise.all(uniq.slice(i, i + 5).map(uid => call('GET', '/cgi-bin/user/get', { access_token, userid: uid }).catch(() => null)));
      batch.forEach(u => { if (u) members.push(u); });
    }
  }
  // 同一个人在多个部门会出现多次，按 userid 去重
  const byId = new Map();
  for (const m of members) if (m && m.userid && !byId.has(m.userid)) byId.set(m.userid, m);
  return { members: [...byId.values()], deptName };
}

/** 这家企业微信在本系统的「登录凭证」provider key（同 corp），用于绑定 UserId；没配企业微信登录则返回 null */
function loginProviderFor(subject, corpId) {
  for (const c of wecomCredsOf.all(subject.id)) {
    try { if (JSON.parse(c.config || '{}').WECOM_CORP_ID === corpId) return 'wecom:' + c.id; } catch (_) {}
  }
  if (process.env.WECOM_CORP_ID && process.env.WECOM_CORP_ID === corpId) return 'wecom';
  return null;
}

const ACTIVE = new Set([1, 4]);   // 1 已激活 / 4 未激活（还没加入企业微信，但在通讯录里）；2 禁用 / 5 退出企业 视为离开

/**
 * 执行一次同步。helpers：{ genOrgUid(subject), isEmail, isPhone }（复用 api.js 里的实现）。
 * 返回 { total, created, linked, added, removed, skipped, errors[], bind_provider }
 */
async function syncWecom(subject, cfg, helpers, fetcher = fetchDirectory) {
  const { members, deptName } = await fetcher(cfg);
  const bindProvider = loginProviderFor(subject, cfg.corp_id);
  const uidMode = cfg.uid_mode || 'userid';
  const out = { total: 0, created: 0, linked: 0, added: 0, removed: 0, skipped: 0, errors: [], bind_provider: bindProvider };
  const seenUsers = new Set();
  const seenExt = new Set();

  for (const m of members) {
    const extId = String(m.userid);
    if (!ACTIVE.has(Number(m.status ?? 1))) { out.skipped++; continue; }
    out.total++;
    seenExt.add(extId);
    const email = String(m.email || m.biz_mail || '').trim().toLowerCase();
    const phone = String(m.mobile || '').trim();
    const name = String(m.name || extId).trim().slice(0, 40);
    const depts = (Array.isArray(m.department) ? m.department : []).map(id => deptName.get(id) || String(id)).join(',');
    try {
      let user = null;
      const link = linkGet.get(subject.id, extId);
      if (link) user = users.findById.get(link.user_id) || null;
      if (!user && bindProvider) user = oauth.findByProvider.get(bindProvider, extId) || null;
      if (!user && email && helpers.isEmail(email)) user = users.findByEmail.get(email) || null;
      if (!user && phone && helpers.isPhone(phone)) user = users.findByPhone.get(phone) || null;
      if (user && user.is_public) { out.errors.push({ userid: extId, error: '命中公共账号，跳过' }); continue; }
      if (!user) {
        user = users.create({
          name,
          email: email && helpers.isEmail(email) && !users.findByEmail.get(email) ? email : null,
          phone: phone && helpers.isPhone(phone) && !users.findByPhone.get(phone) ? phone : null,
        });
        out.created++;
      } else if (!link) {
        out.linked++;
      }
      linkUpsert.run(subject.id, extId, user.id, depts || null);
      // 绑定到企业微信登录凭证：该 UserId 没被别人占用、此人也还没绑这家企业微信时才绑
      if (bindProvider && !oauth.findByProvider.get(bindProvider, extId) && !userOauthOf.get(user.id, bindProvider)) {
        oauth.bind.run(crypto.randomUUID(), user.id, bindProvider, extId, null);
      }
      seenUsers.add(user.id);
      const existing = orgMembers.get.get(subject.id, user.id);
      if (!existing) {
        let orgUid = null;
        if (uidMode === 'userid' && !orgMembers.orgUidTaken.get(subject.id, extId, user.id)) orgUid = extId;
        else if (uidMode !== 'none' && subject.uid_prefix) orgUid = helpers.genOrgUid(subject);
        orgMembers.add.run(subject.id, user.id, orgUid, 'wecom');
        out.added++;
      } else if (!existing.org_uid && uidMode === 'userid' && !orgMembers.orgUidTaken.get(subject.id, extId, user.id)) {
        orgMembers.setOrgUid.run(extId, subject.id, user.id);
      }
    } catch (e) {
      out.errors.push({ userid: extId, error: e.message });
    }
  }

  if (cfg.remove_missing !== false) {
    if (out.total === 0) {
      out.errors.push({ error: '本次一个成员都没拉到，已跳过移除（请检查通讯录权限 / 部门 ID）' });
    } else {
      for (const mem of orgMembers.listBySubject.all(subject.id)) {
        if (mem.source === 'wecom' && !seenUsers.has(mem.user_id)) { orgMembers.remove.run(subject.id, mem.user_id); out.removed++; }
      }
      // 不在范围内的映射也清掉（人回来了会按 UserId 再连上同一账号：user_oauth 绑定还在）
      for (const l of linksOf.all(subject.id)) if (!seenExt.has(l.ext_id)) linkDelete.run(subject.id, l.ext_id);
    }
  }
  return out;
}

module.exports = { syncWecom, fetchDirectory, loginProviderFor, apiBase };
