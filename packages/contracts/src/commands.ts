import { z } from 'zod';
import { CorralDefinition } from './definition.ts';
import { Identifier, SchemaVersion } from './ids.ts';

// Command envelope from contracts/command.schema.json. P0 implements `steer`; C-005 adds the rest.

const envelope = {
  schemaVersion: SchemaVersion,
  commandId: Identifier,
  runId: Identifier,
  expectedControlRevision: z.int().min(0).max(1_000_000).optional(),
};

export const SteerCommand = z.strictObject({
  ...envelope,
  type: z.literal('steer'),
  payload: z.strictObject({
    targetExecutionId: Identifier,
    text: z.string().min(1).max(12000),
    delivery: z.literal('next_request'),
  }),
});
export type SteerCommand = z.infer<typeof SteerCommand>;

export const RunCommand = z.discriminatedUnion('type', [SteerCommand]);
export type RunCommand = z.infer<typeof RunCommand>;

/** POST /runs: start a run from a validated definition snapshot. */
export const StartRunRequest = z.strictObject({
  schemaVersion: SchemaVersion,
  commandId: Identifier,
  definition: CorralDefinition,
  mode: z.enum(['mock', 'live']),
});
export type StartRunRequest = z.infer<typeof StartRunRequest>;
