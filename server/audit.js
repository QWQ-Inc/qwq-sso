/**
 * 防篡改审计存证链（档① 哈希链）
 *
 * 每条敏感/危险操作按发生顺序追加一行，row_hash 把「本行内容 + 上一行 row_hash」一起哈希，
 * 形成只可追加的链：任何人事后改动/删除/插入任意一行，从那一行起整条链都对不上，verifyChain() 立刻查出。
 *
 * 这是「本地防篡改 + 可自证完整性」层（档①）。若将来需要「对第三方可举证某时刻已存在」，
 * 再在此之上加可信时间戳/外部锚定（档②）——把 verifyChain().head 定期打时间戳即可，无需改本表结构。
 *
 * ⚠️ 只存**摘要**，绝不写身份证号/密钥等原文；姓名一律脱敏后再入 detail。
 */
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { db } = require('./db');

const GENESIS = '0'.repeat(64);

const headStmt = db.prepare('SELECT row_hash FROM audit_chain ORDER BY seq DESC LIMIT 1');
const insStmt = db.prepare(`INSERT INTO audit_chain (id,event_type,subject,actor,detail,created_at,prev_hash,row_hash)
  VALUES (@id,@event_type,@subject,@actor,@detail,@created_at,@prev_hash,@row_hash)`);
const listStmt = db.prepare('SELECT seq,id,event_type,subject,actor,detail,created_at,prev_hash,row_hash FROM audit_chain ORDER BY seq DESC LIMIT ? OFFSET ?');
const bySubjectStmt = db.prepare('SELECT seq,id,event_type,subject,actor,detail,created_at FROM audit_chain WHERE subject=? ORDER BY seq DESC LIMIT ?');
const countStmt = db.prepare('SELECT COUNT(*) n FROM audit_chain');
const allAscStmt = db.prepare('SELECT * FROM audit_chain ORDER BY seq ASC');

function computeHash(r) {
  return crypto.createHash('sha256')
    .update([r.id, r.event_type, r.subject || '', r.actor || '', r.detail || '', r.created_at, r.prev_hash].join('\n'))
    .digest('hex');
}

// 读链头 + 计算 + 插入 必须原子（better-sqlite3 同步，事务内无其它 JS 介入，天然不会分叉）
const _append = db.transaction((e) => {
  const head = headStmt.get();
  const prev_hash = head ? head.row_hash : GENESIS;
  const row = {
    id: e.id, event_type: e.event_type,
    subject: e.subject || null, actor: e.actor || null, detail: e.detail || null,
    created_at: e.created_at, prev_hash,
  };
  row.row_hash = computeHash(row);
  const info = insStmt.run(row);
  return { seq: Number(info.lastInsertRowid), row_hash: row.row_hash };
});

/**
 * 记一条存证。event_type 如 'kyc.verified'；opts: { subject, actor, detail }
 * detail 传对象会 JSON 序列化。失败只告警不抛（存证不该阻断主流程）。
 */
function audit(event_type, opts = {}) {
  try {
    const detail = opts.detail == null ? null
      : (typeof opts.detail === 'string' ? opts.detail : JSON.stringify(opts.detail));
    return _append({
      id: uuidv4(), event_type,
      subject: opts.subject != null ? String(opts.subject) : null,
      actor: opts.actor != null ? String(opts.actor) : null,
      detail,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('[audit] 存证写入失败:', e.message);
    return null;
  }
}

// 从 express req 推断「谁触发的」
function actorOf(req) {
  if (!req) return 'system';
  if (req.apiKey) return `apikey:${req.apiKey.id}`;
  if (req.user) return `${req.user.role === 'admin' ? 'admin' : 'user'}:${req.user.uid}`;
  return 'system';
}

// 全链完整性校验：逐行重算并检查 prev_hash 链接
function verifyChain() {
  const rows = allAscStmt.all();
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev) return { ok: false, count: rows.length, broken_seq: r.seq, reason: 'prev_hash 链断裂（有行被删除/插入/重排）' };
    if (computeHash(r) !== r.row_hash) return { ok: false, count: rows.length, broken_seq: r.seq, reason: '内容被篡改（row_hash 对不上）' };
    prev = r.row_hash;
  }
  return { ok: true, count: rows.length, head: rows.length ? prev : GENESIS };
}

function list(limit = 50, offset = 0) {
  return { total: countStmt.get().n, data: listStmt.all(Math.min(Math.max(+limit || 50, 1), 500), Math.max(+offset || 0, 0)) };
}
function bySubject(subject, limit = 100) {
  return bySubjectStmt.all(String(subject), Math.min(Math.max(+limit || 100, 1), 500));
}

module.exports = { audit, actorOf, verifyChain, list, bySubject, GENESIS, _computeHash: computeHash };
