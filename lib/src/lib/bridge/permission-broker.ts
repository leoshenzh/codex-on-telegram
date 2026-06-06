/**
 * Permission Broker — forwards permission requests to the IM channel as plain text
 * and resolves user replies back through the host permission gateway.
 */

import type { ChannelAddress } from './types.js';
import type { BaseChannelAdapter } from './channel-adapter.js';
import { deliver } from './delivery-layer.js';
import { getBridgeContext } from './context.js';
import { getAddressRouteId } from './addressing.js';

const recentPermissionForwards = new Map<string, number>();
const RECENT_FORWARD_WINDOW_MS = 30_000;
const SENSITIVE_KEY_RE = /(token|secret|password|api[_-]?key|auth|authorization|cookie|session|credential|bearer)/i;
const SENSITIVE_VALUE_RE = /(bearer\s+\S+|bot\d+:[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{10,}|api[_-]?key|secret|token)/i;
const MAX_PERMISSION_FIELDS = 8;
const MAX_STRING_PREVIEW = 120;

function cleanupRecentForwards(now: number): void {
  for (const [id, timestamp] of recentPermissionForwards.entries()) {
    if (now - timestamp > RECENT_FORWARD_WINDOW_MS) {
      recentPermissionForwards.delete(id);
    }
  }
}

function sanitizeString(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return '(empty)';
  if (SENSITIVE_VALUE_RE.test(compact)) return '[redacted]';
  if (compact.length <= MAX_STRING_PREVIEW) return compact;
  return `${compact.slice(0, MAX_STRING_PREVIEW)}...`;
}

function summarizeValue(key: string, value: unknown): string {
  if (SENSITIVE_KEY_RE.test(key)) {
    return '[redacted]';
  }
  if (typeof value === 'string') {
    return sanitizeString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[array:${value.length}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    const preview = keys.slice(0, 3).join(', ');
    return keys.length > 0
      ? `{object:${preview}${keys.length > 3 ? ', ...' : ''}}`
      : '{object:empty}';
  }
  if (value === undefined) {
    return '(undefined)';
  }
  return String(value);
}

function summarizeToolInput(toolInput: Record<string, unknown>): string {
  const entries = Object.entries(toolInput);
  if (entries.length === 0) {
    return 'Input summary: (none)';
  }

  const lines = ['Input summary:'];
  for (const [key, value] of entries.slice(0, MAX_PERMISSION_FIELDS)) {
    lines.push(`- ${key}: ${summarizeValue(key, value)}`);
  }
  if (entries.length > MAX_PERMISSION_FIELDS) {
    lines.push(`- ... ${entries.length - MAX_PERMISSION_FIELDS} more fields`);
  }
  return lines.join('\n');
}

export async function forwardPermissionRequest(
  adapter: BaseChannelAdapter,
  address: ChannelAddress,
  permissionRequestId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId?: string,
  suggestions?: unknown[],
  replyToMessageId?: string,
): Promise<boolean> {
  const { store, permissions } = getBridgeContext();
  const now = Date.now();
  cleanupRecentForwards(now);

  if (recentPermissionForwards.has(permissionRequestId)) {
    return true;
  }
  recentPermissionForwards.set(permissionRequestId, now);

  const text = [
    'Permission required',
    '',
    `Tool: ${toolName}`,
    summarizeToolInput(toolInput),
    '',
    'Reply with one of these commands:',
    `/perm allow ${permissionRequestId}`,
    `/perm allow_session ${permissionRequestId}`,
    `/perm deny ${permissionRequestId}`,
    '',
    'Shortcut:',
    '1 = allow once',
    '2 = allow for session',
    '3 = deny',
  ].join('\n');

  const result = await deliver(adapter, {
    address,
    text,
    parseMode: 'plain',
    replyToMessageId,
  }, {
    sessionId,
  });

  if (!result.ok || !result.messageId) {
    recentPermissionForwards.delete(permissionRequestId);
    permissions.resolvePendingPermission(permissionRequestId, {
      behavior: 'deny',
      message: 'Permission prompt could not be delivered.',
    });
    return false;
  }

  try {
    store.insertPermissionLink({
      permissionRequestId,
      channelType: adapter.channelType,
      chatId: getAddressRouteId(address),
      messageId: result.messageId,
      toolName,
      suggestions: suggestions ? JSON.stringify(suggestions) : '',
    });
  } catch {
    // best effort
  }

  return true;
}

export interface PermissionCallbackResult {
  handled: boolean;
  callbackText: string;
}

export function handlePermissionCallback(
  callbackData: string,
  callbackChatId: string,
  callbackMessageId?: string,
): PermissionCallbackResult {
  const { store, permissions } = getBridgeContext();
  const parts = callbackData.split(':');
  if (parts.length < 3 || parts[0] !== 'perm') {
    return { handled: false, callbackText: 'Invalid permission request.' };
  }

  const action = parts[1];
  const permissionRequestId = parts.slice(2).join(':');
  const link = store.getPermissionLink(permissionRequestId);
  if (!link) {
    return { handled: false, callbackText: 'Permission no longer active.' };
  }

  if (link.chatId !== callbackChatId) {
    return { handled: false, callbackText: 'Permission not valid for this chat.' };
  }

  if (callbackMessageId && link.messageId !== callbackMessageId) {
    return { handled: false, callbackText: 'Permission no longer active.' };
  }

  if (link.resolved) {
    return { handled: false, callbackText: 'Permission already handled.' };
  }

  let resolution: import('./host.js').PermissionResolution;
  let callbackText: string;

  switch (action) {
    case 'allow':
      resolution = { behavior: 'allow' };
      callbackText = 'Allowed once.';
      break;
    case 'allow_session': {
      let updatedPermissions: unknown[] | undefined;
      if (link.suggestions) {
        try {
          const parsed = JSON.parse(link.suggestions) as unknown;
          if (Array.isArray(parsed)) {
            updatedPermissions = parsed;
          }
        } catch {
          updatedPermissions = undefined;
        }
      }
      resolution = { behavior: 'allow', updatedPermissions };
      callbackText = 'Allowed for this session.';
      break;
    }
    case 'deny':
      resolution = { behavior: 'deny', message: 'Denied via IM bridge' };
      callbackText = 'Denied.';
      break;
    default:
      return { handled: false, callbackText: 'Invalid permission action.' };
  }

  const resolved = permissions.resolvePendingPermission(permissionRequestId, resolution);
  if (!resolved) {
    return { handled: false, callbackText: 'Permission expired or no longer active.' };
  }

  const marked = store.markPermissionLinkResolved(permissionRequestId);
  if (!marked) {
    return { handled: false, callbackText: 'Permission already handled.' };
  }

  return { handled: true, callbackText };
}
