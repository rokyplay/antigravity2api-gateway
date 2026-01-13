/**
 * OpenAI 格式处理器
 * 处理 /v1/chat/completions 请求，支持流式和非流式响应
 */

import { generateAssistantResponse, generateAssistantResponseNoStream } from '../../api/client.js';
import { generateRequestBody, prepareImageRequest } from '../../utils/utils.js';
import { cleanCacheControl } from '../../utils/messageCleaner.js';
import { buildOpenAIErrorPayload } from '../../utils/errors.js';
import { executeWebSearch, findWebSearchCall, buildWebSearchResultMessage } from '../../utils/webSearchHandler.js';
import logger from '../../utils/logger.js';
import config from '../../config/config.js';
import tokenManager from '../../auth/token_manager.js';
import fs from 'fs';
import {
  createResponseMeta,
  setStreamHeaders,
  createHeartbeat,
  getChunkObject,
  releaseChunkObject,
  writeStreamData,
  endStream,
  with429Retry,
  withEmptyRetry
} from '../stream.js';

/**
 * 创建流式数据块
 * 支持 DeepSeek 格式的 reasoning_content
 * @param {string} id - 响应ID
 * @param {number} created - 创建时间戳
 * @param {string} model - 模型名称
 * @param {Object} delta - 增量内容
 * @param {string|null} finish_reason - 结束原因
 * @returns {Object}
 */
export const createStreamChunk = (id, created, model, delta, finish_reason = null) => {
  const chunk = getChunkObject();
  chunk.id = id;
  chunk.object = 'chat.completion.chunk';
  chunk.created = created;
  chunk.model = model;
  chunk.choices[0].delta = delta;
  chunk.choices[0].finish_reason = finish_reason;
  return chunk;
};

/**
 * 处理 OpenAI 格式的聊天请求
 * @param {Request} req - Express请求对象
 * @param {Response} res - Express响应对象
 */
export const handleOpenAIRequest = async (req, res) => {
  const { messages, model, stream = false, tools, ...params } = req.body;

  // 【调试】记录接收到的原始请求
  try {
    const incomingData = {
      timestamp: new Date().toISOString(),
      type: 'incoming_openai',
      model,
      stream,
      toolsCount: tools?.length || 0,
      messagesCount: messages?.length || 0,
      params,
      messages,
      tools
    };
    fs.writeFileSync('/app/data/debug-incoming.json', JSON.stringify(incomingData, null, 2));
  } catch (e) {
    console.error('写入 incoming 调试文件失败:', e.message);
  }

  try {
    if (!messages) {
      return res.status(400).json({ error: 'messages is required' });
    }

    // 【预处理】清理消息中的 cache_control 字段（Claude prompt caching 功能，反重力不支持）
    const cleanedMessages = cleanCacheControl(messages);

    const token = await tokenManager.getToken();
    if (!token) {
      throw new Error('没有可用的token，请运行 npm run login 获取token');
    }

    const isImageModel = model.includes('-image');

    // 【改进】创建请求体生成函数，支持重试时使用新 token
    const createRequestBody = (t) => {
      const body = generateRequestBody(cleanedMessages, model, params, tools, t);
      if (isImageModel) {
        prepareImageRequest(body);
      }
      return body;
    };

    const requestBody = createRequestBody(token);

    const { id, created } = createResponseMeta();
    const maxRetries = Number(config.retryTimes || 0);
    const safeRetries = maxRetries > 0 ? Math.floor(maxRetries) : 0;

    // 【改进】重试选项：支持重新获取 token
    const retryOptions = {
      currentToken: token,
      getToken: () => tokenManager.getToken()
    };

    if (stream) {
      setStreamHeaders(res);

      // 启动心跳，防止 Cloudflare 超时断连
      const heartbeatTimer = createHeartbeat(res);

      try {
        if (isImageModel) {
          const { content, usage, reasoningSignature } = await with429Retry(
            (attempt, currentToken) => {
              const body = attempt > 0 ? createRequestBody(currentToken) : requestBody;
              return generateAssistantResponseNoStream(body, currentToken || token);
            },
            safeRetries,
            'chat.stream.image ',
            retryOptions
          );
          const delta = { content };
          if (reasoningSignature && config.passSignatureToClient) {
            delta.thoughtSignature = reasoningSignature;
          }
          writeStreamData(res, createStreamChunk(id, created, model, delta));
          writeStreamData(res, { ...createStreamChunk(id, created, model, {}, 'stop'), usage });
        } else {
          let hasToolCall = false;
          let usageData = null;
          let collectedToolCalls = []; // 收集工具调用用于 WebSearch 检测
          let collectedContent = ''; // 收集内容用于 WebSearch 后续处理
          let hasReasoning = false; // 是否有思考内容

          // 【空回重试】使用 withEmptyRetry 包装整个流式请求
          const emptyRetries = Math.max(safeRetries, 3); // 空回至少重试 3 次

          await withEmptyRetry(
            async (attempt, currentToken) => {
              // 每次重试前重置收集状态
              hasToolCall = false;
              usageData = null;
              collectedToolCalls = [];
              collectedContent = '';
              hasReasoning = false;

              if (attempt > 0) {
                logger.info(`chat.stream 空回/错误重试第 ${attempt} 次`);
              }

              const body = attempt > 0 ? createRequestBody(currentToken) : requestBody;
              await generateAssistantResponse(body, currentToken || token, (data) => {
                if (data.type === 'usage') {
                  usageData = data.usage;
                } else if (data.type === 'reasoning') {
                  hasReasoning = true;
                  const delta = { reasoning_content: data.reasoning_content };
                  if (data.thoughtSignature && config.passSignatureToClient) {
                    delta.thoughtSignature = data.thoughtSignature;
                  }
                  writeStreamData(res, createStreamChunk(id, created, model, delta));
                } else if (data.type === 'tool_calls') {
                  hasToolCall = true;
                  collectedToolCalls = data.tool_calls; // 收集工具调用
                  // 根据配置决定是否透传工具调用中的签名
                  const toolCallsWithIndex = data.tool_calls.map((toolCall, index) => {
                    if (config.passSignatureToClient) {
                      return { index, ...toolCall };
                    } else {
                      const { thoughtSignature, ...rest } = toolCall;
                      return { index, ...rest };
                    }
                  });
                  const delta = { tool_calls: toolCallsWithIndex };
                  writeStreamData(res, createStreamChunk(id, created, model, delta));
                } else {
                  collectedContent += data.content || '';
                  const delta = { content: data.content };
                  writeStreamData(res, createStreamChunk(id, created, model, delta));
                }
              });

              // 返回状态供 withEmptyRetry 判断是否空回
              return {
                hasContent: collectedContent.length > 0,
                hasToolCalls: hasToolCall,
                hasReasoning: hasReasoning
              };
            },
            emptyRetries,
            'chat.stream ',
            retryOptions
          );

          // 【WebSearch 流式处理】检测是否有 WebSearch 工具调用
          const webSearchCall = findWebSearchCall(collectedToolCalls);
          if (webSearchCall && webSearchCall.query) {
            logger.info(`[WebSearch-Stream] 检测到搜索请求: "${webSearchCall.query}"`);

            // 先发送 tool_calls 结束标记
            writeStreamData(res, { ...createStreamChunk(id, created, model, {}, 'tool_calls'), usage: usageData });

            // 使用 gemini-2.5-flash 执行搜索
            const searchResult = await executeWebSearch(webSearchCall.query, token);

            if (searchResult.success) {
              // 搜索成功，构建新的消息列表继续对话
              const toolResultMessage = buildWebSearchResultMessage(webSearchCall.id, searchResult);

              const newMessages = [
                ...cleanedMessages,
                {
                  role: 'assistant',
                  content: collectedContent || '',
                  tool_calls: collectedToolCalls.map(tc => ({
                    id: tc.id,
                    type: 'function',
                    function: {
                      name: tc.function.name,
                      arguments: tc.function.arguments
                    }
                  }))
                },
                toolResultMessage
              ];

              // 用原模型继续对话，流式返回结果
              const continueRequestBody = generateRequestBody(newMessages, model, params, tools, token);

              // 创建新的响应 ID
              const { id: newId, created: newCreated } = createResponseMeta();

              await with429Retry(
                (attempt, currentToken) => {
                  const body = attempt > 0 ? generateRequestBody(newMessages, model, params, tools, currentToken) : continueRequestBody;
                  return generateAssistantResponse(body, currentToken || token, (data) => {
                    if (data.type === 'usage') {
                      usageData = data.usage;
                    } else if (data.type === 'reasoning') {
                      const delta = { reasoning_content: data.reasoning_content };
                      writeStreamData(res, createStreamChunk(newId, newCreated, model, delta));
                    } else if (data.type === 'tool_calls') {
                      const toolCallsWithIndex = data.tool_calls.map((toolCall, index) => {
                        const { thoughtSignature, ...rest } = toolCall;
                        return { index, ...rest };
                      });
                      writeStreamData(res, createStreamChunk(newId, newCreated, model, { tool_calls: toolCallsWithIndex }));
                    } else {
                      writeStreamData(res, createStreamChunk(newId, newCreated, model, { content: data.content }));
                    }
                  });
                },
                safeRetries,
                'chat.websearch_continue_stream ',
                retryOptions
              );

              logger.info(`[WebSearch-Stream] 搜索完成并继续对话`);
              writeStreamData(res, { ...createStreamChunk(newId, newCreated, model, {}, 'stop'), usage: usageData });
            }
          } else {
            // 没有 WebSearch，正常结束
            writeStreamData(res, { ...createStreamChunk(id, created, model, {}, hasToolCall ? 'tool_calls' : 'stop'), usage: usageData });
          }
        }

        clearInterval(heartbeatTimer);
        endStream(res);
      } catch (error) {
        clearInterval(heartbeatTimer);
        if (!res.writableEnded) {
          const statusCode = error.statusCode || error.status || 500;
          // 【修复】发送正确格式的流式错误响应
          // 1. 先发送一个包含错误信息的 content chunk
          const errorMessage = error.message || 'Internal server error';
          writeStreamData(res, createStreamChunk(id, created, model, {
            content: `\n\n[Error ${statusCode}] ${errorMessage}`
          }));
          // 2. 再发送 stop 消息
          writeStreamData(res, createStreamChunk(id, created, model, {}, 'stop'));
          endStream(res);
        }
        logger.error('生成响应失败:', error.message);
        return;
      }
    } else {
      // 非流式请求：设置较长超时，避免大模型响应超时
      req.setTimeout(0); // 禁用请求超时
      res.setTimeout(0); // 禁用响应超时

      let { content, reasoningContent, reasoningSignature, toolCalls, usage } = await with429Retry(
        (attempt, currentToken) => {
          const body = attempt > 0 ? createRequestBody(currentToken) : requestBody;
          return generateAssistantResponseNoStream(body, currentToken || token);
        },
        safeRetries,
        'chat.no_stream ',
        retryOptions
      );

      // 【WebSearch 自动执行】检测是否有 WebSearch 工具调用
      const webSearchCall = findWebSearchCall(toolCalls);
      if (webSearchCall && webSearchCall.query) {
        logger.info(`[WebSearch] 检测到搜索请求: "${webSearchCall.query}"`);

        // 使用 gemini-2.5-flash 执行搜索
        const searchResult = await executeWebSearch(webSearchCall.query, token);

        if (searchResult.success) {
          // 搜索成功，将结果作为工具返回值，继续对话
          const toolResultMessage = buildWebSearchResultMessage(webSearchCall.id, searchResult);

          // 构建新的消息列表，包含原始 assistant 消息和工具结果
          const newMessages = [
            ...cleanedMessages,
            {
              role: 'assistant',
              content: content || '',
              tool_calls: toolCalls.map(tc => ({
                id: tc.id,
                type: 'function',
                function: {
                  name: tc.function.name,
                  arguments: tc.function.arguments
                }
              }))
            },
            toolResultMessage
          ];

          // 用原模型继续对话，让它基于搜索结果回答
          const continueRequestBody = generateRequestBody(newMessages, model, params, tools, token);

          const continueResult = await with429Retry(
            (attempt, currentToken) => {
              const body = attempt > 0 ? generateRequestBody(newMessages, model, params, tools, currentToken) : continueRequestBody;
              return generateAssistantResponseNoStream(body, currentToken || token);
            },
            safeRetries,
            'chat.websearch_continue ',
            retryOptions
          );

          // 使用继续对话的结果
          content = continueResult.content;
          reasoningContent = continueResult.reasoningContent;
          reasoningSignature = continueResult.reasoningSignature;
          toolCalls = continueResult.toolCalls;
          usage = continueResult.usage;

          logger.info(`[WebSearch] 搜索完成并继续对话，结果长度: ${content?.length || 0}`);
        }
      }

      // DeepSeek 格式：reasoning_content 在 content 之前
      const message = { role: 'assistant' };
      if (reasoningContent) message.reasoning_content = reasoningContent;
      if (reasoningSignature && config.passSignatureToClient) message.thoughtSignature = reasoningSignature;
      message.content = content;

      if (toolCalls.length > 0) {
        // 根据配置决定是否透传工具调用中的签名
        if (config.passSignatureToClient) {
          message.tool_calls = toolCalls;
        } else {
          message.tool_calls = toolCalls.map(({ thoughtSignature, ...rest }) => rest);
        }
      }

      // 使用预构建的响应对象，减少内存分配
      const response = {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [{
          index: 0,
          message,
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
        }],
        usage
      };

      res.json(response);
    }
  } catch (error) {
    logger.error('生成响应失败:', error.message);
    if (res.headersSent) return;
    const statusCode = error.statusCode || error.status || 500;
    return res.status(statusCode).json(buildOpenAIErrorPayload(error, statusCode));
  }
};
