/**
 * 消息发送 —— 统一走 QWQ Message 分发中心
 * https://github.com/uesrbai/qwq-message
 *
 * v3.3.3 起，本系统不再直接对接任何短信/邮件服务商。
 * 原来的 sms.js（火山引擎/阿里云/腾讯云）和 email.js（Zeabur Email/SMTP）已删除，
 * 服务商的账号、模板、轮询、故障转移全部由分发中心负责，这边只管调一个接口。
 *
 * 需要配置的环境变量：
 *   QWQ_MESSAGE_URL         分发中心地址，如 https://msg.example.com
 *                           （填成完整端点 .../api/v1/send 也可以，会自动去重）
 *   QWQ_MESSAGE_KEY         密钥，qwq_live_xxx（生产）或 qwq_test_xxx（测试）
 *   QWQ_MESSAGE_SMS_GROUP   短信通道组标识，如 sms-16
 *   QWQ_MESSAGE_EMAIL_GROUP 邮件通道组标识，如 mail-1
 *   QWQ_MESSAGE_SMS_HUB_TEMPLATE （可选）分发中心「模板管理」里自建模板的编号，如 sso-sms-code
 *   QWQ_MESSAGE_SMS_TEMPLATE     （可选）服务商后台已审核的模板号，如火山引擎的 ST_xxx
 *                                 —— 这两个是不同的东西，二选一，自建模板优先
 *   QWQ_MESSAGE_SMS_VAR          （可选）模板里验证码占位符的变量名，默认 code
 *
 * ⚠️ 沿用项目既有约定：是否真实发送**不看 NODE_ENV**，
 *    而是看分发中心是否已配置（isConfigured()）。未配置就只打印到控制台。
 */
const { recordCall } = require('./poller');

const PROVIDER_KEY = 'qwq_message';   // 出站调用统计里的标识

/** 分发中心是否已配置到可用状态 */
function isConfigured() {
  return !!(process.env.QWQ_MESSAGE_URL && process.env.QWQ_MESSAGE_KEY);
}

/**
 * 组装发送端点。
 * 管理员既可能填根地址（https://msg.example.com），也可能顺手把文档里的
 * 完整端点粘进来（https://msg.example.com/api/v1/send）——后者如果再拼一次
 * 就会变成 /api/v1/send/api/v1/send，所以这里统一把已有的端点后缀剥掉。
 */
function buildEndpoint(raw) {
  const base = String(raw).trim()
    .replace(/\/+$/, '')                 // 去掉结尾斜杠
    .replace(/\/api\/v1\/send$/i, '')    // 去掉已经带上的端点路径
    .replace(/\/+$/, '');
  return `${base}/api/v1/send`;
}

/**
 * 从错误响应里提炼出人能看懂的原因。
 *
 * 分发中心失败时经常直接把上游服务商的原始响应透传回来，形如：
 *   {"ResponseMetadata":{...,"Error":{"Code":"RE:0005","Message":"模板错误"}},...}
 * 早期实现只认顶层 detail/error/message，取不到就把整个 JSON 原样抛出，
 * 结果管理员看到的是一大坨看不懂的东西。这里逐层往下找真正的错因。
 */
const PROVIDER_HINTS = {
  'RE:0005': '短信模板有问题。最常见的原因是把「分发中心自建模板编号」填进了服务商模板号：' +
             '自建模板（模板管理里创建的，如 sso-sms-code）要填 QWQ_MESSAGE_SMS_HUB_TEMPLATE，' +
             '服务商后台已审核的模板号才填 QWQ_MESSAGE_SMS_TEMPLATE。' +
             '其次检查模板变量名是否与 QWQ_MESSAGE_SMS_VAR 一致',
  'RE:0004': '短信签名有问题：签名未审核通过或与模板不匹配',
};

function describeError(body, text, status) {
  if (!body || typeof body !== 'object') return text || `HTTP ${status}`;

  // detail 有时本身又是一段 JSON 字符串，先尝试展开
  let detail = body.detail;
  if (typeof detail === 'string' && /^\s*[{[]/.test(detail)) {
    try { detail = JSON.parse(detail); } catch (_) { /* 保持原样 */ }
  }

  // 逐个候选位置找服务商的错误对象（火山/阿里/腾讯的形状各不相同）
  const candidates = [detail, body, body.result, body.Result];
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;
    const err = c.Error || c.error || c.ResponseMetadata?.Error;
    if (err && (err.Message || err.Code)) {
      const code = err.Code || err.code;
      const msg  = err.Message || err.message || '';
      const hint = code && PROVIDER_HINTS[code] ? `。${PROVIDER_HINTS[code]}` : '';
      return `${msg}${code ? `（服务商错误码 ${code}）` : ''}${hint}`;
    }
  }

  // 退回到各种常见的平铺字段
  for (const v of [detail, body.error, body.message, body.msg, body.Message]) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  return text || `HTTP ${status}`;
}

/** 调用分发中心的 /api/v1/send */
async function dispatch(payload) {
  if (!isConfigured()) {
    throw new Error('QWQ Message 未配置（需要 QWQ_MESSAGE_URL 和 QWQ_MESSAGE_KEY）');
  }

  // 密钥必须是纯 ASCII：HTTP 头不接受非 ASCII 字符，否则 fetch 会抛出
  // "Cannot convert argument to a ByteString" 这种完全看不懂的底层错误。
  // 最常见的原因是把管理端里打码显示的 '••••' 当成真密钥保存了。
  const key = String(process.env.QWQ_MESSAGE_KEY);
  if (/^[•*]+$/.test(key)) {
    throw new Error('QWQ_MESSAGE_KEY 是一串掩码字符（••••），说明保存时把打码显示值当成了真实密钥。请到「系统配置 → 消息分发」重新填写真实密钥');
  }
  if (/[^\x20-\x7E]/.test(key)) {
    throw new Error('QWQ_MESSAGE_KEY 含有非 ASCII 字符，无法作为请求头发送，请检查是否复制到了多余内容');
  }

  const url = buildEndpoint(process.env.QWQ_MESSAGE_URL);

  let res, text;
  try {
    res  = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
    text = await res.text();
  } catch (e) {
    recordCall(PROVIDER_KEY, false);
    // 网络层失败（DNS/超时/证书），把地址带出来方便排查
    throw new Error(`QWQ Message 请求失败（${url}）：${e.message}`);
  }

  let body;
  try { body = JSON.parse(text); } catch (_) { body = { raw: text }; }

  if (!res.ok || body.success === false) {
    recordCall(PROVIDER_KEY, false);
    throw new Error(`QWQ Message 发送失败 (${res.status})：${describeError(body, text, res.status)}`);
  }

  recordCall(PROVIDER_KEY, true);
  // 分发中心会告诉我们它最终走了哪条通道，记进日志便于对账
  console.log(`[QWQ Message] → ${payload.to || payload.group} via ${body.method || '?'}${body.channelId ? ' #' + body.channelId : ''}`);
  return body;
}

// ──────────────────────────────────────────
// 邮件 HTML 模板（从原 email.js 保留，样式不变）
// ──────────────────────────────────────────
function buildCodeHtml(code) {
  const expire = Math.round(parseInt(process.env.EMAIL_CODE_EXPIRE || '600') / 60);
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:40px 20px;">
      <div style="text-align:center;margin-bottom:32px;">
        <div style="width:48px;height:48px;background:#5A8A00;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;">
          <span style="color:white;font-size:24px;">🔐</span>
        </div>
        <h1 style="margin:16px 0 4px;font-size:24px;font-weight:700;color:#111827;">登录验证码</h1>
        <p style="margin:0;color:#6B7280;font-size:14px;">统一账号服务</p>
      </div>
      <div style="background:#F6FFDA;border-radius:12px;padding:32px;text-align:center;margin-bottom:24px;border:1px solid #ECFFAF;">
        <p style="margin:0 0 16px;color:#374151;font-size:15px;">您的验证码是：</p>
        <div style="letter-spacing:12px;font-size:40px;font-weight:800;color:#5A8A00;">${code}</div>
        <p style="margin:16px 0 0;color:#9CA3AF;font-size:13px;">验证码 ${expire} 分钟内有效，请勿泄露给他人。</p>
      </div>
      <p style="color:#9CA3AF;font-size:12px;text-align:center;margin:0;">
        如果您未请求此验证码，请忽略此邮件。<br>此邮件由系统自动发送，请勿回复。
      </p>
    </div>`;
}

// ──────────────────────────────────────────
// 对外接口（签名与原 sms.js / email.js 保持一致，调用方无需改动）
// ──────────────────────────────────────────

/**
 * 发送短信。
 * @param {string} phone
 * @param {string} codeOrText 验证码；实名认证提醒场景传的是完整链接，
 *                            由分发中心侧的模板决定怎么填（原行为不变）
 */
async function sendSmsCode(phone, codeOrText) {
  const group = process.env.QWQ_MESSAGE_SMS_GROUP;
  if (!group) throw new Error('QWQ_MESSAGE_SMS_GROUP 未配置，不知道该走哪条短信通道');

  const payload = { group, to: phone, content: String(codeOrText) };

  // ⚠️ 分发中心有两套模板概念，字段不同，填错会直接被服务商拒掉：
  //   template     = 分发中心「模板管理」里自建的模板（如 sso-sms-code）
  //   templateCode = 服务商后台已审核的模板号（如火山引擎的 ST_xxx）
  // 早期只实现了 templateCode，把自建模板的编号当成服务商模板号透传过去，
  // 火山引擎因此报 RE:0005 模板错误。现在两者都支持，自建模板优先。
  const hubTpl      = (process.env.QWQ_MESSAGE_SMS_HUB_TEMPLATE || '').trim();
  const providerTpl = (process.env.QWQ_MESSAGE_SMS_TEMPLATE || '').trim();

  if (hubTpl || providerTpl) {
    const varName = (process.env.QWQ_MESSAGE_SMS_VAR || 'code').trim();
    payload.variables = { [varName]: String(codeOrText) };
    if (hubTpl) {
      payload.template = hubTpl;
      if (providerTpl) {
        console.warn('[QWQ Message] 同时配置了自建模板与服务商模板号，按自建模板发送；' +
                     '如需走服务商模板请清空 QWQ_MESSAGE_SMS_HUB_TEMPLATE');
      }
    } else {
      payload.templateCode = providerTpl;
    }
  }
  return dispatch(payload);
}

/** 发送邮件（HTML 正文） */
async function sendEmail(to, subject, html) {
  const group = process.env.QWQ_MESSAGE_EMAIL_GROUP;
  if (!group) throw new Error('QWQ_MESSAGE_EMAIL_GROUP 未配置，不知道该走哪条邮件通道');
  return dispatch({ group, to, subject, content: html });
}

/** 发送邮箱验证码（沿用原 HTML 模板） */
async function sendEmailCode(email, code) {
  return sendEmail(email, `【登录验证码】${code}`, buildCodeHtml(code));
}

module.exports = { isConfigured, dispatch, sendSmsCode, sendEmail, sendEmailCode };
