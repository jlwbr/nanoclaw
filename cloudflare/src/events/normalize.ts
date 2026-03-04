import { CanonicalInboundEvent } from '../types';

function normalizeChatJid(payload: Record<string, unknown>): string {
  const direct =
    (typeof payload.chat_jid === 'string' && payload.chat_jid) ||
    (typeof payload.chatJid === 'string' && payload.chatJid);
  if (direct) return direct;

  const nestedChat = payload.chat;
  if (nestedChat && typeof nestedChat === 'object') {
    const raw = nestedChat as Record<string, unknown>;
    const candidate =
      (typeof raw.id === 'string' && raw.id) ||
      (typeof raw.jid === 'string' && raw.jid);
    if (candidate) return candidate;
  }

  return 'unknown';
}

export function normalizeInboundEvent(args: {
  tenantId: string;
  channel: string;
  eventId: string;
  payload: Record<string, unknown>;
  receivedAt?: string;
}): CanonicalInboundEvent {
  const payload = args.payload;
  const sender =
    (typeof payload.sender === 'string' && payload.sender) ||
    (typeof payload.from === 'string' && payload.from) ||
    undefined;

  const senderName =
    (typeof payload.sender_name === 'string' && payload.sender_name) ||
    (typeof payload.senderName === 'string' && payload.senderName) ||
    (typeof payload.username === 'string' && payload.username) ||
    undefined;

  const content =
    (typeof payload.content === 'string' && payload.content) ||
    (typeof payload.text === 'string' && payload.text) ||
    (typeof payload.message === 'string' && payload.message) ||
    undefined;

  return {
    eventId: args.eventId,
    tenantId: args.tenantId,
    channel: args.channel,
    receivedAt: args.receivedAt ?? new Date().toISOString(),
    chatJid: normalizeChatJid(payload),
    sender,
    senderName,
    content,
    payload,
  };
}
