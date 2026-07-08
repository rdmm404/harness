import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const CODEX_PROVIDER_ID = "openai-codex";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const STATUS_KEY = "codex-usage";
const COMMAND_NAME = "codex-usage";
const DEFAULT_TIMEOUT_MS = 15_000;
const REFRESH_INTERVAL_MS = 30_000;
const MAX_ERROR_BODY_CHARS = 600;
const CODEX_USAGE_LIMIT_ID = "codex";
const SPARK_USAGE_LIMIT_ID = "spark";
const SPARK_MODEL_KEY = "gpt-5.3-codex-spark";

const COMMAND_COMPLETIONS = [
  { value: "--refresh", label: "--refresh", description: "Refresh usage instead of cached data" },
  { value: "--timeout ", label: "--timeout", description: "Set query timeout in seconds" },
] as const;

type UsageSource = "pi-auth" | "codex-app-server";
type TimeoutHandle = ReturnType<typeof setTimeout> & { unref?: () => void };
type PiModel = NonNullable<ExtensionContext["model"]>;
type CodexUsageModel = Pick<PiModel, "id" | "name" | "provider">;
type PiTheme = ExtensionCommandContext["ui"]["theme"];

type QueryUsageOptions = {
  refresh: boolean;
  timeoutMs: number;
};

type CachedReport = {
  createdAt: number;
  report: CodexUsageReport;
};

type QueryUsageResult =
  | { ok: true; report: CodexUsageReport }
  | { ok: false; errors: UsageQueryError[] };

type UsageQueryError = {
  source: UsageSource;
  message: string;
  cause?: unknown;
};

type CodexUsageReport = {
  source: UsageSource;
  capturedAt: number;
  planType?: string;
  resetCreditsAvailable?: number;
  snapshots: NormalizedRateLimitSnapshot[];
};

type NormalizedRateLimitSnapshot = {
  limitId: string;
  limitName?: string;
  primary?: NormalizedRateLimitWindow;
  secondary?: NormalizedRateLimitWindow;
  credits?: NormalizedCredits;
};

type NormalizedRateLimitWindow = {
  usedPercent: number;
  windowMinutes?: number;
  resetAt?: number;
};

type NormalizedCredits = {
  hasCredits: boolean;
  unlimited: boolean;
  balance?: string;
};

type RateLimitStatusPayload = {
  plan_type?: unknown;
  rate_limit?: unknown;
  additional_rate_limits?: unknown;
  credits?: unknown;
  rate_limit_reset_credits?: unknown;
};

type BackendAdditionalRateLimit = {
  limit_name?: unknown;
  metered_feature?: unknown;
  rate_limit?: unknown;
};

type BackendRateLimitDetails = {
  primary_window?: unknown;
  secondary_window?: unknown;
};

type BackendWindowSnapshot = {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_at?: unknown;
  resets_at?: unknown;
  reset_time?: unknown;
  end_time?: unknown;
  ends_at?: unknown;
  expires_at?: unknown;
  reset_after_seconds?: unknown;
};

type BackendCreditsSnapshot = {
  has_credits?: unknown;
  unlimited?: unknown;
  balance?: unknown;
};

type BackendResetCreditsSnapshot = {
  available_count?: unknown;
};

type AppServerRateLimitResponse = {
  rateLimits?: unknown;
  rateLimitsByLimitId?: unknown;
  rateLimitResetCredits?: unknown;
  rate_limit_reset_credits?: unknown;
};

type AppServerRateLimitSnapshot = {
  limitId?: unknown;
  limitName?: unknown;
  primary?: unknown;
  secondary?: unknown;
  credits?: unknown;
  planType?: unknown;
};

type AppServerWindowSnapshot = {
  usedPercent?: unknown;
  used_percent?: unknown;
  windowDurationMins?: unknown;
  window_duration_mins?: unknown;
  resetAt?: unknown;
  resetsAt?: unknown;
  reset_at?: unknown;
  resets_at?: unknown;
  resetTime?: unknown;
  endTime?: unknown;
  endsAt?: unknown;
  expiresAt?: unknown;
  resetAfterSeconds?: unknown;
  reset_after_seconds?: unknown;
};

type AppServerCreditsSnapshot = {
  hasCredits?: unknown;
  has_credits?: unknown;
  unlimited?: unknown;
  balance?: unknown;
};

type RpcResponse = {
  id?: unknown;
  result?: unknown;
  error?: { message?: unknown; code?: unknown };
};

type PendingRpc = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export default function codexUsage(pi: ExtensionAPI) {
  let cache: CachedReport | undefined;
  let inFlightUsageQuery: Promise<QueryUsageResult> | undefined;
  let statuslineRefreshTimer: TimeoutHandle | undefined;
  let statuslineRequestId = 0;

  const clearRefreshTimer = () => {
    if (statuslineRefreshTimer) clearTimeout(statuslineRefreshTimer);
    statuslineRefreshTimer = undefined;
  };

  const clearUsageStatusline = (ctx: ExtensionContext) => {
    statuslineRequestId += 1;
    clearRefreshTimer();
    ctx.ui.setStatus(STATUS_KEY, undefined);
  };

  const scheduleStatuslineRefresh = (ctx: ExtensionContext) => {
    if (statuslineRefreshTimer) clearTimeout(statuslineRefreshTimer);
    statuslineRefreshTimer = setTimeout(() => {
      void refreshCurrentCodexUsageStatusline(ctx, true);
    }, REFRESH_INTERVAL_MS) as TimeoutHandle;
    statuslineRefreshTimer.unref?.();
  };

  const setUsageStatusline = (
    ctx: ExtensionContext,
    report: CodexUsageReport,
    model: CodexUsageModel | undefined,
  ) => {
    ctx.ui.setStatus(STATUS_KEY, formatCodexUsageStatusline(report, model));
    scheduleStatuslineRefresh(ctx);
  };

  const queryCurrentUsage = (
    ctx: ExtensionContext,
    model: CodexUsageModel | undefined,
    timeoutMs: number,
  ) => {
    if (!inFlightUsageQuery) {
      inFlightUsageQuery = queryUsage(ctx, { timeoutMs }, model).finally(() => {
        inFlightUsageQuery = undefined;
      });
    }
    return inFlightUsageQuery;
  };

  const refreshCurrentCodexUsageStatusline = async (
    ctx: ExtensionContext,
    force: boolean,
    model = ctx.model,
  ) => {
    if (!isOpenAICodexModel(model)) {
      clearUsageStatusline(ctx);
      return;
    }

    if (!cache) ctx.ui.setStatus(STATUS_KEY, "checking");
    const requestId = statuslineRequestId + 1;
    statuslineRequestId = requestId;

    const cached = cache && Date.now() - cache.createdAt < REFRESH_INTERVAL_MS ? cache : undefined;
    if (cached && !force) {
      setUsageStatusline(ctx, cached.report, model);
      return;
    }

    const result = await queryCurrentUsage(ctx, model, DEFAULT_TIMEOUT_MS);
    if (requestId !== statuslineRequestId) return;
    if (!isOpenAICodexModel(ctx.model)) {
      clearUsageStatusline(ctx);
      return;
    }

    if (!result.ok) {
      if (!cache) ctx.ui.setStatus(STATUS_KEY, "usage error");
      scheduleStatuslineRefresh(ctx);
      return;
    }

    cache = { createdAt: Date.now(), report: result.report };
    setUsageStatusline(ctx, result.report, model);
  };

  const showUsageCommand = async (args: string, ctx: ExtensionCommandContext) => {
    const options = parseArgs(args);
    if (!options.ok) {
      ctx.ui.notify(options.error, "warning");
      return;
    }

    const cached = cache && Date.now() - cache.createdAt < REFRESH_INTERVAL_MS ? cache : undefined;
    if (cached && !options.value.refresh) {
      showReport(ctx, cached.report, ctx.model, true);
      return;
    }

    ctx.ui.setStatus(STATUS_KEY, "checking");
    const result = await queryCurrentUsage(ctx, ctx.model, options.value.timeoutMs);
    if (!result.ok) {
      ctx.ui.setStatus(STATUS_KEY, "usage error");
      ctx.ui.notify(formatQueryErrors(result.errors), "error");
      return;
    }

    cache = { createdAt: Date.now(), report: result.report };
    setUsageStatusline(ctx, result.report, ctx.model);
    showReport(ctx, result.report, ctx.model, false);
  };

  pi.registerCommand(COMMAND_NAME, {
    description: "Show OpenAI Codex subscription usage and reset times",
    getArgumentCompletions: completeCodexUsageArguments,
    handler: showUsageCommand,
  });

  pi.on("session_start", (_event, ctx) => {
    if (isOpenAICodexModel(ctx.model)) void refreshCurrentCodexUsageStatusline(ctx, false);
    else clearUsageStatusline(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    if (isOpenAICodexModel(ctx.model)) void refreshCurrentCodexUsageStatusline(ctx, false);
    else clearUsageStatusline(ctx);
  });

  pi.on("model_select", (event, ctx) => {
    if (isOpenAICodexModel(event.model)) {
      void refreshCurrentCodexUsageStatusline(ctx, false, event.model);
    } else {
      clearUsageStatusline(ctx);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearUsageStatusline(ctx);
  });
}

function completeCodexUsageArguments(argumentPrefix: string) {
  const prefix = argumentPrefix.trimStart();
  if (prefix === "") return [...COMMAND_COMPLETIONS];

  const trailingSpace = /\s$/.test(prefix);
  const tokens = prefix.trimEnd().split(/\s+/).filter(Boolean);
  const previous = tokens.at(-1);
  if (previous === "--timeout" && trailingSpace) return null;
  if (!trailingSpace && tokens.at(-2) === "--timeout") return null;

  const current = trailingSpace ? "" : (previous ?? "");
  if (current && !current.startsWith("-")) return null;

  const currentRaw = trailingSpace ? "" : (prefix.match(/\S+$/)?.[0] ?? "");
  const completionPrefix = trailingSpace ? prefix : prefix.slice(0, prefix.length - currentRaw.length);
  const matches = COMMAND_COMPLETIONS.filter((item) => item.value.startsWith(current));
  return matches.length > 0
    ? matches.map((item) => ({ ...item, value: `${completionPrefix}${item.value}` }))
    : null;
}

function parseArgs(args: string): { ok: true; value: QueryUsageOptions } | { ok: false; error: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let refresh = false;
  let timeoutMs = DEFAULT_TIMEOUT_MS;

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === "--refresh") {
      refresh = true;
      continue;
    }
    if (token === "--timeout") {
      const rawValue = tokens[index + 1];
      if (!rawValue) return { ok: false, error: "Usage: /codex-usage [--refresh] [--timeout seconds]" };
      const parsed = Number(rawValue);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 120) {
        return { ok: false, error: "--timeout must be a number of seconds between 1 and 120." };
      }
      timeoutMs = Math.round(parsed * 1000);
      index += 1;
      continue;
    }
    return {
      ok: false,
      error: `Unknown option: ${token}. Usage: /codex-usage [--refresh] [--timeout seconds]`,
    };
  }

  return { ok: true, value: { refresh, timeoutMs } };
}

function isOpenAICodexModel(model: Pick<PiModel, "provider"> | undefined): boolean {
  return model?.provider === CODEX_PROVIDER_ID;
}

function isSparkCodexModel(model: Pick<PiModel, "id" | "name" | "provider"> | undefined): boolean {
  if (!isOpenAICodexModel(model)) return false;
  const key = `${model?.id ?? ""} ${model?.name ?? ""}`.toLowerCase();
  return key.includes(SPARK_MODEL_KEY);
}

function activeUsageLimitId(model: Pick<PiModel, "id" | "name" | "provider"> | undefined): string {
  return isSparkCodexModel(model) ? SPARK_USAGE_LIMIT_ID : CODEX_USAGE_LIMIT_ID;
}

async function queryUsage(
  ctx: ExtensionContext,
  options: Pick<QueryUsageOptions, "timeoutMs">,
  model: CodexUsageModel | undefined,
): Promise<QueryUsageResult> {
  const errors: UsageQueryError[] = [];
  const sources = isSparkCodexModel(model)
    ? (["codex-app-server", "pi-auth"] as const)
    : (["pi-auth", "codex-app-server"] as const);

  for (const source of sources) {
    try {
      const report =
        source === "pi-auth"
          ? await queryViaPiAuth(ctx, options.timeoutMs)
          : await queryViaCodexAppServer(options.timeoutMs);
      if (selectUsageSnapshot(report, activeUsageLimitId(model))) {
        return { ok: true, report };
      }
      errors.push({ source, message: `${source} returned no displayable rate-limit windows` });
    } catch (cause) {
      errors.push({ source, message: errorMessage(cause), cause });
    }
  }

  return { ok: false, errors };
}

async function queryViaPiAuth(ctx: ExtensionContext, timeoutMs: number): Promise<CodexUsageReport> {
  const auth = await resolvePiCodexAuth(ctx);
  if (!auth) {
    throw new Error(
      "No Pi OpenAI Codex subscription auth was available. Use a Pi OpenAI Codex model or run /login for OpenAI ChatGPT Plus/Pro (Codex).",
    );
  }

  const response = await fetchWithTimeout(CODEX_USAGE_URL, { headers: auth.headers }, timeoutMs);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Codex usage endpoint returned ${response.status} ${response.statusText}: ${redactErrorBody(text)}`,
    );
  }

  const payload = parseJsonObject(text, "Codex usage endpoint response");
  return normalizeBackendPayload(payload as RateLimitStatusPayload, Date.now(), "pi-auth");
}

async function resolvePiCodexAuth(ctx: ExtensionContext): Promise<{ headers: Record<string, string> } | undefined> {
  const models = codexAuthCandidateModels(ctx);
  const errors: string[] = [];

  for (const model of models) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      errors.push(auth.error);
      continue;
    }

    const headers = { ...(auth.headers ?? {}) };
    if (!hasHeader(headers, "Authorization") && auth.apiKey) {
      headers.Authorization = `Bearer ${auth.apiKey}`;
    }
    if (!hasHeader(headers, "User-Agent")) {
      headers["User-Agent"] = "pi-codex-usage";
    }
    if (hasHeader(headers, "Authorization")) {
      return { headers };
    }
  }

  if (errors.length > 0) throw new Error(errors.join("; "));
  return undefined;
}

function codexAuthCandidateModels(ctx: ExtensionContext): PiModel[] {
  const candidates: PiModel[] = [];
  const seen = new Set<string>();
  const add = (model: PiModel | undefined) => {
    if (!model || model.provider !== CODEX_PROVIDER_ID) return;
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(model);
  };

  add(ctx.model);
  for (const model of ctx.modelRegistry.getAvailable()) add(model);
  for (const model of ctx.modelRegistry.getAll()) add(model);
  return candidates;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s while fetching Codex usage.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function queryViaCodexAppServer(timeoutMs: number): Promise<CodexUsageReport> {
  const client = new CodexAppServerClient(timeoutMs);
  try {
    await client.start();
    await client.request("initialize", {
      clientInfo: { name: "pi_codex_usage", title: "Pi Codex Usage", version: "0.1.0" },
      capabilities: {
        experimentalApi: false,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    });
    client.notify("initialized");
    const result = await client.request("account/rateLimits/read", undefined);
    return normalizeAppServerResponse(
      assertObject(result, "account/rateLimits/read result") as AppServerRateLimitResponse,
      Date.now(),
    );
  } finally {
    client.dispose();
  }
}

class CodexAppServerClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private stderr = "";
  private readonly pending = new Map<number, PendingRpc>();
  private startPromise?: Promise<void>;
  private exitError?: Error;

  constructor(private readonly timeoutMs: number) {}

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;

    this.startPromise = new Promise((resolve, reject) => {
      const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;

      const startupTimeout = setTimeout(() => {
        reject(new Error(`Timed out after ${Math.round(this.timeoutMs / 1000)}s starting codex app-server.`));
      }, this.timeoutMs);

      child.once("spawn", () => {
        clearTimeout(startupTimeout);
        resolve();
      });

      child.once("error", (error) => {
        clearTimeout(startupTimeout);
        reject(new Error(`Failed to start codex app-server: ${error.message}`));
        this.rejectAll(error);
      });

      child.once("exit", (code, signal) => {
        const suffix = this.stderr ? ` stderr: ${redactErrorBody(this.stderr)}` : "";
        this.exitError = new Error(
          `codex app-server exited before completing the request (code ${code ?? "unknown"}, signal ${signal ?? "none"}).${suffix}`,
        );
        this.rejectAll(this.exitError);
      });

      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        this.stderr = truncateEnd(this.stderr + chunk, MAX_ERROR_BODY_CHARS);
      });

      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => this.handleLine(line));
    });

    return this.startPromise;
  }

  request(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child?.stdin.writable) throw new Error("codex app-server is not running.");
    if (this.exitError) throw this.exitError;

    const id = this.nextId++;
    const payload = params === undefined ? { method, id } : { method, id, params };
    const response = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out after ${Math.round(this.timeoutMs / 1000)}s waiting for ${method}.`));
      }, this.timeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });

    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return response;
  }

  notify(method: string): void {
    const child = this.child;
    if (!child?.stdin.writable) return;
    child.stdin.write(`${JSON.stringify({ method })}\n`);
  }

  dispose(): void {
    for (const [id, pending] of this.pending) {
      pending.reject(new Error(`codex app-server request ${id} cancelled.`));
    }
    this.pending.clear();

    const child = this.child;
    if (!child) return;
    child.stdin.end();
    if (!child.killed) child.kill();
    this.child = undefined;
  }

  private handleLine(line: string): void {
    let parsed: RpcResponse;
    try {
      parsed = JSON.parse(line) as RpcResponse;
    } catch {
      return;
    }

    if (typeof parsed.id !== "number") return;
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    this.pending.delete(parsed.id);

    if (parsed.error) {
      const message = typeof parsed.error.message === "string" ? parsed.error.message : "unknown error";
      pending.reject(new Error(`codex app-server request failed: ${message}`));
      return;
    }

    pending.resolve(parsed.result);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function normalizeBackendPayload(
  payload: RateLimitStatusPayload,
  capturedAt: number,
  source: UsageSource,
): CodexUsageReport {
  const snapshots: NormalizedRateLimitSnapshot[] = [];
  const planType = asString(payload.plan_type);
  const resetCreditsAvailable = normalizeBackendResetCredits(payload.rate_limit_reset_credits);
  const primary = normalizeBackendSnapshot("codex", undefined, payload.rate_limit, payload.credits);
  if (primary) snapshots.push(primary);

  const additional = Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : [];
  for (const item of additional) {
    const additionalLimit = assertObject(item, "additional rate limit") as BackendAdditionalRateLimit;
    const limitId = asString(additionalLimit.metered_feature) ?? asString(additionalLimit.limit_name);
    if (!limitId) continue;
    const snapshot = normalizeBackendSnapshot(
      limitId,
      asString(additionalLimit.limit_name),
      additionalLimit.rate_limit,
      undefined,
    );
    if (snapshot) snapshots.push(snapshot);
  }

  if (snapshots.length === 0) {
    throw new Error("Codex usage endpoint returned no displayable rate-limit windows.");
  }

  return { source, capturedAt, planType, resetCreditsAvailable, snapshots };
}

function normalizeBackendSnapshot(
  limitId: string,
  limitName: string | undefined,
  rateLimit: unknown,
  credits: unknown,
): NormalizedRateLimitSnapshot | undefined {
  if (rateLimit === null || rateLimit === undefined) {
    const normalizedCredits = normalizeBackendCredits(credits);
    return normalizedCredits ? { limitId, limitName, credits: normalizedCredits } : undefined;
  }

  const details = assertObject(rateLimit, "rate limit") as BackendRateLimitDetails;
  const primary = normalizeBackendWindow(details.primary_window);
  const secondary = normalizeBackendWindow(details.secondary_window);
  const normalizedCredits = normalizeBackendCredits(credits);

  if (!primary && !secondary && !normalizedCredits) return undefined;
  return { limitId, limitName, primary, secondary, credits: normalizedCredits };
}

function normalizeBackendWindow(value: unknown): NormalizedRateLimitWindow | undefined {
  if (value === null || value === undefined) return undefined;
  const window = assertObject(value, "rate-limit window") as BackendWindowSnapshot;
  const usedPercent = asNumber(window.used_percent);
  if (usedPercent === undefined) return undefined;
  const limitSeconds = asNumber(window.limit_window_seconds);
  return {
    usedPercent,
    windowMinutes: limitSeconds && limitSeconds > 0 ? Math.ceil(limitSeconds / 60) : undefined,
    resetAt: normalizeResetEpochSeconds(window),
  };
}

function normalizeBackendCredits(value: unknown): NormalizedCredits | undefined {
  if (value === null || value === undefined) return undefined;
  const credits = assertObject(value, "credits") as BackendCreditsSnapshot;
  const hasCredits = asBoolean(credits.has_credits);
  const unlimited = asBoolean(credits.unlimited);
  if (hasCredits === undefined || unlimited === undefined) return undefined;
  return { hasCredits, unlimited, balance: asString(credits.balance) };
}

function normalizeBackendResetCredits(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const resetCredits = assertObject(value, "rate-limit reset credits") as BackendResetCreditsSnapshot;
  const availableCount = asNumber(resetCredits.available_count);
  if (availableCount === undefined || availableCount < 0) return undefined;
  return Math.floor(availableCount);
}

function normalizeAppServerResponse(response: AppServerRateLimitResponse, capturedAt: number): CodexUsageReport {
  const snapshots: NormalizedRateLimitSnapshot[] = [];
  const addSnapshot = (raw: unknown, fallbackId: string) => {
    const snapshot = normalizeAppServerSnapshot(raw, fallbackId);
    if (!snapshot) return;
    const existingIndex = snapshots.findIndex((item) => normalizedUsageKey(item.limitId) === normalizedUsageKey(snapshot.limitId));
    if (existingIndex >= 0) snapshots[existingIndex] = mergeSnapshot(snapshots[existingIndex], snapshot);
    else snapshots.push(snapshot);
  };

  addSnapshot(response.rateLimits, "codex");
  if (response.rateLimitsByLimitId && typeof response.rateLimitsByLimitId === "object") {
    for (const [limitId, raw] of Object.entries(response.rateLimitsByLimitId)) {
      addSnapshot(raw, limitId);
    }
  }

  if (snapshots.length === 0) {
    throw new Error("codex app-server returned no displayable rate-limit windows.");
  }

  const planType = asAppServerPlanType(response.rateLimits);
  return {
    source: "codex-app-server",
    capturedAt,
    planType,
    resetCreditsAvailable: normalizeAppServerResetCredits(
      response.rateLimitResetCredits ?? response.rate_limit_reset_credits,
    ),
    snapshots,
  };
}

function asAppServerPlanType(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const snapshot = assertObject(raw, "app-server rate-limit snapshot") as AppServerRateLimitSnapshot;
  return asString(snapshot.planType);
}

function normalizeAppServerSnapshot(raw: unknown, fallbackId: string): NormalizedRateLimitSnapshot | undefined {
  if (raw === null || raw === undefined) return undefined;
  const snapshot = assertObject(raw, "app-server rate-limit snapshot") as AppServerRateLimitSnapshot;
  const limitId = asString(snapshot.limitId) ?? fallbackId;
  const limitName = asString(snapshot.limitName);
  const primary = normalizeAppServerWindow(snapshot.primary);
  const secondary = normalizeAppServerWindow(snapshot.secondary);
  const credits = normalizeAppServerCredits(snapshot.credits);
  if (!primary && !secondary && !credits) return undefined;
  return { limitId, limitName, primary, secondary, credits };
}

function normalizeAppServerWindow(value: unknown): NormalizedRateLimitWindow | undefined {
  if (value === null || value === undefined) return undefined;
  const window = assertObject(value, "app-server rate-limit window") as AppServerWindowSnapshot;
  const usedPercent = asNumber(window.usedPercent) ?? asNumber(window.used_percent);
  if (usedPercent === undefined) return undefined;
  return {
    usedPercent,
    windowMinutes: asNumber(window.windowDurationMins) ?? asNumber(window.window_duration_mins),
    resetAt: normalizeResetEpochSeconds(window),
  };
}

function normalizeAppServerCredits(value: unknown): NormalizedCredits | undefined {
  if (value === null || value === undefined) return undefined;
  const credits = assertObject(value, "app-server credits") as AppServerCreditsSnapshot;
  const hasCredits = asBoolean(credits.hasCredits) ?? asBoolean(credits.has_credits);
  const unlimited = asBoolean(credits.unlimited);
  if (hasCredits === undefined || unlimited === undefined) return undefined;
  return { hasCredits, unlimited, balance: asString(credits.balance) };
}

function normalizeAppServerResetCredits(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const resetCredits = assertObject(value, "app-server reset credits");
  const availableCount = asNumber(resetCredits.availableCount) ?? asNumber(resetCredits.available_count);
  if (availableCount === undefined || availableCount < 0) return undefined;
  return Math.floor(availableCount);
}

function mergeSnapshot(
  left: NormalizedRateLimitSnapshot,
  right: NormalizedRateLimitSnapshot,
): NormalizedRateLimitSnapshot {
  return {
    limitId: right.limitId || left.limitId,
    limitName: right.limitName ?? left.limitName,
    primary: right.primary ?? left.primary,
    secondary: right.secondary ?? left.secondary,
    credits: right.credits ?? left.credits,
  };
}

function normalizeResetEpochSeconds(window: Record<string, unknown>): number | undefined {
  const absolute =
    asNumber(window.reset_at) ??
    asNumber(window.resets_at) ??
    asNumber(window.resetAt) ??
    asNumber(window.resetsAt) ??
    asNumber(window.reset_time) ??
    asNumber(window.resetTime) ??
    asNumber(window.end_time) ??
    asNumber(window.endTime) ??
    asNumber(window.ends_at) ??
    asNumber(window.endsAt) ??
    asNumber(window.expires_at) ??
    asNumber(window.expiresAt) ??
    undefined;
  if (absolute !== undefined) return normalizeEpochSeconds(absolute);

  const afterSeconds = asNumber(window.reset_after_seconds) ?? asNumber(window.resetAfterSeconds);
  if (afterSeconds !== undefined && afterSeconds >= 0) return Math.floor(Date.now() / 1000 + afterSeconds);
  return undefined;
}

function normalizeEpochSeconds(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
}

function selectUsageSnapshot(report: CodexUsageReport, limitId: string): NormalizedRateLimitSnapshot | undefined {
  const normalizedLimitId = normalizedUsageKey(limitId);
  return (
    report.snapshots.find((snapshot) => normalizedUsageKey(snapshot.limitId) === normalizedLimitId) ??
    report.snapshots.find((snapshot) => normalizedUsageKey(snapshot.limitName) === normalizedLimitId) ??
    report.snapshots.find((snapshot) => normalizedUsageKey(snapshot.limitId) === CODEX_USAGE_LIMIT_ID) ??
    report.snapshots[0]
  );
}

function formatCodexUsageStatusline(report: CodexUsageReport, model?: CodexUsageModel): string {
  const snapshot = selectUsageSnapshot(report, activeUsageLimitId(model));
  if (!snapshot) return "usage unavailable";

  const parts: string[] = [];
  if (snapshot.primary) parts.push(`5h:${formatRemainingPercent(snapshot.primary)}`);
  if (snapshot.secondary) parts.push(`wk:${formatRemainingPercent(snapshot.secondary)}`);
  if (parts.length === 0 && snapshot.credits && shouldShowCredits(snapshot.credits)) parts.push(formatCredits(snapshot.credits));
  return parts.join(" ") || "usage unavailable";
}

function formatRemainingPercent(window: NormalizedRateLimitWindow): string {
  return `${(100 - clampPercent(window.usedPercent)).toFixed(0)}%`;
}

function showReport(
  ctx: ExtensionCommandContext,
  report: CodexUsageReport,
  model: CodexUsageModel | undefined,
  fromCache: boolean,
): void {
  ctx.ui.notify(
    formatCodexUsageReport(
      report,
      model,
      fromCache ? Date.now() - report.capturedAt : undefined,
      ctx.ui.theme,
    ),
    "info",
  );
}

function formatCodexUsageReport(
  report: CodexUsageReport,
  model: CodexUsageModel | undefined,
  cacheAgeMs: number | undefined,
  theme: PiTheme,
): string {
  const snapshot = selectUsageSnapshot(report, activeUsageLimitId(model));
  const lines = [theme.bold(theme.fg("accent", "OpenAI Codex Usage")), ""];

  if (report.planType) {
    lines.push(`${theme.fg("muted", "Plan:   ")} ${theme.fg("accent", formatPlanType(report.planType))}`);
  }
  lines.push(
    `${theme.fg("muted", "Source: ")} ${theme.fg("accent", report.source === "pi-auth" ? "Pi auth" : "Codex app-server")}`,
  );
  lines.push(
    `${theme.fg("muted", "Updated:")} ${formatRelativePast(report.capturedAt)}${cacheAgeMs !== undefined ? theme.fg("warning", " (cached)") : ""}`,
  );

  if (!snapshot) {
    lines.push("", theme.fg("warning", "No displayable rate-limit windows were returned."));
    return lines.join("\n");
  }

  const label = snapshot.limitName ?? snapshot.limitId;
  if (normalizedUsageKey(label) !== CODEX_USAGE_LIMIT_ID) {
    lines.push(`${theme.fg("muted", "Bucket: ")} ${theme.fg("accent", label)}`);
  }

  lines.push("");
  if (snapshot.primary) lines.push(formatWindowLine("5h", snapshot.primary, theme));
  if (snapshot.secondary) lines.push(formatWindowLine("Weekly", snapshot.secondary, theme));
  if (!snapshot.primary && !snapshot.secondary) {
    lines.push(theme.fg("warning", "Limits unavailable for this account."));
  }
  if (snapshot.credits && shouldShowCredits(snapshot.credits)) {
    lines.push(`${theme.fg("muted", "Credits:")} ${theme.fg("accent", formatCredits(snapshot.credits))}`);
  }
  if (report.resetCreditsAvailable !== undefined) {
    const resetCredits = `${report.resetCreditsAvailable} available`;
    lines.push(`${theme.fg("muted", "Resets: ")} ${theme.fg("accent", resetCredits)}`);
  }

  return lines.join("\n");
}

function formatWindowLine(label: string, window: NormalizedRateLimitWindow, theme: PiTheme): string {
  const remainingValue = 100 - clampPercent(window.usedPercent);
  const remaining = `${remainingValue.toFixed(0)}%`.padStart(4);
  const remainingColor = remainingValue > 50 ? "success" : remainingValue > 20 ? "warning" : "error";
  const reset = window.resetAt ? `, resets in ${formatDuration(window.resetAt * 1000 - Date.now())}` : ", reset unavailable";
  return `${theme.fg("muted", label.padEnd(7))} ${theme.fg(remainingColor, remaining)} ${theme.fg("muted", "left")}${theme.fg("muted", reset)}`;
}

function shouldShowCredits(credits: NormalizedCredits): boolean {
  return credits.hasCredits;
}

function formatCredits(credits: NormalizedCredits): string {
  if (credits.unlimited) return "unlimited credits";
  const balance = credits.balance?.trim();
  if (!balance) return "credits available";
  return `${formatNumber(Number(balance), balance)} credits`;
}

function formatPlanType(planType: string): string {
  const key = planType
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  if (key === "pro_lite" || key === "prolite") return "Pro Lite";
  if (key === "team" || key === "self_serve_business_usage_based" || key === "business") return "Business";
  if (key === "enterprise_cbp_usage_based") return "Enterprise";

  const normalized = planType
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!normalized) return planType;
  return normalized
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function formatRelativePast(epochMs: number): string {
  const duration = formatDuration(Date.now() - epochMs);
  return duration === "0s" ? "just now" : `${duration} ago`;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const remainder = minutes % 60;
    return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
  }
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.round((minutes - days * 24 * 60) / 60);
  return hours ? `${days}d ${hours}h` : `${days}d`;
}

function formatNumber(value: number, fallback: string): string {
  if (!Number.isFinite(value)) return fallback;
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);
}

function formatQueryErrors(errors: UsageQueryError[]): string {
  const lines = ["Unable to read Codex usage."];
  for (const error of errors) {
    const source = error.source === "pi-auth" ? "Pi auth direct" : "Codex app-server fallback";
    lines.push(`- ${source}: ${error.message}`);
  }
  lines.push("");
  lines.push(
    "Tip: use a Pi OpenAI Codex model or run /login for OpenAI ChatGPT Plus/Pro. If Pi auth is unavailable, install Codex CLI and run codex login for the fallback.",
  );
  return lines.join("\n");
}

function normalizedUsageKey(value: string | undefined): string | undefined {
  const key = value
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return key || undefined;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function parseJsonObject(text: string, description: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${description} was not valid JSON: ${errorMessage(error)}`);
  }
  return assertObject(parsed, description);
}

function assertObject(value: unknown, description: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} was not an object.`);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === name.toLowerCase());
}

function redactErrorBody(body: string): string {
  return truncateEnd(
    body
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
      .replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"<redacted>"')
      .trim(),
    MAX_ERROR_BODY_CHARS,
  );
}

function truncateEnd(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
