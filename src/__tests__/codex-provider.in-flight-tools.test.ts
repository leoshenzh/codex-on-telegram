import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSSEChunks, withEnv, expectStreamToFinishWithin } from './_codex-provider-test-helpers.js';

describe('CodexProvider in-flight tool tracking', () => {
  it('does NOT trip the mid-stream watchdog while a tool call is in flight', async () => {
    await withEnv({
      CTI_CODEX_MID_STREAM_IDLE_MS: '40',
      CTI_CODEX_TERMINAL_IDLE_MS: '40',
      CTI_CODEX_TOOL_WALLCLOCK_MS: '5000',
    }, async () => {
      const { CodexProvider } = await import('../codex-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const provider = new CodexProvider(new PendingPermissions());

      // Iterator emits thread.started, then item.started for a tool, then
      // hangs for 120ms (3x the mid-stream idle), then completes the tool,
      // then turn.completed. Expected: stream completes normally — the
      // hang is excused because a tool is in flight.
      let nextCalls = 0;
      const iterator: AsyncIterator<Record<string, unknown>> = {
        async next() {
          nextCalls += 1;
          if (nextCalls === 1) {
            return {
              done: false,
              value: { type: 'thread.started', thread_id: 'in-flight-thread' },
            };
          }
          if (nextCalls === 2) {
            return {
              done: false,
              value: {
                type: 'item.started',
                item: { id: 'cmd-1', type: 'command_execution', command: 'sleep 1' },
              },
            };
          }
          if (nextCalls === 3) {
            // Hang for 3x the mid-stream idle. The watchdog MUST NOT fire
            // because the tool above is still in flight.
            await new Promise(resolve => setTimeout(resolve, 120));
            return {
              done: false,
              value: {
                type: 'item.completed',
                item: {
                  id: 'cmd-1',
                  type: 'command_execution',
                  command: 'sleep 1',
                  aggregated_output: 'done',
                  exit_code: 0,
                },
              },
            };
          }
          if (nextCalls === 4) {
            return {
              done: false,
              value: {
                type: 'turn.completed',
                usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 },
              },
            };
          }
          return { done: true, value: undefined };
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
        prompt: 'run a long tool',
        sessionId: 'in-flight-tool-session',
      });

      const chunks = await expectStreamToFinishWithin(stream, 1000);
      const events = parseSSEChunks(chunks);
      const errorEvent = events.find(e => e.type === 'error');
      const resultEvent = events.find(e => e.type === 'result');

      assert.ok(!errorEvent, `Watchdog must not fire while a tool is in flight (got error: ${errorEvent?.data})`);
      assert.ok(resultEvent, 'Turn should complete normally');
    });
  });

  it('DOES trip the mid-stream watchdog when no tool is in flight and silence exceeds idle', async () => {
    await withEnv({
      CTI_CODEX_MID_STREAM_IDLE_MS: '30',
      CTI_CODEX_TERMINAL_IDLE_MS: '30',
    }, async () => {
      const { CodexProvider } = await import('../codex-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const provider = new CodexProvider(new PendingPermissions());

      let nextCalls = 0;
      let returnCalls = 0;
      const iterator: AsyncIterator<Record<string, unknown>> = {
        async next() {
          nextCalls += 1;
          if (nextCalls === 1) {
            return {
              done: false,
              value: { type: 'thread.started', thread_id: 'no-tool-thread' },
            };
          }
          if (nextCalls === 2) {
            // Emit a non-tool item (reasoning) so we are mid-stream but
            // nothing is in flight.
            return {
              done: false,
              value: {
                type: 'item.completed',
                item: { id: 'r1', type: 'reasoning', text: 'thinking' },
              },
            };
          }
          // Hang forever — the watchdog must fire because nothing is in flight.
          return await new Promise<IteratorResult<Record<string, unknown>>>(() => {});
        },
        async return() {
          returnCalls += 1;
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
        prompt: 'hang with no tool',
        sessionId: 'no-tool-in-flight-session',
      });

      // Watchdog should trip well within 500ms (idle is 30ms).
      const chunks = await expectStreamToFinishWithin(stream, 500);
      const events = parseSSEChunks(chunks);

      assert.equal(returnCalls, 1, 'Watchdog should have closed the iterator');
      // Stream closes cleanly; no error event is emitted on idle timeout
      // (the loop just breaks). Just confirm we exited and the iterator
      // was returned.
      assert.ok(chunks.length >= 0);
      void events;
    });
  });
});
