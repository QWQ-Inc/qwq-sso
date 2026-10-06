// 出站 provisioning 单测（v3.5.69）：企业微信 upsertMember 建号 / userid 冲突增补（多部门不覆盖）
const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗'} ${n}`); };

// ── mock ./db（dirsync-wecom.js 顶层只 prepare，不执行；给空 stmt 即可）──
const noopStmt = { get: () => null, all: () => [], run: () => {} };
const dbMock = {
  db: { prepare: () => noopStmt },
  users: {}, oauth: {}, orgMembers: {}, oauthSubjects: {}, departments: {},
};
// ── mock ./contacts ──
const contactsMock = { importWecomContacts: () => {}, addContact: () => ({ ok: true }), listContacts: () => ({ phones: [], emails: [] }), contactLimits: () => ({ maxPhones: 10, maxEmails: 20 }), normPhone: v => v, normEmail: v => v };

const wp = path.join(__dirname, '..', 'server', 'dirsync-wecom.js');
const inject = (req, exports) => { const r = Module._resolveFilename(req, { id: wp, filename: wp, paths: Module._nodeModulePaths(path.dirname(wp)) }); require.cache[r] = { id: r, filename: r, loaded: true, exports }; };
inject('./db', dbMock);
inject('./contacts', contactsMock);

// ── mock fetch（企业微信接口）──
const wecomCalls = [];
let wecomCreateResp = { errcode: 0, errmsg: 'ok' };   // 可配置：60106 = userid 已存在
let wecomExistingDept = [10, 20];                       // user/get 返回的现有部门
globalThis.fetch = async (url, opts) => {
  const u = new URL(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  wecomCalls.push({ path: u.pathname, method: opts && opts.method, body, params: Object.fromEntries(u.searchParams) });
  if (u.pathname === '/cgi-bin/gettoken') return { ok: true, json: async () => ({ access_token: 'tok' }) };
  if (u.pathname === '/cgi-bin/user/create') return { ok: true, json: async () => wecomCreateResp };
  if (u.pathname === '/cgi-bin/user/get') return { ok: true, json: async () => ({ userid: body ? null : 'u1', name: '张三', department: wecomExistingDept }) };
  if (u.pathname === '/cgi-bin/user/update') return { ok: true, json: async () => ({ errcode: 0, errmsg: 'ok' }) };
  return { ok: true, json: async () => ({ errcode: 0 }) };
};

const W = require('../server/dirsync-wecom');

(async () => {
  // ① 建号成功：user/create 成功 → 返回 userid，不触发 update
  wecomCreateResp = { errcode: 0, errmsg: 'ok' };
  wecomCalls.length = 0;
  const id1 = await W.upsertMember({ corp_id: 'corp', secret: 's', write_secret: 'ws' }, { userid: 'u100', name: '张三', mobile: '13800000001', department: [1] });
  ok('建号成功返回 userid', id1 === 'u100');
  ok('建号走 user/create 且带 department', wecomCalls.some(c => c.path === '/cgi-bin/user/create' && c.body && c.body.department && c.body.department.includes('1')));
  ok('建号成功不触发 user/update', !wecomCalls.some(c => c.path === '/cgi-bin/user/update'));

  // ② userid 冲突（60106）→ 增补部门（读现有 [10,20] → 并集 [10,20,1]，不覆盖）
  wecomCreateResp = { errcode: 60106, errmsg: 'UserID 已存在' };
  wecomExistingDept = [10, 20];
  wecomCalls.length = 0;
  const id2 = await W.upsertMember({ corp_id: 'corp', secret: 's', write_secret: 'ws' }, { userid: 'u100', name: '张三', mobile: '13800000001', department: [1] });
  ok('冲突后返回原 userid', id2 === 'u100');
  const upd = wecomCalls.find(c => c.path === '/cgi-bin/user/update');
  ok('冲突后走 user/update', !!upd);
  ok('增补部门（并集含现有 10/20 与新的 1）', upd && Array.isArray(upd.body.department) && [10, 20, 1].every(d => upd.body.department.includes(String(d))));
  ok('部门数 = 3（未覆盖成单部门）', upd && upd.body.department.length === 3);

  // ③ 非 60106 错误 → 直接抛（不误走 update）
  wecomCreateResp = { errcode: 48002, errmsg: '无写权限' };
  wecomCalls.length = 0;
  let threw = false;
  try { await W.upsertMember({ corp_id: 'corp', secret: 's', write_secret: 'ws' }, { userid: 'u100', name: '张三', department: [1] }); }
  catch (e) { threw = e.errcode === 48002; }
  ok('非 60106 错误直接抛（不误增补）', threw && !wecomCalls.some(c => c.path === '/cgi-bin/user/update'));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
