# 贡献指南 · Contributing

感谢你愿意为 **QWQ SSO** 出一份力！本文说明如何在本地跑起来、代码约定，以及提交 / PR 的流程。

> 中文为主，English notes inline.

---

## 技术栈

- **后端**：Node.js（建议 18+，推荐 20+）+ Express 4 + `better-sqlite3`（同步 SQLite，无 ORM）
- **前端**：原生 HTML / CSS / JS，**单文件、无构建工具、无框架**（`public/dashboard.html` 等各自独立）
- **认证**：JWT + API Key（SHA-256 哈希）；2FA(TOTP) / Passkey(WebAuthn)
- **部署**：Zeabur（`git push` 后自动拉取部署）
- **iOS App**：`ios/`（SwiftUI + XcodeGen，GitHub Actions 云端编译）

## 本地运行

```bash
npm install
npm run init     # 首次：创建超级管理员（按提示 / 环境变量 INIT_ADMIN_*）
npm start        # 启动 server/index.js
# 开发热重载：npm run dev （nodemon）
```

- 配置走环境变量（`.env` 或部署平台变量）；管理端「系统配置」页也可写入并即时生效。
- 数据库是单个文件 `data/sso.db`，首次启动自动建表。

## 代码约定（重要，避免返工）

- **前端无构建**：直接改 `public/*.html` 里的原生 JS，不要引入打包器 / 框架。
- **数据库 schema 变更**：没有迁移工具——在 `server/db.js` 的「迁移」区块里用
  `try { db.exec('ALTER TABLE ... ADD COLUMN ...') } catch(_) {}` 追加字段（模拟 `IF NOT EXISTS`），
  且必须写在建表语句**之后**。
- **发短信 / 邮件是否真发**：**不要用 `NODE_ENV` 判断**，按「是否配置了对应服务商 / 分发中心」判断。
- `db` 是 `require('./db')` 导出对象的一个属性：`const { db } = require('./db')`，不要 `const db = require('./db')`。
- 中文为主：代码注释、提交信息、用户可见文案统一用简体中文。
- 密钥 / `secret` 字段：掩码串（`••••`）绝不能当真值提交；新增敏感字段沿用既有的「仅提交改过的 secret」三道防线。

## 测试

- 改完至少 `node --check <改动的 server 文件>` 过一遍语法。
- 纯逻辑尽量写 `scratchpad/` 下的小单测（Node 自带 `node:sqlite` 可当 better-sqlite3 的替身跑）。
- 前端改动尽量在浏览器里实测关键路径，确认无新增 JS 报错。
- Swift（iOS）靠 GitHub Actions 云端编译验证（本机 Windows 无法本地 `xcodebuild`）。

## 提交 / PR 流程

- 基于 `main` 的**线性提交**；一个 PR 聚焦一件事。
- 提交信息格式：`vX.Y.Z: 简述` 或 `简述`（见下方版本号规则）。
- 发版时版本号要**同步四处** + CHANGELOG：
  `package.json` 的 `version` / `server/index.js` 页脚 `versionLink` / `README.md` 标题 + 徽章 / `CHANGELOG.md` 顶部追加一条。
- 版本号段位：一级 `X.0.0`（仅维护者）/ 二级 `3.X.0`（需讨论）/ 三级 `3.3.X`（每次功能改动）/ 四级 `3.3.1.X`（纯补丁修 bug）。
- 提 PR 前自查：语法过、无明显报错、相关文档 / CHANGELOG 已更新。

## 行为准则

参与本项目即表示你同意遵守 [行为准则](CODE_OF_CONDUCT.md)。

## 安全问题

**不要**用公开 Issue 报告安全漏洞，请走 [安全策略](SECURITY.md)。

## 许可证

贡献的代码按仓库的 [MIT License](LICENSE) 授权。版权行 `Copyright © 2026 QWQ INC.` 不可删除 / 修改。
