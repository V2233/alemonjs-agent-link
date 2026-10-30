import { DSHError } from './errors';

// Inspect the full diagnostic before logging truncation; providers may nest JSON
// inside error.message. Do not expose the provider payload as conversational text.
export const providerImageError = (status: number, detail: string): DSHError | undefined => {
  if (
    [400, 422].includes(status) &&
    /image not recognized|replace the image|图片无法识别|圖片無法辨識|invalid image|invalid_image|failed to decode image|unsupported image format/iu.test(
      detail
    )
  ) {
    return new DSHError('media', '这张图我没认出来，换一张试试，或者用文字告诉我吧。');
  }

  return undefined;
};
