export type MemberRoleEvent = { IsPrivate?: boolean; Role?: string; IsAdmin?: boolean };

// QQ supplies Role; OneBot and other adapters may supply only IsAdmin.
// Only normalized event metadata is trusted, never message text or quoted authors.
export const groupAdminStatus = (event: MemberRoleEvent): boolean | null => {
  if (event.IsPrivate) return null;
  if (event.Role === 'owner' || event.Role === 'admin') return true;
  if (event.Role === 'member') return false;

  return typeof event.IsAdmin === 'boolean' ? event.IsAdmin : null;
};
