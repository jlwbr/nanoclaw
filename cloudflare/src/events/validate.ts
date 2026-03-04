import { Env } from '../types';

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

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function verifySharedSecret(
  request: Request,
  env: Env,
  rawBody: string,
): Promise<boolean> {
  if (!env.WEBHOOK_SHARED_SECRET) return true;
  const signature = request.headers.get('x-webhook-signature');
  if (!signature) return false;
  const timestamp = request.headers.get('x-webhook-timestamp');
  if (timestamp) {
    const ts = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(ts)) return false;
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > 300) return false;
    const expected = await hmacSha256Hex(
      env.WEBHOOK_SHARED_SECRET,
      `${timestamp}.${rawBody}`,
    );
    return timingSafeEqual(signature, expected);
  }
  const expected = await hmacSha256Hex(env.WEBHOOK_SHARED_SECRET, rawBody);
  return timingSafeEqual(signature, expected);
}

async function verifySlackSignature(
  request: Request,
  signingSecret: string,
  rawBody: string,
): Promise<boolean> {
  const timestamp = request.headers.get('x-slack-request-timestamp');
  const signature = request.headers.get('x-slack-signature');
  if (!timestamp || !signature) return false;

  const timestampSeconds = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampSeconds)) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > 300) {
    return false;
  }

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${await hmacSha256Hex(signingSecret, base)}`;
  return timingSafeEqual(signature, expected);
}

export async function verifyInboundSignature(args: {
  request: Request;
  env: Env;
  channel: string;
  rawBody: string;
}): Promise<boolean> {
  const channel = args.channel.toLowerCase();
  if (channel === 'slack' && args.env.SLACK_SIGNING_SECRET) {
    return verifySlackSignature(
      args.request,
      args.env.SLACK_SIGNING_SECRET,
      args.rawBody,
    );
  }
  if (channel === 'telegram' && args.env.TELEGRAM_WEBHOOK_SECRET) {
    const token = args.request.headers.get('x-telegram-bot-api-secret-token');
    return token === args.env.TELEGRAM_WEBHOOK_SECRET;
  }
  if (channel === 'discord' && args.env.DISCORD_WEBHOOK_SECRET) {
    const token = args.request.headers.get('x-discord-webhook-secret');
    return token === args.env.DISCORD_WEBHOOK_SECRET;
  }
  return verifySharedSecret(args.request, args.env, args.rawBody);
}
