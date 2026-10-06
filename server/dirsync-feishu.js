// 飞书通讯录同步（v3.5.59；v3.5.60 起可放在组织文件夹上，文件夹里的组织套用、各选部门）：用飞书「企业自建应用」的通讯录接口，把所选部门（含子部门）的成员同步成本系统某个组织的成员。
// 免费版（基础版）即可：自建应用的「通讯录」「认证及授权」「事件订阅」类接口不计入飞书的 API 调用额度。
//
// 和企业微信那套（dirsync-wecom.js）的对应关系——配置字段沿用同名，管理端 / 接口都不用分两套：
//   corp_id      = 飞书 App ID（cli_ 开头）      secret = App Secret
//   cb_token     = 事件订阅的 Verification Token  cb_aes_key = Encrypt Key（可选）
//   dept_ids     = 部门 open_department_id（字符串，根部门是 "0"）
//
// 认人：飞书成员的 open_id 是「每个应用一份」，union_id 是「同一开发者（企业）下的所有应用共用」。
//   ext_id = 同步用的应用里的 open_id；dir_source_links.ext_union 另存 union_id。
//   ① 本同步源映射 ② 同一个 App ID 的登录凭证已绑这个 open_id（登录和同步用的是同一个应用）
//   ③ union_id：别的同步源 / 别的飞书登录凭证（不同应用）已经认得这个人 ④ 企业邮箱 / 邮箱 ⑤ 手机 ⑥ 新建
// 同步后把 open_id 绑到同一 App ID 的飞书登录凭证上（user_oauth 的 union_id 一并写上），之后用飞书登录直接落到同一账号。
//
// 离开：离职（is_resigned）/ 暂停（is_frozen）/ 主动退出（is_exited）或不在所选部门了 → 从组织移出（规则同企业微信）。
// 停用 / 删除：PATCH users/:id {is_frozen}（暂停 / 恢复）、DELETE users/:id（删除成员），需要应用开通「更新通讯录」权限。
const crypto = require('crypto');
const { db, users, oauth, orgMembers, departments } = require('./db');
const W = require('./dirsync-wecom');   // 共用 effectiveCfg（同步源配置解析）

const SRC = 'feishu';   // org_members.source
const linkGet    = db.prepare('SELECT * FROM dir_source_links WHERE source_id=? AND ext_id=?');
const linkUpsert = db.prepare(`INSERT INTO dir_source_links (source_id, ext_id, user_id, depts, ext_name, ext_union, updated_at) VALUES (?,?,?,?,?,?,datetime('now'))
  ON CONFLICT(source_id, ext_id) DO UPDATE SET user_id=excluded.user_id, depts=excluded.depts,
    ext_name=COALESCE(excluded.ext_name, ext_name), ext_union=COALESCE(excluded.ext_union, ext_union), updated_at=datetime('now')`);
const linksOf    = db.prepare('SELECT * FROM dir_source_links WHERE source_id=?');
const linkDelete = db.prepare('DELETE FROM dir_source_links WHERE source_id=? AND ext_id=?');
const stillSynced = db.prepare(`SELECT 1 FROM dir_source_links l JOIN dir_sync_sources d ON d.id=l.source_id
  WHERE d.subject_id=? AND l.user_id=? LIMIT 1`);
const userOauthOf = db.prepare('SELECT open_id FROM user_oauth WHERE user_id=? AND provider=?');
const credsStmt = db.prepare(`SELECT p.id, p.label, p.config, p.folder_id, f.name AS folder_name FROM oauth_providers p
  LEFT JOIN org_folders f ON f.id=p.folder_id
  WHERE p.platform='feishu' AND (p.subject_id=? OR p.id IN (SELECT provider_id FROM folder_cred_orgs WHERE subject_id=?))
  ORDER BY (p.folder_id IS NOT NULL AND p.folder_id<>''), p.sort_weight, p.created_at`);
const blockedDir = db.prepare("SELECT 1 FROM identity_blocks WHERE kind='dir' AND conn_id=? AND ext_id=?");
// 同一份文件夹通讯录的其他「套用」里的映射（v3.5.60）：一人同时在两个组织的部门里时落到同一账号
const siblingLink = db.prepare(`SELECT l.user_id FROM dir_source_links l JOIN dir_sync_sources d ON d.id=l.source_id
  WHERE d.parent_id=? AND d.id<>? AND l.ext_id=? LIMIT 1`);
const appliedGet = db.prepare('SELECT value FROM dir_sync_applied WHERE source_id=? AND user_id=? AND kind=? AND key=?');
const appliedSet = db.prepare(`INSERT INTO dir_sync_applied (source_id,user_id,kind,key,value,updated_at) VALUES (?,?,?,?,?,datetime('now'))
  ON CONFLICT(source_id,user_id,kind,key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`);

const effectiveCfg = W.effectiveCfg;
const writeCfg = (cfg) => cfg;   // 飞书读写用同一个应用（开通「更新通讯录」权限即可改成员）
function apiBase() { return String(process.env.FEISHU_API_BASE || 'https://open.feishu.cn').replace(/\/+$/, ''); }
const appNorm = (a) => String(a || '').trim();

// 常见错误码的处理建议
const ERR_HINT = {
  10003: 'App ID 或 App Secret 不对',
  10014: 'App Secret 不对',
  99991663: 'tenant_access_token 无效，请重试',
  99991672: '应用没有开通所需权限：到飞书开发者后台「权限管理」开通「获取通讯录基本信息」「获取部门基础信息」「获取用户基本信息」等（要停用 / 删除成员还需「更新通讯录」），然后「创建版本并发布」',
  99991400: '调用太频繁（飞书限流），稍后再试',
  40004: '应用没有该部门的通讯录权限：到飞书开发者后台「权限管理 → 通讯录权限范围」加上要同步的部门，并重新发布版本',
  41050: '应用没有该成员的通讯录权限：把他所在的部门加进应用的「通讯录权限范围」',
  41012: '成员 ID 无效',
};

async function call(method, path, { params, body, token } = {}) {
  const url = new URL(apiBase() + '/open-apis' + path);
  Object.entries(params || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v)); });
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(url, { method, signal: AbortSignal.timeout(20000), headers, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (j && j.code) {
    const hint = ERR_HINT[j.code];
    throw Object.assign(new Error(`飞书 ${path.split('?')[0]} 失败：${j.code} ${j.msg || ''}`.trim() + (hint ? `（${hint}）` : '')), { errcode: j.code });
  }
  if (!r.ok) throw Object.assign(new Error(`飞书接口 HTTP ${r.status}`), { errcode: -1 });
  return j;
}

// tenant_access_token 有效期 2 小时，按 App ID + Secret 缓存（提前 5 分钟换）
const _tokens = new Map();
async function token(cfg) {
  const k = appNorm(cfg.corp_id) + '|' + crypto.createHash('sha256').update(String(cfg.secret || '')).digest('hex').slice(0, 16);
  const c = _tokens.get(k);
  if (c && c.exp > Date.now()) return c.token;
  const j = await call('POST', '/auth/v3/tenant_access_token/internal', { body: { app_id: appNorm(cfg.corp_id), app_secret: String(cfg.secret || '') } });
  if (!j.tenant_access_token) throw new Error('飞书没有返回 tenant_access_token（检查 App ID / App Secret）');
  _tokens.set(k, { token: j.tenant_access_token, exp: Date.now() + Math.max(60, (j.expire || 7200) - 300) * 1000 });
  return j.tenant_access_token;
}

/** 同步范围：部门 open_department_id 字符串，根部门 "0" */
function deptIdsOf(cfg) {
  const arr = Array.isArray(cfg.dept_ids) && cfg.dept_ids.length ? cfg.dept_ids : ['0'];
  return [...new Set(arr.map(x => String(x).trim()).filter(x => /^[A-Za-z0-9_-]{1,64}$/.test(x)))].slice(0, 50);
}

// 分页拉完
async function pages(path, params, tk, listKey = 'items', max = 200) {
  const out = []; let page_token = '';
  for (let i = 0; i < max; i++) {
    const j = await call('GET', path, { params: { ...params, page_size: 50, page_token }, token: tk });
    const d = j.data || {};
    out.push(...(d[listKey] || []));
    if (!d.has_more || !d.page_token) break;
    page_token = d.page_token;
  }
  return out;
}
const DEPT_Q = { department_id_type: 'open_department_id', user_id_type: 'open_id' };
const deptNode = (d) => ({ id: d.open_department_id || d.department_id, name: d.name || '', parent: d.parent_department_id ?? null, order: Number(d.order) || 0 });
async function childrenOf(tk, id) {
  return (await pages(`/contact/v3/departments/${encodeURIComponent(id)}/children`, { ...DEPT_Q, fetch_child: true }, tk)).map(deptNode);
}
// 应用的通讯录权限范围（权限没开到根部门时，从这里拿可见的部门 / 成员）
async function scopes(tk) {
  const dept = new Set(), usersOnly = new Set(); let page_token = '';
  for (let i = 0; i < 100; i++) {
    const j = await call('GET', '/contact/v3/scopes', { params: { ...DEPT_Q, page_size: 100, page_token }, token: tk });
    const d = j.data || {};
    (d.department_ids || []).forEach(x => dept.add(String(x)));
    (d.user_ids || []).forEach(x => usersOnly.add(String(x)));
    if (!d.has_more || !d.page_token) break;
    page_token = d.page_token;
  }
  return { dept: [...dept], users: [...usersOnly] };
}
async function deptInfo(tk, id) {
  try { return deptNode((await call('GET', `/contact/v3/departments/${encodeURIComponent(id)}`, { params: DEPT_Q, token: tk })).data.department); }
  catch (_) { return { id, name: '', parent: null, order: 0 }; }
}

/** 这个应用能看到的部门（给管理端挑同步范围用）；能看到根部门时带上一个「全部」节点 "0" */
async function fetchScopeTree(cfg) {
  const tk = await token(cfg);
  try {
    const nodes = await childrenOf(tk, '0');
    return [{ id: '0', name: '全部（企业根部门）', parent: null, order: -1 }, ...nodes];
  } catch (e) {
    if (e.errcode !== 40004) throw e;
    // 权限范围没开到根部门：从权限范围里的部门往下取
    const sc = await scopes(tk);
    const map = new Map();
    for (const id of sc.dept.slice(0, 200)) {
      map.set(id, await deptInfo(tk, id));
      try { for (const n of await childrenOf(tk, id)) map.set(n.id, n); } catch (_) {}
    }
    return [...map.values()];
  }
}

/** 统一成同步要用的成员结构 */
function normMember(u, deptName) {
  const st = u.status || {};
  const mobile = String(u.mobile || '').trim().replace(/^\+86[-\s]?/, '');
  return {
    userid: u.open_id, union_id: u.union_id || null, user_id: u.user_id || null, employee_no: u.employee_no || null,
    name: u.name || u.en_name || u.open_id,
    email: String(u.enterprise_email || u.email || '').trim().toLowerCase(), mobile,
    department: (u.department_ids || []).map(id => deptName.get(id) || id),
    department_ids: u.department_ids || [],   // v3.5.68 保留原始部门 id 供归部门
    active: !(st.is_resigned || st.is_frozen || st.is_exited),
  };
}

/** 拉取所选部门（含子部门）的成员，按 open_id 去重 */
async function fetchDirectory(cfg) {
  const tk = await token(cfg);
  const roots = deptIdsOf(cfg);
  const deptName = new Map();
  const deptTree = [];   // v3.5.68：含父子关系的部门节点，供自动建 org_departments
  const inScope = new Set();
  let extraUsers = [];
  const collect = n => { if (n.name) { deptName.set(n.id, n.name); deptTree.push(n); } };
  for (const root of roots) {
    inScope.add(root);
    try {
      for (const n of await childrenOf(tk, root)) { inScope.add(n.id); collect(n); }
    } catch (e) {
      if (!(root === '0' && e.errcode === 40004)) throw e;
      // 选了「全部」但权限范围没开到根部门：按权限范围里的部门 + 单独授权的成员同步
      inScope.delete('0');
      const sc = await scopes(tk);
      for (const id of sc.dept) {
        inScope.add(id);
        try { for (const n of await childrenOf(tk, id)) { inScope.add(n.id); collect(n); } } catch (_) {}
      }
      extraUsers = sc.users;
    }
    if (root !== '0' && !deptName.has(root)) { const d = await deptInfo(tk, root); if (d.name) collect(d); }
  }
  const byId = new Map();
  for (const id of inScope) {
    for (const u of await pages('/contact/v3/users/find_by_department', { ...DEPT_Q, department_id: id }, tk)) {
      if (u && u.open_id && !byId.has(u.open_id)) byId.set(u.open_id, normMember(u, deptName));
    }
  }
  for (const oid of extraUsers.slice(0, 500)) {
    if (byId.has(oid)) continue;
    try { const u = (await call('GET', `/contact/v3/users/${encodeURIComponent(oid)}`, { params: DEPT_Q, token: tk })).data.user; if (u) byId.set(u.open_id, normMember(u, deptName)); } catch (_) {}
  }
  return { members: [...byId.values()], deptName, deptTree, limited: false };
}

// ══════════════════════════════════════════
// 同一个飞书应用（App ID）的同步源 + 登录凭证
// ══════════════════════════════════════════
const allSources = db.prepare("SELECT * FROM dir_sync_sources WHERE type='feishu'");
const allCreds = db.prepare("SELECT id, config FROM oauth_providers WHERE platform='feishu'");
function corpScope(appId) {
  const app = appNorm(appId);
  const sources = new Set(), providers = new Set();
  if (!app) return { sources, providers };
  for (const s of allSources.all()) if (appNorm(effectiveCfg(s).corp_id) === app) sources.add(s.id);
  for (const c of allCreds.all()) { try { if (appNorm(JSON.parse(c.config || '{}').FEISHU_APP_ID) === app) providers.add('feishu:' + c.id); } catch (_) {} }
  if (appNorm(process.env.FEISHU_APP_ID) === app) providers.add('feishu');
  return { sources, providers };
}
const usable = (u) => u && !u.is_public && !u.merged_into && u.deletion_state !== 'deleted' && u.deletion_state !== 'purged';
/** 已经对应这个飞书成员的账号：同一应用按 open_id；任何飞书同步源 / 飞书登录凭证按 union_id */
function corpUsers(appId, openId, { unionId = null, excludeSource = null, scope = null } = {}) {
  const ids = [];
  const push = (id) => { if (id && !ids.includes(id)) ids.push(id); };
  if (openId) {
    const { sources, providers } = scope || corpScope(appId);
    for (const l of db.prepare('SELECT source_id, user_id FROM dir_source_links WHERE ext_id=?').all(String(openId))) if (sources.has(l.source_id) && l.source_id !== excludeSource) push(l.user_id);
    for (const o of db.prepare("SELECT provider, user_id FROM user_oauth WHERE open_id=? AND (provider='feishu' OR provider LIKE 'feishu:%')").all(String(openId))) if (providers.has(o.provider)) push(o.user_id);
  }
  if (unionId) {
    for (const l of db.prepare(`SELECT l.source_id, l.user_id FROM dir_source_links l JOIN dir_sync_sources d ON d.id=l.source_id
      WHERE d.type='feishu' AND l.ext_union=?`).all(String(unionId))) if (l.source_id !== excludeSource) push(l.user_id);
    for (const o of db.prepare("SELECT user_id FROM user_oauth WHERE union_id=? AND (provider='feishu' OR provider LIKE 'feishu:%')").all(String(unionId))) push(o.user_id);
  }
  return ids.map(id => users.findById.get(id)).filter(usable);
}
/** 飞书登录凭证 provider key → 它的 App ID */
function corpOfProvider(providerKey) {
  if (providerKey === 'feishu') return process.env.FEISHU_APP_ID || '';
  if (!String(providerKey).startsWith('feishu:')) return '';
  const row = db.prepare('SELECT config FROM oauth_providers WHERE id=?').get(String(providerKey).slice(7));
  try { return row ? JSON.parse(row.config || '{}').FEISHU_APP_ID || '' : ''; } catch (_) { return ''; }
}
function loginProviderFor(subject, appId) {
  for (const c of credsStmt.all(subject.id, subject.id)) {
    try { if (appNorm(JSON.parse(c.config || '{}').FEISHU_APP_ID) === appNorm(appId)) return 'feishu:' + c.id; } catch (_) {}
  }
  if (process.env.FEISHU_APP_ID && appNorm(process.env.FEISHU_APP_ID) === appNorm(appId)) return 'feishu';
  return null;
}
function loginProviderChoices(subject) {
  const out = [];
  for (const c of credsStmt.all(subject.id, subject.id)) {
    let app = ''; try { app = JSON.parse(c.config || '{}').FEISHU_APP_ID || ''; } catch (_) {}
    const where = c.folder_id ? `（文件夹「${c.folder_name || ''}」共用）` : '';
    out.push({ key: 'feishu:' + c.id, label: '飞书' + (c.label ? ' · ' + c.label : '') + where, corp_id: app, folder: !!c.folder_id });
  }
  if (process.env.FEISHU_APP_ID) out.push({ key: 'feishu', label: '飞书（本站默认凭证）', corp_id: process.env.FEISHU_APP_ID });
  return out;
}
/** 要绑定的登录凭证：只能绑同一个 App ID 的（open_id 是每个应用一份，不同应用的 open_id 对不上） */
function bindProvidersFor(subject, cfg) {
  const mode = cfg.bind_mode || 'auto';
  if (mode === 'none') return [];
  if (mode === 'custom') {
    const valid = new Set(loginProviderChoices(subject).filter(x => appNorm(x.corp_id) === appNorm(cfg.corp_id)).map(x => x.key));
    return (cfg.bind_providers || []).filter(k => valid.has(k));
  }
  const p = loginProviderFor(subject, cfg.corp_id);
  return p ? [p] : [];
}

/** 执行一次同步（流程与企业微信一致：只补默认值、不覆盖单独修改；0 人不移除；只移出本源丢掉、也不在其他同步源里的成员） */
async function syncFeishu(source, subject, cfg, helpers, fetcher = fetchDirectory, opts = {}) {
  const force = !!opts.force;
  const { members, deptTree } = await fetcher(cfg);
  // v3.5.68：自动建部门树；ext_id→部门 uuid 映射供成员归部门
  const extToDeptId = new Map();
  if (Array.isArray(deptTree) && deptTree.length) {
    for (const node of deptTree) {
      const extId = String(node.id);
      let dId = departments.getByExt.get(subject.id, 'feishu', extId);
      const parentId = node.parent != null ? (extToDeptId.get(String(node.parent)) || null) : null;
      if (dId) {
        departments.update.run(node.name || extId, parentId, dId.id);
      } else {
        dId = { id: crypto.randomUUID() };
        departments.insert.run(dId.id, node.name || extId, subject.id, parentId, 'feishu', extId, Number(node.order) || 0);
      }
      extToDeptId.set(extId, dId.id);
    }
  }
  const bindProviders = bindProvidersFor(subject, cfg);
  const uidMode = cfg.uid_mode || 'userid';
  const pwHash = cfg.default_pw_hash || null;
  const out = { total: 0, created: 0, linked: 0, added: 0, removed: 0, skipped: 0, errors: [],
    bind_provider: bindProviders[0] || null, bind_providers: bindProviders,
    bound: 0, pw_set: 0, kept: 0, conflicts: 0, unmatched: 0, force, limited: false };
  const seenUsers = new Set(), seenExt = new Set();
  const sc = corpScope(cfg.corp_id);

  function applyBind(user, m, p) {
    const extId = m.userid;
    const owner = oauth.findByProvider.get(p, extId);
    if (owner && owner.id !== user.id) { out.conflicts++; return; }
    if (owner) { appliedSet.run(source.id, user.id, 'bind', p, extId); return; }
    const cur = userOauthOf.get(user.id, p)?.open_id || null;
    if (cur === extId) { appliedSet.run(source.id, user.id, 'bind', p, extId); return; }
    const rec = appliedGet.get(source.id, user.id, 'bind', p);
    if (!(!cur && !rec) && !force) { out.kept++; return; }
    if (cur) oauth.unbind.run(user.id, p);
    oauth.bind.run(crypto.randomUUID(), user.id, p, extId, m.union_id || null);
    appliedSet.run(source.id, user.id, 'bind', p, extId);
    out.bound++;
  }
  function applyPassword(user) {
    if (!pwHash) return;
    const mem = orgMembers.get.get(subject.id, user.id);
    if (!mem || mem.source !== SRC) return;
    const cur = mem.password_hash || null;
    const rec = appliedGet.get(source.id, user.id, 'pw', '')?.value || null;
    if (cur === pwHash) { if (rec !== pwHash) appliedSet.run(source.id, user.id, 'pw', '', pwHash); return; }
    const untouched = (!cur && !rec) || (cur && rec && cur === rec);
    if (!untouched && !force) { out.kept++; return; }
    orgMembers.setPassword.run(pwHash, subject.id, user.id);
    appliedSet.run(source.id, user.id, 'pw', '', pwHash);
    out.pw_set++;
  }

  for (const m of members) {
    const extId = String(m.userid);
    if (!m.active) { out.skipped++; continue; }
    if (blockedDir.get(source.parent_id || source.id, extId)) { out.blocked = (out.blocked || 0) + 1; continue; }
    out.total++;
    seenExt.add(extId);
    const name = String(m.name || extId).trim().slice(0, 40);
    try {
      let user = null;
      const link = linkGet.get(source.id, extId);
      if (link) user = users.findById.get(link.user_id) || null;
      if (!user && source.parent_id) {                       // 同一份文件夹通讯录，别的组织已经认出这个人
        const sib = siblingLink.get(source.parent_id, source.id, extId);
        if (sib) user = users.findById.get(sib.user_id) || null;
      }
      for (const p of bindProviders) { if (!user) user = oauth.findByProvider.get(p, extId) || null; }
      if (!user) user = corpUsers(cfg.corp_id, extId, { unionId: m.union_id, scope: sc })[0] || null;
      if (!user && m.email && helpers.isEmail(m.email)) user = users.findByEmail.get(m.email) || null;
      if (!user && m.mobile && helpers.isPhone(m.mobile)) user = users.findByPhone.get(m.mobile) || null;
      if (user && user.is_public) { out.errors.push({ userid: extId, error: '命中公共账号，跳过' }); continue; }
      if (user && (user.deletion_state === 'deleted' || user.deletion_state === 'purged')) { out.blocked = (out.blocked || 0) + 1; continue; }
      if (!user) {
        user = users.create({
          name,
          email: m.email && helpers.isEmail(m.email) && !users.findByEmail.get(m.email) ? m.email : null,
          phone: m.mobile && helpers.isPhone(m.mobile) && !users.findByPhone.get(m.mobile) ? m.mobile : null,
        });
        out.created++;
      } else if (!link) out.linked++;
      linkUpsert.run(source.id, extId, user.id, (m.department || []).join(',') || null, name || null, m.union_id || null);
      if (corpUsers(cfg.corp_id, extId, { unionId: m.union_id, scope: sc }).some(u => u.id !== user.id)) out.duplicates = (out.duplicates || 0) + 1;
      for (const p of bindProviders) applyBind(user, m, p);
      seenUsers.add(user.id);
      // 组织内 UID：飞书工号（employee_no），没有就用飞书 user_id（应用开了「获取用户 user ID」权限才有）
      const want = m.employee_no || m.user_id || null;
      const existing = orgMembers.get.get(subject.id, user.id);
      if (!existing) {
        let orgUid = null;
        if (uidMode === 'userid' && want && !orgMembers.orgUidTaken.get(subject.id, want, user.id)) orgUid = want;
        else if (uidMode === 'rule' && subject.uid_prefix) orgUid = helpers.genOrgUid(subject);
        orgMembers.add.run(subject.id, user.id, orgUid, SRC);
        out.added++;
      } else if (!existing.org_uid && uidMode === 'userid' && want && !orgMembers.orgUidTaken.get(subject.id, want, user.id)) {
        orgMembers.setOrgUid.run(want, subject.id, user.id);
      }
      // v3.5.68：成员归部门（取第一个有对应 org_departments 的外部部门 id）
      if (Array.isArray(m.department_ids)) {
        for (const did of m.department_ids) {
          const deptId = extToDeptId.get(String(did));
          if (deptId) { orgMembers.setDeptId.run(deptId, subject.id, user.id); break; }
        }
      }
      applyPassword(user);
    } catch (e) {
      out.errors.push({ userid: extId, error: e.message });
    }
  }

  if (cfg.remove_missing !== false) {
    if (out.total === 0) {
      out.errors.push({ error: '本次一个成员都没拉到，已跳过移除（请检查应用的通讯录权限范围 / 所选部门）' });
    } else {
      const gone = new Set();
      for (const l of linksOf.all(source.id)) if (!seenExt.has(l.ext_id)) { linkDelete.run(source.id, l.ext_id); gone.add(l.user_id); }
      for (const mem of orgMembers.listBySubject.all(subject.id)) {
        if (mem.source !== SRC || seenUsers.has(mem.user_id) || !gone.has(mem.user_id)) continue;
        if (stillSynced.get(subject.id, mem.user_id)) continue;
        orgMembers.remove.run(subject.id, mem.user_id); out.removed++;
      }
    }
  }
  return out;
}

// ── 成员状态 / 暂停 / 删除（注销与删除、异常账号、残留成员用）──
async function memberStatus(cfg, openId) {
  const tk = await token(cfg);
  try {
    const u = (await call('GET', `/contact/v3/users/${encodeURIComponent(openId)}`, { params: DEPT_Q, token: tk })).data.user || {};
    const st = u.status || {};
    if (st.is_resigned || st.is_exited) return { status: 'quit' };
    if (st.is_frozen) return { status: 'disabled' };
    return { status: 'active' };
  } catch (e) {
    if (e.errcode === 41012 || e.errcode === 40013) return { status: 'gone' };
    throw e;
  }
}
async function setMemberEnabled(cfg, openId, enabled) {
  const tk = await token(cfg);
  await call('PATCH', `/contact/v3/users/${encodeURIComponent(openId)}`, { params: { user_id_type: 'open_id' }, body: { is_frozen: !enabled }, token: tk });
}
async function deleteMember(cfg, openId) {
  const tk = await token(cfg);
  await call('DELETE', `/contact/v3/users/${encodeURIComponent(openId)}`, { params: { user_id_type: 'open_id' }, token: tk });
}
// 在飞书里创建成员（v3.5.69 出站 provisioning；自建应用需开「更新通讯录」权限）
async function createMember(cfg, f) {
  const tk = await token(cfg);
  const body = { name: f.name };
  // 飞书 mobile 要求 E.164 格式（+8613800000000）；11 位中国手机号补 +86 前缀
  if (f.mobile) body.mobile = /^\+/.test(String(f.mobile)) ? String(f.mobile) : '+86' + String(f.mobile).replace(/[^\d]/g, '');
  if (f.email) body.email = f.email;
  // 部门：根部门 "0" 是虚拟根、不能作成员归属；过滤掉空值和 "0"，空则不传（飞书归到默认部门）
  const deptIds = (Array.isArray(f.department_ids) ? f.department_ids : []).map(String).filter(x => x && x !== '0');
  if (deptIds.length) body.department_ids = deptIds;
  const j = await call('POST', '/contact/v3/users', { params: DEPT_Q, body, token: tk });
  // 不传 user_id 时飞书自动生成 open_id；优先返回 open_id（用于写映射）
  return (j.data && j.data.user && (j.data.user.open_id || j.data.user.user_id)) || f.user_id;
}
// 建成员；user_id 已存在时改「增补部门」而不是覆盖（先读现有 department_ids 取并集再 PATCH）
async function upsertMember(cfg, f) {
  try {
    return await createMember(cfg, f);
  } catch (e) {
    if (!f.user_id) throw e;
    const tk = await token(cfg);
    const cur = await call('GET', `/contact/v3/users/${encodeURIComponent(String(f.user_id))}`, { params: { ...DEPT_Q, user_id_type: 'user_id' }, token: tk }).catch(() => null);
    const existing = (cur && cur.data && cur.data.user && Array.isArray(cur.data.user.department_ids)) ? cur.data.user.department_ids.map(String) : [];
    const merged = [...new Set([...existing, ...(Array.isArray(f.department_ids) ? f.department_ids.map(String) : [])])];
    await call('PATCH', `/contact/v3/users/${encodeURIComponent(String(f.user_id))}`, { params: { ...DEPT_Q, user_id_type: 'user_id' }, body: { department_ids: merged }, token: tk });
    return String(f.user_id);
  }
}
const isGoneError = (e) => e && (e.errcode === 41012 || e.errcode === 40013);

// ══════════════════════════════════════════
// 事件订阅（实时同步）：飞书开发者后台「事件与回调 → 事件配置」请求地址填本系统给的 URL
//   Encrypt Key（可选）：body = {"encrypt": base64}；解密 AES-256-CBC，key = sha256(EncryptKey)，iv = 密文前 16 字节，PKCS#7
//   签名（配了 Encrypt Key 时）：X-Lark-Signature = sha256hex(timestamp + nonce + EncryptKey + 原始 body)
//   Verification Token：事件 header.token（v2）或顶层 token（URL 校验 / v1）必须等于它
// ══════════════════════════════════════════
function evDecrypt(encryptKey, encrypt) {
  const key = crypto.createHash('sha256').update(String(encryptKey)).digest();
  const buf = Buffer.from(String(encrypt), 'base64');
  const d = crypto.createDecipheriv('aes-256-cbc', key, buf.subarray(0, 16));
  return Buffer.concat([d.update(buf.subarray(16)), d.final()]).toString('utf8');
}
function evEncrypt(encryptKey, plain) {   // 飞书那一侧做的事；测试与自检用
  const key = crypto.createHash('sha256').update(String(encryptKey)).digest();
  const iv = crypto.randomBytes(16);
  const c = crypto.createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([iv, c.update(Buffer.from(String(plain), 'utf8')), c.final()]).toString('base64');
}
function evSignature(timestamp, nonce, encryptKey, rawBody) {
  return crypto.createHash('sha256').update(String(timestamp) + String(nonce) + String(encryptKey) + String(rawBody)).digest('hex');
}
/**
 * 解析一次推送：返回 { ok, reason?, kind:'challenge'|'event', challenge?, event_type?, app_id?, payload? }
 * headers 用小写键
 */
function parseEvent(cfg, headers, rawBody) {
  let body;
  try { body = JSON.parse(rawBody || '{}'); } catch (_) { return { ok: false, reason: '请求体不是 JSON' }; }
  if (body.encrypt !== undefined) {
    if (!cfg.cb_aes_key) return { ok: false, reason: '飞书推送的是加密内容，但本系统没填 Encrypt Key' };
    const sig = String(headers['x-lark-signature'] || '');
    if (sig) {   // URL 校验请求没有签名头；事件推送有
      const want = evSignature(headers['x-lark-request-timestamp'] || '', headers['x-lark-request-nonce'] || '', cfg.cb_aes_key, rawBody);
      if (sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return { ok: false, reason: '签名不对：飞书后台的 Encrypt Key 和本系统保存的不一致' };
    }
    try { body = JSON.parse(evDecrypt(cfg.cb_aes_key, body.encrypt)); }
    catch (_) { return { ok: false, reason: '解密失败：飞书后台的 Encrypt Key 和本系统保存的不一致' }; }
  } else if (cfg.cb_aes_key) {
    return { ok: false, reason: '本系统填了 Encrypt Key，但飞书推送的是明文：飞书后台也要填同一个 Encrypt Key' };
  }
  const tok = body.header ? body.header.token : body.token;
  if (!cfg.cb_token || String(tok || '') !== String(cfg.cb_token)) return { ok: false, reason: 'Verification Token 不对：飞书后台的 Verification Token 和本系统保存的不一致' };
  if (body.type === 'url_verification') return { ok: true, kind: 'challenge', challenge: body.challenge };
  const h = body.header || {};
  return { ok: true, kind: 'event', event_type: h.event_type || (body.event && body.event.type) || '', app_id: h.app_id || '', payload: body.event || {} };
}

module.exports = {
  type: 'feishu', label: '飞书', SRC, effectiveCfg, writeCfg, apiBase, deptIdsOf, token,
  fetchScopeTree, fetchDirectory, sync: syncFeishu, syncFeishu,
  corpScope, corpUsers, corpOfProvider, loginProviderFor, loginProviderChoices, bindProvidersFor,
  memberStatus, setMemberEnabled, deleteMember, createMember, upsertMember, isGoneError,
  evDecrypt, evEncrypt, evSignature, parseEvent, LIMITED_HINT: '',
};
