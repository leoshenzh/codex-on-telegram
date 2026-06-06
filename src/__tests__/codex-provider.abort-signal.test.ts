import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { expectStreamToFinishWithin } from './_codex-provider-test-helpers.js';

describe('CodexProvider forwards the AbortSignal to runStreamed', () => {
  it('passes { signal } from params.abortController to thread.runStreamed so SDK can kill the subprocess', async () => {
    const { CodexProvider } = await import('../codex-provider.js');
    const { PendingPermissions } = await import('../permission-gateway.js');
    const provider = new CodexProvider(new PendingPermissions());

    // Iterator emits a clean thread.started + turn.completed so streamChat
    // finishes immediately without firing any watchdog. We only care that
    // the SDK received the AbortSignal on the very first runStreamed call.
    const iterator: AsyncIterator<Record<string, unknown>> = {
      async next() {
        return { done: true, value: undefined };
      },
      async return() {
        return { done: true, value: undefined };
      },
    };

    let capturedTurnOptions: unknown = undefined;
    const mockThread = {
      runStreamed: (_input: unknown, turnOptions?: unknown) => {
        capturedTurnOptions = turnOptions;
        return {
          events: {
            [Symbol.asyncIterator]() {
              return iterator;
            },
          },
        };
      },
    };

    (provider as any).sdk = { Codex: class { constructor() {} } };
    (provider as any).codex = {
      startThread: () => mockThread,
    };

    const abortController = new AbortController();
    const stream = provider.streamChat({
      prompt: 'check that signal is forwarded',
      sessionId: 'abort-signal-session',
      abortController,
    });

    await expectStreamToFinishWithin(stream, 1000);

    assert.ok(capturedTurnOptions, 'runStreamed must be invoked with a turnOptions argument');
    const opts = capturedTurnOptions as { signal?: unknown };
    assert.ok(opts.signal, 'turnOptions.signal must be present so SDK can wire it to spawn({signal})');
    assert.strictEqual(
      opts.signal,
      abortController.signal,
      'turnOptions.signal must be the same AbortSignal instance from params.abortController',
    );
  });
});
