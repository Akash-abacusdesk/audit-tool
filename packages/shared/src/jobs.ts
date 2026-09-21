import { z } from 'zod';

/**
 * pg-boss job names + payload schemas.
 * Producers (api) and consumers (workers) both import from here so the queue
 * contract has exactly one definition. See docs/architecture.md — module boundaries.
 */
export const JOB = {
  exampleCreated: 'example.created',
  webhookReceived: 'git.webhook.received',
} as const;

export type JobName = (typeof JOB)[keyof typeof JOB];

export const exampleCreatedPayload = z.object({
  id: z.string(),
  name: z.string(),
});

export type ExampleCreatedPayload = z.infer<typeof exampleCreatedPayload>;

export const webhookReceivedPayload = z.object({
  /** api_webhook_events.id of the persisted, verified delivery. */
  eventId: z.string().uuid(),
});

export type WebhookReceivedPayload = z.infer<typeof webhookReceivedPayload>;
