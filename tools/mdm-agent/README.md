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

## 命令与载荷

| 命令 | payload | 默认 handler 行为 |
|---|---|---|
| lock | `{message?, pin?}` | Windows 真锁屏；其余演练 |
| unlock / clear_passcode | `{}` | 回报已处理 |
| restart | `{}` | 演练（真重启命令已注释，自行启用） |
| locate | `{}` | 回报主机名 + 内网 IP |
| wipe | `{}` | **默认只演练**，需 `--allow-wipe` + 自行填真实擦除 |
| retire | `{}` | 清本地描述文件缓存 + 停止 agent |
| push_profile | `{profile_id, profile, profile_name}` | 把描述文件 JSON 落到 `~/.qwq-mdm/profiles/` |
| remove_profile | `{profile_id}` | 删本地描述文件 |
| custom | `{command}` | **默认不执行**（RCE 风险），要支持自行加白名单 |

## 把它变成真·MDM

`agent.js` 里的 `handlers` 默认是**安全占位**。要让命令真的作用到系统，按本机 OS 替换：

- **macOS**：锁定/擦除/装描述文件走 `profiles` CLI 或真实 Apple MDM；真实 Apple MDM 协议（APNs 推送 + `.mobileconfig`）需要 Apple Pass/MDM vendor 证书，在管理端配 `MDM_APNS_*` 后由服务端推送唤醒，agent 仍可做执行端。
- **Windows**：锁屏已用 `LockWorkStation`；擦除/策略可接 `MDM Bridge WMI` 或组策略。
- **Linux**：按发行版用 `loginctl` / `systemctl` 等。

> ⚠️ 擦除是不可逆操作，agent 默认不真执行；务必在确认目标设备后再实现并加 `--allow-wipe`。

## 没有 agent 也能做什么

就算不跑 agent，命令也会进队列（管理端能看到 pending）。配了 `MDM_APNS_*` 厂商推送通道后，服务端会在下发时尝试推送唤醒设备立即 check-in；没配就纯靠 agent 轮询。
