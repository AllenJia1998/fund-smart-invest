/**
 * DeepSeek 客户端：支持流式输出、Function Calling、JSON 模式。
 * 接口与 OpenAI Chat Completions 兼容。
 */
import { config } from '../config.js';

const ENDPOINT = () => `${config.deepseek.baseUrl.replace(/\/$/, '')}/chat/completions`;

function authHeaders() {
  if (!config.deepseek.key) {
    throw Object.assign(new Error('未配置 DEEPSEEK_API_KEY'), { statusCode: 500 });
  }
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.deepseek.key}`,
  };
}

async function post(body, signal) {
  const res = await fetch(ENDPOINT(), {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(new Error(`DeepSeek ${res.status}: ${text.slice(0, 300)}`), {
      statusCode: 502,
    });
  }
  return res;
}

/** 非流式对话，可带工具定义。 */
export async function chat({ messages, model, tools, temperature = 0.6, signal, jsonMode = false }) {
  const body = {
    model: model ?? config.deepseek.model,
    messages,
    temperature,
    stream: false,
  };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (jsonMode) body.response_format = { type: 'json_object' };

  const res = await post(body, signal);
  const data = await res.json();
  const message = data.choices?.[0]?.message ?? {};
  return {
    content: message.content ?? '',
    reasoning: message.reasoning_content ?? null,
    toolCalls: message.tool_calls ?? [],
    finishReason: data.choices?.[0]?.finish_reason ?? null,
    usage: data.usage ?? null,
  };
}

/**
 * 流式对话。逐块回调：
 *   onDelta({content, reasoning})      文本增量
 *   onToolCalls(toolCalls)             本轮工具调用（流结束后一次性给出）
 * 返回聚合后的完整结果。
 */
export async function streamChat({
  messages,
  model,
  tools,
  temperature = 0.6,
  signal,
  responseFormat,
  onDelta = () => {},
}) {
  const body = {
    model: model ?? config.deepseek.model,
    messages,
    temperature,
    stream: true,
  };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (responseFormat) body.response_format = responseFormat;

  const res = await post(body, signal);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  let content = '';
  let reasoning = '';
  let finishReason = null;
  const toolAcc = new Map();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (line === '' || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;

      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta ?? {};
      const reason = chunk.choices?.[0]?.finish_reason;
      if (reason) finishReason = reason;

      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content;
        onDelta({ reasoning: delta.reasoning_content });
      }
      if (delta.content) {
        content += delta.content;
        onDelta({ content: delta.content });
      }
      for (const call of delta.tool_calls ?? []) {
        const index = call.index ?? 0;
        const acc = toolAcc.get(index) ?? { id: '', name: '', args: '' };
        if (call.id) acc.id = call.id;
        if (call.function?.name) acc.name = call.function.name;
        if (call.function?.arguments) acc.args += call.function.arguments;
        toolAcc.set(index, acc);
      }
    }
  }

  const toolCalls = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({
      id: v.id || `call_${Math.random().toString(36).slice(2, 10)}`,
      type: 'function',
      function: { name: v.name, arguments: v.args || '{}' },
    }))
    .filter((c) => c.function.name);

  return { content, reasoning, toolCalls, finishReason };
}

/** 便捷方法：一次性拿到文本结果（用于分析与报告生成）。 */
export async function complete(prompt, { model, system, jsonMode = false, signal } = {}) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const target = model ?? config.deepseek.analystModel;

  // 说明：非流式请求要等模型完整生成后才返回响应头，长文本（如投研日报的
  // 结构化 JSON）容易撞上 undici 默认 300s 的 headersTimeout，报 "terminated"。
  // 因此这里统一走流式累积：响应头立刻返回，正文分块读取，不受该超时限制。
  const result = await streamChat({
    messages,
    model: target,
    temperature: jsonMode ? 0.3 : 0.6,
    signal,
    ...(jsonMode ? { responseFormat: { type: 'json_object' } } : {}),
  });
  return result.content;
}

/** 解析模型返回的 JSON（容忍 ```json 包裹）。 */
export function parseJsonLoose(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.search(/[[{]/);
    if (start < 0) return null;
    const end = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
    if (end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

export function llmStatus() {
  return {
    configured: Boolean(config.deepseek.key),
    keySource: config.deepseek.source,
    baseUrl: config.deepseek.baseUrl,
    model: config.deepseek.model,
    analystModel: config.deepseek.analystModel,
  };
}
