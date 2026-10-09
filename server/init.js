/**
 * 初始化脚本 - 创建管理员账户
 * 运行：node server/init.js
 */
require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { db, nextUidSeq, users, apps } = require('./db');

console.log('🔧 初始化数据库...');

// ──────────────────────────────────────────
// 创建超级管理员
// ──────────────────────────────────────────
// 凭据一律走环境变量，不要写死在源码里（本仓库是公开仓库）。
// 未配置密码时随机生成一个，只在创建那一刻打印一次。
const ADMIN_EMAIL    = process.env.INIT_ADMIN_EMAIL || 'admin@example.com';
const ADMIN_NAME     = process.env.INIT_ADMIN_NAME  || 'admin';
const ADMIN_PASSWORD = process.env.INIT_ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');
const PASSWORD_GENERATED = !process.env.INIT_ADMIN_PASSWORD;

const existing = users.findByEmail.get(ADMIN_EMAIL);
if (existing) {
  console.log(`✓ 管理员账户已存在：${ADMIN_EMAIL}`);
} else {
  const hash = bcrypt.hashSync(ADMIN_PASSWORD, 12);
  users.create({
    name:          ADMIN_NAME,
    email:         ADMIN_EMAIL,
    password_hash: hash,
    role:          'admin',
    admin_level:   1,
    user_level:    1,
  });
  console.log(`✓ 超级管理员创建成功`);
  console.log(`  账号：${ADMIN_EMAIL}`);
  console.log(`  密码：${ADMIN_PASSWORD}`);
  if (PASSWORD_GENERATED) {
    console.log(`  ⚠️ 上面这串是随机生成的密码，只显示这一次，请立刻保存并登录后修改`);
    console.log(`     （想自己指定请设置环境变量 INIT_ADMIN_PASSWORD 后重新运行）`);
  }
  console.log(`  角色：超级管理员 (admin Lv.1)`);
}

// ──────────────────────────────────────────
// 预置环境变量键（空值，待填写）
// ──────────────────────────────────────────
const { env } = require('./db');
const ENV_KEYS = [
  'WECHAT_APP_ID','WECHAT_APP_SECRET','WECHAT_REDIRECT_URI',
  'WECOM_CORP_ID','WECOM_AGENT_ID','WECOM_APP_SECRET','WECOM_REDIRECT_URI',
  'FEISHU_APP_ID','FEISHU_APP_SECRET','FEISHU_REDIRECT_URI',
  'DINGTALK_CLIENT_ID','DINGTALK_CLIENT_SECRET','DINGTALK_REDIRECT_URI',
  'DOUYIN_CLIENT_KEY','DOUYIN_CLIENT_SECRET','DOUYIN_REDIRECT_URI',
  'KUAISHOU_APP_ID','KUAISHOU_APP_SECRET','KUAISHOU_REDIRECT_URI',
  'XHS_APP_ID','XHS_APP_SECRET','XHS_REDIRECT_URI',
  'BILIBILI_CLIENT_ID','BILIBILI_CLIENT_SECRET','BILIBILI_REDIRECT_URI',
  'GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REDIRECT_URI',
  'APPLE_CLIENT_ID','APPLE_TEAM_ID','APPLE_KEY_ID','APPLE_PRIVATE_KEY','APPLE_REDIRECT_URI',
  'GITHUB_CLIENT_ID','GITHUB_CLIENT_SECRET',
  'MICROSOFT_CLIENT_ID','MICROSOFT_CLIENT_SECRET','MICROSOFT_TENANT',
  'QQ_APP_ID','QQ_APP_SECRET',
  // 短信/邮件统一走 QWQ Message 分发中心（v3.3.3 起），服务商凭据配在分发中心那边
  'QWQ_MESSAGE_URL','QWQ_MESSAGE_KEY','QWQ_MESSAGE_SMS_GROUP','QWQ_MESSAGE_EMAIL_GROUP',
  'QWQ_MESSAGE_SMS_HUB_TEMPLATE','QWQ_MESSAGE_SMS_TEMPLATE','QWQ_MESSAGE_SMS_VAR',
  'QWQ_MESSAGE_NOTIFY_GROUP','QWQ_MESSAGE_NOTIFY_EVENTS',
  'SMS_CODE_EXPIRE','DEFAULT_PHONE_CC',
  // ⚠️ 下面两组是「阿里云/火山引擎的通用凭据」，KYC 实名认证仍在用，别当成短信配置删掉
  'VOLCENGINE_ACCESS_KEY_ID','VOLCENGINE_ACCESS_KEY_SECRET',
  'ALIYUN_ACCESS_KEY_ID','ALIYUN_ACCESS_KEY_SECRET',
  'ALIYUN_KYC_ACCESS_KEY_ID','ALIYUN_KYC_ACCESS_KEY_SECRET','ALIYUN_KYC_SCENE_ID','ALIYUN_KYC_MODE','ALIYUN_KYC_CALLBACK_URL',
  'VOLC_KYC_ACCESS_KEY_ID','VOLC_KYC_ACCESS_KEY_SECRET','VOLC_KYC_APP_ID','VOLC_KYC_MODE','VOLC_KYC_CALLBACK_URL',
  'TENCENT_KYC_SECRET_ID','TENCENT_KYC_SECRET_KEY','TENCENT_KYC_REGION','TENCENT_KYC_RULE_ID','TENCENT_KYC_CALLBACK_URL',
  'KYC_PROVIDER','KYC_ENABLED','KYC_ALLOW_DELETE','KYC_MAX_ACCOUNTS','KYC_PSEUDONYM_SECRET',
  'DIDIT_API_KEY','DIDIT_WORKFLOW_ID','DIDIT_WEBHOOK_SECRET',
  'ALIPAY_APP_ID','ALIPAY_PRIVATE_KEY','ALIPAY_PUBLIC_KEY','ALIPAY_KYC_BIZ_CODE','ALIPAY_GATEWAY',
  'FOOTER_DISTRIBUTOR','FOOTER_DISTRIBUTOR_URL',
  'JWT_SECRET','JWT_EXPIRES_IN','SESSION_SECRET','EMAIL_CODE_EXPIRE',
  'EMAIL_DOMAIN_MODE','EMAIL_DOMAIN_LIST',
  'LOGINDATE_DAY','LOGINDATE_EXPORT',
  'UID_MODE','UID_PREFIX','UID_LENGTH',
  'OIDC_LAUNCH_COUNTDOWN',
  'INAPP_AUTO_LOGIN',
  'ACCOUNT_DELETE_COOLDOWN_DAYS', 'ACCOUNT_DELETE_RETAIN_DAYS', 'ACCOUNT_DELETE_ADMIN_WAIT_DAYS', 'MERGE_UNDO_DAYS',
  'MEMO_LINK_DOMAINS','MEMO_MAX_ATTACH_MB','MEMO_ADMIN_LEVEL',
  'MEMBER_MAX_PHONES','MEMBER_MAX_EMAILS','MULTITENANT_BASE_DOMAIN',
  'WATERMARK_ENABLED','WATERMARK_SCOPE','WATERMARK_TEXT','WATERMARK_OPACITY','WATERMARK_ANGLE','WATERMARK_SIZE','WATERMARK_GAP','WATERMARK_COLOR','WATERMARK_BURN','WATERMARK_BURN_TEXT','WATERMARK_FONT_URL','WATERMARK_FONT_PATH','OAUTH_DEFAULT_DISABLED',
  'TWOFA_REQUIRED_LEVELS','TWOFA_ISSUER',
  'ACCESS_QR_SECRET','ACCESS_QR_TTL','FED_ALLOWED_DOMAINS',
  'MDM_APNS_TOPIC','MDM_APNS_KEY','MDM_APNS_KEY_ID','MDM_APNS_TEAM_ID','MDM_APNS_HOST',
  // v3.5.84 MDM 厂商通道：Google 服务账号（Chrome / Android 共用）+ Chrome 域级委派 + Android enterprise
  'GOOGLE_SA_CLIENT_EMAIL','GOOGLE_SA_PRIVATE_KEY','GOOGLE_ADMIN_SUBJECT','GOOGLE_CUSTOMER_ID','ANDROID_ENTERPRISE_NAME',
  'APPLE_PASS_TYPE_ID','APPLE_TEAM_ID','APPLE_PASS_CERT','APPLE_PASS_KEY','APPLE_PASS_KEY_PASSWORD','APPLE_WWDR_CERT','PKPASS_ORG_NAME','PKPASS_BG_COLOR','GOOGLE_WALLET_ISSUER_ID',
  'SELFHOST_UPDATE','SELFHOST_UPDATE_RESTART',
  'PORT','BASE_URL','NODE_ENV','CORS_ORIGIN',
];

let envInit = 0;
ENV_KEYS.forEach(k => {
  const existing = env.get.get(k);
  if (!existing) { env.set.run(k, ''); envInit++; }
});
if (envInit > 0) console.log(`✓ 环境变量键预置：${envInit} 条`);

console.log('\n✅ 初始化完成！运行 npm start 启动服务');
process.exit(0);
