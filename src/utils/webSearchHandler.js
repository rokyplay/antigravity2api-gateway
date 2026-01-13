/**
 * WebSearch 工具处理器
 * 使用 gemini-2.5-flash 作为搜索引擎，为其他模型提供网络搜索能力
 */

import { generateAssistantResponseNoStream } from '../api/client.js';
import tokenManager from '../auth/token_manager.js';
import logger from './logger.js';

// 搜索专用模型
const SEARCH_MODEL = 'gemini-2.5-flash';

/**
 * 执行网络搜索
 * @param {string} query - 搜索查询
 * @param {Object} token - 认证 token
 * @returns {Promise<Object>} 搜索结果
 */
export async function executeWebSearch(query, token) {
  logger.info(`[WebSearch] 执行搜索: "${query}"`);

  // 构建搜索请求
  const searchRequest = {
    project: token.projectId,
    requestId: `websearch-${Date.now()}`,
    request: {
      contents: [
        {
          role: 'user',
          parts: [{ text: `请搜索以下内容并提供详细结果，包括来源链接：${query}` }]
        }
      ],
      generationConfig: {
        maxOutputTokens: 2000,
        temperature: 0.7
      },
      tools: [{ google_search: {} }],
      sessionId: `search-${Date.now()}`
    },
    model: SEARCH_MODEL,
    userAgent: 'antigravity',
    requestType: 'agent'
  };

  try {
    const result = await generateAssistantResponseNoStream(searchRequest, token);

    logger.info(`[WebSearch] 搜索完成，内容长度: ${result.content?.length || 0}`);

    return {
      success: true,
      content: result.content || '搜索未返回结果',
      usage: result.usage
    };
  } catch (error) {
    logger.error(`[WebSearch] 搜索失败: ${error.message}`);
    return {
      success: false,
      content: `搜索失败: ${error.message}`,
      error: error.message
    };
  }
}

/**
 * 检查工具调用中是否有 WebSearch
 * @param {Array} toolCalls - 工具调用数组
 * @returns {Object|null} WebSearch 调用信息，如果没有则返回 null
 */
export function findWebSearchCall(toolCalls) {
  if (!Array.isArray(toolCalls)) return null;

  for (const call of toolCalls) {
    const name = call.function?.name || call.name;
    if (name === 'WebSearch') {
      let args = {};
      try {
        args = typeof call.function?.arguments === 'string'
          ? JSON.parse(call.function.arguments)
          : call.function?.arguments || {};
      } catch (e) {
        // 解析失败，使用空对象
      }
      return {
        id: call.id,
        query: args.query || ''
      };
    }
  }
  return null;
}

/**
 * 构建 WebSearch 工具结果消息
 * @param {string} toolCallId - 工具调用 ID
 * @param {Object} searchResult - 搜索结果
 * @returns {Object} OpenAI 格式的工具结果消息
 */
export function buildWebSearchResultMessage(toolCallId, searchResult) {
  return {
    role: 'tool',
    tool_call_id: toolCallId,
    content: searchResult.content
  };
}

export default {
  executeWebSearch,
  findWebSearchCall,
  buildWebSearchResultMessage
};
