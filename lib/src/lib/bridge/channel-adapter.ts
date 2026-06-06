/**
 * Abstract base class for bridge channel adapters.
 *
 * A consuming host repo can extend this class to provide platform-specific
 * message consumption and delivery while keeping the shared bridge logic here.
 */

import type {
  ChannelType,
  InboundMessage,
  OutboundFileMessage,
  OutboundMessage,
  PreviewCapabilities,
  SendResult,
  StreamContext,
} from './types.js';

export abstract class BaseChannelAdapter {
  abstract readonly channelType: ChannelType;

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;
  abstract isRunning(): boolean;
  abstract consumeOne(): Promise<InboundMessage | null>;
  abstract send(message: OutboundMessage): Promise<SendResult>;

  async sendFile(_message: OutboundFileMessage): Promise<SendResult> {
    return { ok: false, error: 'File delivery is not supported by this adapter' };
  }

  async preflight(): Promise<void> {
    // Optional: adapters can verify connectivity/auth before entering running state.
  }

  async answerCallback(_callbackQueryId: string, _text?: string): Promise<void> {
    // Optional for adapters that support callback-style replies.
  }

  abstract validateConfig(): string | null;
  abstract isAuthorized(userId: string, chatId: string): boolean;

  onMessageStart?(_context: StreamContext): void;
  onMessageEnd?(_context: StreamContext): void;
  acknowledgeUpdate?(_updateId: number): void;
  getPreviewCapabilities?(_chatId: string): PreviewCapabilities | null;
  sendPreview?(_chatId: string, _text: string, _draftId: number): Promise<'sent' | 'skip' | 'degrade'>;
  endPreview?(_chatId: string, _draftId: number): void;
  onStreamText?(_context: StreamContext, _fullText: string): void;
  onToolEvent?(_context: StreamContext, _tools: import('./types.js').ToolCallInfo[]): void;
  onStreamHeartbeat?(_context: StreamContext, _statusText: string): void;
  onStreamEnd?(_context: StreamContext, _status: 'completed' | 'interrupted' | 'error', _responseText: string): Promise<boolean>;
}

const adapterFactories = new Map<string, () => BaseChannelAdapter>();

export function registerAdapterFactory(channelType: string, factory: () => BaseChannelAdapter): void {
  adapterFactories.set(channelType, factory);
}

export function createAdapter(channelType: string): BaseChannelAdapter | null {
  const factory = adapterFactories.get(channelType);
  return factory ? factory() : null;
}

export function getRegisteredTypes(): string[] {
  return Array.from(adapterFactories.keys());
}
