export interface ReconcileOptions { apply?: boolean; actor?: string; reason?: string; }

export function validateReconcileOptions(options: ReconcileOptions): void {
  if ((options.apply && (!options.actor || !options.reason)) ||
      (options.actor !== undefined && (!options.actor.trim() || options.actor.length > 200)) ||
      (options.reason !== undefined && (!options.reason.trim() || options.reason.length > 1000))) throw new Error('RECONCILE_ACTOR_REASON_REQUIRED');
}

export function parseReconcileOptions(args: string[]): ReconcileOptions {
  const options: ReconcileOptions = {};
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (!['--apply', '--actor', '--reason'].includes(flag) || seen.has(flag)) throw new Error('INVALID_RECONCILE_ARGUMENTS');
    seen.add(flag);
    if (flag === '--apply') { options.apply = true; continue; }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error('INVALID_RECONCILE_ARGUMENTS');
    if (flag === '--actor') options.actor = value;
    else options.reason = value;
  }
  validateReconcileOptions(options);
  return options;
}
