export type BiliEvidence = {
  basis: 'subtitles' | 'subtitle_excerpt' | 'metadata';
  hasSubtitleText: boolean;
  hasAudienceComments: boolean;
  visualObserved: false;
  audioObserved: false;
  limitation: string;
};

/** Describes received sources only, without rating the content or trusting comments as facts. */
export const biliEvidence = (
  subtitles: { status: string; text: string; truncated?: boolean },
  comments: { status: string; items: { text: string }[] }
): BiliEvidence => {
  const hasSubtitleText = subtitles.status === 'available' && Boolean(subtitles.text.trim());
  const basis = hasSubtitleText ? (subtitles.truncated ? 'subtitle_excerpt' : 'subtitles') : 'metadata';

  return {
    basis,
    hasSubtitleText,
    hasAudienceComments: comments.status === 'available' && comments.items.some(item => Boolean(item.text.trim())),
    visualObserved: false,
    audioObserved: false,
    limitation: hasSubtitleText
      ? subtitles.truncated
        ? '只有部分字幕可作内容依据，不可据此总结未返回的片段或声称理解全片；字幕本身也可能不准确。'
        : '可依据返回字幕讨论台词内容，不代表看过画面、听过音频或理解全片；字幕本身也可能不准确。'
      : '只有标题简介等元数据，不能声称了解视频情节或质量；可以说主题引起兴趣，或跳过分享。评论仅为观众观点，不能补成视频事实。'
  };
};
