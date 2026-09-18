import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, highlightCode, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { Component, SelectItem } from "@earendil-works/pi-tui";
import { Box, Container, SelectList, Spacer, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { parse as shellParse } from "shell-quote";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, normalize, relative, resolve } from "node:path";

type Severity = "high" | "medium";

type SecretRisk = {
	severity: Severity;
	reasons: string[];
	target?: string;
};

type OpToken = { op: string; [k: string]: unknown };
type Token = string | OpToken;

function isOpToken(t: Token): t is OpToken {
	return typeof t === "object" && t !== null && "op" in t;
}

function tokensToStrings(tokens: Token[]): string[] {
	return tokens.filter((t) => typeof t === "string") as string[];
}

function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) {
		return join(homedir(), p.slice(2));
	}
	return p;
}

function isInside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isTmpPath(target: string): boolean {
	return isInside(tmpdir(), target) || isInside("/tmp", target) || isInside("/var/tmp", target);
}

const GUEST_WORKSPACE = "/workspace";

function isInsideWorkspace(cwd: string, target: string): boolean {
	const normalized = normalize(target);
	return (
		isInside(cwd, normalized) ||
		isTmpPath(normalized) ||
		normalized === GUEST_WORKSPACE ||
		isInside(GUEST_WORKSPACE, normalized)
	);
}

/**
 * Known sensitive file basenames and patterns.
 */
const SENSITIVE_BASENAMES = new Set([
	".bashrc",
	".bash_profile",
	".bash_login",
	".bash_logout",
	".bash_history",
	".zshrc",
	".zprofile",
	".zshenv",
	".zlogin",
	".zhistory",
	".zsh_history",
	".profile",
	".cshrc",
	".tcshrc",
	".kshrc",
	".netrc",
	".git-credentials",
	".pgpass",
	".pypirc",
	".npmrc",
	"id_rsa",
	"id_ed25519",
	"id_ecdsa",
	"id_dsa",
]);

/**
 * Extensions and prefix patterns for secret files.
 */
const SENSITIVE_PATTERNS = [
	/^\.env(\..+)?$/i,
	/\.pem$/i,
	/\.key$/i,
	/\.pkcs12$/i,
	/\.pfx$/i,
	/\.p12$/i,
	/id_rsa/i,
	/id_ed25519/i,
];

/**
 * Benign template / example files that match sensitive patterns but are safe.
 */
const BENIGN_PATTERN_EXCEPTIONS = [
	/\.env\.(example|sample|template|test|testing|dist|defaults)$/i,
	/\.env\.schema$/i,
];

/**
 * Sensitive directories inside user home or root.
 */
const SENSITIVE_HOME_DIRS = [
	".ssh",
	".aws",
	".kube",
	".gnupg",
	".config/gcloud",
	".config/gh",
	".docker/config.json",
	".azure",
];

/**
 * Sensitive system configuration files.
 */
const SENSITIVE_SYSTEM_FILES = [
	"/etc/shadow",
	"/etc/sudoers",
	"/etc/master.passwd",
	"/etc/environment",
	"/etc/profile",
];

function isPathSensitive(rawPath: string, cwd: string): { sensitive: boolean; reason?: string } {
	if (!rawPath || typeof rawPath !== "string") return { sensitive: false };

	const trimmed = rawPath.trim();
	if (trimmed === GUEST_WORKSPACE || trimmed === "." || trimmed === "./") return { sensitive: false };

	const expanded = expandTilde(trimmed);
	const absPath = normalize(resolve(cwd, expanded));
	const base = basename(absPath);

	// Check if this is an allowed benign template (e.g. .env.example)
	for (const benign of BENIGN_PATTERN_EXCEPTIONS) {
		if (benign.test(base)) {
			return { sensitive: false };
		}
	}

	// 1. Direct sensitive filename match
	if (SENSITIVE_BASENAMES.has(base.toLowerCase())) {
		return {
			sensitive: true,
			reason: `sensitive dotfile / credential configuration (${base})`,
		};
	}

	// 2. Sensitive pattern matches (e.g. .env, *.pem, *.key)
	for (const pat of SENSITIVE_PATTERNS) {
		if (pat.test(base)) {
			return {
				sensitive: true,
				reason: `secret / private credential file (${base})`,
			};
		}
	}

	// 3. System credential files
	for (const sysFile of SENSITIVE_SYSTEM_FILES) {
		if (absPath === sysFile || absPath.startsWith(`${sysFile}/`)) {
			return {
				sensitive: true,
				reason: `sensitive system credential path (${sysFile})`,
			};
		}
	}

	// 4. Sensitive home directories (.ssh, .aws, .kube, .gnupg)
	const home = homedir();
	for (const relDir of SENSITIVE_HOME_DIRS) {
		const fullDir = normalize(resolve(home, relDir));
		if (absPath === fullDir || absPath.startsWith(`${fullDir}/`)) {
			return {
				sensitive: true,
				reason: `sensitive credential directory (~/${relDir})`,
			};
		}
	}

	// 5. Root home equivalents (/root/.ssh, /root/.aws)
	for (const relDir of SENSITIVE_HOME_DIRS) {
		const fullDir = normalize(resolve("/root", relDir));
		if (absPath === fullDir || absPath.startsWith(`${fullDir}/`)) {
			return {
				sensitive: true,
				reason: `root credential directory (/root/${relDir})`,
			};
		}
	}

	return { sensitive: false };
}

function checkPathAccess(rawPath: string, cwd: string): SecretRisk | null {
	if (!rawPath || typeof rawPath !== "string") return null;

	const trimmed = rawPath.trim();
	if (!trimmed || trimmed === "." || trimmed === "./" || trimmed === GUEST_WORKSPACE) return null;

	const expanded = expandTilde(trimmed);

	// If target is inside guest workspace /workspace (e.g. Gondolin micro-VM)
	if (expanded === GUEST_WORKSPACE || expanded.startsWith(`${GUEST_WORKSPACE}/`)) {
		const sensitiveCheck = isPathSensitive(expanded, GUEST_WORKSPACE);
		if (sensitiveCheck.sensitive && sensitiveCheck.reason) {
			return { severity: "high", reasons: [sensitiveCheck.reason], target: expanded };
		}
		return null;
	}

	const absPath = normalize(resolve(cwd, expanded));
	const reasons: string[] = [];
	let severity: Severity = "medium";

	// 1. Check if path is sensitive
	const sensitiveCheck = isPathSensitive(absPath, cwd);
	if (sensitiveCheck.sensitive && sensitiveCheck.reason) {
		reasons.push(sensitiveCheck.reason);
		severity = "high";
	}

	// 2. Check if path is outside workspace (and outside /tmp and /workspace)
	if (!isInsideWorkspace(cwd, absPath)) {
		reasons.push(`filesystem path outside current workspace (${absPath})`);
		severity = "high";
	}

	if (reasons.length === 0) return null;
	return { severity, reasons, target: absPath };
}

/**
 * Remove here-document bodies so content being written via cat <<EOF is not judged.
 */
function stripHeredocBodies(command: string): string {
	let out = "";
	let i = 0;
	const n = command.length;
	const pending: Array<{ delimiter: string; stripTabs: boolean }> = [];
	let quote: "'" | '"' | null = null;

	while (i < n) {
		const ch = command[i];

		if (quote === "'") {
			out += ch;
			i++;
			if (ch === "'") quote = null;
			continue;
		}
		if (quote === '"') {
			if (ch === "\\") {
				out += ch;
				i++;
				if (i < n) out += command[i++];
				continue;
			}
			out += ch;
			i++;
			if (ch === '"') quote = null;
			continue;
		}
		if (ch === "\\") {
			out += ch;
			i++;
			if (i < n) out += command[i++];
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			out += ch;
			i++;
			continue;
		}

		if (ch === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
			let j = i + 2;
			const stripTabs = command[j] === "-";
			if (stripTabs) j++;
			while (j < n && (command[j] === " " || command[j] === "\t")) j++;

			let delimiter = "";
			while (j < n && !/[\s;&|<>]/.test(command[j])) {
				const c = command[j];
				if (c === "'" || c === '"') {
					const q = c;
					j++;
					while (j < n && command[j] !== q) delimiter += command[j++];
					if (j < n) j++;
					continue;
				}
				if (c === "\\") {
					j++;
					if (j < n) delimiter += command[j++];
					continue;
				}
				delimiter += c;
				j++;
			}

			pending.push({ delimiter, stripTabs });
			out += command.slice(i, j);
			i = j;
			continue;
		}

		if (ch === "\n") {
			out += ch;
			i++;
			while (pending.length > 0 && i <= n) {
				let lineEnd = command.indexOf("\n", i);
				if (lineEnd === -1) lineEnd = n;
				const rawLine = command.slice(i, lineEnd);
				const spec = pending[0];
				const line = spec.stripTabs ? rawLine.replace(/^\t+/, "") : rawLine;
				if (line === spec.delimiter) pending.shift();
				if (lineEnd >= n) {
					i = n;
					break;
				}
				i = lineEnd + 1;
			}
			continue;
		}

		out += ch;
		i++;
	}

	return out;
}

/**
 * Commands that dump the full process environment or all declared variables.
 */
const ENV_DUMP_COMMANDS = new Set(["env", "printenv"]);

function analyzeBashForSecrets(command: string, cwd: string): SecretRisk | null {
	const analyzable = stripHeredocBodies(command);
	let tokens: Token[];
	try {
		tokens = shellParse(analyzable, process.env) as Token[];
	} catch {
		tokens = [];
	}

	const reasons: string[] = [];
	let severity: Severity = "medium";

	// 1. Direct environment dumping commands
	const args = tokensToStrings(tokens);
	if (args.length > 0) {
		const firstCmd = args[0];
		if (ENV_DUMP_COMMANDS.has(firstCmd) && (args.length === 1 || (args.length === 2 && args[1].startsWith("-")))) {
			reasons.push(`${firstCmd} (dumps all process environment variables and API keys)`);
			severity = "high";
		}
		if (firstCmd === "export" && (args.length === 1 || args.includes("-p"))) {
			reasons.push("export -p (dumps all exported environment variables)");
			severity = "high";
		}
		if (firstCmd === "set" && args.length === 1) {
			reasons.push("set (dumps all shell variables and environment)");
			severity = "high";
		}
	}

	// 2. /proc/*/environ reads
	if (/\/proc\/(?:self|\d+|\$\$)\/environ\b/.test(command)) {
		reasons.push("reading /proc/*/environ (exposes process environment variables)");
		severity = "high";
	}

	// 3. Inspect arguments for ACTUAL sensitive secret files/directories
	for (const token of args) {
		if (!token || token.startsWith("-")) continue;

		// Skip standard workspace targets
		if (token === GUEST_WORKSPACE || token === "." || token === "./") continue;

		// If token is under /workspace, check if it targets a sensitive secret file inside workspace (e.g. /workspace/.env)
		if (token.startsWith(`${GUEST_WORKSPACE}/`)) {
			const sensitiveCheck = isPathSensitive(token, GUEST_WORKSPACE);
			if (sensitiveCheck.sensitive && sensitiveCheck.reason) {
				reasons.push(`access to ${sensitiveCheck.reason}`);
				severity = "high";
			}
			continue;
		}

		// Check if token references an explicitly sensitive path (e.g. ~/.bashrc, ~/.ssh, .env, id_rsa, /etc/shadow)
		const sensitiveCheck = isPathSensitive(token, cwd);
		if (sensitiveCheck.sensitive && sensitiveCheck.reason) {
			reasons.push(`access to ${sensitiveCheck.reason}`);
			severity = "high";
		}
	}

	// 4. Sweeping searches across root/home
	if (/\bfind\s+(?:\/|\/etc|\/home|\/root|~)(?:\s|$)/.test(command) && !command.includes(GUEST_WORKSPACE)) {
		reasons.push("find targeting system root or user home directory");
		severity = "high";
	}

	const uniq = [...new Set(reasons)];
	if (uniq.length === 0) return null;
	return { severity, reasons: uniq, target: command };
}

// Subagent depth detection: 0 = main interactive session, >= 1 = headless subagent child process
const _subagentDepth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
const _isSubagent = Number.isFinite(_subagentDepth) && _subagentDepth >= 1;

const SECRETS_GUARD_STATUS_KEY = " secrets-guard";

async function promptSecretAccessOrAbort(
	ctx: any,
	title: string,
	targetDisplay: string,
	risk: SecretRisk,
): Promise<"allow" | "abort"> {
	if (!ctx.hasUI) return "abort";

	const items: SelectItem[] = [
		{ value: "allow", label: "Allow Once", description: "Permit this sensitive read for this operation" },
		{ value: "abort", label: "Abort", description: "Block access and protect credentials" },
	];

	const choice = await ctx.ui.custom<"allow" | "abort">(
		(tui: any, theme: any, _kb: any, done: (val: "allow" | "abort") => void) => {
			const severityColor = risk.severity === "high" ? "error" : "warning";

			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("warning", s)));
			container.addChild(new Text(theme.fg("warning", theme.bold(`🔒 ${title}`)), 1, 0));
			container.addChild(new Text(theme.fg(severityColor, theme.bold(`${risk.severity.toUpperCase()} security alert`)), 1, 0));
			container.addChild(
				new Text(
					risk.reasons.map((r) => `${theme.fg(severityColor, "•")} ${theme.fg("muted", r)}`).join("\n"),
					1,
					0,
				),
			);
			container.addChild(new Spacer(1));

			const previewBox = new Box(1, 1, (s: string) => theme.bg("toolPendingBg", s));
			const previewText = targetDisplay.length > 200 ? `${targetDisplay.slice(0, 200)}...` : targetDisplay;
			previewBox.addChild(new Text(theme.fg("toolOutput", previewText), 0, 0));
			container.addChild(previewBox);
			container.addChild(new Spacer(1));

			const list = new SelectList(items, items.length, {
				selectedPrefix: (t: string) => theme.fg("accent", t),
				selectedText: (t: string) => theme.fg("accent", t),
				description: (t: string) => theme.fg("muted", t),
				scrollInfo: (t: string) => theme.fg("dim", t),
				noMatch: (t: string) => theme.fg("warning", t),
			});

			list.onSelect = (item: SelectItem) => done(item.value as "allow" | "abort");
			list.onCancel = () => done("abort");
			container.addChild(list);

			container.addChild(new DynamicBorder((s: string) => theme.fg("warning", s)));

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{ overlay: true },
	);

	return choice ?? "abort";
}

export default function (pi: ExtensionAPI) {
	if (_isSubagent) {
		// Subagent mode: hard-block any sensitive reads or outside-workspace traversal.
		pi.on("tool_call", async (event, ctx) => {
			const cwd = ctx?.cwd ?? process.cwd();

			if (
				isToolCallEventType("read", event) ||
				isToolCallEventType("write", event) ||
				isToolCallEventType("edit", event)
			) {
				const rawPath = event.input.file_path || event.input.path || "";
				const risk = checkPathAccess(rawPath, cwd);
				if (risk) {
					return {
						block: true,
						reason:
							`Blocked by secrets-guard: ${risk.reasons.join("; ")}. ` +
							"Subagent sessions are strictly jailed to the workspace and forbidden from accessing credentials or dotfiles. " +
							"Work within the local workspace directory or ask the parent agent for approval.",
					};
				}
			}

			if (
				isToolCallEventType("ls", event) ||
				isToolCallEventType("find", event) ||
				isToolCallEventType("grep", event)
			) {
				const rawPath = event.input.path || ".";
				const risk = checkPathAccess(rawPath, cwd);
				if (risk) {
					return {
						block: true,
						reason:
							`Blocked by secrets-guard: ${risk.reasons.join("; ")}. ` +
							"Subagents cannot list or search paths outside the workspace or inside sensitive credential directories.",
					};
				}
			}

			if (isToolCallEventType("bash", event)) {
				const command = event.input.command;
				const risk = analyzeBashForSecrets(command, cwd);
				if (risk) {
					return {
						block: true,
						reason:
							`Blocked by secrets-guard: ${risk.reasons.join("; ")}. ` +
							"Subagent shell execution is restricted from dumping environment variables or accessing sensitive paths.",
					};
				}
			}
		});
		return;
	}

	// Main session mode: interactive prompting
	pi.registerFlag("secrets-guard-disabled", {
		description: "Start the session with secrets-guard disabled (autonomous mode; hard-block floor for subagents still applies).",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("secrets-guard-auto-allow", {
		description: "If set, secrets-guard will not prompt in non-interactive sessions.",
		type: "boolean",
		default: false,
	});

	let disabled = false;

	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "startup" && pi.getFlag("--secrets-guard-disabled") === true) {
			disabled = true;
			const { theme } = ctx.ui;
			const badge = theme.bg("toolErrorBg", theme.bold(theme.fg("error", " ⚠ SEC OFF ")));
			ctx.ui.setStatus(SECRETS_GUARD_STATUS_KEY, badge);
		}
	});

	pi.registerCommand("secrets-guard", {
		description: "Toggle secrets-guard between interactive (default) and disabled for this session.",
		handler: async (_args, ctx) => {
			disabled = !disabled;
			if (disabled) {
				const { theme } = ctx.ui;
				const badge = theme.bg("toolErrorBg", theme.bold(theme.fg("error", " ⚠ SEC OFF ")));
				ctx.ui.setStatus(SECRETS_GUARD_STATUS_KEY, badge);
				ctx.ui.notify(
					"secrets-guard DISABLED for this session. Sensitive reads will not prompt. Subagents remain hard-blocked.",
					"warning",
				);
			} else {
				ctx.ui.setStatus(SECRETS_GUARD_STATUS_KEY, undefined);
				ctx.ui.notify("secrets-guard re-enabled.", "info");
			}
		},
	});

	const recentlyAborted = new Map<string, number>();
	const ABORT_REMEMBER_MS = 60_000;

	pi.on("tool_call", async (event, ctx) => {
		const cwd = ctx?.cwd ?? process.cwd();

		if (disabled) return;

		let risk: SecretRisk | null = null;
		let title = "Sensitive path access";
		let targetDisplay = "";

		if (
			isToolCallEventType("read", event) ||
			isToolCallEventType("write", event) ||
			isToolCallEventType("edit", event)
		) {
			const rawPath = event.input.file_path || event.input.path || "";
			targetDisplay = rawPath;
			risk = checkPathAccess(rawPath, cwd);
			title = `Sensitive file access (${event.tool})`;
		} else if (
			isToolCallEventType("ls", event) ||
			isToolCallEventType("find", event) ||
			isToolCallEventType("grep", event)
		) {
			const rawPath = event.input.path || ".";
			targetDisplay = rawPath;
			risk = checkPathAccess(rawPath, cwd);
			title = `Directory / Search access (${event.tool})`;
		} else if (isToolCallEventType("bash", event)) {
			const command = event.input.command;
			targetDisplay = command;
			risk = analyzeBashForSecrets(command, cwd);
			title = "Sensitive bash command / Secret exposure";
		}

		if (!risk || risk.reasons.length === 0) return;

		const now = Date.now();
		const cacheKey = `${event.tool}:${targetDisplay}`;
		const lastAbort = recentlyAborted.get(cacheKey);
		if (lastAbort && now - lastAbort < ABORT_REMEMBER_MS) {
			return {
				block: true,
				reason: "Blocked by secrets-guard: access was recently denied by user. Ask for a safer workspace-local alternative.",
			};
		}

		if (!ctx.hasUI && pi.getFlag("--secrets-guard-auto-allow")) {
			return;
		}

		const choice = await promptSecretAccessOrAbort(ctx, title, targetDisplay, risk);
		if (choice === "allow") return;

		recentlyAborted.set(cacheKey, now);
		return {
			block: true,
			reason: `Blocked by user via secrets-guard: ${risk.reasons.join("; ")}. Please use workspace files or provide an alternative.`,
		};
	});
}
