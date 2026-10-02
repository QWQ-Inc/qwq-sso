/**
 * KYC 实名认证服务 - 支持多服务商轮询
 * 服务商：Didit / Stripe Identity / 阿里云实人认证 / 火山引擎人脸认证
 *
 * 模式说明：
 *   - Didit / Stripe：创建认证会话 → 返回跳转 URL → 用户完成后 Webhook 通知结果
 *   - 阿里云 / 火山引擎：传统服务端提交（适合有证件照片的场景）
 */
const axios  = require('axios');
const crypto = require('crypto');
const { pollExecute, getStrategy, recordCall } = require('./poller');

// ══════════════════════════════════════════════════════════
// Didit KYC
// 文档：https://docs.didit.me/integration/integration-prompt
// ══════════════════════════════════════════════════════════
async function createDiditSession(userId, callbackUrl) {
  const apiKey     = process.env.DIDIT_API_KEY;
  const workflowId = process.env.DIDIT_WORKFLOW_ID;
  if (!apiKey || !workflowId) throw new Error('Didit 未配置 DIDIT_API_KEY 或 DIDIT_WORKFLOW_ID');

  const resp = await axios.post('https://verification.didit.me/v3/session/', {
    workflow_id:  workflowId,
    vendor_data:  String(userId),
    callback:     callbackUrl,
  }, {
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
  });

  const { session_id, url } = resp.data;
  return { provider: 'didit', session_id, redirect_url: url };
}

/**
 * 验证 Didit Webhook（HMAC-SHA256）
 * 在 Didit 控制台配置 Webhook Secret 后调用此函数验证签名
 */
function verifyDiditWebhook(rawBody, signature, secret) {
  const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
}

// ══════════════════════════════════════════════════════════
// Stripe Identity
// 文档：https://docs.stripe.com/identity/verification-sessions
// ══════════════════════════════════════════════════════════
async function createStripeSession(userId, callbackUrl) {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) throw new Error('Stripe Identity 未配置 STRIPE_SECRET_KEY');

  // 使用 FormData 格式（Stripe API 用 URL-encoded）
  const params = new URLSearchParams({
    type:          'document',
    'metadata[user_id]': String(userId),
    'options[document][require_matching_selfie]': 'true',
    return_url:    callbackUrl,
  });

  const resp = await axios.post(
    'https://api.stripe.com/v1/identity/verification_sessions',
    params.toString(),
    {
      headers: {
        Authorization:  `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );

  const { id: session_id, url } = resp.data;
  return { provider: 'stripe', session_id, redirect_url: url };
}

/**
 * 验证 Stripe Webhook 签名
 */
function verifyStripeWebhook(rawBody, signature, secret) {
  try {
    // Stripe signature format: t=timestamp,v1=hash
    const elements = signature.split(',');
    const timestamp = elements.find(e => e.startsWith('t=')).slice(2);
    const v1 = elements.find(e => e.startsWith('v1=')).slice(3);
    const payload = `${timestamp}.${rawBody}`;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
  } catch (_) {
    return false;
  }
}

// ══════════════════════════════════════════════════════════
// 阿里云实人认证
// ══════════════════════════════════════════════════════════
async function verifyViaAliyunKYC(name, idNumber) {
  // 优先用 KYC 专用 AK（管理端「KYC · 阿里云」面板填的就是这两个），
  // 没配才回退到通用 AK。v3.3.3 之前只读通用 AK，导致面板里填的 KYC 专用密钥
  // 从来没生效过，KYC 实际是在借用短信的凭据。
  const accessKeyId = process.env.ALIYUN_KYC_ACCESS_KEY_ID     || process.env.ALIYUN_ACCESS_KEY_ID;
  const secretKey   = process.env.ALIYUN_KYC_ACCESS_KEY_SECRET || process.env.ALIYUN_ACCESS_KEY_SECRET;

  const params = {
    AccessKeyId:       accessKeyId,
    Action:            'VerifyMaterial',
    Format:            'JSON',
    IdCardNumber:      idNumber,
    IdCardName:        name,
    ProductCode:       process.env.ALIYUN_KYC_PRODUCT || 'ID_PRO',
    SignatureMethod:   'HMAC-SHA1',
    SignatureNonce:    crypto.randomUUID(),
    SignatureVersion:  '1.0',
    Timestamp:         new Date().toISOString(),
    Version:           '2019-03-07',
  };

  const sorted    = Object.keys(params).sort();
  const canonical = sorted.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  const toSign    = `GET&${encodeURIComponent('/')}&${encodeURIComponent(canonical)}`;
  const signature = crypto.createHmac('sha1', `${secretKey}&`).update(toSign).digest('base64');
  const url       = `https://cloudauth.aliyuncs.com/?${canonical}&Signature=${encodeURIComponent(signature)}`;

  const resp = await axios.get(url);
  if (!resp.data?.Data?.Passed) throw new Error(resp.data?.Data?.SubCode || '阿里云实名认证失败');
  return { verified: true, provider: 'aliyun_kyc' };
}

// ══════════════════════════════════════════════════════════
// 火山引擎人脸核身
// ══════════════════════════════════════════════════════════
async function verifyViaVolcengineKYC(name, idNumber) {
  // 同上：优先 KYC 专用 AK，回退通用 AK
  const accessKeyId = process.env.VOLC_KYC_ACCESS_KEY_ID     || process.env.VOLCENGINE_ACCESS_KEY_ID;
  const secretKey   = process.env.VOLC_KYC_ACCESS_KEY_SECRET || process.env.VOLCENGINE_ACCESS_KEY_SECRET;

  const host    = 'faceid.volcengineapi.com';
  const service = 'faceid';
  const region  = 'cn-north-1';
  const action  = 'IdCardVerify';
  const version = '2021-11-18';
  const now     = new Date();
  const xDate   = now.toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '');
  const shortDate = xDate.slice(0, 8);

  const bodyObj = { Name: name, IdCardNumber: idNumber };
  const body    = JSON.stringify(bodyObj);
  const contentHash = crypto.createHash('sha256').update(body).digest('hex');
  const headers = { 'Content-Type': 'application/json', Host: host, 'X-Date': xDate, 'X-Content-Sha256': contentHash };
  const canonicalHeaders = Object.keys(headers).sort().map(k => `${k.toLowerCase()}:${headers[k]}`).join('\n') + '\n';
  const signedHeaders    = Object.keys(headers).sort().map(k => k.toLowerCase()).join(';');
  const canonicalRequest = ['POST', '/', `Action=${action}&Version=${version}`, canonicalHeaders, signedHeaders, contentHash].join('\n');
  const credentialScope  = `${shortDate}/${region}/${service}/request`;
  const stringToSign     = ['HMAC-SHA256', xDate, credentialScope, crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
  const signingKey    = hmac(hmac(hmac(hmac(secretKey, shortDate), region), service), 'request');
  const signature     = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const authorization = `HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const resp = await axios.post(
    `https://${host}/?Action=${action}&Version=${version}`,
    body,
    { headers: { ...headers, Authorization: authorization } }
  );

  if (resp.data?.ResponseMetadata?.Error) throw new Error(resp.data.ResponseMetadata.Error.Message);
  if (!resp.data?.Result?.Passed) throw new Error('火山引擎实名认证未通过');
  return { verified: true, provider: 'volcengine_kyc' };
}

// ══════════════════════════════════════════════════════════
// 支付宝实人认证（alipay.user.certify.open.*）
// 文档：https://opendocs.alipay.com/open/20181012100420932508
// 流程：initialize 拿 certify_id → 跳 certify 页人脸核身 → query 查结果
// 签名：RSA2（SHA256withRSA），响应用支付宝公钥验签
// ══════════════════════════════════════════════════════════
const ALIPAY_GATEWAY = () => process.env.ALIPAY_GATEWAY || 'https://openapi.alipay.com/gateway.do';

// 把「无头无尾的 base64 密钥串」补成标准 PEM（管理员常直接从支付宝后台复制裸串）
function toPem(key, label) {
  const k = String(key || '').trim();
  if (!k) return '';
  if (k.includes('-----BEGIN')) return k.replace(/\\n/g, '\n');
  const body = k.replace(/\s+/g, '').match(/.{1,64}/g).join('\n');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`;
}

// 支付宝时间戳：Asia/Shanghai 的 yyyy-MM-dd HH:mm:ss
function alipayTimestamp() {
  const s = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }); // 2026-08-24 12:34:56
  return s.replace('T', ' ').slice(0, 19);
}

// 待签名串：按 key 字典序，k=v&… （值不做 URL 编码），排除 sign / 空值
function alipaySignContent(params) {
  return Object.keys(params).sort()
    .filter(k => k !== 'sign' && params[k] !== undefined && params[k] !== '')
    .map(k => `${k}=${params[k]}`).join('&');
}

function alipaySign(params) {
  const priv = toPem(process.env.ALIPAY_PRIVATE_KEY, 'PRIVATE KEY');
  if (!priv) throw new Error('支付宝未配置 ALIPAY_PRIVATE_KEY');
  return crypto.createSign('RSA-SHA256').update(alipaySignContent(params), 'utf8').sign(priv, 'base64');
}

// 验支付宝响应签名（有配公钥才验；裸串会被补成 PEM）
function alipayVerify(content, sign) {
  const pub = toPem(process.env.ALIPAY_PUBLIC_KEY, 'PUBLIC KEY');
  if (!pub || !sign) return true; // 未配公钥则跳过验签（依赖 HTTPS），不阻断流程
  try {
    return crypto.createVerify('RSA-SHA256').update(content, 'utf8').verify(pub, sign, 'base64');
  } catch (_) { return false; }
}

function alipayCommonParams(method) {
  return {
    app_id:    process.env.ALIPAY_APP_ID,
    method,
    format:    'JSON',
    charset:   'utf-8',
    sign_type: 'RSA2',
    timestamp: alipayTimestamp(),
    version:   '1.0',
  };
}

// 构造已签名、URL 编码的完整请求参数
function alipayBuildParams(method, bizContent) {
  const params = { ...alipayCommonParams(method), biz_content: JSON.stringify(bizContent) };
  params.sign = alipaySign(params);
  return params;
}

// 从响应里取出对应 method 的 *_response 节点 + 校验业务 code
function alipayParseResponse(data, method) {
  const nodeKey = method.replace(/\./g, '_') + '_response';
  const node = data?.[nodeKey];
  if (!node) throw new Error('支付宝响应格式异常');
  // 尽力验签（对该节点的紧凑 JSON）
  if (!alipayVerify(JSON.stringify(node), data.sign)) throw new Error('支付宝响应验签失败');
  if (node.code && node.code !== '10000') {
    throw new Error(`支付宝错误 ${node.code}：${node.sub_msg || node.msg || '未知'}`);
  }
  return node;
}

async function alipayPost(method, bizContent) {
  const params = alipayBuildParams(method, bizContent);
  const resp = await axios.post(ALIPAY_GATEWAY(), new URLSearchParams(params).toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
  });
  return alipayParseResponse(resp.data, method);
}

/** 发起支付宝实人认证：返回 certify_id + 让用户跳转的核身页 URL */
async function createAlipaySession(userId, name, idNumber, returnUrl) {
  if (!process.env.ALIPAY_APP_ID || !process.env.ALIPAY_PRIVATE_KEY) {
    throw new Error('支付宝未配置 ALIPAY_APP_ID / ALIPAY_PRIVATE_KEY');
  }
  const outerOrderNo = 'kyc' + Date.now() + Math.floor(Math.random() * 1000);
  const initNode = await alipayPost('alipay.user.certify.open.initialize', {
    outer_order_no: outerOrderNo,
    biz_code:       process.env.ALIPAY_KYC_BIZ_CODE || 'FACE',
    identity_param: { identity_type: 'CERT_INFO', cert_type: 'IDENTITY_CARD', cert_name: name, cert_no: idNumber },
    merchant_config:{ return_url: returnUrl },
  });
  const certifyId = initNode.certify_id;
  if (!certifyId) throw new Error('支付宝未返回 certify_id');

  // 核身页：以 GET 方式带上已签名参数，重定向用户浏览器过去
  const certifyParams = alipayBuildParams('alipay.user.certify.open.certify', { certify_id: certifyId });
  const redirectUrl = `${ALIPAY_GATEWAY()}?${new URLSearchParams(certifyParams).toString()}`;

  return { provider: 'alipay', session_id: certifyId, redirect_url: redirectUrl };
}

/** 查询支付宝实人认证结果 */
async function queryAlipayCertify(certifyId) {
  const node = await alipayPost('alipay.user.certify.open.query', { certify_id: certifyId });
  return { passed: node.passed === 'T' || node.passed === true, raw: node };
}

// ══════════════════════════════════════════════════════════
// 身份假名化 / 比对哈希（S-08 去重、S-02 姓名比对）
// 只算 HMAC，绝不存原文；密钥 KYC_PSEUDONYM_SECRET 必须长期固定并妥善备份，
// 换密钥会让所有历史假名/哈希失效。
// ══════════════════════════════════════════════════════════
function _kycSecret() { return process.env.KYC_PSEUDONYM_SECRET || ''; }
const normName = s => String(s || '').replace(/\s+/g, '').trim();
const normId   = s => String(s || '').replace(/\s+/g, '').trim().toUpperCase();
function kycHmac(label, value) {
  const secret = _kycSecret();
  if (!secret || !value) return null;
  return crypto.createHmac('sha256', secret).update(label + ':' + value).digest('hex');
}
/** 计算某人的假名 + 姓名哈希。certType 默认身份证。未配密钥返回 nulls。 */
function identityHashes(name, idNo, certType = 'IDENTITY_CARD') {
  return {
    pseudonym: kycHmac('pid', certType + '|' + normId(idNo)),  // 同一自然人恒定、跨账号一致、不可逆
    nameHash:  kycHmac('name', normName(name)),
  };
}
function kycPseudonymEnabled() { return !!_kycSecret(); }

// ══════════════════════════════════════════════════════════
// 统一 KYC 入口（两种模式）
// ══════════════════════════════════════════════════════════

/**
 * 模式一：会话跳转模式（Didit / Stripe Identity）
 * 返回 redirect_url，前端跳转完成认证，结果通过 Webhook 通知
 * @param {string} userId
 * @param {string} callbackUrl  认证完成后跳转回的 URL
 */
async function createKycSession(userId, callbackUrl, opts = {}) {
  const e        = process.env;
  const strategy = getStrategy('kyc');
  const { name, idNumber } = opts;

  const providers = [
    {
      key:       'kyc_didit',
      available: !!(e.DIDIT_API_KEY && e.DIDIT_WORKFLOW_ID),
      fn:        () => createDiditSession(userId, callbackUrl),
    },
    {
      key:       'kyc_stripe',
      available: !!e.STRIPE_SECRET_KEY,
      fn:        () => createStripeSession(userId, callbackUrl),
    },
    {
      // 支付宝实人认证需要姓名+身份证号（发起前收集），完成后经 callback 查询结果落库
      key:       'kyc_alipay',
      available: !!(e.ALIPAY_APP_ID && e.ALIPAY_PRIVATE_KEY && name && idNumber),
      fn:        () => createAlipaySession(userId, name, idNumber, callbackUrl),
    },
  ];

  const available = providers.filter(p => p.available);
  if (!available.length) {
    throw new Error('未配置任何会话型 KYC 服务商（Didit / Stripe Identity / 支付宝）');
  }

  return pollExecute(providers, strategy);
}

/**
 * 模式二：服务端直接认证（阿里云 / 火山引擎）
 * 直接提交姓名 + 身份证号，返回认证结果
 * @param {string} name      真实姓名
 * @param {string} idNumber  身份证号
 */
async function verifyKycDirect(name, idNumber) {
  const e        = process.env;
  const strategy = getStrategy('kyc');

  const providers = [
    {
      key:       'kyc_volcengine',
      available: !!((e.VOLC_KYC_ACCESS_KEY_ID || e.VOLCENGINE_ACCESS_KEY_ID) &&
                    (e.VOLC_KYC_ACCESS_KEY_SECRET || e.VOLCENGINE_ACCESS_KEY_SECRET)),
      fn:        () => verifyViaVolcengineKYC(name, idNumber),
    },
    {
      key:       'kyc_aliyun',
      available: !!((e.ALIYUN_KYC_ACCESS_KEY_ID || e.ALIYUN_ACCESS_KEY_ID) &&
                    (e.ALIYUN_KYC_ACCESS_KEY_SECRET || e.ALIYUN_ACCESS_KEY_SECRET)),
      fn:        () => verifyViaAliyunKYC(name, idNumber),
    },
  ];

  const available = providers.filter(p => p.available);
  if (!available.length) {
    throw new Error('未配置任何直接认证型 KYC 服务商（阿里云 / 火山引擎）');
  }

  return pollExecute(providers, strategy);
}

module.exports = {
  createKycSession,
  verifyKycDirect,
  verifyDiditWebhook,
  verifyStripeWebhook,
  queryAlipayCertify,
  createAlipaySession,
  identityHashes,
  kycHmac,
  normName,
  normId,
  kycPseudonymEnabled,
  // 供测试：签名机制
  _alipay: { toPem, alipaySign, alipayVerify, alipaySignContent, alipayBuildParams },
};
