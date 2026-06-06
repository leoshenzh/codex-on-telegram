export interface RuntimeAdapterHealth {
  channelType: string;
  running: boolean;
}

export interface RuntimeBridgeStatus {
  running: boolean;
  startedAt?: string | null;
  adapters: RuntimeAdapterHealth[];
}

export interface RuntimeStatusInfo {
  running: boolean;
  pid: number;
  runId: string;
  startedAt: string;
  channels: string[];
  lastExitReason?: string;
}

export interface RuntimeHealthEvaluation {
  statusInfo: RuntimeStatusInfo;
  nextConsecutiveUnhealthyTicks: number;
  shouldExit: boolean;
}

export function evaluateRuntimeHealth(input: {
  status: RuntimeBridgeStatus;
  pid: number;
  runId: string;
  previousConsecutiveUnhealthyTicks: number;
  unhealthyExitThreshold: number;
  fallbackStartedAt?: string;
}): RuntimeHealthEvaluation {
  const activeChannels = input.status.adapters
    .filter((adapter) => adapter.running)
    .map((adapter) => adapter.channelType);
  const unhealthy = input.status.running
    && input.status.adapters.length > 0
    && activeChannels.length === 0;
  const nextConsecutiveUnhealthyTicks = unhealthy
    ? input.previousConsecutiveUnhealthyTicks + 1
    : 0;

  return {
    statusInfo: {
      running: input.status.running && activeChannels.length > 0,
      pid: input.pid,
      runId: input.runId,
      startedAt: input.status.startedAt || input.fallbackStartedAt || new Date().toISOString(),
      channels: activeChannels,
      lastExitReason: unhealthy ? 'all adapters unhealthy' : undefined,
    },
    nextConsecutiveUnhealthyTicks,
    shouldExit: unhealthy && nextConsecutiveUnhealthyTicks >= input.unhealthyExitThreshold,
  };
}
