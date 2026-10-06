// 飞书出站建号单测（v3.5.70.3 + v3.5.74.1）：createMember 手机号加 +86、不传 user_id、返回 open_id、department_ids 必填
const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗'} ${n}`); };

// mock ./db（dirsync-feishu.js 顶层只 prepare，不执行）
const noopStmt = { get: () => null, all: () => [], run: () => {} };
const dbMock = { db: { prepare: () => noopStmt }, users: {}, oauth: {}, orgMembers: {}, departments: {} };

const fp = path.join(__dirname, '..', 'server', 'dirsync-feishu.js');
const inject = (req, exports) => { const r = Module._resolveFilename(req, { id: fp, filename: fp, paths: Module._nodeModulePaths(path.dirname(fp)) }); require.cache[r] = { id: r, filename: r, loaded: true, exports }; };
inject('./db', dbMock);
inject('./contacts', { importWecomContacts: () => {}, addContact: () => ({ ok: true }), listContacts: () => ({ phones: [], emails: [] }), contactLimits: () => ({ maxPhones: 10, maxEmails: 20 }), normPhone: v => v, normEmail: v => v });

// mock fetch（飞书接口）
const feishuCalls = [];
globalThis.fetch = async (url, opts) => {
  const u = new URL(url);
  const body = opts && opts.body ? JSON.parse(opts.body) : null;
  feishuCalls.push({ path: u.pathname, method: opts && opts.method, body });
  if (u.pathname === '/open-apis/auth/v3/tenant_access_token/internal') return { ok: true, json: async () => ({ tenant_access_token: 'tk', expire: 7200 }) };
  if (u.pathname === '/open-apis/contact/v3/users') return { ok: true, json: async () => ({ code: 0, data: { user: { open_id: 'ou_abc', user_id: 'emp001', name: body && body.name } } }) };
  return { ok: true, json: async () => ({ code: 0 }) };
};

const F = require('../server/dirsync-feishu');

(async () => {
  // 正常建号：具体部门 + 裸手机号
  const id = await F.createMember({ corp_id: 'cli_test', secret: 's' }, { name: '张三', mobile: '13800000001', email: 'z@x.com', department_ids: ['od_abc'] });
  const createCall = feishuCalls.find(c => c.path === '/open-apis/contact/v3/users');
  ok('返回 open_id', id === 'ou_abc');
  ok('不传 user_id', createCall && !createCall.body.user_id);
  ok('mobile 加 +86 前缀', createCall && createCall.body.mobile === '+8613800000001');
  ok('name 原样', createCall && createCall.body.name === '张三');
  ok('具体部门保留', createCall && Array.isArray(createCall.body.department_ids) && createCall.body.department_ids.includes('od_abc'));

  // 已带 + 的手机号不重复加
  feishuCalls.length = 0;
  await F.createMember({ corp_id: 'cli_test', secret: 's' }, { name: '李四', mobile: '+8613811112222', department_ids: ['od_abc'] });
  const c2 = feishuCalls.find(c => c.path === '/open-apis/contact/v3/users');
  ok('已带 + 不重复加 +86', c2 && c2.body.mobile === '+8613811112222');

  // 非法 email 不传（防 99992402）
  feishuCalls.length = 0;
  await F.createMember({ corp_id: 'cli_test', secret: 's' }, { name: '王五', email: 'bad-email', department_ids: ['od_abc'] });
  const c3 = feishuCalls.find(c => c.path === '/open-apis/contact/v3/users');
  ok('非法 email 不传', c3 && !c3.body.email);

  // 根部门 "0" → 明确报错（department_ids 必填）
  let err0 = null;
  try { await F.createMember({ corp_id: 'cli_test', secret: 's' }, { name: '赵六', department_ids: ['0'] }); } catch (e) { err0 = e; }
  ok('根部门 "0" 明确报「未确定归属部门」', !!err0 && /未确定成员归属部门/.test(err0.message));

  // 无部门 → 明确报错
  let errEmpty = null;
  try { await F.createMember({ corp_id: 'cli_test', secret: 's' }, { name: '钱七' }); } catch (e) { errEmpty = e; }
  ok('无部门明确报「未确定归属部门」', !!errEmpty && /未确定成员归属部门/.test(errEmpty.message));

  // name 为空 → 明确报错
  let errName = null;
  try { await F.createMember({ corp_id: 'cli_test', secret: 's' }, { name: '', department_ids: ['od_abc'] }); } catch (e) { errName = e; }
  ok('姓名为空明确报错', !!errName && /姓名不能为空/.test(errName.message));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
