/**
 * 统一登录系统 - 主服务入口 v2.0
 */
require('dotenv').config();

// ── 第一步：把数据库中保存的环境变量注入 process.env ──
// 必须在所有其他 require 之前执行，确保 sms/email/oauth 等模块读到正确的值
(function loadEnvFromDb() {
  try {
    const Database = require('better-sqlite3');
    const path = require('path');
    const dbPath = process.env.DB_PATH || path.join(__dirname, '../data/sso.db');
    const tmpDb = new Database(dbPath, { readonly: true });
    const rows = tmpDb.prepare(
      "SELECT key_name, value FROM env_config WHERE value IS NOT NULL AND value != ''"
    ).all();
    let count = 0;
    rows.forEach(({ key_name, value }) => {
      if (value && value.trim()) {
        // 只填补空缺，不覆盖已存在的环境变量（Zeabur/系统环境变量优先）
        if (!process.env[key_name]) {
          process.env[key_name] = value;
          count++;
        }
      }
    });
    tmpDb.close();
    if (count > 0) console.log(`[ENV] 从数据库补充了 ${count} 个环境变量`);
  } catch (e) {
    if (!e.message?.includes('no such table') && !e.message?.includes('ENOENT')) {
      console.warn('[ENV] 数据库环境变量加载失败:', e.message);
    }
  }
})();

// ── 第二步：加载其他模块（此时 process.env 已含数据库中的值）──
const express   = require('express');
const session   = require('express-session');
const cors      = require('cors');
const path      = require('path');
const rateLimit = require('express-rate-limit');

const { isSetupDone } = require('./db');
const setupRoutes  = require('./setup');
const oauthRoutes  = require('./oauth');      // 本系统 → 去登录微信/飞书等（消费方）
const providerRoutes = require('./provider'); // 第三方 → 用 QWQ SSO 登录（提供方）
const apiRoutes    = require('./api');

const app  = express();
const PORT = process.env.PORT || 3000;

// Zeabur 等平台在反向代理后面：信任代理，让 req.protocol/req.ip 反映真实值
// （Passkey 的 origin 校验依赖正确的 https 协议判断）
app.set('trust proxy', true);

// ── 基础中间件 ──
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Session ──
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-session-secret',
  resave: false, saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

// ── 安装守卫：未完成安装时，非 /setup 请求全部重定向 ──
app.use((req, res, next) => {
  if (
    req.path.startsWith('/setup') ||
    req.path.startsWith('/public') ||
    req.path === '/favicon.ico' ||
    req.path === '/'
  ) return next();
  if (!isSetupDone()) {
    if (req.path.startsWith('/api') || req.path.startsWith('/auth')) {
      return res.status(503).json({ error: '系统尚未完成初始化，请访问 /setup 完成安装' });
    }
    return res.redirect('/setup.html');
  }
  next();
});

// ── 根路由（必须在 static 之前）──
app.get('/', (req, res) => {
  if (!isSetupDone()) return res.redirect('/setup.html');
  res.redirect('/login.html');
});

// ── 无后缀路由兼容（/dashboard → /dashboard.html）──
app.get('/dashboard', (req, res) => res.redirect('/dashboard.html'));
app.get('/login',     (req, res) => res.redirect('/login.html'));
app.get('/setup',     (req, res) => res.redirect('/setup.html'));

// ── 页脚 HTML 生成 ──
function buildFooterHtml() {
  const e = process.env;

  // 版权行（不可修改核心部分）
  const distributor    = e.FOOTER_DISTRIBUTOR?.trim();
  const distributorUrl = e.FOOTER_DISTRIBUTOR_URL?.trim();
  const distPart = distributor
    ? (distributorUrl && /^https?:\/\//i.test(distributorUrl)
        ? ` & <a href="${distributorUrl}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;">${distributor}</a>`
        : ` & ${distributor}`)
    : '';
  const copyright = `Copyright © 2026 QWQ INC.${distPart}`;

  // 动态扫描所有 FOOTER_XXX 环境变量（排除 DISTRIBUTOR/_URL/DISTRIBUTOR_URL）
  const items = [];
  const skip  = new Set(['FOOTER_DISTRIBUTOR', 'FOOTER_DISTRIBUTOR_URL']);
  Object.keys(e)
    .filter(k => k.startsWith('FOOTER_') && !k.endsWith('_URL') && !skip.has(k))
    .sort()
    .forEach(k => {
      const val = e[k]?.trim();
      if (!val) return;
      const url = e[k + '_URL']?.trim();
      items.push(url && /^https?:\/\//i.test(url)
        ? `<a href="${url}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;">${val}</a>`
        : val);
    });

  const sep      = `<span style="margin:0 10px;opacity:.2;">|</span>`;
  const infoLine = items.length
    ? `<div style="margin-top:4px;flex-wrap:wrap;justify-content:center;display:flex;gap:0;align-items:center;">${items.join(sep)}</div>`
    : '';

  // 版本信息点击跳转 GitHub（不可修改）
  const versionLink = `<a href="https://github.com/QWQ-Inc/qwq-sso" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;opacity:.7;">Powered by QWQ SSO v3.4.29</a>`;

  return `<footer style="text-align:center;padding:20px 20px 8px;margin-top:24px;font-size:11px;color:rgba(0,0,0,.38);border-top:1px solid rgba(0,0,0,.07);line-height:1.9;user-select:none;">
  <div style="font-weight:500;">${copyright}</div>${infoLine}
  <div style="font-size:10px;opacity:.55;margin-top:3px;">Licensed under MIT License &nbsp;·&nbsp; ${versionLink}</div>
</footer>`;
}

// ── HTML 注入：__SETUP_DONE__ + 页脚（替换占位符）──
app.use((req, res, next) => {
  if (req.path.endsWith('.html')) {
    const fs = require('fs');
    const filePath = path.join(__dirname, '../public', req.path);
    if (fs.existsSync(filePath)) {
      let html = fs.readFileSync(filePath, 'utf8');
      html = html.replace('__SETUP_DONE__', isSetupDone() ? 'true' : 'false');
      // 替换页脚占位符（在内容区内部，而非整个页面底部）
      html = html.replace(/__FOOTER_HTML__/g, buildFooterHtml());
      return res.type('html').send(html);
    }
  }
  next();
});

// ── 路由 ──
app.use('/setup', setupRoutes);
app.use('/auth',  oauthRoutes);
app.use('/api',   apiRoutes);
app.use('/api/passkey', require('./passkey'));   // Passkey / WebAuthn
// OIDC Provider：/.well-known/openid-configuration 和 /oauth/* 挂在根路径（必须在 static 之前）
app.use('/',      providerRoutes);
app.use('/',      express.static(path.join(__dirname, '../public')));

// ── 启动 ──
app.listen(PORT, () => {
  console.log(`[SSO] 服务已启动：http://localhost:${PORT}`);
  console.log(`[SSO] 安装完成：${isSetupDone()}`);
  console.log(`[SSO] JWT_EXPIRES_IN="${process.env.JWT_EXPIRES_IN || '7d（默认）'}"`);
  console.log(`[SSO] JWT_SECRET 已设置：${!!process.env.JWT_SECRET}`);
});
