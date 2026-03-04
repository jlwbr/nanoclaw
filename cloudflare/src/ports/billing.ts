import {
  BillingCustomer,
  BillingSummary,
  EntitlementCheck,
  EntitlementDecision,
  SubscriptionStatus,
  UsageReportRequest,
  UsageReportResult,
} from '../contracts.js';

export interface BillingPortalSession {
  url: string;
  expiresAt: string;
}

export interface BillingWebhookEvent {
  id: string;
  type: string;
  receivedAt: string;
  payload: Record<string, unknown>;
}

export interface BillingPort {
  ensureCustomer(
    tenantId: string,
    input: { email?: string; externalRef: string },
  ): Promise<BillingCustomer>;
  fetchSubscriptionStatus(tenantId: string): Promise<SubscriptionStatus>;
  checkEntitlement(input: EntitlementCheck): Promise<EntitlementDecision>;
  reportUsage(input: UsageReportRequest): Promise<UsageReportResult>;
  createPortalSession(tenantId: string, returnUrl: string): Promise<BillingPortalSession>;
  getSummary(tenantId: string): Promise<BillingSummary>;
  verifyAndParseWebhook(
    headers: Headers,
    body: string,
  ): Promise<BillingWebhookEvent>;
  applyWebhookEvent(event: BillingWebhookEvent): Promise<void>;
}
