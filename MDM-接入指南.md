# QWQ SSO · MDM 设备纳管接入指南（Android / Chromebook）

> 本文覆盖 **Android（Android Management API）** 和 **Chromebook（Chrome Management API）** 两条厂商通道的接入。
> 电脑（Windows/Mac/Linux）走拉取式 agent，见 [`tools/mdm-agent/README.md`](tools/mdm-agent/README.md)；iPhone/iPad 走 Apple MDM（服务端端点与描述文件已就位，见 3.5，需你提供 Apple MDM 推送证书）。

---

## 0. 工作原理（先懂这个）

QWQ SSO 的 MDM 下发是**多传输适配层**：每台设备在「生成纳管 token」时选一个**传输通道**（`devices.transport`），管理端下发命令时按通道路由。

- 命令进 `device_commands` 队列后，服务端调 `mdm.deliverCommand(device, cmd)`。
- Android / Chromebook 通道在**凭据已配齐**时，直接经 Google REST API 下发命令；**未配齐**时命令留在队列、管理端显示「传输未配置」，配好后重新下发即可。
- 命令名会自动映射成厂商命令（见下方矩阵）；某通道不支持的命令会标「该通道不支持此命令」。

凭据统一在**管理端 → 系统配置 → 系统与页脚 → 📱 MDM 设备纳管**里填（底层是环境变量，也可直接配在 Zeabur 环境变量里）。

---

## 1. 通用：建一个 Google 服务账号（两条通道共用）

Android 和 Chromebook 都用**同一个 Google Cloud 服务账号（Service Account）**的密钥换取 access_token。

1. 打开 [Google Cloud Console](https://console.cloud.google.com/) → 新建或选一个项目。
2. 「IAM 和管理 → 服务账号」→ **创建服务账号**（名字随意，如 `qwq-mdm`）。
3. 进入该服务账号 → 「密钥」→ **添加密钥 → 创建新密钥 → JSON**，下载 JSON 文件。
4. 打开 JSON，取两个字段填进系统配置：

| 系统配置项 | 环境变量 | 取自 JSON 的 |
|---|---|---|
| Google · 服务账号邮箱 | `GOOGLE_SA_CLIENT_EMAIL` | `client_email`（形如 `qwq-mdm@项目.iam.gserviceaccount.com`） |
| Google · 服务账号私钥 | `GOOGLE_SA_PRIVATE_KEY` | `private_key`（整段，含 `-----BEGIN PRIVATE KEY-----`；JSON 里的 `\n` 原样粘贴即可，系统会自动还原换行） |

> ⚠️ 私钥是敏感凭据。系统配置里该字段是 secret 类型（打码、留空不覆盖）。

---

## 2. Android（Android Management API）

### 2.1 需要什么
- 上面建好的 Google 服务账号 JSON 密钥。
- 一个 **Android Management API 的 Enterprise**（企业绑定，免费）。
- 设备是 **Android 企业版受管设备**（通过企业注册流程纳管的，不是随便一台手机）。

### 2.2 开通步骤

1. 在 Google Cloud 项目里**启用 Android Management API**：
   「API 和服务 → 库」搜索 *Android Management API* → 启用。
2. 给服务账号授予调用权限：Android Management API 用服务账号直接调用（无需域级委派），确保服务账号在本项目内即可。
3. **创建 Enterprise（企业）**。这一步要走 Google 的注册流程，拿到形如 `enterprises/LC0xxxxxxx` 的资源名。两种方式：
   - 用 Google 的 [Android Management API 快速上手](https://developers.google.com/android/management/quickstart)（Colab 脚本）跑一遍 `signupUrls.create` + `enterprises.create`，最省事；
   - 或自建后端调 `signupUrls.create` → 浏览器完成绑定 → `enterprises.create?signupUrlName=...&projectId=...`。
   把拿到的 `enterprises/LC...` 填进：

   | 系统配置项 | 环境变量 | 值 |
   |---|---|---|
   | Android · Enterprise 名 | `ANDROID_ENTERPRISE_NAME` | `enterprises/LC0xxxxxxx` |

4. **把设备纳管进这个 Enterprise**（v3.5.87 起可在界面里一键完成）：
   - 在 QWQ SSO 设备管理里登记这台设备（类型选 **Google/Android**）→ 设备行「MDM」→「生成纳管 token」→ 通道选 **Android** → 面板上点 **📲 生成纳管二维码**，系统会自动建一条空策略 + enrollment token，显示 token 值和二维码。
   - 新设备在「开机设置」阶段输入 `afw#setup` 或扫该二维码，按引导完成企业纳管。
   - （也可仍用 `enterprises.enrollmentTokens.create` 自行建 token。）

### 2.3 在 QWQ SSO 里绑定该设备
1. 设备纳管进 Enterprise 后，在 MDM 面板点 **📥 从 Google 拉取设备** —— 系统调 `enterprises.devices.list` 列出设备，选中即自动回填 `ext_device_id`（完整资源名 `enterprises/.../devices/...`），**不用手敲**。
2. 回 MDM 面板下发命令。若凭据已配齐，命令会直接经 Android Management API 执行。
3. （也可在「生成纳管 token」时手填 `ext_device_id`，效果相同。）

### 2.4 支持的命令（Android）
| QWQ 命令 | 实际动作 | Android API |
|---|---|---|
| 锁定 | 立即锁屏 | `issueCommand` type=`LOCK` |
| 清除锁屏密码 | 重置密码 | `issueCommand` type=`RESET_PASSWORD` |
| 重启 | 重启 | `issueCommand` type=`REBOOT` |
| 退役 | 放弃设备所有权（解除管理） | `issueCommand` type=`RELINQUISH_OWNERSHIP` |
| 远程擦除 | 恢复出厂（删除设备资源） | `DELETE enterprises/.../devices/...`（`wipeDataFlags=WIPE_EXTERNAL_STORAGE`） |

> 定位 / 推送·移除描述文件 / 解锁在 Android Management API 里没有对应的即时命令（策略类走 Policy，不在此通道），下发会标「该通道不支持此命令」。

---

## 3. Chromebook（Chrome Management API / Admin SDK Directory）

### 3.1 需要什么
- 上面建好的 Google 服务账号 JSON 密钥。
- **Google Workspace / Education**，且这些 Chromebook 已买 **Chrome Enterprise Upgrade** 或 **Chrome Education Upgrade** 许可、已纳入你的 Google 域。
- 一个 **Workspace 超级管理员邮箱**（用于域级委派 subject）。

### 3.2 开通步骤

1. Google Cloud 项目里**启用 Admin SDK API**（「API 和服务 → 库」搜索 *Admin SDK API* → 启用）。
2. **给服务账号开域级委派（Domain-wide Delegation）**：
   - 记下服务账号的 **Client ID**（服务账号详情页的「唯一 ID / Unique ID」，一串数字）。
   - 进 [Google Workspace 管理控制台](https://admin.google.com/) → 安全 → 访问权限和数据控制 → **API 控制** → **域级委派** → 添加新的：
     - Client ID 填服务账号的 Unique ID；
     - OAuth 范围填：`https://www.googleapis.com/auth/admin.directory.device.chromeos`
3. 填系统配置：

   | 系统配置项 | 环境变量 | 值 |
   |---|---|---|
   | Chrome · 域级委派管理员 | `GOOGLE_ADMIN_SUBJECT` | 一个超级管理员邮箱，如 `admin@yourdomain.com` |
   | Chrome · Customer ID | `GOOGLE_CUSTOMER_ID` | 留空用 `my_customer`（代表本域），或填实际 customerId |

4. **设备纳管**：ChromeOS 设备的企业纳管在**开机设置阶段**完成（输入 Workspace 账号或 Admin Console 里生成的「注册令牌」，管理控制台 → 设备 → Chrome → 设置 → 注册）——这一步在 Google 侧做，QWQ SSO 不代办。

### 3.3 在 QWQ SSO 里绑定该设备
1. 登记设备（类型选 **Google/Chrome**）→ 设备行「MDM」→「生成纳管 token」→ 通道选 **Chromebook（Chrome Management API）**。
2. 面板点 **📥 从 Google 拉取设备** —— 系统调 `admin.directory.chromeosdevices.list` 列出域内 Chromebook（型号/序列号/使用者），选中即自动回填 `ext_device_id`（Chrome 的 deviceId），**不用手敲**。
3. 下发命令，凭据齐则经 Directory API 执行。

### 3.4 支持的命令（Chromebook）
| QWQ 命令 | 实际动作 | Chrome API commandType |
|---|---|---|
| 重启 | 重启设备 | `REBOOT` |
| 远程擦除 | 远程 Powerwash（恢复出厂） | `REMOTE_POWERWASH` |

> ChromeOS 的设备命令集有限，锁定 / 清除密码 / 退役 / 定位 / 描述文件在此通道无对应命令，下发会标「该通道不支持此命令」。

---

## 3.5 iPhone / iPad（Apple MDM）

### 需要什么
- 一张 **Apple MDM 推送证书**（APNs），用来唤醒设备。走 **Apple Business Manager** 注册、或从已有 MDM vendor 证书签发，最终在 [Apple Push Certificates Portal](https://identity.apple.com/pushcert/) 拿到证书。
- 证书对应的 **推送主题（Topic）**、以及一个 APNs 鉴权密钥（.p8，Team ID + Key ID）。

### 配置（系统配置 → 📱 MDM 设备纳管）
| 项 | 环境变量 | 说明 |
|---|---|---|
| Apple · Team ID | `MDM_APNS_TEAM_ID` | Apple 开发者 Team ID |
| Apple · APNs Key ID | `MDM_APNS_KEY_ID` | .p8 密钥的 Key ID |
| Apple · APNs 密钥(.p8) | `MDM_APNS_KEY` | .p8 文件内容 |
| Apple · MDM 推送主题 | `MDM_APNS_TOPIC` | 推送证书的主题（通常是证书 UID，形如 `com.apple.mgmt.External.xxxx`） |

### 纳管步骤
1. 设备管理里登记这台设备（类型 **Apple**）→ 设备行「MDM」→ 点 **🍎 下载纳管描述文件 (.mobileconfig)**。
2. 把这个 `.mobileconfig` 发到该 iPhone/iPad（隔空投送 / 邮件 / 访达），在设备上打开 → 设置里「安装描述文件」。
3. 安装后设备自动 check-in（上报 APNs 凭据），这里纳管状态变「已纳管」。之后下发锁定 / 擦除 / 装描述文件：服务端用 APNs 唤醒设备，设备回连拉取命令并执行、回报。

### 支持的命令（iOS）
| QWQ 命令 | MDM RequestType |
|---|---|
| 锁定（可带锁屏留言） | `DeviceLock` |
| 清除锁屏密码 | `ClearPasscode`（需设备 check-in 时上报了 UnlockToken） |
| 重启 | `RestartDevice`（通常需监管设备 Supervised） |
| 远程擦除 | `EraseDevice` |
| 推送/移除描述文件 | `InstallProfile` / `RemoveProfile`（描述文件需为 .mobileconfig） |

> ⚠️ **两点限制**（拿到证书联调时需补齐）：
> 1. **安全**：当前无 SCEP，设备鉴权只靠「描述文件里每设备随机 token」。生产环境应再加一个 `com.apple.security.scep` 载荷下发设备身份证书，并在服务端校验 `Mdm-Signature`。
> 2. **严格模式/未签名描述文件**：描述文件未做 Apple 证书签名，设备上安装会提示「未验证」；监管模式（Supervised，经 Apple Configurator / ABM）下更多命令才生效（如 RestartDevice）。
> 定位（Locate）在 iOS 需「丢失模式（Lost Mode）」才行，暂未接入——用「我的设备」或 Apple「查找」更合适。

---

## 4. 命令支持矩阵（一览）

| 命令 | 电脑(pull_agent) | Android | Chromebook | iPhone(Apple MDM) |
|---|:--:|:--:|:--:|:--:|
| 锁定 | ✅ | ✅ | — | ✅* |
| 解锁 | （记录） | — | — | — |
| 清除锁屏密码 | — | ✅ | — | ✅* |
| 重启 | ✅ | ✅ | ✅ | ✅* |
| 定位 | ✅(主机名/IP) | — | — | — |
| 远程擦除 | ✅(需自备命令) | ✅(删设备) | ✅(Powerwash) | ✅* |
| 退役 | ✅ | ✅ | — | — |
| 推送/移除描述文件 | ✅(本地) | — | — | ✅* |

\* iPhone 的服务端 MDM 端点（check-in + command）、描述文件生成、命令翻译已就位（见 3.5）；真机 enroll 需你提供 Apple MDM 推送证书（MDM_APNS_*）。擦除/重启等受监管模式(Supervised)影响。

---

## 5. 测试与排错

- **下发后看反馈**：MDM 面板下发命令后会提示结果——「已经厂商 API 下发」=成功调用；「该通道凭据未配置，已先入队」=去系统配置补凭据；「该通道不支持此命令」=换支持的命令；「缺厂商设备 id」=回「生成纳管 token」把 `ext_device_id` 填上。
- **401 / invalid_grant**：服务账号密钥不对，或（Chromebook）域级委派没配 / subject 不是有效管理员 / 范围没授权。
- **403 / permission**：（Android）服务账号没在该 Enterprise 下调用、或 API 没启用；（Chromebook）该管理员无权管这台设备 / 未买 Chrome 升级许可。
- **404 device**：`ext_device_id` 填错——Android 要**完整资源名** `enterprises/.../devices/...`，Chromebook 要 **deviceId**（不是序列号）。

> ✅ v3.5.87 起：**列设备**（Android/Chromebook）与 **Android 建 enrollment token/二维码**已接进 MDM 面板（📥 从 Google 拉取设备 / 📲 生成纳管二维码），`ext_device_id` 一般不用手敲。Chromebook 的设备企业注册仍在 Google 管理控制台/开机设置完成（API 无干净公开接口），注册后用「📥 从 Google 拉取设备」绑定即可。
