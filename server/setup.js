/**
 * 安装向导路由
 * 仅在 SETUP_DONE != '1' 时可访问
 * 完成后写入 SETUP_DONE=1，此后所有 /setup 请求跳回首页
 */
const express  = require('express');
const bcrypt   = require('bcryptjs');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');
const path     = require('path');
const { db, nextUidSeq, users, env, isSetupDone, DATA_DIR, DB_FILE } = require('./db');
const backup   = require('./backup');

const router = express.Router();

// ── 安装向导：从备份恢复（仅未安装时可用；装好后一律 403）──
// 全新部署数据丢失后，可直接在安装页上传导出文件、或填存储桶凭证从云端拉一份恢复，省去手动替换库。
const setupStages = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of setupStages) if (now - v.at > 10 * 60 * 1000) { try { fs.unlinkSync(v.file); } catch (_) {} setupStages.delete(k); } }, 5 * 60 * 1000).unref();
function bucketCfg(type, c = {}) {
  if (type === 'local') return { dir: String(c.dir || '').trim() };
  if (type === 'r2') return { account_id: String(c.account_id || '').trim(), bucket: String(c.bucket || '').trim(), access_key_id: String(c.access_key_id || '').trim(), secret_access_key: String(c.secret_access_key || '').trim(), prefix: String(c.prefix || '').trim(), endpoint: String(c.endpoint || '').trim() };
  if (type === 'oss') return { region: String(c.region || '').trim(), endpoint: String(c.endpoint || '').trim(), bucket: String(c.bucket || '').trim(), access_key_id: String(c.access_key_id || '').trim(), access_key_secret: String(c.access_key_secret || '').trim(), prefix: String(c.prefix || '').trim() };
  return null;
}
// 上传导出文件 → 校验暂存
router.post('/restore/stage', express.raw({ type: () => true, limit: 512 * 1024 * 1024 }), (req, res) => {
  if (isSetupDone()) return res.status(403).json({ error: '系统已安装，请到管理端恢复' });
  try {
    const buf = req.body;
    if (!buf || !buf.length) return res.status(400).json({ error: '没有收到文件' });
    let pass = ''; try { const h = req.get('X-Backup-Pass'); if (h) pass = Buffer.from(h, 'base64').toString('utf8'); } catch (_) {}
    const dbBuf = backup.decodeBackup(Buffer.isBuffer(buf) ? buf : Buffer.from(buf), pass);
    const info = backup.inspectDbBuffer(dbBuf, DATA_DIR);
    const token = uuidv4();
    const staged = path.join(DATA_DIR, `.restore-stage-${token}.db`);
    fs.writeFileSync(staged, dbBuf, { mode: 0o600 });
    setupStages.set(token, { file: staged, at: Date.now(), info });
    res.json({ success: true, token, info });
  } catch (e) { res.status(400).json({ error: e.message, need_pass: !!e.needPass }); }
});
router.post('/restore/apply', (req, res) => {
  if (isSetupDone()) return res.status(403).json({ error: '系统已安装' });
  const { token, confirm } = req.body || {};
  if (confirm !== '恢复全站数据') return res.status(400).json({ error: '请输入「恢复全站数据」确认', confirm_text: '恢复全站数据' });
  const st = setupStages.get(token);
  if (!st || !fs.existsSync(st.file)) return res.status(404).json({ error: '暂存文件已失效，请重新上传' });
  try {
    backup.stageRestore(DB_FILE, fs.readFileSync(st.file));
    setupStages.delete(token); try { fs.unlinkSync(st.file); } catch (_) {}
    res.json({ success: true, restart: true, message: '已载入恢复数据，系统将重启。请稍候十几秒后刷新访问登录页。' });
    setTimeout(() => process.exit(0), 800);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 从存储桶列出 / 恢复（内联填桶凭证，用于全新部署）
router.post('/restore/bucket-list', async (req, res) => {
  if (isSetupDone()) return res.status(403).json({ error: '系统已安装' });
  const cfg = bucketCfg(req.body?.type, req.body?.config);
  if (!cfg) return res.status(400).json({ error: '存储类型只能是 local / r2 / oss' });
  try { res.json({ success: true, files: await backup.list({ type: req.body.type }, cfg, DATA_DIR) }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
router.post('/restore/from-bucket', async (req, res) => {
  if (isSetupDone()) return res.status(403).json({ error: '系统已安装' });
  const { type, config, name, passphrase, confirm } = req.body || {};
  if (confirm !== '恢复全站数据') return res.status(400).json({ error: '请输入「恢复全站数据」确认', confirm_text: '恢复全站数据' });
  const cfg = bucketCfg(type, config);
  if (!cfg) return res.status(400).json({ error: '存储类型只能是 local / r2 / oss' });
  if (!backup.FILE_RE.test(String(name || ''))) return res.status(400).json({ error: '文件名不对' });
  try {
    const raw = await backup.read({ type }, cfg, DATA_DIR, name);
    const dbBuf = backup.decodeBackup(Buffer.isBuffer(raw) ? raw : Buffer.from(raw), String(passphrase || ''));
    backup.inspectDbBuffer(dbBuf, DATA_DIR);
    backup.stageRestore(DB_FILE, dbBuf);
    res.json({ success: true, restart: true, message: '已从存储桶载入恢复数据，系统将重启。' });
    setTimeout(() => process.exit(0), 800);
  } catch (e) { res.status(e.needPass ? 400 : 500).json({ error: e.message, need_pass: !!e.needPass }); }
});

// ── GET /setup → 送出向导页面 ──
router.get('/', (req, res) => {
  if (isSetupDone()) return res.redirect('/');
  res.sendFile(path.join(__dirname, '../public/setup.html'));
});

// ── POST /setup/check-email → 检查邮箱是否已存在 ──
router.post('/check-email', (req, res) => {
  if (isSetupDone()) return res.status(403).json({ error: '已完成安装' });
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: '邮箱不能为空' });
  const exists = !!users.findByEmail.get(email);
  res.json({ exists });
});

// ── POST /setup/complete → 提交向导，完成安装 ──
router.post('/complete', async (req, res) => {
  if (isSetupDone()) return res.status(403).json({ error: '系统已完成安装，无法重复执行' });

  const {
    // Step 1: 管理员账号
    admin_name, admin_email, admin_password,
    // Step 2: 站点基本配置
    site_name, base_url, node_env,
    // Step 3: 功能开关
    features,          // { sms, email, wechat, kyc, shop, api, ... }
    // Step 4: 可选：消息分发中心（QWQ Message）快速配置
    qwq_message_url, qwq_message_key, qwq_message_sms_group, qwq_message_email_group,
  } = req.body;

  // 基础校验
  if (!admin_email || !admin_password || !base_url) {
    return res.status(400).json({ error: '管理员邮箱、密码、站点地址为必填项' });
  }
  if (admin_password.length < 8) {
    return res.status(400).json({ error: '管理员密码至少 8 位' });
  }
  const emailReg = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailReg.test(admin_email)) {
    return res.status(400).json({ error: '邮箱格式不正确' });
  }

  try {
    // ── 1. 创建超级管理员账号 ──
    const existing = users.findByEmail.get(admin_email);
    if (!existing) {
      const hash = await bcrypt.hash(admin_password, 12);
      users.create({
        name:          admin_name || admin_email.split('@')[0],
        email:         admin_email,
        password_hash: hash,
        role:          'admin',
        admin_level:   1,
        user_level:    1,
      });
    } else if (existing.role !== 'admin') {
      // 已有该邮箱的普通账号，升级为超管
      db.prepare("UPDATE users SET role='admin',admin_level=1,updated_at=datetime('now') WHERE id=?").run(existing.id);
    }

    // ── 2. 写入基础环境变量 ──
    const baseVars = {
      BASE_URL:   base_url.replace(/\/$/, ''),
      NODE_ENV:   node_env || 'production',
      SITE_NAME:  site_name || '统一登录系统',
    };
    Object.entries(baseVars).forEach(([k, v]) => env.set.run(k, v));

    // ── 3. 写入功能开关 ──
    const feat = features || {};
    const featureVars = {
      FEATURE_SMS:     feat.sms     ? '1' : '0',
      FEATURE_EMAIL:   feat.email   ? '1' : '0',
      FEATURE_WECHAT:  feat.wechat  ? '1' : '0',
      FEATURE_WECOM:   feat.wecom   ? '1' : '0',
      FEATURE_FEISHU:  feat.feishu  ? '1' : '0',
      FEATURE_DINGTALK:feat.dingtalk? '1' : '0',
      FEATURE_DOUYIN:  feat.douyin  ? '1' : '0',
      FEATURE_KUAISHOU:feat.kuaishou? '1' : '0',
      FEATURE_XHS:     feat.xhs     ? '1' : '0',
      FEATURE_BILIBILI:feat.bilibili? '1' : '0',
      FEATURE_GOOGLE:  feat.google  ? '1' : '0',
      FEATURE_APPLE:   feat.apple   ? '1' : '0',
      FEATURE_KYC:     feat.kyc     ? '1' : '0',
      FEATURE_SHOP:    feat.shop    ? '1' : '0',
      FEATURE_API:     feat.api     ? '1' : '0',
    };
    Object.entries(featureVars).forEach(([k, v]) => env.set.run(k, v));

    // ── 4. 可选：快速配置消息分发中心 ──
    // v3.3.3 起短信和邮件都走 QWQ Message，安装向导不再收集 SMTP / 短信服务商配置，
    // 装完在「系统配置 → 消息分发（QWQ Message）」里填即可。
    if ((feat.email || feat.sms) && qwq_message_url) {
      const msgVars = {
        QWQ_MESSAGE_URL:         qwq_message_url,
        QWQ_MESSAGE_KEY:         qwq_message_key         || '',
        QWQ_MESSAGE_SMS_GROUP:   qwq_message_sms_group   || '',
        QWQ_MESSAGE_EMAIL_GROUP: qwq_message_email_group || '',
      };
      Object.entries(msgVars).forEach(([k, v]) => v && env.set.run(k, v));
    }

    // ── 5. 锁定安装 ──
    env.set.run('SETUP_DONE', '1');
    env.set.run('SETUP_AT', new Date().toISOString());
    env.set.run('SETUP_BY', admin_email);

    res.json({ success: true, message: '安装完成，即将跳转登录页面' });

  } catch (err) {
    console.error('[Setup Error]', err);
    res.status(500).json({ error: '安装失败：' + err.message });
  }
});

// ── POST /setup/reset → 仅开发环境可重置（方便调试）──
router.post('/reset', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: '生产环境不允许重置安装状态' });
  }
  env.set.run('SETUP_DONE', '0');
  res.json({ success: true, message: '安装状态已重置，请刷新页面' });
});

module.exports = router;
