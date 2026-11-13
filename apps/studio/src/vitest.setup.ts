import { afterEach } from 'vitest';
import { resetViewMemory } from './workbench/viewMemory.ts';

// A row's remembered view, log choice and height must not leak from one test into the next.
afterEach(() => resetViewMemory());
