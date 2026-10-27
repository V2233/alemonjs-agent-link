import { ResultCode, useMember } from 'alemonjs';

type AdminEvent = { Platform?: string; BotId?: string; IsPrivate?: boolean; IsAdmin?: boolean; UserId?: string; ChannelId?: string };
type MemberResult = { code: number; data?: { UserId?: string; GuildId?: string; Role?: string } };
// Only platform metadata or a scoped member-role response can authorize issuance.
export const verifyGroupKeyAdmin = async (event: AdminEvent, lookup?: () => Promise<MemberResult>): Promise<boolean> => {
  if (event.IsPrivate || !event.Platform || !event.ChannelId || !event.UserId) return false;
  if (event.IsAdmin === true) return true;
  if (event.IsAdmin === false) return false;
  let timer: ReturnType<typeof setTimeout>;

  try {
    const query =
      lookup ||
      (() => {
        const [member] = useMember(event);

        return member.info({ userId: event.UserId });
      });
    const result = await Promise.race([
      query(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('role timeout')), 5000);
      })
    ]);
    const value = result.data;

    return (
      result.code === ResultCode.Ok &&
      value?.UserId === event.UserId &&
      (!value.GuildId || value.GuildId === event.ChannelId) &&
      ['admin', 'owner'].includes(value.Role || '')
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};
