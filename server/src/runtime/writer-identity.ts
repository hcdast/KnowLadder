/** Active registrations owned by this process, distinct from a PM2 deployment token. */
const tokens = new Set<string>();
export function trackWriter(token: string) {
  tokens.add(token);
}
export function untrackWriter(token: string) {
  tokens.delete(token);
}
export function activeWriterTokens(): string[] {
  return [...tokens];
}
