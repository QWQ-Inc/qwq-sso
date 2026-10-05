# QWQ SSO — 统一登录系统 v3.5.68

> 多渠道登录 · 用户/管理控制台 · 积分商城 · KYC 实名认证 · 开放 API · OIDC 身份提供方

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-3.5.68-blue.svg)](https://github.com/QWQ-Inc/qwq-sso)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-brightgreen.svg)](https://nodejs.org)

---

## ✨ 功能概览

### 登录方式（13 个平台）
| 类型 | 平台 |
|------|------|
| 账号密码 | 邮箱 + 密码 / 邮箱 + 验证码 / 手机 + 验证码（账号支持邮箱/手机/UID/用户名多标识符） |
| 国内社交 | 微信公众号、企业微信、飞书、钉钉、抖音、快手、小红书、Bilibili、QQ |
| 国际平台 | Google、Apple、GitHub、Microsoft |
| 登录到组织 | IAM 用户：复用平台账号、限定到某组织登录（组织自有密码 / 独立安全 org-scoped 不可切换；显性下拉或组织码进入） |

> **多主体（多组织 / 多架构）**：管理端「登录主体」里，**主体 = 组织**，一个主体下可挂**多套登录凭证**（如「集团」主体下挂 A 公司微信 + B 公司微信，甚至跨平台）。同一主体下不同凭证登录进来的用户**同人识别合并**（按 unionid / 邮箱认作同一账号）；**不同主体之间数据隔离**，互不合并。环境变量配的默认凭证是各自独立的单租户主体。

### 二级验证（2FA）
- **TOTP**：Google Authenticator / Authy 等兼容 App
- **Passkey**：WebAuthn / FIDO2 无密码登录（指纹 / 面容 / 硬件密钥），基于 `@simplewebauthn/server`
- 管理员可配置是否开放、是否强制启用

### 用户端功能
- **首页**：签到（可配置周期/积分区间）
- **应用管理**：应用市场、已授权应用、应用主动打开（IdP 发起式登录）
- **积分商城**：商品兑换（生成兑换券）、盲盒、转账、兑换码、积分日志、我的兑换券
- **账号设定**：个人信息、时区、密码重置（验证码）、实名认证（KYC）、登录方式绑定（三方账号 / 修改邮箱手机 / 2FA / Passkey）
- **公共账号**：分组内被授权成员可整会话切换为共享账号（仅保留基础 SSO 登录，禁商城/转账）
- **登录日志**：查看自己的登录记录（可导出，可配置保留天数）
- **公告查看**：弹窗确认后不再重复显示，公告更新后重新弹出
- **备忘录**：个人备忘录，可打标签、转交给某用户，支持图片 / PDF / Word(.docx) 等附件与外部链接（默认仅白名单内网域），宏文档与可执行文件一律拒绝

### 管理端功能
- **用户管理**：搜索、新建、详情、积分划转、重置密码、停用（含级别保护）、分组 / 标签分配、勾选批量操作、勾选多个账号合并为一人、疑似重复账号批量识别与合并（超级管理员，可撤销）
- **分组标签**：用户分组（互斥）与标签（可叠加）的增删改，分组可指定分组管理员、挂载公共账号
- **应用管理（OIDC）**：CRUD、审核通过/拒绝、接入凭据（client_id/secret + 四端点）、发起地址、必传字段、删除（清除所有授权）
- **登录日志**：按状态筛选、导出 CSV
- **调用日志**：入站（外部调用本系统）/ 出站（本系统调用外部）统计与记录
- **商城管理**：商品（含盲盒配置）、兑换码（作废/撤销）、兑换记录、积分配置
- **系统配置**：所有三方服务商环境变量（按三方登录/消息通知/实名认证/支付/系统与页脚分类，侧边栏二级导航）、页脚动态配置、登录协议编辑、三方轮询策略
- **API 调用**：密钥管理（`sk_live_`/`sk_test_` 双前缀分离、测试密钥永久可查看+沙盒模拟数据、实际密钥强制可信 IP、全量历史记录不因撤销而消失）、接口文档、调用测试
- **等级管理**：普通用户/管理员两组等级，支持任意等级新增/编辑/删除（等级下有用户时禁止删除），用户等级以 `U数字`/`A数字`（如 U3、A1）标识符暴露给 API，管理端等级列表不直接展示该标识符
- **公告发布**：富文本编辑器（粗体/斜体/字号/图片/链接/视频），支持 API 发布
- **审计存证**：敏感/危险操作（实名认证、二次核验、清除实名、积分调整、账号停用、OIDC 授权）按发生顺序**哈希链式防篡改存证**，一键校验完整性；第三方可用 `audit:read` 自证
- **备忘录（全部）**：管理员可查看/协助管理全部用户的备忘录（查看、转交、删除）；可配 `MEMO_ADMIN_LEVEL` 限定哪一级管理员能看（默认仅超管）
- **防截图水印**：可配显示范围（整站/登录页/指定页面）与样式策略（文本模板 {name}/{uid}/{datetime} 等、透明度、角度、字号、密度、颜色），支持开放 API `GET·PUT /v1/watermark` 程序化对接修改；**导出文件加水印**：备忘录附件的图片/PDF 由服务器把「查看人 + 时间 + 追踪码」烧进文件本身，外泄后可按追踪码反查
- **组织成员（IAM）**：组织=登录主体，可管理组织成员、给成员分配**组织内 UID**（自定义规则/手动，仅组织内身份辨认与必要认证，平台通用 UID 不受影响）；应用可**开放给指定组织**（不设=全局通用），仅开放组织的成员可见可登；支持**外部通讯录批量导入/同步**（管理端粘贴或开放 API `org:sync`）与**企业微信通讯录同步**（一个组织可接多家企业微信，可多选部门拉取成员，同步时可绑定登录凭证、设默认组织密码且不覆盖成员单独的修改，离职自动移出，可定时，也可配置接收事件服务器实时同步）与**飞书通讯录同步**（企业自建应用，免费版可用；同样支持选部门、绑定飞书登录、默认组织密码、事件订阅实时同步、删除账号时在飞书里暂停 / 删除成员；v3.5.60 起也能放在组织文件夹上，文件夹里的组织套用、各选部门）；用户登录后可在应用市场按当前组织过滤
- **组织管理 / IAM 登录（登录主体）**：组织可指定**组织管理员**（委派管理本组织）；可配**组织专属凭证**（短信/邮件/实名按组织覆盖全局）；可开**独立安全**（组织自有密码 + 独立策略，登录后 org-scoped 不可切换）；成员可**跨组织复用**（成员开放）；组织可设为**不显性**（不在登录页列出、靠组织码登录，适用于临时）；组织多了可用**文件夹**归类（管理端分组折叠显示）。登录页「登录到组织（IAM 用户）」入口即走此流程
- **设备管理**：登记 + 台账 Apple / Google / Microsoft 设备、自有协议门禁机 / 读卡器；归属用户或组织，门禁机/读卡器可关联门；开放 API `device:read`（台账同步 + 心跳）
- **身份核验**：被授权「核验员」扫对方动态码查看**脱敏身份卡**（脱敏姓名/所属组织/分组/自定义字段），用于外部活动等核对身份
- **关于 / 更新**：查看版本、检查 GitHub 最新 tag、自托管一键更新（默认关）；App 端亦有关于/更新 + 许可协议

### 门禁 / 设备 / 跨系统联邦
- **门禁**：动态开门码（45s 一次性签名，像健康码）/ 实体卡·NFC / 人脸（设备本地 1:N 比对）/ 访客通行码；授权规则按 组织/分组/等级/逐人（deny 优先）+ 时段/星期/日期区间；扫码终端网页（旧平板即门禁机）+ 开放 API（`access:verify`/`access:read`）接设备
- **访客码 + Apple Wallet**：访客通行码可加入 Apple Wallet（`.pkpass`，阶段一，需 Apple 证书）
- **跨系统联邦**：两套 QWQ SSO 互认，共享密钥 + 签名跨域码，共享门禁 + 跨域应用登录（B 的用户用 A 开放的 OIDC 应用）；令牌自省 + 主动撤销（deprovision webhook / Back-Channel Logout）控制临期账号生命周期

### 消息发送
- **短信 / 邮件**：统一通过 [QWQ Message](https://github.com/uesrbai/qwq-message) 分发中心发送，
  本系统不直接对接服务商；服务商账号、模板、轮询与故障转移都在分发中心配置
- **KYC 轮询**：Didit（每月 500 次免费）/ Stripe Identity / 阿里云 / 火山引擎 / 支付宝实人认证（人脸核身）
- **策略**：最少调用优先 / 顺序优先 / 只开放一个 / 用户自选

### 页脚与版权
- 版权行 `Copyright © 2026 QWQ INC.` 固定，遵循 MIT 协议不可删除
- 管理端可动态添加/删除备案号、许可证、认证等页脚项目
- 分发人字段支持超链接跳转

---

## 🚀 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量（首次启动通过 /setup 向导完成）
cp .env.example .env

# 3. 启动
npm start
```

访问 `http://localhost:3000`，按向导完成初始化。

### Zeabur 一键部署

[![Deploy on Zeabur](https://zeabur.com/button.svg)](https://zeabur.com)

1. Fork 本仓库
2. 在 Zeabur 新建项目 → 从 GitHub 导入
3. 设置必要环境变量（`JWT_SECRET`、`SESSION_SECRET`）
4. 访问 `https://your-domain.zeabur.app/setup` 完成初始化

---

## 🗂️ 目录结构

```
├── server/
│   ├── index.js      # Express 入口，页脚注入，env 从数据库加载
│   ├── api.js        # 全部 REST 接口
│   ├── auth.js       # JWT 鉴权 + requireAuth/Admin/ApiKey
│   ├── db.js         # SQLite 数据库层（better-sqlite3）
│   ├── oauth.js      # 13 个平台 OAuth 回调（消费方：本系统去登录三方）
│   ├── oauth-meta.js # 三方平台元数据（oauth.js + api.js 共用）
│   ├── provider.js   # OIDC 身份提供方（提供方：第三方用 QWQ SSO 登录）
│   ├── twofa.js      # 2FA（TOTP，RFC 6238）
│   ├── passkey.js    # Passkey / WebAuthn（@simplewebauthn/server）
│   ├── message.js    # 短信 + 邮件（统一调 QWQ Message 分发中心）
│   ├── kyc.js        # KYC（Didit/Stripe/阿里云/火山引擎/支付宝 + 轮询，可按组织配凭证）
│   ├── audit.js      # 防篡改审计存证链（哈希链 + 完整性校验）
│   ├── access.js     # 门禁（动态码/卡/人脸/访客码/跨域码判定 + 签名）
│   ├── updater.js    # 系统版本更新（查 GitHub tag + 自托管一键拉取）
│   ├── pkpass.js     # Apple Wallet 访客码 .pkpass 生成/签名（需 Apple 证书）
│   ├── memo-util.js  # 备忘录附件白名单/magic bytes 校验 + 外链白名单
│   ├── poller.js     # 通用服务商轮询模块
│   └── setup.js      # 安装向导后端
├── public/
│   ├── login.html          # 登录页（动态平台显示 + 登录到组织 IAM 入口）
│   ├── dashboard.html      # 用户端 + 管理端控制台（巨型单文件）
│   ├── authorize.html      # OIDC 授权确认页
│   ├── login-success.html  # 登录成功中间页（Token 验证 + App 深链）
│   ├── pass.html           # 访客通行码页（QR + Apple Wallet）
│   ├── access-terminal.html# 门禁扫码终端（旧平板即门禁机）
│   ├── brand-icons.js / qr-mini.js / webauthn-glue.js  # 品牌图标 / 本地 QR 编码 / Passkey 胶水
│   └── setup.html          # 安装向导
├── ios/              # iOS 原生 App（SwiftUI，XcodeGen 工程，详见 ios/README.md）
├── .github/workflows/
│   ├── ios.yml       # GitHub Actions：macOS runner 云端编译未签名 .ipa
│   └── release.yml   # 推 vX.Y.Z tag → 自动建 GitHub Release（说明取自 CHANGELOG.md）
├── CHANGELOG.md      # 线性发行记录（每次发版追加）
├── .env.example      # 环境变量模板
├── API-docs.md       # 开放接口文档
└── package.json
```

## 📱 iOS App（原生 SwiftUI 骨架）

`ios/` 目录是 iOS 客户端骨架：首屏填「所属网域」→ 加载该域登录方式 → 登录（密码/验证码/2FA/第三方/扫码）。
含 `qwqsso://` 深链。工程用 XcodeGen 生成，可在 Mac（Xcode）或 **GitHub Actions（macOS runner 自带 Xcode，免费出未签名构建）** 编译。详见 [ios/README.md](./ios/README.md)。

---

## 🔧 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Node.js 18+ · Express 4 · better-sqlite3 |
| 前端 | 原生 HTML/CSS/JS（单文件，无构建工具）|
| 数据库 | SQLite（`data/sso.db`，自动创建）|
| 认证 | JWT · bcryptjs · WebAuthn（Passkey）|
| 部署 | Zeabur / 任意 Node.js 环境 |

---

## 📡 开放 API

所有接口以 `Bearer sk_live_xxxx` 或 `Bearer sk_test_xxxx` 鉴权，40+ 个 `/v1/*` 接口，按 scope 授权。

| 分类 | 代表接口 | Scope |
|------|------|------|
| 鉴权 | `GET /api/v1/auth/verify` | `auth:verify` |
| 用户 | `GET /api/v1/users`、`/users/{uid}`、`/kyc/match`、`/users/{uid}/org` | `users:read` / `users:write` / `users:kyc` |
| 积分 | `GET·POST /api/v1/users/{uid}/points`、`/points/leaderboard` | `points:read` / `points:write` |
| 签到 | `GET·POST /api/v1/users/{uid}/checkin` | `points:read` / `points:write` |
| 商城 | `GET /api/v1/shop/goods`、`/shop/blind-boxes`、`/users/{uid}/coupons`、`/users/{uid}/shop/records` | `shop:read` |
| 兑换 | `GET /api/v1/coupon/verify`、`POST /coupon/use`、`GET /redeem/verify` | `redeem:verify` |
| 组织 | `GET /api/v1/levels`、`/groups`、`/tags` | `users:read` |
| 实名 | `GET /api/v1/users/{uid}/kyc`、`/kyc/events`、`POST /kyc/session`、`/kyc/verify`、`/kyc/match` | `kyc:read` / `kyc:session` / `kyc:verify` / `users:kyc` |
| 存证 | `GET /api/v1/audit/verify`、`/users/{uid}/audit` | `audit:read` |
| 组织 | `POST /api/v1/orgs/{sid}/members/import`（外部通讯录同步）、`POST /api/v1/orgs/{sid}/dir-sync/run`（企业微信 / 飞书通讯录同步） | `org:sync` |
| 配置 | `GET·PUT /api/v1/watermark`（水印策略读取/修改） | `config:read` / `config:write` |
| 门禁 | `POST /api/v1/access/verify`（扫码开门）、`/access/check`、`GET /access/doors`、`/access/logs` | `access:verify` / `access:read` |
| 设备 | `GET /api/v1/devices`（设备台账同步）、`POST /devices/{id}/heartbeat`（心跳） | `device:read` |
| 其它 | `GET /api/v1/apps`、`/logs`、`POST /sms/send` | `apps:read` / `logs:read` / `sms:send` |

完整速查表与请求/响应细节见 [API-docs.md](./API-docs.md)（第六章 · 6.0 接口速查表）。

---

## ⚖️ 关于我们与许可协议

我们是位于美国特拉华州的 **QWQ INC.（库哇库股份有限公司）**，其在中国的共同开发者是**海南省儋州市许白网络文化传媒有限公司（Hainan Xubai MediaNet Co., Ltd）**。

本项目遵循 **MIT 协议**（Massachusetts Institute of Technology License）。这是一种源自麻省理工学院的宽松型开源许可证，以简洁、自由度高著称。它允许任何人免费使用、复制、修改、合并、发布、分发、再授权甚至销售软件及其文档，唯一要求是在软件及相关文档中保留原作者的版权声明和许可声明。

我公司与共同开发者公司依法享有该项目的原始著作权利与相关技术成果，任何人对其使用、复制、修改、合并、发布、分发、再授权甚至销售软件及其文档时，都应该保留我们在其项目中的相关版权信息与著作权信息，您包括但不限于围绕于不能做出修改版权或著作信息等举动。

我方及其关联方有权对其作品保有著作权利，以及其他的维护我方权益的权利。

我方仅保证相关软件按照原样提供，如分发人将其分发后再修改作为非法用途的，将不为我方责任。

如您使用、复制、修改、合并、发布、分发、再授权甚至销售软件及其文档的方式对本项目做出举动，则代表您同意 MIT 协议与我们给出的限制条件。否则，请购买商业授权版。

---

## 📞 联系我们

我们有代为配置（部署）服务，如果您不会配置，或者想要更为实惠的云服务（服务器、域名、CDN 等）资源，请咨询微信客服：

> 微信扫码咨询客服（企业微信 · 微信客服）

如您有其他问题，可以加入官方微信交流群了解详情：

> QWQ-SSO 官方群（企业微信群）

---

## 📄 License

```
MIT License
Copyright (c) 2026 QWQ INC. & Hainan Xubai MediaNet Co., Ltd
```
