/**
 * Node-style handle counting for timers (ref/unref). The program's main
 * promise resolves only when no ref'd handle remains.
 */
export function createHandleTable() {
  const refed = new Set();
  const waiters = new Set();

  const notify = () => {
    if (waiters.size === 0) return;
    const pending = [...waiters];
    waiters.clear();
    for (const wake of pending) wake();
  };

  return {
    get refCount() {
      return refed.size;
    },
    /** The ref'd handles (process.getActiveResourcesInfo). */
    list() {
      return [...refed];
    },
    add(handle) {
      refed.add(handle);
    },
    delete(handle) {
      if (refed.delete(handle)) notify();
    },
    notify,
    waitForProgress() {
      if (refed.size === 0) return Promise.resolve();
      return new Promise((resolve) => waiters.add(resolve));
    },
    clear() {
      refed.clear();
      notify();
    },
  };
}
