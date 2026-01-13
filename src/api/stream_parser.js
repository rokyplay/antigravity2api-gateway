import memoryManager, { registerMemoryPoolCleanup } from '../utils/memoryManager.js';
import { generateToolCallId } from '../utils/idGenerator.js';
import { setSignature, shouldCacheSignature, isImageModel } from '../utils/thoughtSignatureCache.js';
import { getOriginalToolName } from '../utils/toolNameCache.js';
import config from '../config/config.js';
import fs from 'fs';

// 预编译的常量（避免重复创建字符串）
const DATA_PREFIX = 'data: ';
const DATA_PREFIX_LEN = DATA_PREFIX.length;

// 高效的行分割器（零拷贝，避免 split 创建新数组）
// 使用对象池复用 LineBuffer 实例
class LineBuffer {
  constructor() {
    this.buffer = '';
    this.lines = [];
  }
  
  // 追加数据并返回完整的行
  append(chunk) {
    this.buffer += chunk;
    this.lines.length = 0; // 重用数组
    
    let start = 0;
    let end;
    while ((end = this.buffer.indexOf('\n', start)) !== -1) {
      this.lines.push(this.buffer.slice(start, end));
      start = end + 1;
    }
    
    // 保留未完成的部分
    this.buffer = start < this.buffer.length ? this.buffer.slice(start) : '';
    return this.lines;
  }
  
  clear() {
    this.buffer = '';
    this.lines.length = 0;
  }
}

// LineBuffer 对象池
const lineBufferPool = [];
const getLineBuffer = () => {
  const buffer = lineBufferPool.pop();
  if (buffer) {
    buffer.clear();
    return buffer;
  }
  return new LineBuffer();
};
const releaseLineBuffer = (buffer) => {
  const maxSize = memoryManager.getPoolSizes().lineBuffer;
  if (lineBufferPool.length < maxSize) {
    buffer.clear();
    lineBufferPool.push(buffer);
  }
};

// toolCall 对象池
const toolCallPool = [];
const getToolCallObject = () => toolCallPool.pop() || { id: '', type: 'function', function: { name: '', arguments: '' } };
const releaseToolCallObject = (obj) => {
  const maxSize = memoryManager.getPoolSizes().toolCall;
  if (toolCallPool.length < maxSize) toolCallPool.push(obj);
};

// 注册内存清理回调（供外部统一调用）
function registerStreamMemoryCleanup() {
  registerMemoryPoolCleanup(toolCallPool, () => memoryManager.getPoolSizes().toolCall);
  registerMemoryPoolCleanup(lineBufferPool, () => memoryManager.getPoolSizes().lineBuffer);
}

// 转换 functionCall 为 OpenAI 格式（使用对象池）
// 会尝试将安全工具名还原为原始工具名
function convertToToolCall(functionCall, sessionId, model) {
  const toolCall = getToolCallObject();
  toolCall.id = functionCall.id || generateToolCallId();
  let name = functionCall.name;
  if (model) {
    const original = getOriginalToolName(model, functionCall.name);
    if (original) name = original;
  }
  toolCall.function.name = name;
  toolCall.function.arguments = JSON.stringify(functionCall.args);
  return toolCall;
}

// 解析并发送流式响应片段（会修改 state 并触发 callback）
// 支持 DeepSeek 格式：思维链内容通过 reasoning_content 字段输出
// 同时透传 thoughtSignature，方便客户端后续复用
// 签名和思考内容绑定存储：收集完整思考内容后和签名一起缓存
function parseAndEmitStreamChunk(line, state, callback) {
  if (!line.startsWith(DATA_PREFIX)) return;
  
  try {
    const data = JSON.parse(line.slice(DATA_PREFIX_LEN));
    const candidate = data.response?.candidates?.[0];
    const parts = candidate?.content?.parts;

    // 【调试】记录响应中是否有 groundingMetadata
    if (candidate) {
      const debugPath = '/app/data/debug-response-chunk.json';
      try {
        const existing = fs.existsSync(debugPath) ? JSON.parse(fs.readFileSync(debugPath, 'utf8')) : { chunks: [] };
        existing.chunks.push({
          timestamp: new Date().toISOString(),
          hasGroundingMetadata: !!candidate.groundingMetadata,
          groundingMetadata: candidate.groundingMetadata || null,
          finishReason: candidate.finishReason,
          partsCount: parts?.length || 0
        });
        // 只保留最后 20 个 chunks
        if (existing.chunks.length > 20) existing.chunks = existing.chunks.slice(-20);
        fs.writeFileSync(debugPath, JSON.stringify(existing, null, 2));
      } catch (e) { /* ignore */ }
    }

    // 处理 groundingMetadata（Google Search 工具的返回结果）
    if (candidate?.groundingMetadata) {
      const metadata = candidate.groundingMetadata;
      // 转换为文本输出，包含搜索结果和来源
      let searchResultText = '';

      if (metadata.webSearchQueries?.length > 0) {
        searchResultText += `搜索查询: ${metadata.webSearchQueries.join(', ')}\n\n`;
      }

      if (metadata.groundingChunks?.length > 0) {
        searchResultText += '搜索结果:\n';
        for (const chunk of metadata.groundingChunks) {
          if (chunk.web) {
            searchResultText += `- [${chunk.web.title || 'Link'}](${chunk.web.uri})\n`;
          }
        }
        searchResultText += '\n';
      }

      if (searchResultText) {
        callback({ type: 'text', content: searchResultText });
      }
    }

    if (parts) {
      for (const part of parts) {
        if (part.thoughtSignature) {
          // Gemini 等模型可能只在 functionCall part 上给出 thoughtSignature；
          // 将其视为本轮"最新签名"，用于后续 functionCall 兜底与下次请求缓存。
          if (part.thoughtSignature !== state.reasoningSignature) {
            state.reasoningSignature = part.thoughtSignature;
            // 延迟缓存：等收集完思考内容后再缓存
          }
        }

        if (part.thought === true) {
          // 累积思考内容
          if (part.text) {
            state.reasoningContent = (state.reasoningContent || '') + part.text;
          }
          
          if (part.thoughtSignature) {
            state.reasoningSignature = part.thoughtSignature;
            // 延迟到流结束时缓存，确保收集到完整的思考内容
          }
          callback({
            type: 'reasoning',
            reasoning_content: part.text || '',
            thoughtSignature: part.thoughtSignature || state.reasoningSignature || null
          });
        } else if (part.text !== undefined) {
          callback({ type: 'text', content: part.text });
        } else if (part.functionCall) {
          const toolCall = convertToToolCall(part.functionCall, state.sessionId, state.model);
          const sig = part.thoughtSignature || state.reasoningSignature || null;
          if (sig) {
            toolCall.thoughtSignature = sig;
            // 标记有工具调用
            state.hasToolCalls = true;
          }
          state.toolCalls.push(toolCall);
        }
      }
    }
    
    if (candidate?.finishReason) {
      // 流结束时，判断是否应该缓存签名
      const hasTools = state.hasToolCalls || state.toolCalls.length > 0;
      const isImage = isImageModel(state.model);
      
      if (state.sessionId && state.model && state.reasoningSignature) {
        if (shouldCacheSignature({ hasTools, isImageModel: isImage })) {
          const content = state.reasoningContent || ' ';
          setSignature(state.sessionId, state.model, state.reasoningSignature, content, { hasTools, isImageModel: isImage });
        }
      }
      
      if (state.toolCalls.length > 0) {
        callback({ type: 'tool_calls', tool_calls: state.toolCalls });
        state.toolCalls = [];
      }
      const usage = data.response?.usageMetadata;
      if (usage) {
        callback({
          type: 'usage',
          usage: {
            prompt_tokens: usage.promptTokenCount || 0,
            completion_tokens: usage.candidatesTokenCount || 0,
            total_tokens: usage.totalTokenCount || 0
          }
        });
      }
      // 清空累积的思考内容和状态
      state.reasoningContent = '';
      state.hasToolCalls = false;
    }
  } catch {
    // 忽略 JSON 解析错误
  }
}

export {
  getLineBuffer,
  releaseLineBuffer,
  parseAndEmitStreamChunk,
  convertToToolCall,
  registerStreamMemoryCleanup,
  releaseToolCallObject
};
