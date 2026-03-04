import {
  BillingCustomer,
  BillingCustomerSchema,
  BillingSummary,
  EntitlementCheck,
  EntitlementDecision,
  EntitlementDecisionSchema,
  SubscriptionStatus,
  SubscriptionStatusSchema,
  UsageReportRequest,
  UsageReportResult,
  UsageReportResultSchema,
  parseContract,
} from '../contracts.js';
import { AppError } from '../errors.js';
import { WorkerEnv } from '../env.js';
import { log } from '../logging.js';
import { BillingPort, BillingWebhookEvent } from '../ports/billing.js';
import { PlatformRepositories } from '../ports/database.js';
import { hmacSha256Hex, stableNowIso } from '../utils.js';

interface AutumnConfig {
  apiKey: string;
  baseUrl: string;
  webhookSecret: string;
  productId: string;
}

interface AutumnApiError {
  status: number;
  message: string;
  retryable: boolean;
}

export class AutumnBillingAdapter implements BillingPort {
  constructor(
    private readonly config: AutumnConfig,
    private readonly repos: PlatformRepositories,
  ) {}

  async ensureCustomer(
    tenantId: string,
    input: { email?: string; externalRef: string },
  ): Promise<BillingCustomer> {
    const tenant = await this.repos.tenants.get(tenantId);
    if (tenant?.autumnCustomerId) {
      return parseContract(
        BillingCustomerSchema,
        {
          tenantId,
          providerCustomerId: tenant.autumnCustomerId,
          email: input.email,
          externalRef: input.externalRef,
        },
        'BillingCustomer',
      );
    }

    const payload = {
      external_id: input.externalRef,
      email: input.email,
      metadata: {
        tenant_id: tenantId,
      },
    };
    const response = await this.request<{
      id: string;
      email?: string;
      external_id: string;
    }>('/customers', {
      method: 'POST',
      body: payload,
    });

    await this.repos.tenants.updateBillingReferences(tenantId, {
      autumnCustomerId: response.id,
    });

    return parseContract(
      BillingCustomerSchema,
      {
        tenantId,
        providerCustomerId: response.id,
        email: response.email,
        externalRef: response.external_id,
      },
      'BillingCustomer',
    );
  }

  async fetchSubscriptionStatus(tenantId: string): Promise<SubscriptionStatus> {
    const tenant = await this.repos.tenants.get(tenantId);
    if (!tenant?.autumnCustomerId) {
      return parseContract(
        SubscriptionStatusSchema,
        {
          tenantId,
          providerCustomerId: 'none',
          status: 'none',
          updatedAt: stableNowIso(),
        },
        'SubscriptionStatus',
      );
    }

    const response = await this.request<{
      subscription_id?: string;
      status: SubscriptionStatus['status'];
      plan_id?: string;
      current_period_end?: string;
    }>(`/customers/${tenant.autumnCustomerId}/subscription`);

    const result = parseContract(
      SubscriptionStatusSchema,
      {
        tenantId,
        providerCustomerId: tenant.autumnCustomerId,
        subscriptionRef: response.subscription_id,
        status: response.status,
        planId: response.plan_id,
        currentPeriodEnd: response.current_period_end,
        updatedAt: stableNowIso(),
      },
      'SubscriptionStatus',
    );

    await this.repos.tenants.updateBillingReferences(tenantId, {
      subscriptionRef: result.subscriptionRef,
    });

    return result;
  }

  async checkEntitlement(input: EntitlementCheck): Promise<EntitlementDecision> {
    const tenant = await this.repos.tenants.get(input.tenantId);
    if (!tenant?.autumnCustomerId) {
      return parseContract(
        EntitlementDecisionSchema,
        {
          allowed: false,
          reason: 'no_billing_customer',
          source: 'cache',
          checkedAt: stableNowIso(),
        },
        'EntitlementDecision',
      );
    }

    const response = await this.request<{
      allowed: boolean;
      reason?: string;
      cached_until?: string;
    }>('/entitlements/check', {
      method: 'POST',
      body: {
        customer_id: tenant.autumnCustomerId,
        feature: input.feature,
        quantity: input.quantity,
      },
    });

    if (response.cached_until) {
      await this.repos.tenants.updateBillingReferences(input.tenantId, {
        entitlementCacheUntil: response.cached_until,
      });
    }

    return parseContract(
      EntitlementDecisionSchema,
      {
        allowed: response.allowed,
        reason: response.reason || (response.allowed ? 'allowed' : 'denied'),
        source: 'provider',
        checkedAt: stableNowIso(),
      },
      'EntitlementDecision',
    );
  }

  async reportUsage(input: UsageReportRequest): Promise<UsageReportResult> {
    const existing = await this.repos.billingRefs.getUsageReport(input.idempotencyKey);
    if (existing?.status === 'reported') {
      return parseContract(
        UsageReportResultSchema,
        {
          accepted: true,
          providerEventId: existing.providerRef,
          retryable: false,
          message: 'already_reported',
        },
        'UsageReportResult',
      );
    }

    await this.repos.billingRefs.upsertUsageReport(input.idempotencyKey, {
      tenantId: input.tenantId,
      runId: input.runId,
      metric: input.metric,
      quantity: input.quantity,
      status: 'pending',
      createdAt: stableNowIso(),
      updatedAt: stableNowIso(),
    });

    try {
      const tenant = await this.repos.tenants.get(input.tenantId);
      if (!tenant?.autumnCustomerId) {
        throw new AppError({
          code: 'BILLING_FAILURE',
          status: 400,
          retryable: false,
          message: 'tenant has no Autumn customer reference',
        });
      }

      const response = await this.request<{
        id?: string;
        accepted: boolean;
        message?: string;
      }>('/usage-events', {
        method: 'POST',
        body: {
          customer_id: tenant.autumnCustomerId,
          metric: input.metric,
          quantity: input.quantity,
          occurred_at: input.occurredAt,
          metadata: {
            run_id: input.runId,
            tenant_id: input.tenantId,
          },
        },
        idempotencyKey: input.idempotencyKey,
      });

      await this.repos.billingRefs.upsertUsageReport(input.idempotencyKey, {
        tenantId: input.tenantId,
        runId: input.runId,
        metric: input.metric,
        quantity: input.quantity,
        status: 'reported',
        providerRef: response.id,
        createdAt: stableNowIso(),
        updatedAt: stableNowIso(),
      });

      return parseContract(
        UsageReportResultSchema,
        {
          accepted: Boolean(response.accepted),
          providerEventId: response.id,
          retryable: false,
          message: response.message ?? 'reported',
        },
        'UsageReportResult',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable =
        error instanceof AppError ? error.retryable : true;
      await this.repos.billingRefs.upsertUsageReport(input.idempotencyKey, {
        tenantId: input.tenantId,
        runId: input.runId,
        metric: input.metric,
        quantity: input.quantity,
        status: 'failed',
        lastError: message,
        createdAt: stableNowIso(),
        updatedAt: stableNowIso(),
      });
      return parseContract(
        UsageReportResultSchema,
        {
          accepted: false,
          retryable,
          message,
        },
        'UsageReportResult',
      );
    }
  }

  async createPortalSession(
    tenantId: string,
    returnUrl: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const tenant = await this.repos.tenants.get(tenantId);
    if (!tenant?.autumnCustomerId) {
      throw new AppError({
        code: 'BILLING_FAILURE',
        message: 'Tenant has no Autumn customer reference',
        status: 400,
        retryable: false,
      });
    }
    const response = await this.request<{ url: string; expires_at: string }>(
      '/portal/sessions',
      {
        method: 'POST',
        body: {
          customer_id: tenant.autumnCustomerId,
          return_url: returnUrl,
        },
      },
    );
    return {
      url: response.url,
      expiresAt: response.expires_at,
    };
  }

  async getSummary(tenantId: string): Promise<BillingSummary> {
    const tenant = await this.repos.tenants.get(tenantId);
    const subscription = await this.fetchSubscriptionStatus(tenantId);
    const usageWindowStart = new Date();
    usageWindowStart.setUTCDate(1);
    usageWindowStart.setUTCHours(0, 0, 0, 0);
    const usage = await this.repos.usage.sumByTenant(
      tenantId,
      usageWindowStart.toISOString(),
    );
    return {
      customer: tenant?.autumnCustomerId
        ? {
            tenantId,
            providerCustomerId: tenant.autumnCustomerId,
            externalRef: tenant.tenantId,
          }
        : null,
      subscription,
      usageWindowStart: usageWindowStart.toISOString(),
      usageWindowEnd: stableNowIso(),
      usage,
    };
  }

  async verifyAndParseWebhook(
    headers: Headers,
    body: string,
  ): Promise<BillingWebhookEvent> {
    const signature = headers.get('x-autumn-signature');
    if (!signature) {
      throw new AppError({
        code: 'UNAUTHORIZED',
        message: 'Missing Autumn webhook signature',
        status: 401,
        retryable: false,
      });
    }
    const computed = await hmacSha256Hex(this.config.webhookSecret, body);
    if (signature !== computed) {
      throw new AppError({
        code: 'UNAUTHORIZED',
        message: 'Invalid Autumn webhook signature',
        status: 401,
        retryable: false,
      });
    }
    const payload = JSON.parse(body) as Record<string, unknown>;
    const id = payload.id;
    const type = payload.type;
    if (typeof id !== 'string' || typeof type !== 'string') {
      throw new AppError({
        code: 'INVALID_REQUEST',
        message: 'Autumn webhook payload missing id/type',
        status: 400,
        retryable: false,
      });
    }
    return {
      id,
      type,
      receivedAt: stableNowIso(),
      payload,
    };
  }

  async applyWebhookEvent(event: BillingWebhookEvent): Promise<void> {
    const metadata =
      typeof event.payload.metadata === 'object' && event.payload.metadata !== null
        ? (event.payload.metadata as Record<string, unknown>)
        : undefined;
    const tenantId = metadata?.tenant_id;
    if (typeof tenantId !== 'string') {
      return;
    }
    if (event.type === 'customer.updated') {
      const providerCustomerId = event.payload.customer_id;
      if (typeof providerCustomerId === 'string') {
        await this.repos.tenants.updateBillingReferences(tenantId, {
          autumnCustomerId: providerCustomerId,
        });
      }
    }
    if (event.type === 'subscription.updated') {
      const subscriptionRef = event.payload.subscription_id;
      if (typeof subscriptionRef === 'string') {
        await this.repos.tenants.updateBillingReferences(tenantId, {
          subscriptionRef,
        });
      }
    }
  }

  private async request<T>(
    path: string,
    init: {
      method?: 'GET' | 'POST';
      body?: unknown;
      idempotencyKey?: string;
    } = {},
  ): Promise<T> {
    const headers = new Headers({
      authorization: `Bearer ${this.config.apiKey}`,
      'content-type': 'application/json',
      'x-autumn-product-id': this.config.productId,
    });
    if (init.idempotencyKey) {
      headers.set('idempotency-key', init.idempotencyKey);
    }
    const response = await fetch(`${this.config.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    if (!response.ok) {
      const errorText = await response.text();
      const apiError: AutumnApiError = {
        status: response.status,
        message: errorText || `Autumn request failed: ${response.status}`,
        retryable: response.status >= 500 || response.status === 429,
      };
      log({
        event: 'billing.autumn.error',
        level: 'warn',
        message: 'Autumn API request failed',
        data: {
          status: apiError.status,
          message: apiError.message,
          retryable: apiError.retryable,
        },
      });
      throw new AppError({
        code: 'BILLING_FAILURE',
        status: 502,
        retryable: apiError.retryable,
        message: apiError.message,
      });
    }
    return response.json() as Promise<T>;
  }
}

export function createAutumnBillingAdapter(
  env: WorkerEnv,
  repos: PlatformRepositories,
): BillingPort {
  return new AutumnBillingAdapter(
    {
      apiKey: env.AUTUMN_API_KEY ?? 'dev-autumn-key',
      baseUrl: env.AUTUMN_BASE_URL ?? 'https://api.useautumn.com/v1',
      webhookSecret: env.AUTUMN_WEBHOOK_SECRET ?? 'dev-autumn-webhook-secret',
      productId: env.AUTUMN_PRODUCT_ID ?? 'nanoclaw-hosted',
    },
    repos,
  );
}
