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

// ══════════════════════════════════════════
// 多传输适配层（v3.5.84）
//   一台设备走哪条下发通道由 device.transport 决定：
//     pull_agent    电脑跑 agent.js，被动拉取（现成、已跑通；阶段 A）
//     apple_mdm     iPhone/iPad/Mac，Apple MDM over APNs（需 Apple MDM 推送证书；阶段 B）
//     google_chrome Chromebook，Google Admin SDK / Chrome Management API（需 Google 服务账号；阶段 C）
//     android_mgmt  Android，Android Management API（需 Google Cloud 项目 + enterprise；阶段 D）
//   厂商通道未配凭据时 gated：命令照样进队列，deliver 返回 pending + transport_not_configured，
//   管理端标「传输未配置」。配齐凭据后把对应 adapter 的 send() 填成真实调用即可，别处不用改。
// ⚠️ 厂商 send() 的 API 请求结构按官方文档写好，但本机无凭据无法联调——gated、try/catch、如实回报，
//    真正投产前需用真实凭据验证一遍。
// ══════════════════════════════════════════
const env = (k) => String(process.env[k] || '').trim();

// 本系统命令 → 各厂商命令名（不支持的为 undefined，管理端标「该通道不支持此命令」）
const VENDOR_CMD = {
  apple_mdm:     { lock: 'DeviceLock', clear_passcode: 'ClearPasscode', restart: 'RestartDevice', wipe: 'EraseDevice', push_profile: 'InstallProfile', remove_profile: 'RemoveProfile' },
  google_chrome: { restart: 'REBOOT', wipe: 'REMOTE_POWERWASH' },
  // ⚠️ Android Management API 的 issueCommand 没有 WIPE 枚举——擦除=删除设备资源（DELETE），在 deliver 里特判。
  android_mgmt:  { lock: 'LOCK', clear_passcode: 'RESET_PASSWORD', restart: 'REBOOT', retire: 'RELINQUISH_OWNERSHIP' },
};
function mapVendorCommand(transport, type) {
  const m = VENDOR_CMD[transport];
  return m ? m[type] : undefined;   // pull_agent 不在表里 → undefined（它不做命令名映射，直接排队）
}

// ── Google 服务账号 → access_token（Chrome / Android 共用；RS256 JWT 换 token）──
// 需环境变量 GOOGLE_SA_CLIENT_EMAIL + GOOGLE_SA_PRIVATE_KEY（PEM，\n 可用字面写）。
// Chrome(Admin SDK) 还需域级委派管理员邮箱 GOOGLE_ADMIN_SUBJECT。
// ⚠️ 所有读 env 的函数都收一个可选 `E`（env getter，默认全局 env）。按组织覆盖时（v3.5.89）由 api.js
//    用该设备所属组织的 feature_config 构造 E 传入——组织配了用组织的，没配回退全局。并发安全（随调用栈走）。
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function googleSAConfigured(E = env) { return !!(E('GOOGLE_SA_CLIENT_EMAIL') && E('GOOGLE_SA_PRIVATE_KEY')); }
function buildGoogleAssertion(scope, subject, E = env) {
  const key = E('GOOGLE_SA_PRIVATE_KEY').replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: E('GOOGLE_SA_CLIENT_EMAIL'), scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  if (subject) claim.sub = subject;
  const signingInput = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64url(JSON.stringify(claim));
  const sig = crypto.createSign('RSA-SHA256').update(signingInput).sign(key);
  return signingInput + '.' + b64url(sig);
}
async function googleAccessToken(scope, subject, E = env) {
  const assertion = buildGoogleAssertion(scope, subject, E);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Google token 失败：' + (j.error_description || j.error || r.status));
  return j.access_token;
}

// ── Apple APNs（MDM 唤醒推送；ES256 JWT provider token）──
// 需 MDM_APNS_TEAM_ID + MDM_APNS_KEY_ID + MDM_APNS_KEY(.p8 内容) + MDM_APNS_TOPIC（MDM 推送主题）。
function buildApnsJwt(E = env) {
  const key = E('MDM_APNS_KEY').replace(/\\n/g, '\n');
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: E('MDM_APNS_KEY_ID'), typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: E('MDM_APNS_TEAM_ID'), iat: now }));
  const sig = crypto.createSign('SHA256').update(head + '.' + body).sign({ key, dsaEncoding: 'ieee-p1363' });
  return head + '.' + body + '.' + b64url(sig);
}

const TRANSPORTS = {
  pull_agent: {
    key: 'pull_agent', label: '设备代理（拉取式·电脑）', kinds: ['apple', 'google', 'microsoft', 'access_controller', 'card_reader'],
    configured: () => true,
    // 被动：命令进队列，agent 下次 check-in 拉取执行
    async deliver() { return { delivered: false, pending: true, reason: 'await_agent' }; },
  },
  apple_mdm: {
    key: 'apple_mdm', label: 'Apple MDM（iPhone/iPad/Mac·APNs）', kinds: ['apple'],
    envKeys: ['MDM_APNS_TOPIC', 'MDM_APNS_KEY', 'MDM_APNS_KEY_ID', 'MDM_APNS_TEAM_ID'],
    configured: (E = env) => !!(E('MDM_APNS_TOPIC') && E('MDM_APNS_KEY') && E('MDM_APNS_KEY_ID') && E('MDM_APNS_TEAM_ID')),
    async deliver(device, command, E = env) {
      if (!this.configured(E)) return { delivered: false, pending: true, reason: 'transport_not_configured' };
      const vc = mapVendorCommand('apple_mdm', command.type);
      if (!vc) return { delivered: false, pending: false, reason: 'unsupported_command' };
      // Apple MDM：命令已入队，APNs 只负责「唤醒」设备来 PUT ServerURL 取命令（见 mdm-apple.js + /api/mdm/apple）。
      if (!device.mdm_push_token || !device.mdm_push_magic) return { delivered: false, pending: true, reason: 'not_enrolled' };   // 设备还没 check-in 上报 APNs 凭据
      try {
        const jwt = buildApnsJwt(E);
        const http2 = require('http2');
        await apnsPush(http2, jwt, device.mdm_push_token, device.mdm_push_magic, E('MDM_APNS_TOPIC'), E);
        return { delivered: true, pending: true, reason: 'apns_woke_awaiting_pull', vendor: vc };
      } catch (e) { return { delivered: false, pending: false, reason: 'apns_failed', detail: e.message }; }
    },
  },
  google_chrome: {
    key: 'google_chrome', label: 'Chromebook（Chrome Management API）', kinds: ['google'],
    envKeys: ['GOOGLE_SA_CLIENT_EMAIL', 'GOOGLE_SA_PRIVATE_KEY', 'GOOGLE_ADMIN_SUBJECT', 'GOOGLE_CUSTOMER_ID'],
    configured: (E = env) => !!(googleSAConfigured(E) && E('GOOGLE_ADMIN_SUBJECT')),
    async deliver(device, command, E = env) {
      if (!this.configured(E)) return { delivered: false, pending: true, reason: 'transport_not_configured' };
      const vc = mapVendorCommand('google_chrome', command.type);
      if (!vc) return { delivered: false, pending: false, reason: 'unsupported_command' };
      if (!device.ext_device_id) return { delivered: false, pending: false, reason: 'no_ext_device_id' };
      try {
        const token = await googleAccessToken('https://www.googleapis.com/auth/admin.directory.device.chromeos', E('GOOGLE_ADMIN_SUBJECT'), E);
        const customer = E('GOOGLE_CUSTOMER_ID') || 'my_customer';
        const r = await fetch(`https://admin.googleapis.com/admin/directory/v1/customer/${customer}/devices/chromeos/${encodeURIComponent(device.ext_device_id)}/commands`, {
          method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ commandType: vc }), signal: AbortSignal.timeout(15000),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return { delivered: false, pending: false, reason: 'chrome_api_error', detail: (j.error && j.error.message) || r.status };
        return { delivered: true, pending: false, reason: 'issued', vendor: vc, ext_command_id: j.commandId };
      } catch (e) { return { delivered: false, pending: false, reason: 'chrome_failed', detail: e.message }; }
    },
  },
  android_mgmt: {
    key: 'android_mgmt', label: 'Android（Android Management API）', kinds: ['google'],
    envKeys: ['GOOGLE_SA_CLIENT_EMAIL', 'GOOGLE_SA_PRIVATE_KEY', 'ANDROID_ENTERPRISE_NAME'],
    configured: (E = env) => !!(googleSAConfigured(E) && E('ANDROID_ENTERPRISE_NAME')),
    async deliver(device, command, E = env) {
      if (!this.configured(E)) return { delivered: false, pending: true, reason: 'transport_not_configured' };
      if (!device.ext_device_id) return { delivered: false, pending: false, reason: 'no_ext_device_id' };   // 完整资源名 enterprises/LC.../devices/xxx
      // 擦除：Android Management API 没有 WIPE 命令，删除设备资源即触发恢复出厂
      if (command.type === 'wipe') {
        try {
          const token = await googleAccessToken('https://www.googleapis.com/auth/androidmanagement', null, E);
          const r = await fetch(`https://androidmanagement.googleapis.com/v1/${device.ext_device_id}?wipeDataFlags=WIPE_EXTERNAL_STORAGE`, {
            method: 'DELETE', headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000),
          });
          if (!r.ok) { const j = await r.json().catch(() => ({})); return { delivered: false, pending: false, reason: 'android_api_error', detail: (j.error && j.error.message) || r.status }; }
          return { delivered: true, pending: false, reason: 'issued', vendor: 'DELETE(wipe)' };
        } catch (e) { return { delivered: false, pending: false, reason: 'android_failed', detail: e.message }; }
      }
      const vc = mapVendorCommand('android_mgmt', command.type);
      if (!vc) return { delivered: false, pending: false, reason: 'unsupported_command' };
      try {
        const token = await googleAccessToken('https://www.googleapis.com/auth/androidmanagement', null, E);
        const r = await fetch(`https://androidmanagement.googleapis.com/v1/${device.ext_device_id}:issueCommand`, {
          method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: vc }), signal: AbortSignal.timeout(15000),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) return { delivered: false, pending: false, reason: 'android_api_error', detail: (j.error && j.error.message) || r.status };
        return { delivered: true, pending: false, reason: 'issued', vendor: vc, ext_command_name: j.name };
      } catch (e) { return { delivered: false, pending: false, reason: 'android_failed', detail: e.message }; }
    },
  },
};

// APNs HTTP/2 推送（MDM 唤醒）：发到设备的 APNs token，body 是 {"mdm":"<PushMagic>"}
function apnsPush(http2, jwt, deviceToken, pushMagic, topic, E = env) {
  return new Promise((resolve, reject) => {
    const host = E('MDM_APNS_HOST') || 'https://api.push.apple.com';
    const client = http2.connect(host);
    client.on('error', reject);
    const req = client.request({
      ':method': 'POST', ':path': '/3/device/' + deviceToken,
      authorization: 'bearer ' + jwt, 'apns-topic': topic, 'apns-push-type': 'mdm',
    });
    let status = 0, data = '';
    req.on('response', (h) => { status = h[':status']; });
    req.on('data', (d) => data += d);
    req.on('end', () => { client.close(); status === 200 ? resolve(true) : reject(new Error('APNs ' + status + ' ' + data)); });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('APNs timeout')));
    req.end(JSON.stringify({ mdm: pushMagic }));
  });
}

// ── 从厂商侧拉取设备列表（省掉手填 ext_device_id）──
// Android：列 Enterprise 下的受管设备（name=资源名即 ext_device_id）。Chromebook：列域内 ChromeOS 设备（deviceId）。
// ⚠️ gated + try/catch；真实调用需凭据，本机无法联调。
async function listVendorDevices(transport, E = env) {
  if (transport === 'android_mgmt') {
    if (!TRANSPORTS.android_mgmt.configured(E)) return { ok: false, reason: 'transport_not_configured' };
    const token = await googleAccessToken('https://www.googleapis.com/auth/androidmanagement', null, E);
    const r = await fetch(`https://androidmanagement.googleapis.com/v1/${E('ANDROID_ENTERPRISE_NAME')}/devices?pageSize=100`, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, reason: 'api_error', detail: (j.error && j.error.message) || r.status };
    return { ok: true, devices: (j.devices || []).map(d => ({ ext_device_id: d.name, model: (d.hardwareInfo || {}).model || '', brand: (d.hardwareInfo || {}).brand || '', serial: (d.hardwareInfo || {}).serialNumber || '', state: d.appliedState || d.state || '' })) };
  }
  if (transport === 'google_chrome') {
    if (!TRANSPORTS.google_chrome.configured(E)) return { ok: false, reason: 'transport_not_configured' };
    const token = await googleAccessToken('https://www.googleapis.com/auth/admin.directory.device.chromeos', E('GOOGLE_ADMIN_SUBJECT'), E);
    const customer = E('GOOGLE_CUSTOMER_ID') || 'my_customer';
    const r = await fetch(`https://admin.googleapis.com/admin/directory/v1/customer/${customer}/devices/chromeos?maxResults=100&projection=BASIC`, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, reason: 'api_error', detail: (j.error && j.error.message) || r.status };
    return { ok: true, devices: (j.chromeosdevices || []).map(d => ({ ext_device_id: d.deviceId, model: d.model || '', serial: d.serialNumber || '', state: d.status || '', user: d.annotatedUser || '' })) };
  }
  return { ok: false, reason: 'unsupported_transport' };
}

// ── Android：建 enrollment token（设备在开机设置/afw#setup 时用它纳管进 Enterprise）──
// 先 best-effort 确保策略存在（空策略即可纳管），再建 token；返回 token 值 + qrCode(JSON 字符串) + 过期时间。
async function createAndroidEnrollmentToken(opts = {}, E = env) {
  if (!TRANSPORTS.android_mgmt.configured(E)) return { ok: false, reason: 'transport_not_configured' };
  const ent = E('ANDROID_ENTERPRISE_NAME');
  const token = await googleAccessToken('https://www.googleapis.com/auth/androidmanagement', null, E);
  const policyId = String(opts.policy || 'default').replace(/[^\w-]/g, '') || 'default';
  const policyName = `${ent}/policies/${policyId}`;
  try { await fetch(`https://androidmanagement.googleapis.com/v1/${policyName}`, { method: 'PATCH', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(15000) }); } catch (_) {}
  const dur = Math.max(300, Math.min(Number(opts.duration) || 3600, 7776000));   // 5 分钟 ~ 90 天
  const r = await fetch(`https://androidmanagement.googleapis.com/v1/${ent}/enrollmentTokens`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ policyName, duration: dur + 's' }), signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, reason: 'api_error', detail: (j.error && j.error.message) || r.status };
  return { ok: true, value: j.value, qrCode: j.qrCode, expiration: j.expirationTimestamp, name: j.name, policyName };
}

function transportByKey(k) { return TRANSPORTS[k] || TRANSPORTS.pull_agent; }
function transportForDevice(device) { return transportByKey((device && device.transport) || 'pull_agent'); }
function transportKeys() { return Object.keys(TRANSPORTS); }
/** 给管理端 UI：各传输的 key/label/是否已配凭据/适用设备类型/所需 env（E=组织 getter 时反映该组织是否已配） */
function transportsMeta(E = env) {
  return Object.values(TRANSPORTS).map(t => ({ key: t.key, label: t.label, configured: t.configured(E), kinds: t.kinds, envKeys: t.envKeys || [] }));
}
/** 下发：把命令送到设备的传输通道。pull_agent 返回 await_agent（排队等拉取），厂商通道已配则尝试真实下发。E=设备所属组织的 env getter */
async function deliverCommand(device, command, E = env) {
  const t = transportForDevice(device);
  try { return Object.assign({ transport: t.key }, await t.deliver(device, command, E)); }
  catch (e) { return { transport: t.key, delivered: false, pending: false, reason: 'deliver_error', detail: e.message }; }
}

// 兼容旧调用：transportConfigured() 现表示「Apple APNs 是否已配」（设备列表徽章仍用）
function transportConfigured(E = env) { return TRANSPORTS.apple_mdm.configured(E); }
/** 旧 pushWake 名保留：pull_agent 设备的唤醒仍是 no-op（靠轮询），厂商设备走 deliverCommand */
async function pushWake(device, command) {
  if (!device || (device.transport || 'pull_agent') === 'pull_agent') return { pushed: false, reason: 'await_agent' };
  const r = await deliverCommand(device, command || { type: 'noop' });
  return { pushed: !!r.delivered, reason: r.reason, detail: r.detail };
}

module.exports = {
  COMMAND_TYPES, DANGER_CONFIRM, isCommandType, validateCommand,
  genEnrollSecret, hashSecret, verifySecret, transportConfigured, pushWake,
  // v3.5.84 多传输
  TRANSPORTS, mapVendorCommand, transportByKey, transportForDevice, transportKeys, transportsMeta, deliverCommand,
  buildGoogleAssertion, buildApnsJwt, googleSAConfigured,
  // v3.5.87 厂商设备拉取 + Android 纳管 token
  listVendorDevices, createAndroidEnrollmentToken,
};
