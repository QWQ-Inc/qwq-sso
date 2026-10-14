/**
 * 直连 IPP 打印（v3.5.99，Phase 2）—— 零依赖手写最小 IPP 客户端。
 * 服务器网络可达的网络打印机：直接把文档用 IPP Print-Job（operation 0x0002）POST 到打印机的
 * ipp(s):// 端点（通常 ipp://host:631/ipp/print）。云部署通常够不到局域网打印机，故此为辅、gated。
 *
 * 只实现 Print-Job 一个操作，够用；按 RFC 8010（编码）/ RFC 8011（语义）写。
 */
const http = require('http');
const https = require('https');

// value-tags（RFC 8010 §3.5.2）
const TAG = { opAttrs: 0x01, jobAttrs: 0x02, endAttrs: 0x03,
  integer: 0x21, boolean: 0x22, enumv: 0x23,
  charset: 0x47, naturalLanguage: 0x48, uri: 0x45, keyword: 0x44,
  nameWithoutLanguage: 0x42, mimeMediaType: 0x49, textWithoutLanguage: 0x41 };

const MEDIA = { A4: 'iso_a4_210x297mm', LETTER: 'na_letter_8.5x11in', LEGAL: 'na_legal_8.5x14in', A3: 'iso_a3_297x420mm', A5: 'iso_a5_148x210mm' };
function mediaKeyword(m) { return MEDIA[String(m || 'A4').toUpperCase()] || null; }

let REQ_ID = 1;

function strAttr(tag, name, value) {
  const n = Buffer.from(name, 'utf8'), v = Buffer.from(String(value), 'utf8');
  const b = Buffer.alloc(1 + 2 + n.length + 2 + v.length);
  let o = 0; b.writeUInt8(tag, o); o += 1;
  b.writeUInt16BE(n.length, o); o += 2; n.copy(b, o); o += n.length;
  b.writeUInt16BE(v.length, o); o += 2; v.copy(b, o);
  return b;
}
function intAttr(name, value) {
  const n = Buffer.from(name, 'utf8');
  const b = Buffer.alloc(1 + 2 + n.length + 2 + 4);
  let o = 0; b.writeUInt8(TAG.integer, o); o += 1;
  b.writeUInt16BE(n.length, o); o += 2; n.copy(b, o); o += n.length;
  b.writeUInt16BE(4, o); o += 2; b.writeInt32BE(value | 0, o);
  return b;
}

// 组装 Print-Job 请求字节（含文档数据）
function buildPrintJob(printerUri, data, opts = {}) {
  const reqId = (REQ_ID++) & 0x7fffffff;
  const parts = [];
  const head = Buffer.alloc(8);
  head.writeUInt8(0x01, 0); head.writeUInt8(0x01, 1);   // version 1.1
  head.writeUInt16BE(0x0002, 2);                         // operation-id Print-Job
  head.writeUInt32BE(reqId, 4);                          // request-id
  parts.push(head);

  parts.push(Buffer.from([TAG.opAttrs]));
  parts.push(strAttr(TAG.charset, 'attributes-charset', 'utf-8'));           // 必须第一条
  parts.push(strAttr(TAG.naturalLanguage, 'attributes-natural-language', 'en'));
  parts.push(strAttr(TAG.uri, 'printer-uri', printerUri));
  parts.push(strAttr(TAG.nameWithoutLanguage, 'requesting-user-name', String(opts.user || 'qwq-sso').slice(0, 64)));
  parts.push(strAttr(TAG.nameWithoutLanguage, 'job-name', String(opts.docName || 'document').slice(0, 120)));
  parts.push(strAttr(TAG.mimeMediaType, 'document-format', String(opts.mime || 'application/octet-stream')));

  parts.push(Buffer.from([TAG.jobAttrs]));
  parts.push(intAttr('copies', Math.max(1, Math.min(99, opts.copies || 1))));
  parts.push(strAttr(TAG.keyword, 'sides', opts.duplex ? 'two-sided-long-edge' : 'one-sided'));
  parts.push(strAttr(TAG.keyword, 'print-color-mode', opts.color ? 'color' : 'monochrome'));
  const media = mediaKeyword(opts.media);
  if (media) parts.push(strAttr(TAG.keyword, 'media', media));

  parts.push(Buffer.from([TAG.endAttrs]));
  if (data && data.length) parts.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
  return { body: Buffer.concat(parts), reqId };
}

// 解析响应头：status-code < 0x0100 = successful-ok 家族
function parseResponse(buf) {
  if (!buf || buf.length < 8) return { ok: false, status: -1, statusHex: 'short', message: 'IPP 响应过短' };
  const status = buf.readUInt16BE(2);
  return { ok: status < 0x0100, status, statusHex: '0x' + status.toString(16).padStart(4, '0') };
}

// ipp:// → http:// (631)，ipps:// → https:// (631)
function toHttpUrl(ippUrl) {
  const u = new URL(ippUrl);
  const isSec = u.protocol === 'ipps:' || u.protocol === 'https:';
  const port = u.port || '631';
  return { secure: isSec, host: u.hostname, port, path: u.pathname + (u.search || ''), printerUri: ippUrl };
}

function printViaIpp(ippUrl, data, opts = {}) {
  return new Promise((resolve, reject) => {
    let t;
    try {
      const target = toHttpUrl(ippUrl);
      const { body } = buildPrintJob(target.printerUri, data, opts);
      const lib = target.secure ? https : http;
      const req = lib.request({
        host: target.host, port: target.port, path: target.path, method: 'POST',
        headers: { 'Content-Type': 'application/ipp', 'Content-Length': body.length },
        rejectUnauthorized: false,   // 打印机常用自签证书
      }, res => {
        const chunks = []; res.on('data', c => chunks.push(c));
        res.on('end', () => {
          clearTimeout(t);
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('HTTP ' + res.statusCode));
          const r = parseResponse(Buffer.concat(chunks));
          if (r.ok) resolve(r); else reject(new Error('IPP 状态 ' + r.statusHex + (r.message ? ' ' + r.message : '')));
        });
      });
      req.on('error', e => { clearTimeout(t); reject(e); });
      t = setTimeout(() => { req.destroy(new Error('IPP 连接超时')); }, opts.timeoutMs || 20000);
      req.write(body); req.end();
    } catch (e) { clearTimeout(t); reject(e); }
  });
}

module.exports = { buildPrintJob, parseResponse, toHttpUrl, mediaKeyword, printViaIpp, TAG };
