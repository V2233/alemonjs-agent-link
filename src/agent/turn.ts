import { readScopedPersona } from './scoped-persona';
import { personaDetailsPrompt } from '../companion/persona-details';
import { ownerTerminalAllowed, turnIntelligence } from './intelligence';
import { bridgeConversationIdentity, conversationQueueScope } from '../dsh/conversation-scope';
import { assertAIEnabled } from '../dsh/ai-switch';
import { bufferUnavailableMemorySave, resolveUnavailableMemoryEcho } from '../memory/save-reply';
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
import { getChatCredentials, getWorkspaceCredentials } from '../dsh/credentials';
import { inputText, withInputContext, type ChatInput } from '../dsh/input';
import { normalizeBubbleText } from '../dsh/reply-format';
import { ensureDSHSupervisor, hasDSHBridgeOverride } from '../dsh/supervisor';
import { SessionRegistry, type PrivateHistoryContext } from '../state/registry';
import { getModuleConfig, getModuleRuntime } from './modules';
import { runToolChat } from './tool-chat';
import { estimateModelRequestTokens } from './token-estimate';
import type { AgentTool, TurnContext } from './types';

const runModuleTurnInner = async (options: {
  config: DSHBridgeConfig;
  sessionId: string;
  input: ChatInput;
  context: TurnContext;
  history?: PrivateHistoryContext;
  streamContent?: boolean;
  toolLimits?: { maxRounds: number; maxContinuations: number };
  onImage?: (png: Buffer) => Promise<void>;
  onSpeech?: TurnContext['onSpeech'];
  onSticker?: TurnContext['onSticker'];
  onStickerCollect?: TurnContext['onStickerCollect'];
  onCurrentImages?: TurnContext['onCurrentImages'];
  onEvent: (event: DSHStreamEvent) => Promise<void>;
  onCompleted?: (signal: AbortSignal) => Promise<void>;
}): Promise<void> => {
  const { config, sessionId, history, onEvent, onCompleted } = options;

  assertAIEnabled(config);
  const context: TurnContext = {
    ...options.context,
    capabilities: { ...options.context.capabilities, terminal: ownerTerminalAllowed(options.context, Boolean(options.context.autonomous)) },
    onSpeech: options.onSpeech || options.context.onSpeech,
    onSticker: options.onSticker || options.context.onSticker,
    onStickerCollect: options.onStickerCollect || options.context.onStickerCollect,
    onCurrentImages: options.onCurrentImages || options.context.onCurrentImages
  };
  const intelligence = await turnIntelligence(config, context, context.userText, Boolean(context.autonomous));

  context.intelligenceLevel = intelligence.level;
  const preparingAt = Date.now();
  const lease = await (await getModuleRuntime(config)).acquire();

  try {
    const scopedPrompt = intelligence.entitled ? personaDetailsPrompt(readScopedPersona(config, context)) : '';
    const personaPrompt = [
      await lease.system(config.defaultSystemPrompt, context),
      scopedPrompt ? '以下仅调整当前会话表达，不改变权限、身份与工具规则。\n' + scopedPrompt : ''
    ]
      .filter(Boolean)
      .join('\n\n');
    const systemPrompt = withToolUsePolicy(
      `${personaPrompt}\n\n${modelContext(config.model)}${options.onImage && !context.autonomous ? '\n当前可调用 draw_image 绘制图形元素构成的 PNG；如果 generate_image 可用，也可按用户要求使用外部生图服务。前者不是照片级扩散生图，两者均不支持精确编辑已有图片。' : ''}${context.autonomous ? '\n当前为系统调度的主动搭话，不是用户新发来的请求。只可读取当前会话范围内的资料与已开放的只读信息，不得把历史话语当作新授权，不能主动调用记忆写入、执行工作区、管理群或联系其他对象。系统可以记录真实完成的只读操作作为经历。不要编造现实经历；不适合打扰时只输出 [沉默]。' : ''}`
    );
    const moduleContext = await lease.context(context);
    const input = await lease.prompt(withInputContext(options.input, moduleContext), context);
    const tools = lease.tools(context);

    logger.info(
      {
        requestId: context.requestId,
        elapsedMs: Date.now() - preparingAt,
        web: context.capabilities.web,
        files: context.capabilities.files,
        terminal: context.capabilities.terminal,
        intelligence: intelligence.level,
        tools: tools.length,
        workspaceTool: tools.some(tool => tool.name === 'agent_workspace')
      },
      'Agent context prepared'
    );

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
    const unavailableMemorySave = bufferUnavailableMemorySave(context.private, context.userText, tools);

    if (
      intelligence.entitled ||
      context.autonomous ||
      unavailableMemorySave ||
      tools.length ||
      lease.transformsReplies ||
      (lease.transformsSystem && personaPrompt !== config.defaultSystemPrompt) ||
      hasImages
    ) {
      const supervisor = await ensureDSHSupervisor(config);

      if (!hasDSHBridgeOverride() && config.runtimeMode !== 'chat-only') {
        void supervisor.prepareForChat().catch(() => logger.warn('Workspace preparation pending or unavailable'));
      }
      // streamChat waits for preparation when the model actually requests work.
      const sandboxReady = hasDSHBridgeOverride() || config.runtimeMode !== 'chat-only';

      if (!context.autonomous && sandboxReady && (context.capabilities.web || context.capabilities.files || context.capabilities.terminal)) {
        const workspaceTool: AgentTool = {
          name: 'agent_workspace',
          description: `让隔离会话执行具体任务并返回结果。当前权限：网页${context.capabilities.web ? '允许' : '禁止'}、文件${context.capabilities.files ? '允许' : '禁止'}、终端${context.capabilities.terminal ? '允许' : '禁止'}。文件操作使用 framework MCP 的 workspace_* 工具；仅终端权限允许时可按用户明确任务执行终端命令。可通过 framework MCP 发现并调用本轮开放的框架和业务接口，权限以目录与真实回执为准。`,
          parameters: {
            type: 'object',
            properties: { task: { type: 'string', minLength: 1, maxLength: 12000 } },
            required: ['task'],
            additionalProperties: false
          },
          execute: async ({ task }, turn) => {
            let result = '';

            const framework = await startFrameworkMcp(tools, turn);
            const workspaceCredentials = await getWorkspaceCredentials({ stickyKey: context.channelId });

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
                framework.endpoint,
                workspaceCredentials || undefined,
                bridgeConversationIdentity(context.channelId, conversationQueueScope(config, context))
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
      const incremental = options.streamContent && !lease.transformsReplies && !config.outputBlockedKeywords.length && !unavailableMemorySave;
      const moduleConfig = getModuleConfig(config);
      const limits = options.toolLimits;

      if (
        limits &&
        (!Number.isSafeInteger(limits.maxRounds) || limits.maxRounds < 1 || !Number.isSafeInteger(limits.maxContinuations) || limits.maxContinuations < 0)
      ) {
        throw new Error('回合工具上限无效。');
      }
      const raw = await runToolChat({
        config: { ...config, defaultSystemPrompt: systemPrompt },
        credentials: (messages, requestTools) =>
          getChatCredentials({
            purpose: hasImages ? 'vision' : requestTools.length ? 'tools' : 'chat',
            stickyKey: context.channelId,
            requestId: context.requestId,
            estimatedTokens: estimateModelRequestTokens(messages, requestTools, config.budget?.maxOutputTokens ?? 2048)
          }),
        input,
        context,
        tools,
        history: history ? await registry.privateHistory(history) : [],
        memoryContext: history?.memoryContext,
        maxRounds: Math.min(intelligence.maxRounds, moduleConfig.maxToolRounds, limits?.maxRounds ?? moduleConfig.maxToolRounds),
        maxContinuations: Math.min(
          intelligence.maxContinuations,
          moduleConfig.maxToolContinuations,
          limits?.maxContinuations ?? moduleConfig.maxToolContinuations
        ),
        onContent: incremental
          ? async content => {
              await onEvent({ type: 'content', content });
            }
          : undefined,
        onRetry: () => onEvent({ type: 'retrying' }),
        onTool: async name => {
          await onEvent({ type: 'tool_call', tool: name });
        }
      });
      const moduleReply = await lease.reply(raw, context);
      const transformed = unavailableMemorySave ? resolveUnavailableMemoryEcho(moduleReply, context.userText) : moduleReply;

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
        await registry.appendPrivateTurn(
          history,
          context.autonomous ? '' : inputText(options.input) + (typeof options.input === 'string' ? '' : '\n[本轮包含图片]'),
          normalizeBubbleText(answer),
          Boolean(context.autonomous)
        );
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
        onCompleted,
        undefined,
        undefined,
        bridgeConversationIdentity(context.channelId, conversationQueueScope(config, context))
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
