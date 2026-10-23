const HEX = "0123456789abcdef";

function randomHex(size: number): string {
  let out = "";
  for (let i = 0; i < size; i++) out += HEX.charAt(Math.floor(Math.random() * HEX.length));
  return out;
}

export function newRunId(now = new Date()): string {
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, "");
  return `run-${stamp}-${randomHex(4)}`;
}

export function pageInputId(runId: string, index: number): string {
  return `pg-${runId}-${String(index).padStart(2, "0")}`;
}

export function newId(prefix: string): string {
  return `${prefix}-${randomHex(8)}`;
}
