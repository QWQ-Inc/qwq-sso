# QWQ SSO 打印代理（print-agent）

在组织内一台能访问打印机的机器上运行。它定时向 SSO check-in 拉「待打印任务」→ 下载文件 → 用本机系统打印 → 回报状态。
云端 SSO 够不到你局域网/USB 打印机，靠这个代理桥接（和 `tools/mdm-agent` 同一个套路）。

## 1. 登记代理 + 打印机（管理端）
1. 管理端「设备管理 → 打印机」→「登记打印代理」→ 选所属组织 → 拿到**代理设备 id** 和 **enroll secret**（只显示一次）+ check-in 地址。
2. 「登记打印机」→ 选所属组织、传输方式=打印代理、选刚登记的代理、填**队列名**（见下）。

## 2. 跑代理
```bash
node agent.js --base https://你的域名 --device <代理设备id> --secret <enroll secret>
```
- 启动时会打印本机可见的打印队列名，把它填到管理端的「队列名」。
- 轮询秒数 `--interval 5`。

### 各系统打印后端
- **macOS / Linux**：走 CUPS `lp`，PDF / 图片 / 文本原生可打。队列名 = `lpstat -p` 里的名字。
- **Windows**：CLI 打 PDF 需便携版 **SumatraPDF**，加 `--sumatra "C:\path\SumatraPDF.exe"`。队列名 = `Get-Printer` 里的 Name。
- **Office（docx/xlsx/pptx）**：需装 **LibreOffice**，代理会用 `soffice --headless --convert-to pdf` 先转 PDF（没装则该格式任务失败并提示）。可用 `--soffice` 指定命令。
- **Chromebook**：ChromeOS 一般不跑本代理；让它访问的打印机由局域网内一台 Linux 代理或直连 IPP（Phase 2）覆盖，Chromebook 用户用网页发打印。

## 3. config.json（可选，代替命令行）
```json
{ "base": "https://你的域名", "device": "xxxx", "secret": "xxxx", "interval": 5,
  "sumatra": "C:\\Tools\\SumatraPDF.exe", "soffice": "soffice" }
```
```bash
node agent.js --config config.json
```

## 4. 直连 IPP（无需代理，v3.5.99）

网络打印机若 **SSO 服务器网络可达**（同内网部署、或打印机有公网/VPN 可达地址），可不跑代理：

1. 管理端「登记打印机」→ 传输方式选 **直连 IPP** → 填打印机的 IPP 地址，如 `ipp://192.168.1.50:631/ipp/print`（TLS 用 `ipps://`）。
2. 用户照常「发去打印」。服务端后台 worker（每 ~15 秒）自动拉取该打印机的待打印任务，用 IPP `Print-Job` 把文档直接发给打印机，回写任务状态。
3. 需烧水印的类别同样在服务端烧好再发。

⚠️ **云端（如 Zeabur）通常够不到你局域网里的打印机** —— 这种情况仍用「打印代理」。直连 IPP 适合 SSO 与打印机在同一网络的自托管部署。IPP 不可达/报错时任务标记失败并记原因，不影响其它任务。

## 5. Chromebook 打印

ChromeOS 系统被锁定，一般**不在上面跑本代理**。Chromebook 作「客户端」即可——用户在 Chrome 里打开 SSO 的「我的设备 → 打印」发打印。打印机的到达由以下之一覆盖：

- **局域网内一台 Linux / Mac / Windows 机器跑本代理**（推荐）：Chromebook 用户发的任务由这台代理拉取并打印。最省事。
- **进阶：在 Chromebook 的 Linux 开发环境（Crostini）里跑代理**——开启「Linux 开发环境」→ 容器里装 CUPS（`sudo apt install cups` + 把打印机加进 CUPS）→ `node agent.js ...`。仅适合给自己那台打印机用。
- **直连 IPP**（见 §4）：打印机是 SSO 可达的网络打印机时，不需要 Chromebook 侧任何东西。
- 若打印机由 **Google 管理控制台**以 CUPS/IPP 下发给 Chromebook，取其 IPP 地址按 §4 直连即可。

⚠️ 真机打印需现场验证（仓库无打印机）；协议契约与服务端一致。401 → 凭据失效自动退出。
