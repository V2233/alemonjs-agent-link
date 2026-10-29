export type BiliEvidence = {
  basis: 'subtitles' | 'subtitle_excerpt' | 'metadata' | 'sampled_frames';
  hasSubtitleText: boolean;
  hasAudienceComments: boolean;
  visualObserved: boolean;
  sampledTimestamps: number[];
  audioObserved: false;
  limitation: string;
};

/** Describes received sources only, without rating the content or trusting comments as facts. */
export const biliEvidence = (
  subtitles: { status: string; text: string; truncated?: boolean },
  comments: { status: string; items: { text: string }[] },
  visual?: { status: string; timestamps: number[]; description: string }
): BiliEvidence => {
  const hasSubtitleText = subtitles.status === 'available' && Boolean(subtitles.text.trim());
  const visualObserved =
    visual?.status === 'available' &&
    Boolean(visual.description.trim()) &&
    visual.timestamps.length > 0 &&
    visual.timestamps.length <= 3 &&
    visual.timestamps.every(time => Number.isFinite(time) && time >= 0);
  const basis = hasSubtitleText ? (subtitles.truncated ? 'subtitle_excerpt' : 'subtitles') : visualObserved ? 'sampled_frames' : 'metadata';

  return {
    basis,
    hasSubtitleText,
    hasAudienceComments: comments.status === 'available' && comments.items.some(item => Boolean(item.text.trim())),
    visualObserved,
    sampledTimestamps: visualObserved ? visual.timestamps.slice() : [],
    audioObserved: false,
    limitation: visualObserved
      ? '视觉模型只描述了 sampledTimestamps 所列位置的采样静帧，描述可能出错；不能推断帧间过程、未采样情节、音频或全片质量。字幕若截断也只能讨论返回部分；评论仅为观众观点。'
      : hasSubtitleText
        ? subtitles.truncated
          ? '只有部分字幕可作内容依据，不可据此总结未返回的片段或声称理解全片；字幕本身也可能不准确。'
          : '可依据返回字幕讨论台词内容，不代表看过画面、听过音频或理解全片；字幕本身也可能不准确。'
        : '只有标题简介等元数据，不能声称了解视频情节或质量；可以说主题引起兴趣，或跳过分享。评论仅为观众观点，不能补成视频事实。'
  };
};
