// 手机号国家码 + 区号路由单测（v3.5.71）：parsePhone/normalizePhone/isPhone/区号通道路由
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE sms_channels (id TEXT PRIMARY KEY, country_code TEXT UNIQUE, label TEXT DEFAULT '', config TEXT, enabled INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0);
CREATE TABLE oauth_subjects (id TEXT PRIMARY KEY, msg_config TEXT, sms_channels TEXT);`);
db.exec("INSERT INTO sms_channels (id,country_code,label,config,enabled) VALUES ('c1','+852','香港','{\"QWQ_MESSAGE_URL\":\"https://hk.msg\",\"QWQ_MESSAGE_KEY\":\"k_hk\",\"QWQ_MESSAGE_SMS_GROUP\":\"sms-hk\"}',1)");
// 先 INSERT 组织行，再 UPDATE 其字段（避免 UPDATE 作用在不存在行上被静默吞掉）
db.exec("INSERT INTO oauth_subjects (id) VALUES ('o1')");
db.exec("INSERT INTO oauth_subjects (id) VALUES ('o2')");

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log(`${c ? '✓' : '✗'} ${n}`); };

// 复刻 api.js 的纯逻辑（含修复后的 parsePhone：国家码前缀表匹配）
process.env.DEFAULT_PHONE_CC = '+86';
const PHONE_CCS = ['+852','+853','+855','+856','+880','+886','+998','+996','+995','+994','+993','+992','+977','+976','+975','+974','+973','+972','+971','+970','+968','+967','+966','+965','+964','+963','+962','+961','+960','+94','+93','+92','+91','+90','+86','+84','+82','+81','+66','+65','+64','+63','+62','+61','+60','+58','+57','+56','+55','+54','+53','+52','+51','+49','+48','+47','+46','+45','+44','+43','+41','+40','+39','+36','+34','+33','+32','+31','+30','+27','+20','+7','+1'];
function parsePhone(s) { const t = String(s || '').trim(); if (!t.startsWith('+')) return null; const cc = PHONE_CCS.find(c => t.startsWith(c)); if (!cc) return null; const local = t.slice(cc.length); return local ? { cc, local } : null; }
function defaultPhoneCC() { const v = String(process.env.DEFAULT_PHONE_CC || '+86').trim(); return /^\+\d{1,4}$/.test(v) ? v : '+86'; }
function normalizePhone(s) { const t = String(s || '').trim(); if (/^\+\d{1,4}\d{4,15}$/.test(t)) return t; if (/^1[3-9]\d{9}$/.test(t)) return defaultPhoneCC() + t; return t; }
const isPhone = s => { const p = parsePhone(s); if (!p) return false; if (p.cc === '+86') return /^1[3-9]\d{9}$/.test(p.local); return /^\d{4,15}$/.test(p.local); };
function smsOverrideFor(phone, orgId) {
  const p = parsePhone(phone); const cc = p ? p.cc : defaultPhoneCC();
  if (orgId) { try { const s = db.prepare('SELECT * FROM oauth_subjects WHERE id=?').get(orgId); if (s && s.sms_channels) { const m = JSON.parse(s.sms_channels); if (m[cc] && typeof m[cc] === 'object' && Object.keys(m[cc]).length) return m[cc]; } } catch (_) {} }
  try { const ch = db.prepare('SELECT * FROM sms_channels WHERE country_code=?').get(cc); if (ch && ch.enabled) { const c = JSON.parse(ch.config || '{}'); if (Object.keys(c).length) return c; } } catch (_) {}
  if (orgId) { try { const s = db.prepare('SELECT * FROM oauth_subjects WHERE id=?').get(orgId); if (s && s.msg_config) { const c = JSON.parse(s.msg_config); if (Object.keys(c).length) return c; } } catch (_) {} }
  return undefined;
}

// parsePhone / normalizePhone / isPhone
ok('parsePhone +86', JSON.stringify(parsePhone('+8613800000000')) === JSON.stringify({ cc: '+86', local: '13800000000' }));
ok('parsePhone +852', JSON.stringify(parsePhone('+85212345678')) === JSON.stringify({ cc: '+852', local: '12345678' }));
ok('parsePhone +1', JSON.stringify(parsePhone('+14155552671')) === JSON.stringify({ cc: '+1', local: '4155552671' }));
ok('normalizePhone 裸 11 位补 +86', normalizePhone('13800000000') === '+8613800000000');
ok('normalizePhone 带码原样', normalizePhone('+85212345678') === '+85212345678');
ok('isPhone +86 合法', isPhone('+8613800000000') === true);
ok('isPhone 裸 11 位（无 +）不合法', isPhone('13800000000') === false);
ok('isPhone +852 宽松合法', isPhone('+85212345678') === true);

// smsOverrideFor 区号路由
ok('+852 走全局区号通道', JSON.stringify(smsOverrideFor('+85212345678', null)) === JSON.stringify({ QWQ_MESSAGE_URL: 'https://hk.msg', QWQ_MESSAGE_KEY: 'k_hk', QWQ_MESSAGE_SMS_GROUP: 'sms-hk' }));
ok('+86 无全局通道 → undefined（回退全局 env）', smsOverrideFor('+8613800000000', null) === undefined);
// 组织覆盖某区号
db.prepare("UPDATE oauth_subjects SET sms_channels=? WHERE id='o1'").run(JSON.stringify({ '+86': { QWQ_MESSAGE_URL: 'https://org.msg', QWQ_MESSAGE_KEY: 'k_org', QWQ_MESSAGE_SMS_GROUP: 'sms-org' } }));
ok('组织覆盖 +86', JSON.stringify(smsOverrideFor('+8613800000000', 'o1')) === JSON.stringify({ QWQ_MESSAGE_URL: 'https://org.msg', QWQ_MESSAGE_KEY: 'k_org', QWQ_MESSAGE_SMS_GROUP: 'sms-org' }));
ok('组织覆盖不影响 +852（仍走全局区号通道）', JSON.stringify(smsOverrideFor('+85212345678', 'o1')) === JSON.stringify({ QWQ_MESSAGE_URL: 'https://hk.msg', QWQ_MESSAGE_KEY: 'k_hk', QWQ_MESSAGE_SMS_GROUP: 'sms-hk' }));
// 组织默认 msg_config 兜底
db.prepare("UPDATE oauth_subjects SET msg_config=? WHERE id='o2'").run(JSON.stringify({ QWQ_MESSAGE_URL: 'https://default.msg', QWQ_MESSAGE_KEY: 'k_default', QWQ_MESSAGE_SMS_GROUP: 'sms-default' }));
ok('组织默认 msg_config 兜底 +86', JSON.stringify(smsOverrideFor('+8613800000000', 'o2')) === JSON.stringify({ QWQ_MESSAGE_URL: 'https://default.msg', QWQ_MESSAGE_KEY: 'k_default', QWQ_MESSAGE_SMS_GROUP: 'sms-default' }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
