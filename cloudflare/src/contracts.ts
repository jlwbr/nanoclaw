import { z } from 'zod';

const isoDateString = z.string().datetime({ offset: true });

export const CorrelationContextSchema = z.object({
  requestId: z.string().min(1),
  tenantId: z.string().min(1),
  eventId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  deliveryId: z.string().min(1).optional(),
  billingEventId: z.string().min(1).optional(),
});

export type CorrelationContext = z.infer<typeof CorrelationContextSchema>;

export const UsageCounterSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  runtimeMs: z.number().int().nonnegative(),
});

export type UsageCounter = z.infer<typeof UsageCounterSchema>;

export const AgentRunRequestSchema = z.object({
  runId: z.string().min(1),
  tenantId: z.string().min(1),
  taskId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1),
  prompt: z.string().min(1),
  context: z.object({
    sessionId: z.string().min(1).optional(),
    groupFolder: z.string().min(1).optional(),
    isScheduledTask: z.boolean().default(false),
  }),
  correlation: CorrelationContextSchema,
  createdAt: isoDateString,
});

export type AgentRunRequest = z.infer<typeof AgentRunRequestSchema>;

export const RuntimeErrorCodeSchema = z.enum([
  'RUNTIME_TIMEOUT',
  'RUNTIME_UNAVAILABLE',
  'RUNTIME_BAD_RESPONSE',
  'RUNTIME_EXECUTION_FAILED',
  'RUNTIME_VERSION_MISMATCH',
  'RUNTIME_ABORTED',
]);

export type RuntimeErrorCode = z.infer<typeof RuntimeErrorCodeSchema>;

export const AgentRunResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    runId: z.string().min(1),
    outputText: z.string(),
    artifacts: z.array(
      z.object({
        artifactId: z.string().min(1),
        key: z.string().min(1),
        contentType: z.string().min(1),
        sizeBytes: z.number().int().nonnegative(),
      }),
    ),
    usage: UsageCounterSchema,
    correlation: CorrelationContextSchema,
    completedAt: isoDateString,
  }),
  z.object({
    status: z.literal('error'),
    runId: z.string().min(1),
    code: RuntimeErrorCodeSchema,
    message: z.string().min(1),
    retriable: z.boolean(),
    usage: UsageCounterSchema.optional(),
    correlation: CorrelationContextSchema,
    completedAt: isoDateString,
  }),
]);

export type AgentRunResult = z.infer<typeof AgentRunResultSchema>;

export const OutboundDeliveryRequestSchema = z.object({
  deliveryId: z.string().min(1),
  tenantId: z.string().min(1),
  runId: z.string().min(1),
  channel: z.string().min(1),
  target: z.string().min(1),
  payload: z.object({
    text: z.string().min(1),
    metadata: z.record(z.string(), z.string()).default({}),
  }),
  attempt: z.number().int().positive(),
  nextAttemptAt: isoDateString.optional(),
  correlation: CorrelationContextSchema,
});

export type OutboundDeliveryRequest = z.infer<typeof OutboundDeliveryRequestSchema>;

export const CanonicalInboundEventSchema = z.object({
  eventId: z.string().min(1),
  tenantId: z.string().min(1),
  source: z.string().min(1),
  channel: z.string().min(1),
  receivedAt: isoDateString,
  payload: z.object({
    sender: z.string().min(1),
    senderName: z.string().optional(),
    text: z.string().min(1),
    chatId: z.string().min(1),
  }),
  signature: z.string().min(1).optional(),
});

export type CanonicalInboundEvent = z.infer<typeof CanonicalInboundEventSchema>;

export const BillingCustomerSchema = z.object({
  tenantId: z.string().min(1),
  providerCustomerId: z.string().min(1),
  email: z.string().email().optional(),
  externalRef: z.string().min(1),
});

export type BillingCustomer = z.infer<typeof BillingCustomerSchema>;

export const SubscriptionStatusSchema = z.object({
  tenantId: z.string().min(1),
  providerCustomerId: z.string().min(1),
  subscriptionRef: z.string().min(1).optional(),
  status: z.enum([
    'active',
    'trialing',
    'past_due',
    'paused',
    'canceled',
    'incomplete',
    'none',
  ]),
  planId: z.string().min(1).optional(),
  currentPeriodEnd: isoDateString.optional(),
  updatedAt: isoDateString,
});

export type SubscriptionStatus = z.infer<typeof SubscriptionStatusSchema>;

export const EntitlementCheckSchema = z.object({
  tenantId: z.string().min(1),
  feature: z.string().min(1),
  quantity: z.number().nonnegative().default(1),
  correlation: CorrelationContextSchema,
});

export type EntitlementCheck = z.infer<typeof EntitlementCheckSchema>;

export const EntitlementDecisionSchema = z.object({
  allowed: z.boolean(),
  reason: z.string().min(1),
  source: z.enum(['cache', 'provider']),
  checkedAt: isoDateString,
});

export type EntitlementDecision = z.infer<typeof EntitlementDecisionSchema>;

export const UsageReportRequestSchema = z.object({
  tenantId: z.string().min(1),
  runId: z.string().min(1),
  metric: z.string().min(1),
  quantity: z.number().nonnegative(),
  idempotencyKey: z.string().min(1),
  occurredAt: isoDateString,
  correlation: CorrelationContextSchema,
});

export type UsageReportRequest = z.infer<typeof UsageReportRequestSchema>;

export const UsageReportResultSchema = z.object({
  accepted: z.boolean(),
  providerEventId: z.string().min(1).optional(),
  retryable: z.boolean(),
  message: z.string().min(1),
});

export type UsageReportResult = z.infer<typeof UsageReportResultSchema>;

export const BillingSummarySchema = z.object({
  customer: BillingCustomerSchema.nullable(),
  subscription: SubscriptionStatusSchema,
  usageWindowStart: isoDateString,
  usageWindowEnd: isoDateString,
  usage: z.array(
    z.object({
      metric: z.string().min(1),
      quantity: z.number().nonnegative(),
    }),
  ),
  managePortalUrl: z.string().url().optional(),
});

export type BillingSummary = z.infer<typeof BillingSummarySchema>;

export function parseContract<T>(
  schema: z.ZodType<T>,
  input: unknown,
  contractName: string,
): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid ${contractName}: ${issues}`);
  }
  return result.data;
}
