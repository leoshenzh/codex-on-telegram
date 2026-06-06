import type { ChannelAddress } from './types.js';

export function getAddressRouteId(address: Pick<ChannelAddress, 'chatId' | 'topicId'>): string {
  if (address.topicId && address.topicId.trim()) {
    return `${address.chatId}:topic:${address.topicId.trim()}`;
  }
  return address.chatId;
}
