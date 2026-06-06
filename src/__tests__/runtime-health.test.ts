import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateRuntimeHealth } from '../runtime-health.js';

describe('runtime-health', () => {
  it('requests shutdown after adapters stay unhealthy for the threshold', () => {
    const unhealthyStatus = {
      running: true,
      startedAt: '2026-04-14T00:00:00.000Z',
      adapters: [
        { channelType: 'telegram', running: false },
      ],
    };

    const first = evaluateRuntimeHealth({
      status: unhealthyStatus,
      pid: 1234,
      runId: 'run-1',
      previousConsecutiveUnhealthyTicks: 0,
      unhealthyExitThreshold: 3,
    });
    const second = evaluateRuntimeHealth({
      status: unhealthyStatus,
      pid: 1234,
      runId: 'run-1',
      previousConsecutiveUnhealthyTicks: first.nextConsecutiveUnhealthyTicks,
      unhealthyExitThreshold: 3,
    });
    const third = evaluateRuntimeHealth({
      status: unhealthyStatus,
      pid: 1234,
      runId: 'run-1',
      previousConsecutiveUnhealthyTicks: second.nextConsecutiveUnhealthyTicks,
      unhealthyExitThreshold: 3,
    });

    assert.equal(first.shouldExit, false);
    assert.equal(second.shouldExit, false);
    assert.equal(third.shouldExit, true);
    assert.equal(third.statusInfo.lastExitReason, 'all adapters unhealthy');
  });

  it('resets the unhealthy streak once any adapter is running again', () => {
    const unhealthy = evaluateRuntimeHealth({
      status: {
        running: true,
        startedAt: '2026-04-14T00:00:00.000Z',
        adapters: [{ channelType: 'telegram', running: false }],
      },
      pid: 1234,
      runId: 'run-1',
      previousConsecutiveUnhealthyTicks: 2,
      unhealthyExitThreshold: 3,
    });

    const recovered = evaluateRuntimeHealth({
      status: {
        running: true,
        startedAt: '2026-04-14T00:00:05.000Z',
        adapters: [{ channelType: 'telegram', running: true }],
      },
      pid: 1234,
      runId: 'run-1',
      previousConsecutiveUnhealthyTicks: unhealthy.nextConsecutiveUnhealthyTicks,
      unhealthyExitThreshold: 3,
    });

    assert.equal(recovered.shouldExit, false);
    assert.equal(recovered.nextConsecutiveUnhealthyTicks, 0);
    assert.deepEqual(recovered.statusInfo.channels, ['telegram']);
  });
});
