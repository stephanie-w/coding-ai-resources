/**
 * Subagent discovery and configuration.
 *
 * Adapted from the upstream subagent example, extended with:
 * - `subagents/*.md` directories alongside `agents/*.md` at every level.
 * - A bundled "catalog" directory next to this extension (shipped defaults).
 * - `thinking`, `direct_tool`, and `guidelines` frontmatter fields.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "user" | "project" | "catalog";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	/** Thinking level override, compressed to an integer 0-3 (0=off, 1=low, 2=medium, 3=high). */
	thinking?: number;
	/** When true, also register a dedicated top-level tool for this agent. */
	directTool: boolean;
	guidelines?: string[];
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDirs: string[];
}

/** Directory containing this extension; bundled catalog agents live here. */
const extensionDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Raw agent frontmatter. Values are `unknown` because `parseFrontmatter` runs a
 * real YAML parser, so any scalar or collection can appear here.
 *
 * A type alias rather than an interface: `parseFrontmatter` constrains its
 * parameter to `Record<string, unknown>`, and only an alias picks up the
 * implicit index signature that satisfies it.
 */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	thinking?: unknown;
	direct_tool?: unknown;
	guidelines?: unknown;
};

/**
 * Normalize a frontmatter `tools` value to a list of tool names.
 *
 * Both spellings are valid YAML and both are in use:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 *
 * so accept either. Anything else yields no tools rather than throwing: this
 * runs inside agent discovery, where a single bad file must not take down
 * every other agent in the same directory.
 */
function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

/** Accept a single string or an array of strings (YAML is loose about this). */
function parseStringList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
	const items = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return items.length > 0 ? items : undefined;
}

/** Thinking level as an integer 0-3, accepted from YAML number or numeric string. */
function parseThinking(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		const n = Math.round(value);
		if (n >= 0 && n <= 3) return n;
	}
	if (typeof value === "string") {
		const n = Number.parseInt(value, 10);
		if (Number.isFinite(n) && n >= 0 && n <= 3) return n;
	}
	return undefined;
}

function parseBool(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const v = value.trim().toLowerCase();
		if (v === "true" || v === "yes" || v === "1") return true;
		if (v === "false" || v === "no" || v === "0") return false;
	}
	if (typeof value === "number") return value !== 0;
	return undefined;
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);

		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
			continue;
		}

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			thinking: parseThinking(frontmatter.thinking),
			directTool: parseBool(frontmatter.direct_tool) ?? false,
			guidelines: parseStringList(frontmatter.guidelines),
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Walk from cwd to the filesystem root, collecting every ancestor directory
 * that has `.pi/agents` or `.pi/subagents`. Nearest ancestor is listed first so
 * nearer definitions win on name collisions (monorepo-friendly).
 */
function findProjectAgentDirs(cwd: string): string[] {
	const dirs: string[] = [];
	let current = cwd;
	while (true) {
		const base = path.join(current, CONFIG_DIR_NAME);
		for (const sub of ["agents", "subagents"]) {
			const candidate = path.join(base, sub);
			if (isDirectory(candidate)) dirs.push(candidate);
		}
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return dirs;
}

/**
 * Discover subagents across the three levels.
 *
 * Precedence (lowest to highest): catalog < user < project. Catalog agents
 * ship with this extension and are always loaded; the `scope` only toggles
 * user-level vs project-level directories.
 */
export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDirs = [path.join(getAgentDir(), "agents"), path.join(getAgentDir(), "subagents")];
	const projectDirs = findProjectAgentDirs(cwd);
	const catalogDirs = [path.join(extensionDir, "agents"), path.join(extensionDir, "subagents")];

	const agentMap = new Map<string, AgentConfig>();

	// Catalog first (lowest precedence).
	for (const dir of catalogDirs) {
		for (const agent of loadAgentsFromDir(dir, "catalog")) agentMap.set(agent.name, agent);
	}

	// User next.
	if (scope !== "project") {
		for (const dir of userDirs) {
			for (const agent of loadAgentsFromDir(dir, "user")) agentMap.set(agent.name, agent);
		}
	}

	// Project last (highest precedence).
	if (scope !== "user") {
		for (const dir of projectDirs) {
			for (const agent of loadAgentsFromDir(dir, "project")) agentMap.set(agent.name, agent);
		}
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDirs: projectDirs };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
