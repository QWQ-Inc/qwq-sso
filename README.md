# QWQ SSO — 统一登录系统 v3.4.31

> 多渠道登录 · 用户/管理控制台 · 积分商城 · KYC 实名认证 · 开放 API · OIDC 身份提供方

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-3.4.31-blue.svg)](https://github.com/QWQ-Inc/qwq-sso)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-brightgreen.svg)](https://nodejs.org)

---

## ✨ 功能概览

### 登录方式（13 个平台）
| 类型 | 平台 |
|------|------|
| 账号密码 | 邮箱 + 密码 / 邮箱 + 验证码 / 手机 + 验证码 |
| 国内社交 | 微信公众号、企业微信、飞书、钉钉、抖音、快手、小红书、Bilibili、QQ |
| 国际平台 | Google、Apple、GitHub、Microsoft |

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
- **用户管理**：搜索、新建、详情、积分划转、重置密码、停用（含级别保护）、分组 / 标签分配
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
- **防截图水印**：可配显示范围（整站/登录页/指定页面）与样式策略（文本模板 {name}/{uid}/{datetime} 等、透明度、角度、字号、密度、颜色），支持开放 API `GET·PUT /v1/watermark` 程序化对接修改
- **组织成员（IAM）**：组织=登录主体，可管理组织成员、给成员分配**组织内 UID**（自定义规则/手动，仅组织内身份辨认与必要认证，平台通用 UID 不受影响）；应用可**开放给指定组织**（不设=全局通用），仅开放组织的成员可见可登；支持**外部通讯录批量导入/同步**（管理端粘贴或开放 API `org:sync`）；用户登录后可在应用市场按当前组织过滤

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
│   ├── provider.js   # OIDC 身份提供方（提供方：第三方用 QWQ SSO 登录）
│   ├── twofa.js      # 2FA（TOTP，RFC 6238）
│   ├── passkey.js    # Passkey / WebAuthn（@simplewebauthn/server）
│   ├── message.js    # 短信 + 邮件（统一调 QWQ Message 分发中心）
│   ├── kyc.js        # KYC（Didit/Stripe/阿里云/火山引擎/支付宝 + 轮询）
│   ├── audit.js      # 防篡改审计存证链（哈希链 + 完整性校验）
│   ├── memo-util.js  # 备忘录附件白名单/magic bytes 校验 + 外链白名单
│   ├── poller.js     # 通用服务商轮询模块
│   └── setup.js      # 安装向导后端
├── public/
│   ├── login.html          # 登录页（动态平台显示）
│   ├── dashboard.html      # 用户端 + 管理端控制台
│   ├── authorize.html      # OIDC 授权确认页
│   ├── login-success.html  # 登录成功中间页（Token 验证）
│   └── setup.html          # 安装向导
├── ios/              # iOS 原生 App（SwiftUI 骨架，XcodeGen 工程，详见 ios/README.md）
├── .github/workflows/ios.yml  # GitHub Actions：macOS runner 云端编译 iOS App
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

所有接口以 `Bearer sk_live_xxxx` 或 `Bearer sk_test_xxxx` 鉴权，共 37 个 `/v1/*` 接口，按 scope 授权。

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
| 组织 | `POST /api/v1/orgs/{sid}/members/import`（外部通讯录同步） | `org:sync` |
| 配置 | `GET·PUT /api/v1/watermark`（水印策略读取/修改） | `config:read` / `config:write` |
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
