import { logger } from 'alemonjs';
import { abortFailure } from '../dsh/errors';
import { streamChat, type DSHBridgeConfig, type DSHStreamEvent } from '../dsh/client';
import { getDSHCredentials } from '../dsh/credentials';
import { inputText, withInputContext, type ChatInput } from '../dsh/input';
import { ensureDSHSupervisor, hasDSHBridgeOverride } from '../dsh/supervisor';
import { SessionRegistry, type PrivateHistoryContext } from '../state/registry';
import { getModuleConfig, getModuleRuntime } from './modules';
import { runToolChat } from './tool-chat';
import type { AgentTool, TurnContext } from './types';

export const runModuleTurn = async (options: {
  config: DSHBridgeConfig;
  sessionId: string;
  input: ChatInput;
  context: TurnContext;
  history?: PrivateHistoryContext;
  streamContent?: boolean;
  onEvent: (event: DSHStreamEvent) => Promise<void>;
  onCompleted?: (signal: AbortSignal) => Promise<void>;
}): Promise<void> => {
  const { config, context, sessionId, history, onEvent, onCompleted } = options;
  const lease = await (await getModuleRuntime(config)).acquire();

  try {
    const systemPrompt = await lease.system(config.defaultSystemPrompt, context);
    const moduleContext = await lease.context(context);
    const input = await lease.prompt(withInputContext(options.input, moduleContext), context);
    const tools = lease.tools(context);
    let answer = '';
    const observe = async (event: DSHStreamEvent): Promise<void> => {
      context.signal.throwIfAborted();
      if (event.type === 'content') {
        answer += event.content;
      }
      await onEvent(event);
    };

    // DSH may project images to text placeholders based on its model catalog.
    // Send current-turn image bytes directly through the multimodal tool loop.
    const hasImages = Array.isArray(input) && input.some(block => block.type === 'image');

    if (tools.length || lease.transformsReplies || (lease.transformsSystem && systemPrompt !== config.defaultSystemPrompt) || hasImages) {
      const credentials = await getDSHCredentials();

      if (!credentials) {
        throw new Error('业务工具需要配置模型 API Key。');
      }
      const supervisor = await ensureDSHSupervisor(config);

      if (!hasDSHBridgeOverride()) {
        await supervisor.prepareForChat();
      }
      const sandboxReady = hasDSHBridgeOverride() || supervisor.status().phase === 'ready';

      if (sandboxReady && (context.capabilities.web || context.capabilities.files || context.capabilities.terminal)) {
        const workspaceTool: AgentTool = {
          name: 'agent_workspace',
          description: `让隔离会话执行具体任务并返回结果。当前权限：网页${context.capabilities.web ? '允许' : '禁止'}、文件${context.capabilities.files ? '允许' : '禁止'}、终端${context.capabilities.terminal ? '允许' : '禁止'}。不能管理机器人或调用未提供的业务接口。`,
          parameters: {
            type: 'object',
            properties: { task: { type: 'string', minLength: 1, maxLength: 12000 } },
            required: ['task'],
            additionalProperties: false
          },
          execute: async ({ task }, turn) => {
            let result = '';

            await streamChat(
              config,
              sessionId,
              String(task),
              event => {
                if (event.type === 'content') {
                  result += event.content;
                  if (result.length > 24000) {
                    throw new Error('工作区结果过长。');
                  }
                }

                return Promise.resolve();
              },
              turn.userId,
              turn.signal,
              turn.capabilities
            );

            return { ok: true, result };
          }
        };

        if (tools.some(tool => tool.name === workspaceTool.name)) {
          throw new Error('模块不能覆盖 agent_workspace 工具。');
        }
        tools.push(workspaceTool);
      }
      const registry = new SessionRegistry(config);
      const incremental = options.streamContent && !lease.transformsReplies && !config.outputBlockedKeywords.length;
      const raw = await runToolChat({
        config: { ...config, defaultSystemPrompt: systemPrompt },
        credentials,
        input,
        context,
        tools,
        history: history ? await registry.privateHistory(history) : [],
        memoryContext: history?.memoryContext,
        maxRounds: getModuleConfig(config).maxToolRounds,
        onContent: incremental
          ? async content => {
              await onEvent({ type: 'content', content });
            }
          : undefined,
        onTool: async name => {
          await onEvent({ type: 'tool_call', tool: name });
        }
      });
      const transformed = await lease.reply(raw, context);

      answer = config.outputBlockedKeywords.some(word => word && transformed.includes(word)) ? '回复因内容安全策略未发送。' : transformed;
      if (!answer.trim()) {
        throw new Error('模块未产生可发送的回复。');
      }
      context.signal.throwIfAborted();
      if (!incremental) {
        await onEvent({ type: 'content', content: answer });
      }
      await onEvent({ type: 'done' });
      await onCompleted?.(context.signal);
      context.signal.throwIfAborted();
      if (history) {
        await registry.appendPrivateTurn(history, inputText(options.input) + (typeof options.input === 'string' ? '' : '\n[本轮包含图片]'), answer);
      }
    } else {
      await streamChat(config, sessionId, input, observe, context.userId, context.signal, context.capabilities, history, onCompleted);
    }
    context.signal.throwIfAborted();
    if (history?.record?.() !== false) {
      await lease.activity(context.userText, answer, context).catch(() => logger.warn('AgentLink module activity hook failed'));
    }
  } catch (error) {
    throw abortFailure(error, context.signal) ?? error;
  } finally {
    await lease.release();
  }
};
