export type BuiltInFilterId = "rage_bait" | "llm_slop" | "ai_video_slop";
export type Sensitivity = "conservative" | "balanced" | "aggressive";
export type KeyStorageMode = "session" | "local";
/** Which classifier runs: TypeSafe's Jev, Fastino's hosted GLiNER2.5, or GLiNER2.5-Decide on this computer. */
export type Backend = "jev" | "gliner" | "local";
/** Backends that need an API key. */
export type KeyedBackend = "jev" | "gliner";

export interface CustomTopic {
  id: string;
  name: string;
  description: string;
  exceptions: string;
  enabled: boolean;
}

export interface Settings {
  enabled: boolean;
  /** Set once the user has read the privacy disclosure on the settings page. */
  disclosureAccepted: boolean;
  backend: Backend;
  /** Where the local server listens; only http://127.0.0.1 or http://localhost. */
  localEndpoint: string;
  /** Hide posts the provider refuses under its usage policy (Fastino refuses many hostile posts). */
  hideProviderRefusals: boolean;
  filters: Record<BuiltInFilterId, boolean>;
  sensitivity: Sensitivity;
  topics: CustomTopic[];
  /** Lowercased handles without the leading @. */
  allowedAuthors: string[];
  dailyRequestLimit: number;
  concealWhilePending: boolean;
  concealTimeoutMs: number;
  keyStorageMode: KeyStorageMode;
}

/** What the content script extracts from one rendered post. */
export interface PostPayload {
  /** X status id, used to recheck identity before applying a result. */
  statusId: string;
  authorHandle: string;
  text: string;
  quotedText: string | null;
  mediaLabels: string[];
  hasVideo: boolean;
  textTruncated: boolean;
}

export interface MatchedRule {
  ruleId: string;
  label: string;
  probability: number;
  threshold: number;
}

export type DecisionReason =
  | "hidden"
  | "below_threshold"
  | "allowed_author"
  | "incomplete_text"
  | "disabled"
  | "no_rules"
  | "no_key"
  | "daily_limit"
  | "api_error"
  | "provider_refused";

export interface Decision {
  hide: boolean;
  reason: DecisionReason;
  matched: MatchedRule[];
  /** One plain sentence built from the matched rule; no extra model call. */
  explanation: string;
}

export interface UsageStats {
  day: string;
  requests: number;
  cacheHits: number;
  inputTokens: number;
  outputTokens: number;
  errors: number;
  lastLatencyMs: number | null;
  lastModel: string | null;
  /** Distinct posts that got a verdict (API or cache), counted once per post per page load. */
  checked: number;
  /** Distinct posts hidden, counted once per post per page load. */
  blocked: number;
  /** Requests the provider refused under its usage policy. */
  refused: number;
  hiddenByRule: Record<string, number>;
}

/** A hidden post kept in session memory (cleared when the browser closes) for review. */
export interface BlockedPost {
  statusId: string;
  authorHandle: string;
  snippet: string;
  labels: string[];
  at: number;
}

export type ConnectionStatus =
  | { state: "no_key" }
  | { state: "untested" }
  | { state: "ok"; model: string; checkedAt: number; device?: string; provider?: Backend }
  | { state: "error"; message: string; checkedAt: number; provider?: Backend };

export type Message =
  | { type: "classify"; post: PostPayload }
  | { type: "getContentConfig" }
  | { type: "getStatus" }
  | { type: "saveKey"; provider: KeyedBackend; key: string; mode: KeyStorageMode }
  | { type: "deleteKey"; provider: KeyedBackend }
  | { type: "testConnection"; provider: Backend }
  | { type: "clearCache" }
  | {
      type: "recordResult";
      newlyChecked: boolean;
      newlyBlocked: boolean;
      ruleIds: string[];
      blockedPost?: Omit<BlockedPost, "at">;
    }
  | { type: "clearRecentBlocked" }
  | { type: "allowAuthor"; handle: string };

export interface ContentConfig {
  active: boolean;
  concealWhilePending: boolean;
  concealTimeoutMs: number;
  allowedAuthors: string[];
  settingsVersion: number;
}

export interface StatusResponse {
  /** The service worker's build; compare with the page's BUILD_ID. */
  buildId: string;
  settings: Settings;
  /** Whether a key is saved for each provider. */
  keys: Record<KeyedBackend, boolean>;
  /** Whether the selected backend has a key. */
  hasKey: boolean;
  /** Connection state of the selected backend. */
  connection: ConnectionStatus;
  connections: Record<Backend, ConnectionStatus>;
  usage: UsageStats;
  recentBlocked: BlockedPost[];
}
