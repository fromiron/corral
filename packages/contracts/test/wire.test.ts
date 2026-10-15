import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import commandSchema from '../../../contracts/command.schema.json' with { type: 'json' };
import envelopeSchema from '../../../contracts/event-envelope.schema.json' with { type: 'json' };
import commands from '../../../examples/commands.json' with { type: 'json' };
import { RunCommand, RunEvent } from '../src/index.ts';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
const seedCommand = ajv.compile(commandSchema);
const seedEnvelope = ajv.compile(envelopeSchema);

const steer = commands.find((command) => command.type === 'steer');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('steer command parity with the seed command schema', () => {
  it('accepts the example steer command in both', () => {
    expect(seedCommand(steer)).toBe(true);
    expect(RunCommand.safeParse(steer).success).toBe(true);
  });

  it.each([
    ['text over 12000 characters', (c: any) => (c.payload.text = 'x'.repeat(12001))],
    ['unknown delivery boundary', (c: any) => (c.payload.delivery = 'immediately')],
    ['extra payload field', (c: any) => (c.payload.priority = 'high')],
    ['missing commandId', (c: any) => delete c.commandId],
  ])('rejects %s in both', (_name, change) => {
    const command = clone(steer) as any;
    change(command);
    expect(seedCommand(command)).toBe(false);
    expect(RunCommand.safeParse(command).success).toBe(false);
  });
});

describe('RunEvent envelope', () => {
  const sample = {
    schemaVersion: '0.1',
    eventId: 'evt_0001',
    runId: 'run_0001',
    runSeq: 7,
    recordedAt: '2026-10-15T00:00:00.000Z',
    type: 'directive.accepted',
    actor: { kind: 'user', id: 'local_user' },
    executionId: 'exec_0001',
    commandId: 'cmd_0001',
    causedByEventIds: [],
    payload: {
      directiveId: 'dir_0001',
      targetExecutionId: 'exec_0001',
      text: 'Primary sources only.',
    },
  };

  it('a typed event is also a valid seed envelope', () => {
    expect(RunEvent.safeParse(sample).success).toBe(true);
    expect(seedEnvelope(sample)).toBe(true);
  });

  it('rejects a payload that does not match its event type', () => {
    const wrong = clone(sample) as any;
    wrong.payload = { directiveId: 'dir_0001' };
    expect(seedEnvelope(wrong)).toBe(true);
    expect(RunEvent.safeParse(wrong).success).toBe(false);
  });
});
