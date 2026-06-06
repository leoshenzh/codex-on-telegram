/**
 * Channel Router — resolves IM addresses to CodePilot sessions.
 *
 * When a message arrives from an IM channel, the router finds or creates
 * the corresponding ChannelBinding (and underlying chat_session).
 */

import type { BridgeSession } from './host.js';
import type { ChannelAddress, ChannelBinding, ChannelType } from './types.js';
import { getBridgeContext } from './context.js';
import { findLocalCodexSession, listLocalCodexSessions } from './local-codex-sessions.js';

export interface BindableSessionInfo {
  sessionId: string;
  source: 'bridge' | 'local-codex';
  workingDirectory: string;
  active: boolean;
  updatedAt?: string;
}

function formatChannelLabel(channelType: string): string {
  if (channelType === 'telegram') return 'Telegram';
  if (!channelType) return 'Chat';
  return channelType.charAt(0).toUpperCase() + channelType.slice(1);
}

export function buildBridgeSessionTitle(address: ChannelAddress): string {
  const channelLabel = formatChannelLabel(address.channelType);
  const identity = (address.displayName || address.chatId || 'Chat').trim();
  const parts = [channelLabel, identity];

  if (address.topicId) {
    parts.push(`Topic ${address.topicId}`);
  }

  return parts.join(' · ');
}

function getLocalSessionMetadata(sessionId: string): BridgeSession | null {
  const localSession = findLocalCodexSession(sessionId);
  if (!localSession) return null;

  return {
    id: localSession.id,
    working_directory: localSession.workingDirectory,
    model: '',
    sdk_session_id: localSession.id,
    display_name: localSession.displayName || `Local Codex (${localSession.source})`,
    updated_at: localSession.updatedAt,
    source: 'local-codex',
  };
}

function isLocalBinding(binding: ChannelBinding): boolean {
  if (binding.sessionSource === 'local-codex') return true;
  return !binding.sessionSource
    && !!binding.sdkSessionId
    && binding.sdkSessionId === binding.codepilotSessionId;
}

export function getSessionMetadata(sessionId: string): BridgeSession | null {
  const { store } = getBridgeContext();
  const storedSession = store.getSession(sessionId);
  if (storedSession) return storedSession;
  return getLocalSessionMetadata(sessionId);
}

/**
 * Return an existing binding if it still points to a valid session.
 * Read-only callers should use this instead of resolve() to avoid
 * silently creating bridge state.
 */
export function getBinding(address: ChannelAddress): ChannelBinding | null {
  const { store } = getBridgeContext();
  const existing = store.getChannelBinding(address.channelType, address.chatId, address.topicId);
  if (!existing) return null;
  const session = store.getSession(existing.codepilotSessionId)
    || (isLocalBinding(existing)
      ? getLocalSessionMetadata(existing.codepilotSessionId)
      : null);
  return session ? existing : null;
}

/**
 * Resolve an inbound address to a ChannelBinding.
 * If no binding exists, auto-creates a new session and binding.
 */
export function resolve(address: ChannelAddress): ChannelBinding {
  return getBinding(address) || createBinding(address);
}

/**
 * Create a new binding with a fresh CodePilot session.
 */
export function createBinding(
  address: ChannelAddress,
  workingDirectory?: string,
): ChannelBinding {
  const { store } = getBridgeContext();
  const defaultCwd = workingDirectory
    || store.getSetting('bridge_default_work_dir')
    || process.env.HOME
    || '';
  const defaultModel = store.getSetting('bridge_default_model') || '';
  const defaultProviderId = store.getSetting('bridge_default_provider_id') || '';

  const session = store.createSession(
    buildBridgeSessionTitle(address),
    defaultModel,
    undefined,
    defaultCwd,
    'code',
  );

  if (defaultProviderId) {
    store.updateSessionProviderId(session.id, defaultProviderId);
  }

  return store.upsertChannelBinding({
    channelType: address.channelType,
    chatId: address.chatId,
    topicId: address.topicId,
    codepilotSessionId: session.id,
    sdkSessionId: '',
    workingDirectory: defaultCwd,
    model: defaultModel,
    mode: 'code',
    sessionSource: 'bridge',
  });
}

/**
 * Bind an IM chat to an existing bridge session or a live local Codex session.
 */
export function bindToSession(
  address: ChannelAddress,
  codepilotSessionId: string,
): ChannelBinding | null {
  const { store } = getBridgeContext();
  const session = getSessionMetadata(codepilotSessionId);
  if (!session) return null;
  const existing = store.getChannelBinding(address.channelType, address.chatId, address.topicId);
  const sameSessionBinding = existing?.codepilotSessionId === session.id ? existing : null;
  const workingDirectory = sameSessionBinding?.workingDirectory
    ? sameSessionBinding.workingDirectory
    : session.working_directory;
  const sdkSessionId = sameSessionBinding
    ? sameSessionBinding.sdkSessionId || session.sdk_session_id || ''
    : session.sdk_session_id || '';
  const model = sameSessionBinding
    ? sameSessionBinding.model || session.model
    : session.model;
  const mode = sameSessionBinding
    ? sameSessionBinding.mode
    : 'code';

  store.upsertSession({
    ...session,
    working_directory: workingDirectory,
    sdk_session_id: sdkSessionId,
    model,
  });

  return store.upsertChannelBinding({
    channelType: address.channelType,
    chatId: address.chatId,
    topicId: address.topicId,
    codepilotSessionId: session.id,
    sdkSessionId,
    workingDirectory,
    model,
    mode,
    sessionSource: session.source === 'local-codex' ? 'local-codex' : 'bridge',
  });
}

/**
 * Update properties of an existing binding.
 */
export function updateBinding(
  id: string,
  updates: Partial<Pick<ChannelBinding, 'sdkSessionId' | 'workingDirectory' | 'model' | 'mode' | 'active'>>,
): void {
  getBridgeContext().store.updateChannelBinding(id, updates);
}

/**
 * List all bindings, optionally filtered by channel type.
 */
export function listBindings(channelType?: ChannelType): ChannelBinding[] {
  return getBridgeContext().store.listChannelBindings(channelType);
}

/**
 * List bridge-managed sessions plus unimported local Codex sessions that can be bound.
 */
export function listBindableSessions(channelType?: ChannelType): BindableSessionInfo[] {
  const { store } = getBridgeContext();
  const bindings = store.listChannelBindings(channelType);
  const bridgeSessions = bindings.map(binding => {
    const session = store.getSession(binding.codepilotSessionId)
      || (isLocalBinding(binding)
        ? getLocalSessionMetadata(binding.codepilotSessionId)
        : null);
    return {
      sessionId: binding.codepilotSessionId,
      source: session?.source === 'local-codex' ? 'local-codex' as const : 'bridge' as const,
      workingDirectory: session?.working_directory || binding.workingDirectory,
      active: binding.active,
      updatedAt: session?.updated_at || binding.updatedAt,
    };
  });

  const knownSessionIds = new Set<string>();
  for (const binding of bindings) {
    knownSessionIds.add(binding.codepilotSessionId);
    if (binding.sdkSessionId) knownSessionIds.add(binding.sdkSessionId);
  }

  const localSessions = listLocalCodexSessions(12)
    .filter(session => !knownSessionIds.has(session.id))
    .map(session => ({
      sessionId: session.id,
      source: 'local-codex' as const,
      workingDirectory: session.workingDirectory,
      active: false,
      updatedAt: session.updatedAt,
    }));

  return [...bridgeSessions, ...localSessions].sort((a, b) => {
    const aTime = Date.parse(a.updatedAt || '') || 0;
    const bTime = Date.parse(b.updatedAt || '') || 0;
    return bTime - aTime;
  });
}
