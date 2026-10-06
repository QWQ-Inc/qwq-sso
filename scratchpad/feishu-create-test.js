// 飞书出站建号单测（v3.5.70.3）：createMember 手机号加 +86、不传 user_id、返回 open_id
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
  const id = await F.createMember({ corp_id: 'cli_test', secret: 's' }, { name: '张三', mobile: '13800000001', email: 'z@x.com', department_ids: ['0'] });
  const createCall = feishuCalls.find(c => c.path === '/open-apis/contact/v3/users');
  ok('返回 open_id', id === 'ou_abc');
  ok('不传 user_id', createCall && !createCall.body.user_id);
  ok('mobile 加 +86 前缀', createCall && createCall.body.mobile === '+8613800000001');
  ok('name 原样', createCall && createCall.body.name === '张三');
  ok('department_ids 传字符串数组', createCall && Array.isArray(createCall.body.department_ids) && createCall.body.department_ids.includes('0'));
  // 已带 + 的手机号不重复加
  feishuCalls.length = 0;
  await F.createMember({ corp_id: 'cli_test', secret: 's' }, { name: '李四', mobile: '+8613811112222', department_ids: ['0'] });
  const c2 = feishuCalls.find(c => c.path === '/open-apis/contact/v3/users');
  ok('已带 + 不重复加 +86', c2 && c2.body.mobile === '+8613811112222');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
