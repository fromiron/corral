import { z } from 'zod';
import { CreateRunRequest, RunCommand } from './commands.ts';
import { CorralDefinition } from './definition.ts';
import { RunEvent } from './events.ts';
import { CanvasLayout } from './layout.ts';
import { Receipt } from './receipt.ts';
import { ReviewArtifact } from './review.ts';

// JSON Schema is generated from the Zod source. The files under
// packages/contracts/generated are build output: regenerate with `pnpm contracts:generate`.

const SOURCES = {
  'corral-definition.schema.json': [
    CorralDefinition,
    'urn:corral:definition:0.1',
    'CorralDefinition',
  ],
  'layout.schema.json': [CanvasLayout, 'urn:corral:layout:0.1', 'CanvasLayout'],
  'command.schema.json': [RunCommand, 'urn:corral:command:0.1', 'RunCommand'],
  'create-run.schema.json': [CreateRunRequest, 'urn:corral:create-run:0.1', 'CreateRunRequest'],
  'run-event.schema.json': [RunEvent, 'urn:corral:run-event:0.1', 'RunEvent'],
  'receipt.schema.json': [Receipt, 'urn:corral:receipt:0.1', 'Receipt'],
  'review.schema.json': [ReviewArtifact, 'urn:corral:review:0.1', 'ReviewArtifact'],
} as const satisfies Record<string, [z.ZodType, string, string]>;

export function generateJsonSchemas(): Record<keyof typeof SOURCES, object> {
  const out = {} as Record<keyof typeof SOURCES, object>;
  for (const [file, [schema, id, title]] of Object.entries(SOURCES)) {
    const json = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' });
    out[file as keyof typeof SOURCES] = { ...json, $id: id, title };
  }
  return out;
}
