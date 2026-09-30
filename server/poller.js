/**
 * 服务商轮询选择器
 * 策略：least（最少调用优先）| sequential（顺序优先）
 */
const { db } = require('./db');

/**
 * 读取轮询策略
 * @param {'sms'|'email'|'kyc'} type
 */
function getStrategy(type) {
  const row = db.prepare("SELECT value FROM shop_config WHERE key_name=?").get(`${type}_poll_strategy`);
  return row?.value || 'least';
}

/**
 * 获取某类型的调用统计
 */
function getStats(provider) {
  return db.prepare("SELECT * FROM provider_stats WHERE provider=?").get(provider)
    || { provider, call_count: 0, fail_count: 0, last_used: null };
}

/**
 * 记录调用结果
 * @param {string} provider 服务商标识，如 'sms_volcengine'
 * @param {boolean} success
 */
function recordCall(provider, success) {
  db.prepare(`
    INSERT INTO provider_stats (provider, call_count, fail_count, last_used, updated_at)
    VALUES (?, 1, ?, datetime('now'), datetime('now'))
    ON CONFLICT(provider) DO UPDATE SET
      call_count = call_count + 1,
      fail_count = fail_count + ?,
      last_used  = datetime('now'),
      updated_at = datetime('now')
  `).run(provider, success ? 0 : 1, success ? 0 : 1);

  // 同步写入出站调用日志（本系统调用外部）
  try {
    const { randomUUID } = require('crypto');
    db.prepare("INSERT INTO api_call_logs (id,direction,method,path,provider,status,success,duration_ms,ip) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(randomUUID(), 'outbound', 'POST', null, provider, success ? 200 : 500, success ? 1 : 0, null, null);
  } catch (_) {} // api_call_logs 表可能尚未创建（首次启动），忽略
}

/**
 * 从可用服务商列表中按策略选出调用顺序
 * @param {Array<{key: string, available: boolean}>} providers 按优先顺序排列的服务商列表
 * @param {string} strategy 'least' | 'sequential' | 'single:<key>' | 'user_choice'
 * @returns {Array} 可用服务商，按选择顺序排列（第一个是本次首选）
 */
function selectProviders(providers, strategy, userChoice) {
  const available = providers.filter(p => p.available);
  if (!available.length) return [];

  // single 模式：只使用指定服务商
  if (strategy.startsWith('single:')) {
    const key = strategy.slice(7);
    const found = available.find(p => p.key === key);
    return found ? [found] : available; // 指定服务商不可用则回退全部
  }

  // user_choice 模式：用户指定服务商
  if (strategy === 'user_choice' && userChoice) {
    const found = available.find(p => p.key === userChoice);
    if (found) return [found];
  }

  if (strategy === 'sequential') {
    return available;
  }

  // least：按调用次数升序
  return available.slice().sort((a, b) => {
    const sa = getStats(a.key).call_count;
    const sb = getStats(b.key).call_count;
    return sa - sb;
  });
}

/**
 * 带自动故障转移的轮询执行
 * @param {Array<{key:string,available:boolean,fn:Function}>} providers
 * @param {string} strategy
 * @param {string} [userChoice] 用户指定的服务商 key（user_choice 模式）
 */
async function pollExecute(providers, strategy, userChoice) {
  const ordered = selectProviders(providers, strategy, userChoice);
  if (!ordered.length) throw new Error('无可用服务商，请检查配置');

  let lastErr;
  for (const p of ordered) {
    try {
      const result = await p.fn();
      recordCall(p.key, true);
      return { provider: p.key, result };
    } catch (err) {
      recordCall(p.key, false);
      lastErr = err;
      console.warn(`[Poller] ${p.key} 失败，尝试下一个: ${err.message}`);
    }
  }
  throw lastErr || new Error('所有服务商均失败');
}

/**
 * 获取所有服务商的调用统计（用于管理端展示）
 */
function getAllStats() {
  return db.prepare("SELECT * FROM provider_stats ORDER BY call_count DESC").all();
}

/**
 * 重置某服务商统计
 */
function resetStats(provider) {
  db.prepare("DELETE FROM provider_stats WHERE provider=?").run(provider);
}

module.exports = { getStrategy, selectProviders, pollExecute, recordCall, getAllStats, resetStats };
