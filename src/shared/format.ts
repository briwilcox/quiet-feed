import type { ConnectionStatus } from "./types.ts";

/** "fastino/GLiNER2.5-Decide on mps" for the local model; the model id otherwise. */
export function describeModel(c: Extract<ConnectionStatus, { state: "ok" }>): string {
  return c.device ? `${c.model} on ${c.device}` : c.model;
}
