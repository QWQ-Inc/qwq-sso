#!/usr/bin/env node
/**
 * QWQ SSO · MDM 参考设备代理（v3.5.83.1）
 *
 * 跑在被纳管的设备上，定时 check-in 拉取待执行命令、执行后回报结果。
 * 零依赖（只用 Node 内置模块），macOS / Windows / Linux 通用。
 * v3.5.83.1：锁定 / 重启 / 定位 / 装·删描述文件 已是各 OS 的真实动作（非演练）。
 *
 * 用法：
 *   1) 管理端「设备管理 → 设备行 MDM → 生成纳管 token」拿到 device_id / secret / check-in URL
 *   2) 在设备上：
 *        node agent.js --base https://qwqsso.zeabur.app --device <device_id> --secret <secret>
 *      或用环境变量：
 *        MDM_BASE=... MDM_DEVICE=... MDM_SECRET=... node agent.js
 *      或放一个 config.json（见 config.example.json）：
 *        node agent.js --config ./config.json
 *
 * ⚠️ 安全：
 *   · wipe（远程擦除）默认**只演练**；需 --allow-wipe 开 + 环境变量 MDM_WIPE_CMD 自备真实擦除命令，两者齐备才真跑。
 *     桌面系统没有干净的「用户态一条命令出厂擦除」，故不内置 rm -rf / 格式化这类命令（远程队列自动跑它=给整批机器埋雷）。
 *   · custom（自定义命令）默认不执行；需 MDM_ALLOW_CUSTOM=yes 才跑，远程 RCE 风险自担。
 *   · restart 真会重启（延迟几秒先回报）；mac/Linux 的重启/描述文件安装需足够权限（agent 以服务/管理员身份跑时）。
 *   · retire（退役）只停 agent + 删本地描述文件缓存，不碰系统。
 */
'use strict';
const https = require('https');
const http = require('http');
const { URL } = require('url');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const PLATFORM = process.platform;   // 'win32' | 'darwin' | 'linux'

// ── 配置 ─────────────────────────────────────────
function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--allow-wipe') { a.allowWipe = true; continue; }
    if (k.startsWith('--')) { a[k.slice(2)] = argv[i + 1]; i++; }
  }
  return a;
}
const args = parseArgs(process.argv);
let cfg = {};
if (args.config) { try { cfg = JSON.parse(fs.readFileSync(args.config, 'utf8')); } catch (e) { fatal('读取 config 失败：' + e.message); } }
const BASE     = (args.base   || cfg.base   || process.env.MDM_BASE   || '').replace(/\/$/, '');
const DEVICE   =  args.device || cfg.device || process.env.MDM_DEVICE || '';
const SECRET   =  args.secret || cfg.secret || process.env.MDM_SECRET || '';
const INTERVAL = Number(args.interval || cfg.interval || process.env.MDM_INTERVAL || 30) * 1000;   // 轮询间隔秒
const ALLOW_WIPE = !!(args.allowWipe || cfg.allowWipe);
const PROFILE_DIR = path.join(os.homedir(), '.qwq-mdm', 'profiles');
if (!BASE || !DEVICE || !SECRET) fatal('缺少 --base / --device / --secret（或对应环境变量 / config.json）');

function fatal(m) { console.error('[MDM agent] ' + m); process.exit(1); }
function log(...m) { console.log(new Date().toISOString(), '[MDM]', ...m); }

// ── HTTP（内置模块，POST JSON）────────────────────
function postJSON(pathname, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + pathname);
    const data = Buffer.from(JSON.stringify(body));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      timeout: 20000,
    }, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => {
        let j = {}; try { j = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, body: j });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end(data);
  });
}

// ── 设备信息（回填 os_version / model）────────────
function deviceInfo() {
  return { os_version: `${os.type()} ${os.release()}`, model: os.hostname() };
}

// ── 执行辅助 ───────────────────────────────────
// 等待型：跑一条命令、拿结果
function runCmd(cmd, cmdArgs) {
  return new Promise((resolve) => {
    execFile(cmd, cmdArgs, { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, result: (err ? ('ERR ' + err.message + ' ') : '') + (stdout || stderr || 'ok').toString().slice(0, 500) });
    });
  });
}
// 依次尝试多条命令，第一条成功即返回（Linux 桌面环境五花八门，锁屏命令各不相同）
async function runFirst(cands) {
  let last = { ok: false, result: '没有可用命令' };
  for (const [cmd, a] of cands) { last = await runCmd(cmd, a); if (last.ok) return last; }
  return last;
}
// 脱离型：后台延迟执行（重启要先让 agent 把结果回报出去，自己再倒下）
function spawnDetached(cmd, cmdArgs) {
  try { const c = spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore' }); c.unref(); return true; } catch (_) { return false; }
}

// ── 命令执行 handlers（v3.5.83.1：Windows / macOS / Linux 真实动作）──
// 每个返回 { ok:boolean, result:string }
const handlers = {
  // 锁屏：Win 锁定工作站；mac CGSession -suspend（切到登录窗=锁屏）；Linux 依次试 loginctl / 各桌面锁屏
  async lock(payload) {
    const note = `${payload.message ? ' msg=' + payload.message : ''}${payload.pin ? ' pin=' + payload.pin : ''}`;
    if (PLATFORM === 'win32') { const r = await runCmd('rundll32.exe', ['user32.dll,LockWorkStation']); r.result += note; return r; }
    if (PLATFORM === 'darwin') { const r = await runCmd('/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession', ['-suspend']); r.result += note; return r; }
    const r = await runFirst([
      ['loginctl', ['lock-session']],
      ['xdg-screensaver', ['lock']],
      ['gnome-screensaver-command', ['-l']],
      ['dm-tool', ['lock']],
      ['xflock4', []],
    ]); r.result += note; return r;
  },
  // 解锁 / 清密码：桌面系统没有安全的远程解锁等价动作，只回报已收到（真·清密码属移动设备 MDM）
  async unlock() { return { ok: true, result: '桌面系统无远程解锁等价动作，已记录' }; },
  async clear_passcode() { return { ok: true, result: '桌面系统无「清除锁屏密码」等价动作，已记录' }; },
  // 重启：延迟几秒执行，先让本轮结果回报出去。mac/Linux 的 shutdown 需足够权限（agent 以服务/管理员身份跑时才成）
  async restart() {
    if (PLATFORM === 'win32') { spawnDetached('shutdown', ['/r', '/t', '8']); return { ok: true, result: '已排程：约 8 秒后重启' }; }
    const ok = spawnDetached('sh', ['-c', 'sleep 6; shutdown -r now']);
    return { ok, result: ok ? '已排程：约 6 秒后重启（需足够权限，否则重启会失败）' : '无法排程重启' };
  },
  // 定位：回报主机名 + 内网 IPv4（无 GPS 的电脑只能到这个粒度；要公网 IP 可自行加一次出网查询）
  async locate() {
    const nets = os.networkInterfaces();
    const ips = Object.values(nets).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
    return { ok: true, result: JSON.stringify({ host: os.hostname(), ips, platform: PLATFORM }) };
  },
  // 擦除：桌面系统没有干净的「用户态一条命令出厂擦除」。双重门禁：--allow-wipe 开 + 由操作者自备擦除命令 MDM_WIPE_CMD。
  //   都满足才真跑那条命令；否则演练。故意不内置 rm -rf / 格式化这类命令——远程队列里自动跑它等于给整批机器埋雷。
  async wipe() {
    if (!ALLOW_WIPE) return { ok: true, result: '(demo) wipe 收到但未执行（需 --allow-wipe）' };
    const cmd = process.env.MDM_WIPE_CMD || '';
    if (!cmd) return { ok: false, result: 'wipe 已授权(--allow-wipe)，但没有配擦除命令：设环境变量 MDM_WIPE_CMD 为你本机/本环境的真实出厂擦除命令（如企业镜像重置工具）。桌面系统无通用安全的用户态出厂擦除，故不内置。' };
    spawnDetached(PLATFORM === 'win32' ? 'cmd' : 'sh', PLATFORM === 'win32' ? ['/c', cmd] : ['-c', cmd]);
    return { ok: true, result: '已触发自备擦除命令 MDM_WIPE_CMD（脱离执行）' };
  },
  // 退役：清本地描述文件缓存，停止 agent（下次不再 check-in）
  async retire() {
    try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (_) {}
    retired = true;
    return { ok: true, result: 'retired：已停止纳管并清理本地缓存' };
  },
  // 装描述文件：先把 JSON 落到本地缓存（持久、可查）。macOS 若带了 .mobileconfig（payload.mobileconfig 为 plist 文本），
  //   额外写出 <id>.mobileconfig 并 `profiles install`（需 root；新版 macOS 对 profiles 有限制，失败会如实回报）。
  async push_profile(payload) {
    try {
      fs.mkdirSync(PROFILE_DIR, { recursive: true });
      const base = path.join(PROFILE_DIR, String(payload.profile_id));
      fs.writeFileSync(base + '.json', JSON.stringify(payload.profile || {}, null, 2));
      let extra = '';
      if (PLATFORM === 'darwin' && payload.mobileconfig) {
        fs.writeFileSync(base + '.mobileconfig', String(payload.mobileconfig));
        const r = await runCmd('profiles', ['install', '-type', 'configuration', '-path', base + '.mobileconfig']);
        extra = r.ok ? '；已 profiles install' : '；profiles install 失败：' + r.result;
      }
      return { ok: true, result: `已安装描述文件 ${payload.profile_name || payload.profile_id}${extra}` };
    } catch (e) { return { ok: false, result: '写描述文件失败：' + e.message }; }
  },
  // 移除描述文件：删本地缓存；macOS 有对应 .mobileconfig 时尝试 `profiles remove`
  async remove_profile(payload) {
    const base = path.join(PROFILE_DIR, String(payload.profile_id));
    let extra = '';
    if (PLATFORM === 'darwin') {
      try { if (fs.existsSync(base + '.mobileconfig')) { const r = await runCmd('profiles', ['remove', '-identifier', String(payload.profile_id)]); extra = r.ok ? '；已 profiles remove' : ''; } } catch (_) {}
    }
    try { fs.rmSync(base + '.json', { force: true }); fs.rmSync(base + '.mobileconfig', { force: true }); } catch (_) {}
    return { ok: true, result: `已移除描述文件 ${payload.profile_id}${extra}` };
  },
  // 自定义命令：默认仍不执行（远程 RCE 风险）。显式设 MDM_ALLOW_CUSTOM=yes 才跑 payload.command（操作者自担风险）。
  async custom(payload) {
    if (String(process.env.MDM_ALLOW_CUSTOM || '').toLowerCase() !== 'yes') {
      return { ok: false, result: '自定义命令默认不执行（安全）；确需请设环境变量 MDM_ALLOW_CUSTOM=yes，并自行评估远程执行风险' };
    }
    const cmd = String(payload.command || '').trim();
    if (!cmd) return { ok: false, result: '自定义命令为空' };
    return runCmd(PLATFORM === 'win32' ? 'cmd' : 'sh', PLATFORM === 'win32' ? ['/c', cmd] : ['-c', cmd]);
  },
};

let retired = false;
async function tick() {
  if (retired) { log('已退役，停止。'); process.exit(0); }
  let r;
  try { r = await postJSON('/api/mdm/checkin', { device_id: DEVICE, secret: SECRET, ...deviceInfo() }); }
  catch (e) { log('check-in 网络错误：', e.message); return; }
  if (r.status === 401) return fatal('enrollment invalid —— token 不对或已重置，请重新生成并更新配置。');
  if (r.status === 403) { log('设备已停用 / 已退役，停止。'); process.exit(0); }
  if (r.status !== 200) { log('check-in 返回', r.status, JSON.stringify(r.body)); return; }
  const cmds = (r.body && r.body.commands) || [];
  if (cmds.length) log(`拉到 ${cmds.length} 条命令：`, cmds.map(c => c.type).join(', '));
  for (const c of cmds) {
    const h = handlers[c.type];
    let out;
    try { out = h ? await h(c.payload || {}) : { ok: false, result: '未知命令类型 ' + c.type }; }
    catch (e) { out = { ok: false, result: '执行异常：' + e.message }; }
    log(`命令 ${c.type} →`, out.ok ? 'acked' : 'failed', out.result);
    try { await postJSON('/api/mdm/result', { device_id: DEVICE, secret: SECRET, command_id: c.id, status: out.ok ? 'acked' : 'failed', result: out.result }); }
    catch (e) { log('回报失败：', e.message); }
    if (c.type === 'retire') break;   // 退役后本轮不再处理后续
  }
}

log(`启动：平台=${PLATFORM} base=${BASE} device=${DEVICE} 轮询=${INTERVAL / 1000}s allowWipe=${ALLOW_WIPE}`);
tick();
const timer = setInterval(tick, INTERVAL);
process.on('SIGINT', () => { clearInterval(timer); log('退出。'); process.exit(0); });
