import { OutboundDeliveryRequest } from '../contracts.js';
import { log } from '../logging.js';
import {
  OutboundTransportPort,
  OutboundTransportResult,
} from '../ports/outbound.js';

export class LoggingOutboundTransportAdapter implements OutboundTransportPort {
  async deliver(
    request: OutboundDeliveryRequest,
  ): Promise<OutboundTransportResult> {
    log({
      event: 'outbound.delivery.attempt',
      message: 'Outbound delivery routed to transport adapter',
      correlation: request.correlation,
      data: {
        tenantId: request.tenantId,
        runId: request.runId,
        deliveryId: request.deliveryId,
        channel: request.channel,
        target: request.target,
      },
    });
    return {
      ok: true,
      retryable: false,
      providerMessageId: `${request.channel}:${request.deliveryId}`,
    };
  }
}
