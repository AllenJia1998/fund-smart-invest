/**
 * Agent 执行器（harness 核心）。
 *
 * 一轮对话的执行流程：
 *   1. 组装系统提示 = 角色设定 + 已挂载 Skills + 知识库检索片段 + 附件解读结果
 *   2. 调用 DeepSeek（流式），把文本增量实时推给前端
 *   3. 若模型请求工具调用 → 执行 → 结果回灌 → 继续循环（最多 maxSteps 轮）
 *   4. 输出最终回答
 */
import { config } from '../config.js';
import { streamChat } from './llm.js';
import { kbContext } from './kb.js';
import { mountedInstructions } from './skills.js';
import { runTool, toolSchemas } from './tools.js';

const BASE_PERSONA = `你是「基金智投」的 AI 投资研究助手，服务于中国公募基金投资者。

工作要求：
- 回答必须基于工具返回的真实数据，不要编造净值、涨跌幅或新闻。
- 引用数据时标注日期与来源（如"截至 2026-09-10，单位净值 1.2620"）。
- 给出投资建议时，必须同时说明理由、风险与不确定性，并提示"以上分析仅供参考，不构成投资建议"。
- 涉及涨跌预测时，区分短期（1-4 周）与中长期（3-12 月），说明依据与置信度，不要给出确定性承诺。
- 使用中文回答，结构清晰，善用 Markdown 表格与列表。
- 如果用户上传了图片或文档，你会收到其解析文本，请基于该内容回答。`;

/**
 * 组装系统提示。
 * @param {{attachments?: Array, useKb?: boolean, query?: string}} options
 */
function buildSystemPrompt({ attachments = [], useKb = true, query = '' } = {}) {
  const parts = [BASE_PERSONA];

  if (useKb && query.trim()) {
    const { text } = kbContext(query, 4);
    if (text) parts.push(text);
  }

  const skills = mountedInstructions();
  if (skills) parts.push(skills);

  if (attachments.length > 0) {
    const blocks = attachments.map((a, i) => {
      const body = a.text?.trim()
        ? a.text.slice(0, 12_000)
        : '（未能提取到文本内容）';
      return `### 附件 ${i + 1}：${a.name}\n- 类型：${a.kind}\n- 解析方式：${a.method}\n- 内容：\n\`\`\`\n${body}\n\`\`\``;
    });
    parts.push(
      [
        '## 用户本轮上传的附件（已由 harness 解析）',
        '请结合下面的附件内容回答用户问题；若用户未明确提出针对附件的问题，请主动给出要点解读。',
        ...blocks,
      ].join('\n\n')
    );
  }

  parts.push(`当前时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（北京时间）`);
  return parts.join('\n\n---\n\n');
}

/**
 * 运行一轮 Agent。
 * @param {object} options
 * @param {Array} options.history  历史消息（role/content）
 * @param {string} options.input   本轮用户输入
 * @param {Array} options.attachments 已解析的附件
 * @param {(event:string, data:object)=>void} options.emit 流式事件回调
 * @param {AbortSignal} options.signal
 * @returns {Promise<{content:string, steps:Array, usage:object}>}
 */
export async function runAgent({
  history = [],
  input = '',
  attachments = [],
  emit = () => {},
  signal,
  maxSteps = 6,
  useKb = true,
}) {
  const messages = [
    { role: 'system', content: buildSystemPrompt({ attachments, useKb, query: input }) },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: input || '（用户上传了附件，请解读）' },
  ];

  const tools = toolSchemas();
  const steps = [];
  let finalContent = '';
  let usage = { promptTokens: 0, completionTokens: 0 };

  for (let step = 0; step < maxSteps; step += 1) {
    if (signal?.aborted) break;

    let streamedThisRound = '';
    const result = await streamChat({
      messages,
      tools,
      signal,
      onDelta: ({ content }) => {
        if (content) {
          streamedThisRound += content;
          emit('delta', { content });
        }
      },
    });

    usage.promptTokens += result.usage?.prompt_tokens ?? 0;
    usage.completionTokens += result.usage?.completion_tokens ?? 0;

    // 没有工具调用 → 本轮即为最终回答
    if (result.toolCalls.length === 0) {
      finalContent = result.content || streamedThisRound;
      break;
    }

    // 记录助手发起的工具调用
    messages.push({
      role: 'assistant',
      content: result.content ?? '',
      tool_calls: result.toolCalls,
    });

    for (const call of result.toolCalls) {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        args = {};
      }
      emit('tool_start', { id: call.id, name: call.function.name, args });
      const outcome = await runTool(call.function.name, args);
      emit('tool_end', {
        id: call.id,
        name: call.function.name,
        ok: outcome.ok,
        elapsedMs: outcome.elapsedMs,
        preview: JSON.stringify(outcome.ok ? outcome.result : outcome.error).slice(0, 400),
      });
      steps.push({ name: call.function.name, args, ok: outcome.ok, elapsedMs: outcome.elapsedMs });

      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(outcome.ok ? outcome.result : { error: outcome.error }).slice(0, 20_000),
      });
    }

    // 已到最后一轮：再要一次最终答复
    if (step === maxSteps - 1) {
      const closing = await streamChat({
        messages: [...messages, { role: 'user', content: '请基于以上工具结果，给出最终回答。' }],
        signal,
        onDelta: ({ content }) => {
          if (content) emit('delta', { content });
        },
      });
      finalContent = closing.content;
    }
  }

  return { content: finalContent, steps, usage, model: config.deepseek.model };
}
