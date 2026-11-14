/**
 * 插件系统（v3.5.135）—— 管理端导入模块、注册钩子，扩展 / 修改已有行为（跳转页、OIDC 声明、登录副作用…）。
 *
 * ⚠️ 信任模型（WordPress 式，务必理解再改）：
 *   插件 = 超级管理员亲自编写 / 审阅的 Node 代码，加载后在主进程内以**完整服务端权限**运行
 *   （可 require 任意模块、读写数据库、改行为）。这与「超管本就能改 JWT_SECRET / 一键 git pull / 导出全库密钥」
 *   同一信任级——不扩大超管自身权限，但要清楚：装进来的就是在跑任意代码。
 *   护栏：① 仅超管（requireAdmin(1)）可装 / 启停 ② 每插件 enable 开关 ③ register / 每个钩子逐个 try/catch——
 *   坏插件不崩主进程、自动跳过并在管理端显示错误 ④ 杀手锏环境变量 PLUGINS_ENABLED=off：
 *   某插件把登录弄挂了，设它 + 重启即全禁用（SSH 恢复，和访问前缀门同思路）。
 *
 * 插件形态（CommonJS 单文件，存库 → 落盘 <DATA_DIR>/plugins/<id>.js → require）：
 *   module.exports = {
 *     name: '我的插件', version: '1.0.0',
 *     register(sso) {
 *       sso.filter('oidc.claims', (claims, ctx) => { claims.dept = sso.config.dept; return claims; });
 *       sso.action('login.success', (ctx) => { sso.audit('login_seen', { uid: ctx.user.id }); });
 *       sso.route('get', '/land', (req, res) => res.send('自定义跳转页'));   // → /ext/<id>/land
 *     }
 *   }
 *   （也可直接 module.exports = function register(sso){...}）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, DATA_DIR } = require('./db');

const PLUGIN_DIR = path.join(DATA_DIR, 'plugins');
try { if (!fs.existsSync(PLUGIN_DIR)) fs.mkdirSync(PLUGIN_DIR, { recursive: true }); } catch (_) {}

// 自建表（和 oidc-keys.js 一样，模块内 CREATE TABLE IF NOT EXISTS；在 db.js 完全加载之后）
db.exec(`CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY, name TEXT, version TEXT, source TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0, config TEXT, error TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
)`);

const stmt = {
  all:       db.prepare('SELECT * FROM plugins ORDER BY created_at'),
  get:       db.prepare('SELECT * FROM plugins WHERE id=?'),
  enabled:   db.prepare('SELECT * FROM plugins WHERE enabled=1 ORDER BY created_at'),
  insert:    db.prepare('INSERT INTO plugins (id,name,version,source,enabled,config) VALUES (?,?,?,?,?,?)'),
  setSource: db.prepare("UPDATE plugins SET source=?, name=?, version=?, updated_at=datetime('now') WHERE id=?"),
  setEnabled:db.prepare("UPDATE plugins SET enabled=?, updated_at=datetime('now') WHERE id=?"),
  setConfig: db.prepare("UPDATE plugins SET config=?, updated_at=datetime('now') WHERE id=?"),
  setError:  db.prepare('UPDATE plugins SET error=? WHERE id=?'),
  remove:    db.prepare('DELETE FROM plugins WHERE id=?'),
};

// 可用钩子清单（给管理端做帮助文档）
const HOOKS = {
  filters: [
    { name: 'oidc.claims', sig: '(claims, {user, scope}) => claims', desc: '改写 OIDC id_token / userinfo 的声明（claims）' },
    { name: 'login.token', sig: '(payload, {user, method}) => payload', desc: '改写登录成功后签发的 SSO 令牌负载（加自定义声明）' },
  ],
  actions: [
    { name: 'login.success', sig: '({user, method, ip, req}) => void', desc: '用户密码 / 验证码登录成功时触发副作用' },
  ],
  routes: '插件可注册 /ext/<插件id>/<路径> 的自定义页面 / 接口（自定义跳转页、回调、webhook 等）',
};

// 运行时注册表（reload 时整体替换，避免半更新态）
let reg = { filters: {}, actions: {}, routes: [], loaded: [] };

function killed() {
  const v = String(process.env.PLUGINS_ENABLED == null ? '' : process.env.PLUGINS_ENABLED).trim().toLowerCase();
  return ['off', '0', 'false', 'no', 'disable', 'disabled', '关闭', '禁用', '停用'].includes(v);
}
function envEnabled() { return !killed(); }

// 传给插件 register(sso) 的 API；注册进传入的 target 注册表
function makeSso(row, target) {
  let cfg = {}; try { cfg = JSON.parse(row.config || '{}'); } catch (_) {}
  return {
    id: row.id, name: row.name, version: row.version, config: cfg,
    filter(hook, fn) { if (hook && typeof fn === 'function') (target.filters[hook] = target.filters[hook] || []).push({ id: row.id, fn }); },
    action(hook, fn) { if (hook && typeof fn === 'function') (target.actions[hook] = target.actions[hook] || []).push({ id: row.id, fn }); },
    route(method, p, fn) {
      if (typeof fn !== 'function') return;
      const m = String(method || 'get').toLowerCase();
      const pp = '/' + String(p || '').replace(/^\/+/, '');
      target.routes.push({ pluginId: row.id, method: m, path: `/ext/${row.id}${pp}`, handler: fn });
    },
    log: (...a) => console.log(`[plugin:${row.id}]`, ...a),
    audit: (type, detail) => { try { require('./audit').audit('plugin.' + String(type), { actor: 'plugin:' + row.id, detail: detail || {} }); } catch (_) {} },
    env: (k) => process.env[k],
    db,
  };
}

// 编译一个插件到 target 注册表，返回 {name, version}；语法 / 结构错误会抛
function compile(row, target) {
  const file = path.join(PLUGIN_DIR, row.id + '.js');
  fs.writeFileSync(file, row.source, 'utf8');
  delete require.cache[require.resolve(file)];
  const mod = require(file);
  const register = typeof mod === 'function' ? mod : (mod && mod.register);
  if (typeof register !== 'function') throw new Error('插件需 module.exports.register(sso)，或直接导出一个 register 函数');
  register(makeSso(row, target));
  return { name: (mod && mod.name) || row.name || row.id, version: (mod && mod.version) || row.version || '' };
}

// 仅校验 + 取 meta（不污染全局注册表）
function validate(row) { return compile(row, { filters: {}, actions: {}, routes: [] }); }

// 重新加载全部启用插件（安装 / 启停 / 改配置后调用；也在模块首次 require 时调用）
function reload() {
  const next = { filters: {}, actions: {}, routes: [], loaded: [] };
  if (killed()) {
    console.log('[plugins] PLUGINS_ENABLED=off，已跳过全部插件');
  } else {
    for (const row of stmt.enabled.all()) {
      try {
        const m = compile(row, next);
        try { stmt.setError.run('', row.id); } catch (_) {}
        next.loaded.push({ id: row.id, name: m.name, version: m.version });
      } catch (e) {
        try { stmt.setError.run(String((e && e.message) || e).slice(0, 500), row.id); } catch (_) {}
        console.error(`[plugin:${row.id}] 加载失败：`, e && e.message);
      }
    }
    if (next.loaded.length) console.log(`[plugins] 已加载 ${next.loaded.length} 个插件：` + next.loaded.map(l => l.name).join(', '));
  }
  reg = next;
}

// 执行过滤器链：每个 fn 收 value 返回新 value；错误跳过、不中断
function runFilter(hook, value, ctx) {
  const list = reg.filters[hook]; if (!list || !list.length) return value;
  let v = value;
  for (const { id, fn } of list) {
    try { const r = fn(v, ctx); if (r !== undefined) v = r; }
    catch (e) { console.error(`[plugin:${id}] filter ${hook} 出错：`, e && e.message); }
  }
  return v;
}
// 执行动作：逐个触发、错误跳过
function runAction(hook, ctx) {
  const list = reg.actions[hook]; if (!list || !list.length) return;
  for (const { id, fn } of list) {
    try { fn(ctx); } catch (e) { console.error(`[plugin:${id}] action ${hook} 出错：`, e && e.message); }
  }
}

// Express 中间件：动态挂插件路由（reload 后即时生效，无需重启）。只接管 /ext/*，其余放行。
function routeMiddleware() {
  return (req, res, next) => {
    if (!req.path.startsWith('/ext/')) return next();
    const method = req.method.toLowerCase();
    const r = reg.routes.find(x => x.method === method && x.path === req.path);
    if (!r) return next();
    Promise.resolve().then(() => r.handler(req, res, next)).catch(e => {
      console.error(`[plugin:${r.pluginId}] route 出错：`, e && e.message);
      if (!res.headersSent) res.status(500).send('plugin route error');
    });
  };
}

// ── 视图 / CRUD（api.js 调用，reload 时机都在这里收口）──
function view(r, withSource) {
  let cfg = {}; try { cfg = JSON.parse(r.config || '{}'); } catch (_) {}
  const o = {
    id: r.id, name: r.name, version: r.version, enabled: !!r.enabled, config: cfg,
    error: r.error || '', created_at: r.created_at, updated_at: r.updated_at,
    active: reg.loaded.some(l => l.id === r.id),
  };
  if (withSource) o.source = r.source;
  return o;
}
function list() { return stmt.all.all().map(r => view(r, false)); }
function getView(id) { const r = stmt.get.get(id); return r ? view(r, true) : null; }
function install({ source, enabled = true, config }) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('插件源码不能为空');
  if (source.length > 512 * 1024) throw new Error('插件源码过大（上限 512KB）');
  const id = crypto.randomBytes(6).toString('hex');
  const meta = validate({ id, source, config: JSON.stringify(config || {}) });   // 先校验，语法 / 结构错当场抛
  stmt.insert.run(id, meta.name, meta.version, source, enabled ? 1 : 0, JSON.stringify(config || {}));
  reload();
  return getView(id);
}
function update(id, { source, config }) {
  const r = stmt.get.get(id); if (!r) throw new Error('插件不存在');
  if (source != null) {
    if (typeof source !== 'string' || !source.trim()) throw new Error('插件源码不能为空');
    if (source.length > 512 * 1024) throw new Error('插件源码过大（上限 512KB）');
    const meta = validate({ id, source, config: r.config });
    stmt.setSource.run(source, meta.name, meta.version, id);
  }
  if (config !== undefined) stmt.setConfig.run(JSON.stringify(config || {}), id);
  reload();
  return getView(id);
}
function setEnabled(id, on) { const r = stmt.get.get(id); if (!r) throw new Error('插件不存在'); stmt.setEnabled.run(on ? 1 : 0, id); reload(); return getView(id); }
function remove(id) {
  const r = stmt.get.get(id); if (!r) return false;
  stmt.remove.run(id);
  try { fs.unlinkSync(path.join(PLUGIN_DIR, id + '.js')); } catch (_) {}
  reload();
  return true;
}

// 模块首次 require 时即加载启用插件（provider.js / api.js require 本模块 → 此时已加载）
reload();

module.exports = {
  HOOKS, envEnabled, reload, runFilter, runAction, routeMiddleware,
  list, getView, install, update, setEnabled, remove,
};
