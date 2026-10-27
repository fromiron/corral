import { z } from 'zod';
import { Identifier } from './ids.ts';
import { WorkspaceTarget } from './workbench.ts';

export const MAX_TERMINAL_INPUT_BYTES = 16 * 1024;
export const MAX_TERMINAL_QUEUED_INPUT_BYTES = 64 * 1024;

const Dimensions = z.strictObject({ cols: z.int().min(2).max(500), rows: z.int().min(1).max(500) });
export const TerminalCreate = Dimensions.extend({
  operationId: Identifier,
  target: WorkspaceTarget,
  shellId: z.string().min(1).max(64),
});
export type TerminalCreate = z.infer<typeof TerminalCreate>;

/** The terminal ID is its original create operation ID; generation identifies this process. */
export const TerminalIdentity = z.strictObject({
  target: WorkspaceTarget,
  generation: Identifier,
});
export type TerminalIdentity = z.infer<typeof TerminalIdentity>;
export const TerminalControllerChange = TerminalIdentity.extend({
  attachmentId: Identifier,
  expectedGeneration: z.int().min(0),
  action: z.enum(['claim', 'release']),
  takeover: z.boolean().default(false),
});
export type TerminalControllerChange = z.infer<typeof TerminalControllerChange>;

const ControllerFrame = TerminalIdentity.extend({
  attachmentId: Identifier,
  controllerGeneration: z.int().min(1),
  sequence: z.int().min(1),
});
export const TerminalInput = ControllerFrame.extend({
  data: z.string().min(1).max(MAX_TERMINAL_INPUT_BYTES),
});
export type TerminalInput = z.infer<typeof TerminalInput>;
export const TerminalResize = ControllerFrame.extend(Dimensions.shape);
export type TerminalResize = z.infer<typeof TerminalResize>;

export const TerminalController = z.strictObject({
  attachmentId: Identifier,
  generation: z.int().min(1),
  /** Input and resize share one ordered frame sequence, acknowledged after host acceptance. */
  acceptedSequence: z.int().min(0),
});
export type TerminalController = z.infer<typeof TerminalController>;
export const TerminalView = z.strictObject({
  terminalId: Identifier,
  target: WorkspaceTarget,
  generation: Identifier,
  shellId: z.string().min(1).max(64),
  state: z.enum(['starting', 'running', 'stopping', 'exited', 'failed', 'uncertain']),
  initialCols: Dimensions.shape.cols,
  initialRows: Dimensions.shape.rows,
  ...Dimensions.shape,
  lastSequence: z.int().min(0),
  replayAvailable: z.boolean(),
  controllerGeneration: z.int().min(0),
  controller: TerminalController.nullable(),
  exitCode: z.int().nullable(),
  stopped: z.boolean().optional(),
  error: z.string().nullable(),
});
export type TerminalView = z.infer<typeof TerminalView>;
export const TerminalList = z.strictObject({
  target: WorkspaceTarget.nullable(),
  available: z.boolean(),
  reason: z.string().nullable(),
  shells: z.array(z.strictObject({ id: z.string(), label: z.string() })),
  terminals: z.array(TerminalView),
});
export type TerminalList = z.infer<typeof TerminalList>;
export const TerminalAck = z.strictObject({
  generation: Identifier,
  controllerGeneration: z.int().min(1),
  acceptedSequence: z.int().min(0),
});
export type TerminalAck = z.infer<typeof TerminalAck>;

const EventBase = z.strictObject({ generation: Identifier, sequence: z.int().min(1) });
const OutputEvent = EventBase.extend({ type: z.literal('output'), data: z.string() });
const ResizeEvent = EventBase.extend({ type: z.literal('resize'), ...Dimensions.shape });
export const TerminalEvent = z.discriminatedUnion('type', [OutputEvent, ResizeEvent]);
export type TerminalEvent = z.infer<typeof TerminalEvent>;
/** Status is current metadata, not historical terminal bytes or an acknowledgement of input. */
export const TerminalStreamMessage = z.discriminatedUnion('type', [
  OutputEvent,
  ResizeEvent,
  z.strictObject({ type: z.literal('status'), terminal: TerminalView }),
]);
export type TerminalStreamMessage = z.infer<typeof TerminalStreamMessage>;
