# QWQ SSO · MDM 参考设备代理

拉取式纳管：设备上跑这个 agent，定时 check-in 拉命令、执行、回报。零依赖（Node 内置模块），macOS / Windows / Linux 通用。

## 三步纳管一台设备

1. **生成 token**：管理端 → 设备管理 → 找到该设备（Apple/Google/Microsoft 类型）→ 点行上「MDM」→「生成纳管 token」。
   会显示一次性的 `device_id` / `secret` / check-in URL（secret 只显示这一次，复制好）。

2. **把设备放到这台机器上跑 agent**（设备本身就是这台机器）：
   ```bash
   node agent.js --base https://你的域名 --device <device_id> --secret <secret>
   ```
   或复制 `config.example.json` 为 `config.json` 填好，然后 `node agent.js --config ./config.json`。
   也支持环境变量 `MDM_BASE` / `MDM_DEVICE` / `MDM_SECRET` / `MDM_INTERVAL`。

3. **下发命令**：回管理端 MDM 面板点「锁定 / 推送描述文件 / 重启…」。agent 下次 check-in（默认 30s）就拉到并执行、回报，面板里能看到「已执行」和设备状态（已纳管 / 已锁 / 已装描述文件）。

## 命令与载荷（v3.5.83.1：锁定/重启/定位/描述文件已是真实动作）

| 命令 | payload | 各 OS 真实行为 |
|---|---|---|
| lock | `{message?, pin?}` | Win `LockWorkStation` 锁屏 / mac `CGSession -suspend` 切登录窗锁屏 / Linux 依次试 `loginctl lock-session`、`xdg-screensaver`、`gnome-screensaver-command`、`dm-tool`、`xflock4` |
| unlock / clear_passcode | `{}` | 桌面系统无安全的远程解锁/清密码等价动作，回报已记录（真·清密码属移动设备 MDM） |
| restart | `{}` | **真重启**：延迟几秒（先回报再倒下）。Win `shutdown /r /t 8`；mac/Linux `shutdown -r now`（需足够权限） |
| locate | `{}` | 回报主机名 + 内网 IPv4 + 平台 |
| wipe | `{}` | 默认演练；**需 `--allow-wipe` + 环境变量 `MDM_WIPE_CMD`**（你自备的真实出厂擦除命令）两者齐备才真跑 |
| retire | `{}` | 清本地描述文件缓存 + 停止 agent（不碰系统） |
| push_profile | `{profile_id, profile, profile_name, mobileconfig?}` | 把描述文件 JSON 落到 `~/.qwq-mdm/profiles/`；macOS 带 `mobileconfig`(plist 文本) 时额外写 `.mobileconfig` 并 `profiles install`（需 root） |
| remove_profile | `{profile_id}` | 删本地描述文件；macOS 有对应 `.mobileconfig` 时尝试 `profiles remove` |
| custom | `{command}` | 默认不执行（远程 RCE 风险）；**需 `MDM_ALLOW_CUSTOM=yes`** 才跑 `payload.command`，风险自担 |

## 安全门禁（务必理解）

- **wipe（擦除）**：桌面系统没有干净的「用户态一条命令出厂擦除」，所以 agent **不内置** `rm -rf` / 格式化这类命令（远程队列里自动跑它 = 给整批机器埋雷）。要真擦除：开 `--allow-wipe` 且设环境变量 `MDM_WIPE_CMD` 为你本机/本环境的真实出厂重置命令（如企业镜像/重置工具），两者齐备 agent 才会脱离执行它。服务端下发 wipe 本身还要求管理员输入强确认口令「擦除设备」——共三道门。
- **custom（自定义命令）**：默认拒绝；确需远程执行任意命令时设 `MDM_ALLOW_CUSTOM=yes`。
- **restart 真会重启**；mac/Linux 的重启、`profiles install` 需 agent 以**服务 / 管理员权限**运行，否则会失败并如实回报。

## 想更进一步

- **macOS 真·配置下发**：把管理端的描述文件做成 `.mobileconfig`（plist），在 payload 里带 `mobileconfig` 字段，agent 会 `profiles install`。更完整的 macOS 管理（锁定/擦除的强制力）仍建议走真实 Apple MDM。
- **iPhone / iPad**：不走本 agent，需 Apple MDM 协议（APNs 推送 + 纳管描述文件），服务端配 `MDM_APNS_*`、你去 Apple 申请 MDM 推送证书。
- **Chromebook / Android**：走各自的 Google 管理平面（Chrome Management API / Android Management API），不是本 agent。

## 没有 agent 也能做什么

就算不跑 agent，命令也会进队列（管理端能看到 pending）。配了 `MDM_APNS_*` 厂商推送通道后，服务端会在下发时尝试推送唤醒设备立即 check-in；没配就纯靠 agent 轮询。
