import type { User } from './db/schema.js';
import type { Scheduler } from './scheduler/scheduler.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Background maintenance sweep. Started by the entrypoint, not by tests. */
    scheduler: Scheduler;
  }
  interface FastifyRequest {
    /** Real client IP resolved from the socket + trusted proxy headers. */
    clientIp: string;
    /** Authenticated user for the request, or null. */
    user: User | null;
    /** ISO 3166-1 country from trusted Cloudflare, or null if unknown. */
    clientCountry: string | null;
  }
}

export {};
