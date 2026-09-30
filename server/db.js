/**
 * 数据库层 - better-sqlite3
 * 所有数据持久化到 data/sso.db
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// index.js 的 loadEnvFromDb() 一直是认 DB_PATH 的，这里以前写死成 data/sso.db，
// 导致一旦配置了 DB_PATH，两边会读写不同的库文件。统一以 DB_PATH 为准。
const DB_FILE  = process.env.DB_PATH || path.join(__dirname, '../data/sso.db');
const DATA_DIR = path.dirname(DB_FILE);
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_FILE);

// WAL 模式提升并发性能
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ⚠️ 字段迁移（ALTER TABLE）统一放在建表之后，见本文件下方「迁移」区块。
// 不要往这里加 ALTER —— 此处表还没建，ALTER 会被 catch 静默吞掉。

// 服务商调用计数表（用于轮询）
try {
  db.exec(`CREATE TABLE IF NOT EXISTS provider_stats (
    provider  TEXT PRIMARY KEY,
    call_count INTEGER NOT NULL DEFAULT 0,
    fail_count INTEGER NOT NULL DEFAULT 0,
    last_used  TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
} catch(_) {}

// API 调用日志表（入站+出站）
try {
  db.exec(`CREATE TABLE IF NOT EXISTS api_call_logs (
    id          TEXT PRIMARY KEY,
    direction   TEXT NOT NULL DEFAULT 'inbound',
    method      TEXT, path TEXT, provider TEXT,
    status      INTEGER, success INTEGER NOT NULL DEFAULT 1,
    error_msg   TEXT, duration_ms INTEGER, ip TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
} catch(_) {}

// 轮询策略配置
try {
  db.exec(`INSERT OR IGNORE INTO shop_config(key_name,value) VALUES
    ('sms_poll_strategy','least'),
    ('email_poll_strategy','least'),
    ('kyc_poll_strategy','least')`
  );
} catch(_) {}

// ──────────────────────────────────────────
// 建表
// ──────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    uid_seq     INTEGER UNIQUE,          -- 自增友好编号 00001
    name        TEXT NOT NULL DEFAULT '',
    email       TEXT UNIQUE,
    phone       TEXT UNIQUE,
    avatar      TEXT,
    password_hash TEXT,
    role        TEXT NOT NULL DEFAULT 'user',   -- user | admin
    admin_level INTEGER,                         -- 管理员: 1/2/3
    user_level  INTEGER NOT NULL DEFAULT 4,      -- 普通用户: 1~5
    status      TEXT NOT NULL DEFAULT 'active',  -- active | disabled
    kyc_verified INTEGER NOT NULL DEFAULT 0,
    kyc_name    TEXT,
    kyc_id_tail TEXT,
    kyc_provider TEXT,
    kyc_verified_at TEXT,
    points      INTEGER NOT NULL DEFAULT 0,
    checkin_streak INTEGER NOT NULL DEFAULT 0,
    last_checkin TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_oauth (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider    TEXT NOT NULL,   -- wechat | wecom | feishu | dingtalk
    open_id     TEXT NOT NULL,
    union_id    TEXT,
    bound_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(provider, open_id)
  );

  CREATE TABLE IF NOT EXISTS otp_store (
    key_name    TEXT PRIMARY KEY,
    code        TEXT NOT NULL,
    expire_at   INTEGER NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS oauth_states (
    state       TEXT PRIMARY KEY,
    provider    TEXT NOT NULL,
    expire_at   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS login_logs (
    id          TEXT PRIMARY KEY,
    user_id     TEXT,
    user_name   TEXT,
    uid_seq     TEXT,
    method      TEXT NOT NULL,
    app_name    TEXT NOT NULL DEFAULT '本系统',
    ip          TEXT,
    user_agent  TEXT,
    status      TEXT NOT NULL DEFAULT 'success',  -- success | failed | disabled
    fail_reason TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS apps (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    icon        TEXT NOT NULL DEFAULT '📦',
    icon_bg     TEXT NOT NULL DEFAULT '#F0F0F0',
    description TEXT NOT NULL DEFAULT '',
    client_id   TEXT UNIQUE NOT NULL,
    client_secret TEXT NOT NULL,
    callback_url TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',  -- enabled | disabled | pending
    visible     INTEGER NOT NULL DEFAULT 0,        -- 用户端市场是否可见
    auth_users  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_app_auth (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    app_id      TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    authed_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, app_id)
  );

  -- ── QWQ SSO 作为身份提供方（OIDC Provider）── --
  -- 授权码：单次使用、10 分钟过期，绑定 client_id + redirect_uri + PKCE
  CREATE TABLE IF NOT EXISTS oauth_auth_codes (
    code            TEXT PRIMARY KEY,
    app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    redirect_uri    TEXT NOT NULL,
    scope           TEXT NOT NULL DEFAULT 'openid',
    nonce           TEXT,
    code_challenge  TEXT,
    challenge_method TEXT,
    used            INTEGER NOT NULL DEFAULT 0,
    expires_at      INTEGER NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 访问令牌：不存明文，只存 sha256
  CREATE TABLE IF NOT EXISTS oauth_access_tokens (
    token_hash  TEXT PRIMARY KEY,
    app_id      TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope       TEXT NOT NULL DEFAULT 'openid',
    expires_at  INTEGER NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS api_keys (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    token_hash  TEXT NOT NULL,
    token_prefix TEXT NOT NULL,
    scopes      TEXT NOT NULL DEFAULT '[]',        -- JSON array
    status      TEXT NOT NULL DEFAULT 'active',    -- active | revoked
    last_used_at TEXT,
    created_by  TEXT REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS env_config (
    key_name    TEXT PRIMARY KEY,
    value       TEXT NOT NULL DEFAULT '',
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS points_log (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta       INTEGER NOT NULL,
    reason      TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS uid_seq (
    id INTEGER PRIMARY KEY AUTOINCREMENT
  );
`);

// ──────────────────────────────────────────
// 迁移：给已存在的表补字段（已存在则被 catch 跳过）
//
// ⚠️ 必须放在上面的建表语句「之后」。
// 历史上这一整块被放在建表之前，导致全新数据库首次启动时所有 ALTER
// 都因「表不存在」而静默失败，字段要等到第二次启动才补上——
// 表现为首次安装后功能残缺、重启一次又莫名其妙好了。新增字段请加在本区块内。
// ──────────────────────────────────────────
try { db.exec('ALTER TABLE users ADD COLUMN can_rename INTEGER NOT NULL DEFAULT 1'); } catch(_) {}
try { db.exec('ALTER TABLE users ADD COLUMN can_change_email INTEGER NOT NULL DEFAULT 1'); } catch(_) {}
try { db.exec('ALTER TABLE users ADD COLUMN can_change_phone INTEGER NOT NULL DEFAULT 1'); } catch(_) {}
try { db.exec("ALTER TABLE users ADD COLUMN timezone TEXT NOT NULL DEFAULT 'auto'"); } catch(_) {}
// 记录用户对某个应用实际授权了哪些 scope（老数据默认给最小集）
try { db.exec("ALTER TABLE user_app_auth ADD COLUMN scope TEXT NOT NULL DEFAULT 'openid profile'"); } catch(_) {}
// 2FA（TOTP 二次验证）
try { db.exec('ALTER TABLE users ADD COLUMN twofa_enabled INTEGER NOT NULL DEFAULT 0'); } catch(_) {}
try { db.exec('ALTER TABLE users ADD COLUMN twofa_secret TEXT'); } catch(_) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS twofa_recovery_codes (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, code_hash TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch(_) {}
// Passkey（WebAuthn 凭据）
try { db.exec(`CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, cred_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL, counter INTEGER NOT NULL DEFAULT 0, transports TEXT,
  name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used_at TEXT
)`); } catch(_) {}
// 公告系统
try { db.exec(`CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
  level TEXT NOT NULL DEFAULT 'info',              -- info | warn | urgent
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))  -- 内容更新会刷新，用于"更新后重弹"
)`); } catch(_) {}
// 用户对公告的已读状态：记录已读时公告的 updated_at，之后公告再更新则重弹
try { db.exec(`CREATE TABLE IF NOT EXISTS announcement_reads (
  user_id TEXT NOT NULL, announcement_id TEXT NOT NULL,
  read_version TEXT NOT NULL,                       -- 已读时公告的 updated_at
  read_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, announcement_id)
)`); } catch(_) {}
// 站点法律文档（服务条款 / 隐私政策），富文本 HTML，管理端可编辑
try { db.exec(`CREATE TABLE IF NOT EXISTS site_documents (
  doc_key TEXT PRIMARY KEY,                          -- terms | privacy
  title TEXT NOT NULL DEFAULT '', content TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch(_) {}
try { db.exec("ALTER TABLE site_documents ADD COLUMN link TEXT NOT NULL DEFAULT ''"); } catch(_) {}   // 可选外部链接，填了则点击跳外链
// 公告：富文本内容 + 可选外部链接
try { db.exec("ALTER TABLE announcements ADD COLUMN link TEXT NOT NULL DEFAULT ''"); } catch(_) {}
// 用户可自定义 UID（uid_seq 仍是内部自增整数，uid_code 是对外展示/登录用的字符串）
try { db.exec('ALTER TABLE users ADD COLUMN uid_code TEXT'); } catch(_) {}
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_uid_code ON users(uid_code) WHERE uid_code IS NOT NULL'); } catch(_) {}
// 用户分组（互斥，一人一个）与标签（可叠加，一人多个）——与等级 U/A 无关
try { db.exec('ALTER TABLE users ADD COLUMN group_id TEXT'); } catch(_) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS user_groups (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#888',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch(_) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS user_tags (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL DEFAULT '#888',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch(_) {}
try { db.exec(`CREATE TABLE IF NOT EXISTS user_tag_map (
  user_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (user_id, tag_id)
)`); } catch(_) {}
// 公共账号（共享账号）：本身是一条 users 行，is_public=1，owner_group_id 指向所属分组。
// 仅保留基础功能（禁商城/转账），只能被授权成员「切换」使用，不能自己密码登录。
try { db.exec('ALTER TABLE users ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0'); } catch(_) {}
try { db.exec('ALTER TABLE users ADD COLUMN owner_group_id TEXT'); } catch(_) {}
// 哪些真实用户被授权使用某个公共账号（管理员指定，且需在该分组内）
try { db.exec(`CREATE TABLE IF NOT EXISTS public_account_members (
  public_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (public_id, user_id)
)`); } catch(_) {}
// 分组管理员：真实用户被指定为某分组的管理员（与系统管理员并存、互不影响）
try { db.exec(`CREATE TABLE IF NOT EXISTS group_admins (
  group_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (group_id, user_id)
)`); } catch(_) {}
// KYC 假名化标识 + 姓名/证件号哈希（S-08 去重、S-02 姓名比对）——只存 HMAC，绝不存原文
try { db.exec('ALTER TABLE users ADD COLUMN kyc_pseudonym TEXT'); } catch(_) {}
try { db.exec('ALTER TABLE users ADD COLUMN kyc_name_hash TEXT'); } catch(_) {}
try { db.exec("ALTER TABLE shop_goods ADD COLUMN redeem_mode TEXT NOT NULL DEFAULT 'code'"); } catch(_) {}
try { db.exec('ALTER TABLE shop_goods ADD COLUMN allow_instant INTEGER NOT NULL DEFAULT 1'); } catch(_) {}
try { db.exec('ALTER TABLE shop_goods ADD COLUMN redirect_url TEXT'); } catch(_) {}
try { db.exec('ALTER TABLE shop_goods ADD COLUMN allow_transfer INTEGER NOT NULL DEFAULT 1'); } catch(_) {}
try { db.exec('ALTER TABLE shop_goods ADD COLUMN transfer_fee INTEGER NOT NULL DEFAULT 0'); } catch(_) {}
try { db.exec("ALTER TABLE api_keys ADD COLUMN key_type TEXT NOT NULL DEFAULT 'live'"); } catch(_) {}
try { db.exec("ALTER TABLE api_keys ADD COLUMN trusted_ips TEXT"); } catch(_) {}
try { db.exec("ALTER TABLE api_keys ADD COLUMN token_plain TEXT"); } catch(_) {} // 仅测试密钥明文保存，供随时查看
try { db.exec('ALTER TABLE shop_goods ADD COLUMN is_blind_box INTEGER NOT NULL DEFAULT 0'); } catch(_) {}
try { db.exec('ALTER TABLE shop_goods ADD COLUMN open_instantly INTEGER NOT NULL DEFAULT 1'); } catch(_) {}
try { db.exec('ALTER TABLE shop_goods ADD COLUMN category TEXT'); } catch(_) {}   // 商品分类（v3.4.43）
try { db.exec("ALTER TABLE apps ADD COLUMN status TEXT NOT NULL DEFAULT 'enabled'"); } catch(_) {}
// 应用「发起地址」：用户在控制台点「打开」时跳转的地址（应用自己的登录入口/主页）。
// 留空则由 SSO 用应用登记的 callback_url 直接拼授权链接跳转（IdP 发起式）。
try { db.exec("ALTER TABLE apps ADD COLUMN launch_url TEXT"); } catch(_) {}
// 应用「必传字段」：授权时用户不可取消的 scope（空格分隔，如 'profile email'）。
// openid 天然必传；这里配的会强制包含进 id_token/userinfo，避免应用端映射失败。
try { db.exec("ALTER TABLE apps ADD COLUMN required_scopes TEXT"); } catch(_) {}
// 三方登录「多主体」：一个渠道（如微信）可挂多套登录凭证（多组织/多架构）。
// 环境变量里配的那套仍是各平台的「默认凭证」（provider=平台名，零迁移）；
// oauth_providers 这张表存的是额外「凭证」，provider=平台名:凭证id。config 是凭证 JSON（含 secret）。
try { db.exec(`CREATE TABLE IF NOT EXISTS oauth_providers (
  id          TEXT PRIMARY KEY,
  platform    TEXT NOT NULL,                 -- wechat | wecom | feishu | ...
  label       TEXT NOT NULL DEFAULT '',      -- 凭证名，如「A公司微信」，展示用
  config      TEXT NOT NULL DEFAULT '{}',    -- JSON：该凭证（键名与该平台环境变量同名）
  enabled     INTEGER NOT NULL DEFAULT 1,
  sort_weight INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch(_) {}
// 「主体」（组织）：一个主体可挂多套登录凭证。同一主体下不同凭证登录进来的用户【同人识别合并】
// （按 unionid / 邮箱匹配为同一账号）。默认每套凭证各自独立成一个主体（互不合并）。
try { db.exec(`CREATE TABLE IF NOT EXISTS oauth_subjects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1,
  sort_weight INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch(_) {}
try { db.exec('ALTER TABLE oauth_providers ADD COLUMN subject_id TEXT'); } catch(_) {}
// 组织成员（组织=主体）：显式的「用户 ∈ 组织」关系 + 组织内标识 org_uid（自定义/导入，仅组织内身份辨认+必要认证）。
try { db.exec(`CREATE TABLE IF NOT EXISTS org_members (
  subject_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  org_uid    TEXT,
  source     TEXT NOT NULL DEFAULT 'manual',   -- manual | import | auto
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (subject_id, user_id)
)`); } catch(_) {}
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_org_uid ON org_members(subject_id, org_uid) WHERE org_uid IS NOT NULL'); } catch(_) {}
// 组织内 org_uid 自动生成规则 + per-组织自增计数（挂在主体上）
try { db.exec('ALTER TABLE oauth_subjects ADD COLUMN uid_prefix TEXT'); } catch(_) {}
try { db.exec('ALTER TABLE oauth_subjects ADD COLUMN uid_len INTEGER NOT NULL DEFAULT 4'); } catch(_) {}
try { db.exec('ALTER TABLE oauth_subjects ADD COLUMN uid_seq INTEGER NOT NULL DEFAULT 0'); } catch(_) {}
// 每登录主体的小管理体系（v3.4.32）：强制两步验证 / 登录 IP 白名单(CIDR,逗号) / 登录时段(HH:MM)
try { db.exec('ALTER TABLE oauth_subjects ADD COLUMN require_2fa INTEGER NOT NULL DEFAULT 0'); } catch(_) {}
try { db.exec('ALTER TABLE oauth_subjects ADD COLUMN ip_allow TEXT'); } catch(_) {}
try { db.exec('ALTER TABLE oauth_subjects ADD COLUMN login_start TEXT'); } catch(_) {}
try { db.exec('ALTER TABLE oauth_subjects ADD COLUMN login_end TEXT'); } catch(_) {}
// 应用按组织开放：一个应用可开放给若干组织；该应用在 app_orgs 里没有任何行 = 全局（通用）应用。
try { db.exec(`CREATE TABLE IF NOT EXISTS app_orgs (
  app_id     TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  PRIMARY KEY (app_id, subject_id)
)`); } catch(_) {}
// 备忘录（v3.4.21）：个人备忘录，可打标签、转交给某用户、带图片/文件/链接附件。
try { db.exec(`CREATE TABLE IF NOT EXISTS memos (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  body       TEXT NOT NULL DEFAULT '',
  tags       TEXT NOT NULL DEFAULT '',          -- 逗号分隔
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch(_) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_memos_owner ON memos(owner_id, updated_at)'); } catch(_) {}
// 备忘录附件：kind=image|file 用 data BLOB；kind=link 用 url。图片/文件只存白名单类型（后端 magic bytes 校验）。
try { db.exec(`CREATE TABLE IF NOT EXISTS memo_attachments (
  id         TEXT PRIMARY KEY,
  memo_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,                      -- image | file | link
  filename   TEXT,
  mime       TEXT,
  size       INTEGER NOT NULL DEFAULT 0,
  url        TEXT,
  data       BLOB,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`); } catch(_) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_memo_att ON memo_attachments(memo_id)'); } catch(_) {}
// 迁移：v3.4.14 里每套凭证各自独立——给无主体的凭证各建一个「同 id」主体（保持互不合并的现状）
try {
  const orphans = db.prepare("SELECT id,label FROM oauth_providers WHERE subject_id IS NULL OR subject_id=''").all();
  const insS = db.prepare("INSERT OR IGNORE INTO oauth_subjects (id,name) VALUES (?,?)");
  const updP = db.prepare("UPDATE oauth_providers SET subject_id=? WHERE id=?");
  orphans.forEach(o => { insS.run(o.id, o.label || o.id); updP.run(o.id, o.id); });
} catch(_) {}

// 防篡改审计存证链（v3.4.17）：敏感/危险操作按发生顺序哈希链式存证，任何事后篡改都会断链被查出。
// row_hash = sha256(id\n event_type\n subject\n actor\n detail\n created_at\n prev_hash)，
// 首条 prev_hash = 64 个 0；逻辑与校验在 server/audit.js。
try { db.exec(`CREATE TABLE IF NOT EXISTS audit_chain (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  id         TEXT NOT NULL,
  event_type TEXT NOT NULL,
  subject    TEXT,
  actor      TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL,
  prev_hash  TEXT NOT NULL,
  row_hash   TEXT NOT NULL
)`); } catch(_) {}

// 注：这里曾有一行 UPDATE api_keys SET status='revoked' WHERE status='active'，
// 注释标称「一次性历史迁移」，实际没有任何条件保护，等于每次服务启动都作废全部密钥
// （Zeabur 每次部署都重启 → 每次发版第三方密钥集体失效）。v3.3.0 已删除。
// 若将来真需要一次性迁移，请用带版本标记的方式，不要写成无条件语句。

// ──────────────────────────────────────────
// 辅助：生成 uid_seq
// ──────────────────────────────────────────
function nextUidSeq() {
  const r = db.prepare('INSERT INTO uid_seq DEFAULT VALUES').run();
  return r.lastInsertRowid;
}

// ──────────────────────────────────────────
// UID 生成（对外展示/登录用的 uid_code）
//   UID_MODE   = sequential（默认，按 uid_seq 补零）| random（随机数字）
//   UID_PREFIX = 前缀，如 QWQ-（默认空）
//   UID_LENGTH = 数字位数（默认 5，夹在 1~24）
// uid_seq 仍是内部自增整数，永不改；uid_code 才是自定义的那个。
// ──────────────────────────────────────────
function genUidCode(seq) {
  const prefix = String(process.env.UID_PREFIX || '');
  const len    = Math.max(1, Math.min(24, parseInt(process.env.UID_LENGTH, 10) || 5));
  const mode   = String(process.env.UID_MODE || 'sequential').trim().toLowerCase();
  const findByCode = db.prepare('SELECT 1 FROM users WHERE uid_code = ?');
  if (mode === 'random') {
    for (let t = 0; t < 60; t++) {
      let n = '';
      for (let i = 0; i < len; i++) n += Math.floor(Math.random() * 10);
      const code = prefix + n;
      if (!findByCode.get(code)) return code;    // 撞号重试
    }
    // 兜底：随机多次都撞号，退回顺序
  }
  return prefix + String(seq).padStart(len, '0');
}

const _insertUser = db.prepare(`INSERT INTO users
  (id,uid_seq,uid_code,name,email,phone,password_hash,role,admin_level,user_level,status,group_id,is_public,owner_group_id)
  VALUES (@id,@uid_seq,@uid_code,@name,@email,@phone,@password_hash,@role,@admin_level,@user_level,@status,@group_id,@is_public,@owner_group_id)`);

/** 统一的用户创建入口：自动分配 uid_seq + 按规则生成 uid_code。所有建号处都走这里。 */
function createUser(f = {}) {
  const { randomUUID } = require('crypto');
  const uid_seq  = nextUidSeq();
  const id       = f.id || randomUUID();
  const uid_code = genUidCode(uid_seq);
  _insertUser.run({
    id, uid_seq, uid_code,
    name: f.name || '',
    email: f.email ?? null,
    phone: f.phone ?? null,
    password_hash: f.password_hash ?? null,
    role: f.role || 'user',
    admin_level: f.admin_level ?? null,
    user_level: f.user_level ?? 4,
    status: f.status || 'active',
    group_id: f.group_id ?? null,
    is_public: f.is_public ? 1 : 0,
    owner_group_id: f.owner_group_id ?? null,
  });
  return db.prepare('SELECT * FROM users WHERE id=?').get(id);
}

// ──────────────────────────────────────────
// 用户
// ──────────────────────────────────────────
const userStmts = {
  findById:      db.prepare('SELECT * FROM users WHERE id = ?'),
  findByEmail:   db.prepare('SELECT * FROM users WHERE email = ?'),
  findByPhone:   db.prepare('SELECT * FROM users WHERE phone = ?'),
  findByUidSeq:  db.prepare('SELECT * FROM users WHERE uid_seq = ?'),
  findByUidCode: db.prepare('SELECT * FROM users WHERE uid_code = ?'),   // 自定义 UID 登录用
  findByName:    db.prepare('SELECT * FROM users WHERE name = ?'),   // 用户名可能重名，用 .all()
  create:        createUser,
  // 公共账号（is_public=1）不进普通用户列表 / 统计
  findAll:       db.prepare('SELECT * FROM users WHERE is_public=0 ORDER BY uid_seq ASC'),
  findByStatus:  db.prepare('SELECT * FROM users WHERE status = ? AND is_public=0 ORDER BY uid_seq ASC'),
  countAll:      db.prepare('SELECT COUNT(*) as n FROM users WHERE is_public=0'),
  countVerified: db.prepare('SELECT COUNT(*) as n FROM users WHERE kyc_verified = 1 AND is_public=0'),
  countActive:   db.prepare("SELECT COUNT(*) as n FROM users WHERE status='active' AND is_public=0 AND date(last_checkin)=date('now')"),

  insert: db.prepare(`INSERT INTO users
    (id,uid_seq,name,email,phone,password_hash,role,admin_level,user_level,status)
    VALUES (@id,@uid_seq,@name,@email,@phone,@password_hash,@role,@admin_level,@user_level,@status)`),

  update: db.prepare(`UPDATE users SET
    name=@name, email=@email, phone=@phone, avatar=@avatar,
    status=@status, user_level=@user_level, admin_level=@admin_level,
    updated_at=datetime('now') WHERE id=@id`),

  updatePassword: db.prepare(`UPDATE users SET password_hash=?, updated_at=datetime('now') WHERE id=?`),

  setKyc: db.prepare(`UPDATE users SET
    kyc_verified=1, kyc_name=@name, kyc_id_tail=@id_tail,
    kyc_provider=@provider, kyc_verified_at=datetime('now'), updated_at=datetime('now')
    WHERE id=@user_id`),

  clearKyc: db.prepare(`UPDATE users SET
    kyc_verified=0, kyc_name=NULL, kyc_id_tail=NULL,
    kyc_provider=NULL, kyc_verified_at=NULL, updated_at=datetime('now')
    WHERE id=?`),

  addPoints: db.prepare('UPDATE users SET points = points + ?, updated_at=datetime(\'now\') WHERE id=?'),
  checkin:   db.prepare(`UPDATE users SET
    checkin_streak = checkin_streak + 1,
    last_checkin = date('now'),
    updated_at = datetime('now')
    WHERE id=?`),
  resetStreak: db.prepare(`UPDATE users SET checkin_streak=1, last_checkin=date('now'), updated_at=datetime('now') WHERE id=?`),

  // 2FA
  set2fa:     db.prepare("UPDATE users SET twofa_enabled=?, twofa_secret=?, updated_at=datetime('now') WHERE id=?"),
};

// ──────────────────────────────────────────
// 2FA 恢复码 / Passkey 凭据
// ──────────────────────────────────────────
const twofaStmts = {
  insertCode:  db.prepare('INSERT INTO twofa_recovery_codes (id,user_id,code_hash) VALUES (?,?,?)'),
  listCodes:   db.prepare('SELECT * FROM twofa_recovery_codes WHERE user_id=? AND used=0'),
  findCode:    db.prepare('SELECT * FROM twofa_recovery_codes WHERE user_id=? AND code_hash=? AND used=0'),
  useCode:     db.prepare('UPDATE twofa_recovery_codes SET used=1 WHERE id=?'),
  clearCodes:  db.prepare('DELETE FROM twofa_recovery_codes WHERE user_id=?'),
  countCodes:  db.prepare('SELECT COUNT(*) AS n FROM twofa_recovery_codes WHERE user_id=? AND used=0'),
};

const webauthnStmts = {
  insert:      db.prepare(`INSERT INTO webauthn_credentials (id,user_id,cred_id,public_key,counter,transports,name)
    VALUES (@id,@user_id,@cred_id,@public_key,@counter,@transports,@name)`),
  listByUser:  db.prepare('SELECT * FROM webauthn_credentials WHERE user_id=? ORDER BY created_at DESC'),
  findByCredId:db.prepare('SELECT * FROM webauthn_credentials WHERE cred_id=?'),
  updateCounter: db.prepare("UPDATE webauthn_credentials SET counter=?, last_used_at=datetime('now') WHERE id=?"),
  rename:      db.prepare('UPDATE webauthn_credentials SET name=? WHERE id=? AND user_id=?'),
  remove:      db.prepare('DELETE FROM webauthn_credentials WHERE id=? AND user_id=?'),
  countByUser: db.prepare('SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id=?'),
};

// ──────────────────────────────────────────
// 公告
// ──────────────────────────────────────────
const announcementStmts = {
  findAll:    db.prepare('SELECT * FROM announcements ORDER BY created_at DESC'),
  findActive: db.prepare("SELECT * FROM announcements WHERE active=1 ORDER BY (level='urgent') DESC, created_at DESC"),
  findById:   db.prepare('SELECT * FROM announcements WHERE id=?'),
  // updated_at 用毫秒精度（strftime %f），避免"同一秒内更新+已读"导致重弹漏判
  insert:     db.prepare("INSERT INTO announcements (id,title,content,level,active,link,updated_at) VALUES (@id,@title,@content,@level,@active,@link,strftime('%Y-%m-%d %H:%M:%f','now'))"),
  update:     db.prepare("UPDATE announcements SET title=@title, content=@content, level=@level, active=@active, link=@link, updated_at=strftime('%Y-%m-%d %H:%M:%f','now') WHERE id=@id"),
  setActive:  db.prepare("UPDATE announcements SET active=?, updated_at=strftime('%Y-%m-%d %H:%M:%f','now') WHERE id=?"),
  remove:     db.prepare('DELETE FROM announcements WHERE id=?'),
  // 已读状态
  getRead:    db.prepare('SELECT read_version FROM announcement_reads WHERE user_id=? AND announcement_id=?'),
  markRead:   db.prepare(`INSERT INTO announcement_reads (user_id,announcement_id,read_version) VALUES (?,?,?)
    ON CONFLICT(user_id,announcement_id) DO UPDATE SET read_version=excluded.read_version, read_at=datetime('now')`),
  clearReads: db.prepare('DELETE FROM announcement_reads WHERE announcement_id=?'),
};

// ──────────────────────────────────────────
// 用户分组 / 标签
// ──────────────────────────────────────────
const groupStmts = {
  all:    db.prepare('SELECT g.*, (SELECT COUNT(*) FROM users u WHERE u.group_id=g.id AND u.is_public=0) AS user_count FROM user_groups g ORDER BY g.created_at ASC'),
  get:    db.prepare('SELECT * FROM user_groups WHERE id=?'),
  insert: db.prepare('INSERT INTO user_groups (id,name,color) VALUES (?,?,?)'),
  update: db.prepare('UPDATE user_groups SET name=?, color=? WHERE id=?'),
  remove: db.prepare('DELETE FROM user_groups WHERE id=?'),
  clearFromUsers: db.prepare('UPDATE users SET group_id=NULL WHERE group_id=?'),
  setUser: db.prepare("UPDATE users SET group_id=?, updated_at=datetime('now') WHERE id=?"),
  membersOf: db.prepare("SELECT * FROM users WHERE group_id=? AND is_public=0 ORDER BY uid_seq ASC"),
  // 分组管理员
  admins:       db.prepare('SELECT user_id FROM group_admins WHERE group_id=?'),
  isAdmin:      db.prepare('SELECT 1 FROM group_admins WHERE group_id=? AND user_id=?'),
  clearAdmins:  db.prepare('DELETE FROM group_admins WHERE group_id=?'),
  addAdmin:     db.prepare('INSERT OR IGNORE INTO group_admins (group_id,user_id) VALUES (?,?)'),
  removeAdminEverywhere: db.prepare('DELETE FROM group_admins WHERE user_id=?'),
  // 我管理的分组（真实用户视角）
  managedBy:    db.prepare(`SELECT g.* FROM user_groups g JOIN group_admins ga ON ga.group_id=g.id
    WHERE ga.user_id=? ORDER BY g.created_at ASC`),
};
const tagStmts = {
  all:    db.prepare('SELECT t.*, (SELECT COUNT(*) FROM user_tag_map m WHERE m.tag_id=t.id) AS user_count FROM user_tags t ORDER BY t.created_at ASC'),
  get:    db.prepare('SELECT * FROM user_tags WHERE id=?'),
  insert: db.prepare('INSERT INTO user_tags (id,name,color) VALUES (?,?,?)'),
  update: db.prepare('UPDATE user_tags SET name=?, color=? WHERE id=?'),
  remove: db.prepare('DELETE FROM user_tags WHERE id=?'),
  removeMap: db.prepare('DELETE FROM user_tag_map WHERE tag_id=?'),
  ofUser:   db.prepare('SELECT t.* FROM user_tags t JOIN user_tag_map m ON t.id=m.tag_id WHERE m.user_id=? ORDER BY t.created_at ASC'),
  clearUser:db.prepare('DELETE FROM user_tag_map WHERE user_id=?'),
  addToUser:db.prepare('INSERT OR IGNORE INTO user_tag_map (user_id,tag_id) VALUES (?,?)'),
};

// ──────────────────────────────────────────
// 公共账号（共享账号）
// ──────────────────────────────────────────
const publicAcctStmts = {
  // 某分组下的所有公共账号（带授权成员数）
  byGroup: db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM public_account_members m WHERE m.public_id=u.id) AS member_count
    FROM users u WHERE u.is_public=1 AND u.owner_group_id=? ORDER BY u.created_at ASC`),
  get:     db.prepare('SELECT * FROM users WHERE id=? AND is_public=1'),
  remove:  db.prepare('DELETE FROM users WHERE id=? AND is_public=1'),
  // 授权成员
  members:    db.prepare('SELECT user_id FROM public_account_members WHERE public_id=?'),
  clearMembers: db.prepare('DELETE FROM public_account_members WHERE public_id=?'),
  addMember:  db.prepare('INSERT OR IGNORE INTO public_account_members (public_id,user_id) VALUES (?,?)'),
  isMember:   db.prepare('SELECT 1 FROM public_account_members WHERE public_id=? AND user_id=?'),
  // 某真实用户可切换的公共账号：被授权 + 该用户当前仍在公共账号所属分组内
  availableFor: db.prepare(`SELECT p.id, p.name, p.uid_code, p.uid_seq, p.owner_group_id, g.name AS group_name, g.color AS group_color
    FROM public_account_members m
    JOIN users p ON p.id=m.public_id AND p.is_public=1
    JOIN users u ON u.id=m.user_id
    LEFT JOIN user_groups g ON g.id=p.owner_group_id
    WHERE m.user_id=? AND u.group_id=p.owner_group_id
    ORDER BY p.created_at ASC`),
};

// ──────────────────────────────────────────
// 站点法律文档
// ──────────────────────────────────────────
const documentStmts = {
  get:    db.prepare('SELECT * FROM site_documents WHERE doc_key=?'),
  upsert: db.prepare(`INSERT INTO site_documents (doc_key,title,content,link,updated_at) VALUES (?,?,?,?,datetime('now'))
    ON CONFLICT(doc_key) DO UPDATE SET title=excluded.title, content=excluded.content, link=excluded.link, updated_at=datetime('now')`),
};

// ──────────────────────────────────────────
// OAuth 绑定
// ──────────────────────────────────────────
const oauthStmts = {
  findByProvider: db.prepare('SELECT u.* FROM users u JOIN user_oauth o ON u.id=o.user_id WHERE o.provider=? AND o.open_id=?'),
  findByUser:     db.prepare('SELECT * FROM user_oauth WHERE user_id=?'),
  bind:   db.prepare('INSERT OR REPLACE INTO user_oauth (id,user_id,provider,open_id,union_id) VALUES (?,?,?,?,?)'),
  unbind: db.prepare('DELETE FROM user_oauth WHERE user_id=? AND provider=?'),
};

// ──────────────────────────────────────────
// 三方登录「多主体」实例（额外主体；默认主体仍走环境变量）
// ──────────────────────────────────────────
const oauthProviderStmts = {
  all:          db.prepare('SELECT * FROM oauth_providers ORDER BY platform, sort_weight, created_at'),
  byPlatform:   db.prepare('SELECT * FROM oauth_providers WHERE platform=? ORDER BY sort_weight, created_at'),
  // 登录页可用凭证：凭证启用 且 所属主体启用
  enabledByPlatform: db.prepare(`SELECT p.* FROM oauth_providers p
    LEFT JOIN oauth_subjects s ON p.subject_id=s.id
    WHERE p.platform=? AND p.enabled=1 AND COALESCE(s.enabled,1)=1
    ORDER BY p.sort_weight, p.created_at`),
  bySubject:    db.prepare('SELECT * FROM oauth_providers WHERE subject_id=? ORDER BY platform, sort_weight, created_at'),
  get:          db.prepare('SELECT * FROM oauth_providers WHERE id=?'),
  insert:       db.prepare('INSERT INTO oauth_providers (id,subject_id,platform,label,config,enabled,sort_weight) VALUES (?,?,?,?,?,?,?)'),
  update:       db.prepare('UPDATE oauth_providers SET label=?, config=?, enabled=?, sort_weight=? WHERE id=?'),
  setSubject:   db.prepare('UPDATE oauth_providers SET subject_id=? WHERE id=?'),
  remove:       db.prepare('DELETE FROM oauth_providers WHERE id=?'),
  removeBySubject: db.prepare('DELETE FROM oauth_providers WHERE subject_id=?'),
};

// 「主体」（组织）CRUD + 同人合并查询
const oauthSubjectStmts = {
  all:    db.prepare('SELECT * FROM oauth_subjects ORDER BY sort_weight, created_at'),
  get:    db.prepare('SELECT * FROM oauth_subjects WHERE id=?'),
  insert: db.prepare('INSERT INTO oauth_subjects (id,name,enabled,sort_weight) VALUES (?,?,?,?)'),
  update: db.prepare('UPDATE oauth_subjects SET name=?, enabled=?, sort_weight=? WHERE id=?'),
  setPolicy: db.prepare('UPDATE oauth_subjects SET require_2fa=?, ip_allow=?, login_start=?, login_end=? WHERE id=?'),
  remove: db.prepare('DELETE FROM oauth_subjects WHERE id=?'),
  setUidRule: db.prepare('UPDATE oauth_subjects SET uid_prefix=?, uid_len=? WHERE id=?'),
  bumpUidSeq: db.prepare('UPDATE oauth_subjects SET uid_seq=uid_seq+1 WHERE id=?'),
};

// 组织成员（org=主体）
const orgMemberStmts = {
  listBySubject: db.prepare(`SELECT m.subject_id, m.user_id, m.org_uid, m.source, m.created_at,
      u.name, u.email, u.uid_seq, u.uid_code
    FROM org_members m JOIN users u ON m.user_id=u.id
    WHERE m.subject_id=? AND u.is_public=0 ORDER BY m.created_at`),
  get:        db.prepare('SELECT * FROM org_members WHERE subject_id=? AND user_id=?'),
  add:        db.prepare('INSERT OR IGNORE INTO org_members (subject_id,user_id,org_uid,source) VALUES (?,?,?,?)'),
  remove:     db.prepare('DELETE FROM org_members WHERE subject_id=? AND user_id=?'),
  removeBySubject: db.prepare('DELETE FROM org_members WHERE subject_id=?'),
  removeUser: db.prepare('DELETE FROM org_members WHERE user_id=?'),
  setOrgUid:  db.prepare('UPDATE org_members SET org_uid=? WHERE subject_id=? AND user_id=?'),
  countBySubject: db.prepare('SELECT COUNT(*) n FROM org_members m JOIN users u ON m.user_id=u.id WHERE m.subject_id=? AND u.is_public=0'),
  orgUidTaken: db.prepare('SELECT 1 FROM org_members WHERE subject_id=? AND org_uid=? AND user_id<>?'),
  // 某用户所属的（启用中的）组织 + 其组织内 uid
  ofUser: db.prepare(`SELECT s.id, s.name, m.org_uid FROM org_members m
    JOIN oauth_subjects s ON m.subject_id=s.id
    WHERE m.user_id=? AND s.enabled=1 ORDER BY s.sort_weight, s.created_at`),
  subjectIdsOfUser: db.prepare('SELECT subject_id FROM org_members WHERE user_id=?'),
};

// 应用对某用户是否可见/可登：全局应用(无 app_orgs 行)对所有人可见；受限应用仅其开放组织的成员可见
function appVisibleToUser(appId, userId) {
  if (!appOrgStmts.isRestricted.get(appId)) return true;      // 全局（通用）应用
  return !!appOrgStmts.openToAnyOfUser.get(appId, userId);    // 受限：需为某开放组织的成员
}

// 应用↔组织开放关系（app_orgs 无行 = 全局应用）
const appOrgStmts = {
  forApp:     db.prepare('SELECT subject_id FROM app_orgs WHERE app_id=?'),
  clearApp:   db.prepare('DELETE FROM app_orgs WHERE app_id=?'),
  add:        db.prepare('INSERT OR IGNORE INTO app_orgs (app_id,subject_id) VALUES (?,?)'),
  removeBySubject: db.prepare('DELETE FROM app_orgs WHERE subject_id=?'),
  isRestricted: db.prepare('SELECT 1 FROM app_orgs WHERE app_id=? LIMIT 1'),
  openToSubject: db.prepare('SELECT 1 FROM app_orgs WHERE app_id=? AND subject_id=? LIMIT 1'),
  removeOne:  db.prepare('DELETE FROM app_orgs WHERE app_id=? AND subject_id=?'),
  countBySubject: db.prepare('SELECT COUNT(*) n FROM app_orgs WHERE subject_id=?'),
  openToAnyOfUser: db.prepare(`SELECT 1 FROM app_orgs ao
    JOIN org_members m ON ao.subject_id=m.subject_id
    WHERE ao.app_id=? AND m.user_id=? LIMIT 1`),
};

// ──────────────────────────────────────────
// 备忘录
// ──────────────────────────────────────────
const memoStmts = {
  get:        db.prepare('SELECT * FROM memos WHERE id=?'),
  byOwner:    db.prepare('SELECT * FROM memos WHERE owner_id=? ORDER BY updated_at DESC, created_at DESC LIMIT 500'),
  all:        db.prepare(`SELECT m.*, u.name AS owner_name, u.uid_seq AS owner_uid_seq
                          FROM memos m LEFT JOIN users u ON m.owner_id=u.id
                          ORDER BY m.updated_at DESC LIMIT 500`),
  insert:     db.prepare('INSERT INTO memos (id,owner_id,title,body,tags) VALUES (?,?,?,?,?)'),
  update:     db.prepare("UPDATE memos SET title=?, body=?, tags=?, updated_at=datetime('now') WHERE id=?"),
  setOwner:   db.prepare("UPDATE memos SET owner_id=?, updated_at=datetime('now') WHERE id=?"),
  remove:     db.prepare('DELETE FROM memos WHERE id=?'),
  removeByOwner: db.prepare('DELETE FROM memos WHERE owner_id=?'),
};
const memoAttStmts = {
  byMemo:  db.prepare('SELECT id,memo_id,kind,filename,mime,size,url,created_at FROM memo_attachments WHERE memo_id=? ORDER BY created_at'),
  get:     db.prepare('SELECT * FROM memo_attachments WHERE id=? AND memo_id=?'),
  insert:  db.prepare('INSERT INTO memo_attachments (id,memo_id,kind,filename,mime,size,url,data) VALUES (?,?,?,?,?,?,?,?)'),
  remove:  db.prepare('DELETE FROM memo_attachments WHERE id=? AND memo_id=?'),
  removeByMemo: db.prepare('DELETE FROM memo_attachments WHERE memo_id=?'),
  countByMemo: db.prepare('SELECT COUNT(*) n FROM memo_attachments WHERE memo_id=?'),
};

// ──────────────────────────────────────────
// OTP
// ──────────────────────────────────────────
const otpStmts = {
  get:    db.prepare('SELECT * FROM otp_store WHERE key_name=?'),
  set:    db.prepare('INSERT OR REPLACE INTO otp_store (key_name,code,expire_at,attempts) VALUES (?,?,?,0)'),
  incAtt: db.prepare('UPDATE otp_store SET attempts=attempts+1 WHERE key_name=?'),
  del:    db.prepare('DELETE FROM otp_store WHERE key_name=?'),
  clean:  db.prepare('DELETE FROM otp_store WHERE expire_at < ?'),
};

// ──────────────────────────────────────────
// OAuth State
// ──────────────────────────────────────────
const stateStmts = {
  get:   db.prepare('SELECT * FROM oauth_states WHERE state=?'),
  set:   db.prepare('INSERT OR REPLACE INTO oauth_states (state,provider,expire_at) VALUES (?,?,?)'),
  del:   db.prepare('DELETE FROM oauth_states WHERE state=?'),
  clean: db.prepare('DELETE FROM oauth_states WHERE expire_at < ?'),
};

// ──────────────────────────────────────────
// 登录日志
// ──────────────────────────────────────────
const logStmts = {
  insert: db.prepare(`INSERT INTO login_logs (id,user_id,user_name,uid_seq,method,app_name,ip,user_agent,status,fail_reason)
    VALUES (@id,@user_id,@user_name,@uid_seq,@method,@app_name,@ip,@user_agent,@status,@fail_reason)`),
  findByUser:  db.prepare('SELECT * FROM login_logs WHERE user_id=? ORDER BY created_at DESC LIMIT ?'),
  findAll:     db.prepare('SELECT * FROM login_logs ORDER BY created_at DESC LIMIT 200'),
  findRecent:  db.prepare("SELECT * FROM login_logs WHERE date(created_at) >= date('now',?) ORDER BY created_at DESC"),
  // 用户自己在指定天数窗口内的登录记录（用户端展示 + 导出）
  findByUserRecent: db.prepare("SELECT * FROM login_logs WHERE user_id=? AND date(created_at) >= date('now',?) ORDER BY created_at DESC LIMIT 2000"),
};

// ──────────────────────────────────────────
// 应用
// ──────────────────────────────────────────
const appStmts = {
  findAll:     db.prepare('SELECT * FROM apps ORDER BY created_at ASC'),
  findById:    db.prepare('SELECT * FROM apps WHERE id=?'),
  findEnabled: db.prepare("SELECT * FROM apps WHERE status='enabled' AND visible=1 ORDER BY created_at ASC"),
  insert: db.prepare(`INSERT INTO apps (id,name,icon,icon_bg,description,client_id,client_secret,callback_url,launch_url,required_scopes,status,visible)
    VALUES (@id,@name,@icon,@icon_bg,@description,@client_id,@client_secret,@callback_url,@launch_url,@required_scopes,@status,@visible)`),
  update: db.prepare(`UPDATE apps SET name=@name,icon=@icon,icon_bg=@icon_bg,description=@description,
    callback_url=@callback_url,launch_url=@launch_url,required_scopes=@required_scopes,status=@status,visible=@visible,updated_at=datetime('now') WHERE id=@id`),
  approve: db.prepare("UPDATE apps SET status='enabled',visible=1,updated_at=datetime('now') WHERE id=?"),
  isAuthed:    db.prepare('SELECT 1 FROM user_app_auth WHERE user_id=? AND app_id=?'),
  authUser:    db.prepare('INSERT OR IGNORE INTO user_app_auth (user_id,app_id) VALUES (?,?)'),
  revokeAuth:  db.prepare('DELETE FROM user_app_auth WHERE user_id=? AND app_id=?'),
  getUserApps: db.prepare(`SELECT a.*, ua.scope AS granted_scope, ua.authed_at
    FROM apps a JOIN user_app_auth ua ON a.id=ua.app_id WHERE ua.user_id=?`),
  incAuthUsers: db.prepare('UPDATE apps SET auth_users=auth_users+1 WHERE id=?'),
  decAuthUsers: db.prepare('UPDATE apps SET auth_users=MAX(0,auth_users-1) WHERE id=?'),
};

// ──────────────────────────────────────────
// OIDC Provider（本系统作为身份提供方）
// ──────────────────────────────────────────
const idpStmts = {
  findAppByClientId: db.prepare('SELECT * FROM apps WHERE client_id=?'),
  grantedScope:      db.prepare('SELECT scope FROM user_app_auth WHERE user_id=? AND app_id=?'),
  upsertGrant:       db.prepare(`INSERT INTO user_app_auth (user_id,app_id,scope) VALUES (?,?,?)
    ON CONFLICT(user_id,app_id) DO UPDATE SET scope=excluded.scope`),

  insertCode: db.prepare(`INSERT INTO oauth_auth_codes
    (code,app_id,user_id,redirect_uri,scope,nonce,code_challenge,challenge_method,expires_at)
    VALUES (@code,@app_id,@user_id,@redirect_uri,@scope,@nonce,@code_challenge,@challenge_method,@expires_at)`),
  findCode:   db.prepare('SELECT * FROM oauth_auth_codes WHERE code=?'),
  useCode:    db.prepare('UPDATE oauth_auth_codes SET used=1 WHERE code=?'),
  // 同一应用+用户的其余未用码一并作废（防止授权码囤积）
  killCodes:  db.prepare('UPDATE oauth_auth_codes SET used=1 WHERE app_id=? AND user_id=? AND used=0'),
  cleanCodes: db.prepare('DELETE FROM oauth_auth_codes WHERE expires_at < ?'),

  insertToken: db.prepare(`INSERT INTO oauth_access_tokens (token_hash,app_id,user_id,scope,expires_at)
    VALUES (?,?,?,?,?)`),
  findToken:   db.prepare('SELECT * FROM oauth_access_tokens WHERE token_hash=?'),
  cleanTokens: db.prepare('DELETE FROM oauth_access_tokens WHERE expires_at < ?'),
  // 用户撤销授权时，连带吊销该应用已发出的令牌
  killTokens:  db.prepare('DELETE FROM oauth_access_tokens WHERE app_id=? AND user_id=?'),
};

// ──────────────────────────────────────────
// API Keys
// ──────────────────────────────────────────
const apiKeyStmts = {
  findAll:    db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC'),
  findByHash: db.prepare('SELECT * FROM api_keys WHERE token_hash=? AND status=?'),
  insert: db.prepare(`INSERT INTO api_keys (id,name,token_hash,token_prefix,scopes,status,created_by)
    VALUES (@id,@name,@token_hash,@token_prefix,@scopes,@status,@created_by)`),
  revoke: db.prepare("UPDATE api_keys SET status='revoked' WHERE id=?"),
  touch:  db.prepare("UPDATE api_keys SET last_used_at=datetime('now') WHERE id=?"),
};

// ──────────────────────────────────────────
// 环境变量配置
// ──────────────────────────────────────────
const envStmts = {
  get:    db.prepare('SELECT value FROM env_config WHERE key_name=?'),
  getAll: db.prepare('SELECT key_name, value FROM env_config'),
  set:    db.prepare('INSERT OR REPLACE INTO env_config (key_name,value,updated_at) VALUES (?,?,datetime(\'now\'))'),
};

// ──────────────────────────────────────────
// 安装状态检测
// ──────────────────────────────────────────
function isSetupDone() {
  try {
    const row = envStmts.get.get('SETUP_DONE');
    return row?.value === '1';
  } catch (_) { return false; }
}

// ──────────────────────────────────────────
// 积分日志
// ──────────────────────────────────────────
const pointsStmts = {
  insert: db.prepare('INSERT INTO points_log (id,user_id,delta,reason) VALUES (?,?,?,?)'),
  findByUser: db.prepare('SELECT * FROM points_log WHERE user_id=? ORDER BY created_at DESC LIMIT 50'),
};

// ──────────────────────────────────────────
// 导出统一 store
// ──────────────────────────────────────────
module.exports = {
  db,
  nextUidSeq,
  isSetupDone,
  users: userStmts,
  oauth: oauthStmts,
  oauthProviders: oauthProviderStmts,
  oauthSubjects: oauthSubjectStmts,
  orgMembers: orgMemberStmts,
  appOrgs: appOrgStmts,
  appVisibleToUser,
  memos: memoStmts,
  memoAtt: memoAttStmts,
  otp: otpStmts,
  state: stateStmts,
  logs: logStmts,
  apps: appStmts,
  idp: idpStmts,
  twofa: twofaStmts,
  webauthn: webauthnStmts,
  announcements: announcementStmts,
  documents: documentStmts,
  groups: groupStmts,
  tags: tagStmts,
  publicAccounts: publicAcctStmts,
  genUidCode,
  apiKeys: apiKeyStmts,
  env: envStmts,
  points: pointsStmts,
};
