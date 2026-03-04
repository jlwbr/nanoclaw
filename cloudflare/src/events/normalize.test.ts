import { describe, expect, it } from 'vitest';

import { normalizeInboundEvent } from './normalize';

describe('normalizeInboundEvent', () => {
  it('normalizes common payload fields', () => {
    const event = normalizeInboundEvent({
      tenantId: 'tenant-1',
      channel: 'slack',
      eventId: 'evt-1',
      payload: {
        chat_jid: 'chat-1',
        sender: 'user-1',
        sender_name: 'Alice',
        text: 'hello',
      },
      receivedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(event).toEqual({
      eventId: 'evt-1',
      tenantId: 'tenant-1',
      channel: 'slack',
      receivedAt: '2026-01-01T00:00:00.000Z',
      chatJid: 'chat-1',
      sender: 'user-1',
      senderName: 'Alice',
      content: 'hello',
      payload: {
        chat_jid: 'chat-1',
        sender: 'user-1',
        sender_name: 'Alice',
        text: 'hello',
      },
    });
  });

  it('falls back to nested chat id', () => {
    const event = normalizeInboundEvent({
      tenantId: 'tenant-1',
      channel: 'discord',
      eventId: 'evt-2',
      payload: {
        chat: { id: 'channel-1' },
        message: 'ping',
      },
    });

    expect(event.chatJid).toBe('channel-1');
    expect(event.content).toBe('ping');
  });
});
