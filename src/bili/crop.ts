export type VideoCrop = { x: number; y: number; width: number; height: number };

/** Relative coordinates of the source frame, before resizing. */
export const visualCropRequest = (value: unknown): VideoCrop | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('画面裁剪范围无效。');
  const crop = value as VideoCrop;
  const keys = ['x', 'y', 'width', 'height'];

  if (
    Object.keys(crop).length !== 4 ||
    Object.keys(crop).some(key => !keys.includes(key)) ||
    keys.some(key => typeof crop[key] !== 'number' || !Number.isFinite(crop[key]))
  )
    throw new Error('画面裁剪需要x、y、width、height四个有限数值。');
  if (crop.x < 0 || crop.y < 0 || crop.width < 0.01 || crop.height < 0.01 || crop.x + crop.width > 1 || crop.y + crop.height > 1)
    throw new Error('画面裁剪坐标须在0–1内，宽高至少0.01，且不能越出画面。');

  return { x: crop.x, y: crop.y, width: crop.width, height: crop.height };
};

export const cropPixels = (width: number, height: number, crop: VideoCrop) => {
  const left = Math.floor(width * crop.x),
    top = Math.floor(height * crop.y);

  return {
    left,
    top,
    width: Math.max(1, Math.min(width, Math.ceil(width * (crop.x + crop.width))) - left),
    height: Math.max(1, Math.min(height, Math.ceil(height * (crop.y + crop.height))) - top)
  };
};
