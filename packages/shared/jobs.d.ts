import { z } from 'zod';
/**
 * pg-boss job names + payload schemas.
 * Producers (api) and consumers (workers) both import from here so the queue
 * contract has exactly one definition. See docs/architecture.md — module boundaries.
 */
export declare const JOB: {
    readonly exampleCreated: "example.created";
    readonly webhookReceived: "git.webhook.received";
};
export type JobName = (typeof JOB)[keyof typeof JOB];
export declare const exampleCreatedPayload: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
}, "strip", z.ZodTypeAny, {
    name: string;
    id: string;
}, {
    name: string;
    id: string;
}>;
export type ExampleCreatedPayload = z.infer<typeof exampleCreatedPayload>;
export declare const webhookReceivedPayload: z.ZodObject<{
    /** api_webhook_events.id of the persisted, verified delivery. */
    eventId: z.ZodString;
}, "strip", z.ZodTypeAny, {
    eventId: string;
}, {
    eventId: string;
}>;
export type WebhookReceivedPayload = z.infer<typeof webhookReceivedPayload>;
