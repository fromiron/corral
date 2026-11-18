import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { withoutPageAddresses } from '../src/quiet-warnings.ts';

it("Electron's failed-load warning, which carries the full address, is not printed", () => {
  const target = new EventEmitter();
  const printed = vi.fn();
  target.on('warning', printed);
  withoutPageAddresses(target);
  const address = Object.assign(
    new Error('Failed to load URL: https://files.example/get?token=abc with error: ERR_FAILED'),
    { name: 'electron' },
  );
  target.emit('warning', address);
  expect(printed).not.toHaveBeenCalled();
  // Every other warning still prints, once.
  const other = Object.assign(new Error('Something else'), { name: 'electron' });
  const deprecation = Object.assign(new Error('Old API'), { name: 'DeprecationWarning' });
  target.emit('warning', other);
  target.emit('warning', deprecation);
  expect(printed.mock.calls).toEqual([[other], [deprecation]]);
});
