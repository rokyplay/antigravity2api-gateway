/**
 * 限流追踪器
 * 参考 Antigravity-Manager 实现，支持：
 * 1. 智能限流检测和跳过
 * 2. 三级降级策略
 * 3. 指数退避
 * 4. 模型级别限流
 */

import { log } from '../utils/logger.js';

// 限流原因枚举
export const RateLimitReason = {
  QUOTA_EXHAUSTED: 'quota_exhausted',           // 配额耗尽
  MODEL_CAPACITY_EXHAUSTED: 'model_capacity',   // 模型容量耗尽
  RATE_LIMITED: 'rate_limited',                 // 请求频率限制
  SERVER_ERROR: 'server_error',                 // 5xx 错误
  UNKNOWN: 'unknown'
};

class RateLimitTracker {
  constructor() {
    // accountId -> { until: timestamp, reason: string, model?: string }
    this.entries = new Map();
    // accountId -> 连续失败次数
    this.failureCounts = new Map();
    // 基础退避秒数（临时限流用）
    this.baseBackoff = 5;
    // 最大退避秒数（临时限流用）
    this.maxBackoff = 60;
    // 配额耗尽固定等待时间
    this.quotaExhaustedWait = 30;
  }

  /**
   * 检查账号是否在限流中
   * @param {string} accountId - 账号ID
   * @param {string} [model] - 可选的模型名称
   * @returns {boolean}
   */
  isRateLimited(accountId, model = null) {
    const entry = this.entries.get(accountId);
    if (!entry) return false;

    const now = Date.now();
    if (now >= entry.until) {
      // 限流已过期，清除记录
      this.entries.delete(accountId);
      return false;
    }

    // 如果指定了模型，检查是否是模型级别限流
    if (model && entry.model && entry.model !== model) {
      // 不同模型，不受限
      return false;
    }

    return true;
  }

  /**
   * 获取剩余等待时间（秒）
   * @param {string} accountId
   * @returns {number} 剩余秒数，0 表示不限流
   */
  getRemainingWait(accountId) {
    const entry = this.entries.get(accountId);
    if (!entry) return 0;

    const remaining = Math.ceil((entry.until - Date.now()) / 1000);
    if (remaining <= 0) {
      this.entries.delete(accountId);
      return 0;
    }
    return remaining;
  }

  /**
   * 设置限流锁定
   * @param {string} accountId
   * @param {number} seconds - 锁定秒数
   * @param {string} reason - 限流原因
   * @param {string} [model] - 可选的模型名称（用于模型级别限流）
   */
  setLockout(accountId, seconds, reason = RateLimitReason.UNKNOWN, model = null) {
    const until = Date.now() + seconds * 1000;
    this.entries.set(accountId, { until, reason, model });

    // 增加失败计数
    const count = (this.failureCounts.get(accountId) || 0) + 1;
    this.failureCounts.set(accountId, count);

    const modelInfo = model ? ` (模型: ${model})` : '';
    log.warn(`账号 ${accountId} 被限流 ${seconds}s，原因: ${reason}${modelInfo}`);
  }

  /**
   * 设置限流直到指定时间（ISO 格式）
   * @param {string} accountId
   * @param {string} isoTime - ISO 8601 时间字符串
   * @param {string} reason
   * @param {string} [model]
   * @returns {boolean} 是否成功设置
   */
  setLockoutUntilIso(accountId, isoTime, reason, model = null) {
    try {
      const until = new Date(isoTime).getTime();
      if (isNaN(until)) return false;

      const now = Date.now();
      if (until <= now) return false;

      this.entries.set(accountId, { until, reason, model });

      const count = (this.failureCounts.get(accountId) || 0) + 1;
      this.failureCounts.set(accountId, count);

      const seconds = Math.ceil((until - now) / 1000);
      log.info(`账号 ${accountId} 精确锁定至 ${isoTime} (${seconds}s)`);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 计算指数退避时间
   * @param {string} accountId
   * @returns {number} 退避秒数
   */
  calculateBackoff(accountId) {
    const count = this.failureCounts.get(accountId) || 0;
    // 指数退避: 30, 60, 120, 240, 480, ...
    const backoff = this.baseBackoff * Math.pow(2, count);
    return Math.min(backoff, this.maxBackoff);
  }

  /**
   * 从错误响应解析限流信息
   * @param {string} accountId
   * @param {number} status - HTTP 状态码
   * @param {string} [retryAfter] - Retry-After 头
   * @param {string} errorBody - 错误响应体
   * @param {string} [model] - 模型名称
   */
  parseFromError(accountId, status, retryAfter, errorBody, model = null) {
    let reason = RateLimitReason.UNKNOWN;
    let seconds = null;

    // 确定限流原因
    const bodyLower = (errorBody || '').toLowerCase();
    if (bodyLower.includes('model_capacity') || bodyLower.includes('capacity')) {
      reason = RateLimitReason.MODEL_CAPACITY_EXHAUSTED;
    } else if (bodyLower.includes('exhausted') || bodyLower.includes('quota')) {
      reason = RateLimitReason.QUOTA_EXHAUSTED;
    } else if (status === 429) {
      reason = RateLimitReason.RATE_LIMITED;
    } else if (status >= 500) {
      reason = RateLimitReason.SERVER_ERROR;
    }

    // 1. 尝试解析 quotaResetDelay（Antigravity API 特有）
    try {
      const parsed = JSON.parse(errorBody);
      const details = parsed?.error?.details || [];
      for (const detail of details) {
        if (detail.quotaResetDelay) {
          seconds = this.parseDuration(detail.quotaResetDelay);
          if (seconds) {
            log.info(`从 quotaResetDelay 解析到锁定时间: ${seconds}s`);
            break;
          }
        }
      }
    } catch (e) {
      // 忽略解析错误
    }

    // 2. 尝试使用 Retry-After 头
    if (!seconds && retryAfter) {
      const parsed = parseInt(retryAfter, 10);
      if (!isNaN(parsed) && parsed > 0) {
        seconds = parsed;
        log.info(`从 Retry-After 头解析到锁定时间: ${seconds}s`);
      }
    }

    // 3. 根据原因选择等待策略
    if (!seconds) {
      if (reason === RateLimitReason.QUOTA_EXHAUSTED) {
        // 配额耗尽：固定等待 30 秒，让其他账号有机会
        seconds = this.quotaExhaustedWait;
        log.info(`配额耗尽，固定等待: ${seconds}s`);
      } else {
        // 临时限流：使用指数退避，但上限较低
        seconds = this.calculateBackoff(accountId);
        log.info(`使用指数退避策略: ${seconds}s`);
      }
    }

    this.setLockout(accountId, seconds, reason, model);
  }

  /**
   * 解析持续时间字符串（如 "3600s", "1h", "30m"）
   * @param {string} duration
   * @returns {number|null} 秒数
   */
  parseDuration(duration) {
    if (!duration) return null;

    // 纯数字（秒）
    const num = parseFloat(duration);
    if (!isNaN(num) && duration.match(/^[\d.]+s?$/)) {
      return Math.ceil(num);
    }

    // 带单位
    const match = duration.match(/^([\d.]+)([smhd])$/i);
    if (match) {
      const value = parseFloat(match[1]);
      const unit = match[2].toLowerCase();
      const multipliers = { s: 1, m: 60, h: 3600, d: 86400 };
      return Math.ceil(value * (multipliers[unit] || 1));
    }

    return null;
  }

  /**
   * 标记账号请求成功，重置失败计数
   * @param {string} accountId
   */
  markSuccess(accountId) {
    this.failureCounts.delete(accountId);
    // 如果之前有限流记录但已过期，也清除
    const entry = this.entries.get(accountId);
    if (entry && Date.now() >= entry.until) {
      this.entries.delete(accountId);
    }
  }

  /**
   * 清除指定账号的限流记录
   * @param {string} accountId
   * @returns {boolean}
   */
  clear(accountId) {
    const had = this.entries.has(accountId);
    this.entries.delete(accountId);
    this.failureCounts.delete(accountId);
    return had;
  }

  /**
   * 清除所有限流记录（乐观重置）
   */
  clearAll() {
    const count = this.entries.size;
    this.entries.clear();
    this.failureCounts.clear();
    if (count > 0) {
      log.warn(`乐观重置：清除了 ${count} 个限流记录`);
    }
  }

  /**
   * 清理过期的限流记录
   * @returns {number} 清理数量
   */
  cleanupExpired() {
    const now = Date.now();
    let cleaned = 0;

    for (const [accountId, entry] of this.entries) {
      if (now >= entry.until) {
        this.entries.delete(accountId);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * 获取所有限流中的账号的最短等待时间
   * @returns {number} 最短等待秒数，0 表示没有限流账号
   */
  getMinRemainingWait() {
    let min = Infinity;
    const now = Date.now();

    for (const [, entry] of this.entries) {
      const remaining = Math.ceil((entry.until - now) / 1000);
      if (remaining > 0 && remaining < min) {
        min = remaining;
      }
    }

    return min === Infinity ? 0 : min;
  }

  /**
   * 获取限流状态摘要
   * @returns {Object}
   */
  getStatus() {
    const now = Date.now();
    const active = [];

    for (const [accountId, entry] of this.entries) {
      const remaining = Math.ceil((entry.until - now) / 1000);
      if (remaining > 0) {
        active.push({
          accountId,
          remaining,
          reason: entry.reason,
          model: entry.model
        });
      }
    }

    return {
      totalTracked: this.entries.size,
      activeLimits: active.length,
      limits: active
    };
  }
}

// 导出单例
const rateLimitTracker = new RateLimitTracker();
export default rateLimitTracker;
