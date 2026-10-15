import { z } from 'zod';
import { Identifier, SchemaVersion } from './ids.ts';

// Screen-only state. Never part of definitionHash (CRL-CAN-002, INV-12).

export const NodeLayout = z.strictObject({
  x: z.number(),
  y: z.number(),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
});
export type NodeLayout = z.infer<typeof NodeLayout>;

export const CanvasLayout = z.strictObject({
  schemaVersion: SchemaVersion,
  corralId: Identifier,
  layoutRevision: z.int().min(1),
  viewport: z.strictObject({ x: z.number(), y: z.number(), zoom: z.number().positive() }),
  nodes: z.record(Identifier, NodeLayout),
});
export type CanvasLayout = z.infer<typeof CanvasLayout>;
