export class DSHError extends Error {
  constructor(
    public readonly kind: 'auth' | 'http' | 'network' | 'timeout' | 'cancelled' | 'protocol' | 'agent' | 'migration' | 'delivery' | 'media',
    message: string
  ) {
    super(message);
    this.name = 'DSHError';
  }
}

export const abortFailure = (error: unknown, signal?: AbortSignal): DSHError | undefined => {
  const reason = signal?.aborted ? signal.reason : error;

  if (reason instanceof Error && reason.name === 'TimeoutError') {
    return new DSHError('timeout', 'Agent 请求超过本轮时限');
  }
  if (signal?.aborted || (reason instanceof Error && reason.name === 'AbortError')) {
    return new DSHError('cancelled', '请求已取消');
  }

  return undefined;
};
