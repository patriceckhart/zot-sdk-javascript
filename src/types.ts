export type ZotProvider =
  | "anthropic"
  | "openai"
  | "openai-codex"
  | "openai-responses"
  | "kimi"
  | "deepseek"
  | "google"
  | "github-copilot"
  | "groq"
  | "openrouter"
  | "amazon-bedrock"
  | "ollama"
  | (string & {});

export type ZotReasoning = "off" | "minimum" | "low" | "medium" | "high" | "maximum";

export type ZotAuthMode = "auto" | "apiKey" | "subscription";

export type ZotSubscriptionProvider = "anthropic" | "openai-codex" | "kimi" | "github-copilot";

export interface ZotClientOptions {
  /** Path to the zot binary. Defaults to ZOT_BINARY or "zot". */
  binary?: string;
  provider?: ZotProvider;
  model?: string;
  cwd?: string;
  apiKey?: string;
  baseUrl?: string;
  /**
   * Credential source preference.
   *
   * - auto: let zot resolve credentials normally from --api-key, env vars, and auth.json.
   * - apiKey: require apiKey to be provided and pass it to zot.
   * - subscription: require a subscription-capable provider and let zot use stored OAuth credentials from auth.json.
   */
  auth?: ZotAuthMode;
  systemPrompt?: string;
  appendSystemPrompt?: string | string[];
  reasoning?: ZotReasoning;
  maxSteps?: number;
  noTools?: boolean;
  tools?: string[];
  env?: NodeJS.ProcessEnv;
  /** Required when the child process has ZOTCORE_RPC_TOKEN set. */
  rpcToken?: string;
  /** Spawn timeout for hello/ping style calls, in milliseconds. */
  commandTimeoutMs?: number;
}

export interface ZotImageInput {
  mime_type: string;
  data: string;
}

export interface PromptOptions {
  images?: ZotImageInput[];
}

export interface ZotUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number;
  cumulative?: ZotUsage;
}

export interface ZotModelInfo {
  id: string;
  provider: string;
  context_window?: number;
  max_output?: number;
  reasoning?: boolean;
  [key: string]: unknown;
}

export type ZotContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mime_type: string; bytes: number }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; call_id: string; is_error: boolean; content: ZotContentBlock[] }
  | { type: string; [key: string]: unknown };

export interface ZotMessage {
  role: "user" | "assistant" | "system" | (string & {});
  content: ZotContentBlock[];
  time?: string;
}

export type ZotStopReason = "end_turn" | "tool_use" | "length" | "error" | "aborted" | (string & {});

export type ZotEvent =
  | { type: "turn_start"; step: number }
  | { type: "user_message"; content: ZotContentBlock[]; time: string }
  | { type: "assistant_start" }
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_progress"; id: string; text: string }
  | { type: "tool_result"; id: string; is_error: boolean; content: ZotContentBlock[] }
  | { type: "assistant_message"; content: ZotContentBlock[]; time: string }
  | ({ type: "usage" } & ZotUsage)
  | { type: "turn_end"; stop: ZotStopReason; error?: string }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "compact_done"; summary: string }
  | { type: string; [key: string]: unknown };

export interface ZotResponse<T = unknown> {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  data?: T;
  error?: string;
}

export interface ZotState {
  provider: string;
  model: string;
  cwd: string;
  message_count: number;
  busy: boolean;
  usage: ZotUsage;
}

export interface HelloData {
  protocol_version: number;
  version: string;
  provider: string;
  model: string;
}

export interface PromptResult {
  text: string;
  events: ZotEvent[];
}

export class ZotRpcError extends Error {
  readonly response?: ZotResponse;

  constructor(message: string, response?: ZotResponse) {
    super(message);
    this.name = "ZotRpcError";
    if (response) this.response = response;
  }
}
