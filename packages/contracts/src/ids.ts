import { z } from 'zod';

/** Stable identifier shared by definitions, runs and events (seed schema pattern). */
export const Identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/);
export type Identifier = z.infer<typeof Identifier>;

export const SCHEMA_VERSION = '0.1';
export const SchemaVersion = z.literal(SCHEMA_VERSION);
