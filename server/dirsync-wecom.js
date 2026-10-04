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
const { db, users, oauth, orgMembers, oauthSubjects } = require('./db');

const linkGet    = db.prepare('SELECT * FROM dir_source_links WHERE source_id=? AND ext_id=?');
const linkUpsert = db.prepare(`INSERT INTO dir_source_links (source_id, ext_id, user_id, depts, updated_at) VALUES (?,?,?,?,datetime('now'))
  ON CONFLICT(source_id, ext_id) DO UPDATE SET user_id=excluded.user_id, depts=excluded.depts, updated_at=datetime('now')`);
const linksOf    = db.prepare('SELECT * FROM dir_source_links WHERE source_id=?');
const linkDelete = db.prepare('DELETE FROM dir_source_links WHERE source_id=? AND ext_id=?');
// 该用户是否还被本组织的「任一」同步源同步着（多同步源时，离开 A 但还在 B 的人不能移出）
const stillSynced = db.prepare(`SELECT 1 FROM dir_source_links l JOIN dir_sync_sources d ON d.id=l.source_id
  WHERE d.subject_id=? AND l.user_id=? LIMIT 1`);
const userOauthOf = db.prepare('SELECT open_id FROM user_oauth WHERE user_id=? AND provider=?');
const wecomCredsOf = db.prepare("SELECT id, label, config FROM oauth_providers WHERE platform='wecom' AND subject_id=?");
// 同步给成员设过什么（登录绑定 / 组织密码），用来判断之后是否被人单独改过
const appliedGet = db.prepare('SELECT value FROM dir_sync_applied WHERE source_id=? AND user_id=? AND kind=? AND key=?');
const appliedSet = db.prepare(`INSERT INTO dir_sync_applied (source_id,user_id,kind,key,value,updated_at) VALUES (?,?,?,?,?,datetime('now'))
  ON CONFLICT(source_id,user_id,kind,key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')`);

function apiBase() { return String(process.env.WECOM_API_BASE || 'https://qyapi.weixin.qq.com').replace(/\/+$/, ''); }

// 常见错误码的处理建议（附在报错后面，管理端「上次同步」里能直接看到）
const ERR_HINT = {
  40001: 'Secret 不对，或不是这个企业的',
  40013: '企业 ID（corpid）不对',
  48009: '这个 Secret 无权读取通讯录详情：「通讯录同步」Secret 已被企业微信限制，请改用「自建应用」Secret',
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
const LIMITED_HINT = '当前 Secret 是「通讯录同步」Secret，企业微信已限制它读取姓名 / 部门名 / 联系方式（48009），本次只拿到了 UserId 和部门 ID。要同步姓名等信息，请改填「自建应用」的 Secret（应用可见范围设为要同步的部门，并把本服务器出口 IP 加进应用的可信 IP）。';

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
  const inScope = new Set();
  let limited = false;
  for (const root of roots) {
    const r = await deptList(access_token, root);
    limited = limited || r.limited;
    r.depts.forEach(d => { if (d.name) deptName.set(d.id, d.name); inScope.add(d.id); });
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
  return { members: [...byId.values()], deptName, limited };
}

/** 这家企业微信在本系统的「登录凭证」provider key（同 corp），用于绑定 UserId；没配企业微信登录则返回 null */
function loginProviderFor(subject, corpId) {
  for (const c of wecomCredsOf.all(subject.id)) {
    try { if (JSON.parse(c.config || '{}').WECOM_CORP_ID === corpId) return 'wecom:' + c.id; } catch (_) {}
  }
  if (process.env.WECOM_CORP_ID && process.env.WECOM_CORP_ID === corpId) return 'wecom';
  return null;
}

/** 本组织可选的企业微信登录凭证（给管理端勾选「同步后绑定到哪些凭证」） */
function loginProviderChoices(subject) {
  const out = [];
  for (const c of wecomCredsOf.all(subject.id)) {
    let corp = ''; try { corp = JSON.parse(c.config || '{}').WECOM_CORP_ID || ''; } catch (_) {}
    out.push({ key: 'wecom:' + c.id, label: '企业微信' + (c.label ? ' · ' + c.label : ''), corp_id: corp });
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
  const { members, deptName, limited } = await fetcher(cfg);
  const bindProviders = bindProvidersFor(subject, cfg);
  const bindProvider = bindProviders[0] || null;   // 匹配用：先按第一个绑定凭证找人
  const uidMode = cfg.uid_mode || 'userid';
  const pwHash = cfg.default_pw_hash || null;
  const out = { total: 0, created: 0, linked: 0, added: 0, removed: 0, skipped: 0, errors: [],
    bind_provider: bindProvider, bind_providers: bindProviders,
    bound: 0, pw_set: 0, kept: 0, conflicts: 0, unmatched: 0, force, limited: !!limited, warning: limited ? LIMITED_HINT : undefined };
  const seenUsers = new Set();
  const seenExt = new Set();

  // 登录凭证绑定：同步只「补上」，被单独改过的不动（除非 force）
  function applyBind(user, extId, p) {
    const owner = oauth.findByProvider.get(p, extId);
    if (owner && owner.id !== user.id) { out.conflicts++; return; }        // 这个 UserId 已绑在别人身上，从不抢
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
      for (const p of bindProviders) { if (!user) user = oauth.findByProvider.get(p, extId) || null; }
      if (!user && email && helpers.isEmail(email)) user = users.findByEmail.get(email) || null;
      if (!user && phone && helpers.isPhone(phone)) user = users.findByPhone.get(phone) || null;
      if (user && user.is_public) { out.errors.push({ userid: extId, error: '命中公共账号，跳过' }); continue; }
      // 只拿到 UserId（通讯录同步 Secret 受限）：没有邮箱手机，无法确认是不是已有账号——不建号，免得给已有用户造重复账号
      if (!user && m._idOnly) { out.unmatched++; continue; }
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
      linkUpsert.run(source.id, extId, user.id, depts || null);
      for (const p of bindProviders) applyBind(user, extId, p);
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

module.exports = { LIMITED_HINT, cbSignature, cbVerify, cbDecrypt, cbEncrypt, xmlField, renameExtId, syncWecom, fetchDirectory, fetchScopeTree, loginProviderFor, loginProviderChoices, bindProvidersFor, deptIdsOf, apiBase };
