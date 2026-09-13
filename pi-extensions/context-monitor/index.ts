/**
 * context-monitor — token/context budget indicator for pi.
 *
 * - Footer badge: `ctx: 32k/128k 25%`, color-coded.
 * - `/tokens`: exact session token/cost totals + estimated window composition.
 * - Overflow surfacing: visible state when a turn fails on context overflow.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

function money(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  return `$${v >= 0.01 ? v.toFixed(2) : v.toFixed(4)}`;
}

/** Rough token estimate: ~4 chars per token. Used only for composition breakdown. */
function estimateTokens(text: string): number {
  return Math.max(0, Math.round(text.length / 4));
}

// ---------------------------------------------------------------------------
// Entry traversal
// ---------------------------------------------------------------------------

type UsageLike = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
};

/** LLM usage carried by an entry, when present. */
function entryUsage(entry: any): UsageLike | undefined {
  if (entry?.type === "message") {
    const m = entry.message;
    if (m?.role === "assistant") return m.usage;
    if (m?.role === "toolResult") return m.usage; // nested LLM work, optional
    return undefined;
  }
  if (entry?.type === "compaction" || entry?.type === "branch_summary") return entry.usage;
  return undefined;
}

/** Human text for a session entry, used for token estimation. */
function entryText(entry: any): string {
  if (!entry) return "";
  if (entry.type === "message") {
    const m = entry.message;
    if (!m) return "";
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .map((b: any) => {
          if (!b) return "";
          if (b.type === "text") return b.text ?? "";
          if (b.type === "thinking") return b.thinking ?? "";
          if (b.type === "toolCall") return `${b.name ?? ""} ${JSON.stringify(b.arguments ?? {})}`;
          if (b.type === "image") return "[image]";
          return "";
        })
        .join("\n");
    }
    if (m.role === "bashExecution") return m.output ?? "";
    return "";
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") return entry.summary ?? "";
  return "";
}

function entryLabel(entry: any): string {
  if (!entry) return "?";
  if (entry.type === "message") {
    const m = entry.message;
    switch (m?.role) {
      case "assistant":
        return "assistant";
      case "user":
        return "user";
      case "toolResult":
        return `tool result (${m.toolName ?? "?"})`;
      case "bashExecution":
        return "bash execution";
      case "custom":
        return `custom (${m.customType ?? "?"})`;
      case "compactionSummary":
        return "compaction summary";
      case "branchSummary":
        return "branch summary";
      default:
        return m?.role ?? "message";
    }
  }
  if (entry.type === "compaction") return "compaction summary";
  if (entry.type === "branch_summary") return "branch summary";
  return entry.type;
}

// ---------------------------------------------------------------------------
// Report building
// ---------------------------------------------------------------------------

function buildReport(ctx: ExtensionContext): string {
  const usage = ctx.getContextUsage();
  const window = usage?.contextWindow ?? (ctx.model as any)?.contextWindow ?? 0;
  const tokens = usage?.tokens ?? null;
  const pct = usage?.percent ?? (window ? Math.round(((tokens ?? 0) / window) * 100) : null);

  // Exact totals over the current branch (assistant + nested tool + summary LLM work).
  const totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costInput: 0,
    costOutput: 0,
    costCacheRead: 0,
    costCacheWrite: 0,
    costTotal: 0,
  };
  for (const entry of ctx.sessionManager.getBranch() as any[]) {
    const u = entryUsage(entry);
    if (!u) continue;
    totals.input += u.input ?? 0;
    totals.output += u.output ?? 0;
    totals.cacheRead += u.cacheRead ?? 0;
    totals.cacheWrite += u.cacheWrite ?? 0;
    totals.totalTokens += u.totalTokens ?? 0;
    totals.costInput += u.cost?.input ?? 0;
    totals.costOutput += u.cost?.output ?? 0;
    totals.costCacheRead += u.cost?.cacheRead ?? 0;
    totals.costCacheWrite += u.cost?.cacheWrite ?? 0;
    totals.costTotal += u.cost?.total ?? 0;
  }
  const chargedInput = totals.input + totals.cacheRead;
  const hitRatio = chargedInput > 0 ? totals.cacheRead / chargedInput : 0;

  // Estimated composition of the current context window (post-compaction).
  const sysTokens = estimateTokens(ctx.getSystemPrompt());
  const rows = (ctx.sessionManager.buildContextEntries() as any[])
    .map((e) => ({ label: entryLabel(e), tokens: estimateTokens(entryText(e)) }))
    .filter((r) => r.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
  const estTotal = sysTokens + rows.reduce((s, r) => s + r.tokens, 0);

  const model = ctx.model as any;
  const modelLabel = model
    ? model.name && model.name !== model.id
      ? `${model.name} (${model.id})`
      : model.id
    : "unknown";

  const out: string[] = [];
  out.push("Context Monitor");
  out.push("");
  out.push(`Window   ${tokens == null ? "~" : fmtTokens(tokens)} / ${fmtTokens(window)}  ${pct == null ? "" : `${Math.round(pct)}%`}`);
  out.push(`Model    ${modelLabel}`);
  out.push("");
  out.push("Session totals (exact, current branch)");
  out.push(`  input       ${fmtTokens(totals.input)}`);
  out.push(`  output      ${fmtTokens(totals.output)}`);
  out.push(`  cache read  ${fmtTokens(totals.cacheRead)}  (hit ${(hitRatio * 100).toFixed(0)}%)`);
  out.push(`  cache write ${fmtTokens(totals.cacheWrite)}`);
  out.push(`  cost        ${money(totals.costTotal)}`);
  out.push("");
  out.push("Window composition (estimated, ~4 chars/token)");
  out.push(`  system prompt  ~${fmtTokens(sysTokens)}`);
  for (const r of rows.slice(0, 8)) out.push(`  ${r.label}  ~${fmtTokens(r.tokens)}`);
  if (rows.length > 8) out.push(`  … +${rows.length - 8} more`);
  out.push(`  total (est)    ~${fmtTokens(estTotal)}`);
  out.push("");
  out.push("Note: composition is estimated; image tokens are undercounted.");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function contextMonitor(pi: ExtensionAPI) {
  pi.registerFlag("context-warn-pct", {
    type: "string",
    default: "60",
    description: "Badge turns yellow at this context fill percentage.",
  });
  pi.registerFlag("context-danger-pct", {
    type: "string",
    default: "85",
    description: "Badge turns red at this context fill percentage.",
  });

  const warnPct = () => clamp(Number.parseInt(String(pi.getFlag("--context-warn-pct") ?? "60"), 10) || 60, 0, 100);
  const dangerPct = () => clamp(Number.parseInt(String(pi.getFlag("--context-danger-pct") ?? "85"), 10) || 85, 0, 100);

  // Last known snapshot, so the badge can show `~` during unknown states (e.g.
  // right after compaction, before the next LLM response).
  let last: { tokens: number; pct: number } | null = null;

  function refresh(ctx: ExtensionContext) {
    if (ctx.mode !== "tui") return;
    const theme = ctx.ui.theme;
    const u = ctx.getContextUsage();
    if (!u) {
      ctx.ui.setStatus("context", undefined);
      return;
    }
    if (u.tokens == null) {
      if (last) {
        ctx.ui.setStatus(
          "context",
          theme.fg("dim", `ctx: ~${fmtTokens(last.tokens)}/${fmtTokens(u.contextWindow)} ${last.pct}%`),
        );
      } else {
        ctx.ui.setStatus("context", theme.fg("dim", "ctx: ~"));
      }
      return;
    }
    const pct = Math.round(u.percent ?? (u.contextWindow ? (u.tokens / u.contextWindow) * 100 : 0));
    last = { tokens: u.tokens, pct };
    const color = pct >= dangerPct() ? "error" : pct >= warnPct() ? "warning" : "success";
    ctx.ui.setStatus("context", theme.fg(color, `ctx: ${fmtTokens(u.tokens)}/${fmtTokens(u.contextWindow)} ${pct}%`));
  }

  async function showReport(ctx: ExtensionCommandContext) {
    const report = buildReport(ctx);
    if (ctx.mode !== "tui" || !ctx.hasUI) {
      ctx.ui.notify(report.split("\n").slice(0, 4).join(" · "), "info");
      return;
    }
    const theme = ctx.ui.theme;
    const lines = report.split("\n");
    let scroll = 0;
    await ctx.ui.custom<void>(
      (tui, _t, _kb, done) => ({
        render(width: number) {
          const inner = Math.max(1, width - 2);
          const maxView = Math.max(5, tui.terminal.rows - 6);
          const maxScroll = Math.max(0, lines.length - maxView);
          scroll = clamp(scroll, 0, maxScroll);
          const bar = theme.fg("accent", "│");
          const frameLine = (l: string) => bar + l.slice(0, inner).padEnd(inner) + bar;
          const rows = lines.slice(scroll, scroll + maxView).map(frameLine);
          const hint = maxScroll > 0
            ? ` ↑↓ scroll · ${scroll}/${maxScroll} · Esc close`
            : " ↑↓ scroll · Esc close";
          return [
            theme.fg("accent", "╭" + "─".repeat(inner) + "╮"),
            ...rows,
            theme.fg("accent", "╰" + "─".repeat(inner) + "╯"),
            theme.fg("dim", hint),
          ];
        },
        invalidate() {},
        handleInput(data: string) {
          if (matchesKey(data, Key.up)) {
            scroll -= 1;
            tui.requestRender();
          } else if (matchesKey(data, Key.down)) {
            scroll += 1;
            tui.requestRender();
          } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) {
            done();
          }
        },
      }),
      { overlay: true },
    );
  }

  pi.on("session_start", (_event, ctx) => refresh(ctx));
  pi.on("agent_settled", (_event, ctx) => refresh(ctx));
  pi.on("model_select", (_event, ctx) => refresh(ctx));

  pi.on("session_compact", (_event, ctx) => {
    refresh(ctx);
    ctx.ui.notify("Context compacted.", "info");
  });

  pi.on("session_compact_failed", (event, ctx) => {
    refresh(ctx);
    ctx.ui.notify(`Compaction failed: ${event.errorMessage ?? "unknown error"}`, "error");
  });

  pi.on("session_before_compact", (event, ctx) => {
    if (event.reason === "overflow") {
      ctx.ui.setStatus("context", ctx.ui.theme.fg("error", "⚠ overflow · compacting"));
      ctx.ui.notify("Context overflow — compacting and retrying.", "warning");
    }
  });

  pi.registerCommand("tokens", {
    description: "Show context window usage, exact token/cost totals, and estimated composition",
    handler: async (_args, ctx) => showReport(ctx),
  });
}
