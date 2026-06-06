import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSSEChunks, withEnv, expectStreamToFinishWithin } from './_codex-provider-test-helpers.js';

describe('CodexProvider retries on mid-stream timeout before final answer', () => {
  it('opens a fresh thread when mid-stream timeout fires before any final answer is committed', async () => {
    await withEnv({
      CTI_CODEX_MID_STREAM_IDLE_MS: '30',
      CTI_CODEX_TERMINAL_IDLE_MS: '30',
    }, async () => {
      const { CodexProvider } = await import('../codex-provider.js');
      const { PendingPermissions } = await import('../permission-gateway.js');
      const provider = new CodexProvider(new PendingPermissions());

      // First attempt: emits thread.started, then hangs forever — watchdog
      // trips, error is surfaced as 'mid_stream_timeout'. Since no final
      // answer was ever committed, the provider MUST retry with a fresh
      // thread (the retriable error whitelist now includes timeouts).
      //
      // Second attempt: emits a clean final answer and turn.completed.
      let attempts = 0;
      const iteratorFactory = (): AsyncIterator<Record<string, unknown>> => {
        attempts += 1;
        const attemptNum = attempts;
        let calls = 0;
        return {
          async next() {
            calls += 1;
            if (attemptNum === 1) {
              if (calls === 1) {
                return {
                  done: false,
                  value: { type: 'thread.started', thread_id: 'first-attempt-thread' },
                };
              }
              // Hang forever; watchdog fires the mid-stream timeout.
              return await new Promise<IteratorResult<Record<string, unknown>>>(() => {});
            }
            // Second attempt: clean turn that delivers a final answer.
            if (calls === 1) {
              return {
                done: false,
                value: { type: 'thread.started', thread_id: 'second-attempt-thread' },
              };
            }
            if (calls === 2) {
              return {
                done: false,
                value: {
                  type: 'event_msg',
                  payload: {
                    type: 'agent_message',
                    phase: 'final_answer',
                    message: 'recovered after timeout',
                  },
                },
              };
            }
            if (calls === 3) {
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
      };

      let runStreamedCalls = 0;
      const mockThread = {
        runStreamed: () => {
          runStreamedCalls += 1;
          const iterator = iteratorFactory();
          return {
            events: {
              [Symbol.asyncIterator]() {
                return iterator;
              },
            },
          };
        },
      };

      let resumeCalls = 0;
      let startCalls = 0;
      (provider as any).sdk = { Codex: class { constructor() {} } };
      (provider as any).codex = {
        resumeThread: () => {
          resumeCalls += 1;
          return mockThread;
        },
        startThread: () => {
          startCalls += 1;
          return mockThread;
        },
      };

      const stream = provider.streamChat({
        prompt: 'first hang, then recover',
        sessionId: 'retry-on-timeout-session',
        sdkSessionId: 'persisted-thread-id', // forces a resume on the first attempt
      });

      const chunks = await expectStreamToFinishWithin(stream, 2000);
      const events = parseSSEChunks(chunks);

      // The iterator factory (runStreamed) must have been invoked twice —
      // once for the doomed resume attempt, once for the fresh-thread retry.
      assert.equal(runStreamedCalls, 2, 'runStreamed must be invoked twice (resume + fresh retry)');
      assert.equal(resumeCalls, 1, 'First attempt must use resumeThread for the persisted id');
      assert.equal(startCalls, 1, 'Retry must use startThread for the fresh attempt');

      // Final answer text must be present in the stream (delivered by the
      // second attempt, not the first).
      const textEvents = events.filter(e => e.type === 'text');
      const textData = textEvents.map(e => e.data);
      assert.ok(
        textData.some(t => t.includes('recovered after timeout')),
        `Stream must include the recovered text. Got: ${JSON.stringify(textData)}`,
      );

      // The final turn.completed result event must be present.
      const resultEvent = events.find(e => e.type === 'result');
      assert.ok(resultEvent, 'Stream must complete with a result event from the fresh thread');
    });
  });
});
