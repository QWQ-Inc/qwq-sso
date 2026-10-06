# CLAUDE.md — 项目交接文档

> 本文档面向接手此项目的 Claude Code（或任何后续开发者）。之前的开发全部在 Claude.ai 对话中完成，本文件把散落在多轮对话里的架构决策、命名约定、已知坑点系统性整理出来，避免重复踩坑或推翻已有设计。

---

## 项目是什么

**QWQ SSO** — 统一登录系统，当前版本 **v3.5.70.5**。

- 部署地址：`https://qwqsso.zeabur.app`（Zeabur 托管）
- GitHub：`https://github.com/QWQ-Inc/qwq-sso`（远端仓库已从 `uesrbai/qwq-sso` 迁移至此，v3.4.21.1）
- 版权方：QWQ INC.（美国特拉华州），中国共同开发者：海南省儋州市许白网络文化传媒有限公司
- 许可证：MIT License（版权行 `Copyright © 2026 QWQ INC.` 不可删除/修改，遵循协议见 README.md 底部）

功能范围（截至 v3.5.62，详见 `README.md` / `CHANGELOG.md`）：
- **登录**：13 个三方登录平台（多主体/多组织）、邮箱/手机验证码、账号密码（多标识符）、2FA(TOTP)、Passkey(WebAuthn)、忘记密码、应用内自动登录（企业微信/微信/飞书/钉钉内打开即用该平台凭证登录）；**登录到组织（IAM 用户）**：复用平台账号限定到某组织、组织自有密码、独立安全策略（org-scoped 不可切换）。
- **身份/组织（IAM）**：等级管理、分组/标签、分组管理员、组织（=登录主体）成员 + 组织内 UID + 组织管理员 + 组织文件夹、外部通讯录导入、**企业微信通讯录同步**（含一人多号合并；v3.5.47 起可放在组织文件夹上，文件夹里的组织套用、各选部门）、**飞书通讯录同步**（企业自建应用，v3.5.59；v3.5.60 起也可放在组织文件夹上）、公共账号、自定义 UID 规则、**组织专属凭证**（短信/邮件/实名按组织覆盖）、组织成员跨组织复用、不显性组织（组织码登录）。
- **应用接入**：开放 API（`/v1/*`，含测试密钥沙盒）、OIDC 提供方（`/oauth/*`，授权码 + PKCE + introspection + Back-Channel Logout）、应用按组织开放、IdP 发起式打开、主动撤销（deprovision webhook）、应用图片图标、个人应用文件夹。
- **自建能力**：积分商城（含盲盒）、签到、KYC 实名（5 服务商轮询 + 开放 API）、备忘录（附件/转交）、公告系统（可邮件群发）、系统通知（经消息分发推到 Webhook / 群机器人）、账号注销 / 删除（冷静期 + 保留期可恢复 + 交接项系统核验 + 三方账号摘除封存 + 审批 + 批量操作）、账号合并（可撤销；勾选合并 + 疑似重复账号批量识别）、防篡改审计存证链、身份核验（核验员扫码）、防截图水印（页面遮罩 + **导出图片/PDF 服务端烧录 + 追踪码反查**）、登录协议富文本、动态页脚、系统版本更新、数据备份（本地 / R2，可加密）、域名验证文件（根目录验证文件，到期自动删除）。
- **门禁 / 设备**：门禁（动态码/实体卡/人脸/访客码 + 扫码终端；门子码/禁入时段/访客陪同带入）、跨系统联邦（共享门禁 + 跨域应用登录）、Apple Wallet 访客码（阶段一，需证书）、**设备管理**（Apple/Google/Microsoft/门禁机/读卡器 登记台账）。
- **客户端**：iOS 原生 App（`ios/`，SwiftUI，多系统切换、门禁出码（含主屏幕快捷操作）、商城、备忘录、应用中心（图标/文件夹/组织切换/管理工具磁贴：门禁·设备·用户·身份核验）、账号设定等；GitHub Actions 云编译）。

---

## 技术栈与硬约束

- **后端**：Node.js + Express 4 + `better-sqlite3`（同步 SQLite，无 ORM）
- **前端**：原生 HTML/CSS/JS，**单文件、无构建工具、无框架**。`dashboard.html` 一个文件裸装了用户端+管理端全部页面和逻辑（现约 9000+ 行），`login.html`、`login-success.html`、`authorize.html`、`pass.html`、`access-terminal.html`、`setup.html` 各自独立
- **iOS App**：`ios/`，SwiftUI + XcodeGen（不手写 .pbxproj），GitHub Actions（macos-15）云端编译出未签名 .ipa。本机 Windows 无法本地 `xcodebuild`，Swift 改动靠人工审查 + CI 验证
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
├── notify.js     # 系统通知（v3.5.52）：重要事件经 QWQ Message 推到 Webhook / 群机器人；audit() 写完存证后调 fromAudit()
├── message.js    # 短信 + 邮件：统一调 QWQ Message 分发中心的单一接口
│                 #   （v3.3.3 起替代原 sms.js / email.js，两者已删除）
├── kyc.js        # KYC 五服务商（Didit/Stripe/阿里云/火山引擎/支付宝）+ 轮询
│                 #   v3.5.16 起用 envGetter 覆盖层支持「按组织配凭证」
├── twofa.js      # 2FA(TOTP, RFC6238) 自研实现 + 恢复码（v3.3.6）
├── passkey.js    # Passkey(WebAuthn/FIDO2)，用 @simplewebauthn/server（v3.3.8）
├── audit.js      # 防篡改审计存证链（哈希链 audit()/verifyChain()），api.js + provider.js 埋点调用
├── access.js     # 门禁（v3.5.0+）：动态码/卡/人脸/访客码/跨域码判定 + 签名校验
├── dirsync.js     # 通讯录同步驱动登记（v3.5.59）：driver(type) → 企业微信 / 飞书，api.js 里按同步源 type 调用
├── dirsync-feishu.js # 飞书通讯录同步（v3.5.59）：企业自建应用 tenant token → 部门 / 成员 → 匹配建号；事件订阅解密验签；成员暂停 / 删除
├── dirsync-wecom.js # 企业微信通讯录同步（v3.5.35）：拉所选部门成员 → 匹配/建号 → 组织成员 + 绑定 UserId + 默认组织密码（v3.5.37，单独改过的不覆盖）
├── backup.js     # 数据备份（v3.5.46）：snapshot/encrypt/decrypt/sigv4/writeTo/list/read，本地 + R2；也是解密命令行
├── account-lifecycle.js # 账号注销 / 删除（v3.5.44）：request/setChecklist/approve/cancel/reject/restore/purge/tick，交接预检 preflight
├── user-merge.js # 同一人多个账号合并（v3.5.41）：mergeUsers/checkMerge/isShellAccount，组织成员合并 + 自助绑定时并入空壳账号
├── org-policy.js # 组织登录策略判定（IP 白名单/登录时段，v3.5.24）：三方登录与「登录到组织」两条通道共用
├── updater.js    # 系统版本更新（v3.5.6）：checkUpdate 查 GitHub tag + applyUpdate 自托管一键拉取（默认关）
├── pkpass.js     # Apple Wallet 访客码 .pkpass 生成+签名（v3.5.10，passkit-generator 懒加载，需 Apple 证书）
├── watermark-burn.js # 导出文件加水印（v3.5.33）：sharp 渲染瓦片 → 图片平铺 / PDF 每页铺图 + 追踪码；字体解析链
├── memo-util.js  # 备忘录：附件类型白名单+magic bytes 校验、外链白名单、附件大小上限（纯函数，可单测）
├── poller.js     # 通用轮询选择器。⚠️ 现在只有 kyc.js 在用，但别删——
│                 #   message.js 仍靠它的 recordCall() 记出站调用统计
└── setup.js      # 首次安装向导后端

public/
├── login.html          # 登录页，动态显示已配置的登录平台 + 登录到组织（IAM）入口
├── dashboard.html       # 用户端 + 管理端一体化控制台（巨型单文件，~9000 行）
├── authorize.html       # OIDC 授权确认页（第三方登录时的"是否同意"界面）
├── login-success.html   # 登录成功中间页，倒计时 + Token 验证 + App 深链回跳
├── pass.html            # 访客通行码页（QR + Apple Wallet 按钮）
├── access-terminal.html # 门禁扫码终端（旧平板即可当门禁机，BarcodeDetector）
├── setup.html           # 首次安装向导前端
├── brand-icons.js       # 三方平台品牌 SVG（login + dashboard 共用）
├── qr-mini.js           # 自研纯 JS QR 编码器（2FA/访客码本地出码，不走 CDN）
└── webauthn-glue.js     # Passkey 浏览器胶水层（base64url↔ArrayBuffer）

ios/                     # iOS 原生 App（SwiftUI + XcodeGen；GitHub Actions 云编译）
.github/workflows/       # ios.yml（编译出未签名 .ipa）+ release.yml（推 tag 自动建 GitHub Release）
CHANGELOG.md             # 线性发行记录（v3.5.19 起，每次发版追加；release.yml 取其小节作 Release 说明）
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

## 数据库表清单（截至 v3.5.51）

核心表：`users`、`user_oauth`、`otp_store`、`oauth_states`、`login_logs`、`apps`、`user_app_auth`、`api_keys`、`env_config`、`points_log`、`uid_seq`
- `users` 关键增补列：`uid_code`（自定义 UID）、`is_public`/`owner_group_id`（公共账号）、`group_id`、`twofa_enabled`/`twofa_secret`、`kyc_*`（kyc_verified/kyc_name/kyc_id_tail/kyc_provider/kyc_verified_at/kyc_pseudonym/kyc_name_hash）、`checkin_streak`/`last_checkin`、`merged_into`（一人多号合并后被并入的账号，v3.5.41）、`deletion_state`/`deleted_at`/`purge_at`（注销删除，v3.5.44）
- `apps` 关键增补列：`client_id`/`client_secret`/`callback_url`、`launch_url`、`required_scopes`、`category`、`deprovision_url`、`backchannel_logout_uri`、`icon_url`
- 应用图片 / 文件夹（v3.5.28）：`app_icons`（图片 BLOB 独立存，**不进 apps**）、`app_folders`/`app_folder_items`（个人文件夹，一应用一夹）

商城相关：`shop_goods`（+`category`）、`shop_records`、`redeem_codes`、`redeem_records`、`feature_quota`、`shop_config`、`blind_box_rewards`、`user_coupons`

身份/组织（IAM）：`user_levels`（等级）、`user_groups`/`user_tags`/`user_tag_map`（分组标签）、`group_admins`（分组管理员）、`public_account_members`（公共账号成员）、`oauth_providers`（三方登录凭证/多主体；+`folder_id` 文件夹共用凭证，v3.5.47）、`oauth_subjects`（主体=组织，含 msg_config/kyc_config/allow_direct_login/independent_security/require_org_password/deny_code_login/members_open/org_code/direct_listed/require_2fa/ip_allow/login_start/login_end/uid_prefix 等）、`oauth_subject_admins`（组织管理员）、`org_folders`（组织文件夹，v3.5.38；`oauth_subjects.folder_id` 归属，NULL=未归类）、`dir_sync_sources`（通讯录同步源，一组织多个，v3.5.36；+`event_state` 接收事件服务器状态，v3.5.39；+`folder_id`/`parent_id` 文件夹通讯录连接与组织套用，v3.5.47）、`folder_cred_orgs`（文件夹凭证由哪些组织使用，v3.5.51）、`dir_source_alias`（并进连接的旧同步源 id → 连接，旧回调地址用，v3.5.51）/`dir_source_links`（按同步源隔离的 UserId→用户映射）/`dir_sync_applied`（同步给成员设过的登录绑定与组织密码，判断是否被单独改过，v3.5.37）、`dir_source_links.ext_name`（应用内姓名，v3.5.43）、`admin_grants`（高危权限授权：perm + 范围 all/org/group/tag/folder，v3.5.43）、`account_deletions`（注销 / 删除申请 + 交接清单，v3.5.44；+`ext_snapshot` 删除时摘下的三方绑定 / 通讯录映射快照，v3.5.49）、`identity_blocks`（已删除账号被封存的外部身份：oauth provider+open_id / dir 连接+UserId，v3.5.49）、`merge_records`/`merge_journal`（账号合并记录 + 改动日志，撤销合并用，v3.5.48）、`merge_ignore_pairs`（疑似重复里标记「不是同一人」的两两组合，a<b，v3.5.62）；v3.5.35 的 `oauth_subjects.dir_sync`/`dir_sync_state`/`dir_sync_links` 已迁移弃用、`org_members`（组织成员，含 org_uid/source/password_hash）、`app_orgs`（应用按组织开放）

KYC / 核验 / 审计：`kyc_pending`（支付宝待查 + reverify/source/org_id）、`kyc_events`（实名事件流水）、`audit_chain`（防篡改哈希链）、`verify_fields`/`user_verify_values`/`access_verifiers`（身份核验，v3.5.12）

门禁 / 设备（v3.5.0+）：`access_doors`（+code_mode/sub_ttl/escort_required/blackout，v3.5.29）、`access_rules`（deny 优先 + valid_from/to/weekdays/time）、`access_logs`、`access_qr_used`、`access_cards`（v3.5.2）、`access_faces`（v3.5.3）、`visitor_passes`（v3.5.4，+escort_user_id/blackout）、`access_escort_pending`（陪同待带入，v3.5.29）、`federation_peers`（v3.5.5）、`fed_oidc_codes`/`fed_oidc_tokens`、`fed_apps`（v3.5.7）、`devices`（设备管理，v3.5.21）

内容 / 其他：`memos`/`memo_attachments`（备忘录）、`twofa_recovery_codes`（2FA 恢复码）、`announcements`/`announcement_reads`（公告）、`site_documents`（登录协议）、`site_verify_files`（域名验证文件，v3.5.40）、`backup_targets`（备份目标，v3.5.46）、`webauthn_credentials`（Passkey）、`provider_stats`（服务商调用统计）、`api_call_logs`（入站/出站调用日志）

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
- ⚠️ **云端会话推不了 tag**（git 代理对 `refs/tags/*` 返回 403，只能推分支）。GITHUB_TOKEN 也不能给「workflow 文件与 main 不同」的提交建引用（没有 workflows 权限）。办法：发版提交推到 main 后，手动运行 **Actions → Backfill tags**（`.github/workflows/backfill-tags.yml`，workflow_dispatch，可用 GitHub MCP `actions_run_trigger` 触发）——按提交标题 `vX.Y.Z:` 找缺 tag 的版本：最新版打在 main HEAD；旧版本打在「该版本代码 + 当前 `.github/workflows`」的快照提交上（代码与原提交完全一致），并按 CHANGELOG 建 Release。v3.5.24~v3.5.37 就是这样补上的。所以发版提交标题必须保持 `vX.Y.Z: 描述` 格式。

---

## v3.5.70.5 修出站建号：企业微信 userid 冲突错误码 + 飞书根部门

四级补丁（修 bug）。用户实测两个新错误：
- 🐛 **企业微信 `60102 userid existed`**：`upsertMember` 里把「userid 已存在→增补」的错误码写成了 `60106`——**60106 实际是「邮箱已存在」**，userid 冲突是 **60102**。导致 userid 冲突时没走「增补部门」，直接报错。修：`60102` 走增补（读现有部门并集 update），`60106`（邮箱已存在）与 `60104`（手机号已存在）各给友好提示。
- 🐛 **飞书 `99992402 field validation failed`**：飞书同步源没配部门时 `deptIdsOf` 返回 `['0']`（根部门），但**根部门 "0" 是虚拟根、不能作成员归属**，传给 `department_ids` 导致字段校验失败。修：`createMember` 过滤掉空值和 `"0"`，过滤后为空则不传 department_ids（飞书归到默认部门）。
- ⚠️ 测试：`push-provision-test.js` 改 60102 增补 + 60106 邮箱提示，10 项；`feishu-create-test.js` 加根部门过滤 + 具体部门保留，7 项；回归 7 套 68 项全过。

## v3.5.70.4 修飞书出站建号：手机号要带 +86（E.164 格式）

四级补丁（修 bug）。用户实测飞书出站建号报 `99992402 field validation failed`——飞书 `POST /contact/v3/users` 的 `mobile` 字段要求 E.164 格式（`+8613800000000`），而 SSO 存的是裸 11 位手机号（`normMember` 读通讯录时把 `+86` 去掉了）。
- 修：`dirsync-feishu.createMember` 里 mobile 无 `+` 前缀时补 `+86`（去掉非数字后拼），已带 `+` 不重复加。
- ⚠️ 测试：新 `scratchpad/feishu-create-test.js`（mock db/contacts + mock fetch）6 项全过（返回 open_id、不传 user_id、mobile 加 +86、已带 + 不重复加、department_ids 字符串数组、name 原样）；回归 7 套 66 项全过。

## v3.5.70.3 修出站建号：飞书 user_id 非法 + 企业微信手机号已存在

四级补丁（修 bug）。用户实测出站建号，两条错误：
- **飞书 `99992360 invalid user_id`**：`pushMemberToSources` 把 `user_id` 传成了组织内 UID（如 `0006`）——飞书 `user_id` 要求工号/手机号格式，纯数字非法。修：飞书**不传 user_id**，让飞书自动生成 open_id，`createMember` 从响应 `j.data.user.open_id` 取回写映射。
- **企业微信 `60104 mobile existed`**：手机号已在企业微信通讯录里（成员很可能已在企业微信）。修：`upsertMember` 捕获 60104 抛友好提示「手机号已在企业微信通讯录里（该成员可能已存在于企业微信，请用通讯录同步拉取绑定）」，不重复建号。
- ⚠️ 测试：`push-provision-test.js` 补 60104 友好提示项，9 项全过；回归 6 套 60 项全过。

## v3.5.70.2 出站建号失败时用弹窗显示详细错误（原 toast 看不到 errcode）

四级补丁。用户反馈出站建号失败但「没找到 errcode」——根因是 `_pushToast`（dashboard.html）失败时只显示「失败：企业微信」这类 label，**不显示具体 error（errcode）**，且 `showToast` 2.5 秒消失、长文本被截断。
- 修：`_pushToast` 失败分支改为 **`uiAlert` 弹窗**逐源显示 `label：error`（含企业微信 errcode /「无写权限」原因），toast 只回「成功 N/M，详情见弹窗」。成功分支照旧 toast「已同步到 …」。
- ⚠️ 与 v3.5.70.1 合起来，出站建号失败的可诊断性补齐：department 类型 + 错误可见性。
- ⚠️ 测试：dev 浏览器实测失败 push_results → 弹窗含 48002/无权限 + toast「详情见弹窗」。

## v3.5.70.1 修出站建号失败（企业微信 department 传了字符串数组，应为整数）

四级补丁（修 bug）。用户反馈 v3.5.69 出站建号失败，但自建应用/通讯录权限都配了。
- 🐛 根因：企业微信 `dept_ids` 在 `dirScopeFromBody`（api.js:2368）里 `parseInt` 存成**整数数组**，但 `dirsync-wecom.createMember`/`upsertMember` 里 `f.department.map(String)` 把整数转成了**字符串数组**——企业微信 `user/create` 的 `department` 要求**整数数组**，传字符串会报错。
- 修：`createMember`/`upsertMember` 里 department 一律 `parseInt` + 过滤 >0，空则默认根部门 `[1]`；不再 `map(String)`。
- 顺手改进「无写权限」提示文案：明确「通讯录同步」Secret（管理工具 → 通讯录同步 → 开启「API 编辑通讯录」）与「自建应用」Secret 的区别。
- ⚠️ 测试：`push-provision-test.js` 更新断言为整数数组（`typeof d === 'number'`），8 项全过；回归 6 套 59 项全过。

## v3.5.70 管理端「当前组织」切换（顶栏下拉 + 组织资源聚焦）（用户反馈）

三级版本。用户要「管理端切换到组织（延伸现在的功能）」，确认语义：**切换后保留管理端、聚焦组织**（不是复用 org_scoped 降级——那会把管理员降成普通用户、管理菜单都没了）；**顶栏下拉**做入口；**组织管理员也一样**。

- 后端 `GET /admin/devices?org=X`：系统管理员传 org 只返回 `subject_id=X` 的设备；组织管理员传 org 限自己管的组织（`myManagedOrgs`）。`GET /admin/access/doors?org=X`：传 org 只返回该组织的门（全局门 `subject_id IS NULL` 在聚焦时不显示）。⚠️ 只收窄显示、不改权限判定（`isSysAdmin`/`myManagedOrgs` 照旧）。
- 前端：`topbar-actions` 加「当前组织」下拉（`loadAdminOrgSelect` 拉 `/account/managed-orgs`——系统管理员=全部、组织管理员=自己管的）；`onAdminOrgChange` 存 `localStorage.sso_admin_org` + 刷新设备/门禁页 + 内容区顶部横幅「当前组织：X · 返回全部」；`loadDevices`/`loadAccessAdmin` 带 `?org=`。`loadMe` 管理员分支调 `loadAdminOrgSelect`。`sso_admin_org` 是独立于 `sso_current_org`（应用市场）和 org_scoped 的第三套上下文。
- ⚠️ 测试：dev 浏览器实测（见下）；真实 HTTP 链路同既有约束未端到端跑（无 node_modules），后端 org 过滤是简单 filter，风险低。

## v3.5.69 出站 provisioning：成员加入/离开组织自动增删企业微信/飞书账号（用户反馈）

三级版本。用户指出：现在「组织成员 add/remove」只有入站（企业微信/飞书 → SSO 拉取），**出站没做**——管理员在 SSO 里把成员加进组织、或移出组织时，企业微信/飞书那边不会自动增删账号。用户确认三点：① 手动+自动结合，且**成员在外部可能已在多部门，推送更新只能增补部门、不能把多部门覆盖成一个**；② 移出删号：本系统建的、外部本来的都删，但**人工强确认**；③ 外部标识（userid/open_id）用随机码或平台 UID（org_uid）。

### 驱动加 createMember / upsertMember
- `dirsync-wecom.js`：`createMember(cfg, f)`（`POST /cgi-bin/user/create`，用 `writeCfg` 的通讯录同步 Secret）+ `upsertMember`（create 报 `60106` userid 已存在 → `user/get` 读现有 department → 与新 department **取并集** → `user/update` 增补，不覆盖多部门）。
- `dirsync-feishu.js`：`createMember`（`POST /contact/v3/users`，传 user_id/name/mobile/email/department_ids）+ `upsertMember`（create 冲突 → GET 读现有 department_ids → 并集 → `PATCH` 增补）。
- `dirsync.js`：wecom driver 显式加 createMember/upsertMember（feishu 是整个模块对象，自动带出）。

### db.js
- `dirSourceStmts` 加 `linkUpsert`（建号后写映射）/ `linkDelete`（删号后清映射）/ `linkByUserSource`。不加列。

### api.js 挂钩
- `pushMemberToSources(subject, user, opts)`：遍历该组织**启用 + can_write** 的同步源（`src.type==='feishu' || !!cfg.write_secret`），`drv.upsertMember` 建号（extId 优先 org_uid、否则随机码），成功后 `linkUpsert` 写映射；失败静默记 warn。`removeMemberFromSources(subject, user)`：查该成员在本组织各同步源的映射 → 逐个 `deleteMember` + `linkDelete`。
- `POST /admin/orgs/:sid/members` 收 `push:true`（勾选才出站）→ 返回 `push_results`；`DELETE .../members/:uid` 收 `push:true`（强确认后带）→ 删号 + 返回 `push_results`。新增显式 `POST /admin/orgs/:sid/members/:uid/push`（事后补建号）。

### 前端（dashboard.html）
- 成员弹窗加「同步到企业微信/飞书建号」勾选（`orgmem-push`），`addOrgMember`/`createOrgMember` 读它带 `push`，`_pushToast` 反馈每源结果。`delOrgMember` 确认文案改「移出后会在企业微信/飞书里删除对应账号」，带 `push:true`。成员行加「同步」按钮（`pushOrgMember` → 显式 push 接口）。dev mock 补 push_results。

### 测试
- `scratchpad/push-provision-test.js` 8 项全过：建号成功返回 userid + 走 user/create + 不触发 update；userid 冲突（60106）→ user/update 增补部门（并集含现有 [10,20] 与新 [1]，部门数=3 未覆盖）；非 60106 错误直接抛不误增补。
- dev 浏览器实测：勾选框存在、加成员带 push 成功、成员行「同步」按钮 → toast「已同步到 企业微信」。
- ⚠️ 真实企业微信/飞书写链路无凭据无法端到端（同既有约束），靠 mock fetch + upsertMember 单测覆盖增补语义。

## v3.5.68.1 修部署失败：删掉未使用的 upsertExt（ON CONFLICT 部分索引不匹配）

四级补丁（修 bug）。v3.5.68 推上去后 Zeabur 部署失败——根因是 `db.js` 的 `deptStmts.upsertExt` 这个 prepared statement 用了 `ON CONFLICT(subject_id, source, ext_id)`，但对应唯一索引是**部分索引**（`CREATE UNIQUE INDEX ... WHERE ext_id IS NOT NULL`），SQLite 报 `ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint`；better-sqlite3 在 `db.prepare()` 时就编译 SQL、抛异常 → 整个 db.js require 失败 → 服务启动崩溃。
- 修：**删除 upsertExt**——它本就没被用到（v3.5.68 里 syncWecom/syncFeishu 实际用的是 `getByExt` 查询 + 分开的 `insert`/`update`，不是 upsertExt）。
- ⚠️ 教训：**部分唯一索引（带 WHERE）不能作为不带 WHERE 的 `ON CONFLICT (cols)` 冲突目标**。要么把冲突目标写成 `ON CONFLICT(cols) WHERE ...`，要么（更简单）像这次一样用「先查再 insert/update」。
- 验证：node:sqlite 确认其余 dept SQL（bySubject 子查询 / listBySubject JOIN / setDeptId / deptOfUser）全部能 prepare；grep 确认 upsertExt 无残留引用。

## v3.5.68 正式树状部门体系（成员按部门归属 + 通讯录同步自动建部门 + 门禁部门授权）（用户反馈）

三级版本。把 v3.5.67 的「自由文本部门」升级成正式的树状部门。用户确认两个决策：① 通讯录同步（企微/飞书）**自动建部门树**；② 门禁授权**同时加「部门」维度**。

### 数据（db.js）
- 新表 `org_departments(id, subject_id, name, parent_id, source[manual|wecom|feishu], ext_id, sort_order, created_at)`——树状（parent_id 自引用），每组织一套；`ext_id` 供通讯录同步按 `(subject_id, source, ext_id)` 唯一 upsert。
- `org_members` 加 `dept_id`（指向部门；旧的 `dept` 自由文本字段保留但不再用，避免 ALTER DROP）。
- `deptStmts`（导出 `departments`）：bySubject（带 member_count 子查询）/ get / getByExt / insert / update / remove / childrenOf / upsertExt / clearMemberDeptByDept。`orgMemberStmts`：`setDept` 改语义为 `setDeptId`、新增 `deptOfUser`（门禁判定用）、`listBySubject` 回带 `dept_id` + `LEFT JOIN` 取 `dept_name`。

### 后端（api.js）
- 部门 CRUD（`canManageOrg` 同成员接口）：`GET/POST/PATCH/DELETE /admin/orgs/:sid/departments`。POST 建顶级部门；PATCH 改名/换父级（**防循环** `deptIsDescendant`：不能把部门移到自己的子孙下）；DELETE 删部门（成员 `dept_id` 置空、子部门 `parent_id` 上提到被删部门父级）。
- `PATCH /admin/orgs/:sid/members/:uid` 收 `dept_id`（替换 v3.5.67 的 `dept` 文本），校验是本组织的部门。
- 门禁规则：`ACCESS_GRANT_TYPES` 加 `dept`，POST 校验 grant_value 必须是存在的部门；`accessRuleLabel` 加 `dept` 显示部门名。

### 门禁判定（access.js）
`ruleMatchesUser` 加 `case 'dept'`：`orgMembers.deptOfUser.all(user.id)` 里任一 `dept_id === grant_value`（**先精确匹配部门本身，不含子部门递归**，子部门展开留后续）。

### 通讯录同步自动建部门（dirsync-wecom.js + dirsync-feishu.js）
- `fetchDirectory` 额外返回 `deptTree`（含父子关系的部门节点；企微 `deptList` 的 `parentid`、飞书 `childrenOf/deptInfo` 的 `parent`）。
- `syncWecom`/`syncFeishu` 开头：非 limited 时遍历 `deptTree`，按 `getByExt` 命中则 update（改名/换父级）、否则 insert，`ext_id` 映射到部门 uuid；成员 `department`/`department_ids` 里第一个有对应部门的 id → `setDeptId` 归部门。飞书 `normMember` 加 `department_ids`（保留原始 open_department_id，之前只映射成 name 丢了 id）。

### 前端（dashboard.html）
- 组织成员弹窗加「🏢 部门（树状）」折叠区：部门树列表（缩进层级 + 来源徽章 + 人数）+ 新建/改名/删除；成员行部门输入从自由文本改**部门下拉**（`_deptOpts` 缩进显示层级）；「新建并加入」的部门也改下拉。dev mock 加 departments CRUD。
- 门禁规则弹窗 `rule-type` 加「按部门」；`openDoorRules` 预取各组织部门合并成带「组织名 · 部门名」的下拉。

### 测试
- `scratchpad/departments-test.js` 12 项全过：门禁 dept 命中/别的部门不命中/无部门不命中/多部门命中其一；部门 upsert 幂等（同 ext_id 不新建、改名+换父级生效）；防循环（子孙判定）。
- dev 浏览器实测：部门树渲染（技术部/后端组缩进）、成员行部门下拉（缩进 + 回填选中部门 + 名字旁部门徽章）、门禁规则弹窗「按部门」+ 部门下拉（示例集团 · 技术部）。回归 contacts 18 + dirsync-contacts 6 + similar-clues 5 + import-multi 10 全过。
- ⚠️ 真实通讯录同步链路无凭据无法端到端（同既有约束），靠 fetchDirectory 返回 deptTree 的逻辑审查 + upsert 单测覆盖。

## v3.5.67 组织成员管理补齐：按组织建成员 + 分配登录凭证 + 成员部门（用户反馈）

三级版本。用户反馈组织成员管理三个缺口：① 不支持「按组织建成员」（只能加已有账号）；② 平台建号入组后「无法为其分配相应账号」（指绑三方登录凭证）；③「将其账号设置到某部门」没有手动部门概念。三件一起补。

### ① 按组织建成员（新建账号 + 直接入组）
此前 `POST /admin/orgs/:sid/members` 只走 `resolveUser` 认已有账号，找不到就 404。现加 `create:true` 分支：`{create,name,email?,phone?,password?,dept?,org_uid?}` → 校验（姓名必填、邮箱/手机至少一个、格式、占用、密码≥8 可空）→ `users.create` 建平台账号 → 主邮箱/手机灌进 user_contacts → 加入本组织（可带部门/org_uid）。路由改 async（要 bcrypt）。前端组织成员弹窗加「➕ 新建账号并加入本组织」折叠区（姓名/邮箱/手机/密码/部门/org_uid + `createOrgMember`）。

### ② 为成员分配登录凭证（绑三方登录）
组织密码（v3.5.20）、组织内UID 本就能设；缺的是把三方登录绑到成员。新增 `GET/POST/DELETE /admin/orgs/:sid/members/:uid/credentials`：POST `{provider, open_id}`（provider=平台名或 平台名:实例id，open_id=该成员在该平台的标识，如企微 UserId / 飞书 open_id）→ 校验平台合法 + 该 (provider,open_id) 未绑他人 → `oauth.bind`；DELETE 按 provider 解绑；GET 列当前绑定。前端成员行加「登录凭证」按钮 → 内联面板 `#orgmem-creds`（平台下拉来自 `/public/login-methods?raw=1` + 填标识 + 绑/解绑；`openOrgMemCreds`/`bindOrgMemCred`/`unbindOrgMemCred`）。绑定后该成员用那个三方登录即落到此账号——正好解决企微/飞书 UserId 对不上、同人多号的归并前置。

### ③ 成员部门（手动，自由文本）
`org_members` 加 `dept` 列（自由文本，如「技术部/后端组」，空=未分配；通讯录同步也可回填）。`orgMemberStmts.setDept` + `listBySubject` 回带 `m.dept`。`PATCH /admin/orgs/:sid/members/:uid` 现同时收 `org_uid` 与 `dept`（都 optional、各自判定）。前端成员行加部门输入 + 「存部门」按钮（`setOrgMemDept`）+ 名字旁 🏢 部门徽章；新建并加入也可带部门。
- ⚠️ 用的是**自由文本部门**，不是正式树状部门表——够用且零迁移风险；要正式部门体系是另一档工作量，按需再上。
- ⚠️ 测试：dev 浏览器实测——「新建并加入」建「赵思达」带部门「技术部/后端组」入列、登录凭证面板（平台下拉含 微信/企业微信/A公司微信，绑 MilkSU 后显示）、行内改部门「市场部」保存。无代码报错（仅既有 loadAcctDeletion/loadKycSiblings 的 dev-mock 缺失报错，与本功能无关）。db 层 ALTER + setDept 语法校验通过；后端 async 建号/凭证绑定逻辑审查（HTTP 层无 express 未端到端，与既有 members 接口同构）。

## v3.5.66 批量导入支持多手机/多邮箱（企微回不了字段时用导入代替）（用户反馈）

四级补丁。用户（带图：企业微信「通讯录同步」权限详情页）确认——该通讯录同步 Secret **「可读取全公司范围内的信息」只有 账号(userid) / 部门ID / 通讯录查看权限，没有手机/邮箱**（「可新增和修改」里虽列了手机邮箱，但那是写权限，不影响读；内置通讯录同步应用的敏感字段读取范围常锁死改不了）。所以企微拉取拿不到手机邮箱是企微侧权限天花板，**干脆用批量导入代替**。

把已有的批量导入（`importOrgMembers`，`/admin/orgs/:sid/import` + 开放 API `/v1/orgs/:sid/members/import`）升级为支持**一人多手机/多邮箱**，灌进 v3.5.63 的 `user_contacts` 表：
- 每行 `members[]` 项新增可选 `emails[]` / `phones[]`（与原 `email`/`phone` 兼容）。收集全部有效值：**第一个有效手机/邮箱做登录主字段**（`users.phone`/`email`），**全部手机/邮箱（含主字段那个）都灌进 `user_contacts`**（走 `contactUtil.addContact`，去重 + 按组织上限 + 静默跳过）。
- 认人改为「数组里任一邮箱/手机命中即同一人」（原来只认第一个主值）——跨次导入不同联系方式也能落到同一账号。
- 报错语义：有填但全不合法 → error；完全没填 → error。结果每行多返回 `contacts`（灌入的联系方式数）。
- 前端粘贴格式扩展：第一列可填**多个手机/邮箱用分号 `;`（或 `；`/`|`）隔开**，如 `13800138000;a@x.com;a@corp.com, 张三, EMP0001`；`doOrgImport` 拆成 `phones[]`/`emails[]` 提交。导入面板说明文字 + placeholder 同步更新。dev mock 处理数组。
- API-docs 的 `members/import` 参数表 + 响应示例更新（加 emails[]/phones[] + contacts 字段）。
- ⚠️ 测试：`scratchpad/import-multi-test.js`（node:sqlite 真表 + 真实 addContact，复刻 importOrgMembers）10 项全过：主值取第一个有效、全部进多联系方式、同行重复去重、邮箱大小写归一、按数组任一旧标识命中同一人、非法/缺标识报错。`contacts`/`dirsync-contacts`/`similar-clues` 三套既有测试仍全过。
- ⚠️ `importOrgMembers` 嵌在 api.js（better-sqlite3）无法独立 require，测试复刻其逻辑验证；真实 HTTP 层与既有 `/admin/orgs/:sid/import` 同构，未端到端跑。

## v3.5.65 疑似重复识别加跨平台线索（外部姓名/UID + 手机/邮箱跨多联系方式）+ 企微空字段提示（用户反馈）

四级补丁。用户反馈（带两张图）：企业微信同步回来的成员**手机/邮箱是空的**，而且**同一人被拆成两个号**（企微「赵思达」org_uid=MilkSU 与 飞书「MilkSU」ext_name=MilkSU 是同一人，却没被识别）。两件事一起处理。

### ① 企微手机/邮箱回空 → 根因是权限，加提示（代码绕不过）
企业微信 `user/get` 回来有姓名、没手机/邮箱，是因为**自建应用 / 通讯录同步 Secret 没开放手机号/邮箱字段的读取权限**（企业微信后台「可见范围 / 敏感信息」里单独控制），不是代码问题。`dirsync-wecom.js` 的 `syncWecom` 加 `out.no_contact` 计数：拿到姓名但手机邮箱都空的成员计一笔，结束时若 `no_contact>0 && !limited` 就把 `out.warning` 设为「有 N 名成员未取到手机/邮箱……请到企业微信后台开放字段权限后重新同步」。该 warning 原本就在同步源 UI（`dashboard.html:6338` `src.state.warning`）显示，无需改前端。

### ② 疑似重复识别加跨平台线索（findSimilarUsers，api.js）
v3.5.62 的线索只有 kyc/union/corp/name/email前缀——跨平台同人（企微+飞书）没有可连的字段。新增：
- **`dirname`（外部通讯录姓名/UID 相同）**：`dir_source_links.ext_name` + `org_members.org_uid` 进同一桶（NFKC+小写+去空白，长度≥3 才作线索防短值乱连）。企微 org_uid=MilkSU 与 飞书 ext_name=MilkSU 就靠这个连上。一般线索（非 strong），受 >8 人桶上限保护，归组后**管理员手动确认合并**。
- **`phone`（手机相同）**：主字段 `users.phone` + `user_contacts` 里的手机，同号进同一桶（≥6 位）。
- **`email` 改为完整邮箱匹配**（原来是 @前缀≥4 位，改为完整 email，更准、少误连）+ 纳入 `user_contacts` 里的邮箱（企微/飞书灌入的企业邮箱也能连）。
- `SIMILAR_REASON` 加 dirname/phone 文案、email 文案改「邮箱相同」。dirname/phone/email 都是一般线索（strong 仍只有 kyc/union/corp），避免误并，靠人工确认兜底——正合用户「相似字段认为可能同一人、手动确认」的诉求。
- ⚠️ 测试：`scratchpad/similar-clues-test.js`（node:sqlite 复刻线索收集+并查集）5 项全过：图里两账号因 dirname 归组、共享手机（主字段 vs user_contacts）归组、共享企业邮箱大小写不敏感归组、不同手机不误连、dirname 太短不连。`contacts-test.js` 18 + `dirsync-contacts-test.js` 6 仍全过。
- ⚠️ `findSimilarUsers` 依赖整个 api.js（better-sqlite3），无法独立 require，故测试复刻其纯逻辑验证；真实并查集/视图在 v3.5.62 已有、未动。

## v3.5.64 企业微信通讯录「主动同步」也灌多联系方式（打通 syncWecom 与 user_contacts）（用户反馈）

四级补丁（承接 v3.5.63）。用户问：能不能像拉通讯录一样直接把成员手机/邮箱传回来，不靠用户登录授权？

**核查发现：主动拉通讯录能力早就有**——`server/dirsync-wecom.js`（v3.5.39+）已完整实现：用通讯录同步 Secret 主动拉全员（`fetchDirectory`：`user/list`，受限自动降级 `list_id`+`user/get`）→ 建号（`syncWecom`）→ 绑定 UserId → 加入组织 → 离职移出（`remove_missing`）；**连回调实时同步都做好了**（`cbVerify`/`cbDecrypt`/`cbEncrypt`/`xmlField`，企业微信「接收事件服务器」的 URL 握手 + AES-256-CBC 解密；回调去抖后调 `runDirSource`→`syncWecom`）。管理端「组织管理 → 成员 → 通讯录同步」里配置。

**唯一缺口**：`syncWecom` 建号时只把 `email||biz_mail` 之一塞进 `users.email` 主字段，没把多出来的手机/个人邮箱/企业邮箱写进 v3.5.63 新建的 `user_contacts` 多联系方式表——于是「主动同步进来的人」在多联系方式里是空的，只有「登录过的人」才有。

**本版修**：`syncWecom` 在解析出 user 后调 `importWecomContacts(user.id, m, subject.id)`（`dirsync-wecom.js` 第 ~396 行，`!m._idOnly` 才灌——只拿到 UserId 的受限情况没有联系方式字段）。于是主动同步 / 回调实时 / 登录灌入三条路的联系方式数据统一，上限仍按组织（`contactLimits` 读 subject 的 max_phones/max_emails）、去重、静默跳过。
- ⚠️ 测试：`scratchpad/dirsync-contacts-test.js`（node:sqlite 兜 syncWecom 用到的表 + stub ./contacts spy）6 项全过：同步建 2 号、正常成员触发 importWecomContacts 且带 biz_mail + 正确 subjectId、`_idOnly` 成员不灌。`contacts-test.js` 18 项仍全过。
- ⚠️ 真实企业微信通讯录链路无凭据无法端到端（同既有约束）；靠 syncWecom 集成单测 + importWecomContacts 单测覆盖。

## v3.5.63 企业微信回传成员联系方式 + 成员多手机/多邮箱（上限按组织可覆盖）（用户反馈）

三级版本。用户问：企业微信回传组织数据时支不支持传回成员手机/邮箱？

**事实**：支持，但前提是登录 scope=`snsapi_privateinfo`（`oauth.js` wecom 入口已满足）+ 自建应用有「通讯录读取」权限，且字段未设「仅本人可见」——满足后 `/cgi-bin/user/get`（登录拿 name/avatar 用的那个）才返回 `mobile`/`email`/`biz_mail`（`/cgi-bin/auth/getuserinfo` 只回 userid，不含）。企微**每成员只有 1 手机 + 1 个人邮箱 + 1 企业邮箱**，不是多值；用户要的「10 手机/20 邮箱」是**本系统自己的多联系方式能力**，企微登录只把那几个灌进来作初始数据。

### 数据（db.js）
- 新表 `user_contacts(id,user_id,kind[phone|email],value,source[manual|wecom|wecom_biz],is_primary,created_at)`，唯一索引 `(user_id,kind,value)` 去重。`contactStmts` 导出 `contacts`。
- `oauth_subjects` 加 `max_phones`/`max_emails`（0=回退全局）；`oauthSubjectStmts.setContactLimits`。
- ⚠️ 额外联系方式**只作资料，不用作登录标识符**（用户确认方式 1）；登录仍只认 `users.email`/`users.phone`，其中 is_primary=1 的那条镜像到主字段。

### 后端（`server/contacts.js` 新文件 + oauth.js + api.js）
- `contacts.js`（纯工具，便于单测）：`contactLimits(subjectId)`（组织 >0 用组织、否则回退全局 `MEMBER_MAX_PHONES`默认10/`MEMBER_MAX_EMAILS`默认20，夹1~50）、`normPhone`/`normEmail`、`addContact`（去重/超上限/非法均静默跳过返回结果对象，不抛）、`listContacts`、`importWecomContacts(userId,d,subjectId)`（从 user/get 响应取 mobile/email/biz_mail）。
- `oauth.js` wecom 回调（现用 `wecomApi` 封装）：findOrCreate 拿到 user 后 `importWecomContacts(resolved.id, detail, subjectOfProviderKey(...))`——**静默**，权限不足/字段空跳过并 `console.warn`。
- api.js：管理端 `GET/POST/DELETE /admin/users/:id/contacts`（读 Lv.3 写 Lv.2）；用户端 `GET/POST/DELETE /user/contacts` + `PUT /user/contacts/:cid/primary`（设主→镜像 users.email/phone + 占用检查）；开放 API `GET /v1/users/:uid/contacts`（复用 users:read，有 sandbox 桩）；`PATCH /admin/oauth-subjects/:id` 收 `max_phones`/`max_emails`、`GET` 回带。

### 前端（dashboard.html）
- 账号「登录方式绑定」：邮箱/手机主字段标「主要」+「+添加」；其它联系方式列出（来源标签 企业微信/企业邮箱/手动）带「设为主要」「删除」；三方凭证收进可展开 `<details>`（标题「其他登录凭证（N 个，已绑 M）」，有已绑则默认展开）。
- 管理端用户详情加「联系方式」区（列表+来源标签+增删）。组织弹窗加「每人手机/邮箱上限（0=全局）」。系统配置「系统与页脚」加 `membercontact` 组（`MEMBER_MAX_PHONES`/`MEMBER_MAX_EMAILS`，init.js ENV_KEYS 同步）。
- ⚠️ 测试：`scratchpad/contacts-test.js`（node:sqlite 建真表 mock ./db）18 项全过。dev 浏览器实测过（在初版 v3.5.24 开发时验证：账号页折叠+设为主要同步主字段、管理端增删、组织弹窗上限回填、membercontact env 组）。
- ⚠️ 企业微信真实链路无凭据无法端到端（同既有约束），靠逻辑审查 + importWecomContacts 单测覆盖。
- ⚠️ 版本号说明：本功能最初在本地老代码上开发为 v3.5.24，但远端早已推进到 v3.5.62（且 v3.5.24/v3.5.25 标签已被占用）。重新基于 v3.5.62 代码移植并发为 v3.5.63；v3.5.24/v3.5.25 号作废跳过。

## v3.5.62 疑似重复账号批量识别与合并（用户反馈）

三级版本。用户：「合并账号能够批量识别相近的就好了。」
- `api.js`：`mergeGroupView(list)` 从 v3.5.61 的 preview 抽出（资料摘要 / can_be_source / can_be_target / suggested（跳过不能当保留的）/ conflict），preview 与本功能共用。`findSimilarUsers()`：候选 = 非公共、未合并、`deletion_state IS NULL`；分桶 `kyc`（kyc_pseudonym）/ `union`（`user_oauth.union_id` 按平台前缀 + `dir_source_links.ext_union` 记为 feishu）/ `corp`（`dirsyncWecom.findCorpDuplicates()`）/ `name`（`similarNameKey`：NFKC + 去空白 + 小写 + 去结尾最多 3 层括号注记，≥2 字）/ `email`（@ 前缀 ≥4 位）；同桶两两连边（弱线索桶 >8 人跳过；`merge_ignore_pairs` 里的、实名假名不同的、两个管理员不连）→ 并查集分组，>21 人的组丢弃；强线索在前。接口 `GET /admin/users/similar`、`POST /admin/users/similar/merge {confirm:'合并账号', groups:[{ids,target}]}`（逐组 `mergeUsers` via `similar`，失败逐组返回）、`POST .../ignore {groups:[{ids}]}`、`POST .../unignore`，全部 Lv.1；审计 `user.merged`（via similar）/ `user.similar_ignored` / `user.similar_unignored`。`MERGE_VIA`（api.js + notify.js）补 `user_list` / `similar`。
- `db.js`：新表 `merge_ignore_pairs(a, b, created_by, created_at, PK(a,b))`（a<b）。⚠️ 账号被彻底清除 / 合并后这里可能残留其 id，无害（分组时按现存账号过滤）。
- 前端：用户管理卡片头「疑似重复账号」按钮 `#user-similar-btn`（`_userBulkSync` 里只对 superadmin 显示）→ `openSimilarUsers()`：每组卡片（勾选框，强线索且无冲突默认勾；线索徽章；单选保留账号 `sim-keep-<gi>`；「保留 / 并入后删除」与不能并入原因）、全选、「不是同一人（N）」、「合并所选（N）」→ `uiConfirm` 名单 → `uiPrompt`「合并账号」→ 批量接口 → 失败组 `uiAlert`；「恢复提示」清空忽略。
- ⚠️ 测试：run38 25 项（Lv.2 403、同一实名强组 + 建议保留、同平台 unionid 强组、不同平台 unionid 不算、姓名去空白 / 去括号三人弱组、公共 / 已删除不参与、邮箱前缀忽略大小写、实名不同不连、两个管理员不连、>8 人常见名不连、强线索在前、不下发哈希、标记不是同一人 3 对且不再出现、缺确认词 400、Lv.2 合并 403、批量两成两败（并入管理员 / 保留账号不在组里）、并入账号删除、unionid 绑定转移、失败组无改动、每组一条可撤销记录、审计、合并后不再出现、单组撤销、恢复提示）；playwright ui38 12 项（Lv.2 无按钮、两组、强组默认勾 / 弱组不勾、线索、默认保留、计数、标记后消失、批量合并积分累加、列表刷新，零 JS 报错、无原生弹窗）；回归 run37 21 / run30 17 / run16 22 / run 35 / run22 62 / ui37 11 / ui30 10。

## v3.5.61 用户管理勾选合并（用户反馈）

三级版本。用户：「用户管理，做一个勾选用户快速合并的功能。」
- `api.js`：`POST /admin/users/merge/preview {ids}`（Lv.1，2~21 个）——每个账号的资料摘要（不下发哈希）+ `can_be_source/source_error`（用无限制的虚拟保留账号跑 `checkMerge`）+ `can_be_target/target_error`（反过来）+ `suggested`（`mergeKeepScore`，同 `findCorpDuplicates` 的打分）+ `conflict`（实名假名不同 / 两个以上管理员）+ `undo_days`。`POST /admin/users/merge` 新收 `target_id` / `source_ids`（按 id，不走 `resolveUser`，同名不会认错），`via:'user_list'`；旧的 `{target, sources}` 照旧。合并本身仍是 `userMerge.mergeUsers`（事务 + 改动日志，可撤销）。
- 前端：批量栏 `#user-bulk-merge`（`_userBulkSync` 里 `adminRole==='superadmin' && _uSel.size>=2` 才显示）→ `userBulkMerge()`：预览弹窗（`ui-dlg` 样式，单选保留账号 `um-keep`，行上「保留 / 并入后删除」与不能并入的原因，有问题时「下一步」禁用）→ `uiConfirm` 名单 → `uiPrompt`「合并账号」→ 合并后清选择、刷新列表并打开保留账号详情。
- ⚠️ 测试：run37 21 项（Lv.2 预览 / 合并 403、一个 / 不存在、建议保留、资料摘要、不下发哈希、管理员只能保留、公共账号两边都不行、实名不同冲突、已删除不能参与、两个管理员冲突、缺确认词、并入管理员 400 且无改动、按 id 合并、并入账号删除、绑定 / 组织 / 积分 / 手机转移、合并记录 via user_list 可撤销、审计、撤销、旧接口照旧）；playwright ui37 11 项（Lv.2 无按钮、一人不显示、默认保留、改选、错确认词不执行、合并成功积分累加、列表刷新，零 JS 报错、无原生弹窗）；回归 run30 17 / run16 22 / run 35 / ui30 10。run23（3 项）/ run20（1 项）在未改动的代码上同样失败（撤销期限与 KYC 服务商的测试环境问题），与本版无关。

## v3.5.60 飞书通讯录也能放在组织文件夹上（用户反馈）

三级版本。用户问 v3.5.59「为什么文件夹不行？」——那是范围取舍不是技术限制，用户：「下一班做掉。」
- 后端（api.js）：文件夹连接建 / 改 / 部门树 / 迁移 / 按部门建组织全部按 `conn.type` 走驱动（`drvOf`）。`cbReady(type, cfg)`（飞书只要 Token 即就绪）；`dirConnView` 回调地址按类型；`buildDirConnCfg(b, old, type)`；同文件夹同 App ID 只能一份，有套用时不能改 App ID。组织侧套用：`useType = conn.type`，传了不一样的 type → 400；套用的 scope-tree 也用连接的类型。迁移的候选覆盖所有 `DIR_TYPES`，并入已有连接时回调字段按 `cbReady` 带过去。create-orgs：飞书部门 id 保持字符串、跳过根 `"0"`，凭证按 `FEISHU_APP_ID` 筛同 App ID 的文件夹飞书凭证。`/api/public/dirsync/feishu/:id`：先查 `dir_source_alias`、套用 id → 父连接，连接收到事件后给所有启用套用各 `scheduleEventSync`（actor `feishu:event`）。
- `dirsync-feishu.js`：`siblingLink`——同一父连接下的其他套用已映射这个 open_id → 同一账号（与企业微信 v3.5.47 同理）。
- 前端：`openFeishuConnModal(fid, connId)`（`fcm-*`：App ID 编辑时只读、Secret 打码、事件订阅 URL / Token / Encrypt Key + 清除、暂停同步、启用）；`openDirConnModal` 新建时先用 `_pickOverlay` 选类型、编辑飞书连接转过去；`openFeishuSourceModal(sid, srcId, presetParent)` 加「通讯录来源」`#fsm-parent`（选套用后隐藏 App ID / Secret / 事件订阅、绑定只列连接 App ID 的凭证），`openDirSourceModal` 预选飞书连接时转过去、企业微信弹窗的来源列表不含飞书连接；`openConnCreateOrgs` 飞书不显示根「全部」、id 保持字符串。
- ⚠️ 测试：run36f 37 项（权限、App ID 校验、打码、同 App ID 重复、编辑不覆盖、组织侧可见、部门树、组织管理员不能套用、不在文件夹 / 类型不符 400、套用不存连接字段、两组织同步 + 同一人一个号、union_id、绑定、连接 / 套用 id 校验 challenge、Token 错、事件后两组织各同步、连接停用套用 400、迁移提示 / 并入 / 成员保留 / 旧地址可用 / 再套用不建号、有套用不能改 App ID、按部门建组织跳过根 + 只设定同 App ID 凭证 + 不重复建号、有套用不能删）；playwright ui36f 13 项（选类型、建连接、面板显示、编辑只读打码、套用隐藏连接字段、保存只存部门、编辑套用、按部门建组织，零 JS 报错、无原生弹窗）；回归 run35f 44（「文件夹暂不支持飞书」改为能建）/ ui35f 12 / run22 62 / run 35。run24（2 项）/ run25（3 项）在 v3.5.58.1 代码上同样失败，是测试脚本与当前种子数据脱节，与本版无关。真实飞书未联调。

## v3.5.59 飞书通讯录同步 + 修飞书登录（用户反馈）

三级版本。用户问「飞书的似乎要买商业版才能实现，用自建应用能不能走」——查证后：飞书收费的是「用外部 IdP 登录飞书本身」（商业版 / 企业版）；用飞书登录本系统、用自建应用读通讯录在免费版即可（官方「自建应用 API 调用量上限」说明：通讯录 / 认证及授权 / 事件订阅类接口不计入额度）。用户选做通讯录同步。
- 新 `server/dirsync.js`：驱动登记 `driver(type)` / `driverOfProvider(provider)`；企业微信驱动包一层 dirsync-wecom 的同名函数（`sync = syncWecom`、`isGoneError = 60111`）。**api.js 里同步源相关的通用路径一律走 `drvOf(src.type)`**：`dirSourceView`、`buildDirSourceCfg(..., {type})` / `dirSourceCfgFromBody(b, old, type)` / `dirScopeFromBody(b, old, type)` / `applyCbFields(..., type)`、`runDirSource`、scope-tree（`b.type` 或源的 type）、`pushExternalSuspend`、`deletionItemAction`、残留成员、异常账号。企业微信专属的（接收事件服务器、重复账号合并、文件夹连接 / 迁移 / 按部门建组织）仍只认 wecom。
- 新 `server/dirsync-feishu.js`：配置字段沿用同名——`corp_id` = App ID（`cli_`）、`secret` = App Secret（没有 write_secret，写操作要应用开「更新通讯录」）、`cb_token` = Verification Token、`cb_aes_key` = Encrypt Key（可选）、`dept_ids` = open_department_id **字符串**（根 `"0"`）。tenant_access_token 按 App ID + Secret 哈希缓存。`fetchScopeTree`：`departments/0/children?fetch_child` → 首项「全部」；40004（根部门不在权限范围）回退 `contact/v3/scopes` 的部门。`fetchDirectory`：所选部门 + 全部子部门逐个 `users/find_by_department`（分页），选「全部」但根部门没权限时按 scopes 部门 + 单独授权成员；`normMember` 统一成 `{userid: open_id, union_id, user_id, employee_no, email: enterprise_email||email, mobile 去 +86, active: !(is_resigned||is_frozen||is_exited)}`。
  - 认人：`ext_id` = open_id（每个应用一份），新列 `dir_source_links.ext_union`（union_id，同企业各应用共用，带索引）。`corpScope(appId)`（同 App ID 的飞书同步源 + 飞书登录凭证，含 env `FEISHU_APP_ID`）/ `corpUsers(appId, openId, {unionId})`（同应用按 open_id，跨应用按 union_id）。`bindProvidersFor` 只收同一 App ID 的凭证。`syncFeishu` 流程照抄 `syncWecom`（applyBind 带 union_id、applyPassword、0 人不移除、只移出本源丢掉且不在其他源的 `source='feishu'` 成员）；组织内 UID `userid` 模式 = 工号，没有用 user_id。
  - `memberStatus`（离职 / 退出 → quit，暂停 → disabled，41012 → gone）、`setMemberEnabled`（PATCH `is_frozen`）、`deleteMember`（DELETE users/:open_id）。
  - 事件：`parseEvent(cfg, headers, raw)`——`{encrypt}` 用 sha256(Encrypt Key) 解 AES-256-CBC（iv = 前 16 字节），有 `X-Lark-Signature` 时校验 sha256(ts+nonce+key+原始 body)；token 取 `header.token` 或顶层 `token`；配了 Key 却收到明文拒绝。路由 `POST /api/public/dirsync/feishu/:id`：challenge 原样回；`contact.(user|department|scope).*` → `scheduleEventSync`；`header.app_id` 不符只记录。⚠️ **`index.js` 的 `express.json` 加了 `verify` 给 `/api/public/dirsync/*` 留 `req.rawBody`**——签名要对原始字节算，json 解析后再 stringify 会对不上。
- `account-lifecycle.js`：`wecomSourceFor` 改为按 provider 平台找驱动（飞书按 App ID 找同步源）；`upgradeBind` 也升级飞书登录绑定；`DONE_WITH` 文案按同步源平台填（`{p}`）。
- 🐛 **飞书登录**（`oauth.js`）：`authen/v2/oauth/token` 的 `access_token` 在响应**顶层**，原来取 `data.data.access_token` 永远为空 → 飞书登录从来没成功过。改为顶层优先、`data` 兜底；不再带 Bearer 头（文档要求只用 client_id/secret）；换 token / 取用户信息失败 → `?error=feishu_failed&code=&hint=`；`findOrCreate` 传 `unionId`；新增 1c 步：飞书凭证 → 封存检查 + `corpUsers` 认到同步账号则补绑。`feishuRedirect(c, req)`：没填回调地址按请求域名拼。飞书接口根地址走 `FEISHU_API_BASE`（测试用）。
- 前端：同步源弹窗类型可选「飞书（企业自建应用）」→ 切到独立的 `openFeishuSourceModal`（编辑飞书源时 `openDirSourceModal` 直接转过去）：飞书后台配置步骤折叠说明、App ID / Secret、字符串部门树（`fsm-*`）、绑定只列同 App ID 凭证、默认组织密码、事件订阅（Verification Token / Encrypt Key + 清除）、暂停同步、上次同步。`_dirScopeText` 把 `"0"` 显示为「全部」；`_dirEventText` 按平台写文案；交接项按钮按 label 显示「在飞书中暂停 / 删除」；残留成员卡改名「企业微信 / 飞书残留成员」（按钮「检查通讯录」「禁用 / 暂停…」「在通讯录中删除…」，混选两种平台时提示分开，请求带 `platform`）；异常账号文案改为企业微信 / 飞书。
- ⚠️ 测试：新 `mock-feishu.js`（3921；分页 2 条一页、`restricted` 模拟权限范围、`noWrite`、`drop`/`add`、网页登录 `F_<x>` 码）+ run35f 44 项（App ID 校验、错 Secret 提示、部门树分页、建源打码 / 回调地址、同步计数 / 邮箱关联 / 工号 UID / 去 +86 / 多部门去重 / 绑定带 union_id / ext_union / 来源 feishu、幂等、同应用登录不新建、别的应用按 union_id 认人并补绑、换 token 失败原因、离开移出、权限受限部门树 / 40004 提示 / 按权限范围同步、编辑打码、URL 校验 challenge、Token 错 / 明文 / Key 错 / 签名错拒绝、事件防抖同步、交接项写飞书 + 核验在职 + 暂停后执行、封存身份不能登录、残留成员列出并删除、停用同步暂停、没写权限提示、异常账号补绑带 union_id、文件夹拒绝飞书、列表 types / bind_choices_feishu）；启动需 `FEISHU_API_BASE=http://localhost:3921 FEISHU_APP_ID=cli_test1234 FEISHU_APP_SECRET=fsecret DIRSYNC_EVENT_DELAY_MS=400`（`scratchpad/e2e/restartf.sh`）；回归 run 35 / run10 36 / run13 10 / run16 22 / run19 35 / run24 27 / run25 19 / run30 17 / run32 15 / run33 13（run26 有 1 项、ui25 在改动前就失败，与本版无关）；playwright ui35f 12 项（类型切到飞书页、加载部门、勾选、指定凭证只列同 App ID、保存字段、卡片行、立即同步 4 人、编辑回填回调地址与打码、上次同步，零 JS 报错、无原生弹窗）+ ui33 / ui34 / ui23 回归。真实飞书未联调。

## v3.5.58.1 修企业微信应用内登录（用户反馈）

四级补丁。用户：「企业微信应用内登录还是行不通」。
- 🐛 `oauth.js` `/wecom/callback` 从不检查 errcode（企业微信出错 HTTP 仍 200）：gettoken / getuserinfo 失败 → `userId` 为 undefined → `findOrCreate` 建号后 `user_oauth.open_id NOT NULL` 绑定失败 → 只显示「企业微信登录失败」，**还留下一个无登录方式的孤立账号**（v3.5.58 异常账号的来源之一）。修：`wecomApi()`（走 `dirsyncWecom.apiBase()`，可指向 mock）+ `WecomLoginError`，errcode 映射 `WECOM_LOGIN_HINT`（40001/40013/40014/40029/40163/41001/42001/50001/60020，60020 附 from ip）→ `/login.html?error=wecom_failed&code=&hint=`；没有 `userid`（非成员只有 openid）→ `error=wecom_not_member`，不建号；`user/get` 失败只影响姓名头像。
- `findOrCreate` 开头：openId 为空直接抛错（所有平台）；`createBoundUser` 改为 `db.transaction`，绑定失败不留空账号。
- `wecomRedirect(c, req)`：凭证没填 `WECOM_REDIRECT_URI` 时用本次请求的（X-Forwarded-）Proto/Host 拼 `/auth/wecom/callback`。
- `login.html`：错误提示追加 `hint`（textContent，无 XSS）+ 错误码；补 `wecom_not_member` / `wecom_not_configured` 文案。
- ⚠️ 测试：mock-wecom3 加 `auth/getuserinfo`（`C_<userid>` / `EXT` / 其他 40029）+ `__ctl` 的 `tokenErr` / `uiErr`；run34 13 项（企业微信内 snsapi_base、回调地址兜底、登录 / 再登录同一账号、40029 / 40001 / 60020 原因与 from ip、非成员拒绝、失败不建号、读不到详情仍登录、无效 state；启动需 `WECOM_CORP_ID=wwgroup WECOM_APP_SECRET=fullsecret WECOM_AGENT_ID=1000002`）；回归 run 35 / run16 22 / run17 9 / run24 27 / run25 19；playwright ui35（企业微信 UA 自动跳、错误原因与非成员提示，零 JS 报错）。真实企业微信未联调——线上仍失败时看登录页显示的错误码。

## v3.5.58 异常账号处理页（用户反馈）

三级版本。用户：「有的用户能从企业微信拉回来数据，却绑定不进来。这种就是异常账号，能走通讯录同步删号就删（管理员二次确认的情况下，有个异常账号处理的 page）。」截图里的账号：无登录方式、不属于任何组织——同步进来的账号在组织 / 同步源被删后（删组织连带清成员与映射、账号保留）就会变成这样。
- `api.js` `anomalyAccounts()`：非公共、非管理员、未合并、`deletion_state IS NULL`，且无密码 / 邮箱 / 手机 / `user_oauth` / `webauthn_credentials`，有组织密码的排除（能登录到组织）。`kind`：有 `dir_source_links` → `unbound`；在组织 → `no_login`；都没有 → `orphan`。每条映射算 `bind_provider`（`corpScope(corp).providers` 里该 UserId 还没被占用的）。
- `GET /admin/anomalies`（Lv.3 或 user.delete 授权）；`POST /admin/anomalies/action`：`bind`（Lv.2，`oauth.bind` 到 bind_provider，审计 `user.anomaly_bound`）/ `delete`（确认语「删除 N 个异常账号」，`wecom: remove|disable|keep`；每条重新判定仍是异常账号；`deleteMode` 权限；先调企业微信（`deleteMember` 60111 视为已删），失败则不删本系统账号；再 `lifecycle.request`，把 ext 交接项 `setVerification` 成 gone / disabled / `kept`（`DONE_WITH.kept` 新增）→ 立即执行或进入审批）。汇总审计 `user.anomaly_action`。
- 前端：管理端菜单「异常账号」（`adm-anomalies`，在「注销与删除」下面）：按类分组、勾选、`补绑企业微信登录（N）`、`删除…`（`_pickOverlay` 选企业微信处理方式，默认一并删除 → `uiConfirm` 名单 → `uiPrompt` 确认语）、「详情」跳用户管理。
- ⚠️ 测试：run33 13 项（三类识别、排除有组织密码 / 已绑定 / 有邮箱、可补绑、补绑成功与无凭证失败、补绑后消失、确认语、一并删除 + 孤立直接删 + 已绑拒绝、企业微信里已不存在、禁用收到 enable 0、保留则列在残留且在职、企业微信失败不删账号并提示管理用 Secret、普通用户 403、审计）；回归 run 35 / run19 35 / run24 27 / run30 17 / run32 15；playwright ui34 8 项（分类、补绑、删除默认一并删除 + 两步确认、列表清空、菜单，零 JS 报错、无原生弹窗）。

## v3.5.57 删除账号时企业微信登录账号也要核验 + 企业微信残留成员清理 + 人员列表高度（用户反馈）

三级版本。用户：「有的用户从 sso 被我删了账号，例如企业微信却没有删干净，其还是（在职）」「这块还是没有显示全」（用户管理左侧列表截图）。
- 🐛 根因：`preflight` 把不和通讯录映射重复的企业微信**登录绑定**做成 `bind` 项（`auto`，删除时自动解除），不挡执行——只用企业微信登录、没被同步过的人（或同步范围外的部门）删号后企业微信里照旧在职。
- `account-lifecycle.js`：`wecomSourceFor(provider)` = `corpOfProvider` → `corpScope.sources`（套用换成父连接，优先有 write_secret / 启用 / 有读 Secret 的）；`upgradeBind(i)` 在 `evalItem`（未执行时）把企业微信 bind 项升级为 `ext`（带 `provider`、`ext_id`、`source_id`）——新申请与已有的进行中申请都生效（旧项无 provider 字段时从 key 解析，`bind:wecom:<凭证id>:<UserId>` 先查凭证是否存在）。企业没有同步源的仍是自动解除。`ext` 项的「已不存在映射即完成」判断对升级项改为看 `user_oauth` 绑定是否还在。原有核验 / 禁用 / 删除按钮（`deletionItemAction`）直接可用。
- 残留：`wecomLeftoverCandidates()` 从 `identity_blocks`（`users.deletion_state='deleted'`）取 dir 项（conn_id）与企业微信 oauth 项（`wecomSourceFor`），按「企业|UserId」去重，`corpUsers` 命中正常账号的跳过。`GET /admin/deletions/leftovers`（Lv.3 或 user.delete 授权；5 路并发 `memberStatus`，≤300 条，不下发 Secret）；`POST /admin/deletions/leftovers/action {action: disable|remove_member, items:[{key}], confirm:'禁用|删除 N 个企业微信成员'}`——每条重新从候选里校验（伪造 / 已恢复 / 被别人用的拒绝），审计 `account.external_suspended/removed` 带 `leftover:true`。⚠️ 彻底清除后封存记录随之删除，那之前删的人这里查不到。
- 前端：「注销与删除」页「企业微信残留成员」卡（`loadLeftovers` / `_loBulkSync` / `leftoverAction`，状态徽章、全选、名单确认 + 确认语）。`.detail-list` `max-height` 改为 `calc(100vh - var(--hdr-h) - 48px)`（sticky 在 .content 的 24px 内边距下，原来 `-170px` 底部空出约 94px）。
- ⚠️ 测试：run32 15 项（登录绑定变成需核验项、未核验不执行、重新核验在职、禁用后执行且收到 enable 0、旧申请读取时升级、无同步源仍自动、残留在职 / 已不存在 / 已禁用、被正常账号使用的不列、不下发 Secret、确认语、伪造 key 拒绝、删除后再查已不存在、普通用户 403、审计）；回归 run19 35 / run23 38 / run24 27 / run25 19 / run30 17；playwright ui32（885 / 700 高：列表底部距窗口 24px、最后一人可达）、ui33 5 项（检查 → 在职 → 禁用确认 → 已禁用，零 JS 报错、无原生弹窗）。

## v3.5.56 公告弹窗加「推送到 Webhook / 群机器人」（用户反馈）

三级版本。用户（发布公告弹窗截图）：「这里没有 webhook 的选项啊」——v3.5.52 的公告推送只受 `QWQ_MESSAGE_NOTIFY_EVENTS` 里的 announcement 类别控制，且默认关，弹窗里看不到。
- `notify.js`：`notifyForce(cat,title,lines)`（只要分组配好就推，不看类别）+ `status()`（ready / group / categories）。
- `api.js`：`GET /admin/announcements` 多回 `webhook:{ready, default_on}`（default_on = 已配置且类别含 announcement）。`pushAnnouncement(ann, sendWebhook, updated)`：停用不推；`send_webhook` true → `notifyForce`，false → 不推，不传 → 新建时按类别开关（兼容旧行为）。POST / PATCH 收 `send_webhook`，回 `webhook_pushed` / `webhook_ready`；PATCH 只有显式勾选才推，标题「公告更新：」。
- 前端：`_annWebhook` 由 `loadAdmAnnouncements` 带回；弹窗 `#an-webhook`（未配置禁用 + 指引文案；新建按 default_on 预勾）；`submitAnnounce` 提交 `send_webhook` 并在 toast 里说明是否推送。⚠️ 管理端左侧菜单仍叫「环境变量」（`adm-env`），文案按菜单实际名称写。
- ⚠️ 测试：run31 11 项（未配置不推 + ready=false、配置后默认不勾、勾选强制推且去 HTML、不勾不推、类别含公告默认勾、类别开但不勾不推、不传按类别、停用不推、编辑不勾不推、编辑勾选推「公告更新」）；回归 run27 12；playwright ui31 6 项（未配置禁用 + 指引、配置后可勾、发布推到 mock，零 JS 报错、无原生弹窗）。

## v3.5.55 用户管理批量操作（用户反馈）

三级版本。用户：「用户管理应该可以勾选住用户，然后批量操作（危险操作会强确认）。」
- `POST /admin/users/bulk {action, ids[≤200], confirm, group_id | tag_ids | delta+reason | reason}`（requireAuth；delete 以外须 `isSysAdmin(req,2)`，delete 逐条走 `deleteMode` + `lifecycle.request`，与单条接口相同，所以被授权 user.delete 的人也能用）。action：`disable / enable / delete / group / tags_add / tags_remove / points`。`BULK_DANGER`（disable 停用 / delete 删除 / points 调整积分）要 `confirm` = `「<动作> <ids 数> 个账号」`，不符 400 并回 `confirm_text`。逐条校验同单条（停用：不能停自己 / 同级或更高管理员；启用：已删除 / 已合并拒绝；积分不能扣成负数；公共账号拒绝），状态没变的计 `skipped`。返回 `{done, skipped, failed, results[{id,name,uid,ok,error?,skipped?,state?,needs_approval?}]}`。审计：逐条照旧（`user.disabled/enabled`、`points.adjusted` 带 `bulk:true`；删除走 lifecycle 自己的事件）+ 一条汇总 `user.bulk_action`。
- 前端：用户列表每行 `.user-sel` 勾选框（点击 stopPropagation，不影响点行看详情）+ 表头 `#user-sel-all`；选择存 `_uSel`（Map，换搜索保留）；`#user-bulk` 栏 → `userBulk(act)`：分组 / 标签用 `_pickOverlay` 选，积分用 `uiPrompt` 填数和说明 → `uiConfirm` 名单（危险操作红按钮）→ 危险操作再 `uiPrompt` 原样输入确认语。失败项 `uiAlert` 列原因并保留勾选，成功全部清除选择。
- ⚠️ 测试：run30 17 项（普通用户 403、缺确认 / 数量不对 400、停用逐条失败自己与不存在、启用跳过已正常、分组 / 分组不存在、加标签去重 / 去标签、积分负数逐条失败 / 加积分写日志、删除超管直接删且自己失败、无权限删除逐条拒绝、未知操作、空选择、汇总审计）；回归 run 35 / run16 22 / run18 19 / run19 35 / run23 38；playwright ui30 10 项（勾选出栏、错确认语不执行、正确确认停用、成功清空、全选、清除、点行不勾选，零 JS 报错、无原生弹窗）。

## v3.5.54 积分排行（用户反馈）

三级版本。用户：「做个积分排行功能，默认打开，管理员可选择开放或关闭，关闭则不显示 tab。」
- `api.js`：`shop_config` 默认加 `leaderboard_on='1'` / `leaderboard_size='50'`（10~100）；`/shop/config` 回 `leaderboard_on`；`POST /admin/shop/config` 收 `leaderboard_on / leaderboard_size`（夹 10~100）。`RANK_WHERE` = 非公共、status active、未合并、`deletion_state IS NULL`；`pointsLeaderboard(limit)`（points DESC, uid_seq ASC）+ `pointsRankOf(u)`。`GET /shop/leaderboard`（requireAuth；关闭 403）回 `{size,total,list[{rank,uid_seq,uid_code,name,avatar,points,me}],me{rank,points}|null}`——不下发内部 id / 联系方式。开放 API `/v1/points/leaderboard` 复用 `pointsLeaderboard`（口径从「仅排除公共账号」收紧为同上）。
- 前端：用户商城 tab `stab-rank` / `shop-rank`（`loadPointsRank`），`loadShop` 按 `leaderboard_on` 显隐，关闭时停在排行页则切回商品、接口 403 也隐藏；管理端积分配置卡「积分排行」（`cfg-rank-on` / `cfg-rank-size`）。dev mock 补 `/shop/leaderboard`。
- iOS：`APIClient.leaderboardOn / leaderboard`；`ShopTabView`「更多」里按开关显示「积分排行」→ `LeaderboardView`（ShopExtraViews.swift，奖牌 / 我的名次 / 高亮本人）。靠 GitHub Actions 编译验证。
- ⚠️ 测试：run29 11 项（默认开放、排序、排除公共 / 停用 / 删除、我的名次、不下发 id 邮箱、普通用户不能关、关闭后 config false + 接口 403、size 夹到 10、只给前 N 名且榜外仍有名次）；回归 run 35 / run3 25；playwright ui29 7 项（tab 默认显示、表格与名次、管理端开关、关闭后 tab 消失，零 JS 报错、无原生弹窗）。

## v3.5.53 组织名称唯一（用户反馈）

三级版本。用户：「存在同名组织，则不能再创建。那是被占用了。」（截图里同名组织出现两次。）
- `api.js` `orgNameKey(n)` = NFKC（全角括号 / 全角空格归一）+ 去空白 + 小写；`orgNameTaken(name, exceptId)` 遍历 `oauth_subjects` 比对。`POST /admin/oauth-subjects` 同名 → 409 `{code:'name_taken', existing_id}`；`PATCH` 只有名称（按 key）变了才查重，所以升级前已重名的组织仍能保存其他字段；空名 400。`create-orgs` 逐部门查重（含同一请求内重复），同名跳过进 `skipped[]`，全跳过 409、不写审计。
- ⚠️ 没加数据库唯一索引：存量数据可能已重名，加索引会让启动失败；也没自动改名，交给管理员处理。**以后新增建组织入口要调 `orgNameTaken`。**
- 前端：`_orgNameKey` 同规则；组织卡片「⚠️ 重名」标记（`loadOauthSubjects` 里算 `_dupNames`）；`openConnCreateOrgs` 部门树里同名部门禁用 + 「已有同名组织」，结果提示跳过数。
- ⚠️ 测试：run28 14 项（同名 409、括号宽度 / 空格同名、改成占用名 409 且不生效、保留原名可保存、同组织只改括号宽度可以、空名 400、旧重名数据改其他字段 / 改新名、按部门建跳过同名与请求内重复、全同名 409）；回归 run 35 / run2 16 / run3 25 / run9 26 / run11 15 / run16 22 / run22 62 / run25 19；playwright ui28 6 项（重名标记、同名部门禁用，零 JS 报错、无原生弹窗）。

## v3.5.52 系统通知：经 QWQ Message 推到 Webhook / 群机器人（用户反馈）

三级版本。用户：「消息分发支持 webhook。」——QWQ Message 的分发方式除短信 / 邮件外还有 WEBHOOK / FEISHU / DINGTALK / WECOM 群机器人，调用同一个 `/api/v1/send {group, content}`（见其 API.md 第 6 节；渠道可配请求体模板 `{{变量}}` 与 `X-Signature` 签名）。
- 新 `server/notify.js`：`QWQ_MESSAGE_NOTIFY_GROUP`（分组编号，空 = 不推）+ `QWQ_MESSAGE_NOTIFY_EVENTS`（类别 `account/merge/grant/dirsync/backup/kyc/system/announcement`，`all` 全部，空 = 除 announcement 外全部）。`notify(cat, title, lines)` 异步、不抛错；发送体 `{group, subject:'[QWQ SSO] 标题', content:多行纯文本(含时间 按 WATERMARK_TZ / 站点 BASE_URL), variables:{event,title,time,site}}`，复用 `message.dispatch`（地址 / 密钥 / 出站统计照旧）。`testNotify()` 等待返回。
- 事件来源：`audit.js` 的 `audit()` 写完存证后 `require('./notify').fromAudit(type, opts)`（懒加载避免循环依赖；未配置分组直接返回）——映射 `account.deletion_requested/deleted/restored/purged`、`user.merged/merge_undone`、`admin.grant_added/removed`、`backup.run`（有失败目标才推）、`kyc.account_limit`、`system.update_applied`，subject（uid_seq）/ actor（`admin:<seq>`）反查成「姓名（UID）」。直接调用：`runDirSource` 失败（`prevState.ok !== false || prevState.error !== err` 才推，防定时同步刷屏）、成功但 `duplicates` 与上次不同；`POST /admin/announcements` 新建且启用时推（去 HTML、≤300 字 + 外链）。
- 接口 `POST /admin/notify/test`（Lv.1；没配地址密钥 / 分组 400，分发中心报错 502 原样带回）。前端 ENV_GROUPS 新组 `qwq_notify`（category msg）+ 通用 `g.footer`（卡片底部放「发送测试通知」→ `testNotify()`）；init.js ENV_KEYS 同步。
- ⚠️ 测试：mock-hub.js（3920，`/__sent` 看收到的请求）+ run27 12 项（没填分组 400、Lv.2 403、测试通知分组 / subject / variables、分发中心报错带回、注销申请推送带账号名、授权推送、同步失败只推一次、公告默认不推 / 开了推且去 HTML、类别过滤、分发中心挂了业务照常）；进程内 fromAudit：备份失败只列失败目标、删除带封存数、合并带「企业微信重复账号合并」；回归 run 35 / run10 36 / run19 35 / run22 62 / run23 38 / run24 27 / run25 19；playwright ui27：卡片 + 测试按钮推到 mock，零 JS 报错、无原生弹窗。真实分发中心 Webhook / 群机器人未联调。

## v3.5.51 文件夹资源「交给」而非「套用」+ 文件夹凭证按组织使用 + 按部门建组织（用户反馈）

三级版本。用户：「把组织凭证/通讯录权限迁移给文件夹后，默认不是套用了，而是把这些给了文件夹，要使用再由组织设定。可以用文件夹已有凭证/通讯录权限绑定到现有文件夹内组织，或勾选回传的部门（比如企业微信）自动创建组织。」
- **同步源迁移**（`POST /admin/org-folders/:id/migrate`）：没有同企业连接 → 原同步源**就地**变成文件夹连接（`subject_id=''`、`folder_id`、`parent_id=NULL`、config 只留 CONN_KEYS、state 清空；id 不变 → 旧回调地址直接是连接）；有 → 回调 / 管理用 Secret 缺的带过去，映射 `UPDATE OR IGNORE` 挪到连接 id 下，原同步源删掉，写 `dir_source_alias(old_id → conn_id)`（`dirEventSource` 和 GET 校验都先查 alias）。两种都删 `dir_sync_applied`。组织成员保留。挪到连接上的映射不参与任何组织的同步 / 移出（`stillSynced` 按 subject 查，连接 subject 为空），只供 `corpUsers` 认人——组织再套用时 created=0。
- **文件夹凭证按组织使用**：新表 `folder_cred_orgs(provider_id, subject_id)`；`oauthProviders.orgsUsing/usedBy/setUse/unsetUse/clearUsesOf/clearUsesBy`。一次性迁移：表首次创建（建表前查 sqlite_master）时把已有文件夹凭证设定给当时文件夹里的所有组织。消费方：`dirsync-wecom.wecomCredsOf`（→ `loginProviderChoices` / auto 绑定）改为「本组织凭证 + folder_cred_orgs 里本组织的」；`oauth.mergeScopeKeys` 组织凭证 = 本组织 + 本组织使用的文件夹凭证，文件夹凭证 = 自己 + 使用它的组织的凭证（及它们使用的文件夹凭证）。登录页列出照旧（已绑用户照常登录）。组织换文件夹删掉对旧文件夹凭证的使用；删组织 / 删凭证连带清。凭证迁移不设定任何使用。
- 接口：`PUT /admin/folder-credentials/:id/orgs {subject_ids}`、`POST /admin/orgs/:sid/folder-credentials/:cid {use}`（都 Lv.2；只能是文件夹里的组织；审计 `folder.credential_orgs`）；`POST /admin/folder-dir-sources/:id/create-orgs {depts:[{id,name}], run, bind_creds}`（每部门：`oauthSubjects.insert` + 放进文件夹 + `insertUse`（dept_ids=[id]、bind auto、uid userid、idonly_create）+ 同企业 wecom 文件夹凭证 setUse；run 时逐个 `runDirSource`；审计 `folder.orgs_created`）。`folderResources.credentials[].orgs`。
- 前端：组织卡片列出所在文件夹的凭证行（📁 · 本组织在用 / 未使用 · 使用 / 不再使用 → `useFolderCred`）；文件夹面板凭证行「使用的组织：…」+「设定使用的组织…」（`openFolderCredOrgs`），连接行「套用到组织…」（`openConnUseModal` → `openDirSourceModal(sid, null, connId)` 预选来源）/「按部门建组织…」（`openConnCreateOrgs`：拉 scope-tree 缩进勾选 + 立即同步）；通用 `_pickOverlay`（沿用 ui-dlg 样式）。迁移提示文案改为「交给文件夹，组织要用再设定」。
- ⚠️ 测试：run22 改为新语义 62 项（设定使用前 bind_choices 无文件夹凭证、组织管理员不能设定、设定后有、凭证带 orgs、迁移后原源删除且组织无同步源、映射挪到连接、成员保留、旧回调地址经 alias 可用、再套用 created=0 不新建账号、凭证迁移后无人使用、文件夹面板设定 / 不在文件夹 400、按部门建两个组织 + 套用 + 凭证使用 + 同步无重复建号、就地变连接 id 不变、D 不再有同步源）；升级回填（删表后重启 → 文件夹里两个组织都设定使用）；回归 run 35 / run8 20 / run9 26 / run10 36 / run11 15 / run12 25 / run13 10 / run16 22 / run17 9 / run18 19 / run19 35 / run20 12 / run23 38 / run24 27 / run25 19 / run26 8；playwright ui26：使用、设定使用的组织、按部门建组织、套用到组织预选来源，无原生弹窗、零 JS 报错。真实企业微信未联调。

## v3.5.50 企业微信「同企业 + 同 UserId = 同一人」+ 读写两份 Secret + 系统内弹窗（用户反馈）

三级版本。用户：「从企业微信回来，有的成员数据被拉了两遍回来」「企业微信的通讯录 secret 其实应该要有两份，自建应用用来读取，通讯录的用来增删停」「这种弹出框全部做成系统内部的吧」。
- 🐛 **重复建号根因**：同步认人只看本源映射 → 同文件夹兄弟套用 → **本源要绑定的那几个登录凭证**（bindProviders）→ 邮箱 / 手机；企业微信不给邮箱手机，所以成员用同企业的**另一个**登录凭证（本站默认 `wecom` / 文件夹凭证 / 别的组织凭证）登录过、或同一企业被两个不在同一文件夹的组织各自同步（尤其 `bind_mode: none` 或没配登录凭证）时认不出 → 再建一个。登录侧 `findOrCreate` 同理：只查本凭证的 `user_oauth`，企业微信没有 unionid / 邮箱，直接新建。
- `dirsync-wecom.js` 新：`corpScope(corpId)`（该企业的所有同步源 id——用 `effectiveCfg` 判 corp，含文件夹连接与套用——和所有企业微信登录凭证 provider key，含 env `WECOM_CORP_ID` 的 `wecom`）、`corpUsers(corpId, extId, {scope})`（按 `ext_id` / `open_id` **COLLATE NOCASE** 找已对应的账号，排除公共 / 已合并 / 已删除）、`corpOfProvider(providerKey)`、`findCorpDuplicates()`。同步匹配链在 bindProviders 之后、邮箱之前加 `corpUsers`；每个成员顺带数一下「同 UserId 还挂着别的账号」→ `state.duplicates`。`oauth.findOrCreate` 第 1b 步：企业微信凭证且精确查不到 → 先查该企业通讯录的封存（dir block）→ `corpUsers` 命中则把本凭证绑上去返回。
- 遗留重复：`GET /admin/dir-duplicates`（Lv.3）、`POST /admin/dir-duplicates/merge {groups:[{key,target?}]|all, confirm:'合并账号'}`（Lv.1，逐组 `mergeUsers` via `dir_duplicate`，可撤销；失败逐条返回原因，如管理员账号不能被并）。建议保留：管理员 > 有密码 > 实名 > 2FA > 邮箱 > 手机打分，再按编号最小。前端「组织管理」页顶部 `#dir-dup-card`（`loadDirDuplicates` / `mergeDirDuplicates`，单选保留账号）；同步结果文字带「⚠️ 重复账号 N」。
- **两份 Secret**：`CONN_KEYS` 加 `write_secret`（「通讯录同步」Secret，管理用，可选）；`writeCfg(cfg)` = 有 write_secret 用它、否则退回 secret。`setMemberEnabled` / `deleteMember` 走 writeCfg，读（同步、`memberStatus`）仍用 `secret`。`dirSourceCfgFromBody` 收 `write_secret`（打码 / 留空不改，`clear_write_secret` 清除），文件夹连接 `buildDirConnCfg` 带上，迁移并入已有连接时连接没有就带过去；两处视图打码。`ERR_HINT` 加 48002 / 48004（提示填管理用 Secret + API 编辑通讯录 + 可信 IP）。两个弹窗（同步源 `dsm-wsecret` 在 `#dsm-conn` 里，套用时隐藏；文件夹连接 `dcm-wsecret`）。
- **撤销合并顺序放宽**（用户：「撤销要求先撤一条不合理」）：`undoBlocker` 不再按「账号有交集」拦，改为比对两次合并的改动日志（`journalTouches`：tbl|rid → 是否整行插入 / 删除 + 改过的列）——后一次未撤销的合并与本次**同一行被插入 / 删除**或**改了同一行同一列**才拦（`IGNORE_COLS` updated_at 不算，`ADDITIVE` points 不算）；后一次没有日志则仍拦。`undoMerge` 的 U 回放：累加列（points）当前值≠合并后值时按 `cur - (new - old)` 扣回。run23 改为：两次并进同一保留账号可先撤早的、积分 111→101→100；保留账号后来被并进别人 → 仍要求先撤后一次。
- **系统内弹窗**：`dashboard.html` 新 `uiAlert / uiConfirm / uiPrompt`（Promise；`_uiDialog` 记下打开前的选区与焦点、关闭时恢复——富文本 `rtLink/rtImage/docInsert*` 的 `execCommand` 依赖它；删除类文案自动红按钮、含「密码 / 口令」的输入自动密码框；回车确定、Esc / 点遮罩取消；opts `{title, danger, password, multiline}`）。全文件 91 处原生 `alert/confirm/prompt` 用 acorn 改写为 `await ui*`，所在 7 个函数改 async。**以后一律用 ui*，不要再写原生弹窗。**合并相关文案「此操作不能撤销」改为可在期限内撤销。
- ⚠️ 测试：run25 19 项（另一个组织的凭证登录认到同步账号且补绑、UserId 大小写、同企业另一组织不绑凭证的同步源不重复建号、别家企业同名 UserId 是另一人、Lv.2 看得到重复列表 / 不能合并、建议保留、同步提示、确认词、合并后映射转移、合并记录与撤销）；run26 8 项（两份 Secret 打码 / 分存 / 读 Secret 同步 / 停用用管理 Secret 推送 / 留空不覆盖 / 清除 / 缺管理 Secret 的报错提示 / 文件夹连接）；回归 run 35 / run8 20 / run9 26 / run10 36 / run12 25 / run13 10 / run16 22 / run17 9 / run19 35 / run20 12 / run22 48（需 `DIRSYNC_EVENT_DELAY_MS=400`）/ run23 33 / run24 27；playwright ui25：重复账号卡 → 系统内确认框 + 确认词 → 合并，同步源弹窗管理用 Secret，Esc 取消、无原生弹窗、零 JS 报错。真实企业微信未联调。

## v3.5.49 注销 / 删除账号时三方账号一并摘除 + 交接项系统核验（用户反馈）

三级版本。用户：「注销或删除账号后，其三方账号并没有被删除。我测试的案例是企业微信，用户勾选不能证明什么，只要还在库里就是个问题。」
- **执行删除 = 摘除 + 封存**（`account-lifecycle.detachExternal(userId, deletionId)`）：`user_oauth`、`dir_source_links` 全行快照进 `account_deletions.ext_snapshot`，删掉这两张表的行和 `dir_sync_applied`，并写 `identity_blocks`（kind `oauth`：provider + open_id；kind `dir`：`conn_id` = 文件夹连接 id 或组织同步源 id（`connOf`，套用之间共用）+ UserId）。顺序：`executeDeletion` 先调 `onDeleted` 钩子（`pushExternalSuspend` 要靠映射找到企业微信成员去禁用），**再**摘除。`restore()` 先 `reattachExternal`（被别人占用的跳过）+ 删封存，再调 `onRestored`（启用企业微信成员同样要靠映射）。`purge()` 遍历 user_id 列时自然删掉 `identity_blocks` 与 `account_deletions`，库里不留。`detachLegacyDeleted()` 启动 4 秒后给升级前已删除、绑定还挂着的账号补摘。审计 `account.deleted` detail 带 `detached{oauth,links}`。
- **封存生效点**：`oauth.js findOrCreate` 开头查 `identity_blocks`（命中 → `creq._blockedIdentity`，`loginSuccess` 跳 `?error=account_deleted`；绑定模式命中 → 绑定失败「属于已删除的账号」）；按 unionid / 邮箱认到 `deletion_state` 为 deleted/purged 的账号也拒绝、不挂新绑定。`dirsync-wecom.syncWecom`：成员 UserId 在封存里（按 `source.parent_id || source.id`）→ `out.blocked++` 跳过（不建号不关联）；按邮箱 / 手机认到已删除账号同样跳过。同步状态带 `blocked`。`user-merge.checkMerge` 拒绝 `deletion_state` 非空的账号。
- **交接清单系统核验**（`evalItem`，`getReq` 每次实时算，存的勾选只对 app 项有效）：`ext` = 有核验记录且状态为 gone / disabled / quit，或映射已不存在（同步已不包含他）；`bind`（与通讯录不同 UserId 的登录绑定）= 自动完成（删除时自动解除）；`orgadmin` / `groupadmin` / `device` = 查表；`app` = 管理员确认。申请执行后未完成项显示「已随账号删除处理」。旧清单项无 `check` 字段时从 key 推。`setChecklist` 只收 app 项（其余 400「由系统核验」）。
- **核验 / 处理接口**：`POST /admin/deletions/:id/item {key, action}`（Lv.3 或 user.delete 授权）：ext → `recheck`（`dirsyncWecom.memberStatus`：user/get → active/disabled/quit，60111 → gone，48009 受限 Secret → list_id 里没有 = gone，否则 unknown）/ `disable`（`setMemberEnabled(false)`）/ `remove_member`（新 `deleteMember`：user/delete）——自己调企业微信成功即记为 disabled / gone（受限 Secret 能写不能读状态）；`remove_role`（取消组织 / 分组管理员）、`release_device`（清设备所有者）。本人 `POST /user/account/deletion/item` 只能 recheck；`POST /user/account/deletion/checklist` 一律 403。审计 `account.external_suspended/external_removed/handover_done`。`GET /admin/users/:id/deletion` 多回 `blocked[{kind, where, ext_id}]`。
- 前端：`_delChecklistHtml(list, {admin, onToggle, onAction})`——✓/✗ + 核验说明 + 按钮（重新核验 / 在企业微信中禁用 / 在企业微信中删除…（confirm）/ 取消他的管理员职责 / 从他名下回收），app 项管理员才有「已交接」勾选；本人页只有重新核验；「注销与删除」页未完成的清单默认展开并显示 x/N。已删除账号详情列出被封存的外部账号。登录页错误 `account_deleted`。
- ⚠️ 测试：run24 27 项（清单项类型、本人 / 管理员都不能勾通讯录项、本人不能操作企业微信、重新核验在职 → 未完成、冷静期满未核验不执行、取消组织管理员自动完成、在企业微信禁用 → 立即删除且收到 enable 0、绑定 / 映射摘掉、封存两条、管理端可见、成员重新启用后同步跳过不建号、封存身份登录拒绝不建号、按邮箱认到已删除账号拒绝、恢复后放回 + 解封 + 同步认回、在企业微信删除成员 → 核验已没有该成员 → 执行、彻底清除后一条不剩、升级前已删除账号补摘、审计）；run19 改为新流程 35 项；回归 run 35 / run8 20 / run9 26 / run10 36 / run12 25 / run13 10 / run16 22 / run17 9 / run18 19 / run20 12 / run22 48 / run23 33；playwright ui23：本人卡重新核验显示「仍在职」、管理端清单「在企业微信中禁用」后 1/1，零 JS 报错。mock-wecom3 加 `user/delete`。真实企业微信未联调。

## v3.5.48 撤销合并 + 注销与删除批量操作（用户反馈）

三级版本。用户：「注销与删除这里应该做个勾选，然后二次确认后一键删除」「合并用户做个回撤功能吧，合并错了可不行；我刚刚合并了我的四个用户，有一个不知为何居然不见了」。
- **撤销合并**（`user-merge.js`）：`mergeUsers` 进事务前 `startJournal(mergeId)` 给每张表（跳过 `merge_journal/merge_records/audit_chain/sqlite_sequence`、WITHOUT ROWID 表）建 TEMP 触发器 AFTER INSERT/UPDATE/DELETE，把每行改动写进 `merge_journal(merge_id, tbl, op I/U/D, rid=rowid, old_row, new_row)`；行存成 `json_object(列名, json_array(typeof, 值))`，BLOB 存 hex。外键级联删除也会触发，所以一并记下。`finally` 里拆掉触发器（事务外的改动不会被记）。合并本身记一行 `merge_records`（target 快照、sources 快照含 id/uid/姓名/邮箱/手机、via、actor、actor_uid、journal 1/0）。
  - `undoMerge`：事务里 `defer_foreign_keys=ON`，按 seq 倒放：I → 按 rowid 删；D → 同 rowid 原样插回（行已存在则跳过计 skipped）；U → **只改回「当前值 = 合并后的值」的字段**，合并后又被改过的保留现值计 `kept_fields`。成功后 `undone_at` + 删日志。唯一约束等冲突会让整个事务回滚并报错。
  - `undoBlocker`：已撤销 / 无日志（过期或旧合并）/ **同一批账号之后还有没撤销的合并**（按 rowid 判断，要倒序撤）。
  - `MERGE_UNDO_DAYS`（默认 30，0~365，0 = 不记日志）；`purgeMergeJournals` 启动 8 秒后 + 每 6 小时：过期或保留账号已不存在的日志删掉、`journal=0`（日志里有被删账号的完整数据，包括密码哈希，不能长留）。ENV_GROUPS `acctdel` + init.js 同步。
  - ⚠️ 撤销不收回合并时推给第三方应用的 `user.merged` 通知、不恢复被作废的 OIDC 令牌（用户重新授权即可）。
- 接口：`GET /admin/merges[?user=保留账号id]`（系统管理员 Lv.3 看全部，另附审计存证里本版之前的 `user.merged` 作为只读 `legacy` 项；其他人只看自己做的）、`POST /admin/merges/:id/undo {confirm:'撤销合并'}`（超管或 `actor_uid` 本人；审计 `user.merge_undone`）。四个合并入口（org_admin / kyc_self / super_admin / oauth self_bind）都传 `actor/actorUid/via`，审计 detail 带 `merge_id`。
- **批量**：`POST /admin/deletions/bulk {action: purge|restore|approve|reject|cancel, ids[≤200], confirm}`，确认词 purge「彻底清除」/ approve「批准删除」/ restore「恢复账号」；purge 只超管；其余逐条套用单条接口的权限判断；返回 `done/failed/results[{name, ok, error}]`。
- 前端：「注销与删除」页可勾选的记录（进行中 + 已删除且账号还在）前加勾选框，顶部 `#del-bulk` 栏（全选 / 已选 N / 批准 驳回 撤回 恢复 彻底清除，按选中类型显示数量）→ `bulkDeletion`：confirm 名单 → prompt 确认词 → 失败项 alert 原因。同页新增「账号合并记录」卡（`loadMerges` / `_mergeRowHtml` / `undoMerge`）；用户详情加「合并记录」区（`renderUserMerges`，只在有记录时出现）。合并面板「此操作不能撤销」文案改为可在期限内撤销。
- ⚠️ 「四个合并后一个不见了」：v3.5.46.1 起被合并的账号会被删除，本版之前没有改动日志，**无法在系统里撤销**；合并记录页会从审计存证列出当时并入了哪些 UID（含绑定企业微信时自动并入空壳账号 `self_bind`），要找回只能用数据备份。
- ⚠️ 测试：run23 33 项（合并返回 merge_id、触发器拆掉后不再记日志、记录列表 / 按账号查 / Lv.2 看得到但不能撤销别人的、权限与确认词、撤销后账号 / 绑定 / 组织 / 备忘录 / 登录记录 / 积分明细原样、合并后改过的字段保留、被并入账号能登录、不能重复撤销、外键完整、两次合并要倒序撤、过期不能撤、组织管理员撤销自己的合并、批量彻底清除确认词 / 403 / 逐条失败原因、批量恢复、批量批准、审计）；回归 run 35 / run10 36 / run16 22 / run17 9 / run18 19 / run19 34 / run20 12 / run21 19（需 mock-r2）/ run22 48；playwright ui22：全选 → 彻底清除（3）→ 名单确认 + 确认词 → 清除；合并记录 → 撤销合并 → 三个账号恢复，零 JS 报错。

## v3.5.47 文件夹共用通讯录与登录凭证 + 逐条迁移（用户反馈）

三级版本。用户：「企业微信这样的通讯录同步数据，统一归到文件夹里，方便其他同文件夹组织套用。……现在已有的需要管理员手动确认迁移提示再迁移。」问过用户：共用一份通讯录、各组织选部门；凭证也可放文件夹；已有的逐条提示、管理员确认。（跨系统联邦共享能力排 v3.5.48。）
- **数据**：`dir_sync_sources` 加 `folder_id` / `parent_id`。文件夹通讯录「连接」= `folder_id` 有值、`subject_id=''`，config 只存连接字段 `CONN_KEYS = corp_id/secret/cb_token/cb_aes_key/push_suspend`；组织「套用」= 普通同步源行 + `parent_id` 指向连接，config 只存组织级字段（部门、绑定、默认密码、移出、频率、uid_mode、idonly_create）。`dirsync-wecom.effectiveCfg(src)` = 连接字段 + 自己的字段，**所有读同步源配置的地方都要走它**（runDirSource、定时、回调改 UserId、pushExternalSuspend、视图）。`oauth_providers.folder_id`：文件夹凭证 `subject_id=NULL`；启动时「无主体凭证建同 id 主体」的老迁移已排除 folder_id 非空的。
- **匹配**：套用之间按 ext_id 互认（`siblingLink`：同 parent 的其他套用里已映射的 UserId → 同一账号），一人同在两组织部门不会建两个号。移出判断仍按组织（`stillSynced`）。
- **凭证**：`wecomCredsOf(subject)` 含所在文件夹的凭证（`loginProviderChoices` 标 `folder:true`，auto 绑定也会选到同企业的文件夹凭证）。`oauth.js getCred` 文件夹凭证只看文件夹还在；同人合并范围 `mergeScopeKeys`：组织凭证 = 本组织 + 所在文件夹凭证，文件夹凭证 = 文件夹凭证 + 文件夹里各组织凭证；env 默认凭证仍全局邮箱合并。⚠️ 组织的登录策略（IP / 时段 / 强制 2FA）按凭证所属主体执行，**文件夹凭证没有主体，不受组织策略约束**（迁移提示里写明）。登录页文件夹凭证无名称时显示文件夹名。
- **接口**（文件夹资源全部系统管理员，读 Lv.3 / 写 Lv.2）：`GET /admin/org-folders/:id/resources`；`POST /admin/org-folders/:id/dir-sources`（同企业不能建两份）、`PATCH/DELETE /admin/folder-dir-sources/:id`（有套用时不能删、不能改 corp_id；只传 enabled = 启停）、`POST .../scope-tree`、`POST .../run`（跑所有启用套用）；`POST /admin/org-folders/:id/credentials`；`POST /admin/org-folders/:id/migrate {kind:dir_source|credential, id, confirm:'迁移'}`。`GET /admin/oauth-subjects` 的 `folders[]` 带 `dir_connections`（含 `uses`）/ `credentials` / `migrations`。组织侧：`GET /admin/orgs/:sid/dir-sources` 多回 `folder_connections`（只名称 + corp_id）与 `can_use_folder`；`POST` 带 `parent_id` = 套用（**须系统管理员**——文件夹 Secret 看得到整个企业，组织管理员不能自己挑部门）；套用的非启停 PATCH、按文件夹连接的 scope-tree 也须系统管理员；组织管理员可启停 / 立即同步 / 删除本组织套用。
- **迁移**：同步源迁移 = 同文件夹已有同企业连接就并入（连接没回调时把这份的 Token/AESKey 带过去；Secret 不同以连接为准，提示 `secret_differs`），否则新建连接（连接字段 + event_state 搬过去）；然后 `setParent` 把原同步源变成套用——**id 不变**，所以映射、`dir_sync_applied`、旧回调地址（`dirEventSource` 遇到套用 id 转到父连接）都照旧。凭证迁移 = `moveToFolder`（provider key 不变，已绑用户照常登录）。
- **回调**：`/api/public/dirsync/wecom/:id` 认三种 id：组织自己的源 → 自己；文件夹连接 → 它的所有启用套用各 `renameExtId` + `scheduleEventSync`；套用 id → 父连接。校验 / 事件状态记在连接上。
- **护栏**：套用着文件夹通讯录的组织不能移出文件夹；文件夹上有通讯录 / 凭证时不能删文件夹；连接停用 → 套用同步 400、定时跳过。
- 前端：组织管理选中文件夹（或「全部」里有资源的文件夹分节）显示「📁 文件夹共用」面板（`folderResourcesHtml`：连接行带「套用：组织（部门）」+ 全部同步 / 启停 / 编辑 / 删除；凭证行；💡 可迁移项逐条「迁移…」prompt 输入确认词）；`openDirConnModal`；`openOauthModal(null, cred, folderId)`；同步源弹窗新建时「通讯录来源」下拉选套用（隐藏企业 ID / Secret / 回调 / 停用同步），编辑套用时显示只读提示；同步源行「📁 套用「X」」标记；组织卡片无自己凭证时提示用文件夹共用的。
- ⚠️ 测试：run22 48 项（权限、打码、同企业重复、套用不存连接字段、跨组织同人同账号、组织管理员只读 / 启停、一条事件两组织各同步一次、文件夹凭证登录页 / 绑定 / 发起登录、护栏四项、编辑打码、迁移提示 / 确认词 / 并入 / id 与映射保留 / 旧回调地址、凭证迁移、新建连接迁移）；回归 run 35 / run8 20 / run9 26 / run10 36 / run12 25 / run13 10 / run16 22 / run17 9 / run18 19 / run19 34（需 `DB_PATH`，测试进程直接调 tick）；playwright ui21：面板、迁移、套用弹窗隐藏连接字段、部门树、保存，零 JS 报错。真实企业微信未联调。

## v3.5.46.1 合并后不再保留原账号 + 用户列表显示不全（用户反馈）

四级补丁。用户：「某主账号被合并后，原账号仍然被保留，这是不正确的」「账号详情左边选择人员的区域没有显示全」。
- 🐛 `user-merge.js` 新 `absorbAndDelete(sourceId, targetId)`（在合并事务里、原有定向搬迁之后调用）：遍历 sqlite_master 所有表，`user_id`/`owner_id` 列 `UPDATE OR IGNORE` 转给保留账号、撞唯一约束剩下的删掉；`NOT_MOVED`（2FA 恢复码、kyc_pending、account_deletions、dir_sync_applied、应用授权/令牌/授权码）只删不转——**2FA 恢复码绝不转**（否则能绕过保留账号的两步验证）；`owner_user_id/created_by/granted_by/requested_by/approved_by/issued_by/escort_user_id/done_by` 改指向保留账号；`users.merged_into` 指向它的改指向保留账号；最后 `DELETE FROM users`。万一还有外键挡住就退化成抹掉个人信息的占位（`deletion_state='purged'`）。`mergeUsers` 返回 `moved.deleted`。
- 升级前的「已合并」行：`absorbLegacyMerged()` 启动 3 秒后跑一次（保留账号还在的才处理）。`GET /admin/users` 过滤掉 `merged_into` 非空与 `purged` 的行。前端合并面板 / 实名合并文案改成「会被删除，历史转到保留账号」。
- 🐛 列表：`.detail-list` 原来 `max-height:420px` 且 `.detail-grid` 有 `overflow:hidden`（会让 sticky 失效）。改为 grid `align-items:start`、去掉 overflow hidden，列表 `position:sticky;top:0;max-height:calc(100vh - 170px)`，顶部加 `.detail-list-count`「共 N 人」。
- ⚠️ 测试：run16 改为验证账号已删除 + 被合并账号的积分明细也转过来 + 不出现在列表（22 项）；run20 12 项；旧「已合并」行启动清理（登录日志、三方绑定转到保留账号、行删除）；playwright 93 人列表：页面滚动后列表钉在顶部（48→778px）、最后一人可见。

## v3.5.46 数据备份（本地目录 / Cloudflare R2，可多个同时开启）（用户反馈）

三级版本。用户：「做一个数据备份功能，支持服务器本地储存和 r2 存储桶，同样允许添加多个，允许同时开启。」
- 新 `server/backup.js`：`snapshot(db, dataDir)` = better-sqlite3 在线 `db.backup()` 到临时文件 → gzip（临时文件 finally 删）；`encrypt/decrypt`：`'QWQBK1' + salt16 + iv12 + tag16 + AES-256-GCM`，key = scrypt(口令, salt)；`sigv4()` 自写 S3 SigV4（**已对上 AWS 官方 GET Object / List / PUT 三组测试向量**，不引 SDK）；R2 用 path-style `https://<账户ID>.r2.cloudflarestorage.com/<bucket>/<key>`、region `auto`，`r2List` 解析 ListObjectsV2 XML（分页）；本地 `localDir`（空 = `<DB 目录>/backups`，相对路径相对 DB 目录）。文件名 `qwq-sso-YYYYMMDD-HHMMSS.db.gz[.enc]`（`FILE_RE`，下载也只认这个格式 = 防路径穿越）。`writeTo` 写完按 `keep` 删最旧的。也是命令行：`node server/backup.js decrypt in out 口令`。
- 表 `backup_targets(id,type local|r2,label,config JSON,enabled,interval_hours 0=只手动,keep 0=不清理,state,last_run_at)`；`db.js` 现在导出 `DB_FILE`/`DATA_DIR`。
- 接口（全部 `requireAdmin(1)`）：`GET/POST /admin/backups`、`PATCH/DELETE /admin/backups/:id`（删目标不删已有文件）、`POST /admin/backups/run {target_id?}`（不带 = 所有启用目标；**一份快照写给本次所有目标**；进程内锁，并发 409）、`GET /admin/backups/:id/files`、`GET /admin/backups/:id/files/:name`（下载，本地读 / R2 GET）。配置校验：R2 桶名 / 账户 ID 32 位或自定义 endpoint（须 https，localhost 例外给测试用）/ AK SK；`secret_access_key` 与口令视图打码，打码串 / 留空不改，`clear_passphrase` 取消加密，口令 ≥ 8 位。定时 `runDueBackups` 每 10 分钟：`last_run_at <= now - interval_hours`。审计 `backup.run/target_added/target_removed/downloaded`。
- 前端：管理端「数据备份」页（`adm-backups`，SUPERADMIN_ONLY）：目标卡（类型 / 位置 / 频率 / 保留 / 加密 / 最近结果）+ 立即备份 / 查看文件（下载走 fetch + Bearer → blob）/ 编辑 / 启停 / 删除；添加 / 编辑弹窗按类型切换字段。AUDIT 标签补本批（备份、注销删除各事件、kyc.account_limit）。
- ⚠️ 备份包含 env_config 里的全部密钥；容器本地盘重部署即清空（页面有提示）。**恢复没有做成网页按钮**（替换正在运行的库风险大）：停服务 → 解密 / 解压 → 替换 `DB_PATH` 指向的文件 → 启动。
- ⚠️ 测试：run21 19 项（Lv.2 403、本地 / R2 校验、加密口令长度、两个目标一次快照都成功、本地备份解压成完整库、R2 收到 .enc 且签名全部通过、列表、下载 → 解密 → 解压是 SQLite、路径穿越拒绝、保留 2 份两边都清、编辑打码不覆盖、停用不参与、错密钥记失败原因、列表最近结果、删目标不删文件、审计）；mock-r2.js 用同一套 SigV4 复算校验（另有官方向量单测）；到期 SQL 单测；playwright：添加 R2 目标 → 立即备份 → 查看文件，零 JS 报错。真实 R2 未联调。

## v3.5.45 同一实名多账号：数量上限 + 按实名合并（用户反馈）

三级版本。用户：「某人可能在平台内有多个主账号，通常和实名挂钩，可以以其认定为同一人。默认同一人主账号只能有 3 个，且可以通过已实名信息合并，或者由主管理员合并。」
- 同一人 = 同一个 `kyc_pseudonym`（`identityHashes` 的 HMAC 假名，**需要 `KYC_PSEUDONYM_SECRET`**，没配就没有假名、这些功能自动不生效）。`sameIdentityStmt`：同假名、已实名、非公共、status active、未合并、未删除。
- 上限 `KYC_MAX_ACCOUNTS`（默认 3，0 = 不限，≤100）：`kycLimitError(userId, pseudonym)`。两个直认证接口（`/user/kyc/direct`、`/v1/users/:uid/kyc/verify`）在**调服务商之前**先查（省一次认证费用）；`finalizeKyc` 里再兜底——超限不落库、记审计 `kyc.account_limit`、返回 false（Didit/Stripe webhook、支付宝回调走这里，用户看到的是仍未实名）。`finalizeKyc` 现在返回 true/false。
- 本人合并：`GET /user/kyc/siblings`（同实名其他账号，邮箱手机脱敏）、`POST /user/kyc/merge {sources, confirm:'合并账号'}`（来源必须与本人同假名且已实名；走 `userMerge.mergeUsers`，管理员账号仍不能被并；org_scoped 会话 403）。审计 `user.merged` via `kyc_self`。
- 超管合并：`POST /admin/users/merge {target, sources[], confirm:'合并账号'}`（requireAdmin(1)，target / sources 用 `resolveUser` 认 UID/邮箱/手机/用户名），via `super_admin`；`GET /admin/users/:id/siblings`。
- 前端：用户实名卡下「同一实名下还有 N 个账号」勾选 + 合并（`loadKycSiblings`）；实名卡提示文案随 `KYC_ALLOW_DELETE` 变；用户详情「同一实名的其他账号」表 + 超管「合并其他账号到此…」（prompt 填 UID，再输确认词）。系统配置实名组加 `KYC_MAX_ACCOUNTS`，init.js 同步。
- ⚠️ 测试：run20 12 项（第 4 个账号认证在调服务商前被拦、同实名列表脱敏、确认词、实名不同不能合并、合并后积分转入、名额空出不再拦、未实名看不到、Lv.2 不能全局合并 / 确认词 / 找不到账号 400 / 超管合并、管理端 siblings）；playwright：实名卡勾选合并，零 JS 报错。

## v3.5.44 账号注销 / 删除 + 停用时同步暂停应用权限（用户反馈）

三级版本。用户：「现在只能增加不能删除」——要用户端注销（默认 30 天等待，之后注销但保留一段时间再清除，管理端 90 天内可恢复，过了就完全删除，时间可在环境变量改）、管理端删除（强确认；最高管理员直接删，其他管理员等上级审批或等待期后删，或被授权于某组织/分组/标签/文件夹）、删除前预检重要应用（如企业微信）须先标记交接完成；「账号权限被暂停，其应用权限（包括企业微信）也同步暂停」。
- 新 `server/account-lifecycle.js`：`users.deletion_state`（NULL / pending / deleted）+ `deleted_at` / `purge_at`；申请表 `account_deletions`（kind self/admin、status pending/done/cancelled/rejected/restored、needs_approval、approved_by、checklist JSON、execute_at）。时间都存成与 SQLite `datetime('now')` 同格式的 UTC 字符串，直接字符串比较。
  - `request()`：同一账号只能有一个 pending；self → execute_at = 冷静期后；admin 直接 → now；admin 需审批 → 等待期后。执行条件 `tryExecute`：execute_at ≤ now 且清单全勾。审批 = `approve()` 把 execute_at 拉到现在。
  - 执行 = `status='disabled'` + `deletion_state='deleted'` + `purge_at`（**沿用 disabled 状态，所以所有登录 / 会话拦截天然生效**），钩子 `onDeleted` → `onAccountSuspended(u,'user.deleted')`。
  - `restore()`：保留期内恢复为 active；`purge()`：遍历 sqlite_master 所有表，`user_id`/`owner_id` 列删行，`owner_user_id/created_by/granted_by/requested_by/approved_by/issued_by/escort_user_id/done_by` 置 NULL（NOT NULL 列则删行），删 memos 附件，最后删 users 行（外键 CASCADE 收尾）；万一还有外键挡住就退化成抹掉个人信息的墓碑（`deletion_state='purged'`）。`audit_chain` 不动（只有脱敏摘要）。
  - `preflight(user)`：外部通讯录账号（dir_source_links）、企业微信/飞书/钉钉登录绑定（不和通讯录重复的）、组织管理员、分组管理员、授权过的 `apps.handover_required=1` 应用（新列，应用编辑勾选）、名下设备。
  - `tick()` 每小时（启动 5 秒后先跑一次）：执行到期申请、清除过保留期的账号。
- 配置：`ACCOUNT_DELETE_COOLDOWN_DAYS`（30，0~365）/ `ACCOUNT_DELETE_RETAIN_DAYS`（90，0~3650）/ `ACCOUNT_DELETE_ADMIN_WAIT_DAYS`（7，0~365），ENV_GROUPS `acctdel` + init.js。
- 接口：本人 `GET/POST/DELETE /user/account/deletion`（POST 需 `confirm:'注销账号'` + 有密码则验密码；唯一超管不能注销；org_scoped 会话不能注销）、`POST /user/account/deletion/checklist`（只能勾自己发起的）。管理端 `GET /admin/users/:id/deletion`（预检 + mode + can_restore/can_purge）、`POST /admin/users/:id/delete`（`confirm` 必须 = 对方 UID 显示值）、`GET /admin/deletions?status=`、`POST /admin/deletions/:id/approve|reject|cancel|checklist`、`POST /admin/users/:id/restore`（hasGrant user.delete）、`POST /admin/users/:id/purge`（Lv.1 + `confirm:'彻底清除'`）。分级 `deleteMode`：不能删自己 / 同级或更高管理员；`hasGrant('user.delete')`（超管或授权范围内）直接；其他系统管理员需审批；都不是 403。审批人 `canDecideDeletion`：超管 / 被授权者 / 级别比发起人高的管理员（发起人自己不行）。审计 `account.deletion_requested/approved/cancelled/rejected`、`account.deleted/restored/purged`。
- **停用 = 同步暂停**：`onAccountSuspended`（停用 / 删除）作废 `oauth_access_tokens` / `oauth_auth_codes` + 原有 `deprovisionUserAllApps` + `pushExternalSuspend(false)`；`onAccountResumed`（启用 / 恢复）`pushExternalSuspend(true)`。同步源 config `push_suspend`（默认关）→ `dirsync-wecom.setMemberEnabled` 调企业微信 `user/update {enable:0/1}`（需有写权限的通讯录同步 Secret）。⚠️ **`requireAuth` 现在每个请求查一次 `users.status`**，disabled（含已删除 / 已合并）的令牌立即 401——之前停用后已签发的 JWT 要等过期。启用接口拒绝已删除 / 已合并账号（要用恢复）。
- 前端：账号设定「注销账号」卡（`loadAcctDeletion`，进行中显示截止日期 + 自己勾交接清单 + 撤销）；用户详情状态徽章（已删除 / 已合并 / 注销中）+ `renderUserDeletionSection`（删除… / 进行中清单 / 恢复 / 立即彻底清除）；新页「注销与删除」（`adm-deletions`，筛选、批准 / 驳回 / 撤回、清单）；用户列表状态文字；同步源弹窗「停用时同步禁用企业微信成员」；应用编辑「重要应用」。
- ⚠️ 测试：run19 34 项（确认词 / 密码、30 天冷静期且账号可用、不能重复申请、可撤销、到期删除 + 令牌 401 + 不能登录 + 不能直接启用、Lv.2 不能恢复 / 超管可恢复、预检三类、UID 强确认、清单未完不执行 / 完成即删、删除与恢复推送企业微信 enable 0/1、停用作废令牌 + 禁用成员、Lv.3 发起需审批 / 自己不能批 / 上级批即删、Lv.2 发起等待期满自动删、不能删更高级管理员与自己、保留期满彻底删除含备忘录与申请记录、立即清除仅超管、审计）；回归 run 35 / run9 26 / run10 36 / run16 21 / run17 9 / run18 19；playwright：本人注销卡申请后显示清单与截止、管理员详情删除 → 已删除状态、注销与删除页两条记录，零 JS 报错。mock-wecom3 加了 `user/update` 与 `/__updates`。

## v3.5.43 账号详情补全 + 实名清除权限收紧 + 权限授权（用户反馈）

三级版本。用户：「账号详情看不到所属组织或已绑定的三方凭证（只显示 wecom，没有组织、三方 uid）」「企业微信传回来的姓名不可靠，应加应用内姓名字段，真实姓名从 KYC 深度绑定」「用户能否自删 kyc 取决于管理端是否开放，默认不允许；最高管理员可清除，其他只能授权或有权限」。
- `GET /admin/users/:id` 多回 `userDetailExtras(user)`：`orgs`（组织名 / 组织内 UID / 来源 / 文件夹 / is_admin / has_pw）、`bindings`（`provider` 拆成平台 + 凭证 id → 平台中文名、凭证名、所属组织名，默认凭证标「本站默认」，`open_id` / `union_id` 即三方 UID）、`ext_accounts`（dir_source_links JOIN 同步源 / 组织：外部 UID、`ext_name` 应用内姓名、部门）、`merged_into`；以及 `can:{kyc_clear, delete}`。前端 `_udTable` 渲染三个表；「姓名」→「显示名」+「真实姓名（以实名认证为准）」= `kyc_name`（库里本就只存脱敏名）。详情里的 name/email/phone 改为 esc（原来裸插）。
- **权限授权**：`admin_grants(id,user_id,perm,scope_type,scope_id,granted_by)`；`GRANT_PERMS = kyc.clear / user.delete`；`hasGrant(req, perm, target)`：超管（Lv.1，非 org_scoped）恒真，否则看授权范围是否覆盖对象（`grantCovers`：all / org 成员 / group_id / 标签 / 文件夹下任一组织成员）。`GET/POST/DELETE /admin/grants`（requireAdmin(1)，审计 `admin.grant_added/removed`）。前端「权限授权」页（`adm-grants`，SUPERADMIN_ONLY）。
- 实名清除：`DELETE /admin/users/:id/kyc` 从 `requireAdmin(2)` 改为 `requireAuth + hasGrant('kyc.clear')`；`DELETE /user/kyc` 只有 `KYC_ALLOW_DELETE` 为 true/on/1/yes 才放行（**这个配置项早就在系统配置里但服务端从没读过**，默认改为不允许）；`/user/me` 回 `kyc_user_delete`，用户端按它显示删除按钮。⚠️ 开放 API `DELETE /v1/users/:uid/realname`（API Key + scope）未改。
- ⚠️ 测试：run18 19 项（详情三块数据、can 标志、Lv.2 未授权 403、非超管不能授权、范围对象不存在 400、组织范围内可清 / 范围外 403、列表名称、撤销后 403、审计、用户自删默认 403 / 配置开后 200、超管可清）；playwright：详情三表 + 授权页按组织授权，零 JS 报错。

## v3.5.42.1 修企业微信绑定绑不上 + 受限 Secret 同步不建号（用户反馈）

四级补丁。用户：「企业微信的绑定在企业微信里可以正常授权，但是回到 sso 没反应，没绑上」「企业微信回来 39 人，用户管理里只有 7 个人」。
- 🐛 绑定：`/auth/wecom` 一直跳 `open.weixin.qq.com/connect/oauth2/authorize`（**只能在企业微信里打开**）。在电脑浏览器点绑定 → 授权跑到企业微信自带浏览器 → 回调在另一个 cookie 里，没有 `session.bindUserId` → 当成登录，`findOrCreate` 新建了一个账号（截图里的「许睿好懒工作室」00003）。修：UA 不含 `wxwork` 时改跳企业微信**网页登录** `login.work.weixin.qq.com/wwlogin/sso/login?login_type=CorpApp&appid&agentid&redirect_uri&state`（回调同一个、code 同样走 `auth/getuserinfo`），回调回到同一浏览器 session。多出来的空壳账号：用户重新绑定一次即被 v3.5.41 的 `isShellAccount` 自动合并。⚠️ 刻意**没有**把「绑定意图」放进 state（跨浏览器也能绑）——那是账号关联 CSRF（别人发链接让你授权，你的企业微信就绑到他账号上）。
- 🐛 同步：v3.5.39 起只拿到 UserId（`_idOnly`，通讯录同步 Secret 受限）的成员不建号，用户以为同步坏了。改为同步源 config `idonly_create`（**默认开**）：照样建号、姓名用 UserId 占位、state 计 `created_idonly`；之后拿到真名时，**账号名仍等于 UserId 占位才替换**（别的情况不改名）。关掉则恢复旧行为（`unmatched`）。弹窗加勾选，状态文案提示。
- `dir_source_links.ext_name`（新列）：外部系统里的姓名（「应用内姓名」，不可靠，只展示）；只有 UserId 时不覆盖已有值（`COALESCE`）。
- ⚠️ 测试：run17 9 项（默认开、受限建号 + 占位名、换完整 Secret 不重复建号且换真名 + 记 ext_name、非占位名不覆盖、关掉不建号、受限不清 ext_name、浏览器跳网页登录 / 企业微信里跳 oauth2 snsapi_base）；run13 改为 `idonly_create:false` 后 10 项；回归 run10 36 / run16 21 / run9 26 / run8 20（需 `WECOM_CORP_ID=wwtest`）。真实企业微信网页登录未联调。

## v3.5.42 手机端第三方登录改为点击跳转 + 应用内自动登录（用户反馈）

三级版本。用户：「手机端的第三方快捷登录默认是没有二维码显示的，那就做成点击跳转。如果在某允许的应用内打开 sso，检测到这个环境就直接按这个环境（如果配置了）的凭证登录，比如企业微信自建应用打开自动按企业微信凭证登录。」
- `login.html`：`inAppPlatform()` 按 UA 判（**先判 `wxwork` 再判 `MicroMessenger`**，企业微信 UA 两个都带）；`useRedirectLogin(key)` = 窄屏（≤640px，`.qr-scene` 本就隐藏）或就在该应用里。`selectMethod` 扫码平台遇此 → 在该应用里直接 `location = /auth/<平台>`，否则 `showOpenInAppHint`（微信/企业微信网页授权只能在自家应用里完成：提示 + 复制链接）。窄屏下平台按钮不标 active、状态写「登录 ›」。
- `maybeInAppAutoLogin()`（DOMContentLoaded 末尾、已登录跳控制台的判断之后、`await` 平台列表）：平台在 `inapp_auto` 里且有凭证 → 600ms 遮罩「正在用 X 登录…」（可取消）后跳；多个凭证弹 `showSubjectPicker`，`?inst=` 指定则直接用。不跳：`?error=` / `?tfa=` / `?noauto=1`、`sessionStorage.sso_inapp_tried_<平台>` 已有（同一会话只自动一次 → 退出后回登录页、失败回来都不会循环）。应用内打开时不再弹「打开 QWQ SSO App」条。
- 后端：`/api/public/login-methods` 多回 `inapp_auto`（`inappAutoPlatforms()` 读 `INAPP_AUTO_LOGIN`：空/all/on=四个平台，off/0/false/no/none=关，或逗号列表）；`ENV_GROUPS.oidclogin` + init.js ENV_KEYS 同步。`/auth/wecom` scope `snsapi_privateinfo` → **`snsapi_base`**（静默；回调本就只用 userid + user/get，没用 user_ticket）。
- 管理端：本站默认凭证行与组织凭证行，企业微信/微信/飞书/钉钉多一个「应用内登录地址」按钮（`copyInappLoginUrl`：`/login.html[?inst=<凭证id>]`），填到自建应用主页。
- 🐛 顺手修：`selectPlatform(key, isAuto)` 原来先判「只有一个凭证就 selectMethod」再判 isAuto → 首个平台是飞书/钉钉等跳转类且只一个凭证时，**一打开登录页就被带去授权**。现在 isAuto 先判，载入时只给电脑上的扫码平台出二维码。
- ⚠️ 微信内自动登录走 `/auth/wechat`（公众号网页授权 `oauth2/authorize`），WECHAT_APP_ID 需是公众号 appid；电脑扫码那套是开放平台网站应用 appid——两者若不同，微信内登录会失败（回 `?error=` 后不会再自动跳）。
- ⚠️ 测试：playwright 打真服务 21 项（ui14 one 13 / multi 5 / off 3）：手机浏览器隐藏二维码不自动跳、点企业微信出提示；企业微信内自动跳且 `scope=snsapi_base`、appid/agentid 正确；同页第二次打开不再跳；带 error / noauto 不跳；飞书 / 微信内没配凭证不跳；电脑版企业微信也自动；电脑浏览器照旧二维码；多凭证弹选择→选后用对应 corp；`?inst=` 直接用；手机浏览器多凭证选后出提示；`INAPP_AUTO_LOGIN=off` 不自动但点击仍跳；零 JS 报错。回归 run 35 / run9 26 / run16 21。真实企业微信客户端未实测。

## v3.5.41 同一人多个账号合并（企业微信一人多号）（用户反馈）

三级版本。用户：「某些人在企业微信或者类似的应用里有多个账号，实际上是同一人。我有三个企业微信账号在同组织里，但是出来三个我。」
- 根因：企业微信 2022 年起不给自建应用下发手机/邮箱，同步只能按 UserId 认人 → 一人三个 UserId = 三个账号。同步本身没法自动判断（同名≠同人），所以做**人工合并 + 本人自助合并**，合并后同步与登录都稳定落到一个账号。
- 新 `server/user-merge.js`：`checkMerge` / `mergeUsers(targetId, sourceIds, {onAppRevoked})`（事务）/ `isShellAccount`。搬：`user_oauth`（`UNIQUE(provider,open_id)`，一个用户可有同一 provider 的多条绑定）、`dir_source_links`、`org_members`（保留账号已在则删，org_uid / 组织密码缺则接）、`oauth_subject_admins` / `group_admins` / `public_account_members`、Passkey、备忘录、门禁卡、人脸（保留账号没有时）、积分（累加 + 两边 points_log）、保留账号缺的邮箱/手机/实名；删 `dir_sync_applied`（下次同步按保留账号重记）、应用授权 / 令牌 / 授权码。被合并账号 `status='disabled'` + `users.merged_into`（新列），**不删行**（登录日志等历史挂在上面）。不能并：公共账号、管理员账号、已合并过的、实名假名不同的。
- 接口 `POST /admin/orgs/:sid/members/merge {target, sources}`（`canManageOrg`；全员须是本组织成员）。非系统管理员只能并「只在本组织、无平台密码/实名/两步验证/Passkey」的账号（403 说明原因）。审计 `user.merged`；被合并账号授权过的应用推 `user.merged`（带 merged_into）。`GET /admin/orgs/:sid/members` 每人多 `ext_ids`（本组织各同步源里的外部 UserId + 源名）。
- 自助（`oauth.js` 绑定模式）：要绑的三方身份已挂在别人身上、且那人是 `isShellAccount`（非公共/非管理员、无密码/邮箱/手机/实名/2FA/Passkey、所有组织成员关系都不是 manual）→ 本人刚用它走完授权，直接 `mergeUsers` 把空壳并进来，跳 `?bind=success&merged=1`。
- ⚠️ `dirsync-wecom.applyBind` 修：这个 UserId 已绑在本人身上就直接记录返回——否则一人多号时 `userOauthOf` 取到另一个 UserId，会被当成「被改绑过」计入 kept，force 时还会解绑另外几个号。
- 前端（组织成员弹窗）：成员行前加勾选框 + 外部账号行；同名成员黄条提示「选中并合并」；选 ≥2 人出「合并为同一人…」→ 面板选保留账号（默认：有组织密码 > 手动加入 > 编号最小）→ 确认。dev mock 齐。
- ⚠️ 已知：JWT 无状态，被合并账号已签发的令牌到期前仍可用（与「停用用户」现有行为一致）。
- ⚠️ 测试：run16 共 21 项全过（复现一人三号、ext_ids、组织管理员不能并多组织/有密码的人、非成员 400、别的组织 403、合并后停用+merged_into、三个 UserId 绑定与映射都在保留账号、组织只剩一人、积分转入、审计、再同步不建号/无冲突/无保留、全部覆盖同步不拆开、一个号离职人不移出、已合并不能再并、管理员不能被并、系统管理员可并多组织成员且接过联系方式与组织管理员身份、被合并账号不能登录）；isShellAccount 单测；回归 run10 36 / run12 25（需 `DIRSYNC_EVENT_DELAY_MS=400`）/ run13 10 / run9 26 / run 35；playwright：同名提示 → 选中并合并 → 面板 → 确认 → 列表只剩一人且挂三个 UserId，零 JS 报错。

## v3.5.40 域名验证文件（企业微信可信域名等的根目录验证文件，到期自动删除）（用户反馈）

三级版本。用户：「企业微信会有可信域名校验的关卡，要求在域名根目录（比如 sso.xubainet.cn/verification.txt）下，做个验证文件放置功能（过了多少时间自动删除，默认 72 小时）。」
- 数据：`site_verify_files(name PK, content, expires_at NULL=永久, note, created_by, created_at, updated_at)`；`db.verifyFiles`（all/get/active/upsert/setExpiry/remove/purgeExpired）。
- 接口（`api.js`，**Lv.1 超管**——根目录文件能向任何平台证明域名归属）：`GET/POST /admin/verify-files`、`GET/PATCH/DELETE /admin/verify-files/:name`。POST 同名即替换（`replaced`）；`ttl_hours` 0~8760、默认 72、0=永久；PATCH = 从现在起重新计时。校验 `verifyFileNameError`：`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`、扩展名限 txt/html/htm/xml/json、**不得与 public/ 里已有文件重名**；内容 ≤64KB。审计 `site.verify_file_added|replaced|extended|removed`。每小时 `purgeExpired`。
- 对外提供：`api.js` 导出 `router.serveVerifyFile` 中间件，`index.js` 挂在 providerRoutes / static **之前**（`app.use(apiRoutes.serveVerifyFile)`）：只认单段文件名 + 白名单扩展名，查 `active`（未过期）才下发，否则 next。头：`no-store` + `nosniff`；**.html/.htm 也按 text/plain 下发**（防根域存储型 XSS）。HTML 注入中间件只处理 public/ 里真实存在的 .html，不会拦。
- 前端：管理端菜单「域名验证文件」（`ni-adm-verify-files` / `page-adm-verify-files`，加入 `SUPERADMIN_ONLY`）：列表（文件名 · 大小 · 备注 · 完整地址链接 · 剩余时间「X 天 Y 小时后删除」/永久/已过期 · 复制地址 / 延期(prompt 小时数) / 删除）；添加弹窗 `openVerifyFileModal`（选文件 FileReader 自动带出文件名 + 内容 / 手填；有效期 1h/24h/72h默认/7天/30天/永久/自定义；备注）。通讯录同步源弹窗的接收事件服务器说明里加了「要先验证可信域名就到『域名验证文件』上传」。AUDIT 标签补四项；dev mock（`window._devVF`）。
- ⚠️ 测试：run15 22 项（Lv.2 管理员 403、6 种非法文件名、空内容、超 64KB、默认 72h、根路径原样下发 + text/plain + no-store + nosniff、.html 按纯文本、站内页面不受影响、未上传 404、同名替换 + 永久、过期即 404、列表清理过期、延期重新计时、越界 400、删除后 404、审计四项）；回归 run 35 / run11 15 / run12 25 / run14 5 / run9 26；playwright：选文件自动带出 → 保存 → 列表显示地址与剩余时间 → 根路径取到内容 → 延期 7 天 → 删除后 404，零 JS 报错。

## v3.5.39.1 修「openapi回调地址请求不通过」（接收事件服务器地址校验失败）（用户反馈）

四级补丁。用户在企业微信后台保存接收事件服务器时报「openapi回调地址请求不通过」。线上已是 v3.5.39、路由可达（未配置的 id 回 404 not configured）。
- 🐛 根因：echostr 是 base64，常含 `+`；企业微信不一定把它编码成 `%2B`，而 Express 的 qs 会把 `+` 解成空格 → 验签 / 解密全失败。本地复现：33 个含 `+` 的 echostr 未编码时 0 个通过、编码后全通过。
- 修：`wecomQuery(req)` 从 `req.originalUrl` 自己解析 query（只用 decodeURIComponent，不做 + → 空格），GET 校验与 POST 事件验签都改用它。**以后处理企业微信 / 微信这类 base64 签名参数一律别用 `req.query`。**
- 诊断：`noteVerifyAttempt` 把每次地址校验的结果写进 `event_state.last_verify {at, ok, reason, ip}`（源未配 Token、缺 echostr、签名不对=Token 不一致、解密失败=AESKey 不一致、企业 ID 不符）；弹窗 `_dirEventText` 显示最近一次失败原因；一直没有记录 = 企业微信访问不到这个地址（域名 / HTTPS / 网络）。
- ⚠️ 测试：plus-test（含 + 的 echostr 未编码 / 编码都通过）、run14 5 项（未配置记原因、Token 错、AESKey 错、企业 ID 错、未编码 + 通过）、run12 25 项回归全过。

## v3.5.39 企业微信接收事件服务器（实时同步）+「通讯录同步」Secret 受限（48009）降级（用户反馈）

三级版本。用户：①「企业微信通讯录同步有个叫『接收事件服务器』的东西，这个似乎还没做」②线上报 `department/list 失败：48009 api forbidden for contact assistant ... from ip: 118.25.149.17`。

### ① 接收事件服务器
- `dirsync-wecom.js`：`cbSignature`（sha1 字典序拼 token/timestamp/nonce/encrypt）/ `cbVerify`（timingSafeEqual）/ `cbDecrypt`（AES-256-CBC，key=base64(AESKey+'=')、iv=key 前 16 字节、PKCS#7 块 32；明文=16 随机+4 字节大端长度+消息+receiveid）/ `cbEncrypt`（测试/自检用）/ `xmlField`（扁平 XML 取 CDATA）/ `renameExtId`（改 UserId：本源映射、该源绑定的登录凭证 open_id、`dir_sync_applied` bind 值、组织内 UID 还等于旧 UserId 时，一个事务里一起改）。
- 配置：同步源 config 加 `cb_token`（≤32 位字母数字）/ `cb_aes_key`（43 位，视图打码，打码串/留空不改，`cb_clear` 关闭；两者须同时有或同时无）。视图加 `callback_path`、`callback_ready`、`event_state`。新列 `dir_sync_sources.event_state`。
- 公开路由 `GET/POST /api/public/dirsync/wecom/:id`（api.js）：GET 验签+解密 echostr 原样返回（记 `verified_at`）；POST `express.text` 收 XML → 验签 → 解密 → receiveid 必须 = corp_id（否则 403）→ `change_contact` 且源启用：`update_user`+`NewUserID` 先 `renameExtId`，再 `scheduleEventSync`（**防抖** `DIRSYNC_EVENT_DELAY_MS` 默认 10 秒，200ms~10 分钟；同组织正在同步则顺延；actor `wecom:event`）→ 记 `event_state` → 回 `success`。**刻意不逐条增量改库**：防抖后跑全量同步，范围/移出/单独修改不覆盖等规则与手动同步完全一致。轻量本地改动做完再回 success（先回再改会被测试抓到时序问题）；事件处理异常也回 success 免得企业微信重试。
- 前端同步源弹窗「⚡ 接收事件服务器」区：URL（`location.origin + callback_path`，复制）、Token / EncodingAESKey（随机生成 + 复制；AESKey 保存后打码不再显示）、关闭勾选、步骤说明、最近校验/事件状态（`_dirEventText`）；行上「⚡ 实时」标记。
- ⚠️ 回调地址用的是浏览器当前域名，必须是企业微信能访问到的公网 HTTPS 地址。

### ② 48009 降级
- 企业微信 2022-08-15 起：「通讯录同步」Secret 在新 IP 上不能调 读取成员 / 获取部门成员(详情) / 获取部门列表 / 单个部门详情 / 导出，只能调 `department/simplelist` + `user/list_id`，只返回 ID；官方建议读通讯录用**自建应用** Secret。
- `deptList()`：department/list 报 48009 → 降级 simplelist（无部门名）；`fetchScopeTree` 回 `limited`；`fetchDirectory`：受限或 user/list 失败 → list_id（按范围收集每人所在部门）→ user/get，user/get 也 48009 → **只有 UserId 的成员**（`_idOnly`，name=UserId）。`syncWecom`：`_idOnly` 且通过映射/登录绑定都认不出 → **不建号**（`unmatched++`，防止给已有用户造重复账号）；已关联的照常在册、离开照常移出。state 带 `limited` / `unmatched` / `warning`（`LIMITED_HINT`）。
- `ERR_HINT`：40001/40013/48009/60011/60020 报错附中文处理建议（60020 = 出口 IP 不在可信 IP，提示把报错里的 from ip 加进去）。
- 前端：Secret 标签改为推荐自建应用 + 48009 警示；部门树受限时显示「部门 #id」占位（不存成部门名）+ 提示；行上「⚠ 受限 Secret」、弹窗显示 warning 与未建号人数。

### 测试
- run12（接收事件服务器）25 项：Token/AESKey 格式、AESKey 打码不泄露、URL 校验成功/签名错/别的企业/未配置 404、记校验时间、事件验签解密回 success、防抖期间未同步→防抖后同步、三条事件只同步一次、删除成员事件移出、改 UserId 映射立即改名且同账号/绑定/组织内 UID 跟着改、事件状态、事件签名错/别的企业 403、非通讯录事件与停用源不同步、编辑打码不覆盖、关闭后 404。连跑 3 次稳定。
- run13（48009 降级）10 项：受限 Secret 拉部门降级、完整 Secret 建号后换受限 Secret 不重复建号、未关联 2 人不建号计 unmatched、已有成员不被移出、受限下离开照常移出、错 Secret / 无部门权限中文提示。mock `mock-wecom3.js` 加 `assistsecret`（详情接口 48009、simplelist/list_id 可用）。
- 回归 run10 36 / run9 26 / run8 20 / run11 15 / run 35 全过；playwright：受限 Secret 加载部门树（占位 + 提示）→ 生成 Token/AESKey → 保存 → 同步 → 行显示「⚡ 实时」「⚠ 受限 Secret」、弹窗回填 URL 与打码，零 JS 报错。
- ⚠️ 真实企业微信未联调；加解密按官方协议实现、用自写加密往返验证，未用官方测试向量。

## v3.5.38 组织文件夹（管理端把组织归类）（用户反馈）

三级版本。用户：「这个组织上边还可以加一个文件夹的概念，把这些组织归类起来。」
- 数据：新表 `org_folders(id, name, sort_weight, created_at)` + `oauth_subjects.folder_id`（迁移区块；NULL = 未归类）。**一级、不嵌套，一个组织最多在一个文件夹**。`db.orgFolders` 语句集（all 带 org_count / get / insert / update / remove / unfileAll / setSubject）。
- 接口（系统管理员，读 Lv.3 / 写 Lv.2）：`GET/POST /admin/org-folders`、`PATCH/DELETE /admin/org-folders/:id`（删 = 事务里先把组织 folder_id 置空再删）。组织归类复用主体接口：`POST/PATCH /admin/oauth-subjects` 收 `folder_id`（`folderIdFromBody`：undefined 不改 / null·空串 = 未归类 / 不存在 → 400；**PATCH 在最开头校验**，坏 folder_id 整个请求不生效）。`GET /admin/oauth-subjects` 组织带 `folder_id`、顶层多 `folders`。
- ⚠️ 只是管理端展示归类：**不影响登录、权限、组织管理员范围**；组织管理员（非系统管理员）不能建/改文件夹（requireAdmin）。用户端「我的组织」不显示文件夹。
- 前端（「组织管理」页额外主体卡）：顶部 `#org-folder-bar` 标签栏（全部 / 各文件夹·数量 / 未归类 / + 新建文件夹；选中文件夹时出重命名 / 删除文件夹），选择存 `localStorage.sso_org_folder`（已删的回退「全部」）。「全部」时 `renderOrgGroups` 按文件夹分节、可折叠（`sso_org_folder_collapsed`），最后「未归类」；没有任何文件夹时保持原平铺。卡片头加「📁 移到」浮层菜单（`openOrgMoveMenu`：各文件夹 / 未归类 / 新建文件夹并移入，当前所在打勾）。主体弹窗加「所在文件夹」下拉（新建时默认当前选中的文件夹），`saveSubject` 带 `folder_id`。dev mock 齐。
- ⚠️ 测试：run11 共 15 项全过（非系统管理员 403、空名 400、建/移入/换夹/不传不动/移出、坏 folder_id 400 且其他字段不改、新建组织带文件夹、新建坏文件夹不建、列表计数、重命名、删除回未归类、删不存在 404）；run/run2/run3/run9 回归全过；playwright：新建文件夹→「📁 移到」→新建并移入→分节显示→折叠→按文件夹筛选→弹窗默认当前文件夹→新建组织进该夹→删文件夹回未归类，零 JS 报错。

## v3.5.37 通讯录同步：多选部门 + 同步默认凭证（登录绑定 / 组织密码）+ 单独修改不覆盖 / 强确认全部覆盖（用户反馈）

三级版本。用户：「有的组织用总公司的企业微信账号，权限只有某个部门，应该可以选择部门来同步；以后接入其他有分组概念的应用也一样。同步回来可以按凭证添加默认的凭证。有人单独改了凭证不会覆盖同步，除非勾选强确认的全部同步。」问过用户：「默认凭证」= 登录凭证绑定 + 默认组织密码，两者都要。

- **同步范围**：config `dept_ids`（数组，≤50）+ `dept_names`（展示用）；`deptIdsOf(cfg)` 兼容旧 `dept_id`。`fetchDirectory` 对每个部门各调一次 department/list?id 与 user/list(fetch_child)，合并后按 userid 去重；list_id 回退按所有部门子树的并集过滤。新 `fetchScopeTree(cfg)` = department/list 不带 id（只返回该 Secret 可见范围的部门）。接口 `POST /admin/orgs/:sid/dir-sources/scope-tree`（`canManageOrg` 写；`{source_id}` 时 secret 留空/打码用已存的）。命名刻意通用（scope-tree / nodes），以后飞书/钉钉的「分组」走同一个接口，各类型模块导出自己的 `fetchScopeTree`。
- **登录绑定**：`bind_mode` auto（原行为：`loginProviderFor` 同 corp 的那个）/ custom（`bind_providers`，只收 `loginProviderChoices(subject)` 里的：本组织 wecom 凭证 + 本站默认 wecom）/ none。`bindProvidersFor(subject,cfg)`；匹配时依次按每个绑定 provider 找人。列表接口回 `bind_choices`。
- **默认组织密码**：`default_password` → `bcrypt(12)` 存 `default_pw_hash`（**视图剥掉哈希，只回 `has_default_pw`**）；留空不改、`clear_default_password` 清除。只给 `source='wecom'` 的成员设（手动/导入的不动）。`buildDirSourceCfg`（async）包住原来的 `dirSourceCfgFromBody`，POST/PATCH 路由改 async。
- ⚠️ **不覆盖单独修改**：新表 `dir_sync_applied(source_id,user_id,kind,key,value)`——kind=bind/key=provider/value=UserId；kind=pw/key=''/value=哈希。判定：
  - 绑定：当前就是这个 UserId → 补记录；从没绑过且没记录 → 绑；**有记录但现在没绑（解绑了）或绑成别的（改绑了）**、或没记录但已绑别的 → 保留（`kept`）。UserId 已被别人占 → 永不抢（`conflicts`，force 也不抢）。
  - 密码：当前 = 默认哈希 → 补记录；当前为空且无记录、或当前 = 上次记录（说明没人动过、只是默认密码换了）→ 设；其余（改过 / 清过）→ 保留。
  - 升级前已绑的成员第一次同步会因「当前就是这个 UserId」自动补记录，不会误判。
- **全部覆盖**：`POST /admin/dir-sources/:id/run {force:true, confirm:'全部覆盖'}`（`FORCE_CONFIRM`，口令不符 400）；`syncWecom(..., fetcher, {force})`；state/审计带 `force`、`bound/pw_set/kept/conflicts`。开放 API 与定时同步永远不 force。前端行上「全部覆盖…」按钮 → `prompt` 要求原样输入口令。
- 删同步源 / 删组织连带清 `dir_sync_applied`。
- 前端 `openDirSourceModal` 改 async（先拉 `bind_choices`）：部门芯片 +「加载部门」缩进树（看不到父部门的当顶层；选了该 Secret 看不到的部门标红⚠）+ 手动加 ID；「同步回来的默认凭证」区（绑定方式 + 凭证多选、默认组织密码「已设置，留空不修改」+ 清除）。新建时不预选部门（空 = 保存为 `[1]`）。行上显示部门名、🔑 默认密码、上次「保留 N」。
- ⚠️ 测试：新 `mock-wecom3.js`（集团部门树；`salessecret` 只能看销售部 3/31，访问别的部门 60011）+ run10 共 36 项全过（部门权限、受限 Secret 同步根部门 60011、多选去重、custom 只收有效凭证、哈希不下发、默认密码可「登录到组织」、改密/清密/解绑/改绑都保留、换默认密码只跟上未动过的、force 口令校验与覆盖、force 不抢他人 UserId、手动成员不设密码、删源清记录）；run8 20 / run9 26 / 35 / 16 / 25 / 12 回归全过；playwright：加载部门树→勾选→芯片、指定凭证、默认密码、保存→同步→全部覆盖→再编辑回填，零 JS 报错。

## v3.5.36 通讯录同步改为「多同步源」+ 本站凭证改为「列表 + 子页面」（用户反馈）

三级版本。用户：「某组织可能不止拥有单一企业微信以及类似的应用，需要做多个；不是直接添加，而是像添加凭证那样做子页面，开启或者关闭。目前主平台的凭证也得像组织的一样 UI，全部展开太乱了。」

### 多同步源
- 新表 `dir_sync_sources(id, subject_id, type, label, config JSON, enabled, state JSON, …)` + `dir_source_links(source_id, ext_id, user_id, depts, PK(source_id,ext_id))`——**映射按同步源隔离**（两家企业的 UserId 可能重名，旧表按组织做主键会串人）。`db.dirSources` 语句集。
- ⚠️ **一次性迁移**（db.js 迁移区块）：v3.5.35 的 `oauth_subjects.dir_sync` 非空 → 建一个同步源（label「企业微信」，state 带过来）+ 把 `dir_sync_links` 该组织的行搬进 `dir_source_links` + 旧列/旧行清空；迁完 `dir_sync` 为 NULL，所以重启不会重复迁（事务包裹）。
- `dirsync-wecom.syncWecom(source, subject, cfg, helpers)`：移出逻辑改为「本源这次丢掉的人（删映射）→ 若他已不在本组织**任何**同步源（`stillSynced` 查 dir_source_links JOIN dir_sync_sources）且 source='wecom' → 移出」。别的源负责的人不碰。
- 接口全换（v3.5.35 的 `/admin/orgs/:sid/dir-sync*` 已删）：`GET/POST /admin/orgs/:sid/dir-sources`、`PATCH /admin/dir-sources/:id`（只传 `{enabled}` = 纯启停，配置不动）、`DELETE /admin/dir-sources/:id`（清映射，成员保留）、`POST /admin/dir-sources/:id/run`（停用 400）。权限 `dirSourceFor` → `canManageOrg(src.subject_id)`。开放 API `POST /v1/orgs/:sid/dir-sync/run` 改为依次跑所有启用源、返回 `results[]`。`DIR_TYPES` 目前只有 wecom（飞书/钉钉在 UI 里置灰「即将支持」）；锁仍按**组织**（同组织多源串行，避免移出判断互相干扰）；定时器遍历 `dirSources.dueList`（源启用且组织启用）。`/admin/oauth-subjects` 每个组织多 `dir_sources`（`dirSourceView`，secret 打码）。删组织连带清源与映射。
- 前端：组织卡片在凭证行下面列同步源行（类型 · 名称 · corp/部门/频率 · 上次结果 · 启用徽章 · 立即同步/停用·启用/编辑/删除），卡片头加「+ 通讯录同步」；组织成员弹窗的折叠区改为同一份行列表 +「+ 添加同步源」（`dirSourceRowsHtml` 两处共用、`refreshDirSourceViews` 两处刷新）。编辑走动态子页面 `openDirSourceModal(sid, srcId)`（secret 占位「已配置，留空不修改」、绑定提示、上次结果）。组织的登录凭证行也加了「停用/启用」快捷按钮（`toggleOauthProvider` → PATCH `{enabled}`）。

### 本站（默认主体）凭证
- 后端 `GET/PUT/DELETE /admin/oauth-defaults(/:platform)`（Lv.1，与系统配置同级）：按 `OAUTH_META` 切片读写环境变量；密钥只回 `set`，留空不改、打码串不改；主字段不能清空。**启停**：`OAUTH_DEFAULT_DISABLED`（逗号平台列表），`envConfigured`/`configured-platforms`/`oauth.js getCred` 默认分支都尊重它——停用后登录页不显示，直接打 `/auth/<平台>` 也返回 not_configured；凭证保留。删除 = 清空该平台全部字段（`setEnvVal('')` 同时 delete process.env）。init.js ENV_KEYS 补 `OAUTH_DEFAULT_DISABLED`。
- 前端：「默认主体（本站）」卡片从「13 个平台全部展开的环境变量编辑器」改为**只列已配置平台的行**（图标 · 名称 · 主字段值 · 启用徽章 · 停用/启用 · 编辑 · 删除）+ 头部「+ 添加凭证」（下拉只列未配置平台）。编辑 / 添加是子页面 `openDefaultCredModal(platform)`，字段说明取自 ENV_GROUPS。旧的 `_envRowHtml`/`saveDefaultSubjectCreds` 已删。
- ⚠️ 若变量同时配在 Zeabur 平台环境变量里，删除只清本库与当前进程，重启后平台变量会重新生效（弹窗里有提示）。

### 测试
- 新 run9 共 26 项全过：旧配置迁移（源 + 映射 + 旧列清空）、权限、两个源、不支持类型、组织列表无明文 secret、**两家企业同名 UserId 不串人**、同一人在两家（手机关联）→ 离开一家不移出 / 两家都离开才移出、纯启停保留配置、停用源不能跑、编辑打码不覆盖、开放 API 跑全部源、删除源成员保留；本站凭证：非超管 403、配置后登录页出现、列表不回密钥、停用后登录页消失且 `/auth/wecom` 被拦、停用保留、密钥留空不覆盖、主字段不能清空、删除。run8（单源边界：0 人不移除、user/list 回退、错 secret、幂等）改用新接口 20 项全过；其余回归全过；playwright：本站添加→行→停用；组织卡片两源 + 立即同步；成员弹窗行列表 + 编辑子页面，零 JS 报错。

## v3.5.35 企业微信通讯录同步（用户：「SCIM：目前先做企业微信的」）

三级版本。企业微信**没有标准 SCIM**，所以落地为「用它自己的通讯录 API 拉取 → 同步成某组织的成员」（入站方向，补 v3.4.20 的手动导入）。出站 SCIM（推给第三方应用）仍未做。
- 新 `server/dirsync-wecom.js`：`fetchDirectory`（gettoken → department/list(id=根) → user/list?fetch_child=1；**user/list 被拒时回退 user/list_id 分页 + user/get**，按部门子树过滤，按 userid 去重）+ `syncWecom(subject,cfg,helpers)` + `loginProviderFor`。API 根地址 `WECOM_API_BASE`（默认 qyapi.weixin.qq.com，测试指向 mock）。
- 匹配同一自然人：`dir_sync_links`（本组织 UserId→用户，**保证无邮箱手机的人每次落到同一账号**）→ `user_oauth`(该企业的企业微信登录 provider, UserId) → 邮箱(email/biz_mail) → 手机 → `users.create`。同 corp 的企业微信登录凭证（该组织下 `oauth_providers` 的 WECOM_CORP_ID 相同 → `wecom:<id>`，否则 env `WECOM_CORP_ID` 相同 → `wecom`）存在时，把 UserId **绑定进 user_oauth**，之后企业微信登录的 `findOrCreate` 直接命中同一账号；UserId 已被别人占用或此人已绑该 provider 则不绑。
- 状态 1/4 计入，2/5 视为离开。组织成员 `source='wecom'`；`remove_missing`（默认开）**只移出 source=wecom 且本次不在的**，手动/导入成员不动；原是手动成员的人被匹配到时来源保持不变（不接管）。**拉到 0 人时不移除**（防权限/部门配错把组织清空）。不在范围的映射行删除（人回来时靠 user_oauth 绑定连回原账号）。
- 组织内 UID：`uid_mode` = userid（默认，冲突则不设）/ rule（本组织规则）/ none。
- 配置存 `oauth_subjects.dir_sync`（JSON：corp_id/secret/dept_id/uid_mode/remove_missing/interval_hours/enabled），结果 `dir_sync_state`。接口：`GET/PUT /admin/orgs/:sid/dir-sync`（`canManageOrg`；secret 读时打码 `••••••••`，提交打码串/空=不改；`{clear:true}` 清除）、`POST /admin/orgs/:sid/dir-sync/run`、开放 API `POST /v1/orgs/:sid/dir-sync/run`（`org:sync`，有 sandbox 桩）。`runDirSync` 带组织级锁（并发 409），审计 `org.dir_synced` / `org.dir_sync_configured`。定时：`setInterval` 每 10 分钟检查 `interval_hours`(0/1/6/24…≤168) 到点的组织（`unref`）。删组织连带清 `dir_sync_links`。
- ⚠️ 已核对：所有返回组织的接口都是**显式挑字段**，`dir_sync`（含 secret）不会经列表下发。
- 前端：组织成员弹窗加「🔄 企业微信通讯录同步」折叠区（企业 ID / Secret / 部门 ID / 组织内 UID 方式 / 自动同步 / 离开即移出 + 绑定提示 + 上次结果 + 停用清除 / 保存 / 立即同步），成员行显示「企业微信同步」标记；AUDIT 标签补两项。
- ⚠️ 测试：mock 企业微信（`scratchpad/e2e/mock-wecom.js`，含 errcode、list_id 分页、部门外成员）+ 真实服务端 20 项全过（权限 3 项、secret 打码与不覆盖、首次同步计数、邮箱关联/手机建号/无联系方式建号/离职跳过、UserId 绑定、幂等、离开移出且手动成员保留、0 人不移除、user/list 被拒回退且不越部门、回来连回原账号、错 secret 502+状态、审计、清除后 400）+ 回归 35/16/25/12/4；playwright：组织管理员弹窗配置→立即同步→结果行/绑定提示/打码/成员标记，零 JS 报错。
- ⚠️ 真实企业微信未联调（本机无企业微信企业）：新建自建应用的 user/list 字段权限（2022 年起手机/邮箱不再下发）以实际为准——拿不到邮箱手机时靠 UserId 映射 + 登录绑定仍能稳定落到同一账号。实时变更回调（通讯录事件推送，需 Token/EncodingAESKey 解密）未做，目前靠定时 + 手动同步。

## v3.5.34 iOS 主屏幕快捷操作「出示开门码」+ 交接文档总览追平（承接 v3.5.13/v3.5.14 遗留）

三级版本。v3.5.13 用户要「访客码/门禁码放进 App 快捷方式」，v3.5.14 以「要动 scene 生命周期、无法真机验」暂缓，本版做掉。
- `Info.plist` 加静态 `UIApplicationShortcutItems`（type `cn.xubainet.qwqsso.accessqr`，标题「出示开门码」，SF Symbol `qrcode`）+ 显式 `UIApplicationSceneManifest`（单场景）。
- 新 `ios/QWQSSO/QuickActions.swift`：`ShortcutRouter`（单例 ObservableObject，`pending`）+ `AppDelegate`（`@UIApplicationDelegateAdaptor`；冷启动从 `configurationForConnecting` 的 `options.shortcutItem` 取，并把场景 `delegateClass` 设为 `SceneDelegate`；另保留非场景兜底 `performActionFor`）+ `SceneDelegate`（热启动 `windowScene(_:performActionFor:)`）+ `QuickAccessSheet`（`NavigationStack { AccessView() }` + 完成按钮）。
- `RootView`：`fullScreenCover` 绑定「已登录 && pending == accessQR」，关闭即清 pending；**未登录时挂着，登录完成后自动弹出**。
- CLAUDE.md 总览追平：功能范围、目录结构（补 `org-policy.js`）、数据库表清单（补 `app_icons`/`app_folders`/`app_folder_items`/`access_escort_pending`/`twofa_recovery_codes` 及门/访客码/组织新增列）改为「截至 v3.5.34」。
- ⚠️ 只能靠 GitHub Actions 编译验证；快捷操作的真机行为（长按图标出现菜单 → 冷/热启动都弹门禁码）需装到 iPhone 上确认。

## v3.5.33 把水印烧进导出的图片 / PDF（服务端烧录 + 追踪码）（承接 v3.4.23 遗留）

三级版本。之前的水印只是页面 DOM 遮罩，文件下载后就是干净的。现在由**服务端**在下发备忘录附件时烧录，绕过前端直接调接口也拿不到原文件。
- 新 `server/watermark-burn.js`：sharp（libvips + Pango）把「模板文字 · T追踪码」渲染成透明 PNG 瓦片（旋转 + 留间距 + **隔行错位半格**），图片用 `composite tile:true` 平铺并按原格式输出（PNG/JPEG/WebP/GIF，EXIF 先摆正，大图按短边/900 放大字号）；PDF 用 pdf-lib 把同一瓦片（2 倍分辨率）当图片铺满每页——**PDF 里不嵌字体**，中文不会缺字。
- ⚠️ **字体是最大的坑**：Zeabur 类容器一个字体都没有，Pango 连英文都渲染成豆腐块（已在空 fontconfig 下实测）。所以永远显式传 `fontfile`，解析链：`WATERMARK_FONT_PATH`（`-`=不用中文）→ 常见系统 CJK 字体 → 下载缓存到 `<DB 目录>/fonts/`（默认 jsDelivr 上**钉死 tag Sans2.004 + sha256 校验**的 Noto Sans SC 8.3MB；`WATERMARK_FONT_URL` 可换 / `off` 不下载）→ 兜底 npm 依赖 `dejavu-fonts-ttf` 的 DejaVuSans（只有拉丁字，此时文字去掉非 ASCII，保留 UID/邮箱/时间/追踪码）。开启烧录时 api.js 加载即 `prefetchFont()`。
- 接入 `GET /memos/:id/attachments/:aid`：`WATERMARK_BURN=on` 且是图片/PDF → 烧录后下发，`Cache-Control: no-store`，审计 `file.watermarked`（subject=查看人 uid_seq，detail 含 trace/memo/attachment/file/mime/cjk）。**烧录失败一律 500 拒绝，绝不退回原文件**（如损坏/加密 PDF）。docx 等不可烧录类型照常下发。
- `?thumb=1`：图片缩到 120px webp、不烧录不记存证（网页备忘录小图改用它，否则每开一次备忘录就为每张小图烧录 + 记审计）；开了烧录却 sharp 不可用时缩略图 404，不给原图。
- 追踪码反查 `GET /admin/audit/trace/:code`（Lv.3，`T`+8 位十六进制，可省 T/小写）；「审计存证」页加反查框（`lookupTrace`）。AUDIT_EVENT_LABEL 补 `file.watermarked`。
- 策略：`watermarkPolicy()` 多 `burn`；`PUT /v1/watermark` 收 `burn`/`burn_text`。系统配置「水印」组加 `WATERMARK_BURN`/`WATERMARK_BURN_TEXT`/`WATERMARK_FONT_URL`/`WATERMARK_FONT_PATH`；init.js ENV_KEYS 同步。备忘录弹窗开启时显示「🔏 会带身份水印与追踪码」提示。服务端模板时间按用户 `timezone`（auto 则 `WATERMARK_TZ`，默认 Asia/Shanghai）。
- 依赖：`pdf-lib`、`dejavu-fonts-ttf`（纯 JS/纯数据）进 dependencies；**`sharp` ^0.34.5 放 optionalDependencies**（0.35 要求 Node ≥20.9；可选=原生包装不上也不挡部署，此时开启烧录会 500 拒绝）。两者都懒加载。
- ⚠️ 测试：模块 14 项（四种图片格式同格式同尺寸、PDF 页数不变、docx 返回 null、模板时区、ASCII 降级、坏 PDF 抛错）在**空 fontconfig** 下分别以 DejaVu 兜底 / Noto 中文跑通并目检出图；真实服务端 15+7 项（开/关两种模式：烧录、no-store、每次一条存证、追踪码反查/大小写/不存在/普通用户 403、坏 PDF 500 不泄原文、缩略图不记存证、txt 原样）+ 回归 35/16/25/12/4 全过；playwright：备忘录提示、缩略图 120px、灯箱大图带水印且记 1 条存证、坏 PDF toast 显示后端原因、审计页反查出 alice，零 JS 报错。
- ⚠️ 本地 e2e 起服务时 `WATERMARK_BURN=on` 直接给环境变量即可；本机有 wqy 字体，要模拟线上无字体用 `FONTCONFIG_FILE=<空配置>` + `WATERMARK_FONT_PATH=-`。

## v3.5.32 iOS：身份核验屏 + 我的组织 / 按组织看应用（承接 v3.5.12、v3.4.42 遗留）

三级版本（iOS 为主）。
- 后端 `/user/app-center` 的 `tools` 加 `verify`（`verifierOf(req).ok`：管理员或有效核验员）。
- 新 `VerifyView.swift`（`IdentityVerifyView`）：扫码（复用 `ScannerView`，sheet）或粘贴 qr1 → `POST /api/verify/scan` → 脱敏身份卡（姓名/UID/组织/分组/自定义字段）；`ok:false` 显示 `reason_text`。应用中心「管理工具」多一个「身份核验」磁贴。
- 组织：`APIClient.appsMarket(token:org:)`（`?org=`）+ `myOrgs`（`/api/user/orgs`）。`AppsTabView` 左上角组织菜单（全部 / 各组织·组织内 UID），选择按系统存 `UserDefaults["sso_current_org|<domain>"]`；记住的组织已不在我的组织里则回退「全部」。`MeTabView` 加「我的组织」区（组织名 + 组织内 UID）。
- ⚠️ 测试：真实服务端 4 项（管理员/核验员有磁贴、普通用户无、/user/orgs 带 org_uid）+ 35 项回归；Swift 靠 GitHub Actions 编译验证。

## v3.5.31 分组/组织管理员的网页签发访客码入口 + 签发门范围收紧（承接 v3.5.4 遗留）

三级版本。v3.5.4 遗留「纯分组管理员的用户端签发入口」——后端早就允许分组/组织管理员签发（`canIssuePass`），但网页签发只在管理端「门禁管理」（nav-admin，仅系统管理员可见）。
- `dashboard.html` 用户端「门禁」页加「我签发的访客码」卡（`my-pass-card`）：`loadMyPassCard()` 调 `/user/app-center`，`tools.access.passes && !admin` 才显示（系统管理员仍在管理端签）；门选项来自 `pass_doors`。
- 复用管理端访客码代码：`loadAccessPasses(boxId)` 记住渲染目标 `_passBoxId`（管理端显式传 `'adm-pass-list'`），`openPassModal(doorList)` 可传入门列表（缺省=管理端门缓存）。dev mock 补 `/user/app-center`。
- ⚠️ **安全收紧**：`POST /access/passes` 之前对非系统管理员**不限门**（分组管理员能把访客放进任何门）。现在非 `isSysAdmin(req,2)` 只能签自己 `doorsForUser` 里的门，否则 403「只能签发你自己有权通行的门」。列表/撤销的「全部」判定也从 `role==='admin'` 改为 `isSysAdmin`（org_scoped 的管理员会话不再看到全部访客码）；app-center 的 `pass_doors` 全量门改按 `isSysAdmin(req,2)`，与签发校验一致。
- ⚠️ 测试：真实服务端 12 项全过（pass_doors 只含自己能开的门、签无权门/混入无权门 403、签自己的门成功、系统管理员签任意门、只看自己签发的、不能撤销别人的、普通用户 403 且无磁贴）+ 门禁 25 项回归；playwright 打真服务：组织管理员门禁页出现卡片→签发→出二维码→列表刷新，零 JS 报错。

## v3.5.30 iOS 应用中心加入管理工具（门禁 / 设备 / 用户）（用户反馈）

三级版本。用户：「门禁、设备管理、用户管理这些都可以做到手机端的应用中心，区别于入口罢了。」
- 后端 `GET /api/user/app-center`（requireAuth）：`tools.users`=系统管理员（Lv.3 读，`write`=Lv.2）；`tools.devices`=系统管理员或组织管理员（`orgs`=myManagedOrgs，`all`=系统管理员）；`tools.access`=系统管理员（`admin`）或 `canIssuePass`（`passes`）；`pass_doors`=签发访客码可选的门（管理员=全部启用门，其它=自己能通行的门）。org-scoped 会话自然只算当前组织（走 isSysAdmin/myManagedOrgs/canIssuePass）。**只决定磁贴显隐，真正权限仍由各接口自己校验。**
- iOS 新 `ManageViews.swift`：`ToolTile`、`AdminUsersView`（`/admin/users?q=`，左滑停用/启用）、`DevicesManageView` + `DeviceEditView`（`/admin/devices` CRUD；非系统管理员登记时默认选第一个所管组织、无「不归属」项）、`AccessManageView`（分段：访客码 `/access/passes` 签发/撤销/二维码+`ShareLink` 分享 `/pass.html?code=`；管理员另有门列表 `/admin/access/doors`、通行记录 `/admin/access/logs`）+ `PassIssueView` + `PassQRView`。门的规则/子码/禁入时段仍只在网页配。
- `AppsTabView` 顶部「管理工具」磁贴区（搜索/分类筛选时隐藏）；`APIClient.request(method,path,body,token)` 通用方法。
- ⚠️ 本机无 Swift 工具链，靠 push 后 GitHub Actions 编译验证；ForEach 刻意不用元组 key path（`id: \.0`），改 indices。
- ⚠️ 测试：app-center 权限 4 项（管理员全有 / 组织管理员设备+访客码无用户管理 / 普通用户全无 / 组织会话只剩当前组织）真实服务端跑通。

## v3.5.29 门禁：门子码 + 禁入时段 + 访客陪同带入，主码默认 60 秒（用户反馈）

三级版本。用户：门禁二维码默认 60 秒；主码按用户授权，点门禁/区域可显示子码，子码可设独立规则；访客码同理；可设某时间段无法进入；访客码通过设备验证后需由指定人员带入，指定人扫码则校验成功。

### 模型（我的落地方式，改之前先理解）
- **主码** = 原 qr1（无门信息，开有权限的所有门）。TTL 默认 60（`qrTtl()`，env `ACCESS_QR_TTL` 夹 15~600）。
- **门子码** = 同为 qr1，payload 多 `d=门标签`。「子码的独立规则」落在**门级策略**（`access_doors` 新列）：`code_mode`(any|sub_only)、`sub_ttl`(0=跟随主码)、`escort_required`、`blackout`(JSON 窗口)。`POST /user/access/qr {door_id}` 出子码（先 `evaluateAccess` 有权才签）。
- ⚠️ **门标签而非门 id**：`doorTag(id)=base64url(sha256('door:'+id))[:11]`，`doorMatches(tag,door)` 校验。原因：自研 `qr-mini.js` 最多版本 10（纠错 M=213 字节），子码带完整 UUID 实测 228 字节出不了码（浏览器端 svg=null 回退成文本）。访客子码同理用访客**短码**而非 pass UUID。现长度：主码≈175 / 门子码≈199 / 访客子码≈154。**以后往 qr1/vs1 payload 加字段先算长度。**
- **访客子码** `vs1.<{c:访客码, d:门标签, j, e}>.<sig>`（`signVisitorSub`/`verifyVisitorSub`，HMAC 用同一 qrSecret，签名串前缀 'vs1.' 防与 qr1 混用；jti 一次性，复用 access_qr_used）。公开 `POST /api/public/pass/:code/sub {door_id}`；`GET /api/public/pass/:code` 多回 `door_list[{id,name,sub_only,escort}]`。
- **禁入时段** `normalizeWindows`/`inBlackout`：`[{wd:[0-6],s,e,from,to}]`，复用 `withinSchedule`（跨夜、日期区间）；**每条至少有星期/时段/日期之一，否则丢弃**（防误配成永久禁入）。门的禁入对所有凭证生效；访客码自己的禁入 `visitor_passes.blackout` → `pass_blackout`。
- **门策略统一入口** `doorPolicyCheck(door,{isSub})`：先禁入 `door_blackout`，再 sub_only 且非子码 `need_subcode`。`/v1/access/verify` 四类码都过它：qr1（主/子码；子码门不符 `wrong_door_code`）、vs1、静态访客码、ft1（跨域码无子码机制，sub_only 门不收）。`/v1/access/check`（卡/人脸）**只受禁入约束、不受 sub_only 约束**（不是二维码）。
- **陪同带入**：`visitor_passes.escort_user_id`（签发时填账号，resolveUser）；需陪同 = 门 `escort_required` **或** 访客码指定了陪同人。陪同人 = 指定人，否则签发人。访客验码通过 → `passGrantOrEscort` 写一条 `access_escort_pending`（120 秒，同访客同门去重）并返回 `result:'pending_escort'`（日志 deny/need_escort）；陪同人在同门**自己放行后** `completeEscorts` 消费待陪同、**再核一次访客码**（防等待期间撤销/用尽）、扣次数、日志 allow/escort_ok，响应带 `escorted:[访客名]`。卡/人脸放行也能完成陪同。
- ⚠️ 陪同人本人必须对这扇门有通行权（只在其 ev.allow 时才完成陪同）。

### 前端
- 管理端门弹窗「开门码规则（本门独立）」：模式 / 子码有效期 / 访客须陪同 / 禁入时段编辑器（`bwEditorHtml/bwRowHtml/bwCollect` 门与访客码共用）。签发访客码弹窗加陪同人 + 禁入时段；访客码列表显示陪同人 / 有禁入时段。
- 用户门禁页：每扇门「该门子码」按钮（`showAccessQr(doorId, name)`），标「仅子码 / 当前禁入」。
- `pass.html`：门按钮出该门子码（到期自动刷新）+「通用访客码」切回。`access-terminal.html`：`pending_escort` 黄底「等待陪同人」+ 陪同放行时显示带入名单。
- 系统配置「门禁」组加 `ACCESS_QR_TTL`；init.js ENV_KEYS 同步。iOS `AccessView` 点门出子码（`accessQr(token:doorId:)`）。

### 测试
- 真实服务端 e2e 25 项全过（门策略落库、主码 60s、主码开不了 sub_only、子码 TTL 按门、子码跨门拒、子码一次性、门禁入、无效窗口丢弃、访客码陪同人、门列表、静态访客码过不了 sub_only、访客子码跨门拒、访客子码→pending_escort、别人扫码不带入、陪同人扫码双双放行且扣次数、陪同只消费一次、门需陪同→签发人陪同、等待期间撤销不带入、访客码禁入、无权限不给子码、我能开的门带子码信息）；另两套 35+16 回归全过。
- playwright：门弹窗回填+保存禁入时段、签发弹窗字段、用户门列表出子码 QR（修长度后 svg=true）、访客页门子码 QR、终端等待陪同态，零 JS 报错。

## v3.5.28 应用图片图标 + 我的应用文件夹 + iOS 应用中心桌面式（用户反馈）

三级版本。用户：允许应用上传图片作为图标；手机端不显示应用图标（连 emoji 都没有）；应用要有分组/文件夹，手机端一定要有。

### 图片图标
- ⚠️ **图片放独立表 `app_icons(app_id PK, mime, data BLOB, updated_at)`，不进 `apps`**——到处都 `SELECT * FROM apps` 直接下发，BLOB 进 apps 会被序列化进每个 JSON。`apps.icon_url` 只存公开地址 `/api/public/app-icon/<id>?v=<时间戳36进制>`（换图即换 v，可长缓存）；为空则回退 emoji `icon`。
- `POST /admin/apps/:id/icon`（Lv.2，`express.raw` 原始字节 + `?filename=`，复用 `memo-util.validateAttachment` 扩展名白名单 + magic bytes，只收 image 类，≤512KB，SVG 不在白名单=防 XSS）/ `DELETE` 同路径；公开 `GET /api/public/app-icon/:id`（nosniff + 1 天缓存）。删应用连带清图标和文件夹条目。
- `provider.js` 的 `/oauth/app-info`、`/oauth/consent-info` 回带 `icon_url`；`authorize.html` / `login.html` 的 `isImg` 放行站内相对路径（`/` 开头非 `//`）。
- `dashboard.html`：`appIconInner(a)` 统一渲染（img 或 emoji），市场卡片 / 管理端表格 / 编辑弹窗头 / 已授权应用 / 应用详情都改用它；编辑弹窗「图片图标」行（`uploadAppIcon`/`clearAppIcon`，裸 fetch + Bearer）。

### 我的应用文件夹（个人，非管理员分组）
- 表 `app_folders(id,user_id,name,sort_weight)` + `app_folder_items(user_id,app_id,folder_id, PK(user_id,app_id))`——**一个应用对一个人只在一个文件夹**（assign 用 upsert）。`appFolders` 语句集。
- `GET/POST /user/app-folders`、`PATCH/DELETE /user/app-folders/:id`（删夹=里面应用回未归类）、`PUT /user/app-folders/assign {app_id, folder_id|null}`。全部按 `req.user.uid` 隔离（别人的文件夹 404）。
- 与 v3.4.44 管理员「分类」并存：分类=全局归类（管理员定），文件夹=个人整理。
- 网页市场：文件夹 chip 行（全部 / 各文件夹·数量 / 新建 / 选中时重命名·删除）+ 卡片 📁 按钮弹「移到文件夹」浮层。dev mock 齐。

### iOS（应用中心）
- 新 `AppIconView.swift`（`AsyncImage` 拼 `baseURL + icon_url`，失败/无图回退 emoji + `icon_bg`；`Color(hexString:)` 扩展）。
- `AppsTabView` 重写为桌面式 `LazyVGrid`：文件夹磁贴（2×2 迷你图标）+ 未归类应用；搜索/分类时平铺匹配结果。点应用 `confirmationDialog`、长按 `contextMenu`：打开 / 授权 / 移到文件夹… / 取消授权；「移到文件夹」对话框可新建并放入、移出。文件夹 sheet（`FolderSheet`）可重命名/删除。右上角新建文件夹。`APIClient` 加 `appFolders/appFolderCreate/appFolderRename/appFolderDelete/appFolderAssign`。
- ⚠️ 本机无 Swift 工具链，靠 push 后 GitHub Actions（macos-15）编译验证。

### 测试
- 真实服务端 e2e 新增 16 项全过（非管理员 403、拒 SVG、拒伪造扩展名、超 512KB 413、上传返回 icon_url、公开读取字节一致、市场带 icon_url 且无 BLOB、app-info 带 icon_url、移除后 404、文件夹建/放/一应用一夹/按人隔离/不能动别人的/重命名·移出·删除），原 35 项回归全过。
- playwright 打真服务：管理员编辑弹窗上传图片→预览与表格出现 img；用户市场卡片显示图片图标、📁→新建文件夹并放入→文件夹 chip 出现并可筛选，零 JS 报错。

## v3.5.27 独立安全≠只许密码：改为可叠加的组织附加管控（用户反馈）

三级版本。用户纠正：「独立安全并不代表只允许密码不验证码。意思是组织可以独立管理其下级，在现有的主要安全策略中，再加上其他的管控策略，而不是一棍打死。」
- **语义**：`independent_security` = 组织独立管理下级 + org-scoped 锁定会话（v3.5.26 的后端收口照旧）。**不再**隐含任何登录方式限制。
- **附加管控**（`oauth_subjects` 新列，默认 0，任何组织都可开，不限独立）：`require_org_password`（成员没设组织密码时不回退平台密码）、`deny_code_login`（禁止 `/account/org-login-code`）。`oauthSubjects.setOrgControls`；GET/PATCH oauth-subjects 收发；主体弹窗在「独立安全」下方加两个勾选。
- 密码通道：成员有组织密码 → 只认组织密码；没有 → `require_org_password` 拒绝，否则回退平台密码。验证码通道：去掉「独立组织拒绝」，改看 `deny_code_login`；`org_scoped = !!independent_security`（两通道一致）。
- ⚠️ **一次性迁移**（带版本保护的写法，见交接核查第 4 条教训）：`ALTER ADD require_org_password` 成功（=首次）才紧跟 `UPDATE ... SET require_org_password=1 WHERE independent_security=1`，保住 v3.5.20~26 独立组织「必须组织密码」的原行为；列已存在时 ALTER 抛错、UPDATE 不再执行，管理员改动不会被覆盖（内存库模拟两次启动验证）。
- ⚠️ 测试：真实服务端 e2e 35 项全过（新增：独立组织验证码登录得 org_scoped、deny_code_login 拒绝、无组织密码回退平台密码、require_org_password 拒绝回退、设了组织密码平台密码不认）。
- ⚠️ 本地起测试服务后别用 `pkill -f "node server/index.js"`——会连带杀掉发命令的 shell 自己（命令行里含同样字符串），用 `pkill -f "^node server/index.js"`。

## v3.5.26 组织登录收尾：验证码通道 + org-scoped 会话后端收口（承接 v3.5.20 遗留，至此组织登录遗留项清零）

三级版本。

### ① 组织登录验证码通道
- `api.js` `handleOrgCodeLogin` → `POST /api/account/org-login-code {account(邮箱/手机), code, org}`。顺序：`directLoginSubject` → `subjectGateError`（IP/时段）→ 独立安全组织直接拒（须组织密码）→ 校验 OTP（复用 `email:`/`sms:` 键，5 次上限、一次性）→ 按邮箱/手机找用户，**须为该组织成员、绝不建号**、排公共账号 → 停用 → 强制 2FA → `finishLogin(..., {org, org_scoped:false})`。
- 发码复用 `/email/send-code`、`/sms/send` 带 `org`（v3.5.17 已支持组织专属凭证）。
- `login.html` 组织登录浮层加「组织密码 / 验证码」切换（`olSetMode`/`olSendCode`），复用 `countdown`。

### ② org-scoped 会话后端收口（之前只是前端横幅 + 下拉禁用）
- `auth.js` `requireAuth`：`org_scoped` 令牌每次请求校验组织仍 enabled + allow_direct_login 且本人仍是成员，否则 401「组织会话已失效」；`requireAdmin`：org_scoped 一律 403。
- `api.js`：`isSysAdmin` 对 org_scoped 恒 false；新增 `scopedOrgOf(req)` / `myManagedOrgs(req)`（scoped 时只剩当前组织）。`canManageOrg`/`canManageDevice` 限当前组织；`canManageGroup` 对 scoped 恒 false（分组是平台维度）；`canIssuePass` scoped 时仅当前组织的组织管理员；设备列表/managed-orgs 走 `myManagedOrgs`；`/account/public/switch` scoped 403；`/apps/market` scoped 强制 `org=token.org`（忽略 query）。
- `db.js` 新增 `appVisibleInSession(appId, userId, scopedOrg)`：scoped = 全局应用 + 该组织开放应用（且仍为成员）；否则同 `appVisibleToUser`。`/apps/:id/auth` + `provider.js` 的 consent-info / consent / launch 三处改用它。
- `dashboard.html`：`_isOrgScoped()` 以 **token 的 org_scoped** 为准（localStorage 兜底）；scoped 时隐藏 mode-admin / 公共账号入口，不加载公共账号切换器，按非管理员走（bootToLastPage 丢弃 adm-* 页），组织管理员菜单照常点亮。
- ⚠️ org_scoped 的语义仍是「独立安全组织」才锁定；非独立组织登录（含验证码通道）带 org 但不锁定。（v3.5.27：独立组织不再拒绝验证码，改由附加管控 deny_code_login 决定）

### 测试
- **首次在本仓库跑真实服务端端到端**：`npm install --omit=dev --no-save` 装真依赖（better-sqlite3 等），临时库 seed 后起 `server/index.js`，HTTP 跑 31 项全过：验证码登录（邮箱/手机/错码/一次性/非成员/不建号/独立组织拒绝/用户名拒绝）、IP 白名单对两条通道生效（顺带实测 v3.5.24）、scoped 下管理端 403 / 市场锁 OB / 授权与 OIDC launch 拦 OA 应用 / managed-orgs 与设备只剩 OB / 不能管 OC / 不能切公共账号、普通会话不受影响、移出组织与停用组织后令牌 401。
- playwright 打真服务：登录浮层验证码模式发码→登录→跳 login-success 且 `sso_current_org=OA`；scoped 管理员控制台有横幅、无管理端切换、陈旧 adm-users 记录回退首页；scoped 组织管理员「我的组织」只见 OB + 设备卡，零 JS 报错。
- ⚠️ `node_modules/` 已 gitignore，`--no-save` 不产生 lock 文件。

## v3.5.25 组织管理员的设备管理 UI 入口（承接 v3.5.21 遗留）

三级版本（Web）。v3.5.21 后端已按组织管理员限权（`GET/POST /admin/devices` 走 managedBy、PATCH/DELETE 走 `canManageDevice`），但 UI 只在系统管理员菜单。本版补用户端入口：
- `page-orgadmin`（「我的组织」）加 `org-dev-card`「本组织设备」卡，`loadMyOrgs()` 有组织时显示并 `loadDevices('org')`。
- 设备 JS 参数化：`_devCtx`（`adm`|`org`）+ `_devId(ctx, s)` 映射元素 id（`dev-*` / `org-dev-*`）；`loadDevices/renderDevices/openDeviceModal/delDevice` 都收 `ctx`，保存/删除后按当前 ctx 刷新。管理端按钮显式传 `'adm'`。
- `org` 视图：只列 `subject_id ∈ 我管理的组织` 的设备（系统管理员在此页也一样，无组织设备去管理端看）；多组织时出组织筛选下拉；登记弹窗不给「不归属组织」选项（后端 `resolveDeviceFields` 对非系统管理员本就拒绝）。
- ⚠️ 测试：dev 浏览器（playwright）实测——组织管理员看到卡片+设备列表、弹窗组织下拉只含所管组织、新增「李四的 iPad」入列、搜索、删除；管理端设备页仍有「不归属组织」选项；全程无 JS 报错。后端未改。

## v3.5.24 组织登录通道执行组织登录策略（IP 白名单 / 登录时段）（安全修复，承接 v3.5.20 遗留）

三级版本。v3.5.20 遗留「独立安全组织的 IP/时段策略在 org-login 路径的执行」——之前 v3.4.32 的主体策略只在 `oauth.js` `loginSuccess`（三方登录）执行，`/account/org-login` 可绕过 IP 白名单与登录时段。
- 新文件 `server/org-policy.js`：`withinLoginWindow(start,end,now)` + `subjectGateError(subj, ip, now)` → null | `ip_denied` | `time_denied`。从 oauth.js 抽出，**两条通道共用**，改策略判定只改这一处。
- `handleOrgLogin`：`directLoginSubject` 之后、解析用户/校验密码**之前**执行 `subjectGateError`（组织级、与用户无关——先拦可避免「拒绝即说明密码正确」的泄露），403 + `code`，记登录日志。
- ⚠️ 语义变更：组织登录的「强制 2FA」从 `independent_security && require_2fa` 改为只看 `require_2fa`，与三方登录通道一致（之前非独立组织勾了强制 2FA 但组织登录不拦，属漏洞）。
- 主体弹窗「登录策略」标题改为「经该主体三方登录 /『登录到组织』时强制执行」。
- ⚠️ 测试：`scratchpad/org-policy-test.js` 15 项全过（日内/跨夜/边界/非法放行、CIDR/精确/::ffff:/空白列表、时段拒、只填一端不拦、IP 优先）。HTTP 层同既有约束未端到端跑（无 node_modules）。
- （v3.5.20 遗留的 org-login 验证码、「不可切换」收口已在 v3.5.26 做完；v3.5.21 遗留的组织管理员设备 UI 入口已在 v3.5.25 补上）

## v3.5.23 API-docs 逐接口补全（开放 API 全覆盖）（用户反馈）

三级版本（纯文档）。承接 v3.5.22，把 `API-docs.md` 的开放 API 从「选摘」补成**全部 45 个 `/v1/*` 接口全覆盖**：
- 6.0 速查表补 设备（`/v1/devices` + heartbeat）、配置（`GET·PUT /v1/watermark`）行。
- 新增分节：6.15 设备管理（台账同步 + 心跳，含 kind/status 过滤与响应结构）、6.16 防截图水印策略（GET/PUT 字段表）、6.17 外部通讯录导入（members/remove_missing 语义 + 结果结构）。
- 版本头 v3.5.21→v3.5.23，去掉「选摘」免责声明，改为「/v1 已逐接口补全；第七章管理端接口仍为主干 + 概述」。
- ⚠️ 对照 `server/api.js` 的 45 条 `router.*('/v1/...')` 核对，均有速查表 + 分节（部分归并在 6.13 积分商城 / 6.14 门禁）。

## v3.5.22 文档交接更新（CLAUDE / README / API-docs 追平到 v3.5.x）（用户反馈）

三级版本（纯文档）。用户：做文档交接，很多没写完。把三份主文档追平到当前实现：

- **CLAUDE.md**：① 顶部「功能范围」从一句话扩成按模块分类的完整清单（登录/IAM/应用接入/自建能力/门禁设备/客户端）；② 技术栈补 iOS/App 说明、dashboard 行数更新为 ~9000；③ 目录结构补 twofa.js/passkey.js + public 全量文件（pass/access-terminal/brand-icons/qr-mini/webauthn-glue）+ ios/ + .github/workflows + CHANGELOG.md；④ 「数据库表清单」从 v3.2.0 追平到 v3.5.21（IAM/KYC/核验/审计/门禁/设备/内容各组 + users/apps 关键增补列）。
- **README.md**：登录方式加「登录到组织(IAM)」；用户端/管理端补组织管理·IAM 登录/设备管理/身份核验/关于更新；新增「门禁/设备/跨系统联邦」节；目录结构补齐 server/public/workflows/CHANGELOG；开放 API 表加门禁/设备行、计数 37→40+。
- **API-docs.md**：版本头 v3.5.0→v3.5.21 + 选摘说明；scope 表补 config:read/write、access:verify/read、device:read。
- ⚠️ API-docs 仍是**选摘**（主干接口详，较新接口以 `server/api.js` 的 `/v1/*` 实现 + dashboard「API 调用」内置文档为准）——逐接口补齐是后续工作，非本次范围。

## v3.5.21 设备管理（登记 + 台账：Apple/Google/Microsoft/门禁机/读卡器）（用户反馈）

三级版本。用户要设备管理模块。已问用户确认：**第一版做登记+台账**（不接真实 MDM）；**归属用户+组织都行**（组织管理员只管本组织）；**门禁机/读卡器复用/关联现有门禁**。

### 数据（db.js）
- `devices(id,name,kind,serial,owner_user_id,subject_id,door_id,status,tags,note,last_seen,created_at,updated_at)`。
  - `kind` = apple|google|microsoft|access_controller|card_reader；`status` = active|disabled|lost。
  - `subject_id` 归属组织（登录主体）；`door_id` 仅门禁机/读卡器可关联 `access_doors`。
- `deviceStmts`：all / bySubjects（`json_each` 取多组织，组织管理员用）/ get / insert / update / setStatus / touch（心跳刷 last_seen）/ remove。导出 `devices`。

### 后端（api.js）
- 权限：`canManageDevice(req,dev,write)` = 系统管理员 或 该设备所属组织的组织管理员；无组织的设备仅系统管理员。`resolveDeviceFields` 校验 kind/status 白名单、组织存在、**非系统管理员只能归到自己管理的组织**、所有者 resolveUser、门存在且仅门禁机/读卡器可关联。
- 管理端：`GET /admin/devices`（系统管理员看全部；组织管理员看自己组织的，附可归属组织 + 门列表）、`POST/PATCH/DELETE /admin/devices`。
- 开放 API（新 scope `device:read`，有 sandbox 桩）：`GET /v1/devices`（台账同步，可按 kind/status 过滤）、`POST /v1/devices/:id/heartbeat`（在线设备刷 last_seen）。ALL_SCOPES 同步加 device:read。

### 前端（dashboard.html）
- 管理端新增「设备管理」菜单页（`ni-adm-devices`/`page-adm-devices`/`loadDevices`+`renderDevices`）：列表（类型/状态/序列号/归属/关联门/心跳/标签）+ 类型筛选 + 搜索 + 登记/编辑弹窗（`device-modal` 动态填充，门禁机/读卡器才显示「关联门」）+ 删除。PAGE 标题 + goto 调度 + dev mock 齐。
- ⚠️ 测试：dev 浏览器实测——设备列表渲染、登记弹窗（kind=门禁机显门关联、apple 隐藏）、新建「张三的 MacBook」入列、搜索过滤、控制台无代码错误（仅静态资源 404）。db 层 json_each 本地验证可用。
- ⚠️ 本版「设备管理」菜单在系统管理员菜单（nav-admin）；**组织管理员的 UI 入口**（用户侧「我的组织」里管设备）后端已就绪（GET/POST 已按 managedBy 限权），UI 入口留后续。真实 MDM/协议纳管（下发配置/锁定/擦除）属另一档工作量，按确认未做。

## v3.5.20 登录到组织（IAM 用户）+ 组织自有密码 + org-scoped 会话（用户反馈）

三级版本。用户要点：① 组织若开自有密码/独立安全策略，则优先独立功能；② 网页「登录到组织」太抢眼→挪到忘记密码右边做成入口「登录到组织（IAM 用户）」，仅登录到某组织、不可切换（除非安全策略同主账号）；③ 组织可控制其子用户。本版落地「登录入口 + 组织自有密码 + org-scoped 会话」。设备管理（下一版）。

### 模型（已问用户确认）
- **复用平台账号 + 限定组织**（不是全新账号类型）：子用户 = 该组织的 `org_members` 成员（现有平台自然人）。
- **组织自有密码 + 独立策略**：`org_members.password_hash`（组织给成员设的、独立于平台的组织密码，bcrypt）；`oauth_subjects.independent_security`（开启=组织跑自己的安全：组织密码 + 强制 2FA 等，且 org-scoped 不可切换）。
- **优先独立功能**：org-login 校验**优先组织密码**；无组织密码时——独立安全组织**拒绝回退**（必须组织密码），非独立组织才回退平台密码。

### 后端（api.js / db.js / auth）
- `finishLogin(res,user,req,method,extra)` + `/2fa/login-verify`：token 带 `org`/`org_scoped`，2FA 中间态也带、过二段后保留。
- `POST /api/account/org-login {account,password,org}`（`handleOrgLogin`）：`directLoginSubject` 校验组织开放 → `resolveUser` + 必须是成员 → 密码分支（上述优先级）→ 独立安全组织强制 2FA（未开拒绝）→ `finishLogin(..., {org, org_scoped: !!independent_security})`。独立=锁定(org_scoped)，非独立=带 org 但可切换。
- 组织管理员管子用户密码：`PUT /admin/orgs/:sid/members/:uid/password`（≥6 位，bcrypt，审计 `org.member_password_set`）/ `DELETE`（清除，审计 `org.member_password_cleared`）。`canManageOrg` 门。
- `oauth_subjects.independent_security` 迁移 + `setIndependentSecurity`；GET/PATCH oauth-subjects 收发；`org_members.password_hash` 迁移 + `setPassword`；`listBySubject` 加 `has_pw`。

### 前端
- `login.html`：**移除主表单抢眼的组织下拉**；忘记密码右边加「登录到组织（IAM 用户）」→ `showOrgLogin()` 浮层（组织下拉[显性] + 组织码搜索[不显性] + 账号 + 组织密码 → `/account/org-login`）。成功写 `sso_current_org` + `sso_org_scoped`；个人登录会清这两个。
- `dashboard.html`：`_isOrgScoped()` 为真→顶部蓝色横幅「仅组织会话·不可切换」+ 退出按钮；应用市场组织下拉锁定当前组织（disabled）。主体弹窗加「独立安全」勾选；成员行加「组织密码」设置/清除 + 🔑 已设徽章（`has_pw`）。dev mock 补密码设/清。
- ⚠️ 测试：org-login 决策表 node:sqlite 风格 10 项全过（组织密码优先/错、非独立回退平台、独立拒绝回退、非成员、停用、独立强制 2FA 未开/已开、org_scoped 标记）；dev 浏览器实测 login.html——主表单无组织下拉、入口在忘记密码右边、浮层组织下拉+组织码 secretb1 注入选中、提交 org-login body 正确且 `sso_current_org=o2`/`sso_org_scoped=1`。
- ⚠️ 未做（后续）：org-login 走验证码（当前密码为主）、独立安全组织的 IP/时段策略在 org-login 路径的执行（v3.4.32 的在三方登录路径）、dashboard 更彻底的「不可切换」收口。设备管理单列下一版。

## v3.5.19 线性发行记录 + 自动 GitHub Release（流程改进）（用户反馈）

三级版本。用户要求「每次推送都要有线性发行版记录，不只是打标签」。

- 新增 `CHANGELOG.md`：线性发行记录（随仓库走的文件，不受发版工作流 `rm -rf .git` 影响）。**以后每次发版在其顶部追加一条 `## vX.Y.Z`**（五处版本号之外的第 6 处同步点）。
- 新增 `.github/workflows/release.yml`：推送 `v*` tag → GitHub Actions 用内置 `GITHUB_TOKEN` 自动创建/更新该 tag 的 Release，说明用 awk 从 `CHANGELOG.md` 抽对应小节。**本地无 gh 登录/无 GH_TOKEN 也能出 Release**（之前只打 tag）。
- ⚠️ 发版清单现为：`package.json` / `index.js` versionLink / `README.md` 标题+徽章 / `CLAUDE.md` 顶部 + 变更条 / **`CHANGELOG.md` 顶部新条**。
- ⚠️ awk 抽取已本地验证（v3.5.19 / v3.5.17 小节正确切出）；真实 Release 创建靠 tag 推送触发（本版 tag 即首次验证）。

## v3.5.18 组织可见性收尾：成员跨组织复用 + 不显性组织（组织码登录）（#3 大功能）（用户反馈）

三级版本。#3 最后一块「多主体成员 可开放/不开放」+ 本版用户追加的「不显性组织靠组织码登录（临时用）」。

### 成员跨组织复用（组织「成员开放」）
- `oauth_subjects.members_open`(0/1)：开启后其他组织管理员可查看并复用本组织成员，避免重复建号。
- `orgMembers.shareableFor(sid,sid)`：列其他 `members_open=1 && enabled` 组织的成员，排除本组织已有成员与公共账号，按自然人去重 + 来源组织名（上限 200）。
- `GET /admin/orgs/:sid/shareable?q=`（canManageOrg 读）：可复用成员池，**联系方式脱敏**（maskEmail/maskPhone）+ 来源组织名；复用加入仍走 `POST /members`（按 UID 复用同一自然人账号）。
- 主体弹窗加「成员开放」勾选；成员弹窗加「🔗 从开放组织复用成员」（搜索 + 复用按钮）。

### 不显性组织 + 组织码登录（用户追加需求：适用于临时）
- `oauth_subjects.org_code`（唯一短码，8 位无易混字符，allow_direct_login 时按需生成）+ `direct_listed`(0/1，默认 1)。
  - 显性（direct_listed=1）：在登录页「登录到组织」下拉里列出。
  - 不显性（direct_listed=0）：**不在下拉里**，只能靠组织码在登录页搜索到并直登。
- `GET /api/public/orgs`：只列 `enabled && allow_direct_login && direct_listed`（显性）。
- `GET /api/public/org-by-code?code=`：按组织码解析（`enabled && allow_direct_login`，显性/不显性都可），返回 {id,name}；无效/停用/非直登 → 404。
- `ensureOrgCode(s)`：allow_direct_login 组织缺码时生成唯一码（撞库重试）；GET 列表懒生成、PATCH 开直登时确保有码。
- 登录页 `login.html`：下拉下方加「组织码」输入 + 搜索（`searchOrgCode`）→ 命中则作为选项选中；另有「🔑 用组织码登录到组织」入口（无显性组织时也能展开，`revealOrgArea`）。选中后 send-code/login 带 `org`，走该组织凭证（含不显性）。
- 主体弹窗：加「在登录页下拉列出（显性）」勾选 + 展示只读「组织码」（可复制）。
- ⚠️ `directLoginSubject` 只校验 `enabled && allow_direct_login`（不看 direct_listed），所以不显性组织被组织码选中后，其专属短信/实名凭证照常生效。

### 测试
- 成员复用决策 node:sqlite 9 项（v3.5.17 覆盖的同套）+ 本版组织可见性/组织码 10 项全过（公开列表只含显性、不显性按码可达、大小写不敏感、停用/错误码拒绝、ensureOrgCode 唯一+幂等、非直登不生成）。
- dev 浏览器实测 login.html：显性组织下拉自动显示、输入组织码 `secretb1` → 注入「不显性B公司（组织码）」并选中、错误码报错、选中后登录 body 带 `org:o2` 且 `sso_current_org` 落地。
- ⚠️ 成员池/复用加入的真实 HTTP 链路（express）未端到端跑（同既有约束），靠 shareableFor 单测 + 逻辑审查；dashboard 侧为 dev-mock + 结构校验。

至此 **#3「按主体/组织配凭证 + 多主体成员 + 登录流程」全部完成**（短信邮件 v3.5.15 / 实名 v3.5.16 / org-first 登录 v3.5.17 / 成员复用 + 不显性组织码登录 v3.5.18）。

## v3.5.17 组织专属凭证·第三步：org-first 登录（闭环）（#3 大功能）（用户反馈）

三级版本。把 v3.5.15/16 的组织专属短信/邮件/实名凭证真正「用起来」——登录页可「直接登录到某组织」，
登录后自助实名按当前组织凭证走。至此 #3「按组织配凭证」闭环。

### 后端（api.js）
- 公开 `GET /api/public/orgs`：只列 `enabled && allow_direct_login=1` 的组织（只给 id/name，无任何凭证/成员）。
- 辅助：`directLoginSubject(orgId)`（enabled+allow_direct_login 才算）/ `directLoginMsgCfg(orgId)`（该组织 msg_config，公开面只认已 opt-in 直登的组织）/ `memberMsgCfg(user,orgId)` / `memberKycCfg(user,orgId)`（**仅当用户确为该组织成员**才用其凭证，否则回退 userMsgCfg/userKycCfg）。
- `/sms/send`、`/email/send-code` 收可选 `org`：用 `directLoginMsgCfg(org)` 覆盖下发（`hasMessageHub(orgCfg)` + `sendSmsCode/sendEmailCode(..., orgCfg)`）。
- 自助实名 `/user/kyc/session`、`/user/kyc/direct` 收可选 `org`：用 `memberKycCfg(user, org)`（成员才生效）。
- ⚠️ 支付宝回调查询要和 initialize 用同一组织凭证：`kyc_pending` 加 `org_id` 列 + `kycPending.setOrg`；alipay 会话（自助成员 / 开放 API 显式 org）落 org_id，回调 `queryAlipayCertify` 用 `subjectKycCfg(pending.org_id)`（回退 userKycCfg）。
- ⚠️ 安全：公开发码只认 `allow_direct_login` 组织的凭证（opt-in）；自助实名的组织凭证**必须成员**（`orgMembers.get` 校验），非成员一律回退，防越权借用他组织凭证。

### 前端
- `login.html`：账号输入上方加「登录到组织」选择器（`login-org`/`login-org-wrap`，`loadLoginOrgs()` 拉 `/api/public/orgs`，有则显示）；`sendLoginCode`/`doLogin` 带上 `org`；登录成功把选择写入 `localStorage.sso_current_org`（个人账号则清除）。
- `dashboard.html`：`curOrgId()`/`withOrg(body)` 读 `sso_current_org`，三处自助实名调用（`startKyc`/`submitKycInfo` 的 session + direct）带上 `org`。（`sso_current_org` 本就被 v3.4.19 应用市场组织下拉共用。）
- ⚠️ 测试：org-first 决策逻辑 node:sqlite 9 项全过（开放+有凭证用之 / 未开放·停用·空凭证回退 / 成员传 org 用组织实名凭证 / 非成员回退 / public/orgs 只含 enabled+direct）；dev 浏览器实测 login.html：选择器显示+填充、选 A公司后 send-code body 带 `org:o1`、密码登录 body 带 `org:o2` 且 `sso_current_org` 落地 o2。
- ⚠️ 真实短信/实名服务商链路无凭据无法端到端（同 v3.5.15/16），靠覆盖层单测 + 逻辑审查。

至此 #3「按主体/组织配凭证」三步做完（短信邮件 v3.5.15 / 实名 v3.5.16 / org-first 登录闭环 v3.5.17）。
后续（#3 剩余）：多主体成员「可开放/不开放」共享可见性。

## v3.5.16 组织专属凭证·第二步：实名(KYC)（#3 大功能）（用户反馈）

三级版本。承接 v3.5.15，把实名(KYC)凭证也做成「按组织覆盖」。org-first 登录仍排 v3.5.17（闭环消费点）。

### kyc.js 支持「覆盖凭证」（零行为变化，并发安全）
- 新增 `envGetter(override)` → 返回 `E(key)`：override（组织 `kyc_config`，env 同名键）非空值优先，否则回退 `process.env`；`envGetter(null)` 即直读全局（导出的 `ENV` 默认读取器）。
- **5 家服务商函数全部加可选 `E = ENV` 参数**，把 `process.env.X` 换成 `E('X')`：createDiditSession / createStripeSession / verifyViaAliyunKYC / verifyViaVolcengineKYC + 支付宝整条签名链（ALIPAY_GATEWAY / alipaySign / alipayVerify / alipayCommonParams / alipayBuildParams / alipayParseResponse / alipayPost / createAlipaySession / queryAlipayCertify）。
- 两个编排入口：`createKycSession(userId, cb, {orgKyc})` 用 `envGetter(opts.orgKyc)`；`verifyKycDirect(name, id, orgKyc)` 用 `envGetter(orgKyc)`。可用性判定（available）也走 `E`。
- ⚠️ **刻意用「参数透传 E」而非模块级覆盖变量**：支付宝发起含 initialize→certify 两段 await，模块级覆盖会被并发的另一组织请求冲掉；E 随调用栈走才并发安全。`envGetter` 已导出供 api.js（回调查询）与测试复用。
- ⚠️ 测试：envGetter 合并 8 项全过（无 override 回退 / 覆盖 / 去空白 / 空串与纯空白视为未设回退 / null 回退）。真实 KYC 服务商链路无法本地端到端（无凭据），靠逻辑审查 + envGetter 单测。

### api.js 接入
- `subjectKycCfg(sid)` + `userKycCfg(user)`（成员所属组织里第一个配了 kyc_config 的），与 v3.5.15 的 msg 版同构。
- 用户自助 `/user/kyc/session`、`/user/kyc/direct` 用 `userKycCfg(user)`；支付宝回调 `/auth/kyc/callback` 的 `queryAlipayCertify` 用 `kycEnvGetter(userKycCfg(qUser))`（**查询必须和 initialize 用同一套组织凭证签名**）。
- 开放 API `/v1/users/:uid/kyc/session`、`/v1/users/:uid/kyc/verify` 支持可选 `org`（主体 id，显式指定组织凭证）→ `subjectKycCfg(org)`，不传则回退该用户所属组织。
- `PATCH /admin/oauth-subjects/:id` 收 `kyc_config`（对象→JSON，空对象=清空回退全局，走 `setKycConfig`）；`GET` 回带 `kyc_config`。

### 前端（组织管理）
- 主体弹窗加第二个折叠区「组织专属凭证（实名 / KYC）· 可选」：按服务商填（Didit/Stripe/阿里云/火山/支付宝常用键，支付宝私钥用 textarea）。openSubjectModal 回填 `subj.kyc_config`、saveSubject 采集进 `kyc_config`（空值不写、空对象清空回退全局）。

## v3.5.15 组织专属凭证·第一步：短信/邮件（#3 大功能）（用户反馈）

三级版本。#3「按主体/组织配凭证」第一步——组织可覆盖自己的短信/邮件(QWQ Message)凭证，没配回退全局。实名(KYC) 放 v3.5.16、org-first 登录放 v3.5.17。

### message.js 支持「覆盖凭证」（零行为变化）
- `resolveCfg(override)`：override（组织 msg_config，env 同名键）优先，否则回退全局 env。`isConfigured(override)` / `dispatch(payload, override)` / `sendSmsCode(phone, x, override)` / `sendEmail(to,subj,html,override)` / `sendEmailCode(email,code,override)` 全部加可选 override 参数——**不传即全局，所有既有调用方零改动**。
- ⚠️ 测试：resolveCfg 全覆盖 / 部分覆盖(url 回退全局) / isConfigured 合并 本地跑通。

### 数据 / 接口
- `oauth_subjects` 加 `msg_config`(JSON) / `kyc_config`(JSON，v3.5.16 用) / `allow_direct_login`(v3.5.17 用)；`oauthSubjectStmts` 加 setMsgConfig/setKycConfig/setDirectLogin。
- `PATCH /admin/oauth-subjects/:id` 收 `msg_config`(对象→JSON，空对象=清空回退全局) + `allow_direct_login`；`GET` 回带 msg_config/allow_direct_login。
- `api.js`：`subjectMsgCfg(sid)` + `userMsgCfg(user)`（成员所属组织里第一个配了专属凭证的）。**已接入** `/admin/users/:id/send-kyc-link`（给成员发实名提醒短信/邮件走其组织凭证）。
- 其余通用发码流程（注册/登录/改绑）暂仍走全局——需显式组织上下文，待 v3.5.17 org-first 登录接入。

### 前端（组织管理 = 原登录主体）
- 主体弹窗加「组织专属凭证（短信/邮件）· 可选」折叠区（URL/KEY/短信组/邮件组/自建模板）+「允许直接登录到本组织」勾选；openSubjectModal 回填、saveSubject 采集（空值不写、空对象清空回退全局）。dev 实测回填。

## v3.5.14 iOS 关于/更新 + 许可协议（用户反馈）

三级版本（iOS）。用户：App 端把「关于应用/更新」同样做了，许可协议也写里面。

- `ios/QWQSSO/AboutView.swift`（**新文件**）：App 版本（Bundle）+ 当前网域 + 「检查更新」（调 GitHub tags 取最新发布，复用 semver 比较）+ 许可协议（`DocView` 拉 `/api/public/document/terms|privacy` 富文本 HTML→`NSAttributedString`→`AttributedString` 原生渲染，带外链）+ 官网/仓库链接 + 版权。
- `APIClient`：加 `publicDocument(key)` / `latestTag()`。`MeTabView` 功能区加「关于 / 更新」入口。
- **「快捷出码」**：iOS App 早已有（v3.5.1 首页醒目门禁卡 → AccessView 本地出码，一屏可达），本版未另加 Home Screen Quick Action——它需覆盖 SwiftUI 的 scene 生命周期、风险高且本机无法真机验，留待需要时再上。
- ⚠️ 仍靠 GitHub Actions（macos-15）云端编译验证。

### 下一步（已与用户确认）
**#3 按组织配凭证（短信+实名）+ 多主体成员 + 登录流程（主账号切换 + 登录页直接选组织）**——大架构，接下来分版本做。

## v3.5.13 OIDC Back-Channel Logout + 登录主体改名「组织管理」+ 版权链接（用户反馈）

三级版本。三件：

### ① OIDC Back-Channel Logout（SSO 主动通知登出，标准补充 webhook）
- `apps` 加 `backchannel_logout_uri`。`provider.js` 导出 `backchannelLogout(app, sub)`：用应用 `client_secret` 签 `logout_token`（HS256，含 `events:{backchannel-logout}`），POST form `logout_token=` 到该地址。用标准 OIDC 库的应用天然支持。
- 触发点与 v3.5.11 webhook 并列：用户停用（`deprovisionUserAllApps`）、撤销授权（`DELETE /apps/:id/auth`）同时发 BCL。discovery 加 `backchannel_logout_supported:true`。
- POST/PATCH apps 收 `backchannel_logout_uri`；应用表单加该输入（新建+编辑）。
- ⚠️ SCIM / Wallet 阶段二 / 安卓 Google Wallet **未做**——SCIM 需支持 SCIM 的目标应用才能端到端验、Wallet 需长期缺的 Apple 证书，盲做无意义，待真实接入再上。

### ② 「登录主体」改名「组织管理」
- 管理端菜单/标题「登录主体」→「组织管理」（adm-oauth）；弹窗标题「新增组织（登录主体）」；页内保留「主体/凭证」术语（组织=主体模型不变）。
- 为避免与 v3.5.8 用户端「组织管理」撞名，**用户端那个（组织管理员的成员管理，orgadmin）改名「我的组织」**。

### ③ 版权链接
- 页脚 `Copyright © 2026 QWQ INC.` 的「QWQ INC.」默认链接到 `https://qwq.us`（index.js buildFooterHtml，仍硬编码版权文本）。

⚠️ 测试：backchannel_logout_uri 列 + logout_token 走既有 jwt.sign（与 id_token 同路径）；语法校验通过；真实应用 BCL 回调未端到端跑（无接收方）。

### 本批用户还提的、待办（已沟通，未在本版）
- **按主体/组织配不同凭证（短信/实名等）+ 多主体成员 + 域优先登录流程**：大的架构扩展，下一版先出设计确认。
- **iOS：关于/更新页 + 许可协议**（对齐 Web 的 v3.5.6/登录协议）。
- **iOS：访客码/门禁码放进 App 快捷方式**（Wallet 之前的替代，App 内已有 AccessView 出码，可再加快捷入口）。

## v3.5.12 身份核验（核验员扫码查脱敏身份卡）（用户反馈）

三级版本。用户：被授权者能复用门禁扫码来**核对身份**（外部活动等），看脱敏姓名(许*/王*兴)、所在主体/分组、生日年月、别名、其他可增删字段。范围由我定。

### 数据（db.js）
- `verify_fields(id, field_key, label, kind[text|date], masked, sort_order, enabled)` 自定义核验字段（可增删）；`user_verify_values(user_id, field_id, value)` 每人值；`access_verifiers(id, user_id, subject_id, valid_from, valid_to, note)` 核验员授权（长期/限期，可限定组织）。db 导出 `verify`。

### 后端（api.js）
- `maskPersonName`（许明→许* / 王建兴→王*兴 / 欧阳娜娜→欧**娜，保留首尾）、`maskValue`、`verifierOf(req)`（管理员天然是核验员；否则查 access_verifiers 有效行）、`buildVerifyCard`（脱敏姓名+主体+分组+启用自定义字段，date 只给年月，masked 字段脱敏，只给有值的）。
- `POST /verify/scan`（requireAuth+noPublic，须核验员）：验签对方 `qr1` 码**只读不消耗**（`verifyQr consume:false`）→ 取用户 → 核验员若限定组织则校验成员 → 返回核验卡 → 审计 `verify.checked`。
- 管理端：核验字段 CRUD `/admin/verify/fields`、核验员 CRUD `/admin/verify/verifiers`、某用户字段值 `GET/PUT /admin/verify/values/:uid`（读 Lv.3 / 写 Lv.2）。`GET /user/verify/status` 供前端点亮菜单。

### 前端（dashboard.html）
- 管理端「身份核验」菜单页：核验字段卡（新建/编辑[名称/类型/脱敏/启用/排序]/删除 + 「填写用户字段值」弹窗）+ 核验员卡（授权[账号/限定组织/生效失效]/撤销）。
- 用户端「身份核验」菜单（**仅核验员可见**，`checkVerifierNav` 点亮）：`BarcodeDetector` 扫码 + 粘贴码 → 核验卡（大字脱敏姓名+UID+主体+分组+字段）。离开页关摄像头；USER_PAGES/bootToLastPage 同步。AUDIT 补 verify.checked；dev 有 mock。
- ⚠️ 测试：maskPersonName 各长度 + verify 字段/值/核验员语句用 node:sqlite 跑通；dev 浏览器实测管理端字段/核验员/弹窗 + 用户端扫码卡（许*/主体/分组/生日年月/别名脱敏）。iOS 核验屏放后续。

## v3.5.11 跨域/临期账号生命周期：令牌自省(拉) + 主动撤销推送(推)（用户反馈）

三级版本。用户指出 v3.5.7 缺口：跨域/临期身份登录了第三方应用，但**应用没有 IAM 权限创建/删除/停用这些临期账号** → 会留"幽灵账号"。两手补上（推 + 拉）：

### 拉：令牌自省（RFC 7662）+ 生命周期声明
- 联邦登录的 `id_token`/`userinfo` 加 `account_type:'federated'` + `valid_until`（来自 peer.valid_until），应用一眼识别临期身份。
- `POST /oauth/introspect`（client_id/secret 认证，只认自己的令牌）：普通令牌 active=用户在+未停用+未撤授权+未过期；**联邦令牌 active 实时反映伙伴是否被撤销/到期**——撤销伙伴后其所有临期会话 introspect 立刻 `active:false`。discovery 加 `introspection_endpoint` + claims_supported 补 account_type/valid_until/from_peer。
- ⚠️ 应用只需"查"、不需任何写权限即可据此停用本地账号。

### 推：SSO 主动撤销推送（应用无 introspection 时）
- `apps` 加 `deprovision_url`（账号撤销回调）。`deprovisionPush(app,payload)`：用应用 `client_secret` HMAC 签名（`X-QWQ-Signature: sha256=…`）POST 事件给应用。
- **自动推送时机**：用户被停用（`/admin/users/:id/disable` + `/v1/users/:uid/disable`）→ 推给其授权的所有应用 `user.disabled`；撤销授权（`DELETE /apps/:id/auth`）→ `authorization.revoked`；**撤销联邦伙伴（`DELETE /admin/access/peers/:id`）→ 推给其开放应用 `federation.revoked`（含 sub_prefix=fed:peer_code:，停用该伙伴全部临期账号）**。
- 手动：`POST /admin/apps/:id/deprovision {uid}` 把「撤销某用户账号」推给某应用（审计 `app.deprovision_pushed`）。
- 前端：应用新建/编辑表单加「账号撤销回调」输入；AUDIT_EVENT_LABEL 补 app.deprovision_pushed。

### ⚠️ 硬边界（已向用户说明）
SSO 要"主动控制"应用账号，**应用必须至少暴露一个撤销入口**（本版的 deprovision webhook / 或 introspection / 或 SCIM）。对完全无任何集成点的黑盒应用，无法伸手进其库——只能靠不发持久令牌（短效+不续期）。本版给了最低门槛的签名 webhook（比 SCIM 易实现）+ 标准 introspection。

⚠️ 测试：introspect 联邦分支（伙伴有效→active、停用/删除→active:false）+ apps.deprovision_url 列 + HMAC 签名用 node:sqlite 跑通；语法校验通过。真实应用回调/跨网络推送（fetch）未端到端跑（无接收方），逻辑为标准 HMAC+fetch。后续可加 OIDC back-channel logout（主动通知登出）/ SCIM client。

## v3.5.10 访客码进 Apple Wallet（阶段一：生成+签名 .pkpass）（用户反馈）

三级版本。用户：访客码做成 Apple Wallet（+安卓排期）更快出码、信息可更新。本版做**阶段一**（生成+添加到钱包）；自动更新（PassKit web service + APNs）排阶段二。

### 机制（server/pkpass.js，新文件）
- `buildVisitorPass(p, doorNames)` → 签名好的 `.pkpass` Buffer。条码=访客码（QR），字段=访客名/有效期/可通行门。
- **签名交给 `passkit-generator`（新依赖，懒加载——未装/未配不影响服务启动）**；需 Apple「Pass Type ID 证书」。
- **图标自生成**：`solidPng(size,rgb)` 用 zlib + 自写 crc32 现生成纯色 PNG（icon/logo 各尺寸），不往仓库塞二进制；管理员可后续换品牌图。
- `isConfigured()` = `APPLE_PASS_TYPE_ID + APPLE_TEAM_ID + APPLE_PASS_CERT + APPLE_PASS_KEY + APPLE_WWDR_CERT` 齐全。

### 接口 / 前端
- `GET /api/public/pass/:code/pkpass`（公开）：未配证书 501；访客码失效 410；否则返回 `application/vnd.apple.pkpass` 下载（iOS 自动「添加到钱包」）。
- `GET /api/public/pass/:code` 多返回 `wallet`（是否已配证书）。
- `public/pass.html`：`wallet=true` 且有效时显示「添加到 Apple Wallet」黑色按钮（深色模式反白），点击即下 .pkpass。
- 系统配置加「Apple Wallet」组（8 个 env：Pass Type ID / Team ID / 证书 / 私钥 / 私钥密码 / WWDR / 组织名 / 背景色）；init.js ENV_KEYS 同步。

### 证书门槛（用户已知悉，去申请）
需 Apple Developer（$99/年）→ 建 Pass Type ID + 下载其证书(.p12→PEM) + Apple WWDR 中间证书，PEM 文本填进系统配置。未配则按钮隐藏、端点 501。

⚠️ 测试：pkpass 模块 `isConfigured()` 默认 false（gated）、`solidPng(29)` 生成合法 PNG（签名+IHDR 29x29，95B）本地跑通；语法校验通过。
⚠️ **签名/真机未端到端跑**——本机无 Apple 证书、`passkit-generator` 未装（Zeabur 部署时 npm 安装）。功能在配证书前完全惰性，不影响线上。签名正确性需用户配真证书后在 iPhone 实测。阶段二（撤销/延期自动刷新）、安卓 Google Wallet 后续。

## v3.5.9 联邦配对简化：生成跨域码粘贴 / 伙伴域直推（可用域白名单）（用户反馈）

三级版本。用户：联邦手动拷 peer_code+密钥太繁琐——改成「一个系统生成跨域码，另一个粘贴/或由伙伴域直推」。
确认：① 生成跨域码→对方粘贴 ② 伙伴域直推（仅推送校验「可用域」白名单；粘贴不校验，管理员亲自操作）。

### 机制（access.js）
- `makePairCode({peer_code,secret,domain})` → `pc1.<base64url(JSON)>`；`parsePairCode` 还原。⚠️ 配对码 = 密钥等价物，走 HTTPS/带外/白名单推送。

### 接口（api.js + provider.js）
- `POST /admin/access/peers/pair-code`（写 Lv.2）：本系统建一个 peer（gen peer_code+secret，可选开放门/app/到期/伙伴域）+ 返回 `pc1` 码（domain=本系统 BASE_URL）。
- `POST /admin/access/peers/redeem`（写 Lv.2）：管理员粘贴对方的 `pc1` 码 → 建对等 peer（**不校验白名单**，管理员亲自操作；peer_code 重复 409）。
- `POST /admin/access/peers/:id/push`（写 Lv.2）：把某 peer 的配对码 `fetch` POST 到 `{b_domain}/fed/pair/receive`。
- `POST /fed/pair/receive`（**provider.js 根路径，公开**）：**仅接受来源域在 `FED_ALLOWED_DOMAINS` 白名单内的推送**（否则 403）；解析配对码→建 peer（幂等，peer_code 重复则 already:true）。审计 `fed.pair_received`。
- 可用域 env `FED_ALLOWED_DOMAINS`（逗号域名/后缀，子域匹配；空=不接受任何推送）。init.js ENV_KEYS + 系统配置「门禁」组同步。
- ⚠️ 安全：配对只建立密钥对等关系，**默认不开放任何门/应用**，需接收方事后手动开；推送靠白名单把关；粘贴靠管理员+带外。

### 前端（dashboard.html 跨系统联邦卡）
- 头部三按钮：「⚡ 生成跨域码」(openPairGenModal→doPairGen，出码弹窗可复制+可选直推) / 「📥 用跨域码加入」(openPairRedeemModal→doPairRedeem) / 「+ 手动登记」(原 openPeerModal)。
- 每个 peer 加「📤 推送」(pushPeer→/push)。AUDIT_EVENT_LABEL 补 fed.pair_received；dev 有 mock。
- ⚠️ 测试：makePairCode↔parsePairCode 往返 + 非法拒绝 + 兑换落库用 node:sqlite 跑通；dev 浏览器实测 生成→textarea出 pc1 码→粘贴兑换→伙伴出现（带📤推送）。真实两域推送（S2S fetch）未端到端跑（无第二部署），逻辑为标准 fetch + 白名单校验。

## v3.5.8 卡号随机生成 + 登录主体「组织管理员」（套用分组管理员概念）（用户反馈）

三级版本。用户两点：① 实体卡签发能随机生成卡号；② 登录主体套用「管理用户分组」的委派概念（给组织加管理员）。

### ① 随机卡号
- 后端 `GET /admin/access/cards/gen`（写 Lv.2）→ 生成未被占用的 10 位十六进制卡号（撞库重试）。前端绑卡弹窗加「🎲 随机」按钮（dev 本地生成）。

### ② 组织管理员（登录主体 = 组织，委派管理）
补上 v3.5.4 挂起的「组织管理员」角色——此前只有分组管理员（group_admins），组织（oauth_subjects）无成员级管理员。
- db：`oauth_subject_admins(subject_id,user_id)` + `oauthSubjects` 加 admins/isAdmin/addAdmin/clearAdmins/managedBy（我管理的组织）。删主体连带清。
- api.js：`canManageOrg(req,sid,write)` = 系统管理员 OR 该组织的组织管理员。**组织成员相关端点全部改为 `requireAuth + canManageOrg`**（原 requireAdmin）：
  `GET/POST/PATCH/DELETE /admin/orgs/:sid/members`、`uid-rule`、`import`、`GET/PUT /admin/orgs/:sid/apps`（开放应用）。
  新增：`GET/PUT /admin/orgs/:sid/admins`（系统管理员指定，只收本组织成员）、`GET /account/managed-orgs`（用户视角：系统管理员看全部、组织管理员看自己管的，带成员）。
  `canIssuePass` 现含组织管理员（完成「管理员 + 分组/组织管理员」签发访客码/跨域码的既定意图）。`GET /admin/oauth-subjects` 多返回 `admin_count`。
- 前端：登录主体卡片加「🛡️ 组织管理员」按钮（`openOrgAdmins`，从成员里勾选，复刻 openGroupAdmins）+ 管理员数徽章；用户端新增「组织管理」菜单（`ni-orgadmin`/`page-orgadmin`，**仅组织管理员可见**，`checkOrgAdminNav` 点亮）→ 列我管理的组织 → 复用 `openOrgMembers` 管成员。USER_PAGES/bootToLastPage 同步（orgadmin 入口未点亮则丢弃）。dev 有 mock。
- ⚠️ 测试：oauth_subject_admins 语句用 node:sqlite 实跑通过（addAdmin/isAdmin/managedBy/clearAdmins）；dev 浏览器实测随机卡号(10 位)、组织管理员弹窗、用户端组织管理页。

## v3.5.7 跨域应用登录（联邦第二块：B 的用户用 A 开放的 OIDC 应用）（用户反馈）

三级版本。承接 v3.5.5——把「跨系统共享**应用**」补上（v3.5.5 只做了门禁）。信任沿用**共享密钥 + 签名令牌**。
模型：B 用户在自己系统已登录 → B 用共享密钥给他签一个「联邦登录令牌」(fl1) + 身份断言 → 跳到 A 的 `/fed/launch` → A 验签 → 落**联邦授权码**（不建 A 的真实用户）→ 回跳应用 callback → 应用标准 `/oauth/token` 换令牌拿 id_token。

### 关键设计：联邦访客不建 users 行（FK 隔离）
- `oauth_auth_codes`/`oauth_access_tokens` 的 `user_id` 有 `REFERENCES users` 外键（`PRAGMA foreign_keys=ON`），故联邦身份**另立表**：`fed_oidc_codes` / `fed_oidc_tokens`，`claims` 存已按 scope 裁剪好的 JSON（`sub=fed:<peer_code>:<b_sub>`、name、email、from_peer），不碰 A 本地用户数据。
- `access.js`：`signFedLaunch`/`fedLaunchParse`（令牌 `fl1.<payload>.<sig>`，payload 带身份断言，HMAC 共享密钥）。

### A 侧（provider.js）
- `GET /fed/launch`：验签 + 伙伴 active/未过期 + **应用必须在 peer.app_ids 内** + redirect_uri 匹配 → 按 scope 裁 claims → 落 `fed_oidc_codes` → 回跳 `redirect_uri?code=&state=`。审计 `fed.app_login`。
- `/oauth/token` 加联邦分支：`idp.findCode` 没有则查 `access.fedCodeGet`，走 `handleFedToken`（校验 app/redirect_uri/PKCE/一次性/过期 → 从 claims 签 id_token，用应用自己的 client_secret HS256，与普通流一致）。
- `/oauth/userinfo` 加联邦分支：真实令牌没有则查 `fed_oidc_tokens`，直接回存好的 claims。
- ⚠️ email_verified 对联邦访客给 **false**（伙伴断言、A 未独立验证）。

### B 侧（api.js + db）
- `fed_apps` 表（伙伴开放给我们的应用登记：peer_id/a_base_url/app_client_id/callback_url/scope）。管理端 `GET/POST/DELETE /admin/fed-apps`（读 Lv.3 写 Lv.2）。
- `GET /user/fed-apps` + `POST /user/fed-apps/:id/launch`（requireAuth+noPublic）：用当前用户身份签 fl1 令牌 → 拼 A 的 `/fed/launch?...` 返回 → 前端 `window.open` 跳转。

### 前端（dashboard.html）
- 管理端门禁管理「跨系统联邦」区加「伙伴应用（跨域登录）」卡（登记/删除，伙伴下拉来自 peers 缓存）；用户应用市场顶部加「🔗 伙伴应用（跨域登录）」区（一键「打开 ↗」）。AUDIT_EVENT_LABEL 补 `fed.app_login`；dev 有 mock。

⚠️ 测试：fed OIDC 全链路用 node:sqlite 实跑通过（fl1 签/验、fed_oidc_codes 落库+一次性、fed_oidc_tokens→userinfo claims、fed_apps+peer join）；dev 浏览器实测管理端登记卡/弹窗(伙伴下拉)/用户市场伙伴应用「打开」。
⚠️ 真实两域端到端（A↔B 真实跳转 + 应用换码）未跑（无第二套部署），靠逻辑审查——/fed/launch→/oauth/token→/oauth/userinfo 三处均与既有 OIDC 同构，仅身份源换成联邦断言。
至此跨系统联邦完整：门禁(v3.5.5) + 应用登录(v3.5.7)。

## v3.5.6 系统版本更新（检查+通知+指引 + 自托管一键拉取）（用户反馈）

三级版本。用户要「系统版本自动更新」。因线上 Zeabur 靠 git push 自动部署（容器只读/重启），应用自己 git pull 不适用——故做**检查+通知+指引**（人人适用），**一键拉取**作为自托管开关（默认关、强确认、先备份）。

### 后端（`server/updater.js`，新文件）
- `checkUpdate()`：读本地 `package.json` 版本，调 GitHub `GET /repos/QWQ-Inc/qwq-sso/tags` 取最新 tag，`semverCmp`（支持 4 段如 3.4.44.1）比较；**缓存 1h**（`?force=1` 跳过）。失败不抛，返回 error 字段。
- `applyUpdate()`：仅 `SELFHOST_UPDATE=on` 时——**先备份 `data/sso.db`**（copy 带时间戳）→ `git pull --ff-only` → `npm ci --omit=dev`，返回每步日志；`SELFHOST_UPDATE_RESTART=on` 则成功后 `process.exit(0)` 交守护进程拉起。⚠️ 从网页触发服务器执行命令，接近 RCE 面——默认关、超管专属、强确认。
- `api.js`：`GET /admin/version`（读 Lv.3，返回 current/latest/hasUpdate/url + selfhost_update）；`POST /admin/version/apply`（**Lv.1 超管** + env 门，`system.update_applied` 进审计）。init.js ENV_KEYS 补 `SELFHOST_UPDATE` / `SELFHOST_UPDATE_RESTART`。

### 前端（dashboard.html）
- 管理端新菜单「关于 / 更新」（`ni-adm-about`/`page-adm-about`）：版本信息 + 「检查更新」+ 有更新则横幅（含「查看更新内容」链接）+ 更新方式说明 + 自托管一键更新按钮（仅后端开启时出现，带日志区）。
- `loadMe` 里管理员进控制台 `bootVersionCheck()` 静默查一次，有更新点亮「关于」菜单红点 + 一次 toast。系统配置加「版本更新」组（两个 env）；dev 有 mock。
- ⚠️ 测试：`semverCmp` 5 组（含 4 段、3.10 vs 3.9）+ `checkUpdate` **实打 GitHub API 跑通**（current 3.5.5 ↔ latest tag v3.5.5，hasUpdate=false）；dev 浏览器实测关于页横幅/自托管按钮/菜单红点。
- ⚠️ 一键更新的 `git pull`/`npm ci` 本机没在真实自托管环境端到端跑（CI 是云编译、线上是 Zeabur），逻辑为标准 child_process，env 默认关不影响线上。

## v3.5.5 跨系统联邦门禁（共享密钥伙伴 + 签名跨域码）（用户反馈）

三级版本。门禁最后一块：两套 QWQ SSO 互认，A 把门开放给伙伴 B，B 自行给访客签发跨域码，A 门口扫码本地验签即过。
确认的模型：**共享密钥注册伙伴 + 签名跨域码**（离线可验，不依赖对方在线）；共享**门禁**（应用跨域登录排后续）；**A 开放门集，B 自行签发**。

### 机制（access.js）
- 跨域码 `ft1.<payload>.<sig>`，payload=`{iss:peer_code, v:访客名, j:jti, e:exp}`，用**共享密钥** HMAC-SHA256 签名（`signFedCode`/`fedParse`/`fedVerifySig`）。
- `evaluateFed(parsed, peer, door)`：peer active + 未过合作期 + 码未过期 + 门 ∈ peer.door_ids → 放行；reason ∈ fed_unknown/revoked/peer_expired/code_expired/wrong_door/bad_sig。
- **谁开放门由被访问方（host）本地 `peer.door_ids` 决定**；跨域码只证明「持有者经伙伴授权」，不自带门。

### 数据 / 接口（db.js + api.js）
- `federation_peers(id, name, peer_code UNIQUE, secret, base_url, door_ids, app_ids, valid_until, status, note)`——双方登记**同一对 peer_code + secret**（一方生成、另一方粘贴，像 OIDC client_id/secret）。
- `/v1/access/verify` **三分流**：`qr1.`=用户动态码（一次性）/ `ft1.`=跨域码（查 peer→验签→evaluateFed，log method=federation、name=`访客@伙伴名`）/ 其余=访客码。
- 管理端（读 Lv.3 / 写 Lv.2）：`GET/POST/PATCH/DELETE /admin/access/peers`（POST 可自动生成或粘贴 peer_code/secret，door_ids/app_ids 只收存在的门/应用）。
- 签发：`POST /access/peers/:id/issue`（requireAuth + `canIssuePass`=管理员/分组管理员）→ `signFedCode` 出跨域码（有效时长 1~720h）。`access.fed_issued` 进审计。

### 前端（dashboard.html 门禁管理）
- 「跨系统联邦」卡：伙伴列表（名/开放门/有效期）+ 登记/编辑弹窗（名/域址/门多选/应用多选/到期；新建可填或自动生成配对凭据）+「配对凭据」弹窗（peer_code+secret 复制给伙伴）+「签发跨域码」弹窗→QR(ft1 码本身) + 删除。AUDIT_EVENT_LABEL + accessReasonText 补 fed_*；dev 有 mock。

⚠️ 测试：federation_peers 表 + signFedCode→fedParse→fedVerifySig→evaluateFed 用 node:sqlite 实跑通过（对密钥验签真假、开放门/未开放门、伙伴停用、过期）；dev 浏览器实测伙伴列表/登记弹窗(门多选)/配对凭据/签发→QR。
⚠️ **应用跨域登录（B 用户用 A 的 OIDC 应用）未做**：签名跨域码适合门禁扫码，不直接匹配 OIDC 登录流程；`app_ids` 数据+UI 已就位，跨域应用登录需 B-as-IdP 桥接，留待后续版本。
门禁至此完整：动态码(v3.5.0/iOS v3.5.1) + 实体卡(v3.5.2) + 人脸(v3.5.3) + 访客码(v3.5.4) + 跨系统联邦(v3.5.5)。

## v3.5.4 访客门禁（通行码 + 规则生效日期区间 + 主人邀请 + 签发权限）（用户反馈）

三级版本。用户要访客门禁：活动开放某区域一段时间 / 带人临时访问。本版落地前三块（跨系统联邦排后续）。

### 规则生效日期区间（活动期间整体开放）
- `access_rules` 加 `valid_from` / `valid_to`（YYYY-MM-DD，空=不限）；`access.js` 的 `withinSchedule` 加日期区间判定（`localDateStr`）。
- 规则弹窗加「生效日期」起止；规则列表显示日期区间。`insertRule` + POST 校验。

### 访客通行码（可发给无账号访客）
- `visitor_passes(id, code UNIQUE, visitor_name, visitor_phone, door_ids 逗号, issued_by, issued_by_name, valid_from, valid_to, max_uses, used_count, status, note)`。
- `access.js` `evaluatePass(pass, door, now)`：active + 在时限 + 门在 door_ids + 未超次数 → 放行；reason ∈ pass_unknown/revoked/not_started/expired/wrong_door/used_up。
- **`/v1/access/verify` 分流**：code 以 `qr1.` 开头 → 用户动态码（一次性消费）；否则 → 访客码（`passByCode` → `evaluatePass`，放行则 `bumpPassUse`，日志 method=visitor、user_name=访客名）。
- 签发（`api.js`，`requireAuth` + `canIssuePass` = 系统管理员 OR 分组管理员 `groups.managedBy`）：
  `GET/POST/DELETE /access/passes`（admin 看全部、其余看自己签发的；删=撤销 revoke，非 admin 仅限本人签发的）。`access.pass_issued` / `access.pass_revoked` 进审计。
- 公开 `GET /api/public/pass/:code`：访客页展示用（最小披露：访客名/时限/门名/状态/code，不含签发人/电话）。
- `public/pass.html`（**新文件**）：访客手机打开链接 → 本地 `QRMini` 渲染 **code 本身**的二维码（门口扫码机扫它→verify）+ 有效期/门/状态。
  ⚠️ 二维码编码的是 **code 本身**（不是链接），否则扫码机拿到 URL 对不上 passByCode。

### 前端（dashboard.html 门禁管理）
- 「访客通行码」卡：列表（访客名/门/时限/次数/签发人）+ 签发弹窗（姓名/电话/门多选/起止 datetime-local/次数）+ 撤销 + 「二维码/链接」弹窗（QR=code，附可分享 pass.html 链接）。
- AUDIT_EVENT_LABEL + accessReasonText 补 pass_* / access.pass_*；dev 有 mock。

⚠️ 测试：visitor_passes 表 + evaluatePass + 规则日期区间用 node:sqlite 实跑通过（对门/错门/用尽/撤销/日期过期）；dev 浏览器实测访客码列表+签发弹窗(门多选)+规则日期输入+QR 弹窗。
⚠️ 分组管理员目前经 API 可签发，但门禁管理页在 nav-admin（仅系统管理员可见）——纯分组管理员的用户端签发入口留待后续；「组织管理员」角色尚不存在（组织=主体无成员级管理员），本版按分组管理员。
后续：跨系统联邦（A↔B 域共享门禁/应用，有期限）。

## v3.5.3 门禁人脸录入（独立于 KYC、自愿、设备本地比对）（用户反馈）

三级版本。用户指出：KYC 服务商常只回结果不回人脸数据，门禁需要自己的人脸库；且**自愿录入、非人人必录**。
确认模型：**系统只做「录入 + 存储 + 下发」，1:N 比对放在门禁人脸一体机本地**（不在 Node 跑模型、不送第三方）。

- db：`access_faces(user_id PK, mime, size, status, data BLOB, updated_at)` 一人一张；`accessStmts` 加 faceGet/faceMeta/faceUpsert(ON CONFLICT 覆盖)/faceSetStatus/faceDelete/facesAll/facesActive。
- `api.js`：
  - 用户端（requireAuth + noPublic）：`GET /user/access/face`(状态) / `GET .../face/image`(预览) / `POST .../face`(express.raw 原始字节，复用 memo-util `validateAttachment` 只放行图片) / `DELETE .../face`。
  - 管理端（读 Lv.3 / 写 Lv.2）：`GET /admin/access/faces`(元数据列表,不带 BLOB) / `GET .../:uid/image` / `PATCH .../:uid`(启停) / `DELETE .../:uid`。
  - 开放 API（`access:read`）：`GET /v1/access/faces`(人脸一体机同步，支持 `?since=` 增量，只给 uid/name/updated_at 不给图) / `GET /v1/access/faces/:uid/image`(拉某人图片)。识别后仍走 `/v1/access/check {uid, method:face}`。
  - 录入/删除写审计 `access.face_enrolled` / `access.face_deleted`。
- `dashboard.html`：用户「门禁」页加「人脸录入（可选）」卡（file input `capture=user` 直接调摄像头，上传走裸 fetch+Bearer）；管理端门禁管理加「人脸库」卡（列表/查看预览/启停/删除）；AUDIT_EVENT_LABEL 补 access.*（含 granted/denied/face_*）；dev 有 mock。
- ⚠️ 人脸是敏感 PII：opt-in、可删、进审计、仅本人或管理员可管、图片不出本系统（仅授权设备经 access:read 拉）。
- ⚠️ 测试：access_faces 表 + 全部语句用 node:sqlite 实跑通过（录入/覆盖/启停/删除/active 过滤）；dev 浏览器实测用户录入卡 + 管理端人脸库列表。
- 后续 v3.5.x：访客门禁（通行码 + 日期区间 + 主人邀请）、跨系统联邦。

## v3.5.2 门禁实体卡 / NFC 卡号绑定（用户反馈）

三级版本。完成 v3.5.0 预留的 `/v1/access/check` 刷卡通路——卡号↔用户绑定，门禁机读到卡号即可开门。

- db：`access_cards(id, card_no UNIQUE, user_id, label, status[active|disabled], ...)`；`accessStmts` 加 cardByNo/cardsByUser/allCards/insertCard/setCardStatus/removeCard。
- `api.js`：`POST /v1/access/check` 现接受 `card_no`（优先）或 `uid`——card_no → `access.cardByNo` 解析 active 卡 → 对应用户 → `evaluateAccess`；卡未绑定/停用 → reason `card_unknown`。
  管理端 `GET/POST/PATCH/DELETE /admin/access/cards`（读 Lv.3 / 写 Lv.2；POST 走 `resolveUser` 绑账号，卡号唯一冲突 409）。
- `access.js` REASON_LABEL 加 `card_unknown`。
- `dashboard.html` 门禁管理页加「实体卡 / NFC」卡片（列表 + 绑定弹窗[卡号+账号+备注] + 启停 + 删除）；dev 有 mock。
- ⚠️ 测试：card 表 + 全部语句用 node:sqlite 实跑通过（绑定/解析/启停/删除）；dev 浏览器实测卡列表 + 绑定弹窗渲染。
- 后续 v3.5.x：人脸（复用 KYC）、远程开门。

## v3.5.1 iOS 原生门禁页（出示动态开门码，像健康码）（用户反馈）

三级版本（iOS）。承接 v3.5.0，把门禁做进 App。

- `ios/QWQSSO/AccessView.swift`（**新文件**）：全屏出示动态开门码——`CoreImage` 的 `CIFilter.qrCodeGenerator` **本地**生成二维码（不出端、不引第三方库）；
  进页即拉码，`Timer` 每秒倒计时，到 45s 自动刷新（`accessQr` 返回 `expires_in`）；下方「我能通行的门」列表（`accessDoors`）。
- `APIClient.swift`：加 `accessQr(token)`→`(code,expiresIn)` / `accessDoors(token)`。
- `HomeTabView.swift`：首页顶部加醒目「门禁 · 出示开门码」入口卡 → `NavigationLink` 进 `AccessView`（不占底部 tab，首页一眼可达）。
- ⚠️ XcodeGen 自动纳入 `ios/QWQSSO/*.swift`，无需改 project.yml；仍靠 GitHub Actions（macos-15）云端编译验证。
- 后续 v3.5.x：NFC/刷卡、人脸（复用 KYC）、远程开门。

## v3.5.0 门禁（动态二维码 + 授权规则 + 设备开放 API + 扫码终端）（用户反馈）

二级版本（用户要「做一个门禁功能」，确认方案后开做）。第一期落地「动态二维码」主线，权限「按组织/分组/等级批量 ∧ 逐人叠加」，设备接入「开放 API + 扫码终端网页」双轨。iOS 原生门禁页排 v3.5.1。

### 数据（db.js 迁移区块）
- `access_doors(id,name,location,subject_id,status,note,...)` 门/通道；`subject_id` 可空=不归属组织。
- `access_rules(id,door_id,grant_type,grant_value,effect,weekdays,time_start,time_end,label)`：
  `grant_type` = all/org/group/tag/level/user；`effect` = allow/deny（**deny 优先**，实现「分组批量放行 + 单独排除某人」）；时段 HH:MM（支持跨夜）+ 星期 0-6（空=不限）。
- `access_logs` 通行记录；`access_qr_used(jti,expire_at)` 动态码一次性消费防重放。
- db 导出 `access`（18 条预编译语句）。

### 核心（server/access.js，新文件）
- `signQr(user)` → 45 秒一次性签名码 `qr1.<payload>.<sig>`（HMAC-SHA256，密钥 `ACCESS_QR_SECRET`，回退 JWT_SECRET）。
  码代表「人」不绑死门——一个码能开用户有权限的所有门，门口按该门规则判定；jti 一次性消费防截图重放。
- `verifyQr(code,{consume})` 校验签名+过期+重放；`evaluateAccess(user,door,now)` → `{allow,reason}`（拒绝优先→允许+时段）；`doorsForUser` 列用户可通行的门。
- ⚠️ 判定逻辑已单测 29/29（`scratchpad/access-test.js`，mock db）；db 层用 node:sqlite 顶替 better-sqlite3 实跑建表+全部语句通过（`scratchpad/db-load-test.js`）。

### 接口（api.js）
- 用户端：`POST /user/access/qr`（出示动态码）、`GET /user/access/doors`（我能开的门）。
- 管理端（读 Lv.3 / 写 Lv.2）：门 CRUD `/admin/access/doors`、规则 `/admin/access/doors/:id/rules`、通行记录 `/admin/access/logs`。
- 开放 API（新 scope `access:verify` / `access:read`，都有 sandbox 桩）：
  `POST /v1/access/verify {door_id,code}`（扫码开门，code 一次性）、`POST /v1/access/check {door_id,uid}`（刷卡/人脸预留）、`GET /v1/access/doors`、`GET /v1/access/logs`。
- 每次通行写防篡改审计链 `access.granted` / `access.denied`（actor=`door:<id>`）。
- ⚠️ `/v1/*` 挂在 `/api` 下，设备端点为 `POST /api/v1/access/verify` + `Authorization: Bearer sk_...`。

### 前端
- `dashboard.html`：用户端「门禁」页（出示二维码 `QRMini.svg` 本地渲染 + 45s 倒计时自动刷新 + 我能开的门）；管理端「门禁管理」页（门 CRUD + 规则弹窗[类型/对象下拉/时段/星期 + deny优先] + 通行记录表）。ALL_SCOPES 加 access:verify/read；系统配置加「门禁」组（ACCESS_QR_SECRET，secret）；dev 有 mock。
- `public/access-terminal.html`（**新文件**）：独立扫码终端——填 API Key + 选门 → 浏览器原生 `BarcodeDetector` 扫码（不引 CDN，避供应链）+ 手动输入兜底 → 调 `/api/v1/access/verify` → 放行/拒绝大屏 + 提示音。旧平板/手机即可当门禁机。
- ⚠️ dev 浏览器实测：用户端二维码渲染 + 我能开的门；管理端门列表/规则弹窗(切换类型出下拉)/门弹窗/通行记录；扫码终端页渲染。两个 nav 入口齐备、inline JS 解析 0 错。

### 刻意未做 / 后续
- **v3.5.1 iOS 原生门禁页**（我能开的门 → 全屏出示二维码，像健康码）。
- NFC/刷卡（card_no↔用户映射）、人脸（复用 KYC）、远程开门（需设备在线通道）排 v3.5.x。
- init.js ENV_KEYS 已加 `ACCESS_QR_SECRET`。

## v3.4.44 应用分类 + iOS 应用搜索（用户反馈·批次4下）

三级版本。应用可分类，两端按分类筛选；iOS 应用市场加搜索（网页早有 market-search）。

- db `apps` 加 `category`；`POST/PATCH /admin/apps` 收 `category`（insert/update 后单独 UPDATE，不动 appStmts）。
- 管理端 新建/编辑应用表单加「分类」（`na-category`/`ae-category`），提交带上。
- 网页应用市场 `renderMarket`：分类 chip 筛选（`_marketCat`）+ 卡片分类小标签（搜索本就有）。
- iOS `AppsTabView`：`.searchable` 搜索 + 横向分类 chip 筛选（`filtered`/`categories`）+ 行内分类标签。
- 至此用户反馈那批基本做完（网页外部浏览器/图片缩放/券操作/转账/记录/明细/水印诊断/登录主体显眼/商品分类/应用分类+搜索）。

## v3.4.43 商品分类（用户反馈·批次4上）

三级版本。商城商品可分类，两端按分类展示/筛选。

- db `shop_goods` 加 `category` 列；`POST/PATCH /admin/shop/goods` 收 `category`（COALESCE 更新）。
- 管理端商品弹窗加「分类」输入（`gm-category`），openGoodsModal 回填、saveGoods 提交。
- 网页用户商城：`renderShopGrid()` 有分类时顶部出分类筛选 chip（全部+各分类），卡片名带分类小标签，`_shopCat` 筛选。
- iOS `ShopTabView`：商品按分类分 Section（无分类归「在售商品」排最后），`goodsRow`/`goodsCategories`/`goodsIn` 抽出。
- 下一批（4下）：应用市场 搜索 + 分类（apps 加 category）。

## v3.4.42 登录主体 成员/开放应用 管理更显眼（用户反馈·批次3）

三级版本（Web）。用户：登录主体下管理成员/开放应用「网页也不够显眼」。

- `GET /admin/oauth-subjects` 每个主体多返回 `member_count` / `open_app_count`。
- 主体卡片：直接显示「👥 成员 N」「📦 开放应用 M」徽章；操作按钮补「📦 开放应用」。
- 新反向接口：`GET /admin/orgs/:sid/apps`（列已启用应用 + open/global 标记）、`PUT /admin/orgs/:sid/apps {app_ids}`（从主体侧设它开放哪些应用，逐个 add/removeOne）。db 加 `appOrgs.removeOne` / `appOrgs.countBySubject`。
- `openSubjectApps(sid,name)`：从主体侧勾选开放应用的弹窗；⚠️ 明确提示「把全局应用勾给某主体后它就不再全局」。
- ⚠️ iOS 侧的组织可见性（我的组织 + 按组织看可用应用）后续再补；应用市场搜索/分类、商品分类仍排队。

## v3.4.41 iOS 商城补功能（券 使用/转让/丢弃 + 积分转账/兑换记录/积分明细）+ 水印启用放宽（用户反馈·批次2）

四级补丁。

- iOS 商城（`ShopTabView` + `ShopExtraViews.swift`）：
  - 兑换券行长按菜单：**使用**（`/user/coupons/:code/use`，有 redirect 则外部打开）/ **转让**（`CouponTransferView`，UID+用户名+密码）/ **丢弃**（`/discard`）。⚠️ 券号字段是 `coupon_code`（之前显示用错了 `code`，一并修）。
  - 「更多」区：**积分转账**（`PointsTransferView`，`/shop/transfer` UID+用户名+积分+密码）、**兑换记录**（`/shop/records`）、**积分明细**（`/user/points-log`，delta/reason）。
  - `APIClient` 加 `couponUse/couponDiscard/couponTransfer/pointsTransfer/shopRecords/pointsLog`。
- 水印启用放宽：`WATERMARK_ENABLED` 现接受 `on/1/true/yes/开/开启/启用/是/y`（之前只 on/1/true/yes；线上是没开 enabled=false，非 bug——顺手放宽）。
- ⚠️ 排队后续：**商品分类**（shop_goods 无 category 列，需加后端+管理端）、应用市场搜索+分类、登录主体成员/应用开放两端可见性。

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
