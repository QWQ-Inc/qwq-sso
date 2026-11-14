# 插件开发指南（v3.5.135+）

管理端「插件」页（仅超级管理员）可导入一段插件代码，**热加载**后扩展 / 修改系统行为——改写 OIDC 声明、挂登录副作用、注册自定义页面 / 接口等，无需改源码、无需重启。

## ⚠️ 信任模型（务必先读）

插件 = 你**亲自编写 / 审阅**的 Node 代码，加载后在主进程内以**完整服务端权限**运行（可 `require` 任意模块、读写数据库）。这与「超管本就能改 `JWT_SECRET` / 一键 `git pull` / 导出全库密钥」同一信任级——**只装你信得过的插件**。

护栏：
- 仅超管可安装 / 启停；每个插件有独立开关。
- `register` 与每个钩子都在 `try/catch` 里——坏插件会被**自动跳过**并在管理端显示错误，不会拖垮主进程。
- 杀手锏：环境变量 `PLUGINS_ENABLED=off`（或 `0`/`false`/`no`/`disable`）+ 重启 → **全部插件禁用**。万一某插件把登录弄挂了，SSH 到服务器设它、重启即可恢复。

## 插件形态

CommonJS 单文件。存库后落盘到 `<DATA_DIR>/plugins/<id>.js` 再 `require`。

```js
module.exports = {
  name: '我的插件',
  version: '1.0.0',
  register(sso) {
    // 在这里注册钩子 / 路由
  }
};
// 也可直接导出一个函数：module.exports = function register(sso) { ... }
```

安装时会立刻执行一次 `register`（用于校验 + 取 `name`/`version`）；**`register` 里抛错 = 拒绝安装**（fail-fast）。

## `sso` 对象

| 成员 | 说明 |
|---|---|
| `sso.filter(hook, fn)` | 注册过滤器：`fn(value, ctx)` 返回**新值**（返回 `undefined` 则保留原值）。多个插件按安装顺序串联。 |
| `sso.action(hook, fn)` | 注册动作（副作用）：`fn(ctx)`，返回值忽略。 |
| `sso.route(method, path, fn)` | 注册自定义路由，对外路径为 `/ext/<本插件id>/<path>`，`fn(req, res, next)` 是标准 Express 处理器。 |
| `sso.config` | 本插件的配置对象（管理端「编辑 → 配置 JSON」里填，热更新）。 |
| `sso.db` | 数据库实例（better-sqlite3，`.prepare(sql).get/all/run(...)`）。 |
| `sso.audit(type, detail)` | 写一条防篡改审计存证，事件名 `plugin.<type>`。 |
| `sso.log(...args)` | 带 `[plugin:<id>]` 前缀的 console 日志。 |
| `sso.env(key)` | 读环境变量。 |

## 可用钩子

### 过滤器（filter）

| 钩子 | 签名 | 作用 |
|---|---|---|
| `oidc.claims` | `(claims, {user, scope}) => claims` | 改写 OIDC `id_token` / `userinfo` 的声明。`scope` 是已授权的 scope 数组。 |
| `login.token` | `(payload, {user, method}) => payload` | 改写登录成功后签发的 SSO 令牌负载（加自定义声明）。⚠️ 必须返回对象。 |

### 动作（action）

| 钩子 | 签名 | 作用 |
|---|---|---|
| `login.success` | `({user, method, ip, req}) => void` | 用户**密码 / 验证码**登录成功时触发（第三方 OAuth 登录走另一条路，暂不触发此钩子）。 |

### 自定义路由

`sso.route('get', '/land', handler)` → 对外 `GET /ext/<插件id>/land`。可用来做自定义跳转页、回调、webhook 等。
⚠️ 若开启了「访问前缀门」（v3.5.134），`/ext/*` 默认也在门禁内（需带门票 cookie 才可达）——对外公开的插件路由要么关掉门禁，要么把 `/ext/` 加进 `gate.EXEMPT`。

## 示例

```js
module.exports = {
  name: '部门声明 + 欢迎页',
  version: '1.0.0',
  register(sso) {
    // 1) 给每个 OIDC 登录加一个部门字段（值来自配置）
    sso.filter('oidc.claims', (claims) => {
      claims.dept = sso.config.dept || 'default';
      return claims;
    });

    // 2) 登录成功写审计
    sso.action('login.success', (ctx) => {
      sso.audit('login_seen', { uid: ctx.user.id, method: ctx.method });
    });

    // 3) 自定义跳转页：GET /ext/<本插件id>/welcome
    sso.route('get', '/welcome', (req, res) => {
      res.type('html').send('<h1>欢迎</h1><p>dept=' + (sso.config.dept || '') + '</p>');
    });
  }
};
```

配置填 `{"dept":"研发"}` 即可让上面的插件把部门设成「研发」。

## 热加载 / 失效

安装、改源码、改配置、启停都会**立即重新加载全部启用插件**并重建注册表，无需重启。路由 `/ext/*` 也即时生效。

## 排错

- 管理端插件卡片上显示错误（加载期 `register` 抛错 → 状态「已启用·出错」、active=false、其它插件不受影响）。
- `PLUGINS_ENABLED=off` + 重启 → 全禁用（终极恢复手段）。
