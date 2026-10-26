import { useClient, ResultCode } from 'alemonjs';
import type { TurnContext } from '../agent/types';
import type { GroupOperation } from '../onebot/actions';

export class PlatformOperationError extends Error {
  constructor(readonly kind: string) {
    super('平台没有确认操作完成。');
  }
}
type Bridge = {
  agentLink: {
    capabilities(): Promise<unknown>;
    poke(): Promise<unknown>;
    groupRole(args: { groupId?: string }): Promise<unknown>;
    manageGroup(args: GroupOperation): Promise<unknown>;
  };
};
export const platformClient = (context: TurnContext) => {
  if (context.platform !== 'onebot') {
    throw new PlatformOperationError('unsupported');
  }
  const [client] = useClient<Bridge>({
    Platform: context.platform,
    BotId: context.botId,
    IsPrivate: context.private,
    UserId: context.userId,
    ...(context.private ? {} : { ChannelId: context.channelId, GuildId: context.channelId }),
    Target: { scope: context.private ? 'c2c' : 'group', targetId: context.private ? context.userId : context.channelId, BotId: context.botId }
  } as never);
  const checked = async <T>(run: () => Promise<unknown>): Promise<T> => {
    context.signal.throwIfAborted();
    const results = (await run()) as { code: number; data: { kind?: string } }[];

    if (!Array.isArray(results) || results.length !== 1 || results[0].code !== ResultCode.Ok) {
      throw new PlatformOperationError(results?.[0]?.data?.kind || 'unknown');
    }
    context.signal.throwIfAborted();

    return results[0].data as T;
  };

  return {
    capabilities: () => checked<{ state: string; botId: string; capabilities: string[] }>(() => client.agentLink.capabilities()),
    role: (groupId?: string) => checked<{ groupId: string; role: 'owner' | 'admin' | 'member' }>(() => client.agentLink.groupRole({ groupId })),
    poke: () => checked<{ ok: boolean }>(() => client.agentLink.poke()),
    manage: (operation: GroupOperation) => checked<{ ok: boolean }>(() => client.agentLink.manageGroup(operation))
  };
};
