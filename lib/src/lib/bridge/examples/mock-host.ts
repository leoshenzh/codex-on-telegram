/**
 * Minimal mock host example for the thin bridge core.
 */

import { initBridgeContext } from '../context.js';
import * as router from '../channel-router.js';
import * as engine from '../conversation-engine.js';
import type {
  BridgeStore,
  LLMProvider,
  BridgeSession,
  BridgeMessage,
  StreamChatParams,
} from '../host.js';
import type { ChannelBinding, ChannelType } from '../types.js';

class InMemoryStore implements BridgeStore {
  private settings = new Map<string, string>();
  private sessions = new Map<string, BridgeSession>();
  private bindings = new Map<string, ChannelBinding>();
  private messages = new Map<string, BridgeMessage[]>();
  private nextId = 1;

  getSetting(key: string) { return this.settings.get(key) ?? null; }
  getChannelBinding(channelType: string, chatId: string) { return this.bindings.get(`${channelType}:${chatId}`) ?? null; }
  listSessions(_opts?: { limit?: number }) { return Array.from(this.sessions.values()); }
  upsertSession(session: any) { this.sessions.set(session.id, session); return session; }

  upsertChannelBinding(data: { channelType: string; chatId: string; codepilotSessionId: string; sdkSessionId?: string; workingDirectory: string; model: string; mode?: string }) {
    const key = `${data.channelType}:${data.chatId}`;
    const existing = this.bindings.get(key);
    const binding: ChannelBinding = {
      id: existing?.id || `binding-${this.nextId++}`,
      channelType: data.channelType,
      chatId: data.chatId,
      codepilotSessionId: data.codepilotSessionId,
      sdkSessionId: data.sdkSessionId ?? existing?.sdkSessionId ?? '',
      workingDirectory: data.workingDirectory,
      model: data.model,
      mode: (data.mode as ChannelBinding['mode']) ?? existing?.mode ?? 'code',
      active: true,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.bindings.set(key, binding);
    return binding;
  }

  updateChannelBinding(id: string, updates: Partial<ChannelBinding>) {
    for (const [key, binding] of this.bindings.entries()) {
      if (binding.id === id) {
        this.bindings.set(key, { ...binding, ...updates });
        break;
      }
    }
  }

  listChannelBindings(_channelType?: ChannelType) { return Array.from(this.bindings.values()); }
  getSession(id: string) { return this.sessions.get(id) ?? null; }
  createSession(name: string, model: string, _sp?: string, cwd?: string) {
    const session: BridgeSession = { id: `session-${this.nextId++}`, working_directory: cwd || '/tmp', model, display_name: name };
    this.sessions.set(session.id, session);
    return session;
  }
  updateSessionProviderId() {}
  addMessage(sessionId: string, role: string, content: string) {
    const messages = this.messages.get(sessionId) || [];
    messages.push({ role, content });
    this.messages.set(sessionId, messages);
  }
  getMessages(sessionId: string) { return { messages: this.messages.get(sessionId) || [] }; }
  acquireSessionLock() { return true; }
  renewSessionLock() {}
  releaseSessionLock() {}
  setSessionRuntimeStatus() {}
  updateSdkSessionId() {}
  updateSessionModel() {}
  syncSdkTasks() {}
  getProvider() { return undefined; }
  getDefaultProviderId() { return null; }
  insertAuditLog() {}
  checkDedup() { return false; }
  insertDedup() {}
  cleanupExpiredDedup() {}
  insertOutboundRef() {}
  insertPermissionLink() {}
  getPermissionLink() { return null; }
  markPermissionLinkResolved() { return false; }
  listPendingPermissionLinksByChat() { return []; }
  getChannelOffset() { return '0'; }
  setChannelOffset() {}
}

class EchoLLM implements LLMProvider {
  streamChat(params: StreamChatParams): ReadableStream<string> {
    const response = `Echo: ${params.prompt}`;
    return new ReadableStream({
      start(controller) {
        controller.enqueue(`data: ${JSON.stringify({ type: 'text', data: response })}\n`);
        controller.enqueue(`data: ${JSON.stringify({ type: 'result', data: JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 } }) })}\n`);
        controller.close();
      },
    });
  }
}

async function main() {
  initBridgeContext({
    store: new InMemoryStore(),
    llm: new EchoLLM(),
    permissions: { resolvePendingPermission: () => true },
    lifecycle: {},
  });

  const address = { channelType: 'telegram', chatId: 'tg-user-1', displayName: 'Test User' };
  const binding = router.resolve(address);
  const result = await engine.processMessage(binding, 'Hello, Claude!');

  console.log('Session:', binding.codepilotSessionId);
  console.log('Response:', result.responseText);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
