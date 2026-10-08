/**
 * MDM 设备纳管核心（v3.5.82）
 *
 * 落地为「拉取式设备代理」协议，传输无关、可单测：
 *   - 设备上的 agent（或 MDM 描述文件的 check-in URL）用 enroll secret 轮询 check-in，
 *     拉取待执行命令（device_commands 队列），执行后回报结果。
 *   - 命令：锁定/解锁/重启/清除密码/定位/擦除/退役/推送·移除描述文件/自定义。
 *
 * ⚠️ 真实厂商协议（Apple MDM over APNs、Android Management API、Windows MDM）需要厂商证书 +
 *    推送通道，本机无法联调——作为「唤醒传输适配器」gated：配了 MDM_APNS_* 才会主动推送唤醒设备
 *    check-in，否则纯靠 agent 定时轮询（不影响命令下发与回报，只是实时性）。
 *
 * 本文件只做：命令类型/校验、enroll secret 生成与校验、传输门控。命令回报的副作用
 * （改设备锁定态、已装描述文件、退役）放在 api.js（要动多张表），见 onCommandAcked。
 */
const crypto = require('crypto');

// 命令类型元数据：label 中文名、danger 需强确认、needsProfile 需带 profile_id
const COMMAND_TYPES = {
  lock:           { label: '锁定', danger: false },
  unlock:         { label: '解锁', danger: false },
  restart:        { label: '重启', danger: false },
  clear_passcode: { label: '清除锁屏密码', danger: false },
  locate:         { label: '定位', danger: false },
  wipe:           { label: '远程擦除（恢复出厂）', danger: true },
  retire:         { label: '退役并解除纳管', danger: true },
  push_profile:   { label: '推送配置描述文件', danger: false, needsProfile: true },
  remove_profile: { label: '移除配置描述文件', danger: false, needsProfile: true },
  custom:         { label: '自定义命令', danger: false },
};
const DANGER_CONFIRM = { wipe: '擦除设备', retire: '退役设备' };

function isCommandType(t) { return Object.prototype.hasOwnProperty.call(COMMAND_TYPES, t); }

/**
 * 校验 + 归一化命令。opts.profileExists(id)→bool 供 push/remove_profile 校验。
 * @returns {{ok:true, payload:object}|{ok:false, error:string}}
 */
function validateCommand(type, rawPayload, opts = {}) {
  if (!isCommandType(type)) return { ok: false, error: '未知的命令类型' };
  const meta = COMMAND_TYPES[type];
  const p = (rawPayload && typeof rawPayload === 'object') ? rawPayload : {};
  const out = {};
  if (meta.needsProfile) {
    const pid = String(p.profile_id || '').trim();
    if (!pid) return { ok: false, error: '请选择配置描述文件' };
    if (opts.profileExists && !opts.profileExists(pid)) return { ok: false, error: '配置描述文件不存在' };
    out.profile_id = pid;
  }
  if (type === 'lock') {
    if (p.message != null) out.message = String(p.message).slice(0, 200);
    if (p.pin != null) {
      const pin = String(p.pin).replace(/\D/g, '').slice(0, 8);   // 恢复锁 PIN，仅数字
      if (pin) out.pin = pin;
    }
  }
  if (type === 'custom') {
    const cmd = String(p.command || '').trim();
    if (!cmd) return { ok: false, error: '自定义命令不能为空' };
    out.command = cmd.slice(0, 2000);
  }
  return { ok: true, payload: out };
}

/** 生成 enroll secret：返回明文（只发给设备一次）+ sha256（存库） */
function genEnrollSecret() {
  const secret = crypto.randomBytes(24).toString('base64url');
  return { secret, hash: hashSecret(secret) };
}
function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret || '')).digest('hex');
}
/** 常数时间比对 agent 提交的 secret 与库里 hash */
function verifySecret(secret, hash) {
  if (!secret || !hash) return false;
  const a = Buffer.from(hashSecret(secret));
  const b = Buffer.from(String(hash));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── 唤醒传输适配器（gated）──
// 真实厂商推送需证书：Apple 需 APNs（MDM_APNS_*）、Android 需 Google 服务账号、Windows 需 Intune。
// 未配置时 pushWake 是 no-op，命令仍进队列等 agent 轮询拉取。
function transportConfigured() {
  return !!(process.env.MDM_APNS_TOPIC && process.env.MDM_APNS_KEY && process.env.MDM_APNS_KEY_ID && process.env.MDM_APNS_TEAM_ID);
}
/** 下发命令后尝试推送唤醒设备立刻 check-in；未配推送则返回 {pushed:false}（靠轮询） */
async function pushWake(/* device */) {
  if (!transportConfigured()) return { pushed: false, reason: 'no_transport' };
  // 真实 APNs 推送在此实现（需 MDM vendor 证书）；本机无证书，保持 gated。
  return { pushed: false, reason: 'not_implemented' };
}

module.exports = {
  COMMAND_TYPES, DANGER_CONFIRM, isCommandType, validateCommand,
  genEnrollSecret, hashSecret, verifySecret, transportConfigured, pushWake,
};
