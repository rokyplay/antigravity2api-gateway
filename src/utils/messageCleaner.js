/**
 * 消息清理工具
 * 参考 clewdr-dev 和 Antigravity-Manager 实现
 *
 * 主要功能：
 * 1. 清理 cache_control 字段（VS Code 等客户端会发回历史消息中的 cache_control）
 * 2. 清理无效的 thinking blocks
 * 3. 参数重映射
 */

import logger from './logger.js';

/**
 * 深度清理消息中的 cache_control 字段
 * 这是必要的，因为：
 * 1. VS Code 等客户端会将历史消息（包含 cache_control）原封不动发回
 * 2. Anthropic API 不接受请求中包含 cache_control 字段
 * 3. 转发到 Gemini 时也应该清理以保持协议纯净性
 *
 * @param {Array} messages - Claude 格式的消息数组
 * @returns {Array} 清理后的消息数组
 */
export function cleanCacheControl(messages) {
  if (!Array.isArray(messages)) return messages;

  return messages.map(msg => {
    if (!msg.content || !Array.isArray(msg.content)) return msg;

    const cleanedContent = msg.content.map(block => {
      if (block && typeof block === 'object' && 'cache_control' in block) {
        const { cache_control, ...rest } = block;
        logger.debug(`[Cache-Control-Cleaner] 移除 ${block.type || 'unknown'} 块中的 cache_control`);
        return rest;
      }
      return block;
    });

    return { ...msg, content: cleanedContent };
  });
}

/**
 * 检测是否应该因历史消息不兼容而禁用 Thinking
 *
 * 场景：如果最后一条 Assistant 消息处于 Tool Use 流程中，但没有 Thinking 块，
 * 说明这是一个由非 Thinking 模型发起的流程。此时强制开启 Thinking 会导致：
 * "final assistant message must start with a thinking block" 错误。
 *
 * @param {Array} messages - Claude 格式的消息数组
 * @returns {boolean} 是否应该禁用 Thinking
 */
export function shouldDisableThinkingDueToHistory(messages) {
  if (!Array.isArray(messages)) return false;

  // 逆序查找最后一条 assistant 消息
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      if (!Array.isArray(msg.content)) return false;

      const hasToolUse = msg.content.some(block => block.type === 'tool_use');
      const hasThinking = msg.content.some(block => block.type === 'thinking');

      // 有工具调用但没有 Thinking 块 → 不兼容
      if (hasToolUse && !hasThinking) {
        logger.info('[Thinking-Mode] 检测到历史消息中有工具调用但无 Thinking，建议禁用');
        return true;
      }

      // 只检查最近一条 assistant 消息
      return false;
    }
  }

  return false;
}

/**
 * 剥离无效的 thinking blocks
 * 如果 thinking block 没有有效签名且不是第一个块，应该移除或转换为文本
 *
 * @param {Array} messages - Claude 格式的消息数组
 * @param {string|null} globalSignature - 全局缓存的签名
 * @returns {Array} 处理后的消息数组
 */
export function stripInvalidThinkingBlocks(messages, globalSignature = null) {
  if (!Array.isArray(messages)) return messages;

  const MIN_SIGNATURE_LENGTH = 50;

  return messages.map(msg => {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return msg;

    const cleanedContent = msg.content.map((block, index) => {
      if (block.type !== 'thinking') return block;

      // 检查签名有效性
      const hasValidSignature = block.signature && block.signature.length >= MIN_SIGNATURE_LENGTH;
      const hasGlobalSignature = globalSignature && globalSignature.length >= MIN_SIGNATURE_LENGTH;

      // 如果没有有效签名，转换为普通文本
      if (!hasValidSignature && !hasGlobalSignature) {
        logger.debug('[Thinking-Cleaner] 无效 thinking block 转换为文本');
        return {
          type: 'text',
          text: block.thinking || '...'
        };
      }

      // 空内容的 thinking block 也需要处理
      if (!block.thinking || block.thinking.trim() === '') {
        return {
          ...block,
          thinking: '...'
        };
      }

      return block;
    });

    return { ...msg, content: cleanedContent };
  });
}

/**
 * 工具参数重映射规则
 * 用于修正 AI 模型可能使用的错误参数名
 */
const PARAM_MAPPINGS = {
  'Grep': { 'query': 'pattern', 'path': 'file_path' },
  'grep': { 'query': 'pattern', 'path': 'file_path' },
  'Read': { 'path': 'file_path' },
  'read': { 'path': 'file_path' },
  'Write': { 'path': 'file_path' },
  'write': { 'path': 'file_path' },
  'Edit': { 'path': 'file_path' },
  'edit': { 'path': 'file_path' },
  'Glob': { 'query': 'pattern', 'path': 'directory' },
  'glob': { 'query': 'pattern', 'path': 'directory' },
  'Bash': { 'cmd': 'command' },
  'bash': { 'cmd': 'command' },
};

/**
 * 重映射工具调用参数
 *
 * @param {string} toolName - 工具名称
 * @param {Object} args - 工具参数对象
 * @returns {Object} 重映射后的参数对象
 */
export function remapFunctionCallArgs(toolName, args) {
  if (!toolName || !args || typeof args !== 'object') return args;

  const mapping = PARAM_MAPPINGS[toolName];
  if (!mapping) return args;

  const remapped = { ...args };
  for (const [from, to] of Object.entries(mapping)) {
    if (remapped[from] !== undefined && remapped[to] === undefined) {
      remapped[to] = remapped[from];
      delete remapped[from];
      logger.debug(`[Param-Remap] ${toolName}: ${from} → ${to}`);
    }
  }

  return remapped;
}

/**
 * 预处理 Claude 请求消息
 * 执行所有必要的清理和转换
 *
 * @param {Array} messages - Claude 格式的消息数组
 * @param {Object} options - 选项
 * @param {boolean} options.enableThinking - 是否启用 thinking
 * @param {string|null} options.globalSignature - 全局签名
 * @returns {Object} { messages: 处理后的消息, shouldDisableThinking: 是否应禁用 thinking }
 */
export function preprocessClaudeMessages(messages, options = {}) {
  const { enableThinking = false, globalSignature = null } = options;

  // 1. 清理 cache_control
  let processed = cleanCacheControl(messages);

  // 2. 检查是否应该禁用 thinking
  let shouldDisable = false;
  if (enableThinking) {
    shouldDisable = shouldDisableThinkingDueToHistory(processed);
  }

  // 3. 剥离无效 thinking blocks（如果启用了 thinking）
  if (enableThinking && !shouldDisable) {
    processed = stripInvalidThinkingBlocks(processed, globalSignature);
  }

  return {
    messages: processed,
    shouldDisableThinking: shouldDisable
  };
}

export default {
  cleanCacheControl,
  shouldDisableThinkingDueToHistory,
  stripInvalidThinkingBlocks,
  remapFunctionCallArgs,
  preprocessClaudeMessages
};
