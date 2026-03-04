import { describe, expect, it } from 'vitest';

import { verifyInboundSignature } from './validate';

async function hmacSha256Hex(key: string, payload: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    new TextEncoder().encode(payload),
  );
  const bytes = new Uint8Array(signature);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

describe('verifyInboundSignature', () => {
  it('verifies shared signature', async () => {
    const body = '{"hello":"world"}';
    const secret = 'test-secret';
    const signature = await hmacSha256Hex(secret, body);
    const request = new Request('https://example.com/webhooks/test', {
      method: 'POST',
      headers: {
        'x-webhook-signature': signature,
      },
      body,
    });

    const ok = await verifyInboundSignature({
      request,
      env: {
        WEBHOOK_SHARED_SECRET: secret,
      } as never,
      channel: 'test',
      rawBody: body,
    });
    expect(ok).toBe(true);
  });

  it('verifies slack signature with replay window', async () => {
    const body = 'token=abc';
    const signingSecret = 'slack-secret';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const base = `v0:${timestamp}:${body}`;
    const signature = `v0=${await hmacSha256Hex(signingSecret, base)}`;

    const request = new Request('https://example.com/webhooks/slack', {
      method: 'POST',
      headers: {
        'x-slack-request-timestamp': timestamp,
        'x-slack-signature': signature,
      },
      body,
    });

    const ok = await verifyInboundSignature({
      request,
      env: {
        SLACK_SIGNING_SECRET: signingSecret,
      } as never,
      channel: 'slack',
      rawBody: body,
    });
    expect(ok).toBe(true);
  });
});
