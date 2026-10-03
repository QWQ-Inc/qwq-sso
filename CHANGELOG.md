# 更新日志（线性发行记录）

> 本文件是 QWQ SSO 的**线性发行记录**：每次发版都在顶部追加一条 `## vX.Y.Z`。
> 推送 tag 时 `.github/workflows/release.yml` 会自动在 GitHub 为该 tag 建 Release，
> 并把这里对应版本的小节作为 Release 说明。详尽的架构/踩坑说明见 `CLAUDE.md`。

## v3.5.24 — 组织登录通道执行组织登录策略（安全修复）

- 「登录到组织（IAM 用户）」(`/api/account/org-login`) 现在执行该组织的 **IP 白名单** 与 **登录时段** 策略（之前只在三方登录通道执行，组织登录可绕过）。组织级判定先于密码校验，拒绝时不泄露密码对错，并记登录日志。
- 组织「强制两步验证」在组织登录通道与三方登录通道一致：只看 `require_2fa`（不再要求同时开独立安全）。
- 策略判定抽成 `server/org-policy.js`（`withinLoginWindow` / `subjectGateError`），两条通道共用，防判定漂移。

## v3.5.23 — API-docs 逐接口补全

- `API-docs.md` 开放 API 从「选摘」补成全部 45 个 `/v1/*` 接口全覆盖：速查表补设备/水印行；新增 6.15 设备管理、6.16 水印策略、6.17 外部通讯录导入分节。
- 版本头更新、去掉选摘免责声明。

## v3.5.22 — 文档交接更新

- 把 CLAUDE.md / README.md / API-docs.md 追平到 v3.5.x 当前实现：功能清单、目录结构、数据库表清单、开放 API scope 表全部补齐。
- API-docs 仍为选摘（主干接口详，较新接口以 server/api.js 实现 + dashboard「API 调用」内置文档为准）。

## v3.5.21 — 设备管理（登记 + 台账）

- 新增「设备管理」：登记 Apple / Google / Microsoft 设备、自有协议门禁机 / 读卡器（`devices` 表，类型/序列号/状态/标签/备注）。
- 归属：可绑用户、可归属组织（登录主体）；系统管理员管全部，组织管理员只管本组织设备。
- 门禁机 / 读卡器可关联「门禁管理」里的门（`access_doors`）。
- 开放 API（scope `device:read`）：`GET /v1/devices` 台账同步 + `POST /v1/devices/{id}/heartbeat` 心跳上报。
- 本版为「登记 + 台账」；真实 MDM/协议纳管（下发配置/锁定/擦除）后续按需接入。

## v3.5.20 — 登录到组织（IAM 用户）+ 组织自有密码 + org-scoped 会话

- 登录页「登录到组织（IAM 用户）」入口（挪到忘记密码右边，主表单不再有抢眼的组织下拉）：选组织（显性下拉 / 组织码搜不显性）+ 账号 + 组织密码 → `POST /api/account/org-login`。
- 组织自有密码：`org_members.password_hash`，组织管理员可给成员设/清（`PUT/DELETE /admin/orgs/:sid/members/:uid/password`）。登录校验优先组织密码；独立安全组织必须用组织密码，非独立组织可回退平台密码。
- 独立安全组织（`oauth_subjects.independent_security`）：org-scoped 会话，登录后锁定当前组织、不可切换（顶部横幅提示 + 应用市场组织下拉禁用）；强制 2FA。
- 模型：复用平台账号 + 限定组织（非全新账号类型）；token 带 `org`/`org_scoped`，过 2FA 二段仍保留。

## v3.5.19 — 线性发行记录 + 自动 GitHub Release

- 新增本 `CHANGELOG.md` 作为线性发行记录（历史因发版工作流 `rm -rf .git` 会被重置，故用随仓库走的文件 + GitHub Release 留存线性记录）。
- 新增 `.github/workflows/release.yml`：推送 `v*` tag 时用 Actions 内置 `GITHUB_TOKEN` 自动创建/更新 GitHub Release，说明取自本文件对应小节（无需本地 gh 登录）。
- 约定：以后每次发版都在此追加一条，而不只是打 tag。

## v3.5.18 — 组织可见性收尾：成员跨组织复用 + 不显性组织（组织码登录）

- 组织「成员开放」(`members_open`)：其他组织管理员可查看并复用其成员（脱敏池 `GET /admin/orgs/:sid/shareable`），避免重复建号。
- 不显性组织：`org_code`（唯一短码）+ `direct_listed`（是否在登录页下拉列出）。登录页可用组织码搜索到不公开的组织直登（适用于临时）。
- `GET /api/public/orgs` 只列显性；`GET /api/public/org-by-code` 按码解析。

## v3.5.17 — 组织专属凭证·第三步：org-first 登录（闭环）

- 登录页「登录到组织」：发码/登录带 `org`，用该组织短信/实名凭证；登录后 `sso_current_org` 贯穿自助实名（成员才生效）。
- 公开 `GET /api/public/orgs`；支付宝 `kyc_pending.org_id` 保证回调查询用同组织凭证。

## v3.5.16 — 组织专属凭证·第二步：实名(KYC)

- `kyc.js` 加 `envGetter` 覆盖层（参数透传、并发安全），5 家服务商 + 支付宝签名链全部可按组织覆盖。

## v3.5.15 — 组织专属凭证·第一步：短信/邮件

- `message.js` 加 `resolveCfg(override)`，组织 `msg_config` 覆盖全局；`oauth_subjects` 加 `msg_config`/`kyc_config`/`allow_direct_login`。
