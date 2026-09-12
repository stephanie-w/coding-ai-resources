import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder, highlightCode, isToolCallEventType } from "@mariozechner/pi-coding-agent";
import type { Component, SelectItem } from "@mariozechner/pi-tui";
import { Box, Container, SelectList, Spacer, Text, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { parse as shellParse } from "shell-quote";
import { homedir } from "node:os";
import { resolve } from "node:path";

type Severity = "high" | "medium";

type Risk = {
	severity: Severity;
	reasons: string[];
};

type OpToken = { op: string; [k: string]: unknown };

type Token = string | OpToken;

function isOpToken(t: Token): t is OpToken {
	return typeof t === "object" && t !== null && "op" in t;
}

function tokensToStrings(tokens: Token[]): string[] {
	return tokens.filter((t) => typeof t === "string") as string[];
}

function splitOnOps(tokens: Token[], splitOps: string[]): Token[][] {
	const out: Token[][] = [];
	let current: Token[] = [];
	for (const t of tokens) {
		if (isOpToken(t) && splitOps.includes(t.op)) {
			if (current.length) out.push(current);
			current = [];
			continue;
		}
		current.push(t);
	}
	if (current.length) out.push(current);
	return out;
}

function hasFlag(args: string[], flag: string): boolean {
	return args.includes(flag) || args.some((a) => a.startsWith(flag) && flag.length === 2 && a.startsWith("-"));
}

function anyArgStartsWith(args: string[], prefix: string): boolean {
	return args.some((a) => a.startsWith(prefix));
}

function analyzeSegment(seg: Token[]): Risk | null {
	const reasons: string[] = [];
	let severity: Severity = "medium";

	const ops = seg.filter(isOpToken).map((o) => o.op);
	const args = tokensToStrings(seg);
	if (args.length === 0) return null;

	const cmd = args[0];
	const rest = args.slice(1);

	// sudo
	if (cmd === "sudo") {
		reasons.push("sudo (elevated privileges)");
		severity = "high";
	}

	// rm/rmdir/unlink
	if (cmd === "rm" || cmd === "rmdir" || cmd === "unlink") {
		severity = "high";
		reasons.push(`${cmd} (file deletion)`);
		if (rest.some((a) => a.includes("-r") || a.includes("-R"))) reasons.push("recursive delete (-r/-R)");
		if (rest.some((a) => a.includes("-f"))) reasons.push("forced delete (-f)");
		if (ops.includes("glob")) reasons.push("glob pattern expansion (may delete many files)");
	}

	// find -delete
	if (cmd === "find" && rest.includes("-delete")) {
		severity = "high";
		reasons.push("find -delete (bulk deletion)");
	}

	// xargs launching a deletion command
	if (cmd === "xargs") {
		const target = rest.find((a) => !a.startsWith("-"));
		if (target === "rm" || target === "rmdir" || target === "unlink") {
			severity = "high";
			reasons.push("xargs deletion (bulk file deletion)");
		}
	}

	// git: only destructive working-tree / history operations prompt. Read-only and
	// routine commands (status, log, diff, add, commit, pull, push, fetch, ...) pass.
	if (cmd === "git") {
		const sub = rest[0];
		const subArgs = rest.slice(1);

		if (sub === "rm") {
			severity = "high";
			reasons.push("git rm (deletes files from working tree and stages deletions)");
		}
		if (sub === "clean") {
			const dryRun = subArgs.includes("-n") || subArgs.includes("--dry-run");
			const force = subArgs.some((a) => a === "--force" || (/^-[a-zA-Z]+$/.test(a) && a.includes("f")));
			if (force && !dryRun) {
				severity = "high";
				reasons.push("git clean -f (can delete untracked files)");
			}
		}
		if (sub === "reset" && subArgs.includes("--hard")) {
			severity = "high";
			reasons.push("git reset --hard (discard changes)");
		}
		if (
			sub === "checkout" &&
			(subArgs.includes(".") ||
				subArgs.includes("--") ||
				subArgs.some((a) => a === "--source" || a.startsWith("--source=")) ||
				subArgs.includes("-f") ||
				subArgs.includes("--force"))
		) {
			severity = severity === "high" ? "high" : "medium";
			reasons.push("git checkout (can overwrite working tree)");
		}
		if (sub === "restore") {
			// `--staged` (without `--worktree`) only unstages; everything else can
			// discard uncommitted changes.
			const stagedOnly =
				(subArgs.includes("--staged") || subArgs.includes("-S")) &&
				!(subArgs.includes("--worktree") || subArgs.includes("-W"));
			if (!stagedOnly) {
				severity = severity === "high" ? "high" : "medium";
				reasons.push("git restore (can overwrite working tree)");
			}
		}
		if (sub === "push" && (subArgs.includes("--force") || subArgs.includes("--force-with-lease") || subArgs.includes("-f"))) {
			severity = "high";
			reasons.push("git push --force (rewrite remote history)");
		}
		if (sub === "reflog" && subArgs.includes("expire")) {
			severity = "high";
			reasons.push("git reflog expire (can remove recovery history)");
		}
		if (sub === "gc" && subArgs.some((a) => a.startsWith("--prune"))) {
			severity = "high";
			reasons.push("git gc --prune (can permanently delete objects)");
		}
	}

	// truncate
	if (cmd === "truncate") {
		severity = severity === "high" ? "high" : "medium";
		reasons.push("truncate (in-place size change, can erase contents)");
	}

	// dd of=
	if (cmd === "dd" && (anyArgStartsWith(rest, "of=") || rest.includes("of"))) {
		severity = "high";
		reasons.push("dd with output file/device (can overwrite data)");
	}

	// Disk / volume management (prompt aggressively; high risk)
	// Linux: mkfs.*, wipefs, parted, fdisk, gdisk/sgdisk, lsblk, cryptsetup, LVM tools, zpool
	// macOS: diskutil, hdiutil, gpt, newfs_*, asr
	if (cmd.startsWith("mkfs")) {
		severity = "high";
		reasons.push("mkfs (filesystem formatting)");
	}
	if (cmd.startsWith("newfs_")) {
		severity = "high";
		reasons.push("newfs_* (filesystem formatting)");
	}
	if (cmd === "wipefs") {
		severity = "high";
		reasons.push("wipefs (disk signature wipe)");
	}
	if (cmd === "diskutil") {
		severity = "high";
		reasons.push("diskutil (disk management command)");
		if (rest.includes("eraseDisk") || rest.includes("eraseVolume")) {
			reasons.push("diskutil erase (destructive disk operation)");
		}
	}
	if (cmd === "hdiutil") {
		severity = "high";
		reasons.push("hdiutil (disk image management command)");
	}
	if (cmd === "gpt") {
		severity = "high";
		reasons.push("gpt (partition table manipulation)");
	}
	if (cmd === "asr") {
		severity = "high";
		reasons.push("asr (Apple Software Restore; can overwrite volumes)");
	}
	if (cmd === "parted" || cmd === "fdisk" || cmd === "gdisk" || cmd === "sgdisk") {
		severity = "high";
		reasons.push(`${cmd} (disk/partition management)`);
	}
	if (cmd === "lsblk") {
		// Usually read-only, but still disk-related; prompt as requested.
		severity = severity === "high" ? "high" : "medium";
		reasons.push("lsblk (disk listing)");
	}
	if (cmd === "cryptsetup") {
		severity = "high";
		reasons.push("cryptsetup (disk encryption management)");
	}
	if (cmd === "pvcreate" || cmd === "vgcreate" || cmd === "lvcreate") {
		severity = "high";
		reasons.push(`${cmd} (LVM volume management)`);
	}
	if (cmd === "zpool") {
		severity = "high";
		reasons.push("zpool (ZFS pool management)");
	}

	// chmod/chown recursive
	if (cmd === "chmod" && (rest.includes("-R") || rest.includes("--recursive"))) {
		severity = severity === "high" ? "high" : "medium";
		reasons.push("chmod -R (recursive permission changes)");
	}
	if (cmd === "chown" && (rest.includes("-R") || rest.includes("--recursive"))) {
		severity = severity === "high" ? "high" : "medium";
		reasons.push("chown -R (recursive ownership changes)");
	}

	// mv/cp overwriting
	if (cmd === "mv" && (rest.includes("-f") || rest.includes("--force"))) {
		severity = severity === "high" ? "high" : "medium";
		reasons.push("mv --force/-f (can overwrite files)");
	}
	if (cmd === "cp" && (rest.includes("-f") || rest.includes("--force"))) {
		severity = severity === "high" ? "high" : "medium";
		reasons.push("cp --force/-f (can overwrite files)");
	}

	// sed/perl in-place
	if (cmd === "sed" && (hasFlag(rest, "-i") || rest.includes("--in-place"))) {
		severity = severity === "high" ? "high" : "medium";
		reasons.push("sed -i (in-place file modification)");
	}
	if (cmd === "perl" && (rest.includes("-pi") || (rest.includes("-p") && rest.includes("-i")))) {
		severity = severity === "high" ? "high" : "medium";
		reasons.push("perl -pi/-i (in-place file modification)");
	}

	// kill/shutdown/systemctl
	if (cmd === "kill" || cmd === "pkill" || cmd === "killall") {
		severity = severity === "high" ? "high" : "medium";
		reasons.push(`${cmd} (process termination)`);
		if (rest.includes("-9")) {
			severity = "high";
			reasons.push("SIGKILL (-9)");
		}
	}
	if (cmd === "shutdown" || cmd === "reboot") {
		severity = "high";
		reasons.push(`${cmd} (system power operation)`);
	}
	if (cmd === "systemctl" && (rest.includes("stop") || rest.includes("disable"))) {
		severity = severity === "high" ? "high" : "medium";
		reasons.push("systemctl stop/disable (service disruption)");
	}

	// Infra deletes
	if (cmd === "kubectl" && rest[0] === "delete") {
		severity = "high";
		reasons.push("kubectl delete (resource deletion)");
	}
	if (cmd === "terraform" && rest[0] === "destroy") {
		severity = "high";
		reasons.push("terraform destroy (infrastructure teardown)");
	}
	if (cmd === "aws" && rest[0] === "s3" && rest[1] === "rm" && rest.includes("--recursive")) {
		severity = "high";
		reasons.push("aws s3 rm --recursive (bulk deletion)");
	}
	if (cmd === "gcloud" && rest.includes("delete")) {
		severity = "high";
		reasons.push("gcloud delete (resource deletion)");
	}

	if (reasons.length === 0) return null;
	return { severity, reasons };
}

const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "ash", "csh", "tcsh"]);

function baseName(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? path : path.slice(slash + 1);
}

/**
 * Redirection targets that never touch a real file: `/dev/null`-style sinks and
 * file-descriptor duplications such as `2>&1` or `>&2`.
 */
function isHarmlessRedirectTarget(target: string): boolean {
	if (target === "/dev/null") return true;
	if (/^\d+$/.test(target)) return true; // fd duplication (2>&1, >&2)
	return (
		/^\/dev\/(stdin|stdout|stderr)$/.test(target) ||
		/^\/dev\/fd\/\d+$/.test(target) ||
		/^\/proc\/self\/fd\/\d+$/.test(target)
	);
}

// Absolute path prefixes that are system-level and must not be silently
// overwritten by a shell redirection. Matched on path boundaries so `/etc`
// matches `/etc/hosts` but not `/etcetera`.
const SENSITIVE_PATH_PREFIXES = [
	"/etc",
	"/usr",
	"/bin",
	"/sbin",
	"/lib",
	"/lib64",
	"/boot",
	"/opt",
	"/root",
	"/System", // macOS
	"/Library", // macOS
	"/private/etc",
	"/private/var/db",
];

// Credential / configuration locations inside the user's home directory.
const SENSITIVE_HOME_PATHS = [
	".ssh",
	".gnupg",
	".aws",
	".kube",
	".netrc",
	".pgpass",
	".docker/config.json",
	".config/gcloud",
	".config/gh",
];

/** Expand `~`, resolve relative paths and normalize `..` before prefix checks. */
function normalizeRedirectTarget(target: string): string {
	if (target === "~") return homedir();
	if (target.startsWith("~/")) return resolve(homedir(), target.slice(2));
	return resolve(target);
}

function isSensitiveRedirectTarget(target: string): boolean {
	const abs = normalizeRedirectTarget(target);
	for (const prefix of SENSITIVE_PATH_PREFIXES) {
		if (abs === prefix || abs.startsWith(`${prefix}/`)) return true;
	}
	const home = homedir();
	for (const relative of SENSITIVE_HOME_PATHS) {
		const full = resolve(home, relative);
		if (abs === full || abs.startsWith(`${full}/`)) return true;
	}
	return false;
}

/**
 * Redirection policy: writing to a regular file is routine — the `write`/`edit`
 * tools are not guarded either, so `cat > script.sh <<EOF` must not interrupt.
 * Only writes to devices (`/dev/sda`), special files (`/proc`, `/sys`) and
 * sensitive system paths (`/etc`, `~/.ssh`, ...) are dangerous enough to prompt.
 */
type RedirectFinding = { reason: string; severity: Severity };

function analyzeRedirections(tokens: Token[]): RedirectFinding[] {
	const findings: RedirectFinding[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (!isOpToken(token)) continue;
		const op = token.op;
		if (op !== ">" && op !== ">>" && op !== ">&" && op !== "<&") continue;

		// The target is the next string token; `2>/dev/null` tokenizes as
		// ["2", {op:">"}, "/dev/null"].
		let target: string | undefined;
		for (let j = i + 1; j < tokens.length; j++) {
			const next = tokens[j];
			if (isOpToken(next)) break;
			target = next as string;
			break;
		}
		if (target === undefined || isHarmlessRedirectTarget(target)) continue;

		if (/^\/(dev|proc|sys)\//.test(target)) {
			findings.push({
				reason: "output redirection to a device or special file (can destroy data)",
				severity: "high",
			});
			break; // one finding is enough
		}

		if (isSensitiveRedirectTarget(target)) {
			findings.push({
				reason: `output redirection to a sensitive system path (${target})`,
				severity: "high",
			});
			break;
		}
	}
	return findings;
}

/** True when a pipeline stage invokes a shell interpreter (`curl ... | bash`). */
function hasPipeToShell(tokens: Token[]): boolean {
	const wrappers = new Set(["sudo", "env", "command", "nohup", "time", "exec"]);
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (!isOpToken(token) || (token.op !== "|" && token.op !== "|&")) continue;
		for (let j = i + 1; j < tokens.length; j++) {
			const next = tokens[j];
			if (isOpToken(next)) {
				if (next.op === "|" || next.op === "|&" || next.op === "&&" || next.op === "||" || next.op === ";") break;
				continue;
			}
			const cmd = baseName(next as string);
			if (SHELL_INTERPRETERS.has(cmd)) return true;
			if (wrappers.has(cmd)) continue;
			break;
		}
	}
	return false;
}

type HeredocSpec = { delimiter: string; stripTabs: boolean };

/**
 * Remove here-document *bodies* from a command before analysis. A here-doc body
 * is data being written, not a command, so the contents of a script written via
 * `cat > script.sh <<'EOF' ... EOF` must not be judged by the scanner.
 */
function stripHeredocBodies(command: string): string {
	let out = "";
	let i = 0;
	const n = command.length;
	const pending: HeredocSpec[] = [];
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

		// Here-doc operator `<<` (but not `<<<` here-strings).
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
			// Consume body lines until every pending delimiter is matched.
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

function analyzeBashCommand(command: string): Risk | null {
	// Here-doc bodies are data being written, not commands; don't judge them.
	const analyzable = stripHeredocBodies(command);

	let tokens: Token[];
	try {
		tokens = shellParse(analyzable, process.env) as Token[];
	} catch {
		// Fallback: if we can't parse, treat it as questionable
		return { severity: "medium", reasons: ["unparsed shell command (unable to analyze safely)"] };
	}

	const reasons: string[] = [];
	let severity: Severity = "medium";

	// Redirection analysis. Writing to a regular file is routine; only writes to
	// devices / special files interrupt the user.
	for (const { reason, severity: redirectSeverity } of analyzeRedirections(tokens)) {
		reasons.push(reason);
		if (redirectSeverity === "high") severity = "high";
	}

	// Piping is routine. Only escalate when a pipeline stage hands control to a
	// shell interpreter (e.g. `curl ... | bash`).
	if (hasPipeToShell(tokens)) {
		reasons.push("pipe to a shell (possible remote code execution)");
		severity = "high";
	}

	// Segment analysis (split on &&, ||, ; and pipeline stages)
	const segments = splitOnOps(tokens, ["&&", "||", ";", "|"]);
	for (const seg of segments) {
		const segRisk = analyzeSegment(seg);
		if (!segRisk) continue;
		if (segRisk.severity === "high") severity = "high";
		for (const r of segRisk.reasons) reasons.push(r);
	}

	// De-duplicate reasons
	const uniq = [...new Set(reasons)];
	if (uniq.length === 0) return null;
	return { severity, reasons: uniq };
}

type CommandLineKind = "start" | "operator" | "newline";

type CommandLine = {
	kind: CommandLineKind;
	op?: string;
	text: string;
};

/** True when an unquoted here-document operator (`<<` / `<<-`) appears. */
function hasTopLevelHereDoc(command: string): boolean {
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote === "'") {
			if (ch === "'") quote = null;
			continue;
		}
		if (quote === '"') {
			if (ch === "\\") i++;
			else if (ch === '"') quote = null;
			continue;
		}
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "<" && command[i + 1] === "<") return true;
	}
	return false;
}

/**
 * Reflow a shell command into display lines without changing its semantics.
 *
 * Top-level `|`, `|&`, `&&` and `||` start a new indented line so long pipe
 * chains are readable; `;`, `&` and newlines start a fresh command line.
 * Content inside quotes, `$(...)`, subshells, backticks and here-documents is
 * left untouched. This is presentation only: the command that runs is still
 * the exact original string.
 */
function formatCommandLines(command: string): CommandLine[] {
	if (hasTopLevelHereDoc(command)) {
		return command.split("\n").map((text, i) => ({
			kind: i === 0 ? "start" : "newline",
			text: text.replace(/\s+$/, ""),
		}));
	}

	const connectors = new Set(["|", "|&", "&&", "||"]);
	const lines: CommandLine[] = [];
	let current = "";
	let pendingOp: string | undefined;
	let started = false;
	let depth = 0; // $(), subshells

	const flush = (): void => {
		const text = current.trim();
		current = "";
		if (!text) return;
		if (!started) {
			lines.push({ kind: "start", text });
			started = true;
		} else if (pendingOp) {
			lines.push({ kind: "operator", op: pendingOp, text });
		} else {
			lines.push({ kind: "newline", text });
		}
		pendingOp = undefined;
	};

	let i = 0;
	while (i < command.length) {
		const ch = command[i];

		// Single-quoted string.
		if (ch === "'") {
			current += ch;
			i++;
			while (i < command.length) {
				const c = command[i];
				current += c;
				i++;
				if (c === "'") break;
			}
			continue;
		}

		// Double-quoted string (backslash escapes the next character).
		if (ch === '"') {
			current += ch;
			i++;
			while (i < command.length) {
				const c = command[i];
				if (c === "\\") {
					current += c;
					i++;
					if (i < command.length) current += command[i++];
					continue;
				}
				current += c;
				i++;
				if (c === '"') break;
			}
			continue;
		}

		// Backtick command substitution.
		if (ch === "`") {
			current += ch;
			i++;
			while (i < command.length) {
				const c = command[i];
				if (c === "\\") {
					current += c;
					i++;
					if (i < command.length) current += command[i++];
					continue;
				}
				current += c;
				i++;
				if (c === "`") break;
			}
			continue;
		}

		// Track nesting so operators inside substitutions/subshells stay intact.
		if (ch === "$" && command[i + 1] === "(") {
			current += "$(";
			depth++;
			i += 2;
			continue;
		}
		if (ch === "(") {
			depth++;
			current += ch;
			i++;
			continue;
		}
		if (ch === ")") {
			if (depth > 0) depth--;
			current += ch;
			i++;
			continue;
		}

		// Backslash escape, including line continuation.
		if (ch === "\\") {
			if (command[i + 1] === "\n") {
				i += 2;
				while (i < command.length && (command[i] === " " || command[i] === "\t")) i++;
				continue;
			}
			current += ch;
			i++;
			if (i < command.length) current += command[i++];
			continue;
		}

		if (ch === "\n") {
			if (depth === 0) flush();
			else current += ch;
			i++;
			continue;
		}

		// Top-level control operators.
		if (depth === 0 && (ch === "|" || ch === "&" || ch === ";")) {
			const trimmed = current.replace(/\s+$/, "");
			// Don't split `>&2` / `<&0` style redirections.
			if (ch === "&" && /[<>]$/.test(trimmed)) {
				current += ch;
				i++;
				continue;
			}
			let op = ch;
			if (ch === "|" && command[i + 1] === "&") op = "|&";
			else if ((ch === "|" || ch === "&") && command[i + 1] === ch) op = ch + ch;
			flush();
			pendingOp = connectors.has(op) ? op : undefined;
			i += op.length;
			while (i < command.length && (command[i] === " " || command[i] === "\t")) i++;
			continue;
		}

		current += ch;
		i++;
	}

	flush();

	if (lines.length === 0) return [{ kind: "start", text: command.trim() }];
	return lines;
}

/**
 * Renders a shell command as a readable, syntax-highlighted block: a `$` prompt,
 * pipeline-aware line breaks and indentation. Purely presentational.
 */
class CommandPreview implements Component {
	private readonly command: string;
	private readonly theme: any;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(command: string, theme: any) {
		this.command = command;
		this.theme = theme;
	}

	render(width: number): string[] {
		if (this.cachedLines !== undefined && this.cachedWidth === width) return this.cachedLines;
		this.cachedLines = this.buildLines(width);
		this.cachedWidth = width;
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private buildLines(width: number): string[] {
		const { theme } = this;
		const out: string[] = [];

		for (const line of formatCommandLines(this.command)) {
			let prefix: string;
			if (line.kind === "start") {
				prefix = theme.fg("success", theme.bold("$ "));
			} else if (line.kind === "operator") {
				prefix = theme.fg("accent", `  ${line.op} `);
			} else {
				prefix = "  ";
			}

			const prefixWidth = visibleWidth(prefix);
			const available = Math.max(1, width - prefixWidth);
			const pad = " ".repeat(prefixWidth);

			const wrapped: string[] = [];
			for (const highlighted of highlightCode(line.text, "bash")) {
				wrapped.push(...wrapTextWithAnsi(highlighted, available));
			}

			if (wrapped.length === 0) {
				out.push(prefix.trimEnd());
				continue;
			}
			wrapped.forEach((text, idx) => out.push((idx === 0 ? prefix : pad) + text));
		}

		return out;
	}
}

async function promptRunOrAbort(ctx: any, command: string, risk: Risk): Promise<"run" | "abort"> {
	if (!ctx.hasUI) return "abort";

	const items: SelectItem[] = [
		{ value: "run", label: "Run", description: "Execute the command" },
		{ value: "abort", label: "Abort", description: "Block this command" },
	];

	const choice = await ctx.ui.custom<"run" | "abort">((tui, theme, _kb, done) => {
		const severityColor = risk.severity === "high" ? "error" : "warning";

		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("warning", s)));
		container.addChild(new Text(theme.fg("warning", theme.bold("Potentially destructive bash command")), 1, 0));
		container.addChild(new Text(theme.fg(severityColor, theme.bold(`${risk.severity.toUpperCase()} risk`)), 1, 0));
		container.addChild(
			new Text(
				risk.reasons
					.map((r) => `${theme.fg(severityColor, "•")} ${theme.fg("muted", r)}`)
					.join("\n"),
				1,
				0,
			),
		);
		container.addChild(new Spacer(1));

		const commandBox = new Box(1, 1, (s: string) => theme.bg("toolPendingBg", s));
		commandBox.addChild(new CommandPreview(command, theme));
		container.addChild(commandBox);
		container.addChild(new Spacer(1));

		const list = new SelectList(items, items.length, {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		});

		list.onSelect = (item) => done(item.value as "run" | "abort");
		list.onCancel = () => done("abort");
		container.addChild(list);

		container.addChild(new DynamicBorder((s: string) => theme.fg("warning", s)));

		return {
			render: (w) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	}, { overlay: true });

	return choice ?? "abort";
}

// PI_SUBAGENT_DEPTH is 0 (or unset) in the main session and >= 1 in spawned subagent processes.
// Behaviour branches on this: interactive prompting in the main session, headless hard-block
// for catastrophic operations in subagents (where stdin is /dev/null and no UI is available).
const _subagentDepth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
const _isSubagent = Number.isFinite(_subagentDepth) && _subagentDepth >= 1;

// Hard-block patterns for subagent (headless) mode. Criteria: unrecoverable by default AND
// unlikely to be intentional in an automated context. Fewer false positives over broad coverage —
// the interactive prompt handles the rest for main sessions.
const HEADLESS_BLOCKED: Array<{ pattern: RegExp; reason: string }> = [
	// Recursive deletion
	{ pattern: /(?<!\bgit\s+)\brm\b[^#\n]*\s-(?:[a-zA-Z]*[rR]|-\brecursive\b)/, reason: "recursive delete (rm -r / -rf / -Rf)" },
	// Privilege escalation
	{ pattern: /\bsudo\b/, reason: "elevated privileges (sudo)" },
	// Remote code execution via pipe-to-shell
	{ pattern: /\b(curl|wget)\b[^#\n]*\|\s*(ba?sh|zsh|fish|dash|sh)\b/, reason: "pipe to shell (remote code execution)" },
	// Disk / filesystem destruction
	{ pattern: /\bmkfs/, reason: "filesystem formatting (mkfs)" },
	{ pattern: /\bnewfs_\w+/, reason: "filesystem formatting (newfs_*)" },
	{ pattern: /\bwipefs\b/, reason: "disk signature wipe" },
	{ pattern: /\bdiskutil\s+(erase|zeroDisk|secureErase|reformat)/i, reason: "destructive disk operation (diskutil)" },
	{ pattern: /\bdd\b[^#\n]*\bof=\/dev\//, reason: "raw disk write (dd of=/dev/...)" },
	{ pattern: /\b(parted|fdisk|gdisk|sgdisk)\b/, reason: "partition table management" },
	{ pattern: /\bcryptsetup\b/, reason: "disk encryption management" },
	{ pattern: /\bzpool\b/, reason: "ZFS pool management" },
	// System power
	{ pattern: /\b(shutdown|reboot|halt|poweroff)\b/, reason: "system power operation" },
	// Infrastructure teardown
	{ pattern: /\bterraform\s+destroy\b/, reason: "infrastructure teardown (terraform destroy)" },
	{ pattern: /\bkubectl\s+delete\b/, reason: "Kubernetes resource deletion" },
	{ pattern: /\baws\s+s3\s+rm\b[^#\n]*--recursive/, reason: "bulk S3 deletion (aws s3 rm --recursive)" },
	// Destructive git operations
	{ pattern: /\bgit\s+commit\b/, reason: "git commit (commits are main-session operations)" },
	{ pattern: /\bgit\s+pull\b/, reason: "git pull (pulls are main-session operations)" },
	{ pattern: /\bgit\s+push\b/, reason: "git push (pushes are main-session operations)" },
	{ pattern: /\bgit\s+reset\b[^#\n]*--hard\b/, reason: "discard all uncommitted changes (git reset --hard)" },
	{ pattern: /\bgit\s+clean\b[^#\n]*-[a-zA-Z]*f/, reason: "delete untracked files (git clean -f)" },
	{ pattern: /\bgit\s+reflog\s+expire\b/, reason: "expire reflog (removes recovery history)" },
	{ pattern: /\bgit\s+gc\b[^#\n]*--prune\b/, reason: "prune unreachable objects (git gc --prune)" },
];

// Subset of HEADLESS_BLOCKED used as the hard-block floor when bash-guard is
// disabled in an interactive (main) session. The user explicitly opts into
// autonomy here, so routine git operations (commit/pull/push) are allowed
// through; only truly catastrophic / non-recoverable patterns remain blocked.
const MAIN_DISABLED_BLOCKED: Array<{ pattern: RegExp; reason: string }> = HEADLESS_BLOCKED.filter(
	({ pattern }) => {
		const src = pattern.source;
		return !(
			src.includes("git\\s+commit") ||
			src.includes("git\\s+pull") ||
			// Keep `git push --force` blocked but allow plain `git push`.
			src === "\\bgit\\s+push\\b"
		);
	},
);

// Warning shown via ctx.ui.setStatus when bash-guard is disabled. Pi joins all
// extension statuses on a single line sorted alphabetically by key, so:
//
// - Key has a leading space so it sorts before any letter-keyed extension,
//   guaranteeing the warning stays visible (truncateToWidth chops the right).
// - We deliberately do NOT pad the text to full width — that would push other
//   extensions' statuses off-screen via truncation.
// - Background is truecolor pure red (#FF0000) instead of the basic palette
//   color 41 (which terminals remap per theme, often appearing brown/orange).
//   Foreground is truecolor white for high contrast on pure red.
// - NBSPs (U+00A0) handle intra-warning spacing because the footer's
//   sanitizeStatusText collapses runs of ASCII spaces via / +/g.
const BASH_GUARD_STATUS_KEY = " bash-guard";

export default function (pi: ExtensionAPI) {
	if (_isSubagent) {
		// Subagent mode: hard-block catastrophic operations, no prompting.
		pi.on("tool_call", async (event) => {
			if (!isToolCallEventType("bash", event)) return;
			const command = event.input.command;
			for (const { pattern, reason } of HEADLESS_BLOCKED) {
				if (pattern.test(command)) {
					return {
						block: true,
						reason:
							`Blocked by bash-guard: ${reason}. ` +
							"This is a non-interactive subagent session — catastrophic operations are not permitted. " +
							"Propose a safer alternative or ask the parent agent to confirm with the user.",
					};
				}
			}
		});
		return;
	}

	// Main session mode: interactive prompting.
	pi.registerFlag("bash-guard-auto-allow", {
		description: "If set, bash-guard will not block when no UI is available (non-interactive modes).",
		type: "boolean",
		default: false,
	});

	pi.registerFlag("bash-guard-disabled", {
		description: "Start the session with bash-guard disabled (autonomous mode; hard-block floor still applies).",
		type: "boolean",
		default: false,
	});

	// Session-local toggle. Intentionally not persisted across reloads or restarts.
	let disabled = false;

	pi.on("session_start", async (event, ctx) => {
		if (event.reason === "startup" && pi.getFlag("--bash-guard-disabled") === true) {
			disabled = true;
			const { theme } = ctx.ui;
			const badge = theme.bg(
				"toolErrorBg",
				theme.bold(theme.fg("error", " ⚠ BG OFF ")),
			);
			ctx.ui.setStatus(BASH_GUARD_STATUS_KEY, badge);
		}
	});

	pi.registerCommand("bash-guard", {
		description: "Toggle bash-guard between interactive (default) and disabled (autonomous) for this session.",
		handler: async (_args, ctx) => {
			disabled = !disabled;
			if (disabled) {
				const { theme } = ctx.ui;
				const badge = theme.bg(
					"toolErrorBg",
					theme.bold(theme.fg("error", " ⚠ BG OFF ")),
				);
				ctx.ui.setStatus(BASH_GUARD_STATUS_KEY, badge);
				ctx.ui.notify(
					"bash-guard DISABLED for this session. Catastrophic operations are still hard-blocked. Run /bash-guard again to re-enable.",
					"warning",
				);
			} else {
				ctx.ui.setStatus(BASH_GUARD_STATUS_KEY, undefined);
				ctx.ui.notify("bash-guard re-enabled.", "info");
			}
		},
	});

	// Avoid annoying retry loops: if the exact command was aborted recently, auto-block it.
	const recentlyAborted = new Map<string, number>();
	const ABORT_REMEMBER_MS = 60_000;

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;

		const command = event.input.command;

		// Disabled (autonomous) mode: skip interactive prompting entirely, but keep
		// a hard-block floor for catastrophic operations.
		if (disabled) {
			for (const { pattern, reason } of MAIN_DISABLED_BLOCKED) {
				if (pattern.test(command)) {
					return {
						block: true,
						reason:
							`Blocked by bash-guard (disabled-mode floor): ${reason}. ` +
							"Even with bash-guard disabled, this pattern is considered too destructive to run unattended. " +
							"Re-enable bash-guard with /bash-guard and confirm interactively, or propose a safer alternative.",
					};
				}
			}
			return;
		}

		const risk = analyzeBashCommand(command);
		if (!risk) return;

		const now = Date.now();
		const lastAbort = recentlyAborted.get(command);
		if (lastAbort && now - lastAbort < ABORT_REMEMBER_MS) {
			return {
				block: true,
				reason:
					"Blocked by bash-guard: command was already aborted recently. Ask the user for a safer alternative; do not retry the same command.",
			};
		}

		if (!ctx.hasUI && pi.getFlag("--bash-guard-auto-allow")) {
			// Non-interactive mode: allow when explicitly requested.
			return;
		}

		const choice = await promptRunOrAbort(ctx, command, risk);
		if (choice === "run") return;

		recentlyAborted.set(command, now);
		return {
			block: true,
			reason:
				"Blocked by user via bash-guard (potentially destructive command). Ask the user for confirmation or propose a non-destructive alternative.",
		};
	});
}
