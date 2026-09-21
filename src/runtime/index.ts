/** Type-only re-exports so the Worker can talk to Durable Objects without dragging
 *  runtime imports (and `cloudflare:workers`) into its own module graph. */
export type { LearnerStub } from './learner';
export type { LiveStub } from './live';
