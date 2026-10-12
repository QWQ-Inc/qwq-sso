#!/usr/bin/env node
/**
 * QWQ SSO 打印代理（参考实现，v3.5.97 Phase 1）
 * 在组织内一台能访问打印机的机器上运行：定时 check-in 拉「待打印任务」→ 下载文件 → 本机系统打印 → 回报。
 * 零依赖（只用 Node 内置模块），跨平台（mac / Linux 走 CUPS `lp`；Windows 走 SumatraPDF）。
 *
 * 配置（命令行 > 环境变量 > --config 文件）：
 *   --base    https://你的域名            （SSO 地址）
 *   --device  <打印代理设备 id>            （管理端「登记打印代理」拿到）
 *   --secret  <enroll secret>             （同上，只显示一次）
 *   --interval 5                          （轮询秒数，默认 5）
 *   --sumatra "C:\\path\\SumatraPDF.exe"   （Windows 打 PDF 用，便携版即可）
 *   --soffice soffice                     （可选，Office→PDF 转换命令，装了 LibreOffice 才有）
 *
 * ⚠️ 真机打印需现场验证（本仓库无打印机）。协议契约与服务端一致。
 */
const https = require('https'); const http = require('http');
const { execFile, execFileSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');

function parseArgs() {
  const a = { interval: 5 }; const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) { const k = argv[i]; if (k.startsWith('--')) { const key = k.slice(2); const v = (argv[i+1] && !argv[i+1].startsWith('--')) ? argv[++i] : 'true'; a[key] = v; } }
  if (a.config) { try { Object.assign(a, JSON.parse(fs.readFileSync(a.config, 'utf8')), a); } catch (e) { console.error('读取 --config 失败：', e.message); } }
  return a;
}
const C = parseArgs();
const BASE   = (C.base   || process.env.QWQ_BASE   || '').replace(/\/+$/, '');
const DEVICE = C.device  || process.env.QWQ_PRINT_DEVICE || '';
const SECRET = C.secret  || process.env.QWQ_PRINT_SECRET || '';
const INTERVAL = (parseInt(C.interval) || 5) * 1000;
const SUMATRA = C.sumatra || process.env.QWQ_SUMATRA || '';
const SOFFICE = C.soffice || process.env.QWQ_SOFFICE || 'soffice';
if (!BASE || !DEVICE || !SECRET) { console.error('缺少 --base / --device / --secret'); process.exit(1); }
const TMP = path.join(os.tmpdir(), 'qwq-print'); try { fs.mkdirSync(TMP, { recursive: true }); } catch (_) {}
const isWin = process.platform === 'win32';

function post(pathname, body, raw) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + pathname); const lib = u.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(body));
    const req = lib.request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const buf = Buffer.concat(chunks);
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('HTTP ' + res.statusCode + ' ' + buf.toString().slice(0, 200)));
        resolve(raw ? buf : JSON.parse(buf.toString() || '{}')); });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}

// 列本机系统打印队列
function listQueues() {
  try {
    if (isWin) return execFileSync('powershell', ['-NoProfile', '-Command', '(Get-Printer).Name'], { encoding: 'utf8' }).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    return execFileSync('lpstat', ['-p'], { encoding: 'utf8' }).split(/\r?\n/).map(l => (l.match(/^printer (\S+)/) || [])[1]).filter(Boolean);
  } catch (_) { return []; }
}

const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 120000 }, (e, so, se) => e ? reject(new Error((se || e.message || '').toString().slice(0, 200))) : resolve(so)));

// Office → PDF（装了 LibreOffice 才行）
async function toPdf(file) {
  await run(SOFFICE, ['--headless', '--convert-to', 'pdf', '--outdir', TMP, file]);
  const pdf = path.join(TMP, path.basename(file).replace(/\.[^.]+$/, '') + '.pdf');
  if (!fs.existsSync(pdf)) throw new Error('LibreOffice 转换失败（没装 soffice?）');
  return pdf;
}

async function printFile(file, job) {
  const ext = (path.extname(file) || '').toLowerCase();
  const office = ['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.txt', '.csv', '.md'];
  let target = file;
  if (office.includes(ext) && !isWin) { /* CUPS 直接打 txt 可以,其余 Office 转 PDF */ if (!['.txt', '.csv', '.md'].includes(ext)) target = await toPdf(file); }
  if (office.includes(ext) && isWin && !['.txt'].includes(ext)) target = await toPdf(file);

  if (isWin) {
    if (!SUMATRA) throw new Error('Windows 打印需 --sumatra 指向 SumatraPDF.exe');
    // SumatraPDF：-print-to 队列名 -silent；份数/双面用 -print-settings
    const settings = [`${job.copies || 1}x`, job.duplex ? 'duplexlong' : 'simplex', job.color ? 'color' : 'monochrome'].join(',');
    await run(SUMATRA, ['-print-to', job.queue_name, '-print-settings', settings, '-silent', target]);
  } else {
    const args = ['-d', job.queue_name, '-n', String(job.copies || 1)];
    args.push('-o', 'sides=' + (job.duplex ? 'two-sided-long-edge' : 'one-sided'));
    if (job.media) args.push('-o', 'media=' + job.media);
    if (!job.color) args.push('-o', 'ColorModel=Gray');
    args.push(target);
    await run('lp', args);
  }
}

let busy = false;
async function tick() {
  if (busy) return; busy = true;
  try {
    const r = await post('/api/print/checkin', { device_id: DEVICE, secret: SECRET, queues: listQueues() });
    for (const job of (r.jobs || [])) {
      const file = path.join(TMP, job.id + guessExt(job.file_name, job.mime));
      try {
        const buf = await post('/api/print/file', { device_id: DEVICE, secret: SECRET, job_id: job.id }, true);
        fs.writeFileSync(file, buf);
        await printFile(file, job);
        await post('/api/print/result', { device_id: DEVICE, secret: SECRET, job_id: job.id, status: 'done', detail: '已送打印机' });
        console.log('[打印] 完成', job.file_name, '→', job.queue_name);
      } catch (e) {
        await post('/api/print/result', { device_id: DEVICE, secret: SECRET, job_id: job.id, status: 'failed', detail: e.message }).catch(() => {});
        console.error('[打印] 失败', job.file_name, e.message);
      } finally { try { fs.unlinkSync(file); } catch (_) {} }
    }
  } catch (e) {
    if (/HTTP 401/.test(e.message)) { console.error('凭据失效,退出'); process.exit(1); }
    console.error('[check-in]', e.message);
  } finally { busy = false; }
}
function guessExt(name, mime) {
  const e = (path.extname(name || '') || '').toLowerCase(); if (e) return e;
  if ((mime || '').includes('pdf')) return '.pdf'; if ((mime || '').includes('png')) return '.png'; if ((mime || '').includes('jpeg')) return '.jpg';
  return '.bin';
}

console.log(`QWQ 打印代理启动：${BASE}  设备 ${DEVICE}  平台 ${process.platform}  队列：${listQueues().join(', ') || '(无)'}`);
tick(); setInterval(tick, INTERVAL);
