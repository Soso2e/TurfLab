export type OperationalEvent = {
  event: string;
  component: string;
  [key: string]: string | number | boolean | null | undefined;
};

/** Emit one secret-free JSONL record to the process log. Never pass prompts or request bodies. */
export function emitOperationalEvent(event: OperationalEvent): void {
  console.log(JSON.stringify({
    schema_version: 1,
    timestamp: new Date().toISOString(),
    ...event,
  }));
}
