import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { resolve, relative, isAbsolute, sep } from "node:path";

// --- shared helpers ---

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatCwd(cwd: string, home: string | undefined): string {
  if (!home) return cwd;

  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

  if (!isInsideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

function cacheHitRate(usage: {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
} | undefined): number | undefined {
  if (!usage) return undefined;

  const promptTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  return promptTokens > 0 ? ((usage.cacheRead ?? 0) / promptTokens) * 100 : undefined;
}

type CacheRateColor = "muted" | "warning" | "error";

function cacheRateColor(rate: number): CacheRateColor {
  if (rate >= 80) return "muted";
  if (rate >= 50) return "warning";
  return "error";
}

interface UsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  lastUsage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
  } | null;
  latestCacheHitRate: number | undefined;
  sessionCacheHitRate: number | undefined;
}

function sumUsage(branch: any[]): UsageSummary {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let cost = 0;
  let costInput = 0;
  let costOutput = 0;
  let costCacheRead = 0;
  let costCacheWrite = 0;
  let lastUsage: UsageSummary["lastUsage"] = null;
  let latestCacheHitRate: number | undefined = undefined;

  for (const entry of branch) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      const m = entry.message as AssistantMessage;
      const u = m.usage || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
      
      const inVal = u.input ?? 0;
      const outVal = u.output ?? 0;
      const cRead = u.cacheRead ?? 0;
      const cWrite = u.cacheWrite ?? 0;
      const cCost = u.cost?.total ?? 0;
      const cCostInput = u.cost?.input ?? 0;
      const cCostOutput = u.cost?.output ?? 0;
      const cCostCacheRead = u.cost?.cacheRead ?? 0;
      const cCostCacheWrite = u.cost?.cacheWrite ?? 0;

      input += inVal;
      output += outVal;
      cacheRead += cRead;
      cacheWrite += cWrite;
      cost += cCost;
      costInput += cCostInput;
      costOutput += cCostOutput;
      costCacheRead += cCostCacheRead;
      costCacheWrite += cCostCacheWrite;

      lastUsage = {
        input: inVal,
        output: outVal,
        cacheRead: cRead,
        cacheWrite: cWrite,
        cost: cCost,
      };

      const requestCacheHitRate = cacheHitRate({ input: inVal, cacheRead: cRead, cacheWrite: cWrite });
      if (requestCacheHitRate !== undefined) {
        latestCacheHitRate = requestCacheHitRate;
      }
    }
  }

  const sessionCacheHitRate = cacheHitRate({ input, cacheRead, cacheWrite });

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cost,
    costInput,
    costOutput,
    costCacheRead,
    costCacheWrite,
    lastUsage,
    latestCacheHitRate,
    sessionCacheHitRate,
  };
}

function getMessageContentText(content: any): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    let text = "";
    for (const block of content) {
      if (block && typeof block === "object") {
        if (block.type === "text" && typeof block.text === "string") {
          text += block.text;
        }
      }
    }
    return text;
  }
  return "";
}

function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

function stylePercentValues(
  text: string,
  style: (color: "dim" | "muted", value: string) => string,
): string {
  const percentPattern = /\d+(?:\.\d+)?%/g;
  let result = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = percentPattern.exec(text)) !== null) {
    result += style("dim", text.slice(lastIndex, match.index));
    result += style("muted", match[0]);
    lastIndex = match.index + match[0].length;
  }

  return result + style("dim", text.slice(lastIndex));
}

interface FooterLineLayoutOptions {
  left: string;
  statuses: string[];
  right: string;
  width: number;
  separator: string;
  ellipsis: string;
  minPadding?: number;
}

/**
 * Keep built-in stats and the model visible, then use the remaining bottom-left
 * space for extension statuses. Statuses are the first thing truncated or
 * omitted as the terminal narrows.
 */
export function layoutFooterLine({
  left,
  statuses,
  right,
  width,
  separator,
  ellipsis,
  minPadding = 2,
}: FooterLineLayoutOptions): string {
  if (width <= 0) return "";

  const renderedLeft = truncateToWidth(left, width, ellipsis);
  const leftWidth = visibleWidth(renderedLeft);
  if (leftWidth >= width || !right) {
    if (leftWidth >= width || statuses.length === 0) return renderedLeft;

    const statusBudget = width - leftWidth - visibleWidth(separator);
    if (statusBudget <= 0) return renderedLeft;
    const renderedStatuses = truncateToWidth(statuses.join(" "), statusBudget, ellipsis);
    return renderedLeft + separator + renderedStatuses;
  }

  const rightWidth = visibleWidth(right);
  const fullRightFits = leftWidth + minPadding + rightWidth <= width;

  // Extension statuses are lower priority than both built-in portions. Only
  // add them when the complete right side fits; otherwise preserve the old
  // behavior of truncating the model into whatever space remains.
  if (!fullRightFits) {
    const availableForRight = width - leftWidth - minPadding;
    if (availableForRight <= 0) return renderedLeft;

    const renderedRight = truncateToWidth(right, availableForRight, "");
    const padding = " ".repeat(Math.max(0, width - leftWidth - visibleWidth(renderedRight)));
    return renderedLeft + padding + renderedRight;
  }

  let renderedStatuses = "";
  if (statuses.length > 0) {
    const statusBudget = width - leftWidth - minPadding - rightWidth - visibleWidth(separator);
    if (statusBudget > 0) {
      const statusText = truncateToWidth(statuses.join(" "), statusBudget, ellipsis);
      if (visibleWidth(statusText) > 0) renderedStatuses = separator + statusText;
    }
  }

  const padding = " ".repeat(
    Math.max(0, width - leftWidth - visibleWidth(renderedStatuses) - rightWidth),
  );
  return renderedLeft + renderedStatuses + padding + right;
}

function estimateContextTokens(pi: ExtensionAPI, ctx: ExtensionContext): number {
  let systemPrompt = "";
  try {
    systemPrompt = ctx.getSystemPrompt() ?? "";
  } catch {
    // Ignore
  }

  let activeToolsCharCount = 0;
  try {
    const activeTools = pi.getActiveTools() ?? [];
    const allTools = pi.getAllTools() ?? [];
    for (const toolName of activeTools) {
      const tool = allTools.find(t => t.name === toolName);
      if (tool) {
        activeToolsCharCount += JSON.stringify(tool.parameters || {}).length;
      }
    }
  } catch {
    // Ignore
  }

  let branchText = "";
  try {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message) {
        branchText += getMessageContentText(entry.message.content);
      }
    }
  } catch {
    // Ignore
  }

  const totalChars = systemPrompt.length + activeToolsCharCount + branchText.length;
  return Math.ceil(totalChars / 4);
}

function resolveContextTokens(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  usage = ctx.getContextUsage(),
): { value: number; estimated: boolean } {
  if (usage && usage.tokens !== null) {
    return { value: usage.tokens, estimated: false };
  }
  return { value: estimateContextTokens(pi, ctx), estimated: true };
}

// --- GitHub PR Cache ---

interface PrInfo {
  number: number;
  title: string;
  url: string;
  state: string; // "OPEN", "MERGED", "CLOSED"
  isDraft: boolean;
}

type PrColor = "success" | "muted" | "accent" | "error";

function prStatusColor(pr: PrInfo): PrColor {
  if (pr.state === "MERGED") return "accent";
  if (pr.state === "CLOSED") return "error";
  if (pr.isDraft) return "muted";
  return "success";
}

async function fetchPr(pi: ExtensionAPI, cwd: string): Promise<PrInfo | null> {
  try {
    const res = await pi.exec(
      "gh",
      ["pr", "view", "--json", "number,title,url,state,isDraft"],
      { cwd }
    );
    if (res.code === 0 && res.stdout.trim()) {
      return JSON.parse(res.stdout);
    }
  } catch {
    // Silently ignore (no PR / gh missing / not authed / no remote)
  }
  return null;
}

// Cache keyed by cwd + branch so sessions in different repos on the
// same branch name (e.g. "main") never collide.
function prCacheKey(cwd: string, branch: string): string {
  return `${cwd}\u0000${branch}`;
}

let prCache: { key: string; pr: PrInfo | null } | null = null;
let prFetchInFlight = false;

// --- Timing / Performance State ---

interface PerfState {
  startMs: number;
  firstTokenMs: number;
  deltaChars: number;
  lastTokS: number | undefined;
  lastTtftMs: number | undefined;
  lastOutput: number | undefined;
  lastElapsedMs: number | undefined;
}

const perf: PerfState = {
  startMs: 0,
  firstTokenMs: 0,
  deltaChars: 0,
  lastTokS: undefined,
  lastTtftMs: undefined,
  lastOutput: undefined,
  lastElapsedMs: undefined,
};

let lastRenderMs = 0;
const THROTTLE_MS = 250;
let tuiRef: { requestRender(): void } | null = null;

async function refreshPr(
  pi: ExtensionAPI,
  cwd: string,
  branch: string,
  tui: { requestRender(): void },
) {
  if (prFetchInFlight) return;
  prFetchInFlight = true;
  try {
    const pr = await fetchPr(pi, cwd);
    prCache = { key: prCacheKey(cwd, branch), pr };
  } finally {
    prFetchInFlight = false;
    try {
      tui.requestRender();
    } catch {
      // Ignore if TUI disposed
    }
  }
}

export default function (pi: ExtensionAPI) {
  // Keep the last observed request ratio visible when an aborted request is not
  // persisted as a finalized assistant message.
  let lastRequestCacheHitRate: number | undefined;

  // Footer: install on every session start (startup/reload/new/resume/fork).
  pi.on("session_start", (_e, ctx) => {
    lastRequestCacheHitRate = sumUsage(ctx.sessionManager.getBranch()).latestCacheHitRate;
    if (!ctx.hasUI) return; // no-op in print/json modes
    ctx.ui.setFooter((tui, theme, footerData) => {
      tuiRef = tui;
      const unsub = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose() {
          unsub();
          if (tuiRef === tui) {
            tuiRef = null;
          }
        },
        invalidate() {},
        render(width) {
          // Line 1: pwd (branch) • session-name (highly condensed & styled)
          const home = process.env.HOME || process.env.USERPROFILE;
          const cwdStr = formatCwd(ctx.sessionManager.getCwd(), home);
          const cwdPart = theme.fg("dim", cwdStr);

          let branchPart = "";
          const branch = footerData.getGitBranch();
          if (branch) {
            const cwd = ctx.sessionManager.getCwd();
            const key = prCacheKey(cwd, branch);
            if ((!prCache || prCache.key !== key) && !prFetchInFlight) {
              void refreshPr(pi, cwd, branch, tui);
            }
            const pr = (prCache && prCache.key === key) ? prCache.pr : null;
            if (pr) {
              const prStyled = theme.fg(prStatusColor(pr), `#${pr.number}`);
              branchPart = theme.fg("dim", ` (${branch} `) + prStyled + theme.fg("dim", ")");
            } else {
              branchPart = theme.fg("dim", ` (${branch})`);
            }
          }

          const sessionName = ctx.sessionManager.getSessionName();
          const sessionPart = sessionName ? theme.fg("dim", ` • ${sessionName}`) : "";

          const extensionStatuses = footerData.getExtensionStatuses();
          const piSyncActivityStatus = sanitizeStatusText(
            (extensionStatuses?.get("pisync-activity") as string | undefined) ?? "",
          );
          const piSyncDriftStatus = sanitizeStatusText(
            (extensionStatuses?.get("pisync") as string | undefined) ?? "",
          );
          const piSyncStatus = piSyncActivityStatus || piSyncDriftStatus;
          const line1Left = cwdPart + branchPart + sessionPart;
          const line1Right = piSyncStatus ? theme.fg("dim", `pi-sync ${piSyncStatus}`) : "";
          const line1LeftWidth = visibleWidth(line1Left);
          const line1RightWidth = visibleWidth(line1Right);
          const pwdLine = line1Right && line1LeftWidth + 2 + line1RightWidth <= width
            ? line1Left + " ".repeat(width - line1LeftWidth - line1RightWidth) + line1Right
            : truncateToWidth(line1Left, width, theme.fg("dim", "..."));

          // Line 2: left and right
          const usage = ctx.getContextUsage();
          const { value, estimated } = resolveContextTokens(pi, ctx, usage);
          const ctxStr = estimated ? "~" + formatTokens(value) : formatTokens(value);
          const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
          const windowStr = formatTokens(contextWindow);

          const usageSummary = sumUsage(ctx.sessionManager.getBranch());
          const cost = usageSummary.cost;
          const usingSub = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;

          const codexUsageStatus = sanitizeStatusText(
            (extensionStatuses?.get("codex-usage") as string | undefined) ?? "",
          );

          const contextTokenPart = estimated
            ? theme.fg("dim", "~") + theme.fg("muted", formatTokens(value))
            : theme.fg("muted", ctxStr);
          let leftStr = contextTokenPart + theme.fg("dim", "/") + theme.fg("muted", windowStr);
          const latestCacheHitRate = usageSummary.latestCacheHitRate ?? lastRequestCacheHitRate;
          if (latestCacheHitRate !== undefined) {
            leftStr += theme.fg("dim", "  C:");
            leftStr += theme.fg(cacheRateColor(latestCacheHitRate), `${latestCacheHitRate.toFixed(0)}%`);
          }
          if (usageSummary.sessionCacheHitRate !== undefined) {
            const sessionRate = usageSummary.sessionCacheHitRate;
            leftStr += theme.fg("dim", " Σ:");
            leftStr += theme.fg(cacheRateColor(sessionRate), `${sessionRate.toFixed(0)}%`);
          }
          if (!usingSub) {
            leftStr += theme.fg("dim", "  $");
            leftStr += theme.fg("muted", cost.toFixed(2));
          }
          if (codexUsageStatus) {
            leftStr += theme.fg("dim", "  ");
            leftStr += stylePercentValues(codexUsageStatus, (color, value) => theme.fg(color, value));
          }
          if (perf.lastTokS !== undefined && perf.lastTokS > 0) {
            leftStr += theme.fg("dim", "  ");
            leftStr += theme.fg("muted", perf.lastTokS.toFixed(0));
            leftStr += theme.fg("dim", " tok/s");
          }

          const model = ctx.model;
          let rightStr = "no-model";
          if (model) {
            const modelId = model.id;
            const provider = model.provider;
            const reasoning = model.reasoning;
            const thinking = pi.getThinkingLevel();
            rightStr = reasoning
              ? `${modelId} • ${thinking === "off" ? "thinking off" : thinking} • ${provider}`
              : `${modelId} • ${provider}`;
          }

          // Other extensions share the bottom-left area with the built-in
          // stats. Keep their own styling, but clearly separate them from the
          // built-in portion. Special statuses consumed above are excluded.
          const sortedStatuses = Array.from(extensionStatuses.entries())
            .filter(
              ([key]) =>
                key !== "codex-usage" &&
                key !== "pisync" &&
                key !== "pisync-activity",
            )
            .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
            .map(([, text]) => sanitizeStatusText(text))
            .filter(Boolean);

          const statsLine = layoutFooterLine({
            left: leftStr,
            statuses: sortedStatuses,
            right: theme.fg("dim", rightStr),
            width,
            separator: theme.fg("dim", " │ "),
            ellipsis: theme.fg("dim", "..."),
          });

          return [pwdLine, statsLine];
        },
      };
    });
  });

  pi.on("before_provider_request", async (_event, _ctx) => {
    perf.startMs = Date.now();
    perf.firstTokenMs = 0;
    perf.deltaChars = 0;
  });

  pi.on("message_start", async (event, _ctx) => {
    if (event.message.role !== "assistant") return;
    if (perf.startMs === 0) {
      perf.startMs = Date.now();
    }
    perf.firstTokenMs = 0;
    perf.deltaChars = 0;
  });

  pi.on("message_update", async (event, _ctx) => {
    if (event.message.role !== "assistant") return;

    const observedCacheHitRate = cacheHitRate(event.message.usage);
    if (observedCacheHitRate !== undefined) {
      lastRequestCacheHitRate = observedCacheHitRate;
    }

    // Record first token (thinking or text delta)
    const assistantEvent = event.assistantMessageEvent;
    if (assistantEvent) {
      if (assistantEvent.type === "text_delta" || assistantEvent.type === "thinking_delta") {
        if (perf.firstTokenMs === 0) {
          perf.firstTokenMs = Date.now();
        }
        // Safely access delta since both types have it
        const delta = (assistantEvent as any).delta;
        if (typeof delta === "string") {
          perf.deltaChars += delta.length;
        }
      }
    }

    // Live tok/s calculation
    const now = Date.now();
    if (now - lastRenderMs > THROTTLE_MS) {
      lastRenderMs = now;
      const streamStart = perf.firstTokenMs > 0 ? perf.firstTokenMs : perf.startMs;
      const elapsedSec = (now - streamStart) / 1000;
      if (elapsedSec > 0.1) {
        const liveOut = event.message.usage?.output ?? 0;
        const tokens = liveOut > 0 ? liveOut : Math.ceil(perf.deltaChars / 4);
        perf.lastTokS = tokens / elapsedSec;
      }
      if (tuiRef) {
        try {
          tuiRef.requestRender();
        } catch {
          // Ignore
        }
      }
    }
  });

  pi.on("message_end", async (event, _ctx) => {
    if (event.message.role !== "assistant") return;

    const observedCacheHitRate = cacheHitRate(event.message.usage);
    if (observedCacheHitRate !== undefined) {
      lastRequestCacheHitRate = observedCacheHitRate;
    }

    const now = Date.now();
    const elapsedMs = now - perf.startMs;
    perf.lastElapsedMs = elapsedMs;

    const streamStart = perf.firstTokenMs > 0 ? perf.firstTokenMs : perf.startMs;
    const generationElapsedMs = now - streamStart;

    const u = event.message.usage;
    const outputTokens = u?.output ?? 0;
    perf.lastOutput = outputTokens;

    if (generationElapsedMs > 100) {
      perf.lastTokS = outputTokens / (generationElapsedMs / 1000);
    } else {
      perf.lastTokS = undefined;
    }

    if (perf.firstTokenMs > 0 && perf.firstTokenMs >= perf.startMs) {
      perf.lastTtftMs = perf.firstTokenMs - perf.startMs;
    } else {
      perf.lastTtftMs = undefined;
    }

    // Clear startMs so fallback logic triggers next turn
    perf.startMs = 0;

    if (tuiRef) {
      try {
        tuiRef.requestRender();
      } catch {
        // Ignore
      }
    }
  });

  // /status command: registered once, global.
  pi.registerCommand("status", {
    description: "Show detailed session token + cost + model status",
    handler: async (_args, ctx) => {
      const branch = ctx.sessionManager.getBranch();
      const assistantMessageExists = branch.some(entry => entry.type === "message" && entry.message.role === "assistant");
      if (!ctx.model || !assistantMessageExists) {
        ctx.ui.notify("No data yet, send a message first.", "info");
        return;
      }

      const header = ctx.sessionManager.getHeader();
      const summary = sumUsage(branch);
      const theme = ctx.ui.theme;

      // Best-effort git branch and gh PR commands
      let gitBranch = "—";
      try {
        const res = await pi.exec("git", ["branch", "--show-current"], { cwd: ctx.sessionManager.getCwd() });
        if (res.code === 0 && res.stdout.trim()) {
          gitBranch = res.stdout.trim();
        }
      } catch {
        // Ignore
      }

      let prInfoStr: string | null = null;
      const pr = await fetchPr(pi, ctx.sessionManager.getCwd());
      if (pr) {
        const stateStr = pr.isDraft && pr.state === "OPEN" ? "DRAFT" : pr.state;
        const prefix = theme.fg(prStatusColor(pr), `#${pr.number} [${stateStr}]`);
        prInfoStr = `${prefix} (${pr.title})\n                 ${theme.fg("muted", pr.url)}`;
      }

      const lines: string[] = [];

      // Session
      lines.push(theme.bold(theme.fg("accent", "Session")));
      const sessionName = ctx.sessionManager.getSessionName();
      if (sessionName) {
        lines.push(`${theme.fg("muted", "  Name:        ")} ${sessionName}`);
      }
      const sessionId = ctx.sessionManager.getSessionId();
      if (sessionId) {
        lines.push(`${theme.fg("muted", "  UUID:        ")} ${sessionId}`);
      }
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (sessionFile) {
        lines.push(`${theme.fg("muted", "  File:        ")} ${sessionFile}`);
      }
      lines.push(`${theme.fg("muted", "  CWD:         ")} ${ctx.sessionManager.getCwd() || "—"}`);
      lines.push(`${theme.fg("muted", "  Created:     ")} ${header?.timestamp ? new Date(header.timestamp).toLocaleString() : "—"}`);
      if (header?.parentSession) {
        lines.push(`${theme.fg("muted", "  Parent:      ")} ${header.parentSession}`);
      }
      lines.push(`${theme.fg("muted", "  Git Branch:  ")} ${gitBranch !== "—" ? theme.fg("accent", gitBranch) : "—"}`);
      if (prInfoStr) {
        lines.push(`${theme.fg("muted", "  GitHub PR:   ")} ${prInfoStr}`);
      }

      // Model
      lines.push("\n" + theme.bold(theme.fg("accent", "Model")));
      lines.push(`${theme.fg("muted", "  ID:             ")} ${ctx.model.id}`);
      lines.push(`${theme.fg("muted", "  Provider:       ")} ${ctx.model.provider}`);
      lines.push(`${theme.fg("muted", "  Reasoning:      ")} ${ctx.model.reasoning ? "yes" : "no"}`);
      lines.push(`${theme.fg("muted", "  Thinking Level: ")} ${pi.getThinkingLevel() || "off"}`);
      lines.push(`${theme.fg("muted", "  Context Window: ")} ${formatTokens(ctx.model.contextWindow)}`);

      // Context
      lines.push("\n" + theme.bold(theme.fg("accent", "Context")));
      const usage = ctx.getContextUsage();
      const { value: ctxTokens, estimated } = resolveContextTokens(pi, ctx, usage);
      const windowVal = usage?.contextWindow ?? ctx.model.contextWindow ?? 0;
      const percentVal = usage?.percent ?? (windowVal > 0 ? (ctxTokens / windowVal) * 100 : 0);

      let percentStyled = `${percentVal.toFixed(1)}%`;
      if (percentVal > 90) {
        percentStyled = theme.fg("error", percentStyled);
      } else if (percentVal > 70) {
        percentStyled = theme.fg("warning", percentStyled);
      } else {
        percentStyled = theme.fg("success", percentStyled);
      }

      const ctxStr = estimated ? `~${formatTokens(ctxTokens)}` : formatTokens(ctxTokens);
      const ctxStrStyled = estimated ? theme.fg("warning", ctxStr) : ctxStr;
      const windowStr = formatTokens(windowVal);
      lines.push(`${theme.fg("muted", "  Tokens:      ")} ${ctxStrStyled} / ${windowStr}  (${percentStyled})${estimated ? theme.fg("warning", " (estimated)") : ""}`);

      // Last request breakdown (folded into Context)
      if (summary.lastUsage) {
        lines.push(`${theme.fg("muted", "  Last req:    ")} ↑${summary.lastUsage.input.toLocaleString()}  ↓${summary.lastUsage.output.toLocaleString()}  R${summary.lastUsage.cacheRead.toLocaleString()}  W${summary.lastUsage.cacheWrite.toLocaleString()}`);
        const lastCacheHitRate = summary.latestCacheHitRate;
        if (lastCacheHitRate !== undefined) {
          const rateStr = `${lastCacheHitRate.toFixed(1)}%`;
          const styled = theme.fg(cacheRateColor(lastCacheHitRate), rateStr);
          lines.push(`${theme.fg("muted", "  Cache Hit:   ")} ${styled}`);
        }
      }

      // Token totals (cumulative session)
      lines.push("\n" + theme.bold(theme.fg("accent", "Token totals (cumulative session)")));
      lines.push(`${theme.fg("muted", "  Input:       ")} ${summary.input.toLocaleString()}`);
      lines.push(`${theme.fg("muted", "  Output:      ")} ${summary.output.toLocaleString()}`);
      lines.push(`${theme.fg("muted", "  Cache Read:  ")} ${summary.cacheRead.toLocaleString()}`);
      lines.push(`${theme.fg("muted", "  Cache Write: ")} ${summary.cacheWrite.toLocaleString()}`);

      // Performance (last request)
      lines.push("\n" + theme.bold(theme.fg("accent", "Performance (last request)")));
      const lastTokS = perf.lastTokS;
      const lastTtft = perf.lastTtftMs;
      const lastElapsed = perf.lastElapsedMs;
      const lastOut = perf.lastOutput;

      if (lastTokS !== undefined || lastTtft !== undefined || lastElapsed !== undefined || lastOut !== undefined) {
        if (lastTokS !== undefined) {
          lines.push(`${theme.fg("muted", "  Speed:       ")} ${lastTokS.toFixed(1)} tok/s`);
        }
        if (lastTtft !== undefined) {
          lines.push(`${theme.fg("muted", "  TTFT:        ")} ${(lastTtft / 1000).toFixed(2)}s (${lastTtft.toLocaleString()} ms)`);
        }
        if (lastOut !== undefined) {
          lines.push(`${theme.fg("muted", "  Output:      ")} ${lastOut.toLocaleString()} tokens`);
        }
        if (lastElapsed !== undefined) {
          lines.push(`${theme.fg("muted", "  Elapsed:     ")} ${(lastElapsed / 1000).toFixed(2)}s`);
        }
      } else {
        lines.push(`  ${theme.fg("muted", "No performance metrics captured yet.")}`);
      }

      // Pricing
      lines.push("\n" + theme.bold(theme.fg("accent", "Pricing (rates per million)")));
      const rates = ctx.model.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      
      const formatPricingLine = (label: string, tok: number, rate: number, cost: number) => {
        const tokStr = tok.toLocaleString().padEnd(12);
        const rateStr = `$${rate.toFixed(2)}/M`.padEnd(9);
        const costStr = theme.fg("success", `$${cost.toFixed(3)}`);
        return `${theme.fg("muted", label)} ${tokStr} @ ${rateStr} = ${costStr}`;
      };

      lines.push(formatPricingLine("  input      :", summary.input, rates.input, summary.costInput));
      lines.push(formatPricingLine("  output     :", summary.output, rates.output, summary.costOutput));
      lines.push(formatPricingLine("  cacheRead  :", summary.cacheRead, rates.cacheRead, summary.costCacheRead));
      lines.push(formatPricingLine("  cacheWrite :", summary.cacheWrite, rates.cacheWrite, summary.costCacheWrite));
      lines.push(`${theme.fg("muted", "  TOTAL      :")} ${theme.bold(theme.fg("success", `$${summary.cost.toFixed(3)}`))}`);

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
