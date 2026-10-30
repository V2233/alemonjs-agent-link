import { withVisionProvider } from '../media/vision';
import { describeVideoFrames } from '../media/providers';
import type { MediaConfig } from '../media/config';
import type { VideoFrame } from './visual';

export { visionSource as biliVisionSource } from '../media/vision';

export const describeBiliFrames = (frames: VideoFrame[], media: MediaConfig, signal: AbortSignal): Promise<string> =>
  withVisionProvider(media, signal, (settings, send) => describeVideoFrames(frames, settings, signal, send));
