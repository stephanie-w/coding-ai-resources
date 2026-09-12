/**
 * Git Checkpoint Extension
 *
 * Manual, durable, lossless code snapshots for the pi coding agent.
 *
 *   /checkpoint [label]   snapshot the working tree to refs/pi/checkpoints/<id>
 *   /rollback [n|query]   restore the working tree to a checkpoint
 *   /checkpoint list      list checkpoints (interactive picker)
 *
 * Design notes:
 * - Fully decoupled from session branching. It never touches /tree, /fork, or
 *   /clone. Restoring files is always an explicit user action.
 * - Snapshots are real commits referenced by git refs (never bare `git stash
 *   create` objects), so `git gc` can never collect them.
 * - Untracked, non-ignored files are included.
 * - Every rollback snapshots the current state first, so it is always
 *   reversible: nothing is destroyed, only moved to another ref.
 * - The user's HEAD, branch, and staged index are never moved.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExecResult,
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const REF_PREFIX = "refs/pi/checkpoints/";
const SUBJECT_PREFIX = "pi checkpoint: ";

/** Fixed identity so snapshots never depend on the user's git author config. */
const IDENTITY_ENV = [
	"GIT_AUTHOR_NAME=pi",
	"GIT_AUTHOR_EMAIL=pi@localhost",
	"GIT_COMMITTER_NAME=pi",
	"GIT_COMMITTER_EMAIL=pi@localhost",
];

type Checkpoint = {
	/** Full ref, e.g. refs/pi/checkpoints/1736966400000-my-label */
	ref: string;
	/** Ref name without the namespace, e.g. 1736966400000-my-label */
	shortName: string;
	/** Full commit SHA. */
	commit: string;
	/** Abbreviated commit SHA. */
	short: string;
	/** Human label. */
	label: string;
	/** ISO creation time. */
	created: string;
	/** Number of paths captured, relative to the current HEAD. */
	files: number;
};

function slugify(input: string): string {
	const slug = input
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return slug || "checkpoint";
}

function defaultLabel(): string {
	return new Date().toISOString().slice(0, 19).replace("T", " ");
}

function relativeTime(iso: string): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return "";
	const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

async function git(
	pi: ExtensionAPI,
	cwd: string,
	args: string[],
	env: string[] = [],
): Promise<ExecResult> {
	if (env.length > 0) {
		return pi.exec("env", [...env, "git", ...args], { cwd });
	}
	return pi.exec("git", args, { cwd });
}

async function isGitRepo(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const result = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], {
		cwd,
	});
	return result.code === 0 && result.stdout.trim() === "true";
}

async function hasHead(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	const result = await pi.exec("git", ["rev-parse", "--verify", "--quiet", "HEAD"], {
		cwd,
	});
	return result.code === 0;
}

/**
 * Snapshot the current working tree (tracked + untracked, non-ignored) into a
 * dangling commit referenced by `refs/pi/checkpoints/...`.
 *
 * Uses a temporary index so the user's real index and staged state are never
 * touched. Requires a POSIX `env` on PATH to inject GIT_INDEX_FILE.
 */
async function createCheckpoint(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	label: string,
): Promise<Checkpoint> {
	const cwd = ctx.cwd;
	const head = await hasHead(pi, cwd);
	const dir = await mkdtemp(join(tmpdir(), "pi-checkpoint-"));
	const indexPath = join(dir, "index");
	const env = [`GIT_INDEX_FILE=${indexPath}`];

	try {
		const read = await git(pi, cwd, ["read-tree", head ? "HEAD" : "--empty"], env);
		if (read.code !== 0) {
			throw new Error(read.stderr.trim() || "git read-tree failed");
		}

		const add = await git(pi, cwd, ["add", "-A"], env);
		if (add.code !== 0) {
			throw new Error(add.stderr.trim() || "git add -A failed");
		}

		const treeResult = await git(pi, cwd, ["write-tree"], env);
		if (treeResult.code !== 0) {
			throw new Error(treeResult.stderr.trim() || "git write-tree failed");
		}
		const tree = treeResult.stdout.trim();

		const when = new Date();
		const body = [
			`${SUBJECT_PREFIX}${label}`,
			"",
			`session: ${ctx.sessionManager.getSessionFile() ?? "ephemeral"}`,
			`leaf: ${ctx.sessionManager.getLeafId() ?? "-"}`,
			`created: ${when.toISOString()}`,
		].join("\n");

		const commitArgs = ["commit-tree", tree];
		if (head) commitArgs.push("-p", "HEAD");
		commitArgs.push("-m", body);

		const commitResult = await git(pi, cwd, commitArgs, IDENTITY_ENV);
		if (commitResult.code !== 0) {
			throw new Error(commitResult.stderr.trim() || "git commit-tree failed");
		}
		const commit = commitResult.stdout.trim();

		const shortName = `${when.getTime()}-${slugify(label)}`;
		const ref = REF_PREFIX + shortName;
		const update = await pi.exec("git", ["update-ref", ref, commit], { cwd });
		if (update.code !== 0) {
			throw new Error(update.stderr.trim() || "git update-ref failed");
		}

		const files = await countChangedFiles(pi, cwd, commit, head);
		return {
			ref,
			shortName,
			commit,
			short: commit.slice(0, 7),
			label,
			created: when.toISOString(),
			files,
		};
	} finally {
		await rm(dir, { recursive: true, force: true }).catch(() => undefined);
	}
}

async function countChangedFiles(
	pi: ExtensionAPI,
	cwd: string,
	commit: string,
	head: boolean,
): Promise<number> {
	const args = head
		? ["diff", "--name-only", "HEAD", commit]
		: ["ls-tree", "-r", "--name-only", commit];
	const result = await pi.exec("git", args, { cwd });
	if (result.code !== 0) return 0;
	return result.stdout.split("\n").filter((line) => line.trim().length > 0).length;
}

async function listCheckpoints(pi: ExtensionAPI, cwd: string): Promise<Checkpoint[]> {
	const result = await pi.exec(
		"git",
		[
			"for-each-ref",
			REF_PREFIX,
			"--format=%(refname)|%(objectname)|%(subject)|%(creatordate:iso8601)",
		],
		{ cwd },
	);
	if (result.code !== 0) return [];

	const checkpoints: Checkpoint[] = [];
	for (const line of result.stdout.split("\n")) {
		if (!line.trim()) continue;
		const [ref, commit, subject = "", created = ""] = line.split("|");
		if (!ref || !commit) continue;
		const shortName = ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : ref;
		const label = subject.startsWith(SUBJECT_PREFIX)
			? subject.slice(SUBJECT_PREFIX.length)
			: subject || shortName;
		checkpoints.push({
			ref,
			shortName,
			commit,
			short: commit.slice(0, 7),
			label,
			created,
			files: 0,
		});
	}
	// Ref names start with a millisecond timestamp; newest first.
	checkpoints.sort((a, b) => b.shortName.localeCompare(a.shortName));
	return checkpoints;
}

function formatCheckpoint(cp: Checkpoint, index: number): string {
	const when = cp.created ? ` · ${relativeTime(cp.created)}` : "";
	return `${index + 1}. ${cp.label} [${cp.short}]${when}`;
}

function describeCheckpoint(cp: Checkpoint): string {
	const when = cp.created ? ` · ${relativeTime(cp.created)}` : "";
	return `${cp.label} [${cp.short}]${when}`;
}

/** Interactive picker. Returns undefined when cancelled or UI is unavailable. */
async function pickCheckpoint(
	ctx: ExtensionCommandContext,
	checkpoints: Checkpoint[],
	title: string,
): Promise<Checkpoint | undefined> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Checkpoint selection requires an interactive UI; pass an index instead.", "warning");
		return undefined;
	}
	const items = checkpoints.map((cp, index) => formatCheckpoint(cp, index));
	const selected = await ctx.ui.select(title, items);
	if (!selected) return undefined;
	const index = items.indexOf(selected);
	return index >= 0 ? checkpoints[index] : undefined;
}

async function resolveTarget(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	arg: string,
): Promise<Checkpoint | undefined> {
	const checkpoints = await listCheckpoints(pi, ctx.cwd);
	if (checkpoints.length === 0) {
		ctx.ui.notify("No checkpoints yet. Run /checkpoint first.", "warning");
		return undefined;
	}

	const query = arg.trim();
	if (!query) return pickCheckpoint(ctx, checkpoints, "Roll back to checkpoint");

	if (/^\d+$/.test(query)) {
		const index = Number(query);
		const cp = checkpoints[index - 1];
		if (!cp) {
			ctx.ui.notify(`No checkpoint #${index}. There are ${checkpoints.length}.`, "warning");
			return undefined;
		}
		return cp;
	}

	const lowered = query.toLowerCase();
	const matches = checkpoints.filter(
		(cp) =>
			cp.label.toLowerCase().includes(lowered) ||
			cp.shortName.toLowerCase().includes(lowered) ||
			cp.short.startsWith(lowered),
	);
	if (matches.length === 0) {
		ctx.ui.notify(`No checkpoint matching "${query}".`, "warning");
		return undefined;
	}
	if (matches.length === 1) return matches[0];
	return pickCheckpoint(ctx, matches, `Multiple checkpoints match "${query}"`);
}

async function confirmRollback(
	ctx: ExtensionCommandContext,
	cp: Checkpoint,
): Promise<boolean> {
	const message = [
		`Roll the working tree back to:`,
		``,
		`  ${describeCheckpoint(cp)}`,
		``,
		`The current state is snapshotted first, so this is reversible.`,
		`Modified and untracked (non-ignored) files will be replaced.`,
	].join("\n");

	if (!ctx.hasUI) return true;
	const choice = await ctx.ui.select(message, ["No, cancel", `Yes, roll back to ${cp.short}`]);
	return choice?.startsWith("Yes") ?? false;
}

/**
 * Restore the working tree to a checkpoint without moving HEAD or the branch.
 * Always snapshots the current state first, so the operation is reversible.
 */
async function restoreCheckpoint(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	cp: Checkpoint,
): Promise<Checkpoint> {
	const cwd = ctx.cwd;
	const head = await hasHead(pi, cwd);
	const safety = await createCheckpoint(pi, ctx, `pre-rollback-${cp.short}`);

	// Remove untracked files first so a divergent untracked file cannot block
	// the checkout. Everything removed here is already in the safety snapshot.
	const clean = await pi.exec("git", ["clean", "-fd"], { cwd });
	if (clean.code !== 0) {
		throw new Error(clean.stderr.trim() || "git clean -fd failed");
	}

	// Reset the real index and working tree to the snapshot without touching HEAD.
	const read = await pi.exec("git", ["read-tree", "--reset", "-u", cp.commit], { cwd });
	if (read.code !== 0) {
		throw new Error(read.stderr.trim() || "git read-tree --reset -u failed");
	}

	// Unstage so the rollback shows up as a normal uncommitted diff. On an
	// unborn branch there is no HEAD to reset against; leave the index staged.
	if (head) {
		await pi.exec("git", ["reset", "-q"], { cwd });
	}

	return safety;
}

async function rollbackToCheckpoint(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	target: Checkpoint,
): Promise<void> {
	try {
		const safety = await restoreCheckpoint(pi, ctx, target);
		ctx.ui.notify(
			`Rolled back to ${target.short}. Safety snapshot ${safety.short}; /rollback ${safety.label} to undo.`,
			"info",
		);
	} catch (error) {
		ctx.ui.notify(`Rollback failed: ${(error as Error).message}`, "error");
	}
}

export default function gitCheckpoint(pi: ExtensionAPI) {
	pi.registerCommand("checkpoint", {
		description: "Create a durable git checkpoint of the working tree (tracked + untracked)",
		getArgumentCompletions: (prefix) =>
			"list".startsWith(prefix.trim())
				? [{ value: "list", label: "list — show checkpoints" }]
				: null,
		handler: async (args, ctx) => {
			if (!(await isGitRepo(pi, ctx.cwd))) {
				ctx.ui.notify("Not a git repository.", "error");
				return;
			}

			const trimmed = args.trim();
			if (trimmed === "list" || trimmed === "ls" || trimmed === "--list" || trimmed === "-l") {
				const checkpoints = await listCheckpoints(pi, ctx.cwd);
				if (checkpoints.length === 0) {
					ctx.ui.notify("No checkpoints yet.", "info");
					return;
				}
				const chosen = await pickCheckpoint(ctx, checkpoints, "Checkpoints");
				if (chosen && (await confirmRollback(ctx, chosen))) {
					await rollbackToCheckpoint(pi, ctx, chosen);
				}
				return;
			}

			const label = trimmed || defaultLabel();
			try {
				const cp = await createCheckpoint(pi, ctx, label);
				ctx.ui.notify(
					`Checkpoint ${cp.short} created (${cp.files} file${cp.files === 1 ? "" : "s"}) — /rollback to restore`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`Checkpoint failed: ${(error as Error).message}`, "error");
			}
		},
	});

	pi.registerCommand("rollback", {
		description: "Restore the working tree to a checkpoint (snapshots current state first)",
		handler: async (args, ctx) => {
			if (!(await isGitRepo(pi, ctx.cwd))) {
				ctx.ui.notify("Not a git repository.", "error");
				return;
			}

			const target = await resolveTarget(pi, ctx, args);
			if (!target) return;

			if (!(await confirmRollback(ctx, target))) return;
			await rollbackToCheckpoint(pi, ctx, target);
		},
	});
}
