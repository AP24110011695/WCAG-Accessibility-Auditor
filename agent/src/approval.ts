const attempts = new Map<string, { count: number; started: number }>();
export function approvePasscode(passcode: unknown, expected: string | undefined, client: string, now = Date.now()): boolean {
  const state = attempts.get(client);
  if (state && now - state.started < 600_000 && state.count >= 5) return false;
  const value = typeof passcode === "string" ? passcode : "";
  const max = Math.max(value.length, expected?.length ?? 0); let diff = value.length ^ (expected?.length ?? 0);
  for (let i = 0; i < max; i++) diff |= (value.charCodeAt(i) || 0) ^ (expected?.charCodeAt(i) || 0);
  const valid = Boolean(expected) && diff === 0;
  if (valid) { attempts.delete(client); return true; }
  attempts.set(client, !state || now - state.started >= 600_000 ? { count: 1, started: now } : { ...state, count: state.count + 1 });
  return false;
}
export function clearApprovalAttempts(): void { attempts.clear(); }
