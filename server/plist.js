/**
 * 极简 Apple plist（XML）编解码（v3.5.88，零依赖）
 *
 * 只覆盖 Apple MDM / .mobileconfig 用到的子集：dict / array / string / integer / real / true / false / data(base64) / date。
 * 不追求完备的 plist 规范，只保证 MDM check-in 报文与命令 / 描述文件的往返正确。
 */
'use strict';

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 标记「这是 data 类型」的包装（base64 字符串）。编码时输出 <data>，解码时 data 也还原成 { __data: base64 }。
class PlistData {
  constructor(b64) { this.__data = String(b64 || ''); }
}
function data(b64) { return new PlistData(b64); }

function encodeValue(v, indent) {
  const pad = '  '.repeat(indent);
  if (v === true) return pad + '<true/>';
  if (v === false) return pad + '<false/>';
  if (v instanceof PlistData) return pad + '<data>' + v.__data + '</data>';
  if (v instanceof Date) return pad + '<date>' + v.toISOString().replace(/\.\d{3}Z$/, 'Z') + '</date>';
  if (typeof v === 'number') return pad + (Number.isInteger(v) ? '<integer>' + v + '</integer>' : '<real>' + v + '</real>');
  if (Array.isArray(v)) {
    if (!v.length) return pad + '<array/>';
    return pad + '<array>\n' + v.map(x => encodeValue(x, indent + 1)).join('\n') + '\n' + pad + '</array>';
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (!keys.length) return pad + '<dict/>';
    const inner = keys.map(k => pad + '  <key>' + esc(k) + '</key>\n' + encodeValue(v[k], indent + 1)).join('\n');
    return pad + '<dict>\n' + inner + '\n' + pad + '</dict>';
  }
  return pad + '<string>' + esc(v == null ? '' : v) + '</string>';
}

function encode(obj) {
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + '<plist version="1.0">\n' + encodeValue(obj, 0) + '\n</plist>';
}

// ── 解码 ──
// 把 XML 切成标记流再递归构建。够用于 MDM 报文（结构简单、无 CDATA）。
function unesc(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function decode(xml) {
  const body = String(xml).replace(/<\?xml[\s\S]*?\?>/, '').replace(/<!DOCTYPE[\s\S]*?>/, '');
  const re = /<(\/?)(plist|dict|array|key|string|integer|real|true|false|data|date)([^>]*?)(\/?)>|([^<]+)/g;
  const tokens = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    if (m[2]) tokens.push({ close: m[1] === '/', tag: m[2], self: m[4] === '/' });
    else if (m[5] != null && m[5].trim()) tokens.push({ text: m[5] });
  }
  let i = 0;
  function parseValue() {
    while (i < tokens.length && (tokens[i].text != null || tokens[i].tag === 'plist')) {
      if (tokens[i].tag === 'plist' && tokens[i].close) { i++; continue; }
      if (tokens[i].tag === 'plist') { i++; continue; }
      i++; // 跳过纯空白文本
    }
    const t = tokens[i];
    if (!t) return undefined;
    if (t.tag === 'true') { i++; return true; }
    if (t.tag === 'false') { i++; return false; }
    if (t.self) { i++; return t.tag === 'array' ? [] : (t.tag === 'dict' ? {} : ''); }
    if (t.tag === 'dict') { i++; return parseDict(); }
    if (t.tag === 'array') { i++; return parseArray(); }
    // 标量：<tag>text</tag>
    i++;
    let text = '';
    if (tokens[i] && tokens[i].text != null) { text = tokens[i].text; i++; }
    if (tokens[i] && tokens[i].close && tokens[i].tag === t.tag) i++;
    text = unesc(text).trim();
    if (t.tag === 'integer') return parseInt(text, 10);
    if (t.tag === 'real') return parseFloat(text);
    if (t.tag === 'data') return new PlistData(text.replace(/\s+/g, ''));
    if (t.tag === 'date') return text;
    return text; // string
  }
  function parseDict() {
    const out = {};
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.close && t.tag === 'dict') { i++; break; }
      if (t.tag === 'key') {
        i++;
        let key = '';
        if (tokens[i] && tokens[i].text != null) { key = unesc(tokens[i].text).trim(); i++; }
        if (tokens[i] && tokens[i].close && tokens[i].tag === 'key') i++;
        out[key] = parseValue();
      } else { i++; }
    }
    return out;
  }
  function parseArray() {
    const out = [];
    while (i < tokens.length) {
      const t = tokens[i];
      if (t.close && t.tag === 'array') { i++; break; }
      if (t.text != null) { i++; continue; }
      out.push(parseValue());
    }
    return out;
  }
  return parseValue();
}

module.exports = { encode, decode, data, PlistData };
