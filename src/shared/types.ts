export type BuiltInFilterId = "rage_bait" | "llm_slop" | "ai_video_slop";
export type Sensitivity = "conservative" | "balanced" | "aggressive";
export type KeyStorageMode = "session" | "local";

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
  | "api_error";

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
  hiddenByRule: Record<string, number>;
}

export type ConnectionStatus =
  | { state: "no_key" }
  | { state: "untested" }
  | { state: "ok"; model: string; checkedAt: number }
  | { state: "error"; message: string; checkedAt: number };

export type Message =
  | { type: "classify"; post: PostPayload }
  | { type: "getContentConfig" }
  | { type: "getStatus" }
  | { type: "saveKey"; key: string; mode: KeyStorageMode }
  | { type: "deleteKey" }
  | { type: "testConnection" }
  | { type: "clearCache" }
  | { type: "recordHidden"; ruleIds: string[] }
  | { type: "allowAuthor"; handle: string };

export interface ContentConfig {
  active: boolean;
  concealWhilePending: boolean;
  concealTimeoutMs: number;
  allowedAuthors: string[];
  settingsVersion: number;
}

export interface StatusResponse {
  settings: Settings;
  hasKey: boolean;
  connection: ConnectionStatus;
  usage: UsageStats;
}
