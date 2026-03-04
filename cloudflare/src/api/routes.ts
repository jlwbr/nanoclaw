import { z } from 'zod';

import {
  CanonicalInboundEventSchema,
  EntitlementCheckSchema,
  parseContract,
} from '../contracts.js';
import { AppError, toErrorResponse } from '../errors.js';
import { WorkerEnv } from '../env.js';
import { createPlatform } from '../factory.js';
import { logError } from '../logging.js';
import { getMetricSnapshot, incrementCounter, recordTiming } from '../metrics.js';
import { verifyHmacSignature } from '../security.js';
import { APP_JS, renderAppHtml } from '../ui/app.js';
import { createId, jsonResponse, safeJsonParse, stableNowIso } from '../utils.js';

const CreateTaskSchema = z.object({
  prompt: z.string().min(1),
  scheduleType: z.enum(['cron', 'interval', 'once']),
  scheduleValue: z.string().min(1),
});

const BillingPortalSchema = z.object({
  returnUrl: z.string().url(),
});

function textResponse(text: string, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'text/html; charset=utf-8');
  return new Response(text, {
    ...init,
    headers,
  });
}

function jsResponse(script: string): Response {
  return new Response(script, {
    status: 200,
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=60',
    },
  });
}

function parseTenantRoute(pathname: string): {
  tenantId: string;
  resource: string[];
} | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 3 || parts[0] !== 'api' || parts[1] !== 'tenants') {
    return null;
  }
  const tenantId = decodeURIComponent(parts[2]);
  return {
    tenantId,
    resource: parts.slice(3),
  };
}

function buildCorrelation(request: Request, tenantId?: string): {
  requestId: string;
  tenantId?: string;
} {
  return {
    requestId:
      request.headers.get('cf-ray') ??
      request.headers.get('x-request-id') ??
      crypto.randomUUID(),
    tenantId,
  };
}

export async function handleApiRequest(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  const startedAt = Date.now();
  const platform = createPlatform(env);
  const url = new URL(request.url);
  const pathname = url.pathname;
  incrementCounter('api_requests_total', {
    method: request.method,
    path: pathname,
  });

  try {
    if (request.method === 'GET' && pathname === '/') {
      return textResponse(renderAppHtml());
    }
    if (request.method === 'GET' && pathname === '/app.js') {
      return jsResponse(APP_JS);
    }

    if (request.method === 'GET' && pathname === '/health') {
      const runtime = await platform.runtime.healthcheck();
      return jsonResponse({
        status: runtime.status === 'down' ? 'degraded' : 'ok',
        appVersion: platform.validatedEnv.APP_VERSION,
        runtime,
        billing: {
          provider: 'autumn',
        },
        metrics: getMetricSnapshot(),
      });
    }

    if (request.method === 'POST' && pathname === '/webhook/inbound') {
      const rawBody = await request.text();
      await verifyHmacSignature({
        headers: request.headers,
        body: rawBody,
        headerName: 'x-nanoclaw-signature',
        secret: platform.validatedEnv.INBOUND_WEBHOOK_SECRET,
        missingMessage: 'Missing inbound webhook signature',
        invalidMessage: 'Invalid inbound webhook signature',
      });
      const parsedBody = safeJsonParse<unknown>(rawBody);
      if (!parsedBody) {
        throw new AppError({
          code: 'INVALID_REQUEST',
          message: 'Inbound webhook body must be valid JSON',
          status: 400,
          retryable: false,
        });
      }
      const event = parseContract(
        CanonicalInboundEventSchema,
        parsedBody,
        'CanonicalInboundEvent',
      );
      const id = env.TENANT_ORCHESTRATOR.idFromName(event.tenantId);
      const stub = env.TENANT_ORCHESTRATOR.get(id);
      const response = await stub.fetch(
        'https://tenant-orchestrator/orchestrate/inbound',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify(event),
        },
      );
      const payload = await response.text();
      return new Response(payload, {
        status: response.status,
        headers: {
          'content-type': 'application/json; charset=utf-8',
        },
      });
    }

    if (request.method === 'POST' && pathname === '/webhook/billing/autumn') {
      const rawBody = await request.text();
      const event = await platform.billing.verifyAndParseWebhook(
        request.headers,
        rawBody,
      );
      await platform.billing.applyWebhookEvent(event);
      return jsonResponse({ accepted: true, id: event.id, type: event.type });
    }

    const tenantRoute = parseTenantRoute(pathname);
    if (!tenantRoute) {
      return jsonResponse(
        { error: { code: 'NOT_FOUND', message: `Route not found: ${pathname}` } },
        { status: 404 },
      );
    }
    const { tenantId, resource } = tenantRoute;
    await platform.orchestration.ensureTenantExists(tenantId);
    const correlation = buildCorrelation(request, tenantId);

    if (request.method === 'GET' && resource[0] === 'dashboard') {
      const tenant = await platform.repos.tenants.get(tenantId);
      const tasks = await platform.repos.tasks.listByTenant(tenantId, 100);
      const recentRuns = await platform.repos.runs.listByTenant(tenantId, 20);
      const activeTasks = tasks.filter((task) => task.status === 'active').length;
      const pausedTasks = tasks.filter((task) => task.status === 'paused').length;
      return jsonResponse({
        tenant,
        taskSummary: {
          total: tasks.length,
          active: activeTasks,
          paused: pausedTasks,
        },
        recentRuns,
      });
    }

    if (resource[0] === 'tasks' && request.method === 'GET' && resource.length === 1) {
      const tasks = await platform.repos.tasks.listByTenant(tenantId, 200);
      return jsonResponse({ tasks });
    }

    if (resource[0] === 'tasks' && request.method === 'POST' && resource.length === 1) {
      const body = await request.json();
      const parsed = parseContract(CreateTaskSchema, body, 'CreateTaskRequest');
      const taskId = createId('task');
      const now = stableNowIso();
      const nextRunAt =
        parsed.scheduleType === 'once' ? parsed.scheduleValue : now;
      await platform.repos.tasks.create({
        taskId,
        tenantId,
        prompt: parsed.prompt,
        scheduleType: parsed.scheduleType,
        scheduleValue: parsed.scheduleValue,
        nextRunAt,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      await platform.orchestration.enqueueDueTasks(tenantId, new Date().toISOString());
      const tasks = await platform.repos.tasks.listByTenant(tenantId, 200);
      return jsonResponse({ createdTaskId: taskId, tasks }, { status: 201 });
    }

    if (
      resource[0] === 'tasks' &&
      resource.length === 3 &&
      request.method === 'POST'
    ) {
      const taskId = resource[1];
      const action = resource[2];
      const task = await platform.repos.tasks.get(taskId);
      if (!task || task.tenantId !== tenantId) {
        throw new AppError({
          code: 'NOT_FOUND',
          message: `Task not found: ${taskId}`,
          status: 404,
          retryable: false,
        });
      }

      if (action === 'pause') {
        await platform.repos.tasks.updateStatus(taskId, 'paused');
      } else if (action === 'resume') {
        await platform.repos.tasks.updateStatus(taskId, 'active');
        await platform.orchestration.enqueueDueTasks(
          tenantId,
          new Date().toISOString(),
        );
      } else if (action === 'cancel') {
        await platform.repos.tasks.updateStatus(taskId, 'cancelled');
      } else if (action === 'run_now') {
        const runId = await platform.orchestration.enqueueTaskRun(task);
        return jsonResponse({ runId });
      } else {
        throw new AppError({
          code: 'INVALID_REQUEST',
          message: `Unsupported task action: ${action}`,
          status: 400,
          retryable: false,
        });
      }
      const updated = await platform.repos.tasks.get(taskId);
      return jsonResponse({ task: updated });
    }

    if (resource[0] === 'reconcile' && resource.length === 1 && request.method === 'POST') {
      const id = env.TENANT_ORCHESTRATOR.idFromName(tenantId);
      const stub = env.TENANT_ORCHESTRATOR.get(id);
      const response = await stub.fetch(
        'https://tenant-orchestrator/orchestrate/reconcile',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tenantId }),
        },
      );
      const body = await response.text();
      return new Response(body, {
        status: response.status,
        headers: {
          'content-type': 'application/json; charset=utf-8',
        },
      });
    }

    if (resource[0] === 'usage' && request.method === 'GET') {
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const usage = await platform.repos.usage.sumByTenant(
        tenantId,
        monthStart.toISOString(),
      );
      return jsonResponse({
        tenantId,
        usageWindowStart: monthStart.toISOString(),
        usageWindowEnd: stableNowIso(),
        usage,
      });
    }

    if (resource[0] === 'outbound' && request.method === 'GET' && resource.length === 1) {
      const status = url.searchParams.get('status') ?? 'all';
      if (!['pending', 'delivered', 'retrying', 'dead_letter', 'all'].includes(status)) {
        throw new AppError({
          code: 'INVALID_REQUEST',
          message: `Invalid outbound status: ${status}`,
          status: 400,
          retryable: false,
        });
      }
      const deliveries = await platform.repos.outbound.listByTenant(
        tenantId,
        status as 'pending' | 'delivered' | 'retrying' | 'dead_letter' | 'all',
        200,
      );
      return jsonResponse({ deliveries });
    }

    if (
      resource[0] === 'outbound' &&
      resource.length === 3 &&
      resource[2] === 'redrive' &&
      request.method === 'POST'
    ) {
      const deliveryId = resource[1];
      const delivery = await platform.repos.outbound.get(deliveryId);
      if (!delivery || delivery.tenantId !== tenantId) {
        throw new AppError({
          code: 'NOT_FOUND',
          message: `Delivery not found: ${deliveryId}`,
          status: 404,
          retryable: false,
        });
      }
      const payload = JSON.parse(delivery.payloadJson) as { text: string };
      await env.OUTBOUND_DELIVERY_QUEUE.send({
        kind: 'outbound_delivery',
        payload: {
          deliveryId: delivery.deliveryId,
          tenantId: delivery.tenantId,
          runId: delivery.runId,
          channel: delivery.channel,
          target: delivery.target,
          payload: {
            text: payload.text,
            metadata: {},
          },
          attempt: delivery.attemptCount + 1,
          correlation: {
            requestId: correlation.requestId,
            tenantId,
            runId: delivery.runId,
            deliveryId: delivery.deliveryId,
          },
        },
      });
      await platform.repos.outbound.updateState(deliveryId, {
        status: 'pending',
        updatedAt: stableNowIso(),
      });
      return jsonResponse({ redriven: true, deliveryId });
    }

    if (
      resource[0] === 'billing' &&
      resource[1] === 'summary' &&
      resource.length === 2 &&
      request.method === 'GET'
    ) {
      const summary = await platform.billing.getSummary(tenantId);
      return jsonResponse(summary);
    }

    if (
      resource[0] === 'billing' &&
      resource[1] === 'entitlements' &&
      request.method === 'GET'
    ) {
      const feature = url.searchParams.get('feature');
      if (!feature) {
        throw new AppError({
          code: 'INVALID_REQUEST',
          message: 'feature query param is required',
          status: 400,
          retryable: false,
        });
      }
      const decision = await platform.billing.checkEntitlement(
        parseContract(
          EntitlementCheckSchema,
          {
            tenantId,
            feature,
            quantity: Number(url.searchParams.get('quantity') ?? '1'),
            correlation: {
              requestId: correlation.requestId,
              tenantId,
            },
          },
          'EntitlementCheck',
        ),
      );
      return jsonResponse(decision);
    }

    if (
      resource[0] === 'billing' &&
      resource[1] === 'portal-session' &&
      resource.length === 2 &&
      request.method === 'POST'
    ) {
      const body = await request.json();
      const parsed = parseContract(
        BillingPortalSchema,
        body,
        'BillingPortalSessionRequest',
      );
      const session = await platform.billing.createPortalSession(
        tenantId,
        parsed.returnUrl,
      );
      return jsonResponse(session);
    }

    return jsonResponse(
      {
        error: {
          code: 'NOT_FOUND',
          message: `Route not found: ${pathname}`,
        },
      },
      { status: 404 },
    );
  } catch (error) {
    logError('api.request.error', 'Worker request failed', error, {
      requestId:
        request.headers.get('cf-ray') ??
        request.headers.get('x-request-id') ??
        'unknown',
    });
    const mapped = toErrorResponse(error);
    incrementCounter('api_errors_total', {
      method: request.method,
      path: pathname,
      status: mapped.status,
    });
    return jsonResponse(mapped.body, { status: mapped.status });
  } finally {
    recordTiming('api_request_ms', Date.now() - startedAt, {
      method: request.method,
      path: pathname,
    });
  }
}
