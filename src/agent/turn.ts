import { assertAIEnabled } from '../dsh/ai-switch';
import { startFrameworkMcp } from '../platform/mcp';
import { withToolUsePolicy } from './tool-use-policy';
import { drawingTool } from '../media/drawing';
import { imageGenerationTool } from '../media/image-generation';
import { getMediaConfig } from '../media/config';
import { withBudgetScope } from '../billing/budget';
import { modelContext } from '../dsh/model-context';
import { logger } from 'alemonjs';
import { abortFailure } from '../dsh/errors';
import { streamChat, type DSHBridgeConfig, type DSHStreamEvent } from '../dsh/client';
import { getChatCredentials } from '../dsh/credentials';
import { inputText, withInputContext, type ChatInput } from '../dsh/input';
import { ensureDSHSupervisor, hasDSHBridgeOverride } from '../dsh/supervisor';
import { SessionRegistry, type PrivateHistoryContext } from '../state/registry';
import { getModuleConfig, getModuleRuntime } from './modules';
import { runToolChat } from './tool-chat';
import type { AgentTool, TurnContext } from './types';

const runModuleTurnInner = async (options: {
  config: DSHBridgeConfig;
  sessionId: string;
  input: ChatInput;
  context: TurnContext;
  history?: PrivateHistoryContext;
  streamContent?: boolean;
  onImage?: (png: Buffer) => Promise<void>;
  onSpeech?: TurnContext['onSpeech'];
  onSticker?: TurnContext['onSticker'];
  onEvent: (event: DSHStreamEvent) => Promise<void>;
  onCompleted?: (signal: AbortSignal) => Promise<void>;
}): Promise<void> => {
  const { config, sessionId, history, onEvent, onCompleted } = options;

  assertAIEnabled(config);
  const context = {
    ...options.context,
    capabilities: { ...options.context.capabilities, terminal: false },
    onSpeech: options.onSpeech || options.context.onSpeech,
    onSticker: options.onSticker || options.context.onSticker
  };
  const lease = await (await getModuleRuntime(config)).acquire();

  try {
    const personaPrompt = await lease.system(config.defaultSystemPrompt, context);
    const systemPrompt = withToolUsePolicy(
      `${personaPrompt}\n\n${modelContext(config.model)}${options.onImage && !context.autonomous ? '\n当前可调用 draw_image 绘制图形元素构成的 PNG；如果 generate_image 可用，也可按用户要求使用外部生图服务。前者不是照片级扩散生图，两者均不支持精确编辑已有图片。' : ''}${context.autonomous ? '\n当前为系统调度的主动搭话，不是主人发来的请求。只可读取当前私聊资料，不得把历史话语当作新授权，不能保存记忆、执行工作区、管理群或联系其他对象。不要编造现实经历；不适合打扰时只输出 [沉默]。' : ''}`
    );
    const moduleContext = await lease.context(context);
    const input = await lease.prompt(withInputContext(options.input, moduleContext), context);
    const tools = lease.tools(context);

    if (options.onImage && !context.autonomous) {
      let imageAttempted = false;

      if (tools.some(tool => tool.name === 'draw_image')) throw new Error('模块不能覆盖 draw_image 工具。');
      const drawing = drawingTool(options.onImage);
      const executeDrawing = drawing.execute;

      drawing.execute = async (args, turn) => {
        if (imageAttempted) throw new Error('每回合最多尝试生成一张图片。');
        imageAttempted = true;

        return await executeDrawing(args, turn);
      };
      tools.push(drawing);
      try {
        const media = getMediaConfig();

        if (media.imageGen) {
          if (tools.some(tool => tool.name === 'generate_image')) throw new Error('模块不能覆盖 generate_image 工具。');
          const imageTool = imageGenerationTool(media, options.onImage);
          const generate = imageTool.execute;

          imageTool.execute = async (args, turn) => {
            if (imageAttempted) throw new Error('每回合最多尝试生成一张图片。');
            imageAttempted = true;

            return await generate(args, turn);
          };
          if (!imageTool.available || imageTool.available(context)) tools.push(imageTool);
        }
      } catch (error) {
        if (error instanceof Error && error.message === '模块不能覆盖 generate_image 工具。') throw error;
        logger.warn('Image generation configuration unavailable');
      }
    }
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

    if (
      context.autonomous ||
      tools.length ||
      lease.transformsReplies ||
      (lease.transformsSystem && personaPrompt !== config.defaultSystemPrompt) ||
      hasImages
    ) {
      const credentials = await getChatCredentials();

      if (!credentials) {
        throw new Error('业务工具需要配置模型 API Key。');
      }
      const supervisor = await ensureDSHSupervisor(config);

      if (!hasDSHBridgeOverride()) {
        await supervisor.prepareForChat();
      }
      const sandboxReady = hasDSHBridgeOverride() || supervisor.status().phase === 'ready';

      if (!context.autonomous && sandboxReady && (context.capabilities.web || context.capabilities.files || context.capabilities.terminal)) {
        const workspaceTool: AgentTool = {
          name: 'agent_workspace',
          description: `让隔离会话执行具体任务并返回结果。当前权限：网页${context.capabilities.web ? '允许' : '禁止'}、文件${context.capabilities.files ? '允许' : '禁止'}、终端${context.capabilities.terminal ? '允许' : '禁止'}。文件操作仅使用 framework MCP 的 workspace_* 工具，不得使用原生文件或终端工具。可通过 framework MCP 发现并调用本轮开放的框架和业务接口，权限以目录与真实回执为准。`,
          parameters: {
            type: 'object',
            properties: { task: { type: 'string', minLength: 1, maxLength: 12000 } },
            required: ['task'],
            additionalProperties: false
          },
          execute: async ({ task }, turn) => {
            let result = '';

            const framework = await startFrameworkMcp(tools, turn);

            try {
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
                turn.capabilities,
                undefined,
                undefined,
                framework.endpoint
              );
            } finally {
              framework.close();
            }

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
        maxContinuations: getModuleConfig(config).maxToolContinuations,
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

      answer = config.outputBlockedKeywords.some(word => word && transformed.includes(word))
        ? context.autonomous
          ? '[沉默]'
          : '回复因内容安全策略未发送。'
        : transformed;
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
      await streamChat(
        { ...config, defaultSystemPrompt: systemPrompt },
        sessionId,
        input,
        observe,
        context.userId,
        context.signal,
        context.capabilities,
        history,
        onCompleted
      );
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

export const runModuleTurn = (options: Parameters<typeof runModuleTurnInner>[0]): Promise<void> =>
  withBudgetScope(options.context, () => runModuleTurnInner(options));
