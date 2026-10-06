// 企业微信通讯录同步（v3.5.35）：把企业微信某个部门（含子部门）下的成员同步成本系统某个组织的成员。
//
// 企业微信没有标准 SCIM，这里走它自己的通讯录 API（拉取式）：
//   gettoken → department/list（部门名）→ user/list?fetch_child=1（成员详情）
//   user/list 被企业微信收紧权限时，回退 user/list_id（分页拿 userid）+ user/get（逐个取详情）
//
// 匹配同一自然人的顺序（越靠前越可靠）：
//   ① dir_source_links（本同步源历次同步留下的 UserId → 用户映射；按同步源隔离，不同企业的 UserId 可能重名）
//   ② user_oauth（该企业微信的登录凭证下已绑定这个 UserId——用户以前用企业微信登录过）
//   ③ 邮箱（email / biz_mail）④ 手机 ⑤ 都没有 → 新建账号
// 同步后把 UserId 绑定到该企业微信的登录凭证（若本系统配了同一 corp 的企业微信登录），
// 这样成员之后用企业微信登录会落到同一个账号，而不是再建一个。
//
// 离职 / 禁用（status 2、5）或已不在同步范围的成员：从组织里移出——前提是他也不在本组织的其他同步源里，
// 且只动同步进来的成员（source='wecom'），手动加入 / 批量导入的不动。（v3.5.36 起一个组织可有多个同步源）
// ⚠️ 防误删：本次一个人都没拉到时不做任何移除（多半是权限/部门配置错了）。
//
// v3.5.37：
//   · 同步范围可多选部门（dept_ids）——集团总公司账号只开了某几个部门权限时，只同步那几个部门（含子部门）
//   · 每个同步源可指定「要绑定的登录凭证」（bind_mode auto/custom/none + bind_providers）和「默认组织密码」
//   · 同步只「补上」默认值：成员被单独改过的（解绑/改绑登录凭证、改了或清了组织密码）一律不覆盖，
//     靠 dir_sync_applied 记住「同步上次给他设了什么」来判断是不是被人动过；除非强确认的「全部覆盖同步」（force）
const crypto = require('crypto');
const { db, users, oauth, orgMembers, oauthSubjects, departments } = require('./db');
const { importWecomContacts } = require('./contacts');

const linkGet    = db.prepare('SELECT * FROM dir_source_links WHERE source_id=? AND ext_id=?');
const linkUpsert = db.prepare(`INSERT INTO dir_source_links (source_id, ext_id, user_id, depts, ext_name, updated_at) VALUES (?,?,?,?,?,datetime('now'))
  ON CONFLICT(source_id, ext_id) DO UPDATE SET user_id=excluded.user_id, depts=excluded.depts,
    ext_name=COALESCE(excluded.ext_name, ext_name), updated_at=datetime('now')`);
const linksOf    = db.prepare('SELECT * FROM dir_source_links WHERE source_id=?');
const linkDelete = db.prepare('DELETE FROM dir_source_links WHERE source_id=? AND ext_id=?');
// 该用户是否还被本组织的「任一」同步源同步着（多同步源时，离开 A 但还在 B 的人不能移出）
const stillSynced = db.prepare(`SELECT 1 FROM dir_source_links l JOIN dir_sync_sources d ON d.id=l.source_id
  WHERE d.subject_id=? AND l.user_id=? LIMIT 1`);
const userOauthOf = db.prepare('SELECT open_id FROM user_oauth WHERE user_id=? AND provider=?');
// 本组织可用的企业微信登录凭证：组织自己的 + 所在文件夹里、本组织设定使用的（v3.5.47；v3.5.51 起要组织设定）
const wecomCredsStmt = db.prepare(`SELECT p.id, p.label, p.config, p.folder_id, f.name AS folder_name FROM oauth_providers p
  LEFT JOIN org_folders f ON f.id=p.folder_id
  WHERE p.platform='wecom' AND (p.subject_id=? OR p.id IN (SELECT provider_id FROM folder_cred_orgs WHERE subject_id=?))
  ORDER BY (p.folder_id IS NOT NULL AND p.folder_id<>''), p.sort_weight, p.created_at`);
const wecomCredsOf = { all: (subject) => wecomCredsStmt.all(subject.id, subject.id) };   // v3.5.51：文件夹凭证只算本组织设定使用的
// 同一份文件夹通讯录的其他「套用」里的映射：一人同时在两个组织的部门里时落到同一账号
const siblingLink = db.prepare(`SELECT l.user_id FROM dir_source_links l JOIN dir_sync_sources d ON d.id=l.source_id
  WHERE d.parent_id=? AND d.id<>? AND l.ext_id=? LIMIT 1`);
const sourceGet = db.prepare('SELECT * FROM dir_sync_sources WHERE id=?');
const blockedDir = db.prepare("SELECT 1 FROM identity_blocks WHERE kind='dir' AND conn_id=? AND ext_id=?");

// 通讯录「连接」字段（放在文件夹那份上）；其余（部门、绑定、默认密码、移出、频率…）是各组织「套用」自己的
// v3.5.50：两份 Secret——secret = 读通讯录（推荐「自建应用」Secret），write_secret = 改通讯录（「通讯录同步」Secret：禁用 / 启用 / 删除成员）
const CONN_KEYS = ['corp_id', 'secret', 'write_secret', 'cb_token', 'cb_aes_key', 'push_suspend'];
/** 改通讯录用的配置：有「通讯录同步」Secret 用它，没填就退回读用的那个（老配置只有一份 Secret） */
const writeCfg = (cfg) => ({ ...cfg, secret: (cfg && cfg.write_secret) || (cfg && cfg.secret) });
const parseCfg = (t) => { try { return t ? JSON.parse(t) : {}; } catch (_) { return {}; } };
/** 同步源实际生效的配置：套用文件夹通讯录的 = 文件夹连接字段 + 自己的组织级字段 */
function effectiveCfg(src) {
  const own = parseCfg(src && src.config);
  if (!src || !src.parent_id) return own;
  const parent = sourceGet.get(src.parent_id);
  if (!parent) return { ...own, corp_id: '', secret: '' };   // 连接被删了：配置不完整，同步会报错
  const conn = parseCfg(parent.config);
  const out = { ...own };
  for (const k of CONN_KEYS) { if (conn[k] !== undefined) out[k] = conn[k]; else delete out[k]; }
  return out;
}
// ══════════════════════════════════════════
// 同一企业 + 同一 UserId = 同一个人（v3.5.50）
//   之前认人只看「本同步源的映射」和「本同步源要绑定的那个登录凭证」：成员用同企业的另一个登录凭证
//   （本站默认 / 文件夹共用 / 组织自己的另一个）登录过，或者同一企业被两个不在同一文件夹的同步源同步，
//   就认不出来、又建一个号。现在跨所有同步源与所有企业微信登录凭证，按 corp_id + UserId 认人；
//   企业微信 UserId 不区分大小写，比较时也忽略大小写。
// ══════════════════════════════════════════
const allWecomSources = db.prepare("SELECT * FROM dir_sync_sources WHERE type='wecom'");
const allWecomCreds = db.prepare("SELECT id, config FROM oauth_providers WHERE platform='wecom'");
const linksByExt = db.prepare('SELECT * FROM dir_source_links WHERE ext_id=? COLLATE NOCASE');
const oauthByExt = db.prepare(`SELECT o.provider, o.user_id, o.open_id FROM user_oauth o
  WHERE (o.provider='wecom' OR o.provider LIKE 'wecom:%') AND o.open_id=? COLLATE NOCASE`);
const corpNorm = (c) => String(c || '').trim().toLowerCase();
/** 这家企业的同步源 id 集合 + 登录凭证 provider key 集合 */
function corpScope(corpId) {
  const corp = corpNorm(corpId);
  const sources = new Set(), providers = new Set();
  if (!corp) return { sources, providers };
  for (const s of allWecomSources.all()) if (corpNorm(effectiveCfg(s).corp_id) === corp) sources.add(s.id);
  for (const c of allWecomCreds.all()) { try { if (corpNorm(JSON.parse(c.config || '{}').WECOM_CORP_ID) === corp) providers.add('wecom:' + c.id); } catch (_) {} }
  if (corpNorm(process.env.WECOM_CORP_ID) === corp) providers.add('wecom');
  return { sources, providers };
}
const usable = (u) => u && !u.is_public && !u.merged_into && u.deletion_state !== 'deleted' && u.deletion_state !== 'purged';
/** 这家企业里这个 UserId 已经对应的所有账号（去重；调用方取第一个）。excludeSource：跳过某个同步源自己的映射 */
function corpUsers(corpId, extId, { excludeSource = null, scope = null } = {}) {
  extId = String(extId || '');
  if (!extId) return [];
  const { sources, providers } = scope || corpScope(corpId);
  const ids = [];
  for (const l of linksByExt.all(extId)) if (sources.has(l.source_id) && l.source_id !== excludeSource && !ids.includes(l.user_id)) ids.push(l.user_id);
  for (const o of oauthByExt.all(extId)) if (providers.has(o.provider) && !ids.includes(o.user_id)) ids.push(o.user_id);
  return ids.map(id => users.findById.get(id)).filter(usable);
}
/** 登录凭证 provider key → 它的企业 ID（env 默认凭证读 WECOM_CORP_ID） */
function corpOfProvider(providerKey) {
  if (providerKey === 'wecom') return process.env.WECOM_CORP_ID || '';
  if (!String(providerKey).startsWith('wecom:')) return '';
  const row = db.prepare('SELECT config FROM oauth_providers WHERE id=?').get(String(providerKey).slice(6));
  try { return row ? JSON.parse(row.config || '{}').WECOM_CORP_ID || '' : ''; } catch (_) { return ''; }
}
/**
 * 已经重复的账号：同一企业的同一个 UserId 挂在了两个以上账号上（映射或登录绑定）。
 * 返回 [{ corp_id, ext_id, users:[...] }]，users 里第一个是建议保留的（资料最全的，其次编号最小）。
 */
function findCorpDuplicates() {
  const corps = new Map();   // corp → { sources, providers }
  for (const s of allWecomSources.all()) { const c = corpNorm(effectiveCfg(s).corp_id); if (c) { if (!corps.has(c)) corps.set(c, corpScope(c)); } }
  for (const c of allWecomCreds.all()) { try { const k = corpNorm(JSON.parse(c.config || '{}').WECOM_CORP_ID); if (k && !corps.has(k)) corps.set(k, corpScope(k)); } catch (_) {} }
  const envCorp = corpNorm(process.env.WECOM_CORP_ID);
  if (envCorp && !corps.has(envCorp)) corps.set(envCorp, corpScope(envCorp));
  const links = db.prepare('SELECT source_id, ext_id, user_id FROM dir_source_links').all();
  const binds = db.prepare("SELECT provider, open_id AS ext_id, user_id FROM user_oauth WHERE provider='wecom' OR provider LIKE 'wecom:%'").all();
  const groups = new Map();   // corp|lower(ext) → { corp_id, ext_id, ids:Set }
  const put = (corp, ext, uid) => {
    const k = corp + '|' + String(ext).toLowerCase();
    if (!groups.has(k)) groups.set(k, { corp_id: corp, ext_id: ext, ids: new Set() });
    groups.get(k).ids.add(uid);
  };
  for (const [corp, sc] of corps) {
    for (const l of links) if (sc.sources.has(l.source_id)) put(corp, l.ext_id, l.user_id);
    for (const b of binds) if (sc.providers.has(b.provider)) put(corp, b.ext_id, b.user_id);
  }
  const score = (u) => (u.role === 'admin' ? 64 : 0) + (u.password_hash ? 16 : 0) + (u.kyc_verified ? 8 : 0)
    + (u.twofa_enabled ? 4 : 0) + (u.email ? 2 : 0) + (u.phone ? 1 : 0);
  const out = [];
  for (const g of groups.values()) {
    const us = [...g.ids].map(id => users.findById.get(id)).filter(usable);
    if (us.length < 2) continue;
    us.sort((a, b) => score(b) - score(a) || (a.uid_seq || 0) - (b.uid_seq || 0));
    out.push({ corp_id: g.corp_id, ext_id: g.ext_id, users: us });
  }
  return out;
}

// 同步给成员设过什么（登录绑定 / 组织密码），用来判断之后是否被人单独改过
const appliedGet = db.prepare('SELECT value FROM dir_sync_applied WHERE source_id=? AND user_id=? AND kind=? AND key=?');
const appliedSet = db.prepare(`INSERT INTO dir_sync_applied (source_id,user_id,kind,key,value,updated_at) VALUES (?,?,?,?,?,datetime('now'))
  ON CONFLICT(source_id,user_id,kind,key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`);

function apiBase() { return String(process.env.WECOM_API_BASE || 'https://qyapi.weixin.qq.com').replace(/\/+$/, ''); }

// 常见错误码的处理建议（附在报错后面，管理端「上次同步」里能直接看到）
const ERR_HINT = {
  40001: 'Secret 不对，或不是这个企业的',
  40013: '企业 ID（corpid）不对',
  48002: '这个 Secret 没有改通讯录的权限：在同步源里填「通讯录同步 Secret（管理用）」——企业微信后台 管理工具 → 通讯录同步 里的 Secret，并开启「API 编辑通讯录」、把报错里的 from ip 加进它的可信 IP',
  48004: '这个 Secret 没有改通讯录的权限：同上，填「通讯录同步 Secret（管理用）」',
  48009: '这个 Secret 无权读取通讯录详情：「通讯录同步」Secret 已被企业微信限制读取，读取用的 Secret 请改填「自建应用」Secret（通讯录同步 Secret 填到「管理用」那一栏）',
  60011: '这个 Secret 没有该部门的权限：在企业微信里把应用可见范围设到要同步的部门，或在「同步范围」里只选它能看到的部门',
  60020: '本服务器出口 IP 不在企业微信可信 IP 里：到企业微信后台把报错里的 from ip 加进该应用（或通讯录同步）的可信 IP',
};

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
  if (j.errcode) {
    const hint = ERR_HINT[j.errcode];
    throw Object.assign(new Error(`企业微信 ${path} 失败：${j.errcode} ${j.errmsg || ''}`.trim() + (hint ? `（${hint}）` : '')), { errcode: j.errcode });
  }
  return j;
}

/** 同步范围：v3.5.37 起 dept_ids（多选），兼容旧的单个 dept_id */
function deptIdsOf(cfg) {
  const arr = Array.isArray(cfg.dept_ids) && cfg.dept_ids.length ? cfg.dept_ids : [cfg.dept_id || 1];
  return [...new Set(arr.map(x => parseInt(x, 10)).filter(x => x > 0))].slice(0, 50);
}

async function token(cfg) {
  return (await call('GET', '/cgi-bin/gettoken', { corpid: cfg.corp_id, corpsecret: cfg.secret })).access_token;
}

/** 这个 Secret 能看到的部门（不带 id = 应用可见范围内的全部部门），给管理端挑同步范围用 */
// 「通讯录同步」Secret 自 2022-08-15 起在新 IP 上被禁止读通讯录详情（48009 api forbidden for contact assistant），
// 只能调「获取部门 ID 列表」(department/simplelist) 和「获取成员 ID 列表」(user/list_id)，且只返回 ID。
// 企业微信官方建议读通讯录改用「自建应用」Secret。这里遇到 48009 自动降级到 ID 接口，保证同步还能按 UserId 跑通。
const FORBIDDEN = 48009;
const LIMITED_HINT = '当前 Secret 是「通讯录同步」Secret，企业微信已限制它读取姓名 / 部门名 / 联系方式（48009），本次只拿到了 UserId 和部门 ID（成员照样建号，姓名暂用 UserId）。要同步姓名等信息，请改填「自建应用」的 Secret（应用可见范围设为要同步的部门，并把本服务器出口 IP 加进应用的可信 IP）。';

async function deptList(access_token, id) {
  try {
    const depts = (await call('GET', '/cgi-bin/department/list', { access_token, id })).department || [];
    return { depts: depts.map(d => ({ id: d.id, name: d.name || '', parentid: d.parentid ?? null, order: d.order ?? 0 })), limited: false };
  } catch (e) {
    if (e.errcode !== FORBIDDEN) throw e;
    const ids = (await call('GET', '/cgi-bin/department/simplelist', { access_token, id })).department_id || [];
    return { depts: ids.map(d => ({ id: d.id, name: '', parentid: d.parentid ?? null, order: d.order ?? 0 })), limited: true };
  }
}

/** 这个 Secret 能看到的部门（不带 id = 应用可见范围内的全部部门），给管理端挑同步范围用 */
async function fetchScopeTree(cfg) {
  const access_token = await token(cfg);
  const { depts, limited } = await deptList(access_token);
  const nodes = depts.map(d => ({ id: d.id, name: d.name, parent: d.parentid, order: d.order }));
  nodes.limited = limited;
  return nodes;
}

/** 从企业微信拉取：所选各部门（含子部门）的成员，合并去重。limited=true 表示只拿到了 ID（通讯录同步 Secret 受限） */
async function fetchDirectory(cfg) {
  const access_token = await token(cfg);
  const roots = deptIdsOf(cfg);
  const deptName = new Map();
  const deptTree = [];   // v3.5.68：含父子关系的部门节点，供自动建 org_departments
  const inScope = new Set();
  let limited = false;
  for (const root of roots) {
    const r = await deptList(access_token, root);
    limited = limited || r.limited;
    r.depts.forEach(d => { if (d.name) { deptName.set(d.id, d.name); deptTree.push({ id: d.id, name: d.name, parent: d.parentid, order: d.order }); } inScope.add(d.id); });
    inScope.add(root);
  }
  let members = [];
  try {
    if (limited) throw Object.assign(new Error('limited'), { errcode: FORBIDDEN });
    for (const root of roots) {
      members.push(...((await call('GET', '/cgi-bin/user/list', { access_token, department_id: root, fetch_child: 1 })).userlist || []));
    }
  } catch (e) {
    // user/list 拿不到（新建自建应用受限 / 通讯录同步 Secret 受限）：退回 list_id 分页拿 userid + 所在部门
    const deptsOf = new Map();
    let cursor = '';
    for (let guard = 0; guard < 100; guard++) {
      const j = await call('POST', '/cgi-bin/user/list_id', { access_token }, { cursor, limit: 10000 });
      for (const du of j.dept_user || []) {
        if (!inScope.has(du.department)) continue;
        if (!deptsOf.has(du.userid)) deptsOf.set(du.userid, []);
        deptsOf.get(du.userid).push(du.department);
      }
      if (!j.next_cursor) break;
      cursor = j.next_cursor;
    }
    const uniq = [...deptsOf.keys()].slice(0, 5000);
    members = [];
    let idOnly = limited;
    for (let i = 0; i < uniq.length; i += 5) {
      const chunk = uniq.slice(i, i + 5);
      if (!idOnly) {
        const batch = await Promise.all(chunk.map(uid => call('GET', '/cgi-bin/user/get', { access_token, userid: uid })
          .catch(err => { if (err.errcode === FORBIDDEN) idOnly = true; return null; })));
        if (!idOnly) { batch.forEach(u => { if (u) members.push(u); }); continue; }
      }
      // 只有 ID：姓名先用 UserId 占位（只用于新建账号；已有账号不改名），视为在职
      chunk.forEach(uid => members.push({ userid: uid, name: uid, department: deptsOf.get(uid), status: 1, _idOnly: true }));
    }
    if (idOnly) limited = true;
  }
  // 同一个人在多个部门（或选了父子两个部门）会出现多次，按 userid 去重
  const byId = new Map();
  for (const m of members) if (m && m.userid && !byId.has(m.userid)) byId.set(m.userid, m);
  return { members: [...byId.values()], deptName, deptTree, limited };
}

/** 这家企业微信在本系统的「登录凭证」provider key（同 corp），用于绑定 UserId；没配企业微信登录则返回 null */
function loginProviderFor(subject, corpId) {
  for (const c of wecomCredsOf.all(subject)) {
    try { if (JSON.parse(c.config || '{}').WECOM_CORP_ID === corpId) return 'wecom:' + c.id; } catch (_) {}
  }
  if (process.env.WECOM_CORP_ID && process.env.WECOM_CORP_ID === corpId) return 'wecom';
  return null;
}

/** 本组织可选的企业微信登录凭证（给管理端勾选「同步后绑定到哪些凭证」） */
function loginProviderChoices(subject) {
  const out = [];
  for (const c of wecomCredsOf.all(subject)) {
    let corp = ''; try { corp = JSON.parse(c.config || '{}').WECOM_CORP_ID || ''; } catch (_) {}
    const where = c.folder_id ? `（文件夹「${c.folder_name || ''}」共用）` : '';
    out.push({ key: 'wecom:' + c.id, label: '企业微信' + (c.label ? ' · ' + c.label : '') + where, corp_id: corp, folder: !!c.folder_id });
  }
  if (process.env.WECOM_CORP_ID) out.push({ key: 'wecom', label: '企业微信（本站默认凭证）', corp_id: process.env.WECOM_CORP_ID });
  return out;
}

/** 本次要绑定的登录凭证：auto=同 corp 的那个；custom=管理员勾的（只留仍然存在的）；none=不绑 */
function bindProvidersFor(subject, cfg) {
  const mode = cfg.bind_mode || 'auto';
  if (mode === 'none') return [];
  if (mode === 'custom') {
    const valid = new Set(loginProviderChoices(subject).map(x => x.key));
    return (cfg.bind_providers || []).filter(k => valid.has(k));
  }
  const p = loginProviderFor(subject, cfg.corp_id);
  return p ? [p] : [];
}

const ACTIVE = new Set([1, 4]);   // 1 已激活 / 4 未激活（还没加入企业微信，但在通讯录里）；2 禁用 / 5 退出企业 视为离开

/**
 * 执行一次同步。helpers：{ genOrgUid(subject), isEmail, isPhone }（复用 api.js 里的实现）。
 * 返回 { total, created, linked, added, removed, skipped, errors[], bind_provider }
 */
async function syncWecom(source, subject, cfg, helpers, fetcher = fetchDirectory, opts = {}) {
  const force = !!opts.force;
  const { members, deptName, deptTree, limited } = await fetcher(cfg);
  // v3.5.68：自动建部门树（非 limited 才有部门名/父子关系）；ext_id→部门 uuid 映射供成员归部门
  const extToDeptId = new Map();
  if (!limited && Array.isArray(deptTree) && deptTree.length) {
    for (const node of deptTree) {
      const extId = String(node.id);
      let dId = departments.getByExt.get(subject.id, 'wecom', extId);
      const parentId = node.parent != null ? (extToDeptId.get(String(node.parent)) || null) : null;
      if (dId) {
        departments.update.run(node.name || extId, parentId, dId.id);
      } else {
        dId = { id: crypto.randomUUID() };
        departments.insert.run(dId.id, node.name || extId, subject.id, parentId, 'wecom', extId, Number(node.order) || 0);
      }
      extToDeptId.set(extId, dId.id);
    }
  }
  const bindProviders = bindProvidersFor(subject, cfg);
  const bindProvider = bindProviders[0] || null;   // 匹配用：先按第一个绑定凭证找人
  const uidMode = cfg.uid_mode || 'userid';
  const pwHash = cfg.default_pw_hash || null;
  const out = { total: 0, created: 0, linked: 0, added: 0, removed: 0, skipped: 0, errors: [],
    bind_provider: bindProvider, bind_providers: bindProviders,
    bound: 0, pw_set: 0, kept: 0, conflicts: 0, unmatched: 0, no_contact: 0, force, limited: !!limited, warning: limited ? LIMITED_HINT : undefined };
  const seenUsers = new Set();
  const seenExt = new Set();
  const corpSc = corpScope(cfg.corp_id);

  // 登录凭证绑定：同步只「补上」，被单独改过的不动（除非 force）
  function applyBind(user, extId, p) {
    const owner = oauth.findByProvider.get(p, extId);
    if (owner && owner.id !== user.id) { out.conflicts++; return; }        // 这个 UserId 已绑在别人身上，从不抢
    if (owner) { appliedSet.run(source.id, user.id, 'bind', p, extId); return; }   // 已绑在本人身上（一人多号合并后会有多个 UserId）
    const cur = userOauthOf.get(user.id, p)?.open_id || null;
    if (cur === extId) { appliedSet.run(source.id, user.id, 'bind', p, extId); return; }
    const rec = appliedGet.get(source.id, user.id, 'bind', p);
    const pristine = !cur && !rec;                                          // 从没绑过、同步也没给他绑过
    if (!pristine && !force) { out.kept++; return; }                        // 解绑过 / 改绑成别的 → 尊重
    if (cur) oauth.unbind.run(user.id, p);
    oauth.bind.run(crypto.randomUUID(), user.id, p, extId, null);
    appliedSet.run(source.id, user.id, 'bind', p, extId);
    out.bound++;
  }
  // 默认组织密码：只给「没有组织密码」或「密码还是同步上次设的」成员设；改过 / 清过的不动（除非 force）
  function applyPassword(user) {
    if (!pwHash) return;
    const mem = orgMembers.get.get(subject.id, user.id);
    if (!mem || mem.source !== 'wecom') return;                            // 只管同步进来的成员，手动/导入的不动
    const cur = mem.password_hash || null;
    const rec = appliedGet.get(source.id, user.id, 'pw', '')?.value || null;
    if (cur === pwHash) { if (rec !== pwHash) appliedSet.run(source.id, user.id, 'pw', '', pwHash); return; }
    const untouched = (!cur && !rec) || (cur && rec && cur === rec);       // 没设过，或仍是同步上次设的（默认密码换了）
    if (!untouched && !force) { out.kept++; return; }
    orgMembers.setPassword.run(pwHash, subject.id, user.id);
    appliedSet.run(source.id, user.id, 'pw', '', pwHash);
    out.pw_set++;
  }

  for (const m of members) {
    const extId = String(m.userid);
    if (!ACTIVE.has(Number(m.status ?? 1))) { out.skipped++; continue; }
    // 属于已删除账号的成员（v3.5.49）：不建号、不关联，等他在企业微信里离开后封存自然失效
    if (blockedDir.get(source.parent_id || source.id, extId)) { out.blocked = (out.blocked || 0) + 1; continue; }
    out.total++;
    seenExt.add(extId);
    const email = String(m.email || m.biz_mail || '').trim().toLowerCase();
    const phone = String(m.mobile || '').trim();
    const name = String(m.name || extId).trim().slice(0, 40);
    const depts = (Array.isArray(m.department) ? m.department : []).map(id => deptName.get(id) || String(id)).join(',');
    try {
      let user = null;
      const link = linkGet.get(source.id, extId);
      if (link) user = users.findById.get(link.user_id) || null;
      if (!user && source.parent_id) {                       // 同一份文件夹通讯录，别的组织已经认出这个人
        const sib = siblingLink.get(source.parent_id, source.id, extId);
        if (sib) user = users.findById.get(sib.user_id) || null;
      }
      for (const p of bindProviders) { if (!user) user = oauth.findByProvider.get(p, extId) || null; }
      if (!user) user = corpUsers(cfg.corp_id, extId, { scope: corpSc })[0] || null;   // 同企业别的同步源 / 别的企业微信登录凭证认得这个人
      if (!user && email && helpers.isEmail(email)) user = users.findByEmail.get(email) || null;
      if (!user && phone && helpers.isPhone(phone)) user = users.findByPhone.get(phone) || null;
      if (user && user.is_public) { out.errors.push({ userid: extId, error: '命中公共账号，跳过' }); continue; }
      if (user && (user.deletion_state === 'deleted' || user.deletion_state === 'purged')) { out.blocked = (out.blocked || 0) + 1; continue; }   // 按邮箱 / 手机认到了已删除的账号
      // 只拿到 UserId（通讯录同步 Secret 受限）：认不出是不是已有账号。默认照样建号（姓名用 UserId 占位），
      // 一人多号 / 与已有账号重复的，可在组织成员列表里合并；同步源关了 idonly_create 则不建号只计数
      if (!user && m._idOnly && cfg.idonly_create === false) { out.unmatched++; continue; }
      if (!user && m._idOnly) out.created_idonly = (out.created_idonly || 0) + 1;
      // 之前只拿到 UserId 建的号，现在拿到了真名 → 把占位名换掉（别的情况不改名：外部姓名不可靠，用户可能自己改过）
      if (user && !m._idOnly && m.name && user.name === extId && m.name !== extId) {
        db.prepare("UPDATE users SET name=?, updated_at=datetime('now') WHERE id=?").run(name, user.id);
      }
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
      linkUpsert.run(source.id, extId, user.id, depts || null, m._idOnly ? null : (name || null));
      if (corpUsers(cfg.corp_id, extId, { scope: corpSc }).some(u => u.id !== user.id)) out.duplicates = (out.duplicates || 0) + 1;   // 以前留下的重复账号，等管理员合并
      for (const p of bindProviders) applyBind(user, extId, p);
      seenUsers.add(user.id);
      // 多联系方式（v3.5.63）：把企业微信成员的手机/个人邮箱/企业邮箱灌进 user_contacts（去重+上限按组织，静默跳过）
      if (!m._idOnly) { try { importWecomContacts(user.id, m, subject.id); } catch (_) {} }
      // 拿到了姓名但手机/邮箱都空：多半是企微自建应用/通讯录 Secret 没开放这些字段的读取权限（v3.5.65 提示）
      if (!m._idOnly && !phone && !email) out.no_contact++;
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
      // v3.5.68：成员归部门（取第一个有对应 org_departments 的外部部门 id；只给非 idOnly 成员）
      if (!m._idOnly && Array.isArray(m.department)) {
        for (const did of m.department) {
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
      out.errors.push({ error: '本次一个成员都没拉到，已跳过移除（请检查通讯录权限 / 部门 ID）' });
    } else {
      // 先删本源里已不在范围的映射（人回来了会按 UserId 再连上同一账号：user_oauth 绑定还在）
      const gone = new Set();
      for (const l of linksOf.all(source.id)) if (!seenExt.has(l.ext_id)) { linkDelete.run(source.id, l.ext_id); gone.add(l.user_id); }
      // 再移出：本源同步进来、这次没出现、也不在本组织其他同步源里的成员
      for (const mem of orgMembers.listBySubject.all(subject.id)) {
        if (mem.source !== 'wecom' || seenUsers.has(mem.user_id)) continue;
        if (!gone.has(mem.user_id)) continue;                         // 只处理「本源刚丢掉」的人，别的源负责的人不碰
        if (stillSynced.get(subject.id, mem.user_id)) continue;       // 还在其他同步源里
        orgMembers.remove.run(subject.id, mem.user_id); out.removed++;
      }
    }
  }
  // 有人拿到姓名但没手机/邮箱 → 提示管理员去企微后台开放字段权限（不覆盖「受限只拿到 ID」那条更严重的提示）
  if (out.no_contact > 0 && !out.limited && !out.warning) {
    out.warning = `有 ${out.no_contact} 名成员未取到手机/邮箱（姓名正常）。多半是企业微信「自建应用」或「通讯录同步」Secret 未开放手机号/邮箱字段的读取权限——请到企业微信后台对应应用的「可见范围 / 敏感信息」里开启后重新同步。`;
  }
  return out;
}

// ══════════════════════════════════════════
// 接收事件服务器（v3.5.39）：企业微信「通讯录同步 → 设置接收事件服务器」的回调
//   企业微信后台填 URL + Token + EncodingAESKey；成员/部门变动时推送加密 XML 事件。
//   签名：sha1(字典序拼接 [token, timestamp, nonce, encrypt])
//   加密：AES-256-CBC，key = base64(EncodingAESKey + '=')（32 字节），iv = key 前 16 字节，PKCS#7（块 32）
//   明文：16 字节随机 + 4 字节消息长度（大端）+ 消息 + receiveid（即企业 ID）
// ══════════════════════════════════════════
function cbKey(aesKey) {
  const key = Buffer.from(String(aesKey || '') + '=', 'base64');
  if (key.length !== 32) throw new Error('EncodingAESKey 应为 43 位');
  return key;
}
function cbSignature(token, timestamp, nonce, encrypt) {
  return crypto.createHash('sha1').update([String(token), String(timestamp), String(nonce), String(encrypt)].sort().join('')).digest('hex');
}
function cbVerify(token, q, encrypt) {
  const want = cbSignature(token, q.timestamp, q.nonce, encrypt);
  const got = String(q.msg_signature || '');
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
function cbDecrypt(aesKey, encrypt) {
  const key = cbKey(aesKey);
  const d = crypto.createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  d.setAutoPadding(false);
  let buf = Buffer.concat([d.update(Buffer.from(String(encrypt), 'base64')), d.final()]);
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 32) throw new Error('解密失败（填充错误）');
  buf = buf.subarray(0, buf.length - pad);
  const len = buf.readUInt32BE(16);
  if (20 + len > buf.length) throw new Error('解密失败（长度错误）');
  return { msg: buf.subarray(20, 20 + len).toString('utf8'), receiveid: buf.subarray(20 + len).toString('utf8') };
}
// 加密（企业微信那一侧做的事；这里给测试和自检用）
function cbEncrypt(aesKey, msg, receiveid) {
  const key = cbKey(aesKey);
  const body = Buffer.from(String(msg), 'utf8');
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  let buf = Buffer.concat([crypto.randomBytes(16), len, body, Buffer.from(String(receiveid), 'utf8')]);
  const pad = 32 - (buf.length % 32);
  buf = Buffer.concat([buf, Buffer.alloc(pad, pad)]);
  const c = crypto.createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  c.setAutoPadding(false);
  return Buffer.concat([c.update(buf), c.final()]).toString('base64');
}
// 极简 XML 取字段（企业微信事件是扁平 XML，值多为 CDATA）
function xmlField(xml, tag) {
  const m = String(xml || '').match(new RegExp('<' + tag + '>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))\\s*</' + tag + '>'));
  return m ? (m[1] !== undefined ? m[1] : m[2]).trim() : '';
}
// 成员改了 UserId（update_user 带 NewUserID）：把本源映射、该源绑定过的登录凭证、「同步设过什么」记录、
// 组织内 UID（还等于旧 UserId 时）一起改过去——否则下次全量同步会把他当成「离开 + 新人」
function renameExtId(source, subject, cfg, oldId, newId) {
  oldId = String(oldId || ''); newId = String(newId || '');
  if (!oldId || !newId || oldId === newId) return { renamed: false };
  const link = linkGet.get(source.id, oldId);
  if (!link || linkGet.get(source.id, newId)) return { renamed: false };
  db.transaction(() => {
    db.prepare('UPDATE dir_source_links SET ext_id=?, updated_at=datetime(\'now\') WHERE source_id=? AND ext_id=?').run(newId, source.id, oldId);
    for (const p of bindProvidersFor(subject, cfg)) {
      const owner = oauth.findByProvider.get(p, newId);
      if (!owner) db.prepare('UPDATE user_oauth SET open_id=? WHERE user_id=? AND provider=? AND open_id=?').run(newId, link.user_id, p, oldId);
    }
    db.prepare("UPDATE dir_sync_applied SET value=? WHERE source_id=? AND user_id=? AND kind='bind' AND value=?").run(newId, source.id, link.user_id, oldId);
    const mem = orgMembers.get.get(subject.id, link.user_id);
    if (mem && mem.org_uid === oldId && !orgMembers.orgUidTaken.get(subject.id, newId, link.user_id)) orgMembers.setOrgUid.run(newId, subject.id, link.user_id);
  })();
  return { renamed: true, user_id: link.user_id };
}

// 账号停用 / 删除时同步暂停企业微信成员（v3.5.44，同步源开了 push_suspend 才做）：user/update enable=0/1。
// 需要有通讯录写权限的 Secret（「通讯录同步」Secret；自建应用 Secret 不能改成员）。
// 注销 / 删除账号前核验「该成员已离职」（v3.5.49）：gone 没有这个人 / disabled 已禁用 / quit 已退出 / active 在职 / unknown 查不到
async function memberStatus(cfg, userid) {
  const access_token = await token(cfg);
  try {
    const m = await call('GET', '/cgi-bin/user/get', { access_token, userid: String(userid) });
    const st = Number(m.status ?? 1);
    return { status: st === 2 ? 'disabled' : st === 5 ? 'quit' : 'active' };
  } catch (e) {
    if (e.errcode === 60111) return { status: 'gone' };
    if (e.errcode !== FORBIDDEN) throw e;
    // 受限 Secret 读不了成员详情：只能看 UserId 还在不在通讯录里
    const ids = new Set(); let cursor = '';
    for (let i = 0; i < 100; i++) {
      const j = await call('POST', '/cgi-bin/user/list_id', { access_token }, { cursor, limit: 10000 });
      for (const x of j.dept_user || []) ids.add(String(x.userid));
      cursor = j.next_cursor; if (!cursor) break;
    }
    return ids.has(String(userid)) ? { status: 'unknown', error: '受限的「通讯录同步」Secret 读不到成员是否禁用（这个 UserId 仍在通讯录里）' } : { status: 'gone' };
  }
}
// 在企业微信里删除成员（需要有通讯录写权限的 Secret）
async function deleteMember(cfg, userid) {
  const access_token = await token(writeCfg(cfg));
  await call('GET', '/cgi-bin/user/delete', { access_token, userid: String(userid) });
}
async function setMemberEnabled(cfg, userid, enabled) {
  const access_token = await token(writeCfg(cfg));
  await call('POST', '/cgi-bin/user/update', { access_token }, { userid: String(userid), enable: enabled ? 1 : 0 });
}
// 在企业微信里创建成员（v3.5.69 出站 provisioning；需通讯录同步 Secret 的写权限）
async function createMember(cfg, f) {
  const access_token = await token(writeCfg(cfg));
  const body = { userid: String(f.userid), name: f.name };
  if (f.mobile) body.mobile = f.mobile;
  if (f.email) body.email = f.email;
  // department 必须是整数数组（企业微信 user/create 的类型要求）；缺省归根部门 [1]
  body.department = (Array.isArray(f.department) ? f.department : []).map(x => parseInt(x, 10)).filter(x => x > 0);
  if (!body.department.length) body.department = [1];
  await call('POST', '/cgi-bin/user/create', { access_token }, body);
  return f.userid;
}
// 建成员；userid 已存在（60106）时改走「增补部门」而不是覆盖——先读现有部门取并集再 update（避免把多部门覆盖成一个）
async function upsertMember(cfg, f) {
  try {
    return await createMember(cfg, f);
  } catch (e) {
    if (e.errcode === 60104) {
      // 手机号已在企业微信通讯录里：该成员很可能已在企业微信（或手机号被占用），不要再重复建号
      throw Object.assign(new Error('手机号已在企业微信通讯录里（该成员可能已存在于企业微信，请用「通讯录同步」拉取绑定，或在企业微信里处理该手机号）'), { errcode: 60104 });
    }
    if (e.errcode !== 60106) throw e;
    const access_token = await token(writeCfg(cfg));
    const cur = await call('GET', '/cgi-bin/user/get', { access_token, userid: String(f.userid) }).catch(() => null);
    const existing = (cur && Array.isArray(cur.department)) ? cur.department.map(x => parseInt(x, 10)).filter(x => x > 0) : [];
    const merged = [...new Set([...existing, ...(Array.isArray(f.department) ? f.department : []).map(x => parseInt(x, 10)).filter(x => x > 0)])];
    const body = { userid: String(f.userid) };
    if (f.name) body.name = f.name;
    if (f.mobile) body.mobile = f.mobile;
    if (f.email) body.email = f.email;
    body.department = merged.length ? merged : [1];
    await call('POST', '/cgi-bin/user/update', { access_token }, body);
    return f.userid;
  }
}

module.exports = { writeCfg, corpScope, corpUsers, corpOfProvider, findCorpDuplicates, memberStatus, deleteMember, createMember, upsertMember, effectiveCfg, CONN_KEYS, setMemberEnabled, LIMITED_HINT, cbSignature, cbVerify, cbDecrypt, cbEncrypt, xmlField, renameExtId, syncWecom, fetchDirectory, fetchScopeTree, loginProviderFor, loginProviderChoices, bindProvidersFor, deptIdsOf, apiBase };
