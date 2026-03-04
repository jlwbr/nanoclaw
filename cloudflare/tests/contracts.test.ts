import { describe, expect, it } from 'vitest';

import {
  AgentRunRequestSchema,
  CanonicalInboundEventSchema,
  parseContract,
} from '../src/contracts.js';
import { computeRetryDelaySeconds } from '../src/ports/queue.js';

describe('contracts', () => {
  it('validates AgentRunRequest DTO', () => {
    const parsed = parseContract(
      AgentRunRequestSchema,
      {
        runId: 'run_1',
        tenantId: 'tenant_1',
        idempotencyKey: 'key-1',
        prompt: 'hello',
        context: {
          isScheduledTask: false,
        },
        correlation: {
          requestId: 'req-1',
          tenantId: 'tenant_1',
        },
        createdAt: new Date().toISOString(),
      },
      'AgentRunRequest',
    );
    expect(parsed.runId).toBe('run_1');
  });

  it('rejects invalid inbound event payload', () => {
    expect(() =>
      parseContract(
        CanonicalInboundEventSchema,
        {
          eventId: 'e1',
          tenantId: 't1',
        },
        'CanonicalInboundEvent',
      ),
    ).toThrowError(/Invalid CanonicalInboundEvent/);
  });

  it('computes bounded exponential retry delays', () => {
    const policy = {
      maxAttempts: 5,
      baseDelaySeconds: 5,
      maxDelaySeconds: 40,
    };
    expect(computeRetryDelaySeconds(1, policy)).toBe(5);
    expect(computeRetryDelaySeconds(2, policy)).toBe(10);
    expect(computeRetryDelaySeconds(3, policy)).toBe(20);
    expect(computeRetryDelaySeconds(4, policy)).toBe(40);
    expect(computeRetryDelaySeconds(8, policy)).toBe(40);
  });
});
