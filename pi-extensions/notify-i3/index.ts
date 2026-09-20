import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type Transport = "auto" | "desktop" | "osc" | "off";
type Urgency = "low" | "normal" | "critical";

interface NotifyConfig {
  enabled: boolean;
  thresholdMs: number;
  transport: Transport;
}

const APP_NAME = "Pi";
const CONFIG_FILE = "notify-i3.json";

const DEFAULT_CONFIG: NotifyConfig = {
  enabled: true,
  thresholdMs: 5_000,
  transport: "auto",
};

const MIN_THRESHOLD_MS = 1_000;
const MAX_THRESHOLD_MS = 3_600_000; // 1 hour
const DEBOUNCE_MS = 2_000; // global anti-spam window
const BLOCKED_SUPPRESS_MS = 5_000; // don't stack "done" on a fresh "blocked"
const EXEC_TIMEOUT_MS = 2_000; // notify-send must not stall the event loop
const MAX_BODY_LENGTH = 200;

const TRANSPORTS: readonly Transport[] = ["auto", "desktop", "osc", "off"];

function cleanText(text: string): string {
  return text
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_BODY_LENGTH);
}

function oscSafe(text: string): string {
  // Semicolons and backslashes are structural in OSC payloads.
  return cleanText(text).replace(/[;\\]/g, " ");
}

function hasDesktopEnv(): boolean {
  return Boolean(
    process.env.DBUS_SESSION_BUS_ADDRESS ||
      process.env.DISPLAY ||
      process.env.WAYLAND_DISPLAY,
  );
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(ms % 60_000 === 0 ? 0 : 1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(ms % 1_000 === 0 ? 0 : 1)}s`;
  return `${ms}ms`;
}

function parseDuration(input: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(input.trim());
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  const unit = (match[2] ?? "ms").toLowerCase();
  const factor = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  const ms = Math.round(value * factor);
  if (ms < MIN_THRESHOLD_MS || ms > MAX_THRESHOLD_MS) return undefined;
  return ms;
}

export default async function (pi: ExtensionAPI) {
  const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
  const isSubagent = Number.isFinite(depth) && depth >= 1;

  // Subagents are headless (stdin is /dev/null, no UI, no desktop). Register nothing.
  if (isSubagent) return;

  const configPath = join(getAgentDir(), CONFIG_FILE);

  let config: NotifyConfig = { ...DEFAULT_CONFIG };
  let desktopDemoted = false; // notify-send failed this session; stop retrying
  let running = false; // a task is in flight
  let startedAt = 0; // timestamp of the first agent_start of the current task
  let lastAnyAt = 0; // last time any notification was emitted
  let lastBlockedAt = 0; // last time a "blocked on input" notification was emitted
  let blockedNotified = false; // whether the current task already emitted "blocked"

  function sanitizeConfig(raw: unknown): NotifyConfig {
    if (typeof raw !== "object" || raw === null) return { ...DEFAULT_CONFIG };
    const obj = raw as Partial<NotifyConfig>;
    const thresholdMs =
      typeof obj.thresholdMs === "number" && Number.isFinite(obj.thresholdMs)
        ? Math.min(MAX_THRESHOLD_MS, Math.max(MIN_THRESHOLD_MS, Math.round(obj.thresholdMs)))
        : DEFAULT_CONFIG.thresholdMs;
    const transport = TRANSPORTS.includes(obj.transport as Transport)
      ? (obj.transport as Transport)
      : DEFAULT_CONFIG.transport;
    const enabled = typeof obj.enabled === "boolean" ? obj.enabled : DEFAULT_CONFIG.enabled;
    return { enabled, thresholdMs, transport };
  }

  async function loadConfig(): Promise<void> {
    try {
      config = sanitizeConfig(JSON.parse(await readFile(configPath, "utf8")));
    } catch {
      config = { ...DEFAULT_CONFIG };
    }
  }

  async function saveConfig(): Promise<boolean> {
    const tmp = `${configPath}.tmp`;
    try {
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
      await rename(tmp, configPath);
      return true;
    } catch {
      return false;
    }
  }

  async function sendDesktop(title: string, body: string, urgency: Urgency, icon: string): Promise<boolean> {
    const args = ["-a", APP_NAME, "-u", urgency, "-t", "5000", "-i", icon, "--", title, body];
    try {
      const result = await pi.exec("notify-send", args, { timeout: EXEC_TIMEOUT_MS });
      return result.code === 0;
    } catch {
      return false;
    }
  }

  function sendOsc(title: string, body: string): boolean {
    if (!process.stdout.isTTY) return false;
    try {
      if (process.env.KITTY_WINDOW_ID) {
        process.stdout.write(`\x1b]99;i=1:d=0;${oscSafe(title)}\x1b\\`);
        process.stdout.write(`\x1b]99;i=1:p=body;${oscSafe(body)}\x1b\\`);
      } else {
        process.stdout.write(`\x1b]777;notify;${oscSafe(title)};${oscSafe(body)}\x07`);
      }
      return true;
    } catch {
      return false;
    }
  }

  async function dispatch(title: string, body: string, urgency: Urgency, icon: string): Promise<string> {
    const mode = config.transport;
    if (mode === "off") return "off";

    const wantDesktop = mode === "desktop" || (mode === "auto" && hasDesktopEnv());
    if (wantDesktop && !desktopDemoted) {
      if (await sendDesktop(title, body, urgency, icon)) return "desktop";
      if (mode === "desktop") return "none"; // explicitly requested desktop; failed
      desktopDemoted = true;
    }

    if (mode === "osc" || mode === "auto") {
      if (sendOsc(title, body)) return "osc";
    }

    return "none";
  }

  function getActiveTransport(): string {
    if (!config.enabled || config.transport === "off") return "disabled";
    if (config.transport === "desktop") {
      return desktopDemoted ? "desktop (unavailable this session)" : "desktop";
    }
    if (config.transport === "osc") {
      return process.stdout.isTTY ? "osc" : "osc (no TTY)";
    }
    // auto
    if (hasDesktopEnv() && !desktopDemoted) return "desktop";
    if (process.stdout.isTTY) return "osc/terminal fallback";
    return "none (no display/DBus and stdout is not a TTY)";
  }

  async function notify(title: string, body: string, urgency: Urgency, icon: string): Promise<boolean> {
    if (!config.enabled) return false;
    const now = Date.now();
    if (now - lastAnyAt < DEBOUNCE_MS) return false;
    lastAnyAt = now;
    try {
      const result = await dispatch(title, body, urgency, icon);
      return result !== "none" && result !== "off";
    } catch {
      return false;
    }
  }

  pi.on("agent_start", () => {
    if (!running) {
      running = true;
      startedAt = Date.now();
    }
    blockedNotified = false;
  });

  pi.on("agent_settled", () => {
    running = false;
    const elapsed = startedAt > 0 ? Date.now() - startedAt : 0;
    startedAt = 0;
    const notJustBlocked = Date.now() - lastBlockedAt > BLOCKED_SUPPRESS_MS;
    if (notJustBlocked) {
      const body = elapsed >= config.thresholdMs
        ? `Task finished in ${formatDuration(elapsed)}.`
        : "Ready for input";
      void notify(APP_NAME, body, "normal", "dialog-information").catch(() => {});
    }
  });

  pi.on("ui_prompt_start", () => {
    if (blockedNotified) return;
    void (async () => {
      try {
        const sent = await notify(APP_NAME, "Waiting for your input", "critical", "dialog-warning");
        if (sent) {
          blockedNotified = true;
          lastBlockedAt = Date.now();
        }
      } catch {
        // defensive
      }
    })();
  });

  pi.registerCommand("notify", {
    description: "Manage desktop notifications: status, on, off, toggle, test, threshold",
    getArgumentCompletions(prefix) {
      const subs = ["status", "on", "off", "toggle", "test", "threshold"];
      const matches = subs.filter((s) => s.startsWith(prefix));
      return matches.length > 0 ? matches.map((s) => ({ value: s, label: s })) : null;
    },
    handler: async (args, ctx) => {
      await loadConfig();
      const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const report = (text: string, type: "info" | "warning" | "error" = "info") =>
        ctx.ui.notify(text, type);

      switch (sub) {
        case "status": {
          report(
            `notify-i3: ${config.enabled ? "enabled" : "disabled"} · transport=${config.transport} · threshold=${formatDuration(config.thresholdMs)} · active=${getActiveTransport()}`,
          );
          break;
        }
        case "on":
        case "off": {
          config.enabled = sub === "on";
          const saved = await saveConfig();
          report(
            saved
              ? `Notifications ${config.enabled ? "enabled" : "disabled"}.`
              : `Notifications ${config.enabled ? "enabled" : "disabled"} (in memory; config write failed).`,
            saved ? "info" : "warning",
          );
          break;
        }
        case "toggle": {
          config.enabled = !config.enabled;
          const saved = await saveConfig();
          report(
            saved
              ? `Notifications ${config.enabled ? "enabled" : "disabled"}.`
              : `Notifications ${config.enabled ? "enabled" : "disabled"} (in memory; config write failed).`,
            saved ? "info" : "warning",
          );
          break;
        }
        case "test": {
          if (config.transport === "off") {
            report("Notifications are disabled via transport=off. Edit the config file to re-enable.", "warning");
            break;
          }
          desktopDemoted = false; // re-probe the desktop transport on demand
          const used = await dispatch(APP_NAME, "Test notification", "critical", "dialog-information");
          if (used === "off") report("Notifications are disabled via transport=off.", "warning");
          else if (used === "none") report("No transport available: no display/DBus and stdout is not a TTY.", "warning");
          else report(`Test notification sent via ${used}.`, "info");
          break;
        }
        case "threshold": {
          if (rest.length === 0) {
            report(`Task-finished threshold: ${formatDuration(config.thresholdMs)}.`);
            break;
          }
          const ms = parseDuration(rest.join(""));
          if (ms === undefined) {
            report(
              `Invalid threshold "${rest.join(" ")}". Use e.g. "5s", "2m", or "10000" (range ${formatDuration(MIN_THRESHOLD_MS)}..${formatDuration(MAX_THRESHOLD_MS)}).`,
              "error",
            );
            break;
          }
          config.thresholdMs = ms;
          const saved = await saveConfig();
          report(
            saved
              ? `Task-finished threshold set to ${formatDuration(ms)}.`
              : `Task-finished threshold set to ${formatDuration(ms)} (in memory; config write failed).`,
            saved ? "info" : "warning",
          );
          break;
        }
        default:
          report(`Unknown subcommand "${sub}". Use status, on, off, toggle, test, threshold.`, "error");
      }
    },
  });

  await loadConfig();
}
