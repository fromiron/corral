import { createStore } from 'zustand/vanilla';

type Operation = { target: string; href: string; state: 'pending' | 'saved' | 'uncertain' };

/** Only receipts live outside forms. Payloads, keys and server errors never enter this store. */
export function createSettingsTasks() {
  const commands = new Map<string, { current: unknown }>();
  const store = createStore<{ operations: Operation[] }>(() => ({ operations: [] }));
  const update = (operation: Operation) =>
    store.setState(({ operations }) => ({
      operations: [...operations.filter((value) => value.target !== operation.target), operation],
    }));
  return {
    store,
    command<T>(target: string): { current: T | null } {
      let command = commands.get(target);
      if (!command) {
        command = { current: null };
        commands.set(target, command);
      }
      return command as { current: T | null };
    },
    async run<T>(target: string, href: string, action: () => Promise<T>): Promise<T> {
      if (
        store
          .getState()
          .operations.some((value) => value.target === target && value.state === 'pending')
      )
        throw new Error('A settings operation for this target is still pending.');
      update({ target, href, state: 'pending' });
      try {
        const value = await action();
        update({ target, href, state: 'saved' });
        return value;
      } catch (error) {
        // A transport failure does not prove that the server rejected the write.
        update({ target, href, state: 'uncertain' });
        throw error;
      }
    },
    dismiss(target: string) {
      store.setState(({ operations }) => ({
        operations: operations.filter(
          (value) => value.target !== target || value.state === 'pending',
        ),
      }));
    },
  };
}
