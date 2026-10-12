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

⚠️ 真机打印需现场验证（仓库无打印机）；协议契约与服务端一致。401 → 凭据失效自动退出。
