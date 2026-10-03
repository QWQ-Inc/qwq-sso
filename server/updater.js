// 系统版本更新（v3.5.6）
// ① 检查：对比本地 package.json 版本与 GitHub 最新 tag（带缓存，避免频繁打 GitHub）。
// ② 自托管一键拉取：git pull + npm ci（默认关，env SELFHOST_UPDATE=on 才开；超管触发；先备份 data/sso.db）。
//    ⚠️ 线上 Zeabur 靠 git push 自动部署，容器只读/重启，不适用一键拉取——该功能仅自托管直跑场景。
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const REPO = 'QWQ-Inc/qwq-sso';
const CACHE_MS = 60 * 60 * 1000; // 1 小时
let _cache = null; // { at, latest, url, error }

function currentVersion() {
  try { return require('../package.json').version || '0.0.0'; } catch (_) { return '0.0.0'; }
}

// 语义化比较，支持 4 段（如 3.4.44.1）。a>b→1, a<b→-1, 相等→0
function semverCmp(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

async function fetchLatestTag() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/tags?per_page=50`, {
    headers: { 'User-Agent': 'QWQ-SSO-Updater', 'Accept': 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error('GitHub 返回 ' + res.status);
  const tags = await res.json();
  if (!Array.isArray(tags) || !tags.length) throw new Error('无 tag');
  // 只取形如 vX.Y.Z[.W] 的 tag，按语义化取最大
  const valid = tags.map(t => t.name).filter(n => /^v?\d+\.\d+\.\d+/.test(n));
  if (!valid.length) throw new Error('无有效版本 tag');
  valid.sort((a, b) => semverCmp(b, a));
  return valid[0];
}

// 返回 { current, latest, hasUpdate, url, checked_at, error? }；force 跳过缓存
async function checkUpdate({ force = false } = {}) {
  const current = currentVersion();
  const now = Date.now();
  if (!force && _cache && (now - _cache.at) < CACHE_MS) {
    return { current, latest: _cache.latest, url: _cache.url,
      hasUpdate: _cache.latest ? semverCmp(_cache.latest, current) > 0 : false,
      checked_at: new Date(_cache.at).toISOString(), cached: true, error: _cache.error || undefined };
  }
  try {
    const latest = await fetchLatestTag();
    _cache = { at: now, latest, url: `https://github.com/${REPO}/releases/tag/${latest}`, error: null };
    return { current, latest, url: _cache.url, hasUpdate: semverCmp(latest, current) > 0, checked_at: new Date(now).toISOString() };
  } catch (e) {
    _cache = { at: now, latest: null, url: `https://github.com/${REPO}`, error: e.message };
    return { current, latest: null, url: _cache.url, hasUpdate: false, checked_at: new Date(now).toISOString(), error: e.message };
  }
}

function selfhostEnabled() {
  return /^(on|1|true|yes|开|开启|启用|是)$/i.test(String(process.env.SELFHOST_UPDATE || '').trim());
}
function restartAfterUpdate() {
  return /^(on|1|true|yes)$/i.test(String(process.env.SELFHOST_UPDATE_RESTART || '').trim());
}

function runCmd(cmd) {
  return new Promise(resolve => {
    exec(cmd, { cwd: process.cwd(), timeout: 5 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ cmd, code: err ? (err.code || 1) : 0, out: ((stdout || '') + (stderr || '')).slice(-4000) });
    });
  });
}

// 自托管一键更新：先备份数据库，再 git pull + npm ci。返回每步日志。
async function applyUpdate() {
  if (!selfhostEnabled()) return { ok: false, error: '未开启自托管更新（请设 SELFHOST_UPDATE=on，且仅适用于自托管直跑环境）' };
  const steps = [];
  // 备份 data/sso.db
  try {
    const dbPath = path.join(process.cwd(), 'data', 'sso.db');
    if (fs.existsSync(dbPath)) {
      const bak = dbPath + '.bak.' + Date.now();
      fs.copyFileSync(dbPath, bak);
      steps.push({ cmd: 'backup db', code: 0, out: '已备份到 ' + path.basename(bak) });
    } else {
      steps.push({ cmd: 'backup db', code: 0, out: '未找到 data/sso.db，跳过备份' });
    }
  } catch (e) { steps.push({ cmd: 'backup db', code: 1, out: '备份失败：' + e.message }); }

  steps.push(await runCmd('git pull --ff-only'));
  if (steps[steps.length - 1].code === 0) steps.push(await runCmd('npm ci --omit=dev'));

  const ok = steps.every(s => s.code === 0);
  const willRestart = ok && restartAfterUpdate();
  if (willRestart) setTimeout(() => process.exit(0), 1500); // 由进程守护（pm2/systemd/nodemon）拉起
  return { ok, steps, restart: willRestart, note: willRestart ? '更新成功，服务即将重启生效' : (ok ? '更新成功，请手动重启服务生效' : '更新未全部成功，请查看日志') };
}

module.exports = { currentVersion, semverCmp, checkUpdate, applyUpdate, selfhostEnabled };
