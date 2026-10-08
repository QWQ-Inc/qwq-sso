#!/usr/bin/env node
/**
 * QWQ SSO · MDM 参考设备代理（v3.5.82）
 *
 * 跑在被纳管的设备上，定时 check-in 拉取待执行命令、执行后回报结果。
 * 零依赖（只用 Node 内置模块），macOS / Windows / Linux 通用。
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
 * ⚠️ 安全：破坏性命令（wipe 远程擦除）默认**只演练不真执行**，必须显式 --allow-wipe 才会调用真实擦除钩子。
 *          retire（退役）只是本机停止 agent + 删本地描述文件缓存，不碰系统。
 *          真正的「锁定 / 擦除 / 装描述文件」需要你按本机 OS 填进下面的 handlers（默认是安全占位）。
 */
'use strict';
const https = require('https');
const http = require('http');
const { URL } = require('url');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

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

// ── 命令执行 handlers（默认安全占位，按你的 OS 填真实动作）──
// 每个返回 { ok:boolean, result:string }
const handlers = {
  async lock(payload) {
    // 真实：macOS 可用 MDM / `pmset displaysleepnow`；Windows `rundll32 user32.dll,LockWorkStation`
    if (process.platform === 'win32') return runCmd('rundll32.exe', ['user32.dll,LockWorkStation']);
    return { ok: true, result: `(demo) locked${payload.message ? ' msg=' + payload.message : ''}${payload.pin ? ' pin=' + payload.pin : ''}` };
  },
  async unlock() { return { ok: true, result: '(demo) unlock acknowledged' }; },
  async restart() {
    // 真实：macOS/Linux `shutdown -r now`，Windows `shutdown /r /t 0`。默认不真重启，避免误操作。
    return { ok: true, result: '(demo) restart acknowledged (未真执行，取消注释启用)' };
    // if (process.platform === 'win32') return runCmd('shutdown', ['/r', '/t', '5']);
    // return runCmd('shutdown', ['-r', 'now']);
  },
  async clear_passcode() { return { ok: true, result: '(demo) passcode cleared' }; },
  async locate() {
    // 真实：取 GPS / IP 定位。这里只回报主机名 + 内网地址示意。
    const nets = os.networkInterfaces();
    const ips = Object.values(nets).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => n.address);
    return { ok: true, result: JSON.stringify({ host: os.hostname(), ips }) };
  },
  async wipe() {
    if (!ALLOW_WIPE) return { ok: true, result: '(demo) wipe 收到但未执行（需 --allow-wipe + 填入真实擦除命令）' };
    // 真实擦除极危险，请自行实现并务必确认目标设备。这里故意不写真实擦除命令。
    return { ok: false, result: 'wipe 真实执行未实现——请在 agent.js 的 handlers.wipe 里填入你的擦除流程' };
  },
  async retire() {
    // 退役：清本地描述文件缓存，停止 agent（下次不再 check-in）
    try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (_) {}
    retired = true;
    return { ok: true, result: 'retired：已停止纳管并清理本地缓存' };
  },
  async push_profile(payload) {
    // 演示：把描述文件 JSON 落到本地缓存目录。真实：macOS `profiles install -type configuration -path x.mobileconfig`
    try {
      fs.mkdirSync(PROFILE_DIR, { recursive: true });
      fs.writeFileSync(path.join(PROFILE_DIR, payload.profile_id + '.json'), JSON.stringify(payload.profile || {}, null, 2));
      return { ok: true, result: `installed profile ${payload.profile_name || payload.profile_id}` };
    } catch (e) { return { ok: false, result: '写描述文件失败：' + e.message }; }
  },
  async remove_profile(payload) {
    try { fs.rmSync(path.join(PROFILE_DIR, payload.profile_id + '.json'), { force: true }); } catch (_) {}
    return { ok: true, result: `removed profile ${payload.profile_id}` };
  },
  async custom(payload) {
    // 默认不执行任意命令（RCE 风险）。要启用请自行审慎实现白名单。
    return { ok: false, result: '自定义命令默认不执行（安全）；如需支持请在 handlers.custom 实现白名单' };
  },
};
function runCmd(cmd, cmdArgs) {
  return new Promise((resolve) => {
    execFile(cmd, cmdArgs, { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, result: (err ? ('ERR ' + err.message + ' ') : '') + (stdout || stderr || 'ok').toString().slice(0, 500) });
    });
  });
}

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

log(`启动：base=${BASE} device=${DEVICE} 轮询=${INTERVAL / 1000}s allowWipe=${ALLOW_WIPE}`);
tick();
const timer = setInterval(tick, INTERVAL);
process.on('SIGINT', () => { clearInterval(timer); log('退出。'); process.exit(0); });
