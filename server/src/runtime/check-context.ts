/** Optional diagnostics/cancellation for one complete check; never a success cache. */
export interface CheckContext {
  signal?: AbortSignal;
  run?: <T>(stage: string, work: () => Promise<T>) => Promise<T>;
}
export async function checkStep<T>(
  context: CheckContext,
  stage: string,
  work: () => Promise<T>,
): Promise<T> {
  context.signal?.throwIfAborted();
  const result = await (context.run ? context.run(stage, work) : work());
  context.signal?.throwIfAborted();
  return result;
}
