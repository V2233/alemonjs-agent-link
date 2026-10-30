import { videoId } from './client';
import { visualSampleRequest } from './visual';
import { visualCropRequest } from './crop';

export type AutomaticReadRequest = { link: string; visualAt?: unknown; visualCrop?: unknown; visualFocus?: unknown };
export type AutomaticReadTicket = { readonly key: string; readonly kind: 'initial' | 'overview' | 'refinement' };
type ReadingResult = {
  video: { bvid: string };
  visual: { region?: string; timestamps: number[] };
  evidence: { visualObserved: boolean };
};

/** Per-turn attempts, including failures. A refinement spends the same budget as a new candidate. */
export class AutomaticReadingAttempts {
  private searched = false;
  private attempts = 0;
  private readonly links = new Set<string>();
  private readonly pending = new WeakSet<AutomaticReadTicket>();
  private readonly overviews = new Map<string, { times: number[]; refined: boolean }>();

  claimSearch(): boolean {
    if (this.searched) return false;
    this.searched = true;

    return true;
  }

  snapshot(limit: number, allowRefinement: boolean) {
    const remainingAttempts = Math.max(0, (Number.isSafeInteger(limit) && limit >= 0 && limit <= 3 ? limit : 0) - this.attempts);

    return {
      attemptsUsed: this.attempts,
      remainingAttempts,
      refinableVideos: allowRefinement && remainingAttempts > 0 ? [...this.overviews].filter(([, entry]) => !entry.refined).map(([bvid]) => bvid) : []
    };
  }

  private decide(request: AutomaticReadRequest, limit: number, allowRefinement: boolean) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 3 || this.attempts >= limit) return { reason: 'attempt_limit' as const };
    const parsed = videoId(request.link);
    const bvid = parsed && 'bvid' in parsed ? parsed.bvid : undefined;
    const key = bvid || (parsed && 'aid' in parsed ? `av${parsed.aid}` : parsed && 'short' in parsed ? parsed.short : request.link.trim());
    const kind: AutomaticReadTicket['kind'] =
      request.visualAt === undefined && request.visualCrop === undefined && (request.visualFocus === undefined || request.visualFocus === 'frames')
        ? 'overview'
        : 'initial';

    if (!this.links.has(key)) return { key, kind };
    if (!allowRefinement) return { reason: 'refinement_disabled' as const };
    const overview = bvid && this.overviews.get(bvid);

    if (!overview) return { reason: 'overview_required' as const };
    if (overview.refined) return { reason: 'refinement_already_attempted' as const };
    try {
      const at = visualSampleRequest(request.visualAt);
      const crop = visualCropRequest(request.visualCrop);
      const focus = request.visualFocus ?? 'frames';

      if (!at) return { reason: 'explicit_times_required' as const };
      if (!['frames', 'subtitles'].includes(String(focus)) || (crop && focus !== 'frames')) return { reason: 'invalid_refinement_request' as const };
      if (!crop && focus === 'frames' && at.every(time => overview.times.some(previous => Math.abs(previous - time) <= 0.001)))
        return { reason: 'already_sampled_points' as const };
    } catch {
      return { reason: 'invalid_refinement_request' as const };
    }

    return { key, kind: 'refinement' as const, overview };
  }

  rejectionReason(request: AutomaticReadRequest, limit: number, allowRefinement: boolean) {
    return this.decide(request, limit, allowRefinement).reason;
  }

  claim(request: AutomaticReadRequest, limit: number, allowRefinement: boolean): AutomaticReadTicket | undefined {
    const decision = this.decide(request, limit, allowRefinement);

    if (decision.reason) return;
    if (decision.overview) decision.overview.refined = true;
    this.attempts++;
    this.links.add(decision.key);
    const ticket: AutomaticReadTicket = Object.freeze({ key: decision.key, kind: decision.kind });

    this.pending.add(ticket);

    return ticket;
  }

  complete(ticket: AutomaticReadTicket, result?: ReadingResult): void {
    if (!this.pending.delete(ticket) || !result) return;
    const parsed = videoId(result.video.bvid);

    if (!parsed || !('bvid' in parsed) || parsed.bvid !== result.video.bvid) return;
    const bvid = parsed.bvid;

    this.links.add(bvid);
    if (ticket.kind !== 'overview' || !result.evidence.visualObserved || ['crop', 'bottom_band'].includes(result.visual.region) || this.overviews.has(bvid))
      return;
    const times = result.visual.timestamps;

    if (!times.length || times.length > 9 || times.some(time => !Number.isFinite(time) || time < 0)) return;
    this.overviews.set(bvid, { times: times.slice(), refined: false });
  }
}
