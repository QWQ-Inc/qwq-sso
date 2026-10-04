/**
 * 系统通知（v3.5.52）—— 经 QWQ Message 分发中心推到 Webhook / 群机器人（飞书 / 钉钉 / 企业微信）
 *
 * 分发中心的分组可以是 WEBHOOK / FEISHU / DINGTALK / WECOM 等方式，调用都一样：
 *   POST /api/v1/send { group, subject, content, variables }
 * 所以这里只需要一个「通知分组编号」，管理员在分发中心建好 Webhook / 群机器人分组即可。
 *
 * 配置：
 *   QWQ_MESSAGE_NOTIFY_GROUP   通知分组编号（空 = 不推送）
 *   QWQ_MESSAGE_NOTIFY_EVENTS  推送哪些类别，逗号分隔：account,merge,grant,dirsync,backup,kyc,system,announcement；
 *                              all = 全部；留空 = 除 announcement 之外的全部
 *
 * 事件来源：
 *   · audit() 里的存证事件（注销 / 删除、合并、授权、备份、实名上限、系统更新）——audit.js 写完存证后调 fromAudit()
 *   · 直接调用 notify()：通讯录同步失败 / 发现重复账号、公告发布
 * 推送失败只记日志，绝不影响主流程；一律异步（不等分发中心返回）。
 */
const { db } = require('./db');
const { dispatch, isConfigured } = require('./message');

const CATEGORIES = {
  account: '账号注销 / 删除',
  merge: '账号合并',
  grant: '高危权限授权',
  dirsync: '通讯录同步异常',
  backup: '数据备份失败',
  kyc: '实名账号数超限',
  system: '系统更新',
  announcement: '公告发布',
};
const DEFAULT_OFF = new Set(['announcement']);

function group() { return String(process.env.QWQ_MESSAGE_NOTIFY_GROUP || '').trim(); }
function enabledCats() {
  const raw = String(process.env.QWQ_MESSAGE_NOTIFY_EVENTS || '').trim().toLowerCase();
  if (!raw) return new Set(Object.keys(CATEGORIES).filter(k => !DEFAULT_OFF.has(k)));
  if (raw === 'all' || raw === '*') return new Set(Object.keys(CATEGORIES));
  return new Set(raw.split(/[,，\s]+/).filter(k => CATEGORIES[k]));
}
function ready() { return !!(group() && isConfigured()); }
function wants(cat) { return ready() && enabledCats().has(cat); }

function fmtTime(d = new Date()) {
  const tz = process.env.WATERMARK_TZ || 'Asia/Shanghai';
  try {
    return new Intl.DateTimeFormat('zh-CN', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      .format(d).replace(/\//g, '-');
  } catch (_) { return d.toISOString().slice(0, 16).replace('T', ' '); }
}
const site = () => String(process.env.BASE_URL || '').replace(/\/+$/, '');

/** 组装并发送。返回 Promise（测试 / 手动发送时可 await；业务里调用不 await） */
async function send(cat, title, lines = []) {
  const text = [`【QWQ SSO】${title}`, ...lines.filter(Boolean), `时间：${fmtTime()}`, site() ? `站点：${site()}` : ''].filter(Boolean).join('\n');
  return dispatch({
    group: group(), subject: `[QWQ SSO] ${title}`, content: text,
    variables: { event: cat, title, time: fmtTime(), site: site() },
  });
}
/** 业务调用：按类别开关决定是否推送；不等结果、不抛错 */
function notify(cat, title, lines) {
  if (!wants(cat)) return false;
  send(cat, title, lines).catch(e => console.warn('[通知推送失败]', cat, e.message));
  return true;
}

/** 不看类别开关、只要配好了分组就推（公告弹窗里勾了「推送到 Webhook」时用） */
function notifyForce(cat, title, lines) {
  if (!ready()) return false;
  send(cat, title, lines).catch(e => console.warn('[通知推送失败]', cat, e.message));
  return true;
}
function status() { return { ready: ready(), group: group(), categories: [...enabledCats()] }; }

// ── 存证事件 → 通知 ──
const userBySeq = (seq) => { try { return db.prepare('SELECT name, uid_code, uid_seq FROM users WHERE uid_seq=?').get(Number(seq)); } catch (_) { return null; } };
const who = (seq) => {
  if (seq == null || seq === '') return '';
  const u = userBySeq(seq);
  const uid = u ? (u.uid_code || '#' + String(u.uid_seq).padStart(5, '0')) : '#' + String(seq).padStart(5, '0');
  return u && u.name ? `${u.name}（${uid}）` : uid;
};
const actorText = (a) => {
  if (!a || a === 'system') return '系统';
  const m = /^(?:admin|user):(\d+)$/.exec(a);
  return m ? who(m[1]) : a;
};
const PERM = { 'kyc.clear': '清除实名', 'user.delete': '删除账号' };
const VIA = { org_admin: '组织成员合并', kyc_self: '本人按实名合并', super_admin: '超级管理员合并', self_bind: '绑定三方账号时并入空壳账号', dir_duplicate: '企业微信重复账号合并' };

function fromAudit(type, opts = {}) {
  try {
    if (!ready()) return;
    let d = opts.detail;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = {}; } }
    d = d || {};
    const subj = who(opts.subject), by = actorText(opts.actor);
    switch (type) {
      case 'account.deletion_requested':
        return notify('account', d.needs_approval ? '有账号删除申请等待审批' : (d.kind === 'self' ? '用户申请注销账号' : '管理员发起删除账号'),
          [`账号：${subj}`, `发起：${by}`, d.execute_at ? `最早执行：${String(d.execute_at).slice(0, 16)}（UTC）` : '', d.checklist ? `交接项：${d.checklist} 项` : '']);
      case 'account.deleted':
        return notify('account', '账号已删除', [`账号：${subj}`, d.purge_at ? `保留到：${String(d.purge_at).slice(0, 10)}，之前可恢复` : '',
          d.detached && (d.detached.oauth || d.detached.links) ? `已摘除并封存三方绑定 ${d.detached.oauth || 0} 个、通讯录映射 ${d.detached.links || 0} 个` : '']);
      case 'account.restored':
        return notify('account', '已删除的账号被恢复', [`账号：${subj}`, `操作：${by}`]);
      case 'account.purged':
        return notify('account', '账号已彻底清除', [`账号：${subj}`, `操作：${by}`]);
      case 'user.merged':
        return notify('merge', '账号合并', [`保留账号：${subj}`, `并入：${(d.sources || []).map(who).join('、') || '—'}`, `方式：${VIA[d.via] || d.via || '—'}`, `操作：${by}`]);
      case 'user.merge_undone':
        return notify('merge', '撤销了一次账号合并', [`保留账号：${subj}`, `恢复：${(d.sources || []).map(who).join('、') || '—'}`, `操作：${by}`]);
      case 'admin.grant_added':
      case 'admin.grant_removed':
        return notify('grant', type === 'admin.grant_added' ? '授予了高危权限' : '撤销了高危权限',
          [`对象：${subj}`, `权限：${PERM[d.perm] || d.perm || '—'}`, `范围：${d.scope_type || '—'}${d.scope_id ? ' / ' + d.scope_id : ''}`, `操作：${by}`]);
      case 'backup.run': {
        const bad = (d.results || []).filter(r => !r.ok);
        if (!bad.length) return;
        return notify('backup', `数据备份失败（${bad.length}/${(d.results || []).length} 个目标）`, bad.map(r => `· ${r.label || '目标'}：${r.error || '未知错误'}`));
      }
      case 'kyc.account_limit':
        return notify('kyc', '同一实名的账号数达到上限，本次实名未通过', [`账号：${subj}`, `上限：${d.max} 个`, d.provider ? `服务商：${d.provider}` : '']);
      case 'system.update_applied':
        return notify('system', d.ok ? '系统已一键更新' : '系统一键更新失败', [`操作：${by}`, d.restart ? '将自动重启' : '']);
      default: return;
    }
  } catch (e) { console.warn('[通知] 处理存证事件失败', type, e.message); }
}

/** 发一条测试通知（管理端按钮），等待分发中心返回结果 */
async function testNotify(actor) {
  if (!isConfigured()) throw Object.assign(new Error('还没配置分发中心地址和密钥（QWQ_MESSAGE_URL / QWQ_MESSAGE_KEY）'), { status: 400 });
  if (!group()) throw Object.assign(new Error('请先填写「通知分组编号」（QWQ_MESSAGE_NOTIFY_GROUP）'), { status: 400 });
  const cats = [...enabledCats()].map(k => CATEGORIES[k]);
  return send('test', '测试通知', [`这是一条测试通知，说明 Webhook / 群机器人已接通。`, `操作：${actor || '管理员'}`, `已开启推送：${cats.join('、') || '（没有开启任何类别）'}`]);
}

module.exports = { notify, notifyForce, status, fromAudit, testNotify, CATEGORIES, enabledCats, ready };
