import type { ChatInput } from '../dsh/input';
import type { AgentCapabilities } from '../dsh/client';
import type { SpeechAudio } from '../media/speech';

export type TurnContext = {
  requestId?: string;
  yieldForTools?: () => Promise<void>;
  inputId?: string;
  addressed?: boolean;
  autonomous?: boolean;
  independentReading?: boolean;
  allowedTools?: readonly string[];
  onSpeech?: (audio: SpeechAudio) => Promise<void>;
  onSticker?: (item: import('../media/stickers').Sticker, data: Buffer) => Promise<void>;
  onStickerCollect?: (signal: AbortSignal) => Promise<Buffer>;
  onCurrentImages?: (signal: AbortSignal) => Promise<Buffer[]>;
  onGroupInboxSpeakers?: (speakerIds: string[]) => void;
  onGroupWakeValid?: () => boolean;
  onGroupWait?: (request: import('../social/group-wait').GroupWaitRequest) => import('../social/group-wait').GroupWaitResult;
  channelId: string;
  userId: string;
  platform: string;
  botId?: string;
  private: boolean;
  owner: boolean;
  userText: string;
  capabilities: AgentCapabilities;
  signal: AbortSignal;
};

export type ToolSchema = {
  type: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  properties?: Record<string, ToolSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: ToolSchema;
  enum?: (string | number | boolean)[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
};

export type AgentTool = {
  readOnly?: boolean;
  name: string;
  description: string;
  parameters: ToolSchema;
  available?: (context: TurnContext) => boolean;
  execute: (args: Record<string, unknown>, context: TurnContext) => Promise<unknown>;
};

export type ModuleHooks = {
  system: (prompt: string, context: TurnContext) => string | Promise<string>;
  context: (context: TurnContext) => string | Promise<string>;
  prompt: (input: ChatInput, context: TurnContext) => ChatInput | Promise<ChatInput>;
  reply: (text: string, context: TurnContext) => string | Promise<string>;
  activity: (activity: { input: string; output: string }, context: TurnContext) => void | Promise<void>;
};

export type ModuleApi = {
  id: string;
  dataDirectory: string;
  settings: Readonly<Record<string, unknown>>;
  tool: (tool: AgentTool) => void;
  on: <K extends keyof ModuleHooks>(event: K, handler: ModuleHooks[K]) => void;
  onDispose: (cleanup: () => void | Promise<void>) => void;
};

export type AgentModule = {
  id: string;
  name: string;
  version: string;
  apiVersion: 1;
  setup: (api: ModuleApi) => void | Promise<void>;
};

export type ModuleConfig = {
  directory?: string;
  disabled?: string[];
  settings?: Record<string, Record<string, unknown>>;
  maxToolRounds?: number;
  maxToolContinuations?: number;
};
