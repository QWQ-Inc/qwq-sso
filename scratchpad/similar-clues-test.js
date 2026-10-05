// 疑似重复账号「新线索」单测（v3.5.65）：复刻 findSimilarUsers 的线索收集 + 并查集，
// 用 node:sqlite 真表喂图里的数据，验证：
//   ① 赵思达(企微 org_uid=MilkSU) 与 MilkSU(飞书 ext_name=MilkSU) 因 dirname 线索归为一组
//   ② 两账号共享同一手机（主字段/多联系方式）因 phone 线索归为一组
//   ③ 两账号共享同一邮箱（user_contacts）因 email 线索归为一组
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(':memory:');
db.exec(`
CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT, phone TEXT, role TEXT, is_public INTEGER DEFAULT 0, merged_into TEXT, deletion_state TEXT, kyc_verified INTEGER DEFAULT 0, kyc_pseudonym TEXT, uid_seq INTEGER);
CREATE TABLE merge_ignore_pairs (a TEXT, b TEXT);
CREATE TABLE user_oauth (user_id TEXT, provider TEXT, union_id TEXT);
CREATE TABLE dir_source_links (user_id TEXT, ext_name TEXT, ext_union TEXT);
CREATE TABLE user_contacts (user_id TEXT, kind TEXT, value TEXT);
CREATE TABLE org_members (user_id TEXT, org_uid TEXT);
`);

// ---- 复刻 api.js 里的纯逻辑（与实现保持一致）----
const SIMILAR_STRONG = new Set(['kyc', 'union', 'corp']);
const pairKey = (x, y) => x < y ? [x, y] : [y, x];
function similarNameKey(n) {
  let k = String(n || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
  for (let i = 0; i < 3; i++) k = k.replace(/[（(【\[][^（()）【】\[\]]*[)）】\]]$/, '');
  return k.length >= 2 ? k : '';
}
function findSimilar(corpDupes = []) {
  const rows = db.prepare(`SELECT * FROM users WHERE is_public=0 AND merged_into IS NULL AND deletion_state IS NULL`).all();
  const byId = new Map(rows.map(u => [u.id, u]));
  const ignored = new Set(db.prepare('SELECT a, b FROM merge_ignore_pairs').all().map(r => r.a + '|' + r.b));
  const buckets = new Map();
  const put = (kind, key, id) => { if (!key || !byId.has(id)) return; const k = kind + '|' + key; if (!buckets.has(k)) buckets.set(k, new Set()); buckets.get(k).add(id); };
  for (const u of rows) {
    if (u.kyc_verified && u.kyc_pseudonym) put('kyc', u.kyc_pseudonym, u.id);
    put('name', similarNameKey(u.name), u.id);
    const em = String(u.email || '').trim().toLowerCase(); if (em.includes('@')) put('email', em, u.id);
    const ph = String(u.phone || '').trim(); if (ph.length >= 6) put('phone', ph, u.id);
  }
  for (const b of db.prepare("SELECT user_id, provider, union_id FROM user_oauth WHERE union_id IS NOT NULL AND union_id <> ''").all())
    put('union', String(b.provider).split(':')[0] + ':' + b.union_id, b.user_id);
  for (const l of db.prepare("SELECT user_id, ext_union FROM dir_source_links WHERE ext_union IS NOT NULL AND ext_union <> ''").all()) put('union', 'feishu:' + l.ext_union, l.user_id);
  for (const g of corpDupes) for (const u of g.users) put('corp', g.corp_id + ':' + String(g.ext_id).toLowerCase(), u.id);
  for (const c of db.prepare("SELECT user_id, kind, value FROM user_contacts WHERE value <> ''").all()) {
    const v = String(c.value || '').trim().toLowerCase();
    if (c.kind === 'email' && v.includes('@')) put('email', v, c.user_id);
    else if (c.kind === 'phone' && v.length >= 6) put('phone', v, c.user_id);
  }
  const dirKey = s => { const k = String(s || '').normalize('NFKC').trim().toLowerCase(); return k.length >= 3 ? k : ''; };
  for (const l of db.prepare("SELECT user_id, ext_name FROM dir_source_links WHERE ext_name IS NOT NULL AND ext_name <> ''").all()) put('dirname', dirKey(l.ext_name), l.user_id);
  for (const m of db.prepare("SELECT user_id, org_uid FROM org_members WHERE org_uid IS NOT NULL AND org_uid <> ''").all()) put('dirname', dirKey(m.org_uid), m.user_id);

  const edges = new Map();
  for (const [k, set] of buckets) {
    const kind = k.split('|')[0], ids = [...set];
    if (ids.length < 2 || (!SIMILAR_STRONG.has(kind) && ids.length > 8)) continue;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = pairKey(ids[i], ids[j]); const ua = byId.get(a), ub = byId.get(b);
      if (ignored.has(a + '|' + b)) continue;
      if (ua.kyc_verified && ub.kyc_verified && ua.kyc_pseudonym && ub.kyc_pseudonym && ua.kyc_pseudonym !== ub.kyc_pseudonym) continue;
      if (ua.role === 'admin' && ub.role === 'admin') continue;
      const ek = a + '|' + b; if (!edges.has(ek)) edges.set(ek, new Set()); edges.get(ek).add(kind);
    }
  }
  const parent = new Map(); const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  for (const ek of edges.keys()) for (const id of ek.split('|')) if (!parent.has(id)) parent.set(id, id);
  for (const ek of edges.keys()) { const [a, b] = ek.split('|'); const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); }
  const groups = new Map();
  for (const id of parent.keys()) { const r = find(id); if (!groups.has(r)) groups.set(r, { ids: [], reasons: new Set() }); groups.get(r).ids.push(id); }
  for (const [ek, kinds] of edges) { const g = groups.get(find(ek.split('|')[0])); kinds.forEach(k => g.reasons.add(k)); }
  return [...groups.values()].map(g => ({ ids: g.ids.sort(), reasons: [...g.reasons].sort() }));
}

let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log(`${cond ? '✓' : '✗'} ${name}`); };
const reset = () => { db.exec('DELETE FROM users; DELETE FROM dir_source_links; DELETE FROM user_contacts; DELETE FROM org_members; DELETE FROM user_oauth; DELETE FROM merge_ignore_pairs;'); };
const addUser = (id, name, opts = {}) => db.prepare('INSERT INTO users (id,name,email,phone,role,uid_seq) VALUES (?,?,?,?,?,?)').run(id, name, opts.email || null, opts.phone || null, opts.role || 'user', opts.seq || 0);

// 场景 1：图里的两个账号 —— 企微 org_uid=MilkSU / 飞书 ext_name=MilkSU，姓名不同、无共享邮箱手机
reset();
addUser('zhao', '赵思达');                       // 企微
addUser('milk', 'MilkSU', { email: 'milksu@entropy.asia', phone: '18510077233' });  // 飞书
db.prepare("INSERT INTO org_members (user_id,org_uid) VALUES ('zhao','MilkSU')").run();        // 企微 org 内 UID
db.prepare("INSERT INTO dir_source_links (user_id,ext_name) VALUES ('milk','MilkSU')").run();  // 飞书 应用内姓名
let g1 = findSimilar();
ok('① 赵思达与MilkSU 因 dirname 归为一组', g1.some(g => g.ids.includes('zhao') && g.ids.includes('milk') && g.reasons.includes('dirname')));

// 场景 2：共享手机（一个在主字段、一个在多联系方式）
reset();
addUser('a', '张三', { phone: '13900000001' });
addUser('b', '李四');
db.prepare("INSERT INTO user_contacts (user_id,kind,value) VALUES ('b','phone','13900000001')").run();
let g2 = findSimilar();
ok('② 共享手机（主字段 vs user_contacts）归为一组', g2.some(g => g.ids.includes('a') && g.ids.includes('b') && g.reasons.includes('phone')));

// 场景 3：共享邮箱（都在 user_contacts，企微灌入的企业邮箱）
reset();
addUser('c', '王五');
addUser('d', 'Wang Wu');
db.prepare("INSERT INTO user_contacts (user_id,kind,value) VALUES ('c','email','w@corp.com')").run();
db.prepare("INSERT INTO user_contacts (user_id,kind,value) VALUES ('d','email','W@CORP.COM')").run();  // 大小写不敏感
let g3 = findSimilar();
ok('③ 共享企业邮箱（大小写不敏感）归为一组', g3.some(g => g.ids.includes('c') && g.ids.includes('d') && g.reasons.includes('email')));

// 场景 4：不同手机不误连
reset();
addUser('e', '不同人1', { phone: '13900000001' });
addUser('f', '不同人2', { phone: '13900000002' });
let g4 = findSimilar();
ok('④ 不同手机不误连', !g4.some(g => g.ids.includes('e') && g.ids.includes('f')));

// 场景 5：dirKey 太短（<3）不作线索，避免 "1" "a" 乱连
reset();
addUser('g', 'X'); addUser('h', 'Y');
db.prepare("INSERT INTO org_members (user_id,org_uid) VALUES ('g','ab')").run();   // 2 字符
db.prepare("INSERT INTO dir_source_links (user_id,ext_name) VALUES ('h','ab')").run();
let g5 = findSimilar();
ok('⑤ dirname 太短（<3）不连', !g5.some(g => g.ids.includes('g') && g.ids.includes('h')));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
