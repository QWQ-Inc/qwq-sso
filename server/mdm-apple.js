/**
 * Apple MDM 协议：纳管描述文件（.mobileconfig）生成 + 命令翻译（v3.5.88）
 *
 * 设备侧流程（Apple MDM over HTTP + plist）：
 *   1) 设备装「纳管描述文件」(.mobileconfig，内含 com.apple.mdm 载荷：ServerURL / CheckInURL / Topic)。
 *   2) 设备 PUT CheckInURL：Authenticate（announce）→ TokenUpdate（上报 APNs Token + PushMagic）→ 存库。
 *   3) 服务端用 APNs（MDM_APNS_*）推 {"mdm":"<PushMagic>"} 唤醒设备。
 *   4) 设备 PUT ServerURL：Status=Idle → 服务端回下一条命令（plist）；设备执行后 Status=Acknowledged + CommandUUID。
 *
 * ⚠️ 鉴权：没有 SCEP / 设备身份证书时，用「每设备随机 token 嵌在 ServerURL 路径里」做最小鉴权
 *    （只有装了该描述文件的设备知道 token）。生产环境应再加 SCEP 下发设备证书 + 校验 Mdm-Signature，
 *    本文件只做到 token 级，拿到 Apple MDM 推送证书联调时再加签名校验。
 *
 * 真机 enroll 需要 Apple MDM 推送证书（MDM_APNS_TOPIC 等）；无证书时描述文件仍可生成，但 APNs 唤醒不可用。
 */
'use strict';
const crypto = require('crypto');
const plist = require('./plist');

/** 生成一台设备的纳管描述文件（.mobileconfig XML）。token 明文嵌进 URL；topic=APNs 推送主题。 */
function buildEnrollProfile(device, { base, token, topic, orgName }) {
  const b = String(base || '').replace(/\/$/, '');
  const server = `${b}/api/mdm/apple/${token}`;
  const mdmPayload = {
    PayloadType: 'com.apple.mdm',
    PayloadVersion: 1,
    PayloadIdentifier: 'us.qwq.sso.mdm',
    PayloadUUID: crypto.randomUUID().toUpperCase(),
    PayloadDisplayName: 'QWQ SSO 设备管理',
    ServerURL: server,
    CheckInURL: server + '/checkin',
    Topic: topic || '',
    AccessRights: 8191,                 // 全部权限
    CheckOutWhenRemoved: true,
    ServerCapabilities: ['com.apple.mdm.per-user-connections'],
    // ⚠️ 无 SCEP：此处不引用 IdentityCertificateUUID。真机严格模式可能要求设备身份证书，
    //    生产应另加一个 com.apple.security.scep 载荷并在此 IdentityCertificateUUID 指向它。
  };
  const profile = {
    PayloadType: 'Configuration',
    PayloadVersion: 1,
    PayloadIdentifier: 'us.qwq.sso.enroll.' + device.id,
    PayloadUUID: crypto.randomUUID().toUpperCase(),
    PayloadDisplayName: (orgName ? orgName + ' · ' : '') + 'QWQ SSO 设备纳管',
    PayloadDescription: '安装后本设备将由管理员纳管（可远程锁定 / 擦除 / 下发配置）。',
    PayloadContent: [mdmPayload],
  };
  return plist.encode(profile);
}

/**
 * 把本系统的 device_commands 行翻译成 MDM 命令 plist。
 * @param cmd  { id(CommandUUID), type, payload(obj) }
 * @param ctx  { profile } push/remove_profile 时传入 mdm_profiles 行
 * @returns {{xml:string, requestType:string}} 或 null（该命令 iOS 不支持 / 缺前置条件）
 */
function commandToMdm(cmd, ctx = {}) {
  const p = cmd.payload || {};
  let Command = null;
  switch (cmd.type) {
    case 'lock':
      Command = { RequestType: 'DeviceLock' };
      if (p.message) Command.Message = String(p.message);
      if (p.pin) Command.PIN = String(p.pin);           // 6 位，仅 macOS 生效
      break;
    case 'restart':
      Command = { RequestType: 'RestartDevice' };
      break;
    case 'clear_passcode':
      // ClearPasscode 需要该设备 TokenUpdate 时上报的 UnlockToken
      if (!ctx.unlockToken) return { unsupported: true, reason: 'no_unlock_token' };
      Command = { RequestType: 'ClearPasscode', UnlockToken: plist.data(ctx.unlockToken) };
      break;
    case 'wipe':
      Command = { RequestType: 'EraseDevice' };
      if (p.pin) Command.PIN = String(p.pin);
      break;
    case 'push_profile': {
      const mc = ctx.profile && mobileconfigOf(ctx.profile);
      if (!mc) return { unsupported: true, reason: 'profile_not_mobileconfig' };
      Command = { RequestType: 'InstallProfile', Payload: plist.data(Buffer.from(mc, 'utf8').toString('base64')) };
      break;
    }
    case 'remove_profile': {
      const ident = ctx.profile && profileIdentifierOf(ctx.profile);
      if (!ident) return { unsupported: true, reason: 'profile_no_identifier' };
      Command = { RequestType: 'RemoveProfile', Identifier: ident };
      break;
    }
    case 'unlock':
      // iOS 无「远程解锁」MDM 命令；回 no-op 让它被确认掉
      return { noop: true };
    default:
      return null;   // locate / retire / custom 等 iOS MDM 无直接对应
  }
  return { xml: plist.encode({ CommandUUID: cmd.id, Command }), requestType: Command.RequestType };
}

// mdm_profiles.payload 里若带 mobileconfig（XML 文本或 base64），取出 XML 文本
function mobileconfigOf(profile) {
  let pl = {};
  try { pl = typeof profile.payload === 'string' ? JSON.parse(profile.payload) : (profile.payload || {}); } catch (_) { return null; }
  if (pl.mobileconfig) {
    const s = String(pl.mobileconfig).trim();
    if (s.startsWith('<')) return s;                              // 已是 XML
    try { return Buffer.from(s, 'base64').toString('utf8'); } catch (_) { return null; }   // base64
  }
  return null;
}
function profileIdentifierOf(profile) {
  let pl = {};
  try { pl = typeof profile.payload === 'string' ? JSON.parse(profile.payload) : (profile.payload || {}); } catch (_) { return null; }
  return pl.PayloadIdentifier || pl.identifier || null;
}

module.exports = { buildEnrollProfile, commandToMdm, mobileconfigOf, profileIdentifierOf };
