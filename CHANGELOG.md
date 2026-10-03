# 更新日志（线性发行记录）

> 本文件是 QWQ SSO 的**线性发行记录**：每次发版都在顶部追加一条 `## vX.Y.Z`。
> 推送 tag 时 `.github/workflows/release.yml` 会自动在 GitHub 为该 tag 建 Release，
> 并把这里对应版本的小节作为 Release 说明。详尽的架构/踩坑说明见 `CLAUDE.md`。

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
