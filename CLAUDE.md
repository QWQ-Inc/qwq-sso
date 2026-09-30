# CLAUDE.md — 项目交接文档

> 本文档面向接手此项目的 Claude Code（或任何后续开发者）。之前的开发全部在 Claude.ai 对话中完成，本文件把散落在多轮对话里的架构决策、命名约定、已知坑点系统性整理出来，避免重复踩坑或推翻已有设计。

---

## 项目是什么

**QWQ SSO** — 统一登录系统，当前版本 **v3.4.40**。

- 部署地址：`https://qwqsso.zeabur.app`（Zeabur 托管）
- GitHub：`https://github.com/QWQ-Inc/qwq-sso`（远端仓库已从 `uesrbai/qwq-sso` 迁移至此，v3.4.21.1）
- 版权方：QWQ INC.（美国特拉华州），中国共同开发者：海南省儋州市许白网络文化传媒有限公司
- 许可证：MIT License（版权行 `Copyright © 2026 QWQ INC.` 不可删除/修改，遵循协议见 README.md 底部）

功能范围：13 个三方登录平台、积分商城（含盲盒）、KYC 实名认证（5 服务商轮询）、短信/邮件轮询发送、开放 API（含测试密钥沙盒模式）、动态页脚配置、等级管理、公告系统等。详见 `README.md` 的完整功能清单。

---

## 技术栈与硬约束

- **后端**：Node.js + Express 4 + `better-sqlite3`（同步 SQLite，无 ORM）
- **前端**：原生 HTML/CSS/JS，**单文件、无构建工具、无框架**。`dashboard.html` 一个文件裸装了用户端+管理端全部页面和逻辑（约 5000+ 行），`login.html`、`login-success.html`、`setup.html` 各自独立
- **数据库**：SQLite 文件 `data/sso.db`，**没有迁移工具**，schema 变更靠 `db.js` 里成堆的 `try { db.exec('ALTER TABLE ... ADD COLUMN ...') } catch(_) {}` 语句（IF NOT EXISTS 语义模拟），新增字段必须照抄这个模式，不要引入迁移框架
- **认证**：JWT（用户/管理员）+ API Key SHA256 哈希（第三方系统）
- **部署**：Zeabur，`NODE_ENV` 环境变量**不代表**是否发送真实短信/邮件——判断逻辑是"是否配置了对应服务商的环境变量"，这一点被坑过一次（见下方"已修复的重大 bug"）

---

## 目录结构

```
server/
├── index.js      # 入口。启动时从数据库加载 env 注入 process.env（必须在其他 require 之前执行）
├── api.js        # 几乎所有 REST 接口都在这一个文件里（1700+ 行）
├── auth.js       # JWT 签发/验证 + requireAuth/requireAdmin/requireApiKey 中间件
├── db.js         # 唯一持有 Database 实例的地方，导出 { db, users, oauth, otp, ... } 等 prepared statement 集合
├── oauth.js      # 【消费方】本系统去登录 13 个平台的 OAuth 回调路由（支持多主体）
├── oauth-meta.js # 三方平台元数据（字段/secret/扫码字段/中文名），oauth.js + api.js 共用
├── provider.js   # 【提供方】第三方"用 QWQ SSO 登录"：OIDC 授权码流程 + PKCE
│                 #   ⚠️ 和 oauth.js 方向相反，别搞混
├── message.js    # 短信 + 邮件：统一调 QWQ Message 分发中心的单一接口
│                 #   （v3.3.3 起替代原 sms.js / email.js，两者已删除）
├── kyc.js        # KYC 五服务商（Didit/Stripe/阿里云/火山引擎/支付宝）+ 轮询
├── audit.js      # 防篡改审计存证链（哈希链 audit()/verifyChain()），api.js + provider.js 埋点调用
├── memo-util.js  # 备忘录：附件类型白名单+magic bytes 校验、外链白名单、附件大小上限（纯函数，可单测）
├── poller.js     # 通用轮询选择器。⚠️ 现在只有 kyc.js 在用，但别删——
│                 #   message.js 仍靠它的 recordCall() 记出站调用统计
└── setup.js      # 首次安装向导后端

public/
├── login.html          # 登录页，动态显示已配置的登录平台
├── dashboard.html       # 用户端 + 管理端一体化控制台（巨型单文件）
├── authorize.html       # OIDC 授权确认页（第三方登录时的"是否同意"界面）
├── login-success.html   # 登录成功中间页，5秒倒计时+Token验证展示
└── setup.html            # 首次安装向导前端
```

---

## ⚠️ 关键约定（务必遵守，否则会重复引入 bug）

### 1. `db.js` 的导出方式 — 曾经踩过的坑

```js
// db.js 结尾
module.exports = { db, nextUidSeq, isSetupDone, users, oauth, otp, state, logs, apps, apiKeys, env, points };
```

**`db` 只是导出对象里的一个属性，不是整个模块。** 曾经在 `poller.js` 里写成：

```js
const db = require('./db');       // ❌ 错误：拿到的是整个 exports 对象
db.prepare(...)                    // TypeError: db.prepare is not a function
```

正确写法必须解构：

```js
const { db } = require('./db');   // ✅ 正确
```

**任何新文件要用数据库，一律 `const { db } = require('./db')`，不要 `const db = require('./db')`。**

### 2. 环境变量加载顺序

`index.js` 顶部有一段立即执行函数 `loadEnvFromDb()`，用 `better-sqlite3` 开一个独立的只读连接，把数据库 `env_config` 表的值注入 `process.env`——**这段代码必须在所有其他 `require` 之前执行**，否则 `api.js`、`sms.js` 等模块在 `require` 时就已经读取了空的 `process.env`，导致管理端配置了变量也不生效。

同时这段加载逻辑是"**只填补空缺，不覆盖已存在的环境变量**"（Zeabur 平台变量优先于数据库存的值），这是为了避免数据库里一个错误的 `JWT_SECRET` 覆盖掉 Zeabur 上正确配置的值导致所有 token 集体失效。

管理端 `POST /admin/env` 保存时会**同步写入 `process.env`**，做到不重启立即生效。

### 3. 短信/邮件是否真发送 —— 别用 NODE_ENV 判断

早期版本用 `process.env.NODE_ENV !== 'production'` 来判断是否只打印验证码到控制台。**这是个重大 bug**：Zeabur 默认不设 `NODE_ENV=production`，导致线上一直走"只打印不发送"分支，用户永远收不到验证码。

现在的正确逻辑是**检测消息分发中心是否已配置**（v3.3.3 起）：

```js
const { isConfigured } = require('./message');
if (isConfigured()) { /* 真发 */ } else { /* 只打印，响应体带 dev: true */ }
// isConfigured() 就是 !!(QWQ_MESSAGE_URL && QWQ_MESSAGE_KEY)
```

`message.js`/`kyc.js` 里任何新增通道都要遵循这个模式，不要引入 NODE_ENV 判断。

### 4. JWT 过期保护

`auth.js` 的 `signToken()` 对 `JWT_EXPIRES_IN` 做了防呆：如果这个环境变量被误配置成一个 `<=60` 的纯数字（比如管理员手滑填了 `1`），会强制回退到 `7d` 并打印警告，防止所有新签发的 token 秒过期导致集体登录闪退。**这段防呆逻辑不要删。**

### 5. 密码字段命名

数据库字段是 `password_hash`，不是 `password`。`bcryptjs` 加密强度是 `12`（`bcrypt.hash(pw, 12)`），全项目统一，不要改成别的强度。

### 6. UID 格式

用户对外展示的编号是 `#00001` 这种 5 位补零格式，来自 `uid_seq` 字段（自增整数）。前端格式化函数是 `fmtUid(seq)`，在 `dashboard.html` 里定义，不要重复造轮子。

### 7. 等级标识符 `level_tag`（U/A + 数字）

这是**给 API 和用户字段用的**，格式规则：
- 普通用户：`U` + 一位数字（`U1`~`U9`，数字越小等级越高）
- 管理员：`A` + 一位数字（`A1`~`A9`，数字越小权限越大）

**注意**：这个标识符**不应该**直接展示在管理端「等级管理」页面的卡片上（那里只显示 `Lv.数字`），只应该出现在：
- 用户详情面板（作为辅助小标签，带 tooltip 说明"API 请求标识符"）
- `/v1/users`、`/v1/users/:uid`、`/v1/auth/verify` 等开放 API 的返回字段
- `GET /v1/users?level_tag=U3` 查询参数

等级本身存于 `user_levels` 表（`grp`/`num`/`name`/`badge`/`descr`/`perms`），支持任意等级的增删改（有用户占用的等级禁止删除），详见 `api.js` 的 `/admin/levels` 系列接口。

### 8. API Key 双前缀 + 沙盒模式

- `sk_live_xxxx`：实际密钥，**必须配置可信 IP** 才能调用（未配置返回 403），只在创建那一刻完整显示一次
- `sk_test_xxxx`：测试密钥，明文存库（`token_plain` 字段），可在密钥列表随时反复查看完整值；默认不校验来源 IP（除非管理员主动为它指定了具体 IP）；调用任何 `/v1/*` 接口都返回预设的**沙盒 mock 数据**（`_sandbox: true`），不碰真实数据库

`requireApiKey` 中间件（`auth.js`）里 `req.isSandbox` 标记了这次请求是否是测试密钥，`api.js` 里每个 `/v1/*` 接口开头都有 `if (req.isSandbox) return res.json(SANDBOX.xxx())` 的判断，新增开放接口时要照做。

**密钥历史永不真删除**——`DELETE /admin/api-keys/:id` 只是把 `status` 改成 `revoked`，无论测试还是实际密钥，历史记录都要能查到（管理端「显示全部历史」默认开启）。

### 9. 页脚渲染方式

页脚不是写死在 HTML 里的，是**服务端字符串替换**注入的：

- `public/*.html` 里埋了占位符 `__FOOTER_HTML__`（目前在各页面的 `</body>` 前，页脚整页居底显示）
- `index.js` 的 HTML 响应中间件用正则把占位符替换成 `buildFooterHtml()` 生成的真实内容
- 版权行 `Copyright © 2026 QWQ INC.` 是**硬编码不可配置**的，分发人名称/链接来自 `FOOTER_DISTRIBUTOR` / `FOOTER_DISTRIBUTOR_URL` 环境变量
- 其他页脚项目（备案号、许可证等）是**动态扫描**所有 `FOOTER_*` 环境变量渲染的，管理端有个"页脚信息管理"面板支持增删（生成变量名规则：`FOOTER_<自定义后缀>`，勾选超链接则额外生成 `FOOTER_<后缀>_URL`）
- 版本号那行 `Powered by QWQ SSO vX.Y.Z` 链接指向 `https://github.com/QWQ-Inc/qwq-sso`，**硬编码不可配置**

**页脚位置的当前实际状态（2026-07-20 核实）**：`dashboard.html:1861` 的占位符包在 `<div id="site-footer-placeholder">` 里，位置在 `</div><!-- /content -->` **之前**，也就是已经是"功能内容区居底"那一版。`login.html:1637` 和 `login-success.html:358` 则是裸占位符放在页面末尾（这两个页面没有 `.content` 滚动容器，效果等同整页居底，符合预期）。

（`setup.html` 早期漏埋了占位符导致安装向导页没页脚，v3.2.4 已补上，位置同样在 `</body>` 前。新增页面时记得别再漏。）

### 10. ⚠️ secret 字段的掩码绝不能当成真值提交（v3.3.3.1 修复的严重 bug）

管理端「系统配置」里 `secret: true` 的字段，未点👁展开时输入框的 `value` 是
`'•'.repeat(n)`（`dashboard.html` 渲染处）。而 `saveAllEnv()` 原本直接读 `inputEl.value` 提交——
**结果是在系统配置页点一次保存，所有已配置的密钥会被整串圆点覆盖**：
微信/飞书/钉钉 AppSecret、`JWT_SECRET`、各家 KYC 密钥、`QWQ_MESSAGE_KEY` 全部报废。
症状极具迷惑性：页面上依然显示「已配置」，但实际发请求时报
`Cannot convert argument to a ByteString ... value of 8226`（8226 就是 `•`）。

现在有三道防线，改动这块时不要拆掉任何一道：
1. `onEnvInput()` 给字段打 `v.dirty = true`，`saveAllEnv()` **只提交被用户真正改过的 secret 字段**
2. `saveAllEnv()` 里 `isMaskedValue()` 拦截纯圆点串
3. 后端 `POST /admin/env` 再判一次，圆点串一律拒绝写入并记 warn

`renderEnvPage()` 从服务端重新载入时会把所有 `dirty` 复位。

### 11. 系统配置页（原"环境变量"，已改名）

管理端左侧菜单「环境变量」已重命名为「系统配置」。这个页面的 UI 结构是**左侧竖排分类导航（模仿主菜单栏风格）+ 右侧配置卡片**，不是早期版本的顶部横向 tab。一级分类（三方登录/消息通知/实名认证/支付/系统与页脚）点击可展开二级子菜单（具体到每个服务商）。`ENV_GROUPS` 数组里每一项现在都带 `category` 字段用于分类归属，新增服务商配置时要记得打上正确的 category。

---

## 数据库表清单（截至 v3.2.0）

核心表：`users`、`user_oauth`、`otp_store`、`oauth_states`、`login_logs`、`apps`、`user_app_auth`、`api_keys`、`env_config`、`points_log`、`uid_seq`

商城相关：`shop_goods`、`shop_records`、`redeem_codes`、`redeem_records`、`feature_quota`、`shop_config`、`blind_box_rewards`、`user_coupons`

其他：`provider_stats`（三方服务商调用统计）、`api_call_logs`（入站/出站调用日志）、`user_levels`（等级管理）

OIDC 相关（v3.3.0 新增）：`oauth_auth_codes`（授权码，10 分钟单次使用）、`oauth_access_tokens`（访问令牌，只存 sha256）、`user_app_auth.scope`（用户对该应用实际授权了哪些 scope）

字段增补一律走 `db.js` 里的 `try { ALTER TABLE ... } catch(_) {}` 模式，**不要**假设某个字段一定存在，写查询时留意 `COALESCE` 或默认值兜底。

### ⚠️ ALTER TABLE 必须写在建表语句「之后」

这是 v3.3.0 修掉的一个存量 bug，务必注意：原先 18 条 `ALTER TABLE` 全部排在 `db.exec()` 建表块**之前**，
全新数据库首次启动时表还不存在 → 所有 ALTER 被 `catch(_) {}` 静默吞掉 → 字段全部缺失；
要等第二次启动（表已建好）才补上。表现为**首次安装后功能残缺、重启一次又自己好了**，极难排查。

现在 `db.js` 有一个明确的「迁移」区块位于建表之后，**新增字段请加在那个区块里**，
文件顶部只留了一行注释提醒不要往那儿加。

---

## 已知未完成 / 可能需要继续打磨的部分

> 以下状态已于 2026-07-20 逐条对照代码核实完毕，不再是"待核实"。

1. ✅ **2FA（TOTP）v3.3.6 + Passkey v3.3.8 均已实现**。`server/twofa.js` 用 Node
   内置 crypto 实现 RFC 6238（HMAC-SHA1 / 30s / 6 位），已用官方测试向量校验。流程：账号设定→登录方式绑定
   里绑定（出密钥 + otpauth，手动录入；**未做二维码**，见下）→ 校验一次动态码→下发 10 个一次性恢复码。
   开了 2FA 的用户密码/验证码登录后进「二段」：后端发 5 分钟中间态令牌（`stage:'2fa'`），
   前端浮层输入动态码或恢复码，调 `/api/2fa/login-verify` 换正式 token。
   管理员可用 `TWOFA_REQUIRED_LEVELS`（如 `A1,A2`）强制某些等级必须开启（`mustSetup2fa`）。
   ⚠️ **所有登录路径都过 2FA 门**：密码/验证码/注册走 `finishLogin`；第三方 OAuth 登录
   （`oauth.js` 的 `loginSuccess`）开了 2FA 的用户会跳 `/login.html?tfa=<中间态令牌>` 走二段
   （v3.3.10.1 补，之前 OAuth 绕过 2FA）；Passkey 本身即强认证，直接发 token 不再叠 2FA。
   **二维码（v3.3.7 补齐）**：`public/qr-mini.js` 是自研纯 JS QR 编码器（字节模式/纠错 M/版本 1~10），
   **在浏览器本地生成，密钥不出客户端**。刻意不用 CDN 二维码库——那会把外部 JS 注入已登录的控制台
   （能读 localStorage 里的 JWT），是供应链风险。这个文件同源、随仓库走。
   编码器用 RFC 官方向量之外还做了双重校验：jsqr 往返解码 + 与成熟库 qrcode 逐模块 diff=0。
   超出容量时 `svg()` 返回 null，前端回退到手动录入密钥。
   ⚠️ `twofa_secret` 是敏感字段，`safeUser()` 已剔除，任何接口都不下发。

   **Passkey（WebAuthn / FIDO2，v3.3.8）**：`server/passkey.js` + `public/webauthn-glue.js`。
   密码学验证交给成熟库 **`@simplewebauthn/server`（新依赖）**，不手写。绑定在账号设定→登录方式绑定，
   登录页有「用 Passkey 登录」按钮（浏览器支持时才显示）。凭据存 `webauthn_credentials` 表，
   `counter` 防重放。Passkey 登录本身即强认证，直接发 token 不再走 2FA。
   RP ID / origin 从 `BASE_URL` 推导，**必须与实际访问域名一致**，否则浏览器拒绝；WebAuthn 要求 HTTPS（localhost 例外）。
   **完整仪式已用 Node 软件认证器（真实 P-256 + CBOR/COSE + 签名，`scratchpad/soft-authenticator.js`）
   端到端跑通**：注册/登录/counter 防重放/challenge 校验共 8 项，走真实 @simplewebauthn 校验。
   ⚠️ **RP ID/origin 必须与浏览器实际域名一致**——v3.3.9.1 修：`rpConfig` 改为从**本次请求**的
   `X-Forwarded-Host`/`Host` + `X-Forwarded-Proto` 推导（不再写死 BASE_URL），并 `app.set('trust proxy', true)`。
   之前写死 BASE_URL 会导致「用别的域名访问」或「反代下 protocol 变 http」时 origin 不匹配 → 添加失败。
   浏览器胶水层 `webauthn-glue.js` 按 `@simplewebauthn/browser` 的输出格式手写（base64url↔ArrayBuffer + 序列化），
   同源不走 CDN（已登录页面注入外部 JS 是供应链风险）。
2. ✅ **登录协议富文本编辑器：v3.3.10 已实现**。管理端「登录协议」页（服务条款 / 隐私政策两个 tab），
   富文本编辑用原生 `contenteditable` + `execCommand`（粗体/斜体/标题/列表/链接/图片/视频，无第三方依赖）。
   存 `site_documents` 表（key=terms/privacy）。**保存时服务端 `sanitizeHtml` 净化**：去掉
   `<script>/<style>/<iframe>` 等危险标签、`on*` 事件属性、`javascript:` 协议（内容虽由管理员撰写，
   仍防管理员账号被盗的存储型 XSS）。登录页那两个原本 `href="#"` 的死链接改为 `showDoc()` 弹窗展示，
   走公开接口 `GET /api/public/document/:key`。
   ⚠️ 净化是正则实现（无 DOMPurify，避免引 jsdom），挡住了主要向量但不是完备沙箱；只有 Lv.2+ 能编辑。
3. ✅ **邮箱域名白名单/黑名单：v3.3.2 已实现**。两个环境变量控制：
   `EMAIL_DOMAIN_MODE`（`off`/`whitelist`/`blacklist`）+ `EMAIL_DOMAIN_LIST`（逗号分隔，不带 @，子域自动匹配）。

   **重要语义（改之前先理解）**：策略只作用于「新账号进入系统」的三个入口——`/email/send-code`、
   `/email/register`、`/email/verify-code` 里自动建号那一支。**已存在账号的密码登录不拦截**，
   否则管理员事后加一条黑名单就会把已有用户直接锁死在门外，那是误伤不是策略。
   另外**列表为空时策略自动失效**，防止误配 `whitelist` + 空列表把全站锁死。

   前端 `login.html` 的两个「账号所属域」下拉框现在由 `/api/public/email-domain-policy` 驱动：
   白名单模式只给允许的域（去掉「不限」和「自定义」），黑名单模式摘掉被禁的域，并显示提示。
   注意前端只是提前告知，**真正的拦截在后端**。
4. ✅ **用户端登录日志导出：v3.3.4 已实现**。两个环境变量控制：
   `LOGINDATE_DAY`（展示/导出的天数窗口，默认 30，夹在 1~3650）+ `LOGINDATE_EXPORT`（是否允许用户导出，
   `off`/`0`/`false`/`no` 关闭，默认开）。用户端首页「近期登录记录」表内显示最近 20 条、标注「近 N 天共 M 条」，
   导出按钮走 `GET /api/user/login-logs/export` 下载整个窗口的 CSV（带 UTF-8 BOM，CSV 字段做了逗号/引号转义）。
   开关关闭时前端隐藏按钮、后端也返回 403。管理端「系统配置 → 登录日志」可配。
   （管理端自己的全量日志导出 `exportLogsCSV()` 一直都在，与此独立。）
5. ✅ **公告系统：v3.3.9 已实现**。`announcements` 表 + `announcement_reads`（记已读时的公告版本）。
   管理端「公告管理」CRUD（Lv.2）；用户进首页（`loadHome`）本会话首次弹待读公告，逐条「我知道了」标记已读。
   **「更新后重弹」机制**：已读时存下公告的 `updated_at`，编辑内容会刷新 `updated_at`（用**毫秒精度** strftime %f，
   避免"同一秒内编辑+已读"漏判），`read_version !== updated_at` 即重弹。停用不弹、urgent 排前、删除连带清理已读记录。
6. **短信发送 KYC 认证链接**：`sendSmsCode(phone, redirectUrl)` 目前是把完整 URL 塞进验证码模板的占位符里发送，**这依赖短信服务商预先审核一个"通知类"模板**（不是标准的验证码模板），实际生产环境需要管理员在短信服务商后台单独报备这个模板，代码里只是尽力发送、失败会被 catch 并返回 `failed: <原因>`

---

## 消息发送：全部走 QWQ Message 分发中心（v3.3.3 起）

本系统**不再直接对接任何短信/邮件服务商**。原来的 `sms.js`（火山引擎/阿里云/腾讯云）和
`email.js`（Zeabur Email/SMTP，含多 SMTP 轮询）已删除，改为 `message.js` 调一个接口：

```
POST {QWQ_MESSAGE_URL}/api/v1/send
Authorization: Bearer {QWQ_MESSAGE_KEY}
{ group, to, subject, content, templateCode?, variables? }
```

分发中心：https://github.com/uesrbai/qwq-message

配置项（管理端「系统配置 → 消息分发（QWQ Message）」）：

| 变量 | 说明 |
|---|---|
| `QWQ_MESSAGE_URL` | 分发中心根地址，代码会自动去掉结尾斜杠 |
| `QWQ_MESSAGE_KEY` | `qwq_live_`（生产，支持 IP 白名单）/ `qwq_test_`（测试） |
| `QWQ_MESSAGE_SMS_GROUP` | 短信通道组标识 |
| `QWQ_MESSAGE_EMAIL_GROUP` | 邮件通道组标识 |
| `QWQ_MESSAGE_SMS_HUB_TEMPLATE` | 分发中心「模板管理」里**自建模板**的编号，走 `template` 字段 |
| `QWQ_MESSAGE_SMS_TEMPLATE` | **服务商**后台已审核的模板号，走 `templateCode` 字段 |
| `QWQ_MESSAGE_SMS_VAR` | 模板占位符变量名，默认 `code` |

⚠️ **上面两个模板变量是完全不同的东西，这里踩过坑**：分发中心自建模板的编号
（如 `sso-sms-code`）如果填进 `QWQ_MESSAGE_SMS_TEMPLATE`，会被当成服务商模板号
原样透传给火山引擎/阿里云，对方查无此模板 → 报 `RE:0005 模板错误`。
自建模板必须填 `QWQ_MESSAGE_SMS_HUB_TEMPLATE`。两者二选一，自建模板优先。

要点：
- **服务商账号、模板、轮询、故障转移全在分发中心那边**，本系统不再管这些。
  管理端「三方服务商轮询策略」里短信/邮件两栏已移除，**只剩 KYC**
- 分发中心返回 HTTP 200 但 `success:false` 时**也算失败**，错误原因（`detail`）会透传给调用方
- 出站调用统计仍记在 `provider_stats`，标识是 `qwq_message`；
  旧的 `sms_*`/`email_*` 历史记录保留可查，管理端标签标注了「（历史）」
- `sendSmsCode` / `sendEmailCode` / `sendEmail` **函数签名保持不变**，调用方无需改动。
  实名认证提醒那处 `sendSmsCode(phone, redirectUrl)` 传的是链接而非验证码，行为照旧

---

## 第三方接入的两条路（v3.3.0 起）

**别再把开放 API 当成"第三方登录"用**——它们解决的是不同问题：

| | 开放 API（`/api/v1/*`） | OIDC 登录（`/oauth/*`） |
|---|---|---|
| 凭据 | `sk_live_` API Key | `client_id` + `client_secret` |
| 用户参与 | 无，后台直接查库 | 有，跳转 + 授权确认页 |
| 数据范围 | 管理员给的 scope | 用户逐项勾选同意的 scope |
| 实现位置 | `api.js` | `provider.js` |

v3.3.0 之前**只有前者**，所以"第三方登录"实际上是"第三方读库"——用户全程没参与。
`apps` 表的 `client_id`/`client_secret`/`callback_url` 三个字段从很早就存在，但 `callback_url`
在此之前**从未被任何代码读取过**，是纯装饰。

设计要点（改动前先理解，别退回去）：
- `id_token` 用 **HS256 + client_secret** 签名，故意不引入 RSA/JWKS，省掉密钥管理
- `redirect_uri` 必须与 `apps.callback_url` **完全一致**，不匹配时**绝不回跳**（防钓鱼），直接 400
- **最小化披露**：未授权的字段在 `id_token` 和 `userinfo` 里根本不出现，不是给 null
- `kyc` scope 即使授权，姓名也只给脱敏结果（张三丰 → 张**），完整姓名永不下发
- 撤销授权会连带吊销已发出的令牌（`api.js` 的 `DELETE /apps/:id/auth`）

### 管理端「应用管理」的接入凭据（v3.3.3.6 补齐）

第三方要接 OIDC，管理员必须能拿到 `client_id` + `client_secret`。`client_secret` 是**明文**存在
`apps.client_secret`（不像 API Key 是哈希），本可显示。但早期管理端**任何地方都不显示它**，
导致第三方无法调 `/oauth/token` 换令牌，接入根本无法完成——这就是用户说的「应用管理没做完」。

现在：新建应用后弹出凭据面板，编辑弹窗里有「🔑 接入凭据」区块（`appCredentialsHtml()`），
展示 client_id、client_secret（👁 打码可展开、可复制）、四个端点地址、发起示例，
并提供「重新生成密钥」（`POST /admin/apps/:id/regenerate-secret`，旧密钥立即失效）。

⚠️ 同批修掉一个 bug：`POST /admin/apps` 原本写死 `status:'pending'`，忽略前端传的
「直接启用」，导致管理员自建应用永远是待审核、无法用于 OIDC 授权（authorize 会因未启用而拒绝）。
现在按传入的 status 建（合法值 enabled/pending/disabled，默认 enabled）。

### 多标识符登录（v3.3.5）

登录页的「账号所属域」下拉已删除（纯输入辅助，用户嫌鸡肋）。现在登录框是**单个自动识别**的
账号输入，支持四种标识符：邮箱（含 `@`）、手机号（`1[3-9]\d{9}`）、UID（`#00001`/`00001`/`1`）、用户名。

- 后端 `resolveUser(identifier)`（`api.js`）按 邮箱→手机号→UID→用户名 顺序解析；
  用户名可能重名，命中多个返回 `AMBIGUOUS`，接口提示「改用邮箱/手机号/UID 登录」
- **密码登录**四种标识符都行：前端发 `POST /api/account/login {account,password}`；
  旧路径 `/api/email/login` + `{email}`/`{phone}` 字段仍兼容
- **验证码登录**只支持邮箱/手机号（验证码要有下发渠道），前端 `isEmailStr`/`isPhoneStr`
  自动判断走 `/email/*` 还是 `/sms/*`；填用户名/UID 会提示改用密码登录
- 报错文案统一为「账号或密码不正确」，不再区分邮箱/手机号，也不泄露账号是否存在
- 注册面板未动（仍是邮箱/手机号 + 域名策略下拉，域名白/黑名单 v3.3.2 那套只作用于注册）

### 登录后跳回授权页（`next` 的传递，v3.3.3.5 修）

第三方跳来授权时若用户未登录，`authorize.html` 会带 `?next=<授权页完整地址>` 跳到 `login.html`。
登录完成后要跳回这个 `next` 继续授权。两条登录路径的处理方式不同，别改坏：

- **邮箱/手机 密码或验证码登录**（纯前端）：`login.html` 的 `redirect()` 直接读 URL 里的
  `next`（`safeNext()` 只放行站内相对路径）跳回，不经中间页
- **第三方 OAuth 登录（微信/企业微信/飞书… 全部 13 家）**：要经过「本站→平台→回调」一圈
  服务端跳转，`next` 没法一路带在 URL 上。做法是 `oauth.js` 有个 `router.use` 中间件把进入
  `/auth/*` 时的 `?next=` 存进 **session**（`postLoginNext`），`loginSuccess()` 再取出，
  拼进 `/login-success.html?...&next=`，中间页拿到 `next` 就跳过倒计时直接跳回
- **扫码登录**（微信/企业微信）：二维码直接指向平台、不经过 `/auth/<平台>` 入口，所以
  `login.html` 载入时若有 `next` 会先 `fetch('/auth/stash-next?next=...')` 把它存进 session
- 三处都只接受站内相对路径（`/` 开头、非 `//`），防止 token 被带去外站（开放重定向）

---

## 交接核查时新发现的问题（2026-07-20，均未擅自修改，待用户确认）

1. ✅ **`server/init.js` 硬编码超管密码已修复**（v3.4.16.1 核实：实为更早某次已改）。现读 `INIT_ADMIN_EMAIL` / `INIT_ADMIN_NAME` / `INIT_ADMIN_PASSWORD` 环境变量，未配 `INIT_ADMIN_PASSWORD` 则 `crypto.randomBytes(12).base64url` 随机生成、只打印一次并提示登录后改。⚠️ **代码修好不撤销历史泄露**——若线上超管密码仍是当年硬编码那串，务必去线上改掉。
2. ✅ **`server/store.js` 已删除**（v3.4.16.1 核实：文件已不存在，全项目无 `require`）。
3. ✅ **版本号脱节已修复**（v3.2.4）。此前 tag 已走到 v3.2.3，但 `package.json` / `server/index.js` 页脚 / `README.md` 徽章都还停在 3.2.0——说明前几次发版只打 tag 没同步改代码。**发版时这四处必须一起改**：`package.json` 的 `version` / `server/index.js:130` 的 `versionLink` / `README.md` 标题 + 徽章 / 本文件开头的版本号
4. ✅ **「每次启动作废所有 API Key」已删除**（v3.3.0）。原代码 `UPDATE api_keys SET status='revoked'
   WHERE status='active'` 注释标称"一次性历史迁移"，实际没有任何条件保护、每次启动都执行——
   Zeabur 每次部署都重启，等于每次发版所有第三方密钥集体失效。这就是"API Key 老是莫名其妙失效"的原因。
   **将来若真需要一次性迁移，必须带版本标记，不要写成无条件语句**
5. ✅ **KYC 的管理端配置项与代码读取的变量名对不上（v3.3.3 已修）**。管理端「KYC · 阿里云」
   面板写的是 `ALIYUN_KYC_ACCESS_KEY_ID`，但 `kyc.js` 读的是 `ALIYUN_ACCESS_KEY_ID`（短信那套通用凭据）；
   火山引擎同理（`VOLC_KYC_*` vs `VOLCENGINE_*`）。**结果是在 KYC 面板里填的密钥从来没生效过**，
   KYC 能跑只是因为恰好借用了短信的凭据。现在改成「优先专用 AK，回退通用 AK」。
   注意这个坑正好挡在删短信配置的路上——如果当时直接删掉短信配置组，KYC 会当场失效
6. ✅ **`server/init.js` 的 `ENV_KEYS` 已基本追平**（v3.4.16.1）。此前缺的 Didit/支付宝 KYC、OIDC、UID 规则、2FA 均已在列；本次补了 **GitHub / Microsoft / QQ** 三家 OAuth 的 `*_CLIENT_ID/SECRET`（+`MICROSOFT_TENANT`）。Zeabur Email 已随 message.js 重构废弃、`FOOTER_*` 是动态扫描（本就不预置），无需再加。新增服务商时仍要记得：`ENV_GROUPS`（`dashboard.html`）+ 这个 `ENV_KEYS` 两处同步。

---

## Git / 部署注意事项

- 远程仓库：`https://github.com/QWQ-Inc/qwq-sso.git`（v3.4.21.1 起，原 `uesrbai/qwq-sso` 已弃用）
- **该仓库启用了 GitHub Secret Scanning + Tag Protection**，历史上有一次真实的腾讯云 Secret ID 被误提交进某次历史（具体在哪个 commit 未彻底定位清楚），导致后续所有推送/打 tag 反复被拦截
- 用户最终采用的工作流：**每次发布新版本时 `rm -rf .git && git init` 重新开始**，不保留连续提交历史，只保留 tag 快照（v2.0.0、v3.0.0、v3.1.0、v3.2.0 等），`git push --force` 覆盖 main 分支
- **不要尝试"保留完整连续 git 历史"的方案**——之前尝试过，因为主目录曾经有个误建的 `.git`（在 `C:\Users\xurui` 根目录，混入了大量个人文件和 Codex 运行时缓存），排查耗费大量精力，最终放弃，回到"每次重新初始化"的简单方案
- 部署路径确认：本地解压 zip 到某个 `sso-deploy_XX/sso-system` 目录后，直接在**该子目录**里 `git init`，不要在上层目录操作
- Zeabur 会自动从 GitHub 拉取部署，`git push` 成功后无需额外操作

---

## v3.4.40 iOS 修：网页改外部浏览器（Passkey/操作可用）+ 备忘录图片缩放/保存（用户反馈·批次1）

四级补丁（iOS）。用户反馈一批问题，本批修两个最痛的：

- **App 内网页识别不到操作 + 调不起 Passkey** → 改为**外部真 Safari 打开**并带登录态：`WebOpen.swift` 的 `openAuthedWeb`
  经 `/login-success.html?token=&next=` 落地（存 token 再跳 next）。MeTab「打开网页控制台」、AccountSettings「Passkey/更多」都改用它，去掉内嵌 WKWebView。（WebFallbackView/WebTarget 暂留未用。）
- **备忘录已有图片不能缩放/保存** → `ImagePreview` 加捏合缩放(1~5x)+双击放大+长按/右上「保存·分享」(`ActivityView` 系统面板含存相册)。

⚠️ 其余反馈排队后续批次：商城（兑换券 使用/转让/丢弃、积分转账、兑换记录、积分日志、商品分类）、应用市场（搜索+分类）、水印不生效（web bug 待查）、登录主体的成员/应用开放在两端不明显。

## v3.4.39 iOS 打磨：备忘录附件上传 + 登录日志 CSV 导出/分享 + 盲盒开启动画（用户反馈）

四级补丁（iOS）。三个打磨项：

- **备忘录附件上传原生化**（`MemoEditView`，仅编辑态）：PhotosPicker 选图（统一转 JPEG 再传，避免 HEIC 被 magic bytes 拒）、
  `.fileImporter` 选文件、`+链接`（弹窗，走 `/memos/:id/links`）；上传走 `POST /memos/:id/attachments?filename=`（原始字节），左滑删附件。
- **登录日志 CSV 导出/分享**（`LoginLogsView`）：`canExport` 为真时右上角分享按钮 → 拉 `/user/login-logs/export` 写临时文件 → `UIActivityViewController` 分享。
- **盲盒开启动画**（`BlindBoxRevealView`）：兑换 `is_blind_box` 商品成功 → 礼盒抖动放大→翻转揭晓奖励（解析 reward label/type，未即开则提示到兑换券里开）。
- `APIClient` 加 `memoUpload/memoAddLink/memoDeleteAttachment/rawGet/loginLogsCSV`；`loginLogs` 增回 `canExport`。
- ⚠️ 仍靠 GitHub Actions（macos-15）云端编译验证。

## v3.4.38 iOS 原生登录日志（用户端原生化收尾）（用户反馈）

四级补丁（iOS）。MeTab 加「登录日志」NavigationLink → `LoginLogsView`：拉 `/user/login-logs`（近 N 天，
返回 logs/windowDays/canExport），展示 方式/时间/IP/应用/状态/失败原因，下拉刷新、底部「近 N 天共 M 条」。
`APIClient` 加 `loginLogs`。导出 CSV 暂留网页（`/user/login-logs/export`）。
至此 iOS 用户端主要功能原生化基本收尾（首页/商城/备忘录/应用/我的[账号设定·登录日志·切换系统·扫码]/公告）。

## v3.4.37 公告邮件群发 + iOS 原生公告（用户反馈）

三级版本。用户：公告高频，且发完可选邮件群发。

### 后端/管理端：发布公告可邮件群发

- `api.js` 加 `broadcastAnnouncementEmail(a)`：查所有绑邮箱的真实用户（`is_public=0`），标题 `【公告】<title>`、正文 = 公告 HTML，
  经 `sendEmail`（QWQ Message 分发中心）**后台异步逐个发**（不阻塞响应）；未配分发中心则跳过。
- `POST /admin/announcements` / `PATCH /admin/announcements/:id` 接 `send_email`，发/存后触发群发，返回 `{emailed, email_configured}`。
- 另加 `POST /admin/announcements/:id/email` 对已有公告单独群发。
- `dashboard.html` 公告弹窗加「同时邮件群发」勾选框；`submitAnnounce` 传 `send_email` 并在 toast 反馈群发人数。

### iOS：原生公告

- `AnnouncementView.swift`：`AnnouncementDetailView` 用 `NSAttributedString(HTML)`→`AttributedString` 原生渲染富文本 + 「我知道了」（`/user/announcements/:id/read`）+ 外链。
- `HomeTabView` 首页加「公告」区：拉 `/user/announcements/pending`（未读/更新过的），按级别配色，点开详情、已读后刷新。
- `APIClient` 加 `announcementsPending/announcementRead`。
- ⚠️ 仍靠 GitHub Actions（macos-15）云端编译验证。

## v3.4.36 iOS 客户端原生化·第四批：账号设定（改邮箱手机 / 2FA）（用户反馈）

三级版本（iOS）。MeTab「账号设定」改为原生页 `AccountSettingsView`。

- **改邮箱 / 手机号**（`ContactChangeView`）：发码到新地址（`/user/contact/send-code`）→ 验证（`/user/contact/verify`）。
- **两步验证**（`TwoFASetupView`）：`/user/2fa/setup` 出密钥+otpauth（可点链接一键加到验证器/手动录入）→ `/user/2fa/enable` 校验动态码开启并展示 10 个恢复码；`/user/2fa/disable` 输动态码关闭；`/user/2fa/status` 显示状态/剩余恢复码。
- **Passkey / 更多绑定** → 走网页（原生 Passkey 需 Associated Domains，见 v3.4.30 说明）。
- `APIClient` 加 `contactSendCode/contactVerify/twofaStatus/twofaSetup/twofaEnable/twofaDisable`。
- ⚠️ 仍靠 GitHub Actions（macos-15）云端编译验证。
- 后续：公告、登录日志（较低频，可原生或留网页）。用户端主要功能已基本原生化。

## v3.4.35 iOS 客户端原生化·第三批：应用市场 / 授权 / 打开应用（用户反馈）

三级版本（iOS）。加原生「应用」分页（现 5 分页：首页/积分商城/备忘录/应用/我的）。

- `AppsTabView`：`/apps/market` 列出可见应用；每行 授权(`POST /apps/:id/auth`) / 取消授权(左滑，`DELETE /apps/:id/auth`) / 打开。
- 打开应用：`POST /oauth/launch {app_id}`（**根路径，非 /api**）拿 url → `UIApplication.shared.open` 交系统浏览器（launch_url 直开；authorize 为 IdP 发起式授权链接）。
- `APIClient` 加 `appsMarket/appAuthorize/appRevoke/appLaunch`。
- ⚠️ IdP 发起式(authorize) 在外部 Safari 若无 SSO 网页会话可能要再登一次——深度会话共享属后续优化；多数应用用 launch_url 直开无此问题。
- ⚠️ 仍靠 GitHub Actions（macos-15）云端编译验证。
- 后续：账号设定（改邮箱手机/2FA/Passkey 绑定）、公告、登录日志。

## v3.4.34 iOS 客户端原生化·第二批：备忘录（用户反馈）

三级版本（iOS）。承接 v3.4.33，加原生「备忘录」分页。

- `MemoTabView`：列表（标题/摘要/标签/附件数）、下拉刷新、左滑删除、右上「+」新建。
- `MemoEditView`：标题/正文/标签 新建+编辑（`/memos` POST、`/memos/:id` PATCH/DELETE）、转交（`/memos/:id/transfer`）、
  附件查看（图片经带鉴权 `attachmentData` 拉字节内联预览、链接可点、其它文件显示名称；**新增附件仍走网页端**）。
- `APIClient` 加 `memoList/memoGet/memoCreate/memoUpdate/memoDelete/memoTransfer/attachmentData` + 通用 `sendBody`(PATCH/DELETE)。
- ⚠️ 命名坑：SwiftUI View 的 `body` 与备忘录正文字段冲突，正文 state 改名 `noteBody`。`UIImage` 需 `import UIKit`。
- ⚠️ 仍靠 GitHub Actions（macos-15）云端编译验证。
- 后续：应用市场/已授权应用、账号设定（改邮箱手机/2FA/Passkey）、公告、登录日志。

## v3.4.33 iOS 客户端原生化·第一批：底部分页 + 首页(签到/积分) + 积分商城 + 我的（用户反馈）

三级版本（iOS）。用户定位：**手机端要做成完整客户端、覆盖用户端大部分服务，不是只做登录器；逐屏原生化（不内嵌 dashboard，否则和网页没区别）**。本批把登录后主界面从单屏改为**原生底部分页**并原生实现前三块。

- `MainTabView`（登录后）：首页 / 积分商城 / 我的（后续加 备忘录/应用市场 等）。
- `HomeTabView`：积分 + 签到（`GET /api/user/me` 读 points/checkin_streak/last_checkin，`POST /api/user/checkin/v2` 签到；`isDateInToday` 判今日已签）。
- `ShopTabView`：在售商品（`/shop/goods`）+ 兑换（`/shop/exchange/:id`，弹结果）+ 我的兑换券（`/user/coupons`）。下拉刷新。
- `MeTabView`：资料（名/UID/网域）+ 实名状态（只读，从 me 的 kyc_verified/kyc_name/kyc_id_tail）+ 扫一扫 + 切换系统 + 打开网页控制台（未原生化功能兜底）+ 退出；进入拉 me 写回 setMe。
- `APIClient` 加 `meUser/checkin/shopGoods/exchange/coupons`。删除旧 `HomeView.swift`（内容拆进 MeTab/HomeTab），`RootView` 已登录 → `MainTabView`。
- ⚠️ 内嵌 WebView 仅作**未原生化功能的兜底入口**（账号设定/更多）；管理端复杂配置（系统配置/环境变量）始终走网页。
- ⚠️ 仍靠 GitHub Actions（macos-15）云端编译验证（本机 Windows）。
- 后续：备忘录、应用市场/已授权应用、账号设定（改邮箱手机/2FA/Passkey 绑定）、公告、登录日志等逐屏原生化。见记忆 mobile-vision。

## v3.4.32 每登录主体的小管理体系（强制 2FA / 登录 IP 白名单 / 登录时段）（用户反馈）

三级版本。每个「登录主体」可配自己的登录策略，用户**经该主体三方登录**时强制执行。

### 数据（db.js oauth_subjects 迁移区块）

- 加列 `require_2fa`(0/1) / `ip_allow`(TEXT，逗号 CIDR/精确/*) / `login_start` / `login_end`(HH:MM)；`oauthSubjectStmts.setPolicy`。

### 执行（oauth.js `loginSuccess`）

- `findOrCreate` 顶部把 `provider`(providerKey) 存进 `reqCtx` 的 `_loginProviderKey`；`loginSuccess` 据此 `subjectOfProviderKey`→取主体策略。
- **IP 白名单**：`ipAllowed(clientIp, list)`（复用 auth.js，支持 CIDR/精确/*）不匹配 → `?error=ip_denied`。
- **登录时段**：`withinLoginWindow(start,end)`（本地时间，start>end 视为跨夜）不在内 → `?error=time_denied`。
- **强制两步验证**：用户已开 2FA → 走既有二段门；未开 → `?error=need_2fa` 拒绝并提示先启用（因为前端 mustSetup2fa 仅是提示、不硬拦，故用「拒绝」来真正强制）。
- ⚠️ 只作用于**经登录主体的第三方登录**；env 默认凭证/邮箱/手机/密码登录不经主体、不受此策略约束。

### 管理端 / 接口 / 登录页

- `api.js`：`GET /admin/oauth-subjects` 返回策略字段；`PATCH` 接收并 `setPolicy`（HH:MM 校验，非法清空）；新建后若填策略再补一次 PATCH。
- `dashboard.html` 主体弹窗加「登录策略」区（强制 2FA 勾选 / IP 白名单 / 起止时段），`openSubjectModal` 回填、`saveSubject` 提交。
- `login.html` 错误文案加 `ip_denied` / `time_denied` / `need_2fa`。
- ⚠️ 测试：`withinLoginWindow` 7 项（含跨夜/边界/非法放行）+ `ipAllowed`（v3.4.8 已 21 项）逻辑校验通过；dev 浏览器实测主体弹窗策略字段回填+采集。

至此「三方凭证归位 + 登录主体小管理体系」Web 侧完成；手机端多系统 v3.4.31 也已做。

## v3.4.31 iOS 手机端多系统 / 多网域切换（用户反馈）

三级版本（iOS）。App 从「单一网域」升级为**可同时保存多个来源系统（多网域），随时切换**
（如 sso.xubainet.cn + sso.staff.qwq.us 并存，各自独立登录态）。

- `AppState` 重构：`Account{id,domain,token,name,uid}` 列表 + `currentId`，JSON 存 UserDefaults；
  旧单系统存储（sso_domain/sso_token）**自动迁移**为第一个账户。
  `domain/token/baseURL/meName/meUid` 代理到「当前账户」；变更走 `setToken/setMe/logoutCurrent/switchTo/addSystem/removeSystem`。
  `handleDeepLink(qwqsso://login?domain=&token=)`：domain→加入/切到该系统、token→设当前（配合 v3.4.25/30 深链）。
- 新 `SystemSwitcherView`：列出已添加系统（当前打勾、显示网域/未登录）、点选切换、左滑删除、「添加系统」。
- `DomainEntryView` 复用：首个系统（`asSheet=false`）或从切换器「添加系统」（`asSheet=true`，带取消），成功即 `addSystem`。
- `RootView`：无账户→填网域；当前未登录→登录；已登录→首页；`showAddSystem` 弹添加。
- `LoginView`/`HomeView` 顶栏「换网域」改为「切换系统」→ `SystemSwitcherView`；token/退出/资料改用 `setToken/logoutCurrent/setMe`。
- ⚠️「用登录主账号登录后切换组织」= 单系统内的组织切换（Web 已有 v3.4.19）；本版做的是**跨系统/跨网域**切换。每主体小管理体系（每登录强制 2FA / IP 检测）为后续。
- ⚠️ 仍靠 GitHub Actions（macos-15）云端编译验证。

## v3.4.30 iOS Passkey/第三方走系统 Safari 授权会话再深链回来（用户反馈）

四级补丁（iOS + Web）。用户点子：Passkey 不必原生 ASAuthorization（要签名+Associated Domains+AASA+固定域），
**点一下跳网页授权、完成后深链回来**即可——对任意域都成立、零 entitlement。

### App（`ios/`）

- 新增 `WebAuthLauncher`（`ASWebAuthenticationSession`，真 Safari 引擎→**Passkey / 第三方 OAuth 都能用**，命中 `qwqsso://` 回调自动关会话回 App）。
- `LoginView`：第三方按钮 + 「网页登录」合并为一个「**Passkey / 第三方 / 网页登录**」按钮 → `openWebAuth()` 打开
  `ASWebAuthenticationSession(baseURL + "/login.html?native=1")`，回调取 token 存 `state.token`。原生密码 / 邮箱·手机验证码 / 扫码保留。
  （移除了 LoginView 里旧的 WKWebView 第三方入口 `webPath`；WKWebView 仅 HomeView「打开网页控制台」还在用。）
- 扫到网页二维码也走 `openWebAuth()`。

### Web（识别「系统 Safari 授权会话」）

- 系统 Safari 无自定义 UA，靠 `?native=1` 标记 + `sessionStorage.sso_native`（第三方 OAuth 往返后仍成立）。
- `nativeAuthFlag()` / `returnsToApp() = inAppWebView() || nativeAuthFlag()`；`login.html` 的 `redirect()`、已登录直通、`login-success.html` 三处返回点都改用它 → 登录成功跳 `qwqsso://login?token=`。
- `maybeOfferAppLogin()` 在 `nativeAuthFlag()` 时跳过（否则会提前把会话弹掉）。

⚠️ 于是 App 里 Passkey / 微信飞书等第三方：点按钮→系统 Safari 完成→自动回 App 登录。任意用户输入的网域都适用，不需要 Apple 账号 / Associated Domains。
⚠️ 仍靠 GitHub Actions（macos-15）云端编译验证。

## v3.4.29 iOS 修：网页/第三方登录一打开就被弹回 + 手机号验证码登录（用户反馈）

四级补丁（iOS）。两个问题：

### 1. 🐛 App 里点「网页登录 / 第三方登录」一打开就被弹回

根因：`WebFallbackView` 里 `wv.configuration.applicationNameForUserAgent = "QWQSSOApp"` 设在 **WKWebView 创建之后**——
`WKWebView` 在 init 时就复制了 configuration，事后设无效。于是网页 UA 里没有 `QWQSSOApp`，
`login.html` 把它当普通手机浏览器 → `maybeOfferAppLogin()` 触发静默 `qwqsso://` 深链 iframe → nav 代理拦截 `qwqsso://` 并 `dismiss()` → **一打开就被弹回**。
修：改成先建 `WKWebViewConfiguration`、在上面设 `applicationNameForUserAgent`（+ `websiteDataStore = .nonPersistent()` 干净会话防残留 token 自动跳回），再 `WKWebView(frame:configuration:)`。

### 2. 手机号验证码登录（App 之前只有邮箱验证码）

- `APIClient` 加 `sendSmsCode`(`/api/sms/send`) / `smsCodeLogin`(`/api/sms/verify`)。
- `LoginView` 验证码 tab 加「邮箱 / 手机号」分段切换；手机号走 SMS 收发码，登录/注册与邮箱一致（都过 2FA 门）。

⚠️ 仍靠 GitHub Actions（macos-15）云端编译验证（本机 Windows）。
⚠️ **Passkey 原生化**（用户也要）需 App 签名 + Associated Domains 授权 + 域名托管 AASA，且多租户下 RP ID=用户输入的域较麻烦，单列后续版本处理（当前 Passkey 可经 App 内网页兜底使用）。

## v3.4.28 三方凭证归位·第二步：配置从系统配置搬到登录主体页（用户反馈）

三级版本。承接 v3.4.27，把三方凭证的**配置入口**统一到「登录主体」页，系统配置不再有三方登录（解决「两处配置」矛盾）。

- `dashboard.html` 登录主体页（`page-adm-oauth`）顶部加「**默认主体（本站）· 三方登录凭证**」卡片：
  `renderDefaultSubjectCreds()` 复用系统配置那套 env 编辑器（`_envRowHtml` + 全局 `onEnvInput`/`toggleEnvSecret`/`envSecretVisible`），
  渲染所有 `category==='oauth'` 的 ENV_GROUPS（13 个平台）；`saveDefaultSubjectCreds()` 走 `POST /admin/env`（沿用圆点占位/未改 secret 跳过三道防线）。
  `loadOauthSubjects()` 进页时一并渲染。下方仍是「额外主体」CRUD。
- 系统配置：`ENV_CATEGORIES` 移除 `oauth`；`renderEnvCards` 用 `g.category!=='oauth'` 过滤（含「全部配置」），系统配置彻底不再显示三方登录。
- ⚠️ env 默认凭证**照旧生效**（后端没动），只是编辑入口换到登录主体页；无破坏性迁移，存量绑定不受影响。
- ⚠️ dev 浏览器实测：登录主体页渲染 13 个平台凭证 section；系统配置分类只剩 全部/消息通知/实名认证/支付/系统与页脚，侧栏无「三方登录」。

至此「三方凭证归位」Web 侧做完（v3.4.27 登录页先选主体 + v3.4.28 配置归位）。手机端多系统、每主体小管理体系为后续。

## v3.4.27 登录页三方按平台分组 + 先选登录主体再授权（三方凭证归位·第一步）（用户反馈）

三级版本。用户指出矛盾：三方登录凭证同时在「系统配置(环境变量)」和「登录主体页」两处，用户登录三方时不知道用哪套凭证。
决策（已问用户）：**环境变量已配的三方凭证保留为「默认主体(本站)」不做破坏性迁移；Web 先做，连续多版本推进**。
本版是第一步（登录页 UX），把「用户不知道用哪个凭证」直接解决。

- `login.html`：`renderPlatformList` 改为**按平台分组**（一平台一按钮，显示「N 个主体」），点平台：
  - 单主体 → 直接授权/渲二维码；
  - 多主体 → 弹 `showSubjectPicker`「选择 X 登录主体」→ 选中再 `selectMethod`（授权或扫码）。
  - 环境变量默认主体在选择器里标 **「默认（本站）」**，不再是无标签的裸「微信」和「微信·A公司」并列的困惑态。
- `selectMethod` 高亮改用 `pb-<platform>`（原来是 `pb-m<idx>`）。
- ⚠️ dev 浏览器实测（mock 4 个 method）：微信显示「2 个主体」→ 点击弹选择器（默认（本站）/ A公司）→ 选默认渲染二维码无报错；企业微信/飞书单主体直接走。

### 后续（连续推进，未在本版）

- **v3.4.28（管理端归位）**：把三方凭证配置从「系统配置 → 三方登录」搬到「登录主体页」，环境变量默认凭证显示为可编辑的「默认主体(本站)」；系统配置移除三方分类（环境变量只留邮箱/手机/App 扫码/消息/KYC/系统等）。
- **v3.4.29+（手机端多系统）**：App 添加多个来源网域（sso.xubainet.cn / sso.staff.qwq.us…）、切换、输入网域直接选登录主体登录。
- **再后（每主体小管理体系）**：登录主体可配自己的策略（每次登录强制 2FA、检测登录 IP 等）。

## v3.4.26.1 修 .ipa 安装报 MissingBundleExecutable（Info.plist 缺 CFBundleExecutable）（用户反馈）

四级补丁。用户安装 v3.4.26 的未签名 .ipa（自行重签/侧载）时报
`MissingBundleExecutable ... Payload/QWQSSO.app has missing or invalid CFBundleExecutable`。
根因：`ios/Info.plist` 手写且 `GENERATE_INFOPLIST_FILE=NO`，**没写 `CFBundleExecutable`**，Xcode 也不会自动注入 → 打出来的 .app 没声明可执行文件名 → 安装被拒。
修：`Info.plist` 补 `CFBundleExecutable = $(EXECUTABLE_NAME)`（处理 Info.plist 时展开为 QWQSSO）+ `CFBundleInfoDictionaryVersion`、`UIDeviceFamily`。
⚠️ 重新下 Artifacts 里的 `QWQSSO-unsigned-ipa` 再装。仍是未签名——真机安装要么用侧载工具重签、要么配 Apple 证书出签名包。

## v3.4.26 App 内网页登录回跳 App + CI 出可下载未签名 .ipa（用户反馈）

三级版本。两件事：

### 1. App 内嵌 WebView 登录成功 → 回跳 App（第三方/网页登录在 App 内真正完成）

- 网页端（`login.html` `redirect()` + 已登录直通分支、`login-success.html`）：检测到在 App 内（UA 含 `QWQSSOApp`）且无 `next` 时，
  登录成功不再进网页 dashboard，而是 `location.href = 'qwqsso://login?token=<jwt>'` 把 token 交回 App。
- App（`WebFallbackView` 的 `WKWebView` 加 `WKNavigationDelegate`）：拦截 `qwqsso://` 导航 → 取出 token → `onToken` 回调（`state.token = t`）→ 关闭网页。
  于是「第三方登录 / 网页登录」在 App 里点完就登进来了（之前只是展示网页、不回流）。
- ⚠️ 带 `next`（OIDC 授权）时仍走网页流程，完整 OIDC-in-app 后续再做。

### 2. CI 从「只编译」升级为「打包 + 上传未签名 .ipa」（用户反馈找不到 ipa）

用户反映 Actions 里只有「iOS Build」、没有 ipa 产物页。原因：之前 workflow 只 `xcodebuild build` 验证可编译、不打包不上传。
现在 `.github/workflows/ios.yml`（改名 **iOS Build (unsigned IPA)**）：
- `-sdk iphoneos -configuration Release CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO` 出未签名 .app；
- 手动塞进 `Payload/` 打包成 `QWQSSO-unsigned.ipa`；
- `actions/upload-artifact` 上传，运行页 **Artifacts → QWQSSO-unsigned-ipa** 可下载。
- ⚠️ 未签名 .ipa **不能直接装真机**（iOS 拒装）；真机/TestFlight 需 Apple 证书（Secrets）走签名导出，`ios.yml` 底部有说明。

## v3.4.25 登录深链：手机端按 UA 唤起 App，未装回退网页（用户反馈）

三级版本。承接 v3.4.24 的 iOS App，落地「网页端过来按浏览器/客户端判定：手机→跳 App 登录，没装/不支持→网页登录」。

### 网页端（`login.html`）

- `maybeOfferAppLogin()`（DOMContentLoaded 里调）：UA 命中 `iPhone/iPad/iPod/Android` 且**不在 App 内**（UA 不含 `QWQSSOApp`）、非 localhost 时：
  - 顶部提示条 +「打开 App」按钮 → `window.location.href = 'qwqsso://login?domain=<本域>&next=<站内相对>'`
  - 本会话**静默自动尝试一次**（隐藏 iframe 指向深链）：装了 App 就唤起，没装无感知，用户继续用下方网页登录（天然回退）。
  - `next`（OIDC 授权流程）透传进深链，App 端可据此接续（当前 App 先进该域登录，完整 OIDC-in-app 后续再做）。
- ⚠️ 没走「自动 `location.href` 跳深链」是因为 iOS 对未注册 scheme 会弹丑陋报错；改「静默 iframe + 手动按钮」更稳、无打扰。真要无缝可后续接 Universal Links（需 apple-app-site-association + 证书 entitlement）。

### App 端（`ios/`）

- `AppState.handleDeepLink` 扩展：解析 `qwqsso://login?domain=&token=&next=`——`domain` 带过来则 App 直接进该域登录（免手输）；`token` 则直接登录。
- `LoginView` 加 `.task`：methods 为空（深链直达登录页）时按需拉 `/api/public/login-methods`。
- `WebFallbackView` 给 WKWebView 设 `applicationNameForUserAgent = "QWQSSOApp"`：网页据此识别「已在 App 内」，**避免网页又触发深链套娃**。
- ⚠️ 仍靠 GitHub Actions（macos-15）云端编译验证（本机 Windows 无法本地 build）。

至此 App 相关三版做完：v3.4.24 骨架 → v3.4.24.x 云编译打通 → v3.4.25 深链。

## v3.4.24.2 iOS CI 终于绿：runner 升 macos-15（Xcode 16 读 objectVersion 77）（用户反馈）

四级补丁。承接 v3.4.24.1 继续修 iOS 云编译，靠「push→读公开 API 的 run 结论/注解」反复迭代（本机 Windows 无法本地 build，
GitHub 完整日志又需鉴权读不到，于是让 workflow 失败时把 `xcodebuild` 的 error 行/日志尾部 `echo "::error::"` 成 **annotation**——注解可无鉴权读）。定位到三层问题，逐层修完 CI 转绿：

1. **`paths:` 过滤在 `rm -rf .git` force-push 下整批不触发** → 改 `on: push: branches:[main]`（每次 push 都跑；纯 Web 版也会跑一次 iOS 构建，可接受）。
2. **`xcodebuild: Unable to read project`**：XcodeGen 新版输出 `objectVersion = 77`（Xcode 16 格式），而 `macos-14` runner 是 **Xcode 15.4**，读不了。（试过 project.yml `options.objectVersion:54` **无效**——该 key 不被 XcodeGen 采纳。）→ **runner 改 `macos-15`**（自带 Xcode 16）。
3. v3.4.24.1 的两处（补 `import UIKit`、`Info.plist` 移出 sources）本来就对，被上面两层挡住没验证到；runner 一换，**Swift 编译通过、iOS Build 转绿**。

⚠️ 教训：GitHub annotation 每步只显约 10 条，诊断时先 emit 最关键的几行（版本/objectVersion/-list 错误），别被 `ls` 刷屏。
⚠️ CI 现在 `on: push:main` 无 paths 过滤——以后想省 macOS 构建分钟，确认稳定后可加回 `paths: ['ios/**','.github/workflows/ios.yml']`（但注意 force-push 重开历史时可能不触发）。

## v3.4.24.1 iOS 骨架编译修复（GitHub Actions 报错→修）（用户反馈）

四级补丁。v3.4.24 push 后 GitHub Actions「iOS Build」失败（exit 74，Swift 编译错）。本机 Windows 无法本地
`xcodebuild`，靠云端 CI 暴露问题 + 公开 API 读结论/注解（日志需鉴权、读不到全文），据经验修两处最可能根因：

- **缺 `import UIKit`**：`LoginView` 在函数签名里点名了 `UIKeyboardType`、`ScannerView` 声明了 `UIViewController`/`UIView` 子类——`import SwiftUI` 不 re-export 这些。给 `LoginView`/`ScannerView`/`WebFallbackView` 都补 `import UIKit`。
- **Info.plist 在 sources 目录里**：XcodeGen 默认把 `QWQSSO/` 下的非源码文件扫进 Copy Resources → 与 `INFOPLIST_FILE` 冲突「Multiple commands produce Info.plist」。把 `Info.plist` 移到 `ios/Info.plist`（sources 之外），`project.yml` 的 `INFOPLIST_FILE` 改为 `Info.plist`。
- ⚠️ 仍靠 CI 复验：push 后看 Actions「iOS Build」是否转绿；若还有错按注解继续修。

## v3.4.24 iOS 原生 App 骨架（SwiftUI，域名优先 + qwqsso:// + GitHub Actions 云编译）（用户反馈）

三级版本。用户要「iOS 原生 Swift 工程骨架，首屏填所属网域，深链 qwqsso://」，并问「GitHub 不能编译 ipa 吗」。
**能**——GitHub 的 macOS runner 自带 Xcode。所以工程 + CI 都放进本仓库，云端编译。

### 放在 `ios/`（源码随仓库走；编译/签名在 Mac 或 GitHub Actions）

- **不手写 `.pbxproj`**，用 XcodeGen `ios/project.yml` 生成工程（`brew install xcodegen && xcodegen generate`）。
- Bundle ID `cn.xubainet.qwqsso`；最低 iOS 16；URL Scheme `qwqsso`（`Info.plist`）。
- SwiftUI 源码（`ios/QWQSSO/*.swift`）：
  - `AppState`：`domain`/`token`/`methods` 存 UserDefaults；`normalizeBase` 归一化 https://host；`handleDeepLink` 处理 `qwqsso://login?token=`。
  - `DomainEntryView`：**首屏填所属网域** → 探针式拉 `GET /api/public/login-methods` 校验并加载登录方式。
  - `LoginView`：密码登录（`/api/account/login`）、邮箱验证码（`/api/email/send-code`+`/verify-code`）、2FA 二段（`/api/2fa/login-verify`）、第三方/网页登录（`WKWebView` 兜底 `WebFallbackView`）、扫码（`ScannerView`，AVFoundation）。
  - `HomeView`：拉 `/api/user/me`，扫一扫 / 打开网页控制台 / 退出 / 换网域。
  - `APIClient`：async URLSession + JSONSerialization（容忍字段增减）。
- **GitHub Actions**（`.github/workflows/ios.yml`）：macOS runner → `brew install xcodegen` → `xcodegen generate` →
  `xcodebuild ... -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO build`，**未签名构建、免费、无需证书**，验证可编译。
  文件底部注明：出**已签名 .ipa**（TestFlight/真机）需 Apple 开发者账号证书 + 描述文件存 GitHub Secrets 再加导出步骤。

### ⚠️ 未完（下一版 v3.4.25）

- 深链**后端侧**：目前 App 已注册并能接住 `qwqsso://login?token=`，但后端网页/第三方登录完成后**还没有**回跳到 `qwqsso://` 的逻辑——第三方/网页登录暂用内嵌 `WKWebView` 兜底（今天就能用）。v3.4.25 做 `login.html` 按 UA 检测 + 深链唤起 + 超时回退。
- ⚠️ 本会话是 Windows，**无法本地 `xcodebuild`**；Swift 源码靠人工审查 + 依赖 GitHub Actions 云端编译验证（push 后看 Actions → iOS Build）。若 CI 报编译错，按日志修 `ios/QWQSSO/*.swift` 再推。

## v3.4.23 防截图水印（管理员配显示范围+策略，开放 API 可改）（用户反馈）

三级版本。用户要「水印功能，显示范围与各种策略由管理员决定，水印信息可用 API 对接/修改」。

### 后端（api.js）

- `watermarkPolicy()` 读 8 个 env（都带范围/夹紧兜底）→ `{enabled, scope[], text, opacity, angle, size, gap, color}`。
  - `WATERMARK_ENABLED`(on/off) / `WATERMARK_SCOPE`(逗号页面标识或 all) / `WATERMARK_TEXT`(模板) /
    `WATERMARK_OPACITY`(0.01~1) / `WATERMARK_ANGLE`(-90~90) / `WATERMARK_SIZE`(8~48) / `WATERMARK_GAP`(60~600) / `WATERMARK_COLOR`(#hex)。
- 公开 `GET /api/public/watermark`（无用户数据，模板变量前端解析）。
- 开放 API：`GET /v1/watermark`（新 scope `config:read`）/ `PUT /v1/watermark`（`config:write`）——PUT 把字段映射回 WATERMARK_* 写 env_config + process.env 即时生效，都有 sandbox 桩。
- init.js ENV_KEYS 补 8 键；scope 计数 35→37。

### 前端

- `dashboard.html`：`applyWatermark(page)` 用一张平铺 SVG data-uri 铺满 `position:fixed;inset:0;pointer-events:none;z-index:9998` 的遮罩层；
  文本模板 `_wmResolve` 支持 {name}{uid}{email}{date}{time}{datetime}；`_wmPageMatches` 做**按页面显示范围**判定
  （all/dashboard=整站；否则仅当前页在 scope；adm-memo 归 memo、account 归 kyc）。`loadMe` 末尾 `initWatermark()` 拉策略、`goto` 每次切页 `applyWatermark(page)`。dev 模式内置一份演示策略。
- `login.html`：DOMContentLoaded 里若 scope 含 login/all 则贴同款遮罩（登录页无用户，用户类变量解析为空，兜底 QWQ SSO）。
- 系统配置「水印」组（8 项）；开放 API 文档速查表加 config:read/write。
- ⚠️ dev 浏览器实测：整站平铺水印「许睿 #00001 2026-09-30 12:37」-22° 淡显、pointer-events 不挡操作；scope=['memo'] 时 home 隐藏、memo 页显示。
- 刻意未做（未来）：**把水印烧进导出的图片/PDF**（需 canvas 合成，属另一档工作量）；本版是页面 DOM 层水印（防截图/录屏外泄场景）。

## v3.4.22 备忘录三修：附件可查看 + 管理端分权限 + 新建主体名称 bug（用户反馈）

三级版本。用户一次反馈三点，全部落地：

### 1. 🐛 新建主体报「请填写主体名称」（明明填了）—— 重复 id

`dashboard.html` 里 `id="sm-name"` 撞车：`1237` 是商品/盲盒详情弹窗的 `<h3 id="sm-name">`，
`2303` 是登录主体弹窗的输入框。`getElementById('sm-name')` 命中 DOM 中**靠前**的那个 `<h3>`（无 `.value`），
于是你在真正的输入框里打的字从没被读到 → 永远判空。已把主体输入框 id 改为 `subj-name`（+ `openSubjectModal`/`saveSubject` 两处引用）。

### 2. 🐛 备忘录附件传上去查看不了（只有个缩略图）

后端本就对图片/PDF 返回 `inline`，问题在前端：图片只渲染成 22px 小缩略图、无法点开看大图，PDF 被当普通文件。
现在 `renderMemoAtts`：图片缩略图**点击弹灯箱看大图**、PDF **点击新标签内联打开**、其余文件仍下载。
新增 `memoViewAtt()`（附件接口需 Bearer，只能取 blob→objectURL：图片建灯箱、PDF `window.open`）。

### 3. 备忘录管理分权限（不再所有管理员都能看全部）

- 后端新增 `memoAdminLevel()`（env `MEMO_ADMIN_LEVEL`，**默认 1 = 仅超级管理员**，可放宽到如 2=Lv.1/Lv.2；夹 1~9）。
  `canMemoAdmin(user)` = 管理员且 `adminLevel <= memoAdminLevel()`。
- `memoOf()` 的管理员越权分支改用 `canMemoAdmin`（不达标的管理员不能看/删他人备忘录，本人始终能看自己的）；
  `GET /admin/memos` 从 `requireAdmin(3)` 改为**运行时** `canMemoAdmin` 动态判定（env 改了不重启即生效）。
- `/user/me` 下发 `memo_admin_level`；前端 `_MEMO_ADMIN_LEVEL` + `canMemoAdmin()`：不达标则「备忘录管理」菜单置灰加锁、
  `goto('adm-memo')` 走锁定页、`bootToLastPage` 丢弃该目标。系统配置「备忘录」组加 `MEMO_ADMIN_LEVEL`；init.js ENV_KEYS 同步。
- ⚠️ dev 浏览器实测：新建主体读到中文全名不再误报；附件渲染出图片灯箱/PDF 新标签/docx 下载三种入口；
  Lv.1 管理员可进备忘录管理，Lv.3 管理员菜单锁定 + goto 命中锁定页、真实页面不激活。

### 待办（本次未做，已与用户沟通，见对话）

用户同批还提了三块大功能，属于独立立项，未在本版动手：**① 备忘录/水印功能（水印信息可经 API 对接/修改）**；
**② iOS 原生 App**（不是本 Node 网页仓库能同流程构建/推送的交付物，需单独 Xcode 工程）；
**③ 登录跳转逻辑**（网页端按 UA 判定客户端：手机/iOS 且已装 App → 跳 App 登录，否则回退网页；扫码/三方绑定走 App 内）。

## v3.4.21.1 仓库地址迁移 + 侧边栏切换按钮被截断修复（用户反馈）

四级补丁。两件事：

### 远端仓库迁移 `uesrbai/qwq-sso` → `QWQ-Inc/qwq-sso`

用户告知仓库已迁到 `https://github.com/QWQ-Inc/qwq-sso`。同步改了四处引用：
`CLAUDE.md`（顶部 GitHub 行 + 页脚链接说明 + Git 注意事项的远程地址 + 提交命令模板的 `git remote add`）、
`README.md`（版本徽章链接）、`server/index.js`（页脚 `versionLink` 的 href）。
⚠️ 发版工作流的 `origin` 一律用新地址；`git remote add origin https://github.com/QWQ-Inc/qwq-sso.git`。

### 侧边栏「用户端/管理端」切换按钮被菜单撑没了

根因：`.nav` 是 `display:flex;flex-direction:column;overflow-y:auto` 且 `.nav-bottom{margin-top:auto}`。
功能越加越多（管理端菜单已 13 项），列表撑高溢出后，flex 的 auto 外边距 + 整体滚动把**顶部模式切换条**
和**底部用户菜单**一起挤出可视区、无法滚回（经典 flex column + overflow + margin-auto 截断）。

修法（`dashboard.html`，纯 CSS + 一层包裹）：
- 用 `<div class="nav-scroll">` 包住 `#nav-user` + `#nav-admin` 两个菜单块。
- `.nav{overflow:hidden}`（不再整体滚）；`.nav-brand`/`.mode-switch`/`.nav-bottom` 都加 `flex-shrink:0`（固定不压缩）；
  `.nav-scroll{flex:1 1 auto;min-height:0;overflow-y:auto}`（**只有菜单列表内部滚动**，`min-height:0` 是 flex 里能真正收缩滚动的关键）；
  `.nav-bottom` 去掉 `margin-top:auto`（改由 `nav-scroll` 的 `flex:1` 顶到底）。
- ⚠️ dev 浏览器 1180×600 实测管理端（13 项菜单，内容 553>可视 418）：模式切换条 top=80 完全可见、
  底部用户菜单 527→600 完全可见、中间列表内部滚动。两端固定不再被截断；窄屏抽屉（`@media max-width:900`）结构不受影响。

## v3.4.21 备忘录（标签 / 转交 / 图片·文件·链接附件）（用户反馈）

三级版本。用户端 + 管理端各加一个备忘录功能。确认后的模型（问卷被打断，按推荐默认执行）：
个人备忘录；**转交=移交所有权**（自己不再拥有，对方收到）；**管理员后台看/管全部**，普通用户只看自己的。

### 数据 + 存储（db.js）

- `memos(id, owner_id, title, body, tags 逗号分隔, created_at, updated_at)` + `memo_attachments(id, memo_id, kind[image|file|link], filename, mime, size, url, data BLOB, created_at)`。
- **附件存 SQLite BLOB**（随 data/sso.db 持久——Zeabur 临时磁盘下唯一可靠；单附件默认 5MB、`MEMO_MAX_ATTACH_MB` 可配、硬顶 12MB）。别改成写磁盘（重部署会丢）。

### 安全校验（`server/memo-util.js`，纯函数，27 项单测全过）

- 附件**扩展名白名单 + magic bytes 双校验**：放行 png/jpg/jpeg/gif/webp、pdf、docx/xlsx/pptx、txt/csv/md。
  **宏格式一律拒绝**：.doc/.docm/.xls/.xlsm/.ppt/.pptm（OLE 或启用宏的 OOXML）；可执行/脚本（exe/html/svg…）不在白名单即拒。
  改扩展名绕过被 magic bytes 拦（png 冒充 docx→PK 头不符→拒）。OOXML 的 .docx 是 PK zip 且宏格式扩展名不同，故按扩展名即可挡宏。
- 外链**默认仅白名单内网域**：`MEMO_LINK_DOMAINS`（逗号分隔域名/后缀，子域匹配）；**未配=禁所有外链**；站内相对（/ 开头非 //）始终允许；`javascript:`/`data:`/`//` 一律拒。

### 接口（api.js，均 requireAuth + noPublic；本人或管理员可访问）

- `GET /memos`、`GET/POST /memos`、`PATCH/DELETE /memos/:id`、`POST /memos/:id/transfer`（resolveUser + setOwner + 审计 `memo.transferred`）。
- `POST /memos/:id/links`（白名单校验）、`POST /memos/:id/attachments`（`express.raw` 收原始字节 + 校验 + 存 BLOB）、
  `GET /memos/:id/attachments/:aid`（图片/PDF 内联、其余强制下载 + `X-Content-Type-Options:nosniff`）、`DELETE .../:aid`。
- 管理端：`GET /admin/memos`（读 Lv.3，全部备忘录带 owner）。

### 前端（dashboard.html）

- 用户端「备忘录」菜单页（`ni-memo`/`page-memo`，加进 USER_PAGES）+ 管理端「备忘录」页（`ni-adm-memo`/`page-adm-memo`）。
- `memo-modal`：标题/正文/标签 + 附件区（+图片文件走 `<input type=file>` 原始上传、+链接、逐个删）+ 转交框 + 删除/保存。
  ⚠️ 新备忘录加附件前先 `ensureMemo()` 落库拿 id。图片预览/文件下载因附件接口需 Bearer 头，用 `fetch(...auth) → blob → objectURL`（`<img src>` 无法带头）。dev 模式跳过真实上传。
- 新增 scope 无（备忘录不开放给 /v1）；系统配置加「备忘录」组（`MEMO_LINK_DOMAINS`/`MEMO_MAX_ATTACH_MB`）；init.js ENV_KEYS 同步。

⚠️ 测试：`scratchpad/memo-util-test.js` node:sqlite 无关、纯函数 27 项全过（各类型放行、宏/exe/改扩展名/假 magic 拒绝、外链默认拒+白名单子域+`corp.local.evil.com` 不误放、大小上限）。
dev 浏览器实测：用户端建备忘录+标签+列表、外链 evil.com 被拒 / corp.local 通过、管理端全部备忘录带 owner 列。
⚠️ 附件上传/下载走 `express.raw` + Bearer blob，未在真实 HTTP 端到端跑（测试环境无 express），逻辑审查 + 校验单测覆盖。

## v3.4.20.2 弹窗超屏被裁修复（一处 CSS 全局修）（用户反馈）

四级补丁。用户反馈「添加/编辑应用等弹窗直接溢出屏幕、无法完全显示」。
根因（v3.4.6.2 那次没根治的点）：`.modal-mask.show{display:flex}` + `.modal{margin:auto}` 是 **flex 垂直居中**；
当弹窗比视口高，flex 居中会把**顶部裁到屏幕外且无法滚回去**（经典 flex 溢出裁剪 bug）——编辑应用弹窗本来就高，
这几版又加了接入凭据/必传字段/开放组织，直接超屏。而这些结构化弹窗多是 `padding:0;overflow:hidden` 无内部滚动、无 max-height。

修法（`dashboard.html` 一处基础 CSS，覆盖**所有**弹窗）：
- `.modal-mask.show{display:flex; align-items:flex-start; justify-content:center;}`（顶对齐，不再 flex 垂直居中）
- `.modal{... margin:0 auto;}`（只水平居中）
- 于是任何弹窗都从顶部开始，靠遮罩自身 `overflow-y:auto` 往下滚，头部（关闭）与底部（保存）都可达；短弹窗改为靠上显示（可接受）。
- ⚠️ dev 浏览器 1100×600 实测编辑应用弹窗：弹窗高 1059 > 视口 600，头部 top=25 可达、遮罩可滚、滚到底「保存修改」进入视口。一处 CSS 同时修好全部 `.modal`。

## v3.4.20.1 组织隔离一致性收尾：补 OIDC 授权/发起入口的门（用户反馈）

四级补丁。对 v3.4.18-20 的「应用按组织开放」做一致性审查（同 v3.4.15.1 的做法）。
结论：**无 token 泄露**——唯一签码点 `/oauth/consent` 早已有 `appVisibleToUser` 门，非成员在那里 403。但两处入口漏了预检，
会让非成员一路走到最后才 403（体验差 + 泄露「应用存在」）：

- `provider.js` `/oauth/authorize`(GET)：非成员进授权页前就 403（原来要走到 consent 才拦）。
- `provider.js` `/oauth/launch`：非成员发起（含用户端「已授权应用 → 打开」走的就是它）直接 403——顺带把「组织移除后仍能从已授权列表打开」这条路也堵上（新会话/重新授权都拦，仅存量未过期 access_token 到期前有效）。
- 已有的门：`/apps/market`（过滤）、`/apps/:id/auth`、`/oauth/consent`（签码 backstop）不变。
- ⚠️ 门逻辑就是 `appVisibleToUser`（v3.4.18 已 node:sqlite 13 项测过），本补丁只是多两处调用点，语法校验通过。

## v3.4.20 外部通讯录同步（组织成员批量导入）（IAM 第二阶段·下）（用户反馈）

三级版本。IAM 收尾——接外部通讯录。协议选**自定义批量 upsert 导入**（不做完整 SCIM server，那套对本架构过重；将来真要 SCIM 可再包一层）。

- `importOrgMembers(subject, rows, {removeMissing})`（api.js）：每行按 email/phone 找用户→找不到建号→加入/更新组织成员（`source=import`），org_uid 传了用（组内唯一）否则按规则自动生成。命中公共账号跳过。
  `remove_missing:true` 只清「本次未出现 **且** source=import」的成员——**手动加入的（source=manual）绝不动**。
- 接口：`POST /admin/orgs/:sid/import`（写 Lv.2）+ 开放 API `POST /v1/orgs/:sid/members/import`（新 scope `org:sync`，有 sandbox 桩）。都写审计存证 `org.members_imported`。
- 前端：组织成员弹窗加 `<details>` 批量导入区（粘贴「邮箱/手机, 姓名, 组织内UID」逐行），`doOrgImport()` 解析后 POST，弹结果摘要。dev 有 mock。
- 新 scope `org:sync`（dashboard ALL_SCOPES + API-docs 同步）；开放 API 计数 34→35。
- ⚠️ 测试：`scratchpad/import-test.js` node:sqlite 10 项全过（新建+自动UID、已存在用户 updated、指定UID、坏邮箱/公共账号/缺标识 error、成员计数、**removeMissing 只删 import 源保留 manual**）。
  dev 浏览器实测：粘贴两行导入，张三自动 EMP0001、李四指定 EMP0009。

至此 IAM 两阶段做完：v3.4.18 成员/组织内UID/应用按组织开放 → v3.4.19 登录后组织切换 → v3.4.20 外部通讯录同步。

## v3.4.19 登录后组织切换器（应用市场按组织过滤）（IAM 第二阶段·上）（用户反馈）

三级版本。承接 v3.4.18，落地「登录后选择组织 → 用组织内开放的应用」。

- 后端 `/apps/market` 加可选 `?org=<sid>`：我是该组织成员时，收窄为「全局应用 + 该组织开放的应用」；不传则按 v3.4.18 的并集（全局 + 我所有组织）。新增 `appOrgs.openToSubject` 语句。
- 前端应用市场搜索栏加**组织下拉**（`market-org`）：`loadMarketOrgs()` 从 `/user/orgs` 拉我的组织；有组织才显示，选择存 `localStorage.sso_current_org`，`renderMarket` 带 `?org=` 重新拉取。不属于任何组织的用户看不到下拉（行为零变化）。
- ⚠️ 「用组织凭证登录」沿用现有 login-methods（登录页选该组织的凭证），未在登录页另做 org-first 选择器——那需要 login-methods 额外下发凭证↔组织归属，性价比低，暂不做。
- dev 浏览器实测：普通用户应用市场出现组织下拉「全部我的组织 / 示例集团（EMP0001）」，切换持久化 + 重渲染无报错。

## v3.4.18 组织成员 + 组织内 UID + 应用按组织开放（IAM 第一阶段）（用户反馈）

三级版本。用户要「用户可选所在组织并用组织凭证登录 / 通用登录后选组织 → 用组织内开放的应用」+「IAM 用户管理打开，可接外部通讯录」。
确认后的模型：**组织 = 主体 oauth_subjects**；应用可全局或开放给若干组织；组织内 UID 仅作组织内身份辨认+必要认证，平台通用 uid_code 不变。
IAM「两者都要，分多版本走」——**本版是第一阶段（数据基座 + 管理端）**。

### 数据模型（db.js 迁移区块 + 语句）

- `org_members(subject_id, user_id, org_uid, source, created_at, PK(subject_id,user_id))` + 唯一索引 `idx_org_uid(subject_id, org_uid) WHERE org_uid IS NOT NULL`（组织内 UID 组内唯一、跨组织可重）。
- `oauth_subjects` 加 `uid_prefix` / `uid_len` / `uid_seq`（组织内 UID 自动生成规则 + per-组织自增计数）。
- `app_orgs(app_id, subject_id, PK)`：应用开放给哪些组织；**该应用无任何行 = 全局(通用)应用**（存量应用零变化）。
- `appVisibleToUser(appId, userId)`（db.js 导出）：全局应用对所有人可见；受限应用仅其开放组织的成员可见。
- 删主体连带清 `org_members` + `app_orgs`（api.js DELETE oauth-subjects）。

### 接口（api.js，读 Lv.3 / 写 Lv.2）

- `GET /admin/orgs`（组织+成员数+uid规则）、`GET/POST/PATCH/DELETE /admin/orgs/:sid/members`（成员 CRUD；POST 的 account 走 resolveUser，org_uid 留空则按规则 `genOrgUid` 自动生成、排公共账号）、`PATCH /admin/orgs/:sid/uid-rule`。
- `GET/PUT /admin/apps/:id/orgs`（应用开放组织列表，PUT 全量覆盖）。
- `GET /user/orgs`（我所属组织 + 组织内 UID）。
- **组织隔离落地**：`/apps/market` 只列 `appVisibleToUser` 的应用；`/apps/:id/auth` 与 `provider.js` 的 `/oauth/consent` 都加了「非开放组织成员 → 403」门。

### 前端（dashboard.html）

- 「登录主体」页每个组织加「👥 成员」按钮 → `orgmem-modal`：成员列表 + 按账号加入 + 组织内 UID（留空自动/手动改）+ 移出 + 组织内 UID 规则（前缀/位数）。
- 应用编辑弹窗加「开放给组织」多选（`ae-orgs` / `populateAppOrgs` / `saveAppOrgs`，`saveAppEdit` 成功后 PUT）；都不勾=全局。dev 有 mock。

⚠️ 测试：`scratchpad/org-test.js` node:sqlite 13 项全过（自动 org_uid=EMP0001/2、组内唯一占用检测、跨组织同 uid 不冲突、成员计数、我的组织、全局应用人人可见、受限应用仅成员可见、多组织开放）。
dev 浏览器实测：成员弹窗设规则+加两人（自动 EMP0001/EMP0002）、应用编辑「开放给组织」复选框渲染+勾选采集。

### 本阶段刻意未做（后续版本）

- **登录页「请选择所在组织」UX + 登录后组织切换器**：目前「用组织凭证登录」= 现有 login-methods 里选该组织的凭证（已可用）；应用市场已按「我所属组织的开放应用 + 全局」服务端过滤。显式的登录页组织选择器 / 顶栏当前组织切换留待下一版。
- **外部通讯录同步（SCIM / 自定义导入 API）**：IAM 第二阶段，需定接口协议；`org_members.source` 已预留 `import`。

## v3.4.17 防篡改审计存证链（档① 哈希链）（用户反馈）

三级版本。用户预期接财务/人事系统、外部审批、强实名、危险操作，需要可追溯、防篡改、可自证的审计。
选了**档①哈希链**（不上真区块链——DIY 上链对这套 SQLite/Zeabur 架构严重不划算，真要司法级再接第三方存证）。

### 机制（`server/audit.js`，新文件）

- 新表 `audit_chain(seq,id,event_type,subject,actor,detail,created_at,prev_hash,row_hash)`（db.js 迁移区块）。
- `row_hash = sha256(id\n event_type\n subject\n actor\n detail\n created_at\n prev_hash)`，首条 prev_hash = 64 个 0。
  每条含上一条的 row_hash → **只可追加**；改/删/插任意一条，从那条起全断链，`verifyChain()` 当场查出并指出 `broken_seq`。
- `audit(event_type, {subject, actor, detail})`：读链头→算 hash→插入，包在 `db.transaction` 里（better-sqlite3 同步，事务内无其它 JS 介入，不会分叉）。失败只告警不抛（存证不阻断主流程）。
- `created_at` 在 JS 端生成（`new Date().toISOString()`）以便入 hash，不用 SQLite 默认值。
- ⚠️ 只存**摘要**，绝不写身份证号/密钥原文；姓名一律脱敏后才入 detail。

### 埋点（curated 敏感/危险操作）

- `finalizeKyc`（api.js，所有 KYC 完成点唯一出口）→ `kyc.verified` / `kyc.reverified`（含 provider + id_tail）。
- 清除实名：`/user/kyc`、`/admin/users/:id/kyc`、`/v1/users/:uid/realname` → `kyc.realname_deleted`。
- `/v1/users/:uid/kyc/session` → `kyc.session_started` / `kyc.reverify_requested`。
- `/v1/users/:uid/points`（财务）→ `points.adjusted`（delta + balance_after）。
- `/v1/users/:uid/disable|enable` → `user.disabled` / `user.enabled`。
- `provider.js` 的 `/oauth/consent` 批准 → `oidc.authorized`（app + scope + new_grant）。
- actor 由 `actorOf(req)` 推断：`apikey:<id>` / `admin:<uid>` / `user:<uid>` / `source:<self|admin|api>` / `system`。

### 接口 + 前端

- 新 scope `audit:read`（dashboard ALL_SCOPES + API-docs 同步）。
- 开放 API：`GET /v1/audit/verify`（校验整链）、`GET /v1/users/:uid/audit`（某用户存证，按 uid_seq）。都有 sandbox 桩。
- 管理端：`GET /admin/audit`（列表 + integrity）、`GET /admin/audit/verify`（读 Lv.3）。
- `dashboard.html` 新增「审计存证」菜单页（`ni-adm-audit`/`page-adm-audit`/`loadAuditChain`）：完整性横幅 + 事件表（中文事件名映射 `AUDIT_EVENT_LABEL`）；dev 有 mock。
- 开放 API 计数 32→34。

### 后续（未做，用户没要求）

档②可信时间戳/外部锚定——把 `verifyChain().head` 定期打 RFC 3161 时间戳即可「对第三方举证某时刻已存在」，不改本表结构；有真实合规举证需求再加。档③真上链只在硬合规要求下接第三方存证服务。

⚠️ 测试：`scratchpad/audit-chain-test.js` node:sqlite 8 项全过（链完好、prev_hash 链接、篡改内容被查出、删中间行断链被查出、复原恢复、空链）。
dev 浏览器实测「审计存证」页：完整性横幅「✓ 存证链完整（共 3 条，未被篡改）」+ 事件表中文渲染。
⚠️ `db.transaction` 是 better-sqlite3 API（生产用）；本地 node:sqlite 测试里手动 shim 了它。

## v3.4.16.1 交接遗留项核查 + init.js ENV_KEYS 补齐（用户反馈）

四级补丁。逐条核实「交接核查」三个挂了很久的遗留项，两个其实早已解决、一个补完：

- 🔴 **init.js 硬编码超管密码 → 已修复**（更早某次已改，本次核实）：现读 `INIT_ADMIN_EMAIL/NAME/PASSWORD` 环境变量，未配密码则随机生成只打印一次。⚠️ 代码修好不撤销历史泄露，线上超管密码若仍是旧硬编码串务必去改。
- 🟡 **store.js 死代码 → 已删除**（文件已不存在，全项目无 require）。
- 🟡 **init.js ENV_KEYS 补齐**：补了 GitHub / Microsoft / QQ 三家 OAuth 的 `*_CLIENT_ID/SECRET`（+`MICROSOFT_TENANT`）——这三家之前漏在预置列表外。Didit/支付宝/OIDC/UID/2FA 早已在列；Zeabur Email 已废弃、FOOTER_* 动态扫描无需预置。
- 「交接核查」1/2/6 三条已在 CLAUDE.md 标记 ✅ 并写明现状。

## v3.4.16 实名认证开放 API（强实名 / 会话 / 二次·多次实名 / 直提核验）（用户反馈）

三级版本。用户要「部分应用强实名、二次/多次实名、程序化调用实名」的开放 API。四项全上，复用现有 5 服务商 KYC。

- 新增 scope：`kyc:read` / `kyc:session` / `kyc:verify`（`dashboard.html` ALL_SCOPES + `API-docs.md` 2.2/6.6.2/速查表同步）。
- 新表 `kyc_events`（每次认证落一条 verified/reverified，含 source self/admin/api）+ `kyc_pending` 加 `reverify`/`source` 列。
- `finalizeKyc` 扩参 `{reverify,source}`：写 `kyc_verified_at` + 记一条事件。**三个完成点**（Didit/Stripe webhook、支付宝 callback）
  的守卫从 `!user.kyc_verified` 改为 `kycShouldFinalize(user,pend)` = 未实名 **或** 有 reverify pending 标记——
  这样二次/多次实名即便已实名也放行并记事件；无 reverify 时行为与旧版一致（首认证仍走 `!kyc_verified`）。
- 新接口（`api.js`，都排除公共账号 `findRealUserByUid`，都有 sandbox 桩）：
  - `GET /v1/users/:uid/kyc`（kyc:read）状态：`{uid,verified,name_masked,id_tail,provider,verified_at,events}`——供「强实名门禁」。
  - `GET /v1/users/:uid/kyc/events`（kyc:read）历史（二次/多次审计）。
  - `POST /v1/users/:uid/kyc/session`（kyc:session）发起会话返回跳转 URL；`reverify:true` 对已实名用户放行、打 pending 标记（alipay 存证件哈希；其余存纯 reverify 标记）。
  - `POST /v1/users/:uid/kyc/verify`（kyc:verify）服务端直提两要素（阿里云/火山直认证型）；已实名再调记 `reverified`。
- ⚠️ 测试：`scratchpad/kyc-events-test.js` node:sqlite 12 项全过（首认证记 verified、已实名无 pending 不放行、reverify pending 放行且记 reverified、事件计数、状态视图）。
  完整 webhook/服务商链路无法本地端到端（无 express/真实服务商），守卫改动是纯逻辑、已单测覆盖。

## v3.4.15.2 多主体写进 API 文档（用户反馈）

四级补丁，纯文档。v3.4.14/15 的多主体功能一直没进 `API-docs.md`。补上 7.13 节：
主体/凭证两级模型、同人识别合并语义、管理端 `oauth-subjects` / `oauth-providers` CRUD（读 Lv.3 写 Lv.2、secret 打码规矩、主体停用门）、
公开 `GET /api/public/login-methods` 与授权入口 `/auth/<平台>?inst=<凭证id>`。API-docs 版本头同步到 v3.4.15.2。

## v3.4.15.1 多主体收尾校验：补主体停用门（用户反馈）

四级补丁。对 v3.4.14/15 多主体做一致性审查，代码基本一致（13 个处理器都已把 `process.env.X`→`c.X`、
无残留 `provider:'平台名'` 字面量、绑定层用 composite provider、账号绑定页正确处理 composite）。
发现并修掉一个真实漏洞：

- 🔴 **主体停用可被绕过**：`getCred` 只校验了「凭证」的 enabled，没校验「所属主体」的 enabled。
  登录页（`login-methods` 的 SQL 已 JOIN 主体 enabled）会隐藏停用主体的凭证，但直接打
  `/auth/<平台>?inst=<凭证id>` 仍能授权。已在 `getCred` 里补：凭证所属主体停用 → 返回 null，登录入口整体关闭。
- ⚠️ 测试：`scratchpad/getcred-gate-test.js` 4 项全过（主体启用+凭证启用拿到、主体停用返回 null、凭证自身停用 null、默认凭证不受影响）。

## v3.4.15 多主体重构：主体=组织，可挂多套凭证 + 同人合并（用户反馈）

三级版本。承接 v3.4.14 但**重构了模型**。用户指出：各主体理论上是单独的数据，但应用互通时应能配置到一起
——「一个公司一套凭证；一个集团有好几个公司也可以是一个主体」。于是把「主体」和「登录凭证」解耦：

### 模型（两级）

- **主体（`oauth_subjects`）= 组织**。一个主体下可挂**多套登录凭证**（`oauth_providers.subject_id`）。
- 凭证仍是 v3.4.14 那套（platform + config JSON + provider key `平台名:凭证id`），**绑定层完全没变**。
- **同人识别合并（用户点名要的「互通」语义）**：同一主体下不同凭证登录进来的用户，`findOrCreate` 里按
  **unionid → 邮箱** 在【该主体所有凭证范围内】找同一自然人，命中就绑到同一账号；**跨主体绝不合并**（数据隔离）。
  - env 默认凭证（无 subject_id）保持原有**全局邮箱合并**（单租户老行为，零变化）。
  - `subjectOfProviderKey(providerKey)` 从凭证反查 subject_id；`credentialKeysOfSubject` 给出合并查找范围。
- **迁移**：v3.4.14 的每条 `oauth_providers` 各自独立——给无 subject 的凭证各建一个「同 id 主体」，
  即每套凭证=一个单凭证主体，**保持 v3.4.14 的互不合并现状**，零行为变化。

### 接口 / 前端

- 管理端改为**主体优先**：`GET/POST/PATCH/DELETE /admin/oauth-subjects`（主体 CRUD，删主体连带删其下凭证）；
  凭证 `POST /admin/oauth-providers` 现要求 `subject_id`，`PATCH` 支持把凭证挪到别的主体。
- `dashboard.html` 的「登录主体」页变**两级**：主体卡片（🏢 名称 + 启停 + 编辑/删除 + 添加凭证）内嵌其凭证行。
  `loadOauthSubjects` + `subject-modal`（主体）+ `oauth-modal`（凭证，带 `oc-subject` 隐藏字段）。
- 登录页 / 账号绑定页**不用改**：仍按凭证列 `login-methods`（`enabledByPlatform` 加了 JOIN 主体 enabled，主体停用则其凭证不出现）。

⚠️ 测试：`scratchpad/subject-merge-test.js` 用 node:sqlite 跑 9 项全过（迁移建同 id 主体、同主体 unionid 合并、
跨主体同 unionid 不合并、同凭证同 openid 幂等、同主体邮箱合并、env 默认全局邮箱合并、用户总数）。
dev 浏览器实测两级 UI：主体列表+新建主体「B集团」+ 往主体里加企业微信凭证、示例集团含 A公司微信。
⚠️ 完整 OAuth 链路仍未端到端跑（无 express/真实服务商），findOrCreate 合并逻辑靠上面的 DB 测试覆盖。

## v3.4.14 三方登录「多主体」（多组织 / 多架构）（用户反馈）

三级版本。用户指出「一个渠道只能配一套凭证」——比如微信有两个主体，却只能走一个微信登录，
对多组织多架构不友好。现在每个渠道可挂**任意多个登录主体**。

### 设计（低风险、零迁移）

- **环境变量配的那套 = 各渠道的「默认主体」**（`provider=平台名`，如 `wechat`），行为完全不变，存量用户零迁移。
- 新表 `oauth_providers(id,platform,label,config,enabled,sort_weight)` 存**额外主体**，
  `config` 是该主体凭证 JSON（键名与该平台环境变量同名，含 secret）。
- **实例 id 编进 provider**：额外主体的 `user_oauth.provider = 平台名:实例id`（如 `wechat:uuid`）。
  这样 `UNIQUE(provider, open_id)` 天然按主体隔离——同一 openid 在 3 个主体下互不冲突，**无需改 user_oauth 表结构**。

### 实例凭证如何流过 OAuth 一圈（关键技巧）

- `server/oauth-meta.js`（**新文件**，oauth.js + api.js 共用防漂移）：每个平台的字段清单 / primary / secret / 扫码公开字段 / 中文名。
- `oauth.js` 的 `getCred(platform, instId)`：instId 有值读 `oauth_providers` 表，否则读 `process.env`（默认主体）。
  返回对象属性名 = 环境变量名，所以 13 个处理器只把 `process.env.X` 换成 `c.X`。
- **实例 id 藏在服务端 `state` 里**：`saveState(state, c._providerKey)` 把 `wechat:uuid` 存进 oauth_states.provider 列；
  回调 `consumeState` 取回 → `credFromKey()` 还原凭证 + provider。**因此不用为每个实例新增路由**，
  授权入口统一 `/auth/<平台>?inst=<实例id>`（默认主体不带 inst）。
- 🐛 **顺带修**：github/microsoft/qq 的授权处理器原本 `genState()` 后**从不 saveState**，
  回调 `consumeState` 必然失败（这三家登录一直是坏的）。本次统一加了 saveState。

### 接口

- 公开：`GET /api/public/login-methods`（默认主体 + 各启用实例，只给公开字段；扫码渠道附 appid/redirect，**绝不含 secret**）。登录页 / 账号绑定页改用它。
- 管理端：`GET/POST/PATCH/DELETE /admin/oauth-providers`（读 Lv.3 / 写 Lv.2）。secret 字段读取时打码（`•`×8），
  提交时打码串一律不覆盖原值（与系统配置的 secret 处理同规矩）。

### 前端

- `login.html`：`renderPlatformList` 改由 `login-methods` 驱动，一主体一按钮（「微信 · A公司」）；
  `selectMethod(idx)` 扫码渠道用该主体的 appid/redirect 渲二维码，其余跳 `/auth/<平台>?inst=`。
  🐛 顺带修：`qr-expired` 是 `qr-frame` 的子节点，渲二维码 `frame.innerHTML=''` 会销毁它，二次切换即 null 崩溃——已给三处访问加 `?.`。
- `dashboard.html`：管理端新增「登录主体」菜单页（`ni-adm-oauth`/`page-adm-oauth`，`loadOauthProviders` + `oauth-modal` CRUD，
  平台下拉切换动态渲染字段）；账号绑定页 `loadAccountBindings` 改为 method 驱动，
  每个主体一行、可分别绑定/解绑（composite provider 用 `encodeURIComponent` 传给 `DELETE /user/oauth/:provider`），
  已绑但主体下线的显示为「（已下线主体）」仍可解绑。

⚠️ 测试：`scratchpad/oauth-multi-test.js` 用 node:sqlite + oauth-meta 跑 18 项全过
（默认读 env / 实例读 DB / providerKey 格式 / credFromKey 还原 / 停用·错平台·不存在返回 null /
同 openid 跨 3 主体共存不撞唯一约束 / login-methods 不含 secret）。
前端用 dev 浏览器实测：管理端列表+新增实例、登录页多主体按钮渲染 + 扫码用对应实例 appid（wxAAA）+ 飞书实例跳 `/auth/feishu?inst=inF`、
账号绑定页「微信·A公司 已绑定 解绑」。
⚠️ 完整 OAuth 链路（真实服务商 + express）未端到端跑（测试环境无 express），靠逻辑审查——
state 透传实例 id 是标准做法，处理器改动是纯机械的 `process.env.X`→`c.X`。

## v3.4.13.1 文档纠偏：README 与功能实际脱节（用户反馈）

四级补丁，纯文档。用户指出 README 里 KYC 轮询仍写「4 服务商」漏了支付宝（v3.4.7 就加了）。顺手把 README 里所有和现状脱节的地方补齐：
- KYC 轮询 4→5 服务商（补支付宝实人认证）；`server/` 结构里 kyc.js 说明同步
- Passkey 从「计划中」改为已实现（`@simplewebauthn/server`，v3.3.8）
- 用户端功能补：应用主动打开（IdP 发起式）、登录方式绑定细化（三方/改邮箱手机/2FA/Passkey）、公共账号
- 管理端功能补：分组标签、分组管理员、应用管理的 OIDC 接入凭据/发起地址/必传字段
- `server/` 结构补全 provider.js（OIDC 提供方）/twofa.js/passkey.js，public 补 authorize.html
- CLAUDE.md 顶部功能范围与目录结构里的「4/四服务商」同步改 5/五
- 开放 API 计数 27→28（含 v3.4.13 的 shop:write）

## v3.4.13 代兑换/开盲盒开放 API（用户反馈）

三级版本。承接 v3.4.9~11 的自主功能开放，补上之前刻意搁置的**写接口**：代用户兑换商品/开盲盒。

- 新增 scope `shop:write`（`dashboard.html` ALL_SCOPES + `API-docs.md` 2.2 速查表同步）
- **把 `/shop/exchange/:id` 的兑换逻辑抽成 `performExchange(user, goods)`**（`api.js`），
  返回 `{ ok:true, remain, ...result }` 或 `{ ok:false, status, error }`；原用户端路由改为薄封装调它，行为不变
- 新接口 `POST /v1/users/:uid/shop/exchange/:goods_id`（`requireApiKey('shop:write')`）：
  `findRealUserByUid` 排除公共账号 → 查商品 → `performExchange` → 同样的 `{ success, remain, type, coupon|reward, ... }`。有 sandbox 桩
- 覆盖三种形态（与用户端完全一致）：普通商品发券 / 盲盒即开（加权随机+当场结算积分或发券）/ 盲盒延迟（发待开券，奖励 JSON 存 `user_coupons.redirect_url`）
- ⚠️ 校验：积分不足/缺货 → 400，商品或用户不存在 → 404；扣积分+减库存+写记录+发券全在**一个事务**内
- ⚠️ 测试：`scratchpad/exch-test.js` 用 node:sqlite 建真表 + 复刻 performExchange 跑 17 项全过
  （普通兑换扣分/减库存/发券/记录、积分不足不落库、缺货、盲盒即开净额 500-50+30=480、延迟盲盒券含奖励 JSON、404）。
  HTTP 层同前——测试环境无 express 未端到端跑，但 performExchange 是纯函数、路由是薄封装，与既有 /v1 写接口同构

## v3.4.12.1 刷新后菜单不再回退（用户反馈）

四级补丁。之前刷新页面菜单栏总是重置——管理员回「用户管理」、用户回「首页」，不停留在当前页。
根因：`dashboard.html` 是单文件多 page，导航只是切 `.active` class，无任何持久化；boot 时管理员固定
`setMode('admin')`→`goto('adm-users')`、普通用户走 HTML 默认 home。

修法（纯前端，`dashboard.html`）：
- `goto(page)` 结尾 `localStorage.setItem('sso_last_page', page)` 记住当前菜单
- `setMode(mode, targetPage)` 加可选 `targetPage`（缺省仍是 home/adm-users），不破坏原调用
- 新增 `bootToLastPage()`：读 `sso_last_page`，**按当前身份校验可达性**再恢复，不可达则回退默认：
  - 管理页（`adm-*`）：非管理员丢弃；superadmin-only（`adm-levels`/`adm-env`）非超管丢弃
  - 用户页：未知页丢弃；`public` 需入口已授权（`ni-public` 可见）；公共账号会话丢弃 `shop`
  - 管理员上次停在用户页 → `setMode('user', 页)`；否则 `setMode('admin', 页||默认)`；普通/公共账号 → `setMode('user', 页||home)`
- `loadMe` 末尾 `setTimeout(bootToLastPage, 0)` 取代原来的 `setMode('admin')`
- ⚠️ 已用 dev 浏览器实测 5 类：管理员停留管理页/停留用户页、ops 停 superadmin-only 页回退 adm-users、
  普通用户带陈旧管理页记录回退 home、普通用户停留 shop——全部正确

## v3.4.12 邮箱/手机可改 + 三方账号绑定修复（用户反馈）

三级版本。修「已绑定的邮箱/手机/三方账号都改不了」。

### 修改邮箱 / 手机号（验证新地址所有权）

- 之前 `/user/profile` 只收 phone（还没验证）、完全不处理 email，前端 profile 表单又是 readonly → 无从修改
- 新接口（`api.js`，requireAuth+noPublic）：
  - `POST /user/contact/send-code` {type:email|phone, value}：校验格式/域名策略/占用/与当前不同 → 发码到**新地址**，OTP key `chg:<type>:<userId>:<value>`（绑定用户+新值，防串用）
  - `POST /user/contact/verify` {type,value,code}：验码（过期/次数/错误一套）→ 提交前再查占用 → 更新 users.email/phone
- 前端「登录方式绑定」页邮箱/手机行加「修改/绑定」按钮 → `openContactModal()` 弹窗填新值+验证码；dev 有 mock

### 三方账号绑定修复（`oauth.js`）

- 根因：`showBindModal` 跳 `/auth/<平台>?bind=1`，但回调的 `findOrCreate` 从不读「绑定意图」——
  于是「绑定」实际是按三方身份登录/建号，把你切到**另一个账号**
- 修法（不改 13 个回调）：
  - `AsyncLocalStorage` `reqCtx` 存每个 /auth 请求；`POST /auth/stash-bind`（requireAuth）把 `bindUserId` 存进 session（10 分钟有效）
  - `findOrCreate` 开头读 `reqCtx.getStore().session.bindUserId`：命中且未过期 → 把本次三方身份 `oauth.bind` 到该用户
    （三方身份已绑他人 → 冲突报错），设 `req._bind`，不走登录/建号
  - `loginSuccess` 见 `req._bind` → 不换登录态，跳 `/dashboard.html?bind=success|error`（清一次性标记）
  - 前端 `showBindModal` 先 `fetch('/auth/stash-bind')`（带 token，根路径不走 api()）再跳；dashboard 加载处理 `?bind=`
- ⚠️ 邮箱/手机改绑逻辑已直连 DB 验证（发码/占用/验码/一次性/attempts）+ dev 浏览器实测（改邮箱成功）；
  三方绑定的 OAuth 完整链路因无真实服务商 + 测试环境无 express 未端到端跑，靠逻辑审查（AsyncLocalStorage 透传是标准用法）

## v3.4.11.1 开放 API 速查表（文档）（用户反馈）

四级补丁，纯文档。`API-docs.md` 第六章开头加「6.0 接口速查表」——把全部 27 个 `/v1/*` 接口
（方法/路径/scope/说明）汇总成一张表，按分类（鉴权/用户/积分/签到/商城/兑换/组织/其它）排列；
`README.md` 的开放 API 段也从旧的 5 行更新为按 scope 分类的概览（并删掉了不存在的 `/v1/user/me`）。无代码改动。

## v3.4.11 开放 API：积分排行榜 + 用户兑换记录（用户反馈）

三级版本。两个安全只读接口，复用现有 scope。

- `GET /v1/points/leaderboard`（points:read）积分排行榜，默认前 20 最多 100，排除公共账号，带 rank
- `GET /v1/users/:uid/shop/records`（shop:read）某用户的商城兑换记录（shop_records，最近 100）
- ⚠️ 刻意**未做**「代用户兑换商品/开盲盒」写接口——`/shop/exchange/:id` 那段（扣积分+库存+盲盒加权随机+发券+feature_quota）约 100 行强耦合，
  安全复用需完整 HTTP 集成测试，而本地测试环境 express 被反复 prune 跑不了，风险高于价值。要做的话得先把它抽成 `performExchange()` 并配 HTTP 测试

## v3.4.10 自主功能开放 API 续：签到 / 等级分组 / 盲盒（用户反馈）

三级版本。承接 v3.4.9，把剩下的自主功能也开成 `/v1/*`。**未加新 scope**，复用 points/users/shop。

- 把 `/user/checkin/v2` 的签到逻辑抽成 `performCheckin(user)`（+ `_checkinIsSamePeriod`），原路由改为调它；开放 API 复用同一逻辑（周期/随机区间/连签一致）
- 新接口（`api.js`，`:uid` 都走 `findRealUserByUid` 排除公共账号，都有 sandbox 桩）：
  - `GET /v1/users/:uid/checkin`（points:read）查签到状态；`POST /v1/users/:uid/checkin`（points:write）代签到发积分
  - `GET /v1/levels`（users:read）等级目录带 level_tag；`GET /v1/groups`、`GET /v1/tags`（users:read）分组/标签目录
  - `GET /v1/users/:uid/org`（users:read）某用户的分组+标签（仅名称/颜色，不给内部权限）
  - `GET /v1/shop/blind-boxes`（shop:read）盲盒目录 + 各奖励项 label/weight（开盒仍走用户端）
- ⚠️ 直连 DB 验证了 levels(A1/U3)/groups/org/blindbox 读取；签到逻辑抽取后原用户端路由行为不变

## v3.4.9 自主功能开放 API：积分 / 商城（用户反馈）

三级版本。把 SSO 自建的积分、商城能力开成标准 `/v1/*` 接口，供第三方程序化对接。

- 新增 scope：`points:read` / `points:write` / `shop:read`（`dashboard.html` ALL_SCOPES + API-docs 2.2 同步）
- 新接口（`api.js`，都排除公共账号 `is_public=0`，都有 sandbox 桩）：
  - `GET /v1/users/:uid/points` 查余额
  - `GET /v1/users/:uid/points/logs` 查明细（最近 50）
  - `POST /v1/users/:uid/points` {delta,reason} 调整积分（非零整数；扣减不能使余额<0，否则 400；事务写 users.points + points_log）
  - `GET /v1/shop/goods` 在售商品目录
  - `GET /v1/users/:uid/coupons` 用户兑换券
- `findRealUserByUid`（uid_seq/id/uid_code + is_public=0）复用于这些 :uid 接口
- ⚠️ 已用直连 DB 验证积分增减/余额不足拦截/明细/公共账号排除；HTTP 层因测试环境无 express 未跑，逻辑与既有 /v1 一致

## v3.4.8.2 /v1/users 筛选下沉进 SQL（修分页筛选 bug）（用户反馈）

四级补丁。承接 v3.4.8.1 审计遗留：`GET /v1/users` 的 `level_tag` 此前是**分页后**对当前页 JS 过滤，
跨页会漏（第 2 页可能返回 0 条），且 `total` 用 `countAll` 不含任何筛选。

修法（`api.js`）：改为动态 `WHERE`（`is_public=0` + 可选 `status` + `level_tag` 拆成 role/level 条件）下沉到 SQL，
`total` 也按同一 WHERE 计数——分页结果跨页一致、total = 符合筛选的总数（可据此算页数）。`level_tag` 格式非法返回 400。
已用直连 DB 验证：U3 共 15 条，page1=10、page2=5 全为 U3，无公共账号/管理员/其他等级混入，A1 total=1。

## v3.4.8.1 开放 API 排除公共账号（OIDC/开放 API 审计发现）（用户反馈）

四级补丁。审计开放 API 时发现 v3.4.2 引入公共账号（`is_public=1` 的 users 行）后遗留的正确性 bug：
`GET /v1/users`（列表）和 `GET /v1/users/:uid` 用裸 `SELECT * FROM users` 查询，**没排除公共账号**，
会把共享身份当成自然人泄露给开放 API 消费方（如 HR 同步）；而 `total` 走 `countAll`（已排除 is_public），
导致 count 与 data 语义不一致。

修法（`api.js`）：`/v1/users`、`/v1/users/:uid`、`/v1/kyc/match` 的用户查询都加 `is_public=0`（列表加 `ORDER BY uid_seq`）。
已用直连 DB 测试验证：列表含真人不含公共账号、按 uid 查公共账号返回 null、countAll 与列表一致。

⚠️ 已知遗留（未在本补丁修）：`/v1/users?level_tag=` 的等级筛选是在分页后对当前页过滤，跨页结果不准——
是 pre-existing 设计限制，文档有标注该参数；HR 侧对账走全量/后续 updated_since，不依赖它。

## v3.4.8 HR 集成三条（S-03 CIDR / S-08 KYC 假名 / S-02 姓名比对）（用户反馈）

三级版本。按 `hr-xubai/docs/05-SSO侧改动请求.md` 批的三条 P1（S-03/S-08/S-02），其余 S-01/04/05/06/07 未做。

### S-03 · 可信 IP 支持 CIDR（`auth.js`）

- `ipMatches(clientIp, entry)` / `ipAllowed`：支持精确 IP、CIDR 网段（IPv4）、`*` 通配；`requireApiKey` 两处校验改用它
- 弹性容器出口漂移的接入方填云厂商出口网段即可，不用逐个 IP 维护。`0.0.0.0/0` = 放行全部
- 导出 `ipMatches`/`ipAllowed` 供测试

### S-08 · KYC 假名化标识（去重）

- `users` 加 `kyc_pseudonym` + `kyc_name_hash`（只存 HMAC，绝不存原文）
- `kyc.js` 加 `identityHashes(name,idNo)`→`{pseudonym,nameHash}`，`kycHmac`/`normName`/`normId`；密钥 `KYC_PSEUDONYM_SECRET`
  - `pseudonym = HMAC(secret,'pid:IDENTITY_CARD|'+归一化证件号)`——同人跨账号恒定、不可逆、不含原文；**换密钥历史失效**
- 各 KYC 完成点统一走 `finalizeKyc()`（api.js）写入假名/姓名哈希：直接认证、支付宝回调（发起时算好存 kyc_pending）、Didit/Stripe webhook
- OIDC `kyc` scope 增加 `kyc_pseudonym` claim（`provider.js` claimsFor + 发现端点 claims_supported）

### S-02 · 实名姓名比对开放 API

- `POST /api/v1/kyc/match`（scope `users:kyc`）{uid,name,id_no?} → `{matched:bool}`，只回布尔、比对哈希不比明文；未配密钥 503
- `DELETE /v1/users/:uid/realname` 同步清 `kyc_pseudonym`/`kyc_name_hash`

⚠️ 测试：`sso-changes-test` 21/21（CIDR 匹配、假名恒定/归一化/换密钥失效、姓名比对哈希相等）。
本地 `node_modules` 的 shim（axios/better-sqlite3/jsonwebtoken → 见 scratchpad）会被环境反复 prune，跑测试前需在同一条命令里重建；生产 Zeabur 用官方包不受影响。

## v3.4.7.1 窄屏侧边栏抽屉（主布局响应式）（用户反馈）

四级补丁。v3.4.6.2 只修了弹窗；主布局（`.app` = 固定 220px 侧边栏 + `flex:1` 内容 + `overflow:hidden`）
在窄屏下内容被**压缩**而不是侧边栏收起。

修法（`dashboard.html`）：
- topbar 加汉堡按钮 `#nav-toggle`（`.nav-toggle` 默认隐藏，≤900px 才显示）+ 遮罩 `#nav-backdrop`
- `@media(max-width:900px)`：`.nav` 变 `position:fixed` 抽屉，默认 `.app:not(.nav-open) .nav{transform:translateX(-105%)}` 收起；
  内容占满宽度（不再压缩）、`.settings-grid` 单列、`.content table{display:block;overflow-x:auto}` 宽表可横滚
- **开态用内联 transform 驱动**（`_applyNav()` 设 `nav.style.transform='translateX(0)'`）——
  ⚠️ 纯 CSS `.app.nav-open .nav{transform:translateX(0)!important}` 在无头/不合成帧的测试浏览器里被过渡卡住，
  内联最稳。`toggleNav`/`closeNav`/`goto`（点菜单收起）/`resize`（回桌面清内联）配套
- ⚠️ 测试环境的浏览器面板不合成帧 → CSS `transition` 不推进，会看到 transform 卡在起点；
  去掉 transition 看落点即正确（closed=-273 屏外 / open=0 屏内）。真实浏览器正常滑入

## v3.4.7 KYC 接入支付宝实人认证（用户反馈）

三级版本。新增第 5 个 KYC 服务商：支付宝实人认证（人脸核身），同样走环境变量配置。

### 实现（`server/kyc.js`）

- 支付宝开放平台 `alipay.user.certify.open.*` 三步：initialize 拿 certify_id → 跳 certify 页人脸核身 → query 查结果
- **RSA2 签名**（SHA256withRSA，应用私钥签，支付宝公钥验响应）：`alipaySign`/`alipayVerify`/`alipaySignContent`（字典序 k=v& 排除 sign/空值）/`toPem`（把裸 base64 补成 PEM，管理员常直接粘裸串）
- `createAlipaySession(userId,name,idNumber,returnUrl)` → 需要姓名+身份证号；`queryAlipayCertify(certifyId)` → passed
- 归入**会话跳转型**（`createKycSession`），仅当 `ALIPAY_APP_ID && ALIPAY_PRIVATE_KEY && name && idNumber` 才 available

### 数据流（`server/api.js`）

- `/user/kyc/session` 现接收可选 `{name,id_number}`，传给 createKycSession；provider==='alipay' 时把 certify_id + 姓名 + 证件尾号存进新表 `kyc_pending(user_id PK,...)`
- `/auth/kyc/callback` 支付宝回跳时**不带结果**，用存的 certify_id 调 `queryAlipayCertify` 查询→通过则脱敏落库 → 清 pending
- 🐛 **顺手修**：`recordCall` 在 api.js 的 webhook 里被用但从没导入（一直被 try/catch 静默吞）。已加进 `require('./poller')`

### 前端 & 配置

- `startKyc()`：先试无需填信息的 Didit/Stripe；否则弹 `openKycInfoModal()` 收集姓名+身份证号 → `submitKycInfo()` 先试会话型（支付宝跳转）再降级直接型（阿里云/火山）
- 「系统配置 → 实名认证」加 `kyc_alipay` 配置组：`ALIPAY_APP_ID`/`ALIPAY_PRIVATE_KEY`/`ALIPAY_PUBLIC_KEY`/`ALIPAY_KYC_BIZ_CODE`/`ALIPAY_GATEWAY`；`init.js` ENV_KEYS 同步
- ⚠️ RSA2 签名机制已用本地 mock 网关端到端验证（alipay-kyc-test 10/10：网关用应用公钥验请求签名通过、响应用支付宝公钥验签通过）

⚠️ 本地测试环境的 `node_modules` shim（better-sqlite3→node:sqlite、axios 最小实现）会被 npm 操作 prune 掉，需要跑测试时按 scratchpad 里的方式重建；生产 Zeabur 用官方包不受影响。

## v3.4.6.2 弹窗窄屏截断修复（用户反馈）

四级补丁。`dashboard.html` 里 `.modal` 弹窗（编辑应用等）在窄屏/内容过高时被截断且无法滑动，只能靠缩放。
根因：`.modal-mask` 用 `align-items/justify-content:center` 居中但不滚动 + `.modal` 无 `max-height`，
且各弹窗内联 `min-width:5xx` 在窄屏下压过 `max-width:90vw`（min-width 优先）→ 横向溢出。

修法（改 `.modal-mask` / `.modal` 基础 CSS，一处修全部弹窗）：
- `.modal-mask{overflow-y:auto;padding:24px 14px}`（遮罩自身可滚，内容再高也能滑到）
- `.modal{max-width:min(92vw,720px);margin:auto;box-sizing:border-box}`（`margin:auto` 在可滚动 flex 容器里居中且不裁顶，短弹窗仍居中）
- `@media(max-width:760px){.modal{min-width:0!important;width:calc(100vw-28px)!important;max-width:calc(100vw-28px)!important} .modal .settings-grid{grid-template-columns:1fr!important}}`
  （窄屏强制压掉内联 min-width，表单栅格单列）

已在 375px 实测：编辑应用弹窗横向不溢出、纵向可滑到「保存」按钮；桌面短弹窗仍居中。

## v3.4.6.1 登录成功页不再显示 JWT（用户反馈）

四级补丁。`login-success.html` 原来把完整 JWT token 明文展示在页面上 + 「复制 Token」按钮 + 「API 使用示例」块——
录屏/旁人一眼就能拿到 token，有泄露风险。现在**移除了 token 展示框、复制按钮、API 示例块、以及无用的 testApi/copyToken 死代码和对应 CSS**。
token 仍照常存进 `localStorage.sso_token`（会话需要），只是不再显示在屏幕上。页面保留：欢迎语、用户名/有效期（从 JWT payload 本地解析）、验证状态、倒计时跳转。

## v3.4.6 三方登录品牌 Logo（用户反馈）

三级版本。把三方登录平台的图标从「emoji / 文字占位」换成品牌全彩 SVG。

- 新增 `public/brand-icons.js`，导出 `window.BRAND_ICONS`（key→`<svg>` 字符串），**login.html 与 dashboard.html 共用这一份**，避免两处图标漂移。两页都 `<script src="/brand-icons.js">` 引入
- `login.html`：`renderPlatformList()` 与 QR 品牌标签优先用 `BRAND_ICONS[key]`，图标底片改白色（`background:#fff;border`），回退旧内联图标
- `dashboard.html`：`loadAccountBindings()` 的平台图标改用 `BRAND_ICONS[key]` + 白色底片
- 图标为**可辨识的品牌重绘版**（非官方原矢量——沙盒浏览器 CSP 拉不到官方文件）。Google/Microsoft/Apple/GitHub 用的是标准官方标准标记；微信/抖音/QQ 较准；企业微信/飞书/钉钉是干净的品牌色重绘。
  ⚠️ 若要换成**完全一致的官方 SVG**：把 `.svg` 丢进项目、或把 `<svg>` 源码贴来，替换 `brand-icons.js` 对应 key 即可，样式（白色圆角底片）不用动

## v3.4.5 公共账号整会话切换 + 分组管理员 + 一批限权（用户反馈）

三级版本。围绕公共账号的一批改动：

### 公共账号改成「整会话切换」（不再另开标签）

- 切换 = **替换当前会话**：`switchToPublic` 把本人令牌暂存到 `localStorage.sso_parent_token`、本人时区存 `sso_pub_tz`，
  `sso_token` 换成公共账号令牌后刷新——本人登录态随之消失。`returnToSelf` 用暂存的令牌还原。
- `_IS_PUBLIC_SESSION = !!localStorage.sso_parent_token`；`getToken()` 只读 localStorage（**移除了 v3.4.2 的
  sessionStorage/`?pub=` 新标签机制**）。公共会话 401 / 退出 → `returnToSelf`（还原本人，不清 localStorage）
- 两个切换入口都保留：账号设定页卡片 + 独立「公共账号」菜单页（`ni-public`/`page-public`）+ 左下角用户菜单
  （公共会话时该菜单显示「↩ 返回我的账号」）

### 公共账号限权（以 `ME.is_public` 为准，比 session 标记更可靠）

- `loadMe` 里 `isPublic` → 隐藏：积分商城/签到/积分卡/管理端/**实名 KYC 卡片**/**登录方式绑定 tab**/切换到其他公共账号的卡片
- **名称不可自改**：`_PUBLIC_ACCT` 置位后 `loadProfile` 把用户名输入设 readonly（名称由管理员创建时定死）
- **时区跟随使用人**：`userTz()` 公共会话时读 `sso_pub_tz`（切换那一刻本人的生效时区），兜底设备时区
- 后端硬限制（`noPublic` 中间件）：`/user/profile`、`/user/kyc/session|direct`、`/user/kyc`(DELETE)、
  `/user/2fa/*`、`/user/oauth/:provider`(DELETE) 全部挡住；`passkey.js` 的 register-options/verify 加 `blockPublic`
  （公共账号不允许自设登录方式/2FA/Passkey——「隐藏入口 + 后端兜底」）

### 分组管理员（与系统管理员并存）

- 新表 `group_admins(group_id, user_id)`；`groupStmts` 加 admins/isAdmin/addAdmin/clearAdmins/managedBy/membersOf
- 系统管理员在「分组标签」页每个分组行 →「分组管理员」按钮（`openGroupAdmins`）指定（只收组内成员）
- 公共账号管理接口从 `requireAdmin` 改为 `requireAuth + canManageGroup`（系统管理员 或 该分组的分组管理员）：
  `canManageGroup(req, gid, write)` = `isSysAdmin` 或 `groups.isAdmin`
- 分组管理员在**用户端**「公共账号」页看到「我管理的分组」区块（`loadManagedGroups`，仅非系统管理员显示），
  点「管理公共账号」→ 复用 `openPubAccounts`。成员列表来源改为 `GET /account/managed-groups`
  （系统管理员看全部分组、分组管理员看自己管的，都带成员），不再用系统管理员专属的 `/admin/users`
- 删分组级联清 `group_admins` + 该分组下的公共账号

### 其他

- **通讯录查找部分匹配**：`/shop/find-user` 用户名从精确 `=` 改为 `LIKE %name%`（UID 仍精确，转账安全）；
  同时排除 is_public 账号

## v3.4.4 四项修复/增强（用户反馈）

三级版本。一批独立问题：

- **公共账号做成独立菜单**：用户端左侧新增「公共账号」菜单项（`ni-public` / `page-public`），被授权时才显示。
  `loadPublicSwitcher()` 现在同时点亮：用户菜单入口 + 账号设定页卡片 + 独立菜单/页面。原来只在账号设定页卡片里，
  用户嫌不好找。⚠️ 卡片不显示 = `availableFor` 返回空 = 该用户没被授权或不在分组内（不是 bug，是配置没到位）
- **OAuth2 与 OIDC 并存**（`provider.js`）：原来 `parseScope` 强制塞 `openid`、`/oauth/token` 永远发 id_token
  ——纯 OAuth2 客户端（不带 openid）会因返回了没申请的 openid/id_token 而报错。现在：
  - `parseScope` 不再强塞 openid（只在完全没传 scope 时默认给 openid）；`appRequired` 也不再强加 openid
  - `/oauth/token` **只有 scope 含 openid 才发 id_token**；否则纯 OAuth2，只发 access_token，userinfo 照常可用（恒返回 sub）
  - API 文档新增 10.0 说明两种模式
- **账号绑定页只显示已配置的三方平台**（`loadAccountBindings`）：调 `/api/public/configured-platforms?raw=1`
  （新增 `raw` 参数：不走「没配置就兜底显示微信+企业微信」那套），只渲染已配置或已绑定的平台，未配置的不再出现
- **签到 bug 修复**：
  - 连续天数永远不累加——`/user/checkin/v2` 存的是完整 ISO 时间戳，但连签判断拿它跟日期串 `yesterday` 比，
    永远不相等 → 每次都 resetStreak。改成取 `lastCheckin.toISOString().slice(0,10)` 日期部分再比
  - 周几显示写死（永远高亮周五）+ 签到弹窗积分写死 `+10`。前端 `renderCheckinWeek()` 按 `getDay()` 正确高亮今天、
    把最近 streak 天标记已签；弹窗 `ck-modal-pts` 显示后端返回的**实际随机积分**（不再写死）；
    `loadHome` 的「今日已签到」判断也改成解析日期部分

## v3.4.3 公共账号切换入口更显眼 + 跳转倒计时可配（用户反馈）

三级版本。两处小改：

- **公共账号切换入口**：原来只在左下角用户菜单里（`pub-switch-wrap`），用户嫌不好找。现在**账号设定页新增
  「公共账号」卡片**（`pub-acct-card`，`as-profile` 里，KYC 卡片下方），列出可切换的公共账号 +「切换使用 ↗」按钮。
  `loadPublicSwitcher()` 同时填用户菜单和这张卡片，被授权时才显示，两处都调 `switchToPublic()`
- **跳转倒计时可配**：已授权直通中转页的秒数改为可配。env `OIDC_LAUNCH_COUNTDOWN`（默认 3，夹 0~30，
  **0 = 不倒计时直接跳**）。`provider.js` 的 `launchCountdown()` 读取，`/oauth/consent-info` 返回 `countdown`，
  `authorize.html` 用 `d.countdown`。管理端「系统配置 → 系统与页脚」加了 `oidclogin` 配置组；`init.js` ENV_KEYS 补了这个键

## v3.4.2 分组公共账号（共享账号）（用户反馈）

三级版本。分组可挂「公共账号」——一个共享身份，供组内被授权成员切换使用，仅保留基础功能（第三方 SSO 登录），
禁商城/积分/转账。用途：多人共用一个身份去第三方系统登录。

### 数据模型（复用 users 表）

- 公共账号本身是一条 `users` 行：`is_public=1`、`owner_group_id`=所属分组（`group_id` 也设成该分组）。
  用 `users.create({ is_public:true, owner_group_id, group_id })` 建（`_insertUser`/`createUser` 已加这几列）
- `public_account_members(public_id, user_id)`：哪些真实用户被授权使用某公共账号
- **可用判定**：`publicAccounts.availableFor` = 被授权 **且** 该用户当前仍在公共账号所属分组内
  （离组即失效）；`db.js` 导出 `publicAccounts`

### 隔离（重要，别退回去）

- 公共账号**不进**普通用户列表 / 统计 / 分组人数：`userStmts.findAll/findByStatus/count*` 和
  `groupStmts.all` 的 user_count 全部加了 `is_public=0`；`/admin/users` 搜索 SQL 也加了 `is_public=0`
- 公共账号**不能自己登录**：`resolveUser`（api.js）对邮箱/手机/UID/用户名解析结果一律排除 `is_public`
  （公共账号无凭据，只能被切换使用）
- **基础功能限制**：`noPublic` 中间件（api.js）挡住 `/user/checkin(/v2)`、`/shop/exchange`、`/shop/redeem`、
  `/shop/transfer`、`/user/coupons/:code/transfer`。前端公共会话隐藏「积分商城」菜单 + 首页签到/积分卡 + 管理端入口

### 切换会话（不覆盖本人登录）

- `POST /api/account/public/switch {public_id}`（api.js，`requireAuth`）：校验 `isMember` + 仍在分组内 →
  签发公共账号 JWT（含 `pub:true` / `switchedFrom` / `switchedName`）。`GET /api/account/public/available` 列可切换的
- 前端：用户菜单里列出可切换的公共账号 → `switchToPublic()` 用 `window.open('/dashboard.html?pub=<token>')` **另开标签**
- **会话隔离机制**：公共账号令牌存**本标签的 sessionStorage**（`?pub=` 进来时写入 + 抹掉 URL 参数），
  `getToken()` = sessionStorage 优先、否则 localStorage。于是原标签仍是本人（localStorage）、新标签是公共账号
  （sessionStorage），互不覆盖。顶部橙色提示条 + 「返回我的账号」（`returnToSelf` 只清 sessionStorage）
  - ⚠️ 公共会话里 401 / 退出**只清 sessionStorage，绝不动 localStorage**（否则会把本人也登出，localStorage 跨标签共享）
  - `jwtPayload()` 做了 UTF-8 安全解码（否则中文 name/switchedName 会乱码）

### 管理端

- 「分组标签」页每个分组行加「公共账号」按钮 → `openPubAccounts()` 弹窗：建号 / 列表 / 删号 / 指定成员
  （成员勾选列表 = 该分组内的真实用户，来自 `/admin/users` 前端按 `group.id` 过滤）
- 接口：`GET/POST /admin/groups/:gid/public-accounts`、`GET/DELETE /admin/public-accounts/:id`、
  `PUT /admin/public-accounts/:id/members`（读 `requireAdmin(3)`，写 `requireAdmin(2)`）。
  设成员时只收「在本分组内的真实用户」，删号连带清成员 + 吊销其令牌/授权

## v3.4.1 应用必传字段 + 登录过渡页（用户反馈）

三级版本。两块：应用可强制某些回调字段（避免应用端映射失败）、登录跳转加过渡页。

### 应用必传字段（`apps.required_scopes`）

第三方接入时用户能取消可选 scope，导致应用拿不到 email 等字段而映射/登录失败。现在每个应用可配「必传字段」。

- `db.js` 迁移 `ALTER TABLE apps ADD COLUMN required_scopes TEXT`，`appStmts.insert/update` 同步加列
- `api.js` 的 `POST/PATCH /admin/apps` 用 `safeRequiredScopes()` 校验（只放行合法 scope，剔除 openid，空格分隔）
- `provider.js`：
  - `appRequired(app)` = openid + 配置的必传；`missingRequired(user, req)` 只对 **email/phone** 判空
    （身份映射类字段，缺了会让应用映射失败；其余 scope 总能给值）
  - `consent-info`：展示 scope = 申请的 ∪ 必传，必传项标 `required:true`（前端渲染成勾选+禁用）；
    返回 `missingRequired` 数组；`alreadyGranted` 也要求必传已授权且不缺数据
  - `consent` POST：**强制并入必传 scope**（即使前端被绕过）；缺必传数据直接 `409` 拒绝并提示绑定
- 前端 `dashboard.html`：管理端新建/编辑应用表单加「必传字段」勾选框（`reqScopeBoxes`/`collectReqScopes`，
  前缀 `na-req-*` / `ae-req-*`）；`authorize.html` 必传项禁用勾选、缺失时显示「请先绑定」拦截页
- ⚠️ 决策：必传字段用户缺失时（如必传邮箱但没绑）**拦住引导去绑定**，不是塞 null——避免应用端映射失败

### 登录过渡页

- **未登录**：从 OIDC 授权流程跳到 `login.html`（带 `next`）时，顶部显示「您正在登录 xxx」横幅 + 应用图标。
  数据来自新公开接口 `GET /oauth/app-info?client_id=`（`provider.js`，**无需登录，只给名称/图标，绝不含用户数据**）。
  `login.html` 的 `showOidcBanner()` 从 `next` 里解析 client_id 去拉
- **已授权直通**：`authorize.html` 原本 `alreadyGranted` 时瞬间静默提交，现在改成「您正在登录 xxx，将在 N 秒后跳转」
  倒计时中转页（3 秒 + 「立即继续」按钮）
- **需要授权**：原有的授权确认页不变

## v3.4.0 应用主动打开（IdP 发起式）+ 完善 SSO 回调 + API 文档（用户反馈）

二级版本（用户点名要 3.4.0）。三块：应用启动、回调 claim 补全、文档。全部围绕 `provider.js`（OIDC 提供方）。

### 应用主动打开（用户在控制台点「打开」= IdP 发起式登录）

原来第三方接入只有「SP 发起式」（第三方跳来 `/oauth/authorize`）。现在用户可以从**用户端应用市场**主动点开应用。

- `apps` 新增 `launch_url`（发起地址，`db.js` 迁移区块 `ALTER TABLE apps ADD COLUMN launch_url`，
  `appStmts.insert/update` 同步加列；`api.js` 的 `POST/PATCH /admin/apps` 用 `safeLaunchUrl`（复用 `safeLink`）校验只放行 http(s)）
- 新接口 `POST /oauth/launch`（`provider.js`，`requireAuth`，前端带用户 JWT 调）：
  - 应用填了 `launch_url` → 返回 `{mode:'launch_url', url}`，前端 `window.open` 打开应用自己的入口，
    应用发起标准 OIDC，因**已登录+已授权**，`authorize.html` 走 `alreadyGranted` 免打扰直通
  - 没填 → SSO 用应用登记的 `callback_url`（取第一个）+ 用户已授权的 scope（无则 `openid profile`）
    拼一条 `/oauth/authorize` 链接返回 `{mode:'authorize', url}`，静默签码落到应用回调
- 前端：`dashboard.html` 应用市场卡片 → 已授权/有 launch_url 的应用显示「打开 ↗」按钮（`openApp()`）；
  「已授权应用」详情弹窗也加了「打开应用」；管理端新建/编辑应用表单加了「发起地址」输入
  （`na-launch`/`ae-launch`）。dev 模式 `_devApi` mock 了 `POST /oauth/launch`
- ⚠️ 回退式（没 launch_url）到达应用回调的授权码**没有 state 上下文**（不是应用发起的），
  接入方回调要能处理这种 IdP 发起式到达——已在 API 文档 10.6 写明
- 🐛 **v3.4.0.1 修**：`openApp()` 原本用 `api('POST','/oauth/launch')` 调用，但 `api()` 帮手会自动加
  `/api` 前缀（`fetch('/api'+path)`），而 `/oauth/launch` 挂在**根路径**（`provider.js` 在 index.js
  `app.use('/', providerRoutes)`），结果打到 `/api/oauth/launch` → 404 → 前端提示「无法打开该应用」。
  已改成直接 `fetch('/oauth/launch')` 手动带 token。**凡是 `/oauth/*`、`/auth/*` 这些根路径接口，
  前端都不能用 `api()` 帮手**，要么 `location.href` 要么裸 `fetch`。

### 完善 SSO 登录回调（id_token / userinfo 的 claim）

`provider.js` 的 `claimsFor()` 扩充，仍严守「没授权的字段一个都不出现」：

- `profile` 增补标准 claim：`preferred_username`（优先 uid_code）、`uid_code`、`updated_at`（秒级 Unix，
  新加 `unixOf()` 把 SQLite datetime 按 UTC 解析）
- 新增 `org` scope（分组/标签）：授权后返回 `group`（分组名，互斥，可 null）、`groups`（数组形式）、
  `tags`（标签名数组）。**只给名称，不下发内部 id / 权限等级**。`claimsFor` 用 `groups.get` / `tags.ofUser`
  （所以 provider.js 的 require 加了 `groups, tags`）
- `id_token` 增加 `auth_time`（换码时刻）
- 发现端点 `scopes_supported` 加 `org`，`claims_supported` 补全新字段
- `authorize.html` 的同意页 scope 展示由后端 `SCOPES` 驱动，`org` 自动出现；
  `dashboard.html` 的 `SCOPE_LABELS` 也加了 `org`（已授权应用详情的权限 chip 用）

### API 文档（`API-docs.md`）

版本头改 v3.4.0；OIDC 章节补：scope 表加 `org`、claim 字段说明表、应用启动小节（10.6）、
`id_token` 标准字段说明；通用登录章补多标识符登录 `/api/account/login`（3.6.1）和忘记密码（3.6.2）；
管理端应用管理补 `launch_url`/`status` 字段。

## v3.3.12 自定义 UID 规则 + 用户分组 / 标签（用户反馈）

两块新功能，都在 `db.js` 的「迁移」区块新增字段，`api.js` 新增接口，`dashboard.html` 加界面。

### 自定义 UID（`uid_code`）

**核心设计：不破坏原有 `uid_seq`**。`uid_seq`（自增整数）仍是内部主序号，一切不变；
新增 `users.uid_code`（TEXT，带唯一索引 `idx_users_uid_code ... WHERE uid_code IS NOT NULL`）
才是对外展示 / 登录用的可自定义编号。老用户 `uid_code` 为 NULL，前端 `uidOf(u)` 回退 `#`+补零、
后端 `resolveUser` 回退数字 `uid_seq` 登录，**完全向后兼容**。

- `db.js` 的 `genUidCode(seq)` 按环境变量生成：
  `UID_MODE`（`sequential` 默认 / `random`）、`UID_PREFIX`（前缀，可空）、`UID_LENGTH`（位数，默认 5，夹 1~24）。
  random 模式生成纯数字并**撞库重试**保证唯一；sequential 模式是 `前缀 + 补零(seq)`
- **所有建号入口统一走 `users.create({...})`**（`db.js` 集中封装：`nextUidSeq()` → `genUidCode` → 插入）。
  已迁移 8 处：短信验证自动建号、邮箱 verify-code、注册、管理员建号、dev mock、`oauth.js` 三方登录建号、
  `setup.js` / `init.js` 建管理员。**新增建号入口一律用 `users.create()`，不要手写 INSERT**，否则 `uid_code` 会缺失
- `resolveUser(identifier)` 在数字 `uid_seq` 之前先试 `findByUidCode`（带/不带 `#` 都认），
  所以自定义 UID 能直接用来登录
- 前端「系统配置 → 系统与页脚」多了 `uidrule` 配置组（UID_MODE/UID_PREFIX/UID_LENGTH）。
  ⚠️ 改规则只影响**新建**用户，存量 `uid_code` 不回填
- ⚠️ 登录日志等**快照行没有 uid_code**，仍用数字 `fmtUid`，别硬套 `uidOf`

### 用户分组（互斥）/ 标签（可叠加）

**和「等级（U/A）」是两个正交概念**：等级管权限，分组标签只是组织维度。用户明确要求"和等级不是一个概念"。

- 表：`user_groups(id,name,color,created_at)`、`user_tags(id,name,color,created_at)`、
  `user_tag_map(user_id,tag_id, PK)`；`users.group_id`（外键，互斥：一人一组）
- `db.js` 导出 `groups`（all 带 user_count / get / insert / update / remove / clearFromUsers / setUser）、
  `tags`（all / get / insert / update / remove / removeMap / ofUser / clearUser / addToUser）
- `api.js` 接口（读 `requireAdmin(3)`，写 `requireAdmin(2)`）：
  `GET/POST/PATCH/DELETE /admin/groups`、`/admin/tags`；
  `PUT /admin/users/:id/group {group_id}`（null 即移出分组）、`PUT /admin/users/:id/tags {tag_ids[]}`（全量覆盖，事务）。
  颜色用 `safeColor` 兜底（只放行 `#RGB`~`#RRGGBBAA`）
- **删除级联**：删分组 → `clearFromUsers` 把占用用户 `group_id` 置空；删标签 → `removeMap` 清 `user_tag_map`。
  所以分组标签可随时删，不会留孤儿引用（不像等级"有人占用禁止删"）
- `GET /admin/users` 列表和 `GET /admin/users/:id` 详情都回带 `group` / `tags`，
  前端用户列表卡片显示 `●分组名` + 标签，详情面板有分配 UI（分组下拉 + 标签 chip 多选 → 保存）
- 管理端新增「分组标签」菜单页（`page-adm-groups` / `loadGroupsTags`），左分组右标签双卡片 CRUD，
  独立弹窗 `gt-modal`（`openGtModal`/`saveGt`/`delGt`），8 个预设颜色

## v3.3.11 一批 UX 补齐（用户反馈）

- **忘记密码（v3.3.11 新增）**：登录页「忘记密码」原是死链，现在弹窗走公开接口
  `POST /api/public/forgot-password/send`（按 `resolveUser` 解析账号→给绑定的邮箱/手机发码，
  码存 `reset:<userId>`，**无论账号是否存在都返回同样文案**不泄露存在性）+
  `/reset`（校验码→`updatePassword`，新密码≥8 位，码一次性）
- **登录协议 / 公告都支持外部链接**：`site_documents` 和 `announcements` 各加 `link` 列
  （`safeLink` 只放行 http/https）。文档填了外链则登录页点击直接新标签打开、不弹富文本；
  公告填了外链则弹窗里出现「查看详情」按钮
- **公告内容改为富文本**：原来是纯文本转义显示，现在是 `contenteditable` 富文本（复用
  `rtExec`/`rtLink`/`rtImage`），保存时 `sanitizeHtml` 净化，弹窗按 HTML 渲染
- **用户端应用市场「管理」按钮**原来没绑事件（死按钮），现在 `openMyAppDetail()` 弹详情
  （权限明细 + 授权时间 + 撤销）

## 交互习惯（供后续沟通参考）

- 项目所有者主要用中文交流，代码注释、commit message、用户可见文案统一用简体中文
- 每次代码改动后期望：语法校验（`node --check`）→ 打包成 zip → 用 `present_files` 交付
- 每次改动后期望立刻收到可复制粘贴的 git 提交命令，格式基本固定：
  ```bash
  cd 项目目录
  rm -rf .git
  git init
  git add .
  git commit -m "描述"
  git remote add origin https://github.com/QWQ-Inc/qwq-sso.git
  git branch -M main
  git push -u origin main --force
  git tag vX.Y.Z
  git push origin vX.Y.Z
  ```
- **版本号规则（2026-07-20 用户明确，按此执行，不用每次再问）**：

  | 段位 | 谁来决定 |
  |---|---|
  | 一级 `X.0.0` | **只有用户本人能改**，绝不主动动 |
  | 二级 `3.X.0` | 可以提议，但要先问过用户 |
  | 三级 `3.3.X` | **每次改动都加**，不用问 |
  | 四级 `3.3.1.X` | 本次**只是打补丁修 bug** 时用第四段，而不是第三段 |

  版本号要同步到**四处**：`package.json` 的 `version`、`server/index.js` 里 `versionLink` 的
  `Powered by QWQ SSO vX.Y.Z`、`README.md` 标题 + 徽章、`CLAUDE.md` 开头的当前版本。
  改完打 tag 并 `git push origin vX.Y.Z`。历史上出过只打 tag 不改代码导致脱节（tag 到 v3.2.3 而代码停在 3.2.0）。

- ⚠️ **改文件一律用编辑器工具，不要用 PowerShell 的 `Get-Content`/`Set-Content` 做替换**：
  本机是 Windows PowerShell 5.1，`Get-Content` 默认按 ANSI 代码页读取，读 UTF-8 中文文件会得到乱码，
  再 `Set-Content -Encoding utf8` 写回就把整个文件毁了（README/CLAUDE.md/index.js 都是满篇中文，一改就炸）。
  2026-07-20 踩过一次，靠 `git checkout --` 才救回来。
