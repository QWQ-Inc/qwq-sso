/**
 * 登录跳转策略（v3.5.142）
 *
 * 第三方「用 QWQ SSO 登录」时，校验通过后到底怎么跳回应用，由管理员按规则决定：
 *   - direct    去掉中间页，校验后直接跳（信任应用，自动授权，无确认、无倒计时）
 *   - countdown 显示几秒中转页后自动跳（可配秒数）
 *   - consent   每次都要用户在授权页确认「同意」后再跳
 *   - reauth    强确认：先要求重新输入密码 / 动态码验证身份，再确认 + 跳转
 *
 * 触发条件（match_*，留空 = 不限）：应用、登录主体（组织）、场景、凭证分类，共同决定命中哪条规则。
 *   命中规则按 priority 升序 + 建表时间，取第一条匹配；都不命中 → 保持历史默认
 *   （已授权过 → 倒计时直通；首次 → 需确认）。
 *
 * 本模块是**纯函数**，不碰数据库 / HTTP，便于单测；provider.js 负责取数据并调用。
 * ⚠️ reauth 的「必须重新验证身份」是安全闸门，真正的强制在 provider.js 的 /oauth/consent 服务端，
 *    本模块只决定「该用哪种模式」。
 */

const MODES          = ['direct', 'countdown', 'consent', 'reauth'];
const SCENARIOS      = ['any', 'first', 'returning', 'idp'];      // 任意 / 首次授权 / 已授权再登 / 从控制台(IdP)发起
const AUTHS          = ['any', 'password', 'code', 'oauth', 'passkey', 'other'];
const REAUTH_METHODS = ['password', 'twofa'];

/** 把登录时记录的中文「方式」串归一成凭证分类（供 match_auth 匹配）。token 里带 lm 字段即为此。 */
function methodCategory(method) {
  const s = String(method || '');
  if (/passkey/i.test(s))                 return 'passkey';
  if (/oauth|第三方/i.test(s))             return 'oauth';
  if (/验证码|短信|邮箱验证/.test(s))       return 'code';
  if (/密码|组织登录|找回密码/.test(s))     return 'password';
  return 'other';
}

function clampCountdown(n) {
  const v = parseInt(n, 10);
  if (Number.isNaN(v)) return 3;
  return Math.max(0, Math.min(30, v));
}

function parseReauth(raw) {
  const arr = String(raw || '').split(/[\s,]+/).filter(x => REAUTH_METHODS.includes(x));
  return arr.length ? [...new Set(arr)] : ['password'];
}

/** 一条规则是否匹配当前上下文 */
function policyMatches(p, ctx) {
  if (p.match_app && p.match_app !== ctx.appId) return false;
  if (p.match_subject && !(ctx.isMemberOf && ctx.isMemberOf(p.match_subject))) return false;
  const sc = p.match_scenario || 'any';
  if (sc === 'first'     && ctx.alreadyGranted)  return false;
  if (sc === 'returning' && !ctx.alreadyGranted) return false;
  if (sc === 'idp'       && !ctx.idp)            return false;
  const au = p.match_auth || 'any';
  if (au !== 'any' && au !== (ctx.auth || 'other')) return false;
  return true;
}

/**
 * 评估应走哪种跳转模式。
 * @param policies 规则数组（db 行；本函数内部按 enabled 过滤 + 排序，传全量也可）
 * @param ctx { appId, isMemberOf(subjectId)->bool, alreadyGranted, idp, auth, promptConsent, defaultCountdown }
 * @returns { mode, countdown, reauthMethods, policyId }
 */
function evaluate(policies, ctx) {
  const list = (policies || [])
    .filter(p => p && (p.enabled === undefined || p.enabled))
    .sort((a, b) => ((a.priority ?? 100) - (b.priority ?? 100))
      || String(a.created_at || '').localeCompare(String(b.created_at || '')));

  for (const p of list) {
    if (!policyMatches(p, ctx)) continue;
    let mode = MODES.includes(p.mode) ? p.mode : 'consent';
    // RP 用 prompt=consent 显式要求重新确认：direct/countdown 至少升级到 consent；reauth 保持（更强）
    if (ctx.promptConsent && (mode === 'direct' || mode === 'countdown')) mode = 'consent';
    return { mode, countdown: clampCountdown(p.countdown), reauthMethods: parseReauth(p.reauth_methods), policyId: p.id || null };
  }

  // 无规则命中 → 历史默认行为：已授权过给倒计时直通，首次需确认
  let mode = ctx.alreadyGranted ? 'countdown' : 'consent';
  if (ctx.promptConsent) mode = 'consent';
  return {
    mode,
    countdown: ctx.defaultCountdown != null ? clampCountdown(ctx.defaultCountdown) : 3,
    reauthMethods: ['password'],
    policyId: null,
  };
}

module.exports = { MODES, SCENARIOS, AUTHS, REAUTH_METHODS, methodCategory, clampCountdown, parseReauth, policyMatches, evaluate };
