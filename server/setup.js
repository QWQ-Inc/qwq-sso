/**
 * 安装向导路由
 * 仅在 SETUP_DONE != '1' 时可访问
 * 完成后写入 SETUP_DONE=1，此后所有 /setup 请求跳回首页
 */
const express  = require('express');
const bcrypt   = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path     = require('path');
const { db, nextUidSeq, users, env, isSetupDone } = require('./db');

const router = express.Router();

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
