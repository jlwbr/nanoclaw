import { OutboundDeliveryRequest } from '../contracts.js';

export interface OutboundTransportResult {
  ok: boolean;
  retryable: boolean;
  providerMessageId?: string;
  error?: string;
}

export interface OutboundTransportPort {
  deliver(request: OutboundDeliveryRequest): Promise<OutboundTransportResult>;
}
