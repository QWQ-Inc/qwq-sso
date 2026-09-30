/**
 * JWT 签发与鉴权中间件
 */
const jwt = require('jsonwebtoken');

function getSecret() {
  return process.env.JWT_SECRET || 'dev-secret-CHANGE-IN-PRODUCTION';
}

function signToken(payload) {
  let expiresIn = process.env.JWT_EXPIRES_IN || '7d';
  // 验证 expiresIn 格式：数字（秒）或带单位字符串（7d, 24h, 3600s 等）
  // 如果是纯数字且 <= 60，说明可能配置错了（单位混淆），强制用 7d
  //
  // 注意必须先判「整串都是数字」：早期写成 parseInt(expiresIn) <= 60，
  // 而 parseInt('7d') === 7、parseInt('30d') === 30，导致 7d/30d/12h 这类
  // 完全合法的配置也被当成错误值静默改成 7d（启动日志里会打出误报警告）。
  const isPureNumber = /^\d+$/.test(String(expiresIn).trim());
  const asNum = parseInt(expiresIn);
  if (isPureNumber && asNum <= 60) {
    console.warn(`[JWT] JWT_EXPIRES_IN="${expiresIn}" 疑似配置错误（太短），已强制使用 7d`);
    expiresIn = '7d';
  }
  return jwt.sign(payload, getSecret(), { expiresIn });
}

// 短时令牌：用于 2FA 中间态（密码已过、待输入动态码），默认 5 分钟
function signShortToken(payload, expiresIn = '5m') {
  return jwt.sign(payload, getSecret(), { expiresIn });
}

function verifyToken(token) {
  try {
    return { valid: true, data: jwt.verify(token, getSecret()) };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录或 Token 缺失' });
  }
  const { valid, data, error } = verifyToken(auth.slice(7));
  if (!valid) return res.status(401).json({ error: `Token 无效: ${error}` });
  req.user = data;
  next();
}

function requireAdmin(level = 3) {
  return (req, res, next) => {
    requireAuth(req, res, () => {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ error: '需要管理员权限' });
      }
      if ((req.user.adminLevel || 99) > level) {
        return res.status(403).json({ error: `需要管理员 Lv.${level} 或更高` });
      }
      next();
    });
  };
}

// ── 可信 IP 匹配：支持精确 IP、CIDR 网段（IPv4）、通配 * ──（S-03）
function ipToLong(ip) {
  const p = String(ip).split('.');
  if (p.length !== 4 || p.some(x => x === '' || isNaN(x) || +x < 0 || +x > 255)) return null;
  return ((+p[0] << 24) >>> 0) + (+p[1] << 16) + (+p[2] << 8) + (+p[3]);
}
function ipMatches(clientIp, entry) {
  entry = String(entry || '').trim();
  if (!entry || entry === '*') return true;
  if (entry.includes('/')) {                       // CIDR 网段（仅 IPv4）
    const [net, bitsStr] = entry.split('/');
    const bits = parseInt(bitsStr, 10);
    const c = ipToLong(clientIp), n = ipToLong(net);
    if (c == null || n == null || isNaN(bits) || bits < 0 || bits > 32) return false;
    const mask = bits === 0 ? 0 : (~((1 << (32 - bits)) - 1)) >>> 0;
    return (c & mask) === (n & mask);
  }
  return clientIp === entry;                        // 精确匹配（含 IPv6）
}
function ipAllowed(clientIp, list) { return list.some(e => ipMatches(clientIp, e)); }

function requireApiKey(scope) {
  return async (req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'API Key 缺失' });
    }
    const token = auth.slice(7);

    if (!token.startsWith('sk_live_') && !token.startsWith('sk_test_')) {
      return res.status(401).json({ error: 'API Key 格式无效' });
    }
    const isTestKey = token.startsWith('sk_test_');

    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const { apiKeys } = require('./db');
    const key = apiKeys.findByHash.get(hash, 'active');
    if (!key) return res.status(401).json({ error: 'API Key 无效或已撤销' });

    // 可信 IP 检查：
    // - 实际密钥：必须配置可信 IP 且在范围内
    // - 测试密钥：默认不校验 IP；仅当用户主动配置了具体 IP（非 * 非空）才校验
    const clientIp = req.ip?.replace('::ffff:', '') || '';
    if (!isTestKey) {
      if (!key.trusted_ips || key.trusted_ips === '*') {
        return res.status(403).json({ error: '该 API Key 未配置可信 IP，无法调用' });
      }
      const allowedIps = key.trusted_ips.split(',').map(s => s.trim()).filter(Boolean);
      if (!ipAllowed(clientIp, allowedIps)) {
        return res.status(403).json({ error: `IP ${clientIp} 不在可信范围内` });
      }
    } else {
      // 测试密钥：仅当明确配置了 IP 列表才校验
      if (key.trusted_ips && key.trusted_ips !== '*' && key.trusted_ips.trim()) {
        const allowedIps = key.trusted_ips.split(',').map(s => s.trim()).filter(Boolean);
        if (allowedIps.length && !ipAllowed(clientIp, allowedIps)) {
          return res.status(403).json({ error: `IP ${clientIp} 不在测试密钥指定范围内` });
        }
      }
    }

    const scopes = JSON.parse(key.scopes || '[]');
    if (scope && !scopes.includes(scope)) {
      return res.status(403).json({ error: `权限不足，需要 scope: ${scope}` });
    }
    apiKeys.touch.run(key.id);
    req.apiKey = key;
    req.isSandbox = isTestKey; // 沙盒标记：测试密钥不返回真实数据
    next();
  };
}

module.exports = { signToken, signShortToken, verifyToken, requireAuth, requireAdmin, requireApiKey, ipMatches, ipAllowed };
