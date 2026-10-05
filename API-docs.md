# 统一登录系统 SSO — API 对接文档

> 版本：v3.5.59　　最后更新：2026-10
>
> **开放 API（`/v1/*`）已逐接口补全**：全部 45 个 `/v1/*` 接口在第六章均有速查表（6.0）+ 分节说明。
> 管理端 JWT 接口（第七章）为常用主干 + 新功能的管理入口概述，字段细节以 `server/api.js` 与 dashboard「API 调用」页内置文档为准。

---

## 目录

1. [基础说明](#一基础说明)
2. [鉴权机制](#二鉴权机制)
3. [通用登录接口](#三通用登录接口)
4. [用户接口](#四用户接口)
5. [应用市场接口](#五应用市场接口)
6. [开放 API（第三方系统对接）](#六开放-api第三方系统对接)
7. [管理端接口](#七管理端接口)
8. [错误码说明](#八错误码说明)
9. [对接流程示例](#九对接流程示例)
10. [「使用 QWQ SSO 登录」— OIDC 接入](#十使用-qwq-sso-登录-oidc-接入)

---

## 一、基础说明

### 服务地址

| 环境 | 地址 |
|------|------|
| 开发环境 | `http://localhost:3000` |
| 生产环境 | 与 `BASE_URL` 环境变量一致，如 `https://sso.yourdomain.com` |

所有 API 路径均以 `/api` 为前缀，开放 API 以 `/api/v1` 为前缀。

> **`{BASE_URL}`** 即部署时在环境变量 `BASE_URL` 中配置的服务根地址，也是 API 调用管理页面顶部展示的地址。文档中所有示例均以此变量代替，实际使用时替换为真实域名。

### 请求规范

- 请求方式：`HTTP/1.1`
- 数据格式：`Content-Type: application/json`
- 字符编码：`UTF-8`
- 时间格式：ISO 8601，如 `2025-06-23T09:14:00`

### 通用响应结构

**成功**

```json
{
  "success": true,
  "data": { ... }
}
```

**失败**

```json
{
  "error": "错误描述"
}
```

---

## 二、鉴权机制

系统有两套独立的鉴权体系，分别用于不同场景。

### 2.1 用户 JWT Token（用户端 / 管理端）

用户登录后获得 JWT Token，携带在请求头中访问用户相关接口。

```
Authorization: Bearer <jwt_token>
```

**Token 载荷字段**

| 字段 | 类型 | 说明 |
|------|------|------|
| `uid` | string | 用户 UUID |
| `name` | string | 用户名称 |
| `role` | string | 角色：`user` / `admin` |
| `adminLevel` | number | 管理员等级 1-3，普通用户为 null |
| `iat` | number | 签发时间（Unix 时间戳） |
| `exp` | number | 过期时间（Unix 时间戳） |

**Token 有效期**：默认 7 天，可通过 `JWT_EXPIRES_IN` 环境变量配置。

### 2.2 API Key（第三方系统对接）

第三方系统通过管理员在控制台创建的 API Key 调用开放接口，分为两种类型：

| 类型 | 前缀 | 说明 |
|------|------|------|
| **实际密钥** | `sk_live_xxxx...` | 生产环境使用，操作真实数据，**必须配置可信 IP** 才能调用 |
| **测试密钥** | `sk_test_xxxx...` | 沙盒调试用，默认不限制来源 IP，调用任何接口均返回**模拟数据**（响应体带 `_sandbox: true` 标记），不会读写真实数据库 |

```
Authorization: Bearer sk_live_xxxxxxxxxxxxxxxx...
```

> API Key 与用户 JWT Token **不能互换使用**。开放接口（`/api/v1/*`）使用 API Key，其余接口使用 JWT Token。

**可信 IP 限制**

- 实际密钥：创建时必须填写至少一个可信 IP，请求来源 IP 不在列表内将返回 `403`
- 测试密钥：默认不校验来源 IP；仅当管理员主动为该测试密钥配置了具体 IP 列表时才会校验
- **可信 IP 支持 CIDR 网段**（IPv4），逗号分隔可混填精确 IP 与网段，例如 `203.0.113.7, 10.8.0.0/16, 192.168.1.0/24`。
  弹性容器/出口 IP 会漂移的部署，填云厂商的出口网段即可，无需逐个 IP 维护。`0.0.0.0/0` 等于放行全部（不推荐）

**密钥历史与可见性**

- 测试密钥的完整值可在密钥管理列表中随时查看和复制，不限查看次数
- 实际密钥仅在创建的那一刻完整显示一次，此后只显示前缀，需要妥善保存
- 密钥无论是否被使用过、是否已撤销，历史记录永久保留可查

**权限范围（Scope）**

创建 API Key 时需指定权限范围，每个接口要求不同的 scope：

| Scope | 说明 |
|-------|------|
| `auth:verify` | 验证用户 Token 有效性 |
| `users:read` | 读取用户列表与详情 |
| `users:write` | 停用 / 启用用户账号 |
| `users:kyc` | 删除用户实名认证信息 |
| `apps:read` | 读取应用列表 |
| `sms:send` | 代发短信 |
| `logs:read` | 读取全量登录日志 |
| `redeem:verify` | 核验/核销兑换券与兑换码 |
| `points:read` | 读取用户积分余额与明细 |
| `points:write` | 调整用户积分（增加 / 扣减） |
| `shop:read` | 读取商城商品目录与用户兑换券 |
| `shop:write` | 代用户兑换商品 / 开盲盒 |
| `kyc:read` | 读取实名状态与实名历史 |
| `kyc:session` | 发起实名会话（含二次/多次实名） |
| `kyc:verify` | 服务端直提两要素核验 |
| `audit:read` | 校验审计存证链、读取用户存证事件 |
| `org:sync` | 外部通讯录同步（批量导入组织成员） |
| `config:read` | 读取水印策略 |
| `config:write` | 修改水印策略 |
| `access:verify` | 门禁校验：扫码开门 / 刷卡·人脸校验 |
| `access:read` | 读取门禁：门列表、通行记录、人脸同步 |
| `device:read` | 设备台账同步 + 心跳上报 |

### 2.3 用户等级标识符（level_tag）

每个用户对象都带有一个 `level_tag` 字段，供第三方系统作为请求头或筛选条件快速识别用户等级，格式为**字母 + 一位数字**：

| 标识符 | 含义 |
|--------|------|
| `U1` ~ `U9` | 普通用户，数字为等级序号（数字越小等级越高） |
| `A1` ~ `A9` | 管理员，数字为管理员级别（数字越小权限越大） |

该标识符会出现在 `GET /v1/users`、`GET /v1/users/:uid`、`GET /v1/auth/verify` 等接口返回的用户对象中，也可作为 `GET /v1/users?level_tag=U3` 的查询参数进行筛选。等级标识符不在管理端「等级管理」页面直接展示，仅用于用户字段与 API 通信场景。

---

## 三、通用登录接口

这些接口无需鉴权，用于用户登录注册。

---

### 3.1 发送短信验证码

```
POST /api/sms/send
```

**请求体**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `phone` | string | ✅ | 手机号，支持中国大陆 1 开头 11 位号码 |

**请求示例**

```json
{
  "phone": "13800138000"
}
```

**响应示例**

```json
{
  "success": true,
  "expires": 300
}
```

| 字段 | 说明 |
|------|------|
| `expires` | 验证码有效期（秒），默认 300 秒 |

> 若未在管理端配置任何短信/邮件服务商，验证码仅打印到服务器控制台（响应体带 `dev: true`），不实际发送；一旦配置了至少一个服务商，即真实发送，与 `NODE_ENV` 无关。

---

### 3.2 验证短信验证码并登录

```
POST /api/sms/verify
```

首次使用该手机号将自动注册账号。

**请求体**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `phone` | string | ✅ | 手机号 |
| `code` | string | ✅ | 6 位短信验证码 |

**请求示例**

```json
{
  "phone": "13800138000",
  "code": "123456"
}
```

**响应示例**

```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "uid_seq": 42,
    "name": "用户8000",
    "phone": "13800138000",
    "email": null,
    "role": "user",
    "user_level": 4,
    "level_tag": "U4",
    "status": "active",
    "points": 0,
    "kyc_verified": 0,
    "created_at": "2025-06-23T09:14:00"
  }
}
```

---

### 3.3 发送邮箱验证码

```
POST /api/email/send-code
```

**请求体**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `email` | string | ✅ | 邮箱地址 |

**请求示例**

```json
{
  "email": "user@example.com"
}
```

**响应示例**

```json
{
  "success": true,
  "expires": 600
}
```

---

### 3.4 验证邮箱验证码并登录

```
POST /api/email/verify-code
```

首次使用该邮箱将自动注册账号。

**请求体**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `email` | string | ✅ | 邮箱地址 |
| `code` | string | ✅ | 6 位邮箱验证码 |

**响应结构**：同 [3.2](#32-验证短信验证码并登录)

---

### 3.5 邮箱注册

```
POST /api/email/register
```

**请求体**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `email` | string | ✅ | 邮箱地址 |
| `password` | string | ✅ | 密码，至少 6 位 |
| `name` | string | ❌ | 显示名称，默认取邮箱前缀 |

**请求示例**

```json
{
  "email": "user@example.com",
  "password": "MyPass123",
  "name": "张三"
}
```

**响应结构**：同 [3.2](#32-验证短信验证码并登录)

---

### 3.6 邮箱密码登录

```
POST /api/email/login
```

**请求体**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `email` | string | ✅ | 邮箱地址 |
| `password` | string | ✅ | 密码 |

**响应结构**：同 [3.2](#32-验证短信验证码并登录)

---

### 3.6.1 多标识符密码登录（推荐）

```
POST /api/account/login
```

单个输入框自动识别四种账号标识符：**邮箱**（含 `@`）、**手机号**（`1[3-9]` 开头 11 位）、
**UID**（`#00042` / `00042` / `42`，也认自定义 UID `uid_code`）、**用户名**。

**请求体**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `account` | string | ✅ | 上述任一标识符 |
| `password` | string | ✅ | 密码 |

**响应结构**：同 [3.2](#32-验证短信验证码并登录)。报错统一为「账号或密码不正确」，不区分标识符、不泄露账号是否存在。
用户名可能重名，命中多个时返回提示改用邮箱/手机号/UID 登录。

> 旧路径 `/api/email/login`（配 `{email}` 或 `{phone}`）仍兼容保留。

### 3.6.2 忘记密码

```
POST /api/public/forgot-password/send      # 发送重置验证码
POST /api/public/forgot-password/reset      # 用验证码重置密码
```

`send` 请求体 `{ account }`（按上面的多标识符解析，向账号绑定的邮箱/手机发码）。
**无论账号是否存在都返回相同文案**，不泄露账号存在性。
`reset` 请求体 `{ account, code, password }`，新密码至少 8 位，验证码一次性使用。

---

### 3.6.3 登录到组织（IAM 用户）

复用平台账号、限定到某组织登录。组织须 `enabled` 且开启「允许直接登录」；两个通道都会先执行该组织的 **IP 白名单 / 登录时段** 策略（不符返回 `403`，`code` 为 `ip_denied` / `time_denied`），再校验身份；组织开了「强制两步验证」而本人未开 2FA 时返回 `403`。开了 2FA 的用户返回 `twofa_required` + `twofa_token`，走 `/api/2fa/login-verify` 二段（`org` / `org_scoped` 会保留）。

**密码通道** `POST /api/account/org-login`

```json
{ "account": "邮箱/手机/UID/用户名", "password": "组织密码", "org": "组织 id" }
```

成员设了组织密码则只认组织密码；没设则回退平台密码——除非组织开了附加管控「必须组织密码」。

**验证码通道** `POST /api/account/org-login-code`（v3.5.26）

```json
{ "account": "邮箱或手机号", "code": "123456", "org": "组织 id" }
```

验证码先用 `POST /api/email/send-code {email, org}` 或 `POST /api/sms/send {phone, org}` 获取（会走该组织的专属消息凭证）。只接受**已存在且是该组织成员**的账号，绝不自动建号；组织开了附加管控「禁止验证码登录」时返回 `400`。

**成功响应**：`{ success, token, user, org, org_scoped }`。独立安全组织（两个通道都一样）返回 `org_scoped=true`，该会话：
- 不能使用管理端接口（`403`），不能切换公共账号；
- 组织管理员权限只限当前组织；应用市场 / 授权 / OIDC 发起只认「全局应用 + 该组织开放的应用」；
- 组织被停用或关闭直登、或本人被移出该组织后，令牌立即失效（`401`）。

### 3.7 验证用户 Token（SSO 回调验证）

```
POST /api/auth/verify
```

**鉴权**：`Authorization: Bearer <用户JWT>`

用于第三方应用在用户跳转回来后，验证用户 JWT 的有效性并获取用户信息。

**无请求体**

**响应示例**

```json
{
  "valid": true,
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "uid_seq": 42,
    "name": "张三",
    "email": "user@example.com",
    "role": "user",
    "user_level": 3,
    "status": "active",
    "kyc_verified": 1,
    "kyc_name": "张 * 三",
    "kyc_id_tail": "****1234"
  }
}
```

Token 无效时返回：

```json
{
  "valid": false
}
```

---

## 四、用户接口

以下接口均需携带用户 JWT Token。

---

### 4.1 获取当前用户信息

```
GET /api/user/me
```

**鉴权**：`Authorization: Bearer <用户JWT>`

**响应示例**

```json
{
  "success": true,
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "uid_seq": 42,
    "name": "张三",
    "email": "user@example.com",
    "phone": "138****8000",
    "role": "user",
    "user_level": 3,
    "admin_level": null,
    "status": "active",
    "points": 380,
    "checkin_streak": 5,
    "last_checkin": "2025-06-23",
    "kyc_verified": 1,
    "kyc_name": "张 * 三",
    "kyc_id_tail": "****1234",
    "kyc_provider": "aliyun",
    "kyc_verified_at": "2022-03-16T10:22:00",
    "created_at": "2022-03-15T08:00:00",
    "oauthBinds": [
      {
        "provider": "wechat",
        "open_id": "o6_bmjrPTlm6_2sgVt7hMZOPfL2M",
        "bound_at": "2022-03-16T11:00:00"
      }
    ]
  }
}
```

---

### 4.2 修改用户资料

```
POST /api/user/profile
```

**鉴权**：`Authorization: Bearer <用户JWT>`

**请求体**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | ❌ | 昵称 |
| `phone` | string | ❌ | 手机号（需未被其他账号占用） |

**响应示例**

```json
{
  "success": true
}
```

---

### 4.3 每日签到

```
POST /api/user/checkin
```

**鉴权**：`Authorization: Bearer <用户JWT>`

每日只能签到一次，每次获得 10 积分。

**响应示例**

```json
{
  "success": true,
  "points": 10,
  "streak": 6,
  "total": 390
}
```

| 字段 | 说明 |
|------|------|
| `points` | 本次获得积分 |
| `streak` | 当前连续签到天数 |
| `total` | 累计总积分 |

已签到时返回 `400`：

```json
{
  "error": "今日已签到"
}
```

---

### 4.4 删除实名认证信息

```
DELETE /api/user/kyc
```

**鉴权**：`Authorization: Bearer <用户JWT>`

删除后可重新发起认证。

**响应示例**

```json
{
  "success": true
}
```

---

### 4.5 解绑三方账号

```
DELETE /api/user/oauth/:provider
```

**鉴权**：`Authorization: Bearer <用户JWT>`

**路径参数**

| 参数 | 说明 |
|------|------|
| `provider` | 平台名：`wechat` / `wecom` / `feishu` / `dingtalk` |

**响应示例**

```json
{
  "success": true
}
```

---

### 4.6 获取登录历史

```
GET /api/user/login-logs
```

**鉴权**：`Authorization: Bearer <用户JWT>`

返回最近 20 条登录记录。

**响应示例**

```json
{
  "success": true,
  "logs": [
    {
      "id": "log_uuid",
      "method": "邮箱密码",
      "app_name": "本系统",
      "ip": "121.44.xx.xx",
      "user_agent": "Chrome/125.0 macOS",
      "status": "success",
      "fail_reason": null,
      "created_at": "2025-06-23T09:14:00"
    }
  ]
}
```

`status` 取值：`success`（成功）/ `failed`（失败）/ `disabled`（账号停用）

---

## 五、应用市场接口

---

### 5.1 获取应用市场列表

```
GET /api/apps/market
```

**鉴权**：`Authorization: Bearer <用户JWT>`

仅返回状态为 `enabled` 且用户端可见的应用。

**响应示例**

```json
{
  "success": true,
  "apps": [
    {
      "id": "app_uuid",
      "name": "企业 OA 系统",
      "icon": "📋",
      "icon_bg": "#E8F4FF",
      "description": "内部工单与审批流程管理",
      "client_id": "app_a1b2c3d4e5f6",
      "callback_url": "https://oa.example.com/sso/callback",
      "auth_users": 342,
      "status": "enabled",
      "userAuthed": true
    }
  ]
}
```

---

### 5.2 授权应用

```
POST /api/apps/:id/auth
```

**鉴权**：`Authorization: Bearer <用户JWT>`

**路径参数**

| 参数 | 说明 |
|------|------|
| `id` | 应用 UUID |

**响应示例**

```json
{
  "success": true
}
```

---

### 5.3 撤销应用授权

```
DELETE /api/apps/:id/auth
```

**鉴权**：`Authorization: Bearer <用户JWT>`

**响应示例**

```json
{
  "success": true
}
```

---

### 5.4 获取已授权应用列表

```
GET /api/apps/authed
```

**鉴权**：`Authorization: Bearer <用户JWT>`

**响应示例**

```json
{
  "success": true,
  "apps": [
    {
      "id": "app_uuid",
      "name": "企业 OA 系统",
      "client_id": "app_a1b2c3d4e5f6",
      "status": "enabled"
    }
  ]
}
```

---

## 六、开放 API（第三方系统对接）

> 这组接口专为系统间对接设计，使用 **API Key** 鉴权，与用户 JWT 完全独立。
>
> **获取方式**：管理员登录控制台 → 管理端 → API 调用 → 新建密钥，并分配所需 scope。

所有开放接口以 `/api/v1` 为前缀。

**沙盒模式说明**：使用 `sk_test_` 前缀的测试密钥调用以下任何接口，均返回结构一致但内容为预设的**模拟数据**（响应体带 `_sandbox: true`），不会读取或修改真实数据库，可放心用于联调测试。

---

### 6.0 接口速查表（全部 `/v1` 开放接口）

`:uid` 支持用户 UUID / 数字 UID / 自定义 uid_code；带 `:uid` 的接口**均排除公共账号**（共享身份不是自然人）。

| 分类 | 方法 | 路径 | Scope | 说明 |
|---|---|---|---|---|
| 鉴权 | GET | `/v1/auth/verify` | `auth:verify` | 验证用户 JWT（`x-user-token` 头） |
| 用户 | GET | `/v1/users` | `users:read` | 用户列表（`page`/`limit`/`status`/`level_tag` 筛选） |
| 用户 | GET | `/v1/users/:uid` | `users:read` | 用户详情 |
| 用户 | POST | `/v1/users/:uid/disable` | `users:write` | 停用账号 |
| 用户 | POST | `/v1/users/:uid/enable` | `users:write` | 启用账号 |
| 用户 | DELETE | `/v1/users/:uid/realname` | `users:kyc` | 删除实名信息 |
| 用户 | POST | `/v1/kyc/match` | `users:kyc` | 实名姓名/证件号比对（只回布尔） |
| 实名 | GET | `/v1/users/:uid/kyc` | `kyc:read` | 查实名状态（强实名门禁） |
| 实名 | GET | `/v1/users/:uid/kyc/events` | `kyc:read` | 实名历史（二次/多次实名审计） |
| 实名 | POST | `/v1/users/:uid/kyc/session` | `kyc:session` | 发起实名会话（reverify 支持二次核验） |
| 实名 | POST | `/v1/users/:uid/kyc/verify` | `kyc:verify` | 服务端直提两要素核验 |
| 存证 | GET | `/v1/audit/verify` | `audit:read` | 校验存证链完整性 |
| 存证 | GET | `/v1/users/:uid/audit` | `audit:read` | 查某用户的存证事件 |
| 组织 | POST | `/v1/orgs/:sid/members/import` | `org:sync` | 外部通讯录批量导入组织成员 |
| 组织 | POST | `/v1/orgs/:sid/dir-sync/run` | `org:sync` | 依次执行该组织所有启用的通讯录同步源（企业微信 / 飞书，v3.5.35/36/59） |
| 用户 | GET | `/v1/users/:uid/org` | `users:read` | 该用户的分组 + 标签（仅名称/颜色） |
| 积分 | GET | `/v1/users/:uid/points` | `points:read` | 积分余额 |
| 积分 | GET | `/v1/users/:uid/points/logs` | `points:read` | 积分明细（最近 50） |
| 积分 | POST | `/v1/users/:uid/points` | `points:write` | 调整积分（`delta`/`reason`） |
| 积分 | GET | `/v1/points/leaderboard` | `points:read` | 积分排行榜（默认前 20，最多 100） |
| 签到 | GET | `/v1/users/:uid/checkin` | `points:read` | 签到状态 |
| 签到 | POST | `/v1/users/:uid/checkin` | `points:write` | 代该用户签到发积分 |
| 商城 | GET | `/v1/shop/goods` | `shop:read` | 在售商品目录 |
| 商城 | GET | `/v1/shop/blind-boxes` | `shop:read` | 盲盒目录（含奖励项 label/weight） |
| 商城 | GET | `/v1/users/:uid/coupons` | `shop:read` | 用户持有的兑换券 |
| 商城 | GET | `/v1/users/:uid/shop/records` | `shop:read` | 用户的兑换记录（最近 100） |
| 商城 | POST | `/v1/users/:uid/shop/exchange/:goods_id` | `shop:write` | 代用户兑换商品 / 开盲盒 |
| 兑换 | GET | `/v1/coupon/verify` | `redeem:verify` | 核验兑换券 |
| 兑换 | POST | `/v1/coupon/use` | `redeem:verify` | 核销兑换券 |
| 兑换 | GET | `/v1/redeem/verify` | `redeem:verify` | 核验兑换码 |
| 组织 | GET | `/v1/levels` | `users:read` | 等级目录（带 `level_tag`） |
| 组织 | GET | `/v1/groups` | `users:read` | 分组目录 |
| 组织 | GET | `/v1/tags` | `users:read` | 标签目录 |
| 应用 | GET | `/v1/apps` | `apps:read` | 应用列表 |
| 日志 | GET | `/v1/logs` | `logs:read` | 全量登录日志（最新 200） |
| 消息 | POST | `/v1/sms/send` | `sms:send` | 代发短信 |
| 门禁 | POST | `/v1/access/verify` | `access:verify` | 扫码开门：校验动态二维码（code 一次性消费防重放） |
| 门禁 | POST | `/v1/access/check` | `access:verify` | 直查校验（刷卡/人脸：设备解析出 uid 后调；card_no 预留） |
| 门禁 | GET | `/v1/access/doors` | `access:read` | 已启用的门/通道列表 |
| 门禁 | GET | `/v1/access/logs` | `access:read` | 通行记录（`door_id`/`limit`，最多 500） |
| 门禁 | GET | `/v1/access/faces` | `access:read` | 人脸库同步（`?since=` 增量；只给 uid/name/updated_at） |
| 门禁 | GET | `/v1/access/faces/:uid/image` | `access:read` | 拉某用户的人脸图片（供一体机建本地库） |
| 设备 | GET | `/v1/devices` | `device:read` | 设备台账同步（`?kind=`/`?status=` 过滤） |
| 设备 | POST | `/v1/devices/:id/heartbeat` | `device:read` | 在线设备上报心跳（刷新 last_seen） |
| 配置 | GET | `/v1/watermark` | `config:read` | 读取防截图水印策略 |
| 配置 | PUT | `/v1/watermark` | `config:write` | 修改水印策略（即时生效） |

> 各接口的请求/响应细节见下方分节。`GET`/`POST` 均需 `Authorization: Bearer <API_KEY>`。

---

### 6.1 验证用户 Token ★ 最常用

```
GET /api/v1/auth/verify
```

**鉴权**：`Authorization: Bearer <API_KEY>`（scope: `auth:verify`）

**请求头**

| 请求头 | 必填 | 说明 |
|--------|------|------|
| `x-user-token` | ✅ | 需要验证的用户 JWT Token |

**请求示例（cURL）**

```bash
curl -X GET "{BASE_URL}/api/v1/auth/verify" \
  -H "Authorization: Bearer sk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -H "x-user-token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

**响应示例（有效）**

```json
{
  "valid": true,
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "uid_seq": 42,
    "name": "张三",
    "email": "user@example.com",
    "phone": "138****8000",
    "role": "user",
    "user_level": 3,
    "level_tag": "U3",
    "status": "active",
    "kyc_verified": 1,
    "kyc_name": "张 * 三",
    "points": 380,
    "created_at": "2022-03-15T08:00:00"
  }
}
```

**响应示例（无效）**

```json
{
  "valid": false
}
```

---

### 6.2 获取用户列表

```
GET /api/v1/users
```

**鉴权**：`Authorization: Bearer <API_KEY>`（scope: `users:read`）

**Query 参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `page` | number | ❌ | 页码，默认 `1` |
| `limit` | number | ❌ | 每页条数，默认 `20`，最大 `100` |
| `status` | string | ❌ | 筛选状态：`active` / `disabled` |
| `level_tag` | string | ❌ | 按等级标识符筛选，如 `U3`（普通用户3级）、`A1`（管理员1级）；格式非法返回 `400` |

> 筛选（`status` / `level_tag`）在服务端下沉到查询中，`total` 返回的是**符合筛选条件的总数**（可据此算页数），
> 分页结果跨页一致。公共账号（共享身份）不在返回范围内。

**请求示例**

```bash
curl -X GET "{BASE_URL}/api/v1/users?page=1&limit=20&status=active&level_tag=U3" \
  -H "Authorization: Bearer sk_live_xxxxxxxxxxxxxxxx..."
```

**响应示例**

```json
{
  "total": 1482,
  "page": 1,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "uid_seq": 42,
      "name": "张三",
      "email": "user@example.com",
      "phone": "138****8000",
      "role": "user",
      "user_level": 3,
      "level_tag": "U3",
      "status": "active",
      "kyc_verified": 1,
      "points": 380,
      "created_at": "2022-03-15T08:00:00"
    }
  ]
}
```

---

### 6.3 获取单个用户详情

```
GET /api/v1/users/:uid
```

**鉴权**：`Authorization: Bearer <API_KEY>`（scope: `users:read`）

**路径参数**

| 参数 | 说明 |
|------|------|
| `uid` | 用户 UUID 或用户编号（`uid_seq`，如 `42`） |

**请求示例**

```bash
curl -X GET "{BASE_URL}/api/v1/users/42" \
  -H "Authorization: Bearer sk_live_xxxxxxxxxxxxxxxx..."
```

**响应示例**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "uid_seq": 42,
  "name": "张三",
  "email": "user@example.com",
  "phone": "138****8000",
  "role": "user",
  "user_level": 3,
  "status": "active",
  "kyc_verified": 1,
  "kyc_name": "张 * 三",
  "kyc_id_tail": "****1234",
  "kyc_provider": "aliyun",
  "points": 380,
  "checkin_streak": 5,
  "created_at": "2022-03-15T08:00:00",
  "updated_at": "2025-06-23T09:00:00"
}
```

---

### 6.4 停用用户账号

```
POST /api/v1/users/:uid/disable
```

**鉴权**：`Authorization: Bearer <API_KEY>`（scope: `users:write`）

停用后该用户无法登录，登录接口返回 `403`。

**响应示例**

```json
{
  "success": true
}
```

---

### 6.5 启用用户账号

```
POST /api/v1/users/:uid/enable
```

**鉴权**：`Authorization: Bearer <API_KEY>`（scope: `users:write`）

**响应示例**

```json
{
  "success": true
}
```

---

### 6.6 删除用户实名信息

```
DELETE /api/v1/users/:uid/realname
```

**鉴权**：`Authorization: Bearer <API_KEY>`（scope: `users:kyc`）

删除后用户的 `kyc_verified` 置为 `0`，用户可重新发起认证。

**响应示例**

```json
{
  "success": true
}
```

---

### 6.6.1 实名姓名比对（只回布尔，不下发原文）

```
POST /api/v1/kyc/match
```

**鉴权**：`Authorization: Bearer <API_KEY>`（scope: `users:kyc`）

判断某用户实名认证的姓名/证件号是否与你手上的一致，**只返回布尔值，完整姓名与证件号永不下发**。
服务端比对的是 HMAC 哈希，不比对明文。需服务端配置 `KYC_PSEUDONYM_SECRET`（未配置返回 `503`）。

**请求体**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `uid` | string | ✅ | 用户 UUID / 数字 UID / 自定义 uid_code |
| `name` | string | ✅ | 待比对的姓名（服务端归一化后比对哈希） |
| `id_no` | string | ❌ | 待比对的证件号；传了才比对，比对哈希不比对明文 |

**响应示例**

```json
{ "matched": true }
```

未实名或哈希缺失时返回 `{ "matched": false, "reason": "not_verified" }`。
建议对该接口单独限流并审计（防止被用来爆破姓名）。

---

### 6.6.2 实名认证开放 API（强实名 / 会话 / 二次·多次实名 / 直提核验）

面向「部分应用需强实名、二次/多次核验，或需程序化调用实名」的场景。均排除公共账号。

```
GET  /api/v1/users/:uid/kyc            # 查实名状态（scope: kyc:read）
GET  /api/v1/users/:uid/kyc/events     # 实名历史流水（scope: kyc:read）
POST /api/v1/users/:uid/kyc/session    # 发起实名会话，返回跳转 URL（scope: kyc:session）
POST /api/v1/users/:uid/kyc/verify     # 服务端直提两要素核验（scope: kyc:verify）
```

**查状态** `GET /v1/users/:uid/kyc` →
```json
{ "uid": 142, "verified": true, "name_masked": "张*", "id_tail": "1234",
  "provider": "服务商直接认证", "verified_at": "2026-01-01 10:00:00", "events": 2 }
```
应用据此做「强实名门禁」：`verified=false` 即拦下需实名的操作。

**实名历史** `GET /v1/users/:uid/kyc/events` → `{ total, data:[{ id, provider, status, reverify, source, created_at }] }`。
`status` 为 `verified`（首次）或 `reverified`（二次/多次）；`source` 为 `self`（用户自助）/ `admin` / `api`。

**发起会话** `POST /v1/users/:uid/kyc/session`：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `reverify` | bool | ❌ | 默认 false。已实名用户必须传 `true` 才放行（二次/多次实名） |
| `name` / `id_number` | string | ❌ | 会话服务商为支付宝实人认证时需要（人脸核身前收集） |

返回 `{ success, provider, redirect_url, session_id, reverify }`。把 `redirect_url` 交给用户完成人脸核身；
完成后经服务商 webhook / 回跳落库，应用轮询「查状态 / 历史」得知结果。未传 `reverify` 且用户已实名 → `400`。

**直提核验** `POST /v1/users/:uid/kyc/verify` `{ name, id_number }`：走阿里云/火山「直认证」型两要素比对，无需用户扫脸；
成功即写入实名（已实名用户再调记为 `reverified`）。返回 `{ success, verified, reverify }`；核验不通过 `400`。
未配置任何直认证型服务商密钥时会失败。

---

### 6.6.3 审计存证链（防篡改）

敏感/危险操作（实名认证、二次核验、清除实名、积分调整、账号停用、OIDC 授权等）按发生顺序**哈希链式存证**：
每条记录都含上一条的哈希，任何人事后改动/删除/插入任意一条，从那条起整条链都会对不上、被完整性校验查出。
这是「本地防篡改 + 可自证完整性」层；如需「对第三方举证某时刻已存在」，可在链头之上再叠可信时间戳（暂未内置）。

```
GET /api/v1/audit/verify         # 校验整条存证链（scope: audit:read）
GET /api/v1/users/:uid/audit     # 查某用户的存证事件（scope: audit:read）
```

**校验** `GET /v1/audit/verify` →
```json
{ "ok": true, "count": 128, "head": "<最后一条 row_hash>" }
```
被篡改时返回 `{ "ok": false, "count": N, "broken_seq": 42, "reason": "内容被篡改（row_hash 对不上）" }`（或 `prev_hash 链断裂`）。

**用户存证** `GET /v1/users/:uid/audit?limit=100` → `{ total, data:[{ seq, event_type, subject, actor, detail, created_at }] }`。
`event_type` 如 `kyc.verified` / `kyc.reverified` / `kyc.realname_deleted` / `points.adjusted` / `user.disabled` / `oidc.authorized`；
`actor` 形如 `apikey:<id>` / `admin:<uid>` / `user:<uid>` / `source:api`。detail 只含摘要，**绝不含身份证号/密钥原文，姓名已脱敏**。

---

### 6.7 获取应用列表

```
GET /api/v1/apps
```

**鉴权**：`Authorization: Bearer <API_KEY>`（scope: `apps:read`）

**响应示例**

```json
{
  "total": 4,
  "data": [
    {
      "id": "app_uuid",
      "name": "企业 OA 系统",
      "client_id": "app_a1b2c3d4e5f6",
      "callback_url": "https://oa.example.com/sso/callback",
      "status": "enabled",
      "visible": 1,
      "auth_users": 342,
      "created_at": "2025-01-01T00:00:00"
    }
  ]
}
```

---

### 6.8 代发短信

```
POST /api/v1/sms/send
```

**鉴权**：`Authorization: Bearer <API_KEY>`（scope: `sms:send`）

**请求体**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `phone` | string | ✅ | 手机号 |

**请求示例**

```json
{
  "phone": "13800138000"
}
```

**响应示例**

```json
{
  "success": true,
  "msgId": "sms_1719133200000"
}
```

---

### 6.9 获取全量登录日志

```
GET /api/v1/logs
```

**鉴权**：`Authorization: Bearer <API_KEY>`（scope: `logs:read`）

返回最新 200 条。

**响应示例**

```json
{
  "total": 200,
  "data": [
    {
      "id": "log_uuid",
      "user_id": "user_uuid",
      "user_name": "张三",
      "uid_seq": "00042",
      "method": "邮箱密码",
      "app_name": "企业 OA 系统",
      "ip": "121.44.xx.xx",
      "user_agent": "Chrome/125.0 macOS",
      "status": "success",
      "fail_reason": null,
      "created_at": "2025-06-23T09:14:00"
    }
  ]
}
```

---

### 6.10 核验兑换券

```
GET /api/v1/coupon/verify
```

**鉴权**：`Authorization: Bearer <API_KEY>`（scope: `redeem:verify`）

用于第三方系统核验某张用户兑换券是否有效（未使用/未过期/未撤销）。

**Query 参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `code` | string | ✅ | 兑换券码，格式 `XXXX-XXXX-XXXX` |

**响应示例（有效）**

```json
{
  "valid": true,
  "goods_name": "云存储空间 +1G",
  "user_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

**响应示例（无效）**

```json
{
  "valid": false,
  "reason": "状态：used"
}
```

---

### 6.11 核销兑换券

```
POST /api/v1/coupon/use
```

**鉴权**：`Authorization: Bearer <API_KEY>`（scope: `redeem:verify`）

第三方系统在完成对应服务发放后，调用此接口将兑换券标记为已使用，防止重复兑换。

**请求体**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `code` | string | ✅ | 兑换券码 |

**响应示例**

```json
{
  "success": true,
  "goods_name": "云存储空间 +1G",
  "user_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

---

### 6.12 核验兑换码

```
GET /api/v1/redeem/verify
```

**鉴权**：`Authorization: Bearer <API_KEY>`（scope: `redeem:verify`）

核验管理员批量发放的兑换码（区别于用户个人的兑换券），常用于第三方激活流程。

**Query 参数**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `code` | string | ✅ | 兑换码 |

**响应示例（有效）**

```json
{
  "valid": true,
  "type": "points",
  "value": 100,
  "feature_key": null,
  "remaining": 4
}
```

---

### 6.13 自主功能：积分 / 商城

SSO 自建的积分与商城能力，供第三方系统程序化对接（如给用户发积分、读商品目录、查用户兑换券）。
`:uid` 支持用户 UUID / 数字 UID / 自定义 uid_code；**公共账号（共享身份）不在返回范围内**。

```
GET  /api/v1/users/:uid/points          # 查积分余额（scope: points:read）
GET  /api/v1/users/:uid/points/logs     # 查积分明细，最近 50 条（scope: points:read）
POST /api/v1/users/:uid/points          # 调整积分（scope: points:write）
GET  /api/v1/shop/goods                 # 商城在售商品目录（scope: shop:read）
GET  /api/v1/users/:uid/coupons         # 用户持有的兑换券（scope: shop:read）
```

**查积分余额** — `GET /v1/users/:uid/points`

```json
{ "id": "...", "uid_seq": 42, "uid_code": null, "name": "张三", "points": 380, "checkin_streak": 5 }
```

**调整积分** — `POST /v1/users/:uid/points`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `delta` | number | ✅ | 非零整数，正数增加、负数扣减；扣减不能使余额为负（否则 `400`） |
| `reason` | string | ❌ | 备注，记入积分明细，默认「API 增加/扣减积分」 |

```json
{ "success": true, "points": 480, "delta": 100 }
```

**商品目录** — `GET /v1/shop/goods`

```json
{ "total": 3, "data": [
  { "id": "...", "name": "云存储 +1G", "icon": "☁️", "cost": 100, "stock": -1, "exchange_count": 24, "status": "on", "is_blind_box": 0 }
]}
```

**用户兑换券** — `GET /v1/users/:uid/coupons`

```json
{ "total": 2, "data": [
  { "coupon_code": "ABCD-1234-EFGH", "goods_name": "云存储 +1G", "status": "unused", "obtained_at": "2026-01-01 10:00:00", "used_at": null }
]}
```

> `status` 取值：`unused` / `used` / `transferred` / `discarded`。核销兑换券用 [6.11](#611-核销兑换券)。

**签到、盲盒、等级/分组读取**

```
GET  /api/v1/users/:uid/checkin         # 查签到状态（scope: points:read）
POST /api/v1/users/:uid/checkin         # 代该用户签到发积分（scope: points:write）
GET  /api/v1/levels                     # 等级目录（scope: users:read）
GET  /api/v1/groups                     # 分组目录（scope: users:read）
GET  /api/v1/tags                       # 标签目录（scope: users:read）
GET  /api/v1/users/:uid/org             # 某用户的分组+标签（scope: users:read）
GET  /api/v1/shop/blind-boxes           # 盲盒目录（含各奖励项展示名与权重，scope: shop:read）
GET  /api/v1/points/leaderboard         # 积分排行榜，默认前 20 最多 100（scope: points:read）
GET  /api/v1/users/:uid/shop/records    # 用户的商城兑换记录（scope: shop:read）
POST /api/v1/users/:uid/shop/exchange/:goods_id  # 代用户兑换商品/开盲盒（scope: shop:write）
```

`GET /v1/points/leaderboard` → `{ total, data: [{ rank, uid_seq, uid_code, name, points }] }`（`limit` 可选，排除公共账号）。

- `POST /v1/users/:uid/checkin` 遵循管理端配置的签到周期与随机积分区间；同周期重复签到返回 `400`。
  返回 `{ success, points, min, max, streak, total }`。
- `GET /v1/users/:uid/checkin` → `{ uid_seq, checkin_streak, last_checkin, checked_in_today }`。
- `GET /v1/levels` 每项带 `level_tag`（U3 / A1）；`/v1/groups`、`/v1/tags`、`/v1/users/:uid/org` 只返回名称与颜色，**不下发内部权限**。
- `GET /v1/shop/blind-boxes` 返回盲盒商品及其奖励项的 `label` / `weight`，用于展示。
- `POST /v1/users/:uid/shop/exchange/:goods_id`（`shop:write`）代用户兑换商品或开盲盒，与用户端 `/shop/exchange` 同一套核心逻辑（`performExchange`）：
  校验商品在售/有货、用户积分足够 → **事务内**扣积分、减库存、写兑换记录、发兑换券。
  - 普通商品：返回 `{ success, remain, type:'coupon', coupon:{ code, goods_name, allow_instant, redirect_url } }`
  - 盲盒（即开 `open_instantly`）：加权随机选奖并当场结算，返回 `{ success, remain, type:'blind_box', reward, opened:true, executed:true, ... }`
  - 盲盒（延迟开）：发一张待开的盲盒券，返回 `{ ..., type:'blind_box', opened:false, coupon:{ code, is_blind:true } }`
  - 积分不足 / 缺货 → `400`；商品或用户不存在 → `404`。排除公共账号（`is_public=1`）。

### 6.14 门禁（设备接入）

门口的扫码机/读卡器用一个门禁 **`sk_live_`** 密钥（后台给本机出口 IP 配可信 IP，支持 CIDR）调用；`sk_test_` 走沙盒。

**开门方式 = 动态二维码**：用户在控制台/App 点「出示开门码」拿到一个 **60 秒**（`ACCESS_QR_TTL` 可改，15~600）、一次性的签名码（`qr1.<payload>.<sig>`）。
**主码**代表「人」不绑死门——门口校验时按该门的授权规则判定；jti 一次性消费，截图重放会被拒。

**门子码（v3.5.29）**：用户点某扇门可出示该门的**子码**（同为 `qr1.`，内含门标签，只能开这一扇；有效期按门设定）。每扇门可独立设：
- **开门码模式**：`any`（主码/子码都收）或 `sub_only`（只收本门子码；主码、静态访客码、跨域码一律 `need_subcode`）；
- **子码有效期**（秒）；
- **禁入时段**（星期 / 时段 / 日期区间，可多条）：对所有人生效，含访客、跨域访客与刷卡人脸 → `door_blackout`；
- **访客须陪同**：访客验码通过后返回 `result:"pending_escort"`，陪同人须在 120 秒内于同一扇门扫自己的码（或刷卡/人脸），陪同人放行时响应带 `escorted:["访客名"]`，访客同时放行并扣次数。

访客也有子码：访客页 `/pass.html` 点某扇门出示该门子码（`vs1.`，短时一次性，`POST /api/public/pass/:code/sub {door_id}`）。访客码可指定**陪同人**（指定后到任何门都要此人带入；未指定时「需陪同」的门由签发人带入）和**自己的禁入时段**（`pass_blackout`）。

```
POST /api/v1/access/verify     scope: access:verify
Authorization: Bearer sk_live_xxx
{ "door_id": "<门ID>", "code": "qr1...." }

→ { "allow": true, "result": "allow", "reason": "ok", "reason_text": "放行",
    "user": { "uid_seq": 142, "uid_code": null, "name": "张三" },
    "door": { "id": "...", "name": "一楼大门" } }
```

- `allow=false` 时 `reason` ∈ `denied_by_rule`（被拒绝规则命中）/ `out_of_schedule`（不在时段）/ `not_authorized`（无权限）/ `expired`（码过期）/ `replayed`（码已用）/ `bad_sig` / `user_disabled` / `door_disabled` 等，`reason_text` 为中文。
- v3.5.29 新增 `reason`：`need_subcode`（此门只认子码）/ `wrong_door_code`（子码不属于此门）/ `door_blackout`（门禁入时段）/ `pass_blackout`（访客码禁入时段）/ `need_escort`（`result="pending_escort"`，附 `escort.name`、`expires_in`；不是拒绝，是等陪同人）。
- 无论放行/拒绝都会写一条通行记录 + 一条防篡改审计（`access.granted` / `access.denied`）。
- **访客通行码也走同一接口**：`code` 不以 `qr1.` 开头时，按访客码处理——校验 时限 + 门在允许集 + 剩余次数，放行即扣一次。访客码由管理员/分组管理员在控制台签发（时限+指定门+次数，可发给无账号访客），访客用 `/pass.html?code=` 打开出示二维码。拒绝 `reason` ∈ `pass_expired`/`pass_not_started`/`pass_wrong_door`/`pass_used_up`/`pass_revoked`/`pass_unknown`。
- **跨系统联邦码**（`code` 以 `ft1.` 开头，v3.5.5）：伙伴系统用双方登记的**共享密钥**签发的跨域访客码。本系统按 `iss`(peer_code) 找到登记的伙伴 → 用其 secret 本地验签 → 校验 伙伴启用 + 未过合作期 + 码未过期 + 门在「开放给该伙伴」集合内 → 放行（离线可验，不回调对方）。拒绝 `reason` ∈ `fed_bad_sig`/`fed_unknown`/`fed_revoked`/`fed_peer_expired`/`fed_code_expired`/`fed_wrong_door`。联邦伙伴在管理端「门禁管理 → 跨系统联邦」登记（双方填同一对 peer_code+secret），各自决定开放给对方哪些门。

#### 跨域应用登录（v3.5.7）

同一对联邦伙伴也可共享 **OIDC 应用**：A 把某应用开放给伙伴 B（`peer.app_ids`），B 的用户在自己系统一键跳转登录 A 的应用。
- B 侧：`POST /api/user/fed-apps/:id/launch`（用户登录态）→ B 用共享密钥给当前用户签一个身份断言令牌（`fl1.`）→ 返回 A 的跳转地址。
- A 侧：`GET /fed/launch?peer=&token=&app=&redirect_uri=&scope=&state=&nonce=` → 验签 + 校验应用已对该伙伴开放 + redirect_uri 匹配 → 落**联邦授权码**（不在 A 创建用户，身份来自 B 断言）→ 回跳应用 callback。
- 应用随后走标准 `/oauth/token`（用自己的 client_secret）换 `id_token`——claim `sub=fed:<peer_code>:<b_sub>`、`from_peer`、以及授权 scope 内的 name/email。⚠️ 联邦访客的 `email_verified=false`（伙伴断言，A 未独立验证）。
- B 侧管理员在「门禁管理 → 跨系统联邦 → 伙伴应用」登记 A 开放的应用（a_base_url + client_id + callback_url + scope，由 A 管理员提供）。

```
POST /api/v1/access/check      scope: access:verify   # 刷卡/人脸：设备解析出 card_no 或 uid 后调
{ "door_id": "...", "card_no": "04A2B3" }             # 实体卡/NFC：card_no → 绑定用户（v3.5.2）
{ "door_id": "...", "uid": "142", "method": "face" }  # 人脸：一体机本地比中后传 uid（v3.5.3）；method ∈ card|face|remote|qr
# 卡未绑定/停用 → reason=card_unknown

# 人脸库（人脸一体机同步，本地 1:N 比对；图片是敏感 PII，仅授权设备可拉）：
GET /api/v1/access/faces              scope: access:read   # [{uid_seq,uid_code,name,updated_at}]，支持 ?since= 增量
GET /api/v1/access/faces/<uid>/image  scope: access:read   # 该用户人脸图片原始字节
# 用户在控制台/App「门禁」页自愿录入人脸（POST /api/user/access/face），可随时删除。

GET  /api/v1/access/doors      scope: access:read      # 已启用的门列表 → { total, data:[{id,name,location,status}] }
GET  /api/v1/access/logs       scope: access:read      # 通行记录（?door_id= &limit=，最多 500）
```

> 授权规则（谁能过某扇门）在管理端「门禁管理」页配置：可按**组织/分组/标签/等级批量放行**，再叠加**逐人允许/拒绝**（**拒绝优先**），每条规则可限**时段 + 星期**。
> 也可直接用现成的扫码终端页 `/access-terminal.html`（填 Key + 选门 → 浏览器原生扫码），把旧平板/手机变成门禁机。

---

### 6.15 设备管理（登记 + 台账，v3.5.21）

设备台账的程序化同步与心跳上报。设备的登记/编辑/删除在管理端「设备管理」页（见 7.x），开放 API 只读 + 心跳。

```
GET  /api/v1/devices                     scope: device:read   # 设备台账同步
POST /api/v1/devices/:id/heartbeat       scope: device:read   # 在线设备上报心跳
```

**设备台账** — `GET /v1/devices`

| Query | 必填 | 说明 |
|------|------|------|
| `kind` | ❌ | 按类型过滤：`apple` / `google` / `microsoft` / `access_controller`（门禁机） / `card_reader`（读卡器） |
| `status` | ❌ | 按状态过滤：`active` / `disabled` / `lost` |

```json
{ "total": 2, "data": [
  { "id": "dev_uuid", "name": "前台门禁机", "kind": "access_controller", "serial": "AC-0001",
    "status": "active", "subject": "示例集团", "owner": null, "door_id": "door_uuid",
    "door": "一楼大门", "tags": "一楼", "last_seen": "2026-10-03 09:00:00" }
]}
```

- `subject`=所属组织名（可空）、`owner`=所有者姓名（可空）、`door`=关联门名（仅门禁机/读卡器）。

**心跳上报** — `POST /v1/devices/:id/heartbeat`

在线设备（门禁机/读卡器等）定期调用，刷新 `last_seen`。设备不存在返回 `404`。

```json
{ "success": true, "status": "active" }
```

---

### 6.16 防截图水印策略（v3.4.23）

读取 / 修改水印策略，供第三方系统程序化对接（策略同样在管理端「系统配置 → 水印」可视化配置）。

```
GET /api/v1/watermark     scope: config:read
PUT /api/v1/watermark     scope: config:write
```

**读取** — `GET /v1/watermark` → `{ success, watermark: { enabled, scope:[...], text, opacity, angle, size, gap, color, burn } }`

**修改** — `PUT /v1/watermark`（只接受以下键，传了才改，即时生效）

| 参数 | 类型 | 说明 |
|------|------|------|
| `enabled` | bool/string | 开关（`on/1/true/yes/true` 视为开，其余为关） |
| `scope` | string/数组 | 显示范围：`all` 或页面标识逗号串（如 `dashboard,login,memo`） |
| `text` | string | 文本模板，支持 `{name}` `{uid}` `{email}` `{date}` `{time}` `{datetime}` |
| `opacity` / `angle` / `size` / `gap` | number | 透明度 / 角度 / 字号 / 间距（后端有范围夹紧） |
| `color` | string | `#RRGGBB` |
| `burn` | bool/string | **导出文件加水印**开关（v3.5.33，与 `enabled` 独立）：备忘录附件里的图片 / PDF 下发时由服务器烧录水印 |
| `burn_text` | string | 导出水印文本模板（留空则用 `text`）；末尾自动追加追踪码 `T` + 8 位 |

```json
{ "success": true, "watermark": { "enabled": true, "scope": ["all"], "text": "{name} {uid} {datetime}", "opacity": 0.12, "angle": -22, "size": 16, "gap": 160, "color": "#888888" } }
```

> **两层水印**：`enabled` 控制页面 DOM 层水印（防截图/录屏）；`burn` 控制**烧进文件本身**的水印（v3.5.33）——
> 备忘录附件中的 PNG/JPEG/WebP/GIF 与 PDF 在查看/下载时由服务器把「查看人 + 时间 + 追踪码」合成进像素 / 每一页，
> 绕过前端直接调接口拿到的也是带水印的文件；烧录失败时**拒绝下发**（不会退回原文件）。docx 等其它类型无法烧录，照常下发。
> 每次下发写一条审计存证 `file.watermarked`；管理端可用 `GET /api/admin/audit/trace/:code`（Lv.3，`code` 如 `T1A2B3C4D`）
> 按追踪码反查是谁、何时导出了哪个文件。中文字体：服务器无 CJK 字体时首次使用自动下载（`WATERMARK_FONT_URL`，默认钉死版本的 Noto Sans SC），
> 下载不了则只保留 UID / 邮箱 / 时间 / 追踪码。

---

### 6.18 企业微信通讯录同步（v3.5.35；v3.5.36 起一个组织可有多个同步源；v3.5.37 起可多选部门、默认凭证；v3.5.39 起支持接收事件服务器）

企业微信没有标准 SCIM，本系统用它自己的通讯录 API **拉取**所选部门（可多选，含子部门）的成员，同步成某组织的成员。
一个组织可以配置**多个同步源**（如多家企业微信），每个同步源像登录凭证一样单独启停、编辑、同步；配置入口在管理端「组织管理」的组织卡片（「+ 通讯录同步」）或组织成员弹窗（系统管理员或该组织的组织管理员），需要企业微信后台「管理工具 → 通讯录同步」的 Secret，并把本服务器出口 IP 加进可信 IP。

```
POST /api/v1/orgs/:sid/dir-sync/run      scope: org:sync    # 依次跑该组织所有启用的同步源
```

响应：`{ success, results: [{ source_id, label, state: { at, ok, total, created, linked, added, removed, skipped, bind_provider, bind_providers[], bound, pw_set, kept, conflicts, force, errors[] } } | { source_id, label, error }] }`；没有启用的同步源 400。开放 API 只做普通同步，**不会**做「全部覆盖」。

同步规则：
- 匹配顺序：本组织历次同步的 UserId 映射 → 已绑定该 UserId 的企业微信登录 → 邮箱（email / biz_mail）→ 手机 → 新建账号。
- **同步范围**（v3.5.37）：`dept_ids` 可多选部门（勾父部门即含全部子部门，父子都勾也不会重复）。集团总公司的通讯录 Secret 只开了部分部门权限时，只勾那几个部门——选了看不到的部门同步会报企业微信 60011 无权限。旧配置的单个 `dept_id` 自动当作 `[dept_id]`。
- **登录凭证绑定**（v3.5.37，`bind_mode`）：`auto`（默认，绑到同一企业的企业微信登录：该组织下 corpid 相同的凭证，否则本站默认凭证）/ `custom`（`bind_providers` 指定一个或多个本组织的企业微信登录凭证）/ `none`（不绑）。绑定后成员用企业微信登录进入同一账号；该 UserId 已绑在别人身上时永不抢占（计入 `conflicts`）。
- **默认组织密码**（v3.5.37，`default_password`，6~64 位，只存 bcrypt 哈希、不下发；`clear_default_password:true` 清除）：给同步进来的成员（`source=wecom`）补上组织密码，用于「登录到组织」。手动加入 / 导入的成员不设。
- **单独改过的不覆盖**：系统记住每个同步源给每个成员设过什么（`dir_sync_applied`）。成员被单独解绑 / 改绑登录凭证、改了或清了组织密码，普通同步都保留（计入 `kept`）；默认密码换了，只有「还是上次同步设的密码」的成员会跟着更新。
- **全部覆盖同步**：`POST /api/admin/dir-sources/:id/run` 传 `{ force: true, confirm: "全部覆盖" }`（口令必须原样），把上面被单独改过的也改回同步源的默认值；写审计存证（`force: true`）。
- 成员状态 1（已激活）/4（未激活）计入；2（禁用）/5（退出企业）视为离开。
- 「离开」的成员从组织移出——**只动同步进来的成员**（`source=wecom`），且他已不在本组织**任何一个**同步源里；手动加入/批量导入的不动；本次一个人都没拉到时不做任何移除。
- UserId 映射按同步源隔离：两家企业里同名的 UserId 不会被当成同一个人。
- 组织内 UID 默认取企业微信 UserId（冲突则不设），也可改为按本组织 UID 规则生成或不设置。
- 可设自动同步间隔（1/6/24 小时）；每次同步写审计存证 `org.dir_synced`。

**两份 Secret**（v3.5.50）：`secret` 读通讯录（推荐自建应用 Secret）；`write_secret`（可选，「通讯录同步」Secret，开启 API 编辑通讯录）只用来在企业微信里禁用 / 启用 / 删除成员（停用同步、注销与删除的交接处理），不填则用 `secret` 去改——自建应用 Secret 没有写权限会报 48002。两者读取时都打码，打码串 / 留空不覆盖，`clear_write_secret: true` 清除；文件夹通讯录连接同样有这两个字段。

**用哪个 Secret**（v3.5.39）：推荐**自建应用**的 Secret（应用可见范围设为要同步的部门，并把本服务器出口 IP 加进该应用的可信 IP）。「管理工具 → 通讯录同步」的 Secret 自 2022-08-15 起在新 IP 上被企业微信禁止读取通讯录详情（`48009 api forbidden for contact assistant`），只能读到 UserId 和部门 ID。用它时本系统自动降级到 `department/simplelist` + `user/list_id`：已关联过的成员照常同步、离开照常移出，**没关联过的人因为认不出是谁不会建号**（结果里 `limited: true`、`unmatched` 计数、`warning` 提示改用自建应用 Secret）。常见错误码（40001 / 40013 / 48009 / 60011 / 60020）的报错会带中文处理建议。

**接收事件服务器**（v3.5.39，实时同步，可选）：同步源配置里填 `cb_token`（1~32 位字母数字）+ `cb_aes_key`（43 位 EncodingAESKey，读取时打码；`cb_clear: true` 关闭），回调地址为

```
GET/POST /api/public/dirsync/wecom/:source_id      # 公开，无需鉴权；靠企业微信签名 + 加密校验
```

在企业微信后台「通讯录同步 → 设置接收事件服务器」（或自建应用的「接收消息」）填入 URL / Token / EncodingAESKey。GET 为保存时的地址校验（验签 + 解密 echostr 原样返回；v3.5.39.1 起 query 自行解析，echostr 里未编码的 `+` 不会被当成空格；每次校验的结果与失败原因记入 `event_state.last_verify`）；POST 为事件推送：验签（sha1）+ AES-256-CBC 解密 + 校验企业 ID，`change_contact` 事件**防抖约 10 秒后对该同步源跑一次全量同步**（一阵批量变动只同步一次，范围、移出、单独修改不覆盖等规则与手动同步一致；环境变量 `DIRSYNC_EVENT_DELAY_MS` 可调），`update_user` 带 `NewUserID` 时先就地改 UserId 映射 / 登录绑定 / 组织内 UID。签名错或企业不符 403；同步源停用或非通讯录事件只记录不同步。同步源视图多回 `callback_path`、`callback_ready`、`event_state`（最近校验时间、最近事件、累计条数）。

管理端接口（v3.5.36）：`GET/POST /api/admin/orgs/:sid/dir-sources`（列表 / 新增；`secret` 读取时打码；列表另回 `bind_choices` 可选登录凭证、`force_confirm` 确认口令）、`POST /api/admin/orgs/:sid/dir-sources/scope-tree`（v3.5.37，`{corp_id, secret}` 或 `{source_id}` 用已存 secret → 该 Secret 能看到的部门 `nodes[{id,name,parent,order}]`）、`PATCH /api/admin/dir-sources/:id`（编辑，或只传 `{enabled}` 启停；打码串/留空不覆盖 secret）、`DELETE /api/admin/dir-sources/:id`（删除同步源，已同步成员保留）、`POST /api/admin/dir-sources/:id/run`（立即同步，停用的源 400，同组织并发 409）。

本站（默认主体）三方登录凭证（v3.5.36，Lv.1）：`GET /api/admin/oauth-defaults`（按平台列出，密钥只给「是否已设置」）、`PUT /api/admin/oauth-defaults/:platform`（`{values, enabled}`；密钥留空不改，`enabled:false` 只关闭登录入口、凭证保留——记在 `OAUTH_DEFAULT_DISABLED`）、`DELETE /api/admin/oauth-defaults/:platform`（清空该平台配置）。

### 6.18.1 飞书通讯录同步（v3.5.59）

同一套同步源接口，`type: "feishu"`。用飞书**企业自建应用**（免费版即可：通讯录、认证授权、事件订阅类接口不计入飞书 API 调用额度）。字段沿用同名：

| 字段 | 飞书含义 |
|---|---|
| `corp_id` | App ID（`cli_` 开头） |
| `secret` | App Secret（读写用同一个应用；在飞书里暂停 / 删除成员要给应用开「更新通讯录」权限，没有 `write_secret`） |
| `dept_ids` | 部门 `open_department_id` 字符串数组，根部门 `"0"` = 应用通讯录权限范围内所有人（权限没开到根部门时自动按 `contact/v3/scopes` 里的部门 + 单独授权的成员同步） |
| `cb_token` / `cb_aes_key` | 事件订阅的 Verification Token（开实时同步必填）/ Encrypt Key（可选，飞书后台设了才填；`cb_aes_clear: true` 清除） |
| `uid_mode: "userid"` | 组织内 UID 用飞书工号（`employee_no`），没有则用飞书 `user_id` |
| `push_suspend` | 本系统停用 / 删除账号时把飞书成员设为暂停（`is_frozen`），恢复时取消暂停 |

认人：映射的 `ext_id` = 同步应用里的 `open_id`，另存 `ext_union`（`union_id`，同一企业的各应用共用）。顺序：本源映射 → 同一 App ID 的飞书登录凭证已绑这个 open_id → 任一飞书同步源 / 飞书登录绑定的 union_id → 企业邮箱 / 邮箱 → 手机（去掉 `+86`）→ 新建。同步后把 open_id 绑到**同一 App ID** 的飞书登录凭证（带 union_id）；用别的 App ID 的飞书凭证登录时按 union_id 认到同一账号并补绑。离职（`is_resigned`）/ 暂停（`is_frozen`）/ 主动退出（`is_exited`）视为离开。组织成员 `source='feishu'`，移出规则与企业微信一致。

- `POST /api/admin/orgs/:sid/dir-sources/scope-tree` 传 `{type:'feishu', corp_id, secret}`（或 `{source_id}`）→ `nodes`（能看到根部门时首项为 `{id:'0', name:'全部（企业根部门）'}`）。
- `GET /api/admin/orgs/:sid/dir-sources` 多回 `bind_choices_feishu`；`types` 含 `feishu`。
- 事件订阅地址：`POST /api/public/dirsync/feishu/:id`（同步源视图 `callback_path`）。`url_verification` 原样回 `{challenge}`；配了 Encrypt Key 时内容为 `{"encrypt":…}`（AES-256-CBC，key = sha256(Encrypt Key)，iv = 密文前 16 字节），事件推送校验 `X-Lark-Signature` = sha256(timestamp + nonce + Encrypt Key + 原始 body)；`header.token` 必须等于 Verification Token；`header.app_id` 与 App ID 不符的只记录不同步。`contact.user.*` / `contact.department.*` / `contact.scope.*` 事件防抖后跑一次全量同步。校验失败原因记在 `event_state.last_verify`。
- 注销与删除的交接项、「异常账号」补绑 / 删除、「残留成员」都支持飞书成员（`memberStatus`：在职 / 暂停 / 离职 / 已不存在）。残留成员批量操作请求体加 `platform: "feishu"`，确认语为「禁用|删除 N 个飞书成员」；同一次只能处理同一种平台。
- 暂不支持：飞书通讯录放到组织文件夹上共用（`POST /api/admin/org-folders/:id/dir-sources` 只收企业微信）。
- 常见错误码：10003 / 10014（App ID / Secret 不对）、99991672（应用没开权限或没发布版本）、40004（部门不在通讯录权限范围）、41050（成员不在权限范围）。

> v3.5.59 同时修了飞书**登录**：`authen/v2/oauth/token` 的 `access_token` 在响应顶层，之前从 `data.access_token` 取，导致飞书登录一直失败；现在失败时登录页显示飞书返回的错误码和原因，凭证没填回调地址时按当前访问域名拼 `/auth/feishu/callback`。

---

### 6.17 外部通讯录导入（组织成员同步，v3.4.20）

把外部通讯录批量 upsert 到某组织（登录主体）的成员。

```
POST /api/v1/orgs/:sid/members/import     scope: org:sync
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `members` | array | ✅ | 每项 `{ email?, phone?, name?, org_uid? }`；按 email/phone 找用户，找不到则建号；`org_uid` 留空按组织规则自动生成 |
| `remove_missing` | bool | ❌ | 为 `true` 时，清除「本次未出现**且** source=import」的成员；**手动加入的（source=manual）绝不动** |

```json
{ "success": true, "total": 2, "ok": 2, "removed": 0,
  "results": [ { "email": "a@x.com", "status": "created", "org_uid": "EMP0001" },
               { "email": "b@x.com", "status": "updated", "org_uid": "EMP0002" } ] }
```

- 命中公共账号会跳过；坏邮箱/缺标识的行 `status:'error'`。组织不存在返回 `404`。写防篡改审计 `org.members_imported`。

---

## 七、管理端接口

> 以下接口需要管理员 JWT Token，且部分接口对等级有要求。
>
> - **Lv.1 超级管理员**：可操作全部接口
> - **Lv.2 运营管理员**：可操作用户、应用管理，不可操作 API Key、环境变量
> - **Lv.3 只读管理员**：仅可查询，不可修改

---

### 7.1 获取统计数据

```
GET /api/admin/stats
```

**所需等级**：Lv.3 及以上

**响应示例**

```json
{
  "success": true,
  "stats": {
    "total": 1482,
    "verified": 896,
    "todayActive": 218,
    "newThisMonth": 43,
    "daily7": [
      { "d": "2025-06-17", "n": 8 },
      { "d": "2025-06-18", "n": 12 }
    ]
  }
}
```

---

### 7.2 获取用户列表

```
GET /api/admin/users
```

**所需等级**：Lv.3 及以上

**Query 参数**

| 参数 | 说明 |
|------|------|
| `q` | 关键字搜索（姓名 / 邮箱 / 手机号） |
| `status` | `active` / `disabled` |

---

### 7.3 获取用户详情

```
GET /api/admin/users/:id
```

**所需等级**：Lv.3 及以上

返回字段包括基本信息、三方绑定、已授权应用、最近登录记录。

---

### 7.4 修改用户信息

```
PATCH /api/admin/users/:id
```

**所需等级**：Lv.2 及以上

**请求体（所有字段均可选）**

| 参数 | 类型 | 说明 |
|------|------|------|
| `name` | string | 姓名 |
| `email` | string | 邮箱 |
| `phone` | string | 手机号 |
| `status` | string | `active` / `disabled` |
| `user_level` | number | 用户等级 1-5 |
| `admin_level` | number | 管理员等级 1-3，或 `null` |

---

### 7.5 停用 / 启用用户

```
POST /api/admin/users/:id/disable
POST /api/admin/users/:id/enable
```

**所需等级**：Lv.2 及以上

---

### 7.6 重置用户密码

```
POST /api/admin/users/:id/reset-password
```

**所需等级**：Lv.2 及以上

**请求体**

```json
{
  "password": "NewPassword123"
}
```

---

### 7.7 删除用户实名信息（管理端）

```
DELETE /api/admin/users/:id/kyc
```

**所需等级**：Lv.2 及以上

---

### 7.8 获取用户登录日志

```
GET /api/admin/users/:id/logs
```

**所需等级**：Lv.3 及以上，返回最近 50 条。

---

### 7.9 应用管理

```
GET    /api/admin/apps           # 获取所有应用
POST   /api/admin/apps           # 新增应用
PATCH  /api/admin/apps/:id       # 修改应用
POST   /api/admin/apps/:id/approve  # 审核通过并上架
```

**所需等级**：查询 Lv.3，修改 Lv.2

新增应用请求体：

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | ✅ | 应用名称 |
| `callback_url` | string | ✅ | OAuth 回调地址（多个用英文逗号分隔） |
| `launch_url` | string | ❌ | 发起地址：用户在控制台点「打开」时跳转的应用登录入口。留空则由 SSO 用 `callback_url` 拼授权链接。只放行 `http(s)` |
| `required_scopes` | string/数组 | ❌ | 必传字段（用户不可取消、强制并入），如 `"profile email"`。见 [10.2 必传字段](#102-权限范围scope) |
| `icon` | string | ❌ | Emoji 图标，默认 `📦` |
| `description` | string | ❌ | 应用描述 |
| `status` | string | ❌ | 初始状态 `enabled`/`pending`/`disabled`，默认 `enabled` |
| `visible` | boolean | ❌ | 是否在用户端市场展示，默认 `false` |

> `PATCH /api/admin/apps/:id` 接受同样的字段（均可选，只改传入的）。
> 另有 `POST /api/admin/apps/:id/regenerate-secret` 轮换 `client_secret`（旧密钥立即失效）。

---

### 7.10 获取全量登录日志（管理端）

```
GET /api/admin/logs
```

**所需等级**：Lv.3 及以上，返回最新 200 条。

---

### 7.11 API Key 管理

```
GET    /api/admin/api-keys       # 获取所有 API Key
POST   /api/admin/api-keys       # 创建新 API Key
DELETE /api/admin/api-keys/:id   # 撤销 API Key
```

**所需等级**：Lv.1（超级管理员）

创建请求体：

```json
{
  "name": "主系统对接",
  "scopes": ["auth:verify", "users:read"]
}
```

创建响应（**token 仅返回一次，请立即保存**）：

```json
{
  "success": true,
  "token": "sk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

---

### 7.12 环境变量管理

```
GET  /api/admin/env         # 获取所有环境变量
POST /api/admin/env         # 批量保存环境变量
```

**所需等级**：Lv.1（超级管理员）

保存请求体：

```json
{
  "vars": {
    "WECHAT_APP_ID": "wx1234567890abcdef",
    "WECHAT_APP_SECRET": "your_secret",
    "SMS_PROVIDER": "volcengine"
  }
}
```

---

### 7.12.0 系统通知：Webhook / 群机器人（v3.5.52）

经 QWQ Message 分发中心把重要事件推到 Webhook 或飞书 / 钉钉 / 企业微信群机器人（复用 `QWQ_MESSAGE_URL` / `QWQ_MESSAGE_KEY`）。

| 变量 | 说明 |
|---|---|
| `QWQ_MESSAGE_NOTIFY_GROUP` | 分发中心里 Webhook / 群机器人分组的编号；空 = 不推送 |
| `QWQ_MESSAGE_NOTIFY_EVENTS` | 逗号分隔类别：`account` `merge` `grant` `dirsync` `backup` `kyc` `system` `announcement`；`all` = 全部；留空 = 除 `announcement` 外全部 |

```
POST /api/admin/notify/test     # Lv.1：发一条测试通知 → { success, method }；分发中心的错误原样返回（502）
```

发送体：`{ group, subject:"[QWQ SSO] 标题", content:"【QWQ SSO】标题\n…\n时间：…\n站点：…", variables:{ event, title, time, site } }`（Webhook 默认请求体会带上 variables 的键，渠道里配了请求体模板也可以用 `{{title}}` 等引用）。通讯录同步失败只在「从正常变失败 / 原因变了」时推一次，重复账号数变了才推；推送失败只记日志，不影响业务。

### 7.12.1 域名验证文件（v3.5.40）

企业微信「可信域名」、微信公众号业务域名等会要求把验证文件放在**域名根目录**。管理员上传后，本站在根路径下提供，到期自动删除。

```
GET    /api/admin/verify-files            # 列表 { files:[{name,size,expires_at,note,created_at,updated_at,expired}] }（顺带清理已过期的）
GET    /api/admin/verify-files/:name      # 单个（含 content）
POST   /api/admin/verify-files            # 添加 / 同名替换 { name, content, ttl_hours?=72, note? } → { file, replaced }
PATCH  /api/admin/verify-files/:name      # 延期 { ttl_hours }（从现在起重新计时；0 = 永久）
DELETE /api/admin/verify-files/:name      # 删除

GET    /<name>                            # 公开：返回文件内容（到期或不存在 404）
```

**所需等级**：Lv.1（超级管理员）——根目录文件能向任何平台证明域名归属。

- 文件名：字母 / 数字 / `.` / `_` / `-`，不能带目录、不能以点开头，扩展名限 `.txt` `.html` `.htm` `.xml` `.json`，不能和本站自带页面重名。内容 ≤ 64KB。
- `ttl_hours`：0~8760，默认 72；0 = 永久。到期后立即访问不到，每小时清理一次。
- 下发头：`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`；`.html` 也按 `text/plain` 下发（不会被当成网页执行）。
- 添加 / 替换 / 延期 / 删除写审计存证 `site.verify_file_added|replaced|extended|removed`。

### 7.13 三方登录「多主体」管理（v3.4.15）

一个渠道（如微信）可挂多套登录凭证，适配多组织 / 多架构。模型为**两级**：

- **主体（subject）= 组织**。一个主体下可挂多套登录凭证（跨公司甚至跨平台）。
- **凭证（provider）**：某平台的一套 AppID/Secret/回调，隶属于一个主体。`user_oauth.provider` 记为 `平台名:凭证id`。
- **同人识别合并（「互通」）**：同一主体下不同凭证登录进来的用户，按 **unionid → 邮箱** 在该主体所有凭证范围内认作同一账号；**不同主体之间数据隔离，绝不合并**。
- 环境变量里配的默认凭证（`provider=平台名`）是各自独立的单租户主体，保持原有全局邮箱合并。

```
GET    /api/admin/oauth-subjects        # 主体列表（含其下凭证，secret 打码）+ 平台字段元数据
POST   /api/admin/oauth-subjects        # 新建主体 { name, enabled? }
PATCH  /api/admin/oauth-subjects/:id    # 改主体 { name?, enabled?, sort_weight? }
DELETE /api/admin/oauth-subjects/:id    # 删主体（连带删其下凭证；已绑用户历史保留）

GET    /api/admin/oauth-providers       # 全部凭证平铺列表（辅助）
POST   /api/admin/oauth-providers       # 新增凭证到某主体 { subject_id, platform, label, config, enabled? }
PATCH  /api/admin/oauth-providers/:id   # 改凭证 { label?, config?, enabled?, subject_id? }（subject_id 可把凭证挪到别的主体）
DELETE /api/admin/oauth-providers/:id   # 删凭证
```

> 组织名称唯一（v3.5.53）：新建 / 改名时与已有组织同名（全角半角括号、空格、大小写视为相同）返回 `409 {code:'name_taken', existing_id}`；`POST /api/admin/folder-dir-sources/:id/create-orgs` 遇到同名部门跳过，响应 `skipped:[{dept_id,name,reason}]`，全部同名时 409。


**所需等级**：读 Lv.3，写 Lv.2。

- `config` 的键名与该平台环境变量同名（如 `WECHAT_APP_ID`/`WECHAT_APP_SECRET`/`WECHAT_REDIRECT_URI`）。
- secret 字段读取时打码为 `••••••••`；提交时打码串一律不覆盖原值（编辑时留着圆点即保留）。
- 主体停用 → 其下所有凭证的登录入口整体关闭（登录页隐藏 + 后端 `/auth/<平台>?inst=` 直连也拒绝）。

**账号合并记录 / 撤销合并**（v3.5.48）：

```
GET  /api/admin/merges[?user=<保留账号 id>]   # 合并记录（系统管理员看全部 + 本版之前的只读 legacy 项；其他人只看自己做的）
POST /api/admin/merges/:id/undo              # 撤销 { confirm:"撤销合并" }（超级管理员或做这次合并的人；期限 MERGE_UNDO_DAYS，默认 30 天）
```

撤销顺序（v3.5.50）：只有之后未撤销的合并与这次改到了同一份数据（同一行被插入 / 删除，或同一行同一列；积分、updated_at 不算）才要求先撤那一次；积分按本次增量扣回。

每条记录：`target{id,name,uid,exists}`、`sources[{id,name,uid,exists}]`、`via`/`via_label`、`actor_name`、`created_at`、`undo_until`、`can_undo`、`undo_blocker`、`undone_at`。撤销后返回 `stats{restored_rows, kept_fields, skipped}`（`kept_fields` = 合并后又被改过、保留现值的字段数）。同一批账号合并过多次要从最近一次往前撤。

**企业微信重复账号**（v3.5.50）：同步与企业微信登录都按「企业 ID + UserId（不区分大小写）」认人——跨该企业的所有同步源（组织自己的、文件夹共用的）和所有企业微信登录凭证（本站默认、组织、文件夹）。以前遗留的重复账号：

```
GET  /api/admin/dir-duplicates          # Lv.3：[{ key, corp_id, ext_id, suggested, users:[{id,uid,name,email,phone,admin,has_pw,kyc,orgs}] }]
POST /api/admin/dir-duplicates/merge    # Lv.1：{ groups:[{key, target?}] | all:true, confirm:"合并账号" } → { done, failed, results[] }
```

合并走账号合并（`via: "dir_duplicate"`），可在期限内撤销；同步结果 `state.duplicates` 是本次遇到的遗留重复人数。

**注销 / 删除的交接项**（v3.5.49）：交接清单由系统核验，不能手动勾选（只有 `check:"app"` 的重要应用项由管理员 `POST /api/admin/deletions/:id/checklist {key, done}` 确认）。每项带 `check`（ext / bind / orgadmin / groupadmin / device / app）、`done`、`note`。

```
POST /api/admin/deletions/:id/item     { key, action }   # recheck / disable / remove_member（企业微信成员）、remove_role、release_device
POST /api/user/account/deletion/item   { key, action:"recheck" }   # 本人只能重新核验
```

执行删除时，账号的三方登录绑定与通讯录映射被摘除并封存（保留期内不能用来登录、同步不认回），`GET /api/admin/users/:id/deletion` 的 `blocked[]` 列出被封存的外部账号；恢复时放回，彻底清除时一并删除。

**注销与删除批量操作**（v3.5.48）：`POST /api/admin/deletions/bulk { action, ids[], confirm }`，`action` = `purge`（彻底清除，仅超级管理员，confirm「彻底清除」）/ `approve`（confirm「批准删除」）/ `restore`（confirm「恢复账号」）/ `reject` / `cancel`；逐条按单条接口的权限判断，返回 `{ done, failed, results:[{id,name,ok,error}] }`。

**组织文件夹**（v3.5.38）：管理端把组织归类用，一级、不嵌套，一个组织最多在一个文件夹；**只影响管理端展示，不影响登录与权限**。

```
GET    /api/admin/org-folders           # 文件夹列表 { folders:[{id,name,sort_weight,org_count}] }（Lv.3）
POST   /api/admin/org-folders           # 新建 { name, sort_weight? }（Lv.2，名称 ≤40 字，上限 200 个）
PATCH  /api/admin/org-folders/:id       # 重命名 / 排序 { name?, sort_weight? }（Lv.2）
DELETE /api/admin/org-folders/:id       # 删除（Lv.2）：里面的组织回到「未归类」，组织本身不受影响
```

- 组织归类走主体接口的 `folder_id`：`POST /api/admin/oauth-subjects` 与 `PATCH /api/admin/oauth-subjects/:id` 都收 `folder_id`（文件夹 id；`null`/空串 = 移出到未归类；不传 = 不改；文件夹不存在 400 且整个请求不生效）。
- `GET /api/admin/oauth-subjects` 每个组织多回 `folder_id`，响应顶层多回 `folders`（带 `org_count`；v3.5.47 起还带 `dir_connections` / `credentials` / `migrations`）。

**文件夹共用通讯录与登录凭证**（v3.5.47，系统管理员：读 Lv.3 / 写 Lv.2）：通讯录「连接」（企业 ID / Secret / 接收事件服务器）放在文件夹上只存一份，文件夹里的组织「套用」它、各自选部门。

```
GET    /api/admin/org-folders/:id/resources          # { dir_connections:[{…, uses:[{subject_id,org_name,dept_ids,…}]}], credentials, migrations }
POST   /api/admin/org-folders/:id/dir-sources        # 新建连接 { type, label, corp_id, secret, cb_token?, cb_aes_key?, push_suspend? }（同企业不能重复）
PATCH  /api/admin/folder-dir-sources/:id             # 编辑 / 只传 {enabled} 启停（有套用时不能改 corp_id；打码串不覆盖）
DELETE /api/admin/folder-dir-sources/:id             # 删除（还有组织套用时 400）
POST   /api/admin/folder-dir-sources/:id/scope-tree  # 该连接能看到的部门
POST   /api/admin/folder-dir-sources/:id/run         # 依次同步所有启用的套用 → { results:[{source_id, org_name, state|error}] }
POST   /api/admin/org-folders/:id/credentials        # 文件夹共用登录凭证 { platform, label, config, enabled }
POST   /api/admin/org-folders/:id/migrate            # 逐条交给文件夹 { kind:"dir_source"|"credential", id, confirm:"迁移" }
PUT    /api/admin/folder-credentials/:id/orgs        # v3.5.51：设定使用这套文件夹凭证的组织 { subject_ids:[] }（只能是文件夹里的组织）
POST   /api/admin/orgs/:sid/folder-credentials/:cid  # v3.5.51：组织使用 / 不再使用 { use: true|false }
POST   /api/admin/folder-dir-sources/:id/create-orgs # v3.5.51：按部门建组织 { depts:[{id,name}], run?, bind_creds? } → { created:[{org_id,name,dept_id,source_id,state|error}], bound_creds }
```

- **v3.5.51：交给文件夹 ≠ 套用。** 同步源迁移后组织不再自己同步：没有同企业连接时原同步源就地变成文件夹连接（id 不变），有则并进去、原同步源删掉（旧回调地址转到连接）；它的 UserId 映射留在连接上作为认人依据。组织要继续同步，再设定套用（组织「+ 通讯录同步」选这份，或文件夹面板「套用到组织…」）。凭证迁移后默认没有组织使用，要用再设定。
- 文件夹凭证由哪些组织「使用」决定：同步时可绑定的凭证（`bind_choices`、auto 绑定）、同人合并范围都只算设定使用它的组织。升级时已有文件夹凭证自动设定给当时在该文件夹里的组织。组织移出文件夹时随之取消。
- 按部门建组织：每个部门建一个同名组织放进文件夹，套用这份连接、只同步该部门（含子部门），同企业的文件夹企业微信凭证一并设定给新组织使用。

- 组织套用：`POST /api/admin/orgs/:sid/dir-sources` 带 `parent_id`（连接 id，须是本组织所在文件夹的；须系统管理员），其余字段同普通同步源但不收企业 ID / Secret / 回调。`GET /api/admin/orgs/:sid/dir-sources` 多回 `folder_connections`、`can_use_folder`；同步源视图多回 `parent_id` / `parent_label` / `parent_enabled`，`callback_path` 指向连接。
- 接收事件服务器：填连接的地址，一条事件会让所有启用的套用各同步一次；迁移前的组织同步源地址仍可用（自动转到连接）。
- 文件夹凭证没有所属组织：组织的登录 IP / 时段 / 强制两步验证策略不作用于它；同人合并范围是它自己 + 设定使用它的组织（v3.5.51）。
- 套用着文件夹通讯录的组织不能移出文件夹；文件夹上有通讯录 / 凭证时不能删除文件夹。

**公开接口**（登录页 / 账号绑定页用，无需鉴权，只给公开字段、绝不含 secret）：

```
GET /api/public/login-methods       # 各渠道默认凭证 + 各启用凭证；扫码渠道附 appid/redirect
```

授权入口：默认凭证 `/auth/<平台>`；额外凭证 `/auth/<平台>?inst=<凭证id>`。凭证 id 藏在服务端 `state` 里随回调透传，无需为每个凭证新增路由。

**应用内自动登录**（v3.5.42）：`login-methods` 返回 `inapp_auto`（允许自动登录的平台列表，来自 `INAPP_AUTO_LOGIN`：留空 / `all` = wecom、wechat、feishu、dingtalk 全开，`off` = 关，或逗号列表）。登录页按 UA 识别所在应用（`wxwork` → 企业微信、`MicroMessenger` → 微信、`Lark`/`Feishu` → 飞书、`DingTalk` → 钉钉），未登录且该平台配了凭证时自动跳 `/auth/<平台>`；同一平台多个凭证时弹选择，或在地址上带 `?inst=<凭证id>` 直接指定（管理端凭证行「应用内登录地址」可复制）。不自动跳的情况：带 `?error=` / `?tfa=` / `?noauto=1`、本会话已自动试过一次（退出后回登录页不会又被登进去）。企业微信授权用 `snsapi_base`（静默，不弹确认页）。
手机上（≤640px）不显示二维码，微信 / 企业微信改为点击跳转：在该应用里直接授权；在普通手机浏览器里提示「到微信 / 企业微信里打开」并可复制链接。

---

### 7.14 组织成员（IAM）与应用按组织开放（v3.4.18）

**组织 = 登录主体（oauth_subjects）**。用户可显式加入组织并获得**组织内 UID**（自定义规则/手动，仅组织内身份辨认与必要认证，
平台通用 UID `uid_code` 不受影响）。应用可**开放给指定组织**——某应用在开放列表里没有任何组织 = 全局(通用)应用；
设了组织则**仅该组织成员可见、可授权登录**。

```
GET    /api/admin/orgs                       # 组织列表（含成员数、组织内 UID 规则）
GET    /api/admin/orgs/:sid/members          # 某组织成员（含 org_uid；ext_ids = 在本组织各同步源里对应的外部账号，如企业微信 UserId）
POST   /api/admin/orgs/:sid/members/merge    # 一人多号合并（v3.5.41）{ target: 保留账号 user_id, sources: [被合并 user_id] }
POST   /api/admin/orgs/:sid/members          # 加成员 { account, org_uid?, auto_uid? }
PATCH  /api/admin/orgs/:sid/members/:uid     # 改成员的组织内 UID { org_uid }
DELETE /api/admin/orgs/:sid/members/:uid     # 移出成员
PATCH  /api/admin/orgs/:sid/uid-rule         # 组织内 UID 自动规则 { uid_prefix, uid_len }

GET    /api/admin/apps/:id/orgs              # 应用开放给哪些组织 → { subject_ids: [] }
PUT    /api/admin/apps/:id/orgs              # 全量设置 { subject_ids: [] }（空=全局）

GET    /api/user/orgs                        # 用户端：我所属的组织 + 组织内 UID（需用户 JWT）
```

**所需等级**：`/admin/*` 读 Lv.3、写 Lv.2；`/user/orgs` 需用户登录。

- `account` 支持邮箱/手机/UID/用户名（同登录识别）；`org_uid` 留空且组织设了前缀规则（或传 `auto_uid:true`）则自动生成（前缀+按组织自增补零，组内唯一）。
- 组织内 UID **组内唯一、跨组织可重复**；公共账号不能作为组织成员。
- 应用被限定到组织后，非成员访问 `/apps/market` 看不到它，`/apps/:id/auth` 与 OIDC `/oauth/consent` 返回 `403`。
- 用户端应用市场支持 `GET /api/apps/market?org=<sid>` 按当前组织过滤（全局应用 + 该组织开放的应用）。

**一人多号合并**（v3.5.41，`POST /members/merge`，需能管理该组织）：企业微信等通讯录里同一人有多个账号（多个 UserId）、又拿不到手机/邮箱时，同步会各建一个账号，用它合并成一个。
- 被合并账号的登录绑定（`user_oauth`）、同步映射、组织成员关系（保留账号已在该组织则去重，组织内 UID / 组织密码保留账号没有时接过来）、组织/分组管理员、Passkey、备忘录、门禁卡、积分（累加并记明细）、保留账号缺的邮箱/手机/实名，全部转到保留账号；被合并账号停用并记 `merged_into`，其应用授权与令牌作废，并向配了 `deprovision_url` 的应用推送 `user.merged`（带 `merged_into`）。
- 之后用任何一个外部账号登录都进保留账号，同步也不会再分开建号。
- 所有账号都必须是本组织成员；公共账号、管理员账号不能被合并，实名不同的人不能合并，已合并过的不能再合并。
- 组织管理员（非系统管理员）只能合并「只在本组织、没有平台密码 / 实名 / Passkey / 两步验证」的账号，否则 `403`。写审计 `user.merged`。
- 用户本人自助：登录后在「登录方式绑定」里绑定自己的另一个企业微信账号时，如果它挂在一个同步自动建的空壳账号上（无密码 / 联系方式 / 实名 / Passkey，只在同步来的组织里），会自动把空壳并进本人账号。

**外部通讯录同步**（把外部目录/HR 的人员批量灌进组织）：

```
POST /api/admin/orgs/:sid/import               # 管理端（写 Lv.2）
POST /api/v1/orgs/:sid/members/import          # 开放 API（scope: org:sync）
```
请求体 `{ members: [{ email?, phone?, name?, org_uid? }], remove_missing? }`：
- 按 `email`/`phone` 找用户，找不到就建号；已在组织内则更新，否则加入（`source=import`）。
- `org_uid` 传了则用（组内唯一，冲突报错），留空且组织设了规则则自动生成。
- `remove_missing:true` 时，把「本次未出现 **且** 来源为 import」的成员移出组织——**手动加入的成员不受影响**。
- 返回 `{ total, ok, removed, results:[{ email/phone, uid, org_uid, status: created|added|updated|error, error? }] }`。
- 只处理真实用户，命中公共账号会跳过并标 error。此操作会写入审计存证链（`org.members_imported`）。

---

## 八、错误码说明

| HTTP 状态码 | 说明 |
|-------------|------|
| `200` | 请求成功 |
| `400` | 请求参数错误，详见 `error` 字段 |
| `401` | 未登录或 Token 无效 / 过期 |
| `403` | 权限不足（账号停用、等级不够、scope 缺失） |
| `404` | 资源不存在 |
| `429` | 请求频率超限（生产环境限流） |
| `500` | 服务器内部错误 |

**常见错误信息**

| 错误信息 | 原因 |
|----------|------|
| `手机号格式不正确` | 非中国大陆 1 开头 11 位号码 |
| `验证码不存在或已过期` | 未发送验证码或已超时 |
| `验证码错误` | 输入有误 |
| `错误次数过多，请重新获取` | 同一验证码错误 5 次 |
| `该邮箱已注册` | 邮箱已被占用 |
| `邮箱或密码不正确` | 账号不存在或密码错误 |
| `账号已停用，请联系管理员` | 账号被管理员停用 |
| `未登录或 Token 缺失` | 请求头缺少 Authorization |
| `Token 无效` | Token 格式错误、签名不符或已过期 |
| `需要管理员权限` | 普通用户访问管理接口 |
| `API Key 无效或已撤销` | Key 不存在或已被撤销 |
| `权限不足，需要 scope: xxx` | Key 未分配所需权限 |

---

## 九、对接流程示例

### 场景一：第三方系统接入 SSO 单点登录

用户在第三方系统点击"SSO 登录"，跳转到本系统登录页，登录后携带 Token 跳回。

```
1. 第三方系统跳转 →  {BASE_URL}/login.html?redirect=https://yourapp.com/callback

2. 用户在 SSO 登录页完成登录，获得 JWT Token

3. 跳转回调（前端传递 Token）
   https://yourapp.com/callback?token=eyJhbGci...

4. 第三方系统服务端验证 Token
   GET /api/v1/auth/verify
   Authorization: Bearer sk_live_xxxxxxxx...（API Key）
   x-user-token: eyJhbGci...（用户 Token）

5. 返回用户信息，第三方系统建立自己的会话
```

**Node.js 验证示例**

```javascript
const res = await fetch('{BASE_URL}/api/v1/auth/verify', {
  method: 'GET',
  headers: {
    'Authorization': 'Bearer sk_live_xxxxxxxxxxxxxxxx...',
    'x-user-token': req.query.token,
  }
});

const { valid, user } = await res.json();

if (valid && user.status === 'active') {
  // 建立会话，user.uid_seq 作为用户唯一标识
  req.session.userId = user.uid_seq;
  req.session.userName = user.name;
} else {
  // Token 无效或用户已停用
  res.redirect('/login');
}
```

---

### 场景二：第三方系统同步用户状态

```javascript
// 获取 SSO 用户信息
const userRes = await fetch(`{BASE_URL}/api/v1/users/${uid}`, {
  headers: { 'Authorization': 'Bearer sk_live_xxxxxxxx...' }
});
const user = await userRes.json();

// 根据 kyc_verified 判断是否实名
if (!user.kyc_verified) {
  // 引导用户去 SSO 完成实名认证
}

// 根据 user_level 判断用户权限等级
if (user.user_level <= 2) {
  // 高等级用户，开放高级功能
}
```

---

### 场景三：在第三方系统中停用账号

当用户在第三方系统触发违规时，同步停用 SSO 账号：

```javascript
await fetch(`{BASE_URL}/api/v1/users/${uid}/disable`, {
  method: 'POST',
  headers: { 'Authorization': 'Bearer sk_live_xxxxxxxx...' }
});
// 停用后该用户在所有接入本 SSO 的系统均无法登录
```

---

*文档结束。如有问题请联系系统管理员，或查阅源码 `server/api.js`。*

---

## 十、「使用 QWQ SSO 登录」— OIDC 接入

这是**第三方应用让用户用 QWQ SSO 账号登录**的标准方式，和第六章的开放 API 是两回事：

| | 开放 API（第六章） | OIDC 登录（本章） |
|---|---|---|
| 凭据 | `sk_live_` API Key | `client_id` + `client_secret` |
| 用户是否参与 | 否，后台直接查库 | 是，用户看到授权页并逐项确认 |
| 拿到的数据 | 管理员授予的全部范围 | 仅用户本人勾选同意的 scope |
| 适用场景 | 内部系统批量同步 | 第三方应用登录按钮 |

QWQ SSO 实现了标准 OAuth2 授权码流程 + OpenID Connect，**可以直接用现成的 OIDC 客户端库接入**
（Node 的 `openid-client`、Python 的 `authlib`、Java 的 `Spring Security OAuth2` 等），无需照着本文档手写。

### 10.0 OAuth2 与 OIDC 两种模式都支持（看你请求的 scope）

同一套端点（`/oauth/authorize`、`/oauth/token`、`/oauth/userinfo`）**同时支持纯 OAuth2 和 OIDC**，
区别只在于你请求的 `scope` **是否包含 `openid`**：

| 你的接入方式 | scope 是否含 `openid` | `/oauth/token` 返回 | 拿用户信息 |
|---|---|---|---|
| **纯 OAuth2**（授权码模式） | 否，如 `scope=profile email` | 只有 `access_token`，**不含 `id_token`** | 拿 `access_token` 调 `/oauth/userinfo` |
| **OIDC** | 是，如 `scope=openid profile email` | `access_token` **+ `id_token`**（JWT） | 验 `id_token`，或调 `/oauth/userinfo` |

- 如果你的客户端库是「OAuth2」那一套（只认 authorization_endpoint / token_endpoint / userinfo），
  **不要带 `openid`**，按上表纯 OAuth2 用即可，系统不会强塞 `openid`、也不会返回你没申请的 id_token
- 如果你的客户端库是「OIDC」那一套（要验 id_token / 读 `.well-known`），**带上 `openid`** 就是标准 OIDC
- 两种模式 `/oauth/userinfo` 都能用，返回的字段同样受 scope 约束（见 10.2）；`sub`（用户唯一标识）恒定返回

### 10.1 发现端点

```
GET https://qwqsso.zeabur.app/.well-known/openid-configuration
```

大多数 OIDC 库只要填这一个地址就能自动发现全部端点。核心信息：

| 端点 | 地址 |
|---|---|
| authorization_endpoint | `/oauth/authorize` |
| token_endpoint | `/oauth/token` |
| userinfo_endpoint | `/oauth/userinfo` |
| revocation_endpoint | `/oauth/revoke` |

- `id_token` 签名算法为 **HS256**，密钥就是你的 `client_secret`（因此不需要 JWKS 端点）
- 支持 **PKCE**（`S256` / `plain`），强烈建议移动端和 SPA 启用
- `client_secret` 支持 `client_secret_post`（放 body）和 `client_secret_basic`（HTTP Basic）两种传法

### 10.2 权限范围（scope）

**最小化披露原则：没勾选的字段，`id_token` 和 `userinfo` 里一个都不会出现。**
用户可以在授权页取消任何非必需项，取消后不影响登录本身。

| scope | 含义 | 返回字段 | 可取消 |
|---|---|---|---|
| `openid` | 唯一标识（必需） | `sub` | 否 |
| `profile` | 基本资料 | `name`、`preferred_username`、`picture`、`uid`、`uid_code`、`level_tag`、`created_at`、`updated_at` | 是 |
| `email` | 邮箱 | `email`、`email_verified` | 是 |
| `phone` | 手机号 | `phone_number`、`phone_number_verified` | 是 |
| `kyc` | 实名状态（**敏感**） | `kyc_verified`、`kyc_name`（脱敏为「张**」）、`kyc_id_tail`、`kyc_pseudonym`（假名标识，见下） | 是 |
| `org` | 所属组织 | `group`（分组名，互斥，可能为 null）、`groups`（同值的数组形式）、`tags`（标签名数组） | 是 |

> `kyc` 在授权页会以橙色「敏感」标签突出显示。即使授权，真实姓名也只返回脱敏结果，
> 完整姓名和证件号**永不通过本接口下发**。
>
> **`kyc_pseudonym`（假名化标识）**：`HMAC-SHA256(平台密钥, 证件类型+证件号)`。同一自然人跨其名下所有账号
> **恒定一致、不可逆、不含任何身份原文**，用于「识别是否同一个人」（如限制免费额度重复注册）而无需知道他是谁。
> 仅在用户已实名且服务端配置了 `KYC_PSEUDONYM_SECRET` 时才有值。⚠️ 该密钥必须长期固定，轮换会使所有历史假名失效。
>
> `org` 返回的是**组织维度**的分组与标签（仅名称），与用户的权限等级（`level_tag`）无关，
> 也不下发内部 id。分组是互斥的（一人一个），标签可叠加（一人多个）。

**必传字段（应用可强制某些 scope）**

管理端「应用管理」可为每个应用配置 `required_scopes`（如 `profile email`）。被设为必传的 scope：

- 在授权页对用户**显示为「必需」、不可取消**，并且**即使应用没在 `scope` 参数里申请也会自动并入**
- 服务端在签发授权码时**强制并入**，保证 `id_token`/`userinfo` 一定包含这些字段，避免应用端因缺字段而映射/登录失败
- 若必传字段依赖用户没有的数据（如必传 `email` 但用户没绑邮箱），授权会被**拦下**，
  提示用户「请先在账号设定里绑定邮箱后再登录」，`/oauth/consent` 返回 `409` 且带 `missingRequired`

`openid` 天然必传，无需配置。

**字段说明**

| 字段 | 说明 |
|---|---|
| `sub` | 用户全局唯一 id（UUID），跨应用稳定不变，建议作为你系统里的外部用户主键 |
| `preferred_username` | 优先返回用户的自定义 UID（`uid_code`），无则回退昵称或序号，适合作展示用户名 |
| `uid` | 5 位补零的内部序号（如 `00042`），历史字段，始终存在 |
| `uid_code` | 用户的自定义编号（可由管理员配置生成规则），老用户可能为 `null` |
| `updated_at` | 资料最后更新时间，**秒级 Unix 时间戳**（OIDC 标准） |

`id_token` 中除上述 claim 外，还包含标准字段：`iss`、`aud`、`iat`、`exp`、`auth_time`（认证时刻，秒级）、
以及请求里带了 `nonce` 时的 `nonce`。

### 10.3 接入前提

在**管理端 → 应用管理**中创建应用，拿到 `client_id` / `client_secret`，并填写 `callback_url`：

- `callback_url` 必须与请求里的 `redirect_uri` **完全一致**（多个用英文逗号分隔）
- 不匹配时系统**不会回跳**，而是直接报错——这是防钓鱼的必要行为，不是 bug
- 应用状态必须为 `enabled`，`pending` / `disabled` 一律拒绝授权

### 10.4 完整流程

**① 把用户跳到授权页**

```
GET /oauth/authorize
  ?client_id=app_xxxx
  &redirect_uri=https://your-app.com/callback
  &response_type=code
  &scope=openid%20profile%20email
  &state=<随机串，防 CSRF，原样回传>
  &nonce=<随机串，防重放，会写进 id_token>
  &code_challenge=<PKCE，可选>
  &code_challenge_method=S256
  &prompt=consent        # 可选：强制重新确认，不加则老用户免打扰直通
```

用户未登录会先跳登录页，登录完自动跳回继续授权。用户确认后回跳：

```
https://your-app.com/callback?code=ac_xxxx&state=<原样返回>
```

用户拒绝则回跳 `?error=access_denied&state=...`。**务必校验 `state` 与你发出的一致。**

**② 用 code 换 token**（后端发起，别放前端，会泄露 client_secret）

```http
POST /oauth/token
Content-Type: application/json

{
  "grant_type":    "authorization_code",
  "code":          "ac_xxxx",
  "redirect_uri":  "https://your-app.com/callback",
  "client_id":     "app_xxxx",
  "client_secret": "cs_xxxx",
  "code_verifier": "<用了 PKCE 才需要>"
}
```

```json
{
  "access_token": "at_xxxx",
  "token_type":   "Bearer",
  "expires_in":   7200,
  "scope":        "openid profile",
  "id_token":     "eyJhbGciOiJIUzI1NiJ9..."
}
```

> ⚠️ 返回的 `scope` **可能比你申请的少**——用户取消勾选了可选项。请按实际返回值处理，
> 不要假设申请什么就一定拿到什么。

**③ 验证 id_token 或调 userinfo**

`id_token` 用 `client_secret` 以 HS256 验签，必须校验 `iss`、`aud`、`exp`、`nonce`。
或者直接调：

```http
GET /oauth/userinfo
Authorization: Bearer at_xxxx
```

**④ 登出时吊销令牌**（可选）

```http
POST /oauth/revoke      { "token": "at_xxxx" }
```

### 10.5 令牌与授权的生命周期

- 授权码：**10 分钟**过期，**只能用一次**，重复使用直接拒绝（并且会作废该用户在此应用下所有未使用的码）
- 访问令牌：**2 小时**过期
- 用户在「控制台 → 我的授权」撤销授权后，**已发出的令牌立即失效**，`userinfo` 返回 `403 insufficient_scope`
- 用户账号被停用后，令牌同样立即失效

#### 账号生命周期：自省（拉）+ 主动撤销（推）（v3.5.11）

跨域/临期身份（联邦登录）会在应用侧产生临期账号。两种方式让应用正确回收，**都不要求应用有写 SSO 的权限**：

- **令牌自省** `POST /oauth/introspect`（RFC 7662，用 `client_id`+`client_secret` 认证）：应用拿自己收到的 `access_token` 来查 → 返回 `{ active, sub, scope, exp, account_type, valid_until?, from_peer? }`。
  - `account_type`：`permanent`（真实用户）/ `federated`（联邦临期）。
  - 联邦令牌的 `active` **实时**反映伙伴是否被撤销/到期；普通令牌反映用户是否被停用/撤授权。应用轮询到 `active:false` 即停用本地账号。
- **主动撤销推送**（应用没做自省时）：在应用「账号撤销回调」（管理端应用编辑里配 `deprovision_url`）上，SSO 会在这些时刻 POST 一个签名事件：
  - `user.disabled`（用户被停用）、`authorization.revoked`（撤销授权）、`federation.revoked`（撤销联邦伙伴，含 `sub_prefix` 批量停用该伙伴全部临期账号）、`account.revoked`（管理员手动撤销）。
  - 请求头 `X-QWQ-Signature: sha256=<hex>` = 用该应用 `client_secret` 对请求体 HMAC-SHA256；应用校验签名后停用/删除对应本地账号（按 `sub` / `sub_prefix`）。
- 联邦登录的 `id_token`/`userinfo` 也带 `account_type` + `valid_until`，应用可直接据此设本地账号有效期。

### 10.6 应用启动（IdP 发起式登录 / 用户主动「打开」）

除了「第三方应用发起 → 跳到 SSO」的标准流程（SP 发起式），QWQ SSO 还支持
**用户在本系统控制台的「应用市场」里主动点开某个应用**（IdP 发起式），体验上就是「点一下直接进去」。

有两种落地方式，取决于应用是否登记了**发起地址**（管理端「应用管理」里的 `launch_url` 字段）：

| 情况 | 打开时的行为 |
|---|---|
| **填了发起地址** | 直接在新标签打开该地址（应用自己的登录入口/主页）。应用随后发起标准 OIDC，因用户已登录且已授权，授权页**免打扰直通**，无感回到应用 |
| **没填发起地址** | 由 SSO 用应用登记的 `callback_url` + 用户已授权的 scope 拼出一条 `/oauth/authorize` 链接并打开，静默签发授权码后落到应用的回调 |

前端拿跳转地址的接口（需要用户 JWT，通常由控制台页面调用，不面向第三方后端）：

```http
POST /oauth/launch
Authorization: Bearer <用户JWT>
Content-Type: application/json

{ "app_id": "<应用 id>" }        // 或 { "client_id": "cid_xxx" }
```

```json
{
  "success": true,
  "mode": "launch_url",                 // 或 "authorize"
  "url": "https://yourapp.com/login"    // 前端 window.open 打开它即可
}
```

> **给接入方的建议**：如果希望你的应用出现在 QWQ SSO 控制台里、被用户直接点开，
> 请在「应用管理」中填写**发起地址**为你应用的登录入口（该入口应能发起标准 OIDC 授权请求）。
> 若采用「没填发起地址」的回退方式，你的回调会收到一个**没有 `state` 上下文**的授权码
> （因为不是你的应用发起的），请确保回调逻辑能处理这种 IdP 发起式的到达。

### 10.7 错误码

| error | 含义 |
|---|---|
| `invalid_client` | `client_id` 不存在，或 `client_secret` 不正确 |
| `invalid_request` | `redirect_uri` 未登记、参数缺失 |
| `invalid_grant` | 授权码无效/过期/已用过，或 PKCE 校验失败，或 `redirect_uri` 与授权时不一致 |
| `unsupported_response_type` | 只支持 `response_type=code` |
| `access_denied` | 用户拒绝授权，或应用未启用 |
| `invalid_token` | 访问令牌无效或已过期 |
| `insufficient_scope` | 用户已撤销授权 |