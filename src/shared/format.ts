import type { ConnectionStatus } from "./types.ts";

/** "fastino/GLiNER2.5-Decide on mps" for the local model; the model id otherwise. */
export function describeModel(c: Extract<ConnectionStatus, { state: "ok" }>): string {
  return c.device ? `${c.model} on ${c.device}` : c.model;
}

/** True when the running service worker is from a different build than this page. */
export function workerIsStale(workerBuildId: string | undefined, pageBuildId: string): boolean {
  return workerBuildId !== pageBuildId;
}

/**
 * Whether a connection test proves the local model is serving. It must be an
 * "ok" answer for the local provider that names a device; an out-of-date worker
 * answering for another provider does not count.
 */
export function localModelReady(c: ConnectionStatus): boolean {
  return c.state === "ok" && c.provider === "local" && typeof c.device === "string" && c.device !== "";
}

export const STALE_WORKER_MESSAGE =
  "Quiet Feed was updated but is still running the old version. Click the reload icon on Quiet Feed in brave://extensions (or chrome://extensions), then reload your X tabs.";
