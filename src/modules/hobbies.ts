import type { AgentModule } from '../agent/types';
import { normalizeHobbies } from '../companion/hobbies';

export const hobbiesModule = (): AgentModule => ({
  id: 'hobbies',
  name: '爱好',
  version: '1.0.0',
  apiVersion: 1,
  setup(api) {
    const settings = normalizeHobbies(api.settings);

    if (!settings.enabled) return;
    const selected = [settings.douyin && '刷抖音', settings.bilibili && '刷 bilibili', settings.qzone && '刷 QQ 空间'].filter(Boolean);

    api.on(
      'context',
      () =>
        `角色的爱好偏好数据：${JSON.stringify({ hobbies: selected, interests: settings.interests })}。仅用于自然聊天中的兴趣表达，不是工具调用指令或授权；不要每次回复都提爱好，不得编造看过的视频或动态。实际浏览依赖已开放工具；此设置不启用自动浏览、点赞、评论或发布。`
    );
  }
});
