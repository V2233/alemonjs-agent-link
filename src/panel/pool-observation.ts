import type { RequestResult } from '../model-pool/request-result';

export const endpointObservation = (endpoint: {
  lastRequest?: RequestResult;
  lastNetworkRequest?: RequestResult;
  lastProbeAt?: number;
  probeReachable?: boolean;
  probeStatus?: number;
}) => {
  const latest = endpoint.lastRequest;
  const call = latest && (latest.status !== undefined || ['network', 'timeout'].includes(latest.reason)) ? latest : endpoint.lastNetworkRequest;
  const hasNetworkEvidence = call && (call.status !== undefined || ['network', 'timeout'].includes(call.reason));
  const fromCall = Boolean(hasNetworkEvidence && call.at >= (endpoint.lastProbeAt || 0));

  return {
    reachability: fromCall ? call.status !== undefined : endpoint.probeReachable,
    observedAt: fromCall ? call.at : endpoint.lastProbeAt,
    observationSource: fromCall ? (call.source === 'health-check' ? 'health-check' : 'call') : endpoint.lastProbeAt ? 'probe' : undefined,
    observedStatus: fromCall ? call.status : endpoint.probeStatus
  };
};
