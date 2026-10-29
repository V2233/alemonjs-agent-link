import { AdminInputError } from '../panel/admin-error';

export const normalizeHobbies = (raw: unknown) => {
  const value = raw === undefined ? {} : raw;

  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdminInputError('爱好设置必须为对象');
  const data = value as Record<string, unknown>;
  const keys = ['enabled', 'douyin', 'bilibili', 'qzone', 'interests'];

  if (Object.keys(data).some(key => !keys.includes(key))) throw new AdminInputError('未知的爱好设置');
  for (const key of keys.slice(0, 4)) {
    if (data[key] !== undefined && typeof data[key] !== 'boolean') throw new AdminInputError('爱好开关必须为布尔值');
  }
  if (data.interests !== undefined && (typeof data.interests !== 'string' || data.interests.length > 1000)) throw new AdminInputError('兴趣描述最多 1000 字');

  return {
    enabled: data.enabled === true,
    douyin: data.douyin === true,
    bilibili: data.bilibili === true,
    qzone: data.qzone === true,
    interests: typeof data.interests === 'string' ? data.interests.trim() : ''
  };
};
