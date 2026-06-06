import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSSEChunks, withEnv, expectStreamToFinishWithin } from './_codex-provider-test-helpers.js';

describe('CodexProvider mid-stream timeout surfaces an error event', () => {
  it('enqueues an error event with reason=mid_stream_timeout when the watchdog trips after partial text', async () => {
    await withEnv({
      CTI_CODEX_MID_STREAM_IDLE_MS: '30',
      CTI_CODEX_TERMINAL_IDLE_MS: '30',
    }, async () => {
      const { CodexProvider } = await import('../codex-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const provider = new CodexProvider(new PendingPermissions());

      // Iterator emits thread.started, then a partial text item, then
      // hangs forever with no tool in flight. Watchdog must fire AND
      // surface a structured error event before closing the stream.
      let nextCalls = 0;
      const iterator: AsyncIterator<Record<string, unknown>> = {
        async next() {
          nextCalls += 1;
          if (nextCalls === 1) {
            return {
              done: false,
              value: { type: 'thread.started', thread_id: 'mid-stream-error-thread' },
            };
          }
          if (nextCalls === 2) {
            return {
              done: false,
              value: {
                type: 'item.completed',
                item: { id: 'msg-1', type: 'agent_message', text: 'partial answer' },
              },
            };
          }
          // Hang forever — the watchdog must fire because nothing is in flight.
          return await new Promise<IteratorResult<Record<string, unknown>>>(() => {});
        },
        async return() {
          return { done: true, value: undefined };
        },
      };

      const mockThread = {
        runStreamed: () => ({
          events: {
            [Symbol.asyncIterator]() {
              return iterator;
            },
          },
        }),
      };

      (provider as any).sdk = { Codex: class { constructor() {} } };
      (provider as any).codex = {
        startThread: () => mockThread,
      };

      const stream = provider.streamChat({
        prompt: 'partial then hang',
        sessionId: 'mid-stream-error-session',
      });

      const chunks = await expectStreamToFinishWithin(stream, 1000);
      const events = parseSSEChunks(chunks);
      const errorEvent = events.find(e => e.type === 'error');

      assert.ok(errorEvent, 'Mid-stream watchdog must enqueue an error event');
      const payload = JSON.parse(errorEvent!.data) as Record<string, unknown>;
      assert.equal(payload.reason, 'mid_stream_timeout', 'Error payload must identify the mid-stream timeout');
      assert.equal(typeof payload.midStreamIdleMs, 'number', 'Error payload must include the effective deadline');
      assert.equal(payload.midStreamIdleMs, 30, 'Effective deadline must reflect the env override, not the static default');
      assert.equal(typeof payload.lastEventType, 'string', 'Error payload must include the last event type');
      assert.ok(Array.isArray(payload.inFlightToolIds), 'Error payload must include the in-flight tool id list');
      assert.equal(typeof payload.elapsedMs, 'number', 'Error payload must include the elapsed ms since the last event');
    });
  });
});
