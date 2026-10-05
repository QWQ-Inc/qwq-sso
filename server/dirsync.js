// 通讯录同步的「驱动」登记处（v3.5.59）：同步源按 type 找对应的实现。
//   wecom  → dirsync-wecom.js（企业微信）
//   feishu → dirsync-feishu.js（飞书企业自建应用）
// 各驱动对外提供同名函数：effectiveCfg / deptIdsOf / fetchScopeTree / sync / corpScope / corpUsers / corpOfProvider /
//   loginProviderChoices / bindProvidersFor / memberStatus / setMemberEnabled / deleteMember / isGoneError / writeCfg
const W = require('./dirsync-wecom');
const F = require('./dirsync-feishu');

const wecom = {
  type: 'wecom', label: '企业微信', SRC: 'wecom',
  effectiveCfg: W.effectiveCfg, writeCfg: W.writeCfg, deptIdsOf: W.deptIdsOf, fetchScopeTree: W.fetchScopeTree,
  sync: W.syncWecom, corpScope: W.corpScope, corpUsers: W.corpUsers, corpOfProvider: W.corpOfProvider,
  loginProviderChoices: W.loginProviderChoices, bindProvidersFor: W.bindProvidersFor,
  memberStatus: W.memberStatus, setMemberEnabled: W.setMemberEnabled, deleteMember: W.deleteMember,
  isGoneError: (e) => e && e.errcode === 60111, LIMITED_HINT: W.LIMITED_HINT,
};
const DRIVERS = { wecom, feishu: F };
/** 同步源 type → 驱动；不认识的返回 null */
function driver(type) { return DRIVERS[type] || null; }
/** 登录凭证 provider key（wecom / wecom:<id> / feishu / feishu:<id>）→ 对应平台的驱动 */
function driverOfProvider(provider) { return DRIVERS[String(provider || '').split(':')[0]] || null; }
const PLATFORM_LABEL = { wecom: '企业微信', feishu: '飞书' };

module.exports = { driver, driverOfProvider, DRIVERS, PLATFORM_LABEL };
