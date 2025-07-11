export async function wait(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms));
}

export async function until<T>(fn: () => T, predicate: (v: T) => boolean, timeoutMs = 2000, stepMs = 50): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const val = fn();
    if (predicate(val)) return val;
    await wait(stepMs);
  }
  throw new Error('Condition not satisfied within timeout');
} 