// A failed startup returns no server object. Keep its lock handle reachable until process exit.
const retainedOwnerships = new Set<() => void>();

/** AsyncDisposableStack forgets rejection once disposed; ownership must not forget it. */
export function onceResourceCleanup(
  dispose: () => Promise<void>,
  releaseOwnership?: () => void,
): () => Promise<void> {
  let completion: Promise<void> | undefined;
  return () => {
    completion ??= Promise.resolve()
      .then(dispose)
      .then(() => releaseOwnership?.())
      .catch((cause) => {
        if (releaseOwnership) retainedOwnerships.add(releaseOwnership);
        const failure = new Error('Resource cleanup could not be confirmed', { cause });
        Object.assign(failure, { code: 'RESOURCE_CLEANUP_FAILED' });
        throw failure;
      });
    return completion;
  };
}
