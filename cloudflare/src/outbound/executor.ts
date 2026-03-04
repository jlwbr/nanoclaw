import { Env, OutboundDeliveryMessage } from '../types';

export interface OutboundDeliverySuccess {
  ok: true;
  detail?: string;
  providerMessageId?: string;
}

export interface OutboundDeliveryFailure {
  ok: false;
  error: string;
  retryable: boolean;
}

export type OutboundDeliveryResult =
  | OutboundDeliverySuccess
  | OutboundDeliveryFailure;

function parseMode(env: Env): 'stub' | 'http' {
  return env.OUTBOUND_MODE === 'http' ? 'http' : 'stub';
}

async function executeStub(
  message: OutboundDeliveryMessage,
): Promise<OutboundDeliveryResult> {
  return {
    ok: true,
    detail: `Stub outbound send for ${message.channel}`,
    providerMessageId: `stub-${message.deliveryId}`,
  };
}

async function executeHttp(
  env: Env,
  message: OutboundDeliveryMessage,
): Promise<OutboundDeliveryResult> {
  if (!env.OUTBOUND_HTTP_URL) {
    return {
      ok: false,
      error: 'OUTBOUND_HTTP_URL is required when OUTBOUND_MODE=http',
      retryable: false,
    };
  }

  let response: Response;
  try {
    response = await fetch(env.OUTBOUND_HTTP_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deliveryId: message.deliveryId,
        tenantId: message.tenantId,
        runId: message.runId,
        channel: message.channel,
        chatJid: message.chatJid,
        text: message.text,
        enqueuedAt: message.enqueuedAt,
      }),
    });
  } catch (err) {
    return {
      ok: false,
      error: `Outbound HTTP request failed: ${err instanceof Error ? err.message : String(err)}`,
      retryable: true,
    };
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    if (!response.ok) {
      return {
        ok: false,
        error: `Outbound HTTP failed with status ${response.status}`,
        retryable: response.status >= 500,
      };
    }
  }

  if (!response.ok) {
    return {
      ok: false,
      error:
        typeof payload.error === 'string'
          ? payload.error
          : `Outbound HTTP failed with status ${response.status}`,
      retryable: response.status >= 500,
    };
  }

  if (payload.ok === false) {
    return {
      ok: false,
      error:
        typeof payload.error === 'string'
          ? payload.error
          : 'Outbound endpoint returned ok=false',
      retryable: payload.retryable === true,
    };
  }

  return {
    ok: true,
    detail: typeof payload.detail === 'string' ? payload.detail : undefined,
    providerMessageId:
      typeof payload.providerMessageId === 'string'
        ? payload.providerMessageId
        : undefined,
  };
}

export async function executeOutboundDelivery(
  env: Env,
  message: OutboundDeliveryMessage,
): Promise<OutboundDeliveryResult> {
  if (parseMode(env) === 'http') return executeHttp(env, message);
  return executeStub(message);
}
