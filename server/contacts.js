/**
 * 成员多联系方式（v3.5.24）
 *
 * 一个成员（users 行）可挂多个手机/邮箱。企业微信登录把成员的 mobile/email/biz_mail
 * 作初始数据灌进来（source=wecom*），之后管理端/用户端可增删到上限。
 *
 * ⚠️ 这些额外联系方式只作「成员资料」，不用作登录标识符。登录仍只认 users.email/users.phone
 *    （is_primary=1 的那条镜像到主字段，由 api.js 的「设为主要」接口同步）。
 *
 * 上限按组织可覆盖：oauth_subjects.max_phones / max_emails，为 0/空则回退全局
 *   MEMBER_MAX_PHONES（默认 10）/ MEMBER_MAX_EMAILS（默认 20），夹 1~50 兜底。
 */
const { v4: uuidv4 } = require('uuid');
const { db, contacts, oauthSubjects } = require('./db');

const PHONE_RE = /^1[3-9]\d{9}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 全局默认上限（环境变量，夹 1~50） */
function clampLimit(raw, dflt) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.max(1, Math.min(50, n));
}
function globalLimits() {
  return {
    maxPhones: clampLimit(process.env.MEMBER_MAX_PHONES, 10),
    maxEmails: clampLimit(process.env.MEMBER_MAX_EMAILS, 20),
  };
}

/** 某组织的联系方式上限：组织配了（>0）就用组织的，否则回退全局 */
function contactLimits(subjectId) {
  const g = globalLimits();
  if (!subjectId) return g;
  let s = null;
  try { s = oauthSubjects.get.get(subjectId); } catch (_) {}
  if (!s) return g;
  const mp = parseInt(s.max_phones, 10);
  const me = parseInt(s.max_emails, 10);
  return {
    maxPhones: mp > 0 ? Math.max(1, Math.min(50, mp)) : g.maxPhones,
    maxEmails: me > 0 ? Math.max(1, Math.min(50, me)) : g.maxEmails,
  };
}

/** 归一化：非法返回 null */
function normPhone(v) {
  const s = String(v ?? '').trim();
  return PHONE_RE.test(s) ? s : null;
}
function normEmail(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return EMAIL_RE.test(s) ? s : null;
}
function normValue(kind, v) {
  return kind === 'phone' ? normPhone(v) : (kind === 'email' ? normEmail(v) : null);
}

/**
 * 添加一个联系方式（静默，不抛）。
 * @returns {{ok:true,id}|{ok:false,skip:'bad'|'dup'|'limit'}}
 */
function addContact(userId, kind, value, source = 'manual', subjectId = null) {
  if (!userId || (kind !== 'phone' && kind !== 'email')) return { ok: false, skip: 'bad' };
  const val = normValue(kind, value);
  if (!val) return { ok: false, skip: 'bad' };
  if (contacts.exists.get(userId, kind, val)) return { ok: false, skip: 'dup' };
  const { maxPhones, maxEmails } = contactLimits(subjectId);
  const cap = kind === 'phone' ? maxPhones : maxEmails;
  const n = contacts.countKind.get(userId, kind).n;
  if (n >= cap) return { ok: false, skip: 'limit', cap };
  const id = uuidv4();
  contacts.insert.run(id, userId, kind, val, source, 0);
  return { ok: true, id };
}

/** 列出某用户的联系方式，分组为 {phones, emails} */
function listContacts(userId) {
  const rows = contacts.byUser.all(userId);
  const pick = r => ({ id: r.id, value: r.value, source: r.source, is_primary: !!r.is_primary, created_at: r.created_at });
  return {
    phones: rows.filter(r => r.kind === 'phone').map(pick),
    emails: rows.filter(r => r.kind === 'email').map(pick),
  };
}

/**
 * 从企业微信 /cgi-bin/user/get 响应导入联系方式（静默跳过空字段/权限不足）。
 * 企微每个成员只有 1 个 mobile、1 个 email（个人）、1 个 biz_mail（企业邮箱）。
 */
function importWecomContacts(userId, d, subjectId = null) {
  if (!userId || !d) return;
  const res = [];
  if (d.mobile)   res.push(['phone', d.mobile, 'wecom']);
  if (d.email)    res.push(['email', d.email, 'wecom']);
  if (d.biz_mail) res.push(['email', d.biz_mail, 'wecom_biz']);
  res.forEach(([kind, val, src]) => {
    try { addContact(userId, kind, val, src, subjectId); } catch (_) {}
  });
}

module.exports = {
  contactLimits, globalLimits,
  normPhone, normEmail, normValue,
  addContact, listContacts, importWecomContacts,
};
