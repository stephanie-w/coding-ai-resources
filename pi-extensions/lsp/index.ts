/**
 * pi-lsp — Unified Language Server Protocol & Code Intelligence Extension.
 *
 * Dual-Backend Architecture:
 *   1. Editor-Attached Mode ($NVIM is set):
 *      Routes requests via MessagePack-RPC to the parent Neovim session's active vim.lsp client.
 *      Shares warm project indices, unsaved buffer states, and custom user editor configurations
 *      with 0ms startup and 0 MB extra RAM.
 *   2. Standalone Headless Mode ($NVIM is unset):
 *      Spawns and manages headless language servers over JSON-RPC (stdio) on-demand for CLI, tmux,
 *      and subagent child sessions.
 *
 * Unified Tool Contract:
 *   - lsp_definition: Go to definition or declaration with file location and preview snippet.
 *   - lsp_references: Find all usages, references, and call sites across the project.
 *   - lsp_symbols: Document symbol outline (classes, methods, functions) or workspace symbol search.
 *   - lsp_call_hierarchy: Incoming callers (who calls this) and outgoing callees (what this calls).
 *   - lsp_hover: Type annotations, inferred signatures, and docstrings for a symbol.
 *   - lsp_diagnostics: Query live compiler and linter diagnostics for a line or entire buffer.
 */

import { ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { connect, type Socket } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionContext,
	isEditToolResult,
	isWriteToolResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// 1. Data Models & LSP Kinds
// ---------------------------------------------------------------------------

export const LSP_SYMBOL_KINDS: Record<number, string> = {
	1: "File",
	2: "Module",
	3: "Namespace",
	4: "Package",
	5: "Class",
	6: "Method",
	7: "Property",
	8: "Field",
	9: "Constructor",
	10: "Enum",
	11: "Interface",
	12: "Function",
	13: "Variable",
	14: "Constant",
	15: "String",
	16: "Number",
	17: "Boolean",
	18: "Array",
	19: "Object",
	20: "Key",
	21: "Null",
	22: "EnumMember",
	23: "Struct",
	24: "Event",
	25: "Operator",
	26: "TypeParameter",
};

export interface LocationResult {
	file: string;
	relative_file: string;
	start_line: number;
	start_col: number;
	end_line: number;
	end_col: number;
	preview?: string;
}

export interface SymbolResult {
	name: string;
	kind: string;
	detail?: string;
	container?: string;
	depth?: number;
	start_line?: number;
	end_line?: number;
	location?: LocationResult;
}

export interface CallHierarchyResultItem {
	name: string;
	kind: string;
	detail?: string;
	file: string;
	relative_file: string;
	line: number;
	col: number;
	preview?: string;
}

export interface DiagnosticItem {
	file: string;
	relative_file: string;
	line: number;
	col: number;
	end_line?: number;
	end_col?: number;
	severity: "ERROR" | "WARN" | "INFO" | "HINT" | string;
	message: string;
	source?: string;
	code?: string | number;
}

function textResult(text: string, details: unknown): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

function errorResult(error: unknown): AgentToolResult<unknown> {
	const message = error instanceof Error ? error.message : String(error);
	return { content: [{ type: "text", text: `LSP Error: ${message}` }], details: { error: message } };
}

function shortenPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function uriToPath(uri: string): string {
	if (uri.startsWith("file://")) {
		try {
			return decodeURIComponent(new URL(uri).pathname);
		} catch {
			return uri.slice(7);
		}
	}
	return uri;
}

function pathToUri(filePath: string): string {
	const abs = path.resolve(filePath);
	return `file://${abs.startsWith("/") ? "" : "/"}${abs.replace(/\\/g, "/")}`;
}

function getPreviewLine(filePath: string, lineNr: number): string {
	if (lineNr <= 0) return "";
	try {
		if (!fs.existsSync(filePath)) return "";
		const content = fs.readFileSync(filePath, "utf-8");
		const lines = content.split("\n");
		if (lineNr <= lines.length) {
			return (lines[lineNr - 1] || "").trim();
		}
	} catch {
		// Ignore read errors for previews
	}
	return "";
}

function hasCommand(cmd: string): boolean {
	try {
		const { status } = spawnSync("which", [cmd], { stdio: "ignore" });
		return status === 0;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// 2. Standalone JSON-RPC stdio Client
// ---------------------------------------------------------------------------

interface PendingRpc {
	resolve: (val: unknown) => void;
	reject: (err: unknown) => void;
	timer: NodeJS.Timeout;
}

class JsonRpcStdioClient {
	public proc: ChildProcess | null = null;
	private buffer = Buffer.alloc(0);
	private nextId = 1;
	private pending = new Map<number, PendingRpc>();
	private notificationHandlers = new Map<string, Array<(params: unknown) => void>>();
	public isInitialized = false;
	public serverCapabilities: Record<string, unknown> = {};
	public name: string;
	public command: string;
	public args: string[];
	public cwd: string;

	constructor(name: string, command: string, args: string[], cwd: string) {
		this.name = name;
		this.command = command;
		this.args = args;
		this.cwd = cwd;
	}

	async start(): Promise<void> {
		if (this.proc && !this.proc.killed) return;

		this.proc = spawn(this.command, this.args, {
			cwd: this.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env },
		});

		this.proc.stdout?.on("data", (chunk: Buffer) => this.handleData(chunk));
		this.proc.stderr?.on("data", (_data: Buffer) => {
			// Language server stderr can be logged if debug is enabled
		});

		this.proc.on("error", (err) => {
			this.cleanup(err);
		});

		this.proc.on("exit", () => {
			this.cleanup(new Error("LSP server process exited"));
		});

		// Perform initialize handshake
		const initParams = {
			processId: process.pid,
			rootUri: pathToUri(this.cwd),
			rootPath: this.cwd,
			workspaceFolders: [
				{
					uri: pathToUri(this.cwd),
					name: path.basename(this.cwd),
				},
			],
			capabilities: {
				workspace: {
					symbol: { dynamicRegistration: false },
					workspaceFolders: true,
				},
				textDocument: {
					synchronization: {
						dynamicRegistration: false,
						willSave: false,
						willSaveWaitUntil: false,
						didSave: true,
						change: 1, // Full sync
					},
					hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
					definition: { dynamicRegistration: false, linkSupport: true },
					references: { dynamicRegistration: false },
					documentSymbol: {
						dynamicRegistration: false,
						hierarchicalDocumentSymbolSupport: true,
					},
					callHierarchy: { dynamicRegistration: false },
					publishDiagnostics: { relatedInformation: true },
				},
			},
			initializationOptions: {},
		};

		const initResult = await this.request<{ capabilities?: Record<string, unknown> }>("initialize", initParams, 12000);
		this.serverCapabilities = initResult?.capabilities || {};
		this.notify("initialized", {});
		this.isInitialized = true;
	}

	private handleData(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (true) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) break;
			const headerStr = this.buffer.subarray(0, headerEnd).toString("utf-8");
			const match = headerStr.match(/Content-Length:\s*(\d+)/i);
			if (!match) {
				this.buffer = this.buffer.subarray(headerEnd + 4);
				continue;
			}
			const contentLength = parseInt(match[1], 10);
			const bodyStart = headerEnd + 4;
			const totalMsgLength = bodyStart + contentLength;
			if (this.buffer.length < totalMsgLength) break;

			const bodyBytes = this.buffer.subarray(bodyStart, totalMsgLength);
			this.buffer = this.buffer.subarray(totalMsgLength);
			try {
				const msg = JSON.parse(bodyBytes.toString("utf-8"));
				this.handleMessage(msg);
			} catch {
				// Ignore malformed chunks
			}
		}
	}

	private handleMessage(msg: Record<string, unknown>): void {
		if (msg.id !== undefined && typeof msg.id === "number" && this.pending.has(msg.id)) {
			const { resolve, reject, timer } = this.pending.get(msg.id)!;
			this.pending.delete(msg.id);
			clearTimeout(timer);
			if (msg.error) {
				const errObj = msg.error as { message?: string };
				reject(new Error(errObj.message || JSON.stringify(msg.error)));
			} else {
				resolve(msg.result);
			}
		} else if (typeof msg.method === "string") {
			const handlers = this.notificationHandlers.get(msg.method);
			if (handlers) {
				for (const h of handlers) h(msg.params);
			}
		}
	}

	onNotification(method: string, handler: (params: unknown) => void): void {
		const list = this.notificationHandlers.get(method) || [];
		list.push(handler);
		this.notificationHandlers.set(method, list);
	}

	async request<T>(method: string, params: unknown, timeoutMs = 8000): Promise<T> {
		if (!this.proc || this.proc.killed) {
			await this.start();
		}
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`LSP request '${method}' timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			this.pending.set(id, {
				resolve: resolve as (val: unknown) => void,
				reject,
				timer,
			});

			const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
			const header = `Content-Length: ${Buffer.byteLength(payload, "utf-8")}\r\n\r\n`;
			this.proc?.stdin?.write(header + payload);
		});
	}

	notify(method: string, params: unknown): void {
		if (!this.proc || this.proc.killed) return;
		const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
		const header = `Content-Length: ${Buffer.byteLength(payload, "utf-8")}\r\n\r\n`;
		this.proc.stdin?.write(header + payload);
	}

	async shutdown(): Promise<void> {
		if (!this.proc || this.proc.killed) return;
		try {
			await this.request("shutdown", {}, 2000);
			this.notify("exit", {});
		} catch {
			// Best effort shutdown
		} finally {
			this.proc.kill("SIGTERM");
			this.cleanup(new Error("LSP client stopped"));
		}
	}

	private cleanup(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		this.proc = null;
		this.isInitialized = false;
	}
}

// ---------------------------------------------------------------------------
// 3. Headless LSP Manager (Multi-Language & Document Sync)
// ---------------------------------------------------------------------------

function resolveLanguageId(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase();
	switch (ext) {
		case ".py":
		case ".pyi":
			return "python";
		case ".ts":
			return "typescript";
		case ".tsx":
			return "typescriptreact";
		case ".js":
		case ".mjs":
		case ".cjs":
			return "javascript";
		case ".jsx":
			return "javascriptreact";
		case ".json":
			return "json";
		case ".rs":
			return "rust";
		case ".go":
			return "go";
		case ".c":
		case ".h":
			return "c";
		case ".cpp":
		case ".hpp":
		case ".cc":
			return "cpp";
		case ".sh":
		case ".bash":
			return "shellscript";
		default:
			return "plaintext";
	}
}

interface ServerDiscovery {
	name: string;
	command: string;
	args: string[];
	language: string;
}

function detectServerForLanguage(language: string, cwd: string): ServerDiscovery | null {
	if (language === "python") {
		const venvPyright = path.join(cwd, ".venv", "bin", "pyright-langserver");
		if (fs.existsSync(venvPyright)) {
			return { name: "pyright (.venv)", command: venvPyright, args: ["--stdio"], language: "python" };
		}
		if (hasCommand("uv") && (fs.existsSync(path.join(cwd, "pyproject.toml")) || fs.existsSync(path.join(cwd, "uv.lock")))) {
			return {
				name: "pyright (uv)",
				command: "uv",
				args: ["run", "--quiet", "--with", "pyright", "pyright-langserver", "--stdio"],
				language: "python",
			};
		}
		if (hasCommand("pyright-langserver")) {
			return { name: "pyright-langserver", command: "pyright-langserver", args: ["--stdio"], language: "python" };
		}
		if (hasCommand("ty")) {
			return { name: "ty", command: "ty", args: ["server"], language: "python" };
		}
		if (hasCommand("ruff")) {
			return { name: "ruff server", command: "ruff", args: ["server"], language: "python" };
		}
	} else if (
		language === "typescript" ||
		language === "typescriptreact" ||
		language === "javascript" ||
		language === "javascriptreact"
	) {
		if (hasCommand("vtsls")) {
			return { name: "vtsls", command: "vtsls", args: ["--stdio"], language };
		}
		if (hasCommand("typescript-language-server")) {
			return { name: "typescript-language-server", command: "typescript-language-server", args: ["--stdio"], language };
		}
		if (hasCommand("npx")) {
			return {
				name: "vtsls (npx)",
				command: "npx",
				args: ["--yes", "--quiet", "@vtsls/language-server", "--stdio"],
				language,
			};
		}
	} else if (language === "rust") {
		if (hasCommand("rust-analyzer")) {
			return { name: "rust-analyzer", command: "rust-analyzer", args: [], language: "rust" };
		}
	} else if (language === "go") {
		if (hasCommand("gopls")) {
			return { name: "gopls", command: "gopls", args: [], language: "go" };
		}
	}
	return null;
}

const COMMON_KEYWORDS = new Set([
	"async",
	"def",
	"class",
	"function",
	"fn",
	"pub",
	"export",
	"import",
	"from",
	"const",
	"let",
	"var",
	"public",
	"private",
	"protected",
	"static",
	"readonly",
	"return",
	"yield",
	"await",
	"if",
	"else",
	"elif",
	"for",
	"while",
	"try",
	"except",
	"catch",
	"finally",
	"with",
	"as",
	"in",
	"is",
	"not",
	"and",
	"or",
	"self",
	"this",
	"super",
	"struct",
	"enum",
	"trait",
	"interface",
	"type",
	"package",
]);

function findIdentifiersOnLine(lineText: string): Array<{ name: string; col: number }> {
	const regex = /[a-zA-Z_][a-zA-Z0-9_]*/g;
	const matches: Array<{ name: string; col: number }> = [];
	let m: RegExpExecArray | null;
	while ((m = regex.exec(lineText)) !== null) {
		if (!COMMON_KEYWORDS.has(m[0])) {
			matches.push({ name: m[0], col: m.index + 1 });
		}
	}
	return matches;
}

function resolveSymbolCoordinates(
	filePath: string,
	line?: number,
	col?: number,
	symbol?: string,
): { line: number; col: number; symbol?: string; alternativeCols: number[] } {
	let resolvedLine = line ?? 1;
	let resolvedCol = col ?? 1;
	const alternativeCols: number[] = [];

	try {
		if (fs.existsSync(filePath)) {
			const content = fs.readFileSync(filePath, "utf-8");
			const lines = content.split("\n");

			// If symbol is explicitly provided:
			if (symbol && symbol.trim().length > 0) {
				const sym = symbol.trim();
				// 1. If line is provided, search on that line first
				if (line && line > 0 && line <= lines.length) {
					const lineText = lines[line - 1] || "";
					const idx = lineText.indexOf(sym);
					if (idx !== -1) {
						return { line, col: idx + 1, symbol: sym, alternativeCols: [] };
					}
				}
				// 2. Search whole file for the symbol
				for (let i = 0; i < lines.length; i++) {
					const lineText = lines[i] || "";
					const idx = lineText.indexOf(sym);
					if (idx !== -1) {
						return { line: i + 1, col: idx + 1, symbol: sym, alternativeCols: [] };
					}
				}
			}

			// If line is provided:
			if (line && line > 0 && line <= lines.length) {
				const lineText = lines[line - 1] || "";
				const idents = findIdentifiersOnLine(lineText);
				for (const id of idents) {
					alternativeCols.push(id.col);
				}

				if (col === undefined) {
					if (idents.length > 0) {
						resolvedCol = idents[0].col;
					} else {
						const firstNonWs = lineText.search(/\S/);
						resolvedCol = firstNonWs !== -1 ? firstNonWs + 1 : 1;
					}
				} else {
					const matchingIdent = idents.find((id) => Math.abs(id.col - col) <= 2);
					if (matchingIdent) {
						resolvedCol = matchingIdent.col;
					}
				}
			}
		}
	} catch {
		// Fallback
	}

	return { line: resolvedLine, col: resolvedCol, symbol, alternativeCols };
}

class HeadlessLspManager {
	private servers = new Map<string, JsonRpcStdioClient>();
	private openDocs = new Map<string, { version: number; text: string; language: string; client: JsonRpcStdioClient }>();
	private diagnostics = new Map<string, DiagnosticItem[]>();
	public cwd: string;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	async getServerForFile(filePath: string): Promise<JsonRpcStdioClient | null> {
		const lang = resolveLanguageId(filePath);
		if (lang === "plaintext") return null;

		let client = this.servers.get(lang);
		if (client && client.isInitialized) return client;

		const spec = detectServerForLanguage(lang, this.cwd);
		if (!spec) return null;

		client = new JsonRpcStdioClient(spec.name, spec.command, spec.args, this.cwd);
		this.servers.set(lang, client);

		// Listen to diagnostics
		client.onNotification("textDocument/publishDiagnostics", (params: unknown) => {
			const p = params as { uri: string; diagnostics?: Array<Record<string, unknown>> };
			if (!p || !p.uri) return;
			const targetPath = uriToPath(p.uri);
			const severityNames: Record<number, string> = { 1: "ERROR", 2: "WARN", 3: "INFO", 4: "HINT" };
			const list: DiagnosticItem[] = (p.diagnostics || []).map((d) => {
				const range = (d.range as Record<string, { line: number; character: number }>) || {};
				const sl = (range.start?.line ?? 0) + 1;
				const sc = (range.start?.character ?? 0) + 1;
				const el = range.end ? range.end.line + 1 : undefined;
				const ec = range.end ? range.end.character + 1 : undefined;
				const sevNum = typeof d.severity === "number" ? d.severity : 1;
				return {
					file: targetPath,
					relative_file: path.relative(this.cwd, targetPath),
					line: sl,
					col: sc,
					end_line: el,
					end_col: ec,
					severity: severityNames[sevNum] || "ERROR",
					message: String(d.message || ""),
					source: d.source ? String(d.source) : undefined,
					code: typeof d.code === "string" || typeof d.code === "number" ? d.code : undefined,
				};
			});
			this.diagnostics.set(targetPath, list);
		});

		await client.start();
		return client;
	}

	async ensureDocumentOpen(filePath: string): Promise<JsonRpcStdioClient | null> {
		const absPath = path.resolve(this.cwd, filePath);
		const client = await this.getServerForFile(absPath);
		if (!client) return null;

		if (!this.openDocs.has(absPath) && fs.existsSync(absPath)) {
			const text = fs.readFileSync(absPath, "utf-8");
			const lang = resolveLanguageId(absPath);
			client.notify("textDocument/didOpen", {
				textDocument: {
					uri: pathToUri(absPath),
					languageId: lang,
					version: 1,
					text,
				},
			});
			this.openDocs.set(absPath, { version: 1, text, language: lang, client });
		}
		return client;
	}

	syncDocument(filePath: string): void {
		const absPath = path.resolve(this.cwd, filePath);
		const doc = this.openDocs.get(absPath);
		if (!doc || !fs.existsSync(absPath)) return;

		const text = fs.readFileSync(absPath, "utf-8");
		doc.version += 1;
		doc.text = text;
		doc.client.notify("textDocument/didChange", {
			textDocument: {
				uri: pathToUri(absPath),
				version: doc.version,
			},
			contentChanges: [{ text }],
		});
		doc.client.notify("textDocument/didSave", {
			textDocument: { uri: pathToUri(absPath) },
			text,
		});
	}

	async getDefinition(
		filePath: string,
		line?: number,
		col?: number,
		symbol?: string,
	): Promise<{ definitions: LocationResult[]; resolvedLine: number; resolvedCol: number }> {
		const absPath = path.resolve(this.cwd, filePath);
		const coords = resolveSymbolCoordinates(absPath, line, col, symbol);
		const client = await this.ensureDocumentOpen(absPath);
		if (!client) return { definitions: [], resolvedLine: coords.line, resolvedCol: coords.col };

		const probe = async (l: number, c: number): Promise<LocationResult[]> => {
			const params = {
				textDocument: { uri: pathToUri(absPath) },
				position: { line: Math.max(0, l - 1), character: Math.max(0, c - 1) },
			};
			let resp = await client.request<unknown>("textDocument/definition", params, 4000).catch(() => null);
			if (!resp || (Array.isArray(resp) && resp.length === 0)) {
				resp = await client.request<unknown>("textDocument/typeDefinition", params, 3000).catch(() => null);
			}
			if (!resp) return [];

			const locations: LocationResult[] = [];
			const rawList = Array.isArray(resp) ? resp : [resp];
			for (const item of rawList) {
				if (!item || typeof item !== "object") continue;
				const obj = item as Record<string, unknown>;
				const uri = (obj.uri || obj.targetUri) as string | undefined;
				const range = (obj.range || obj.targetSelectionRange || obj.targetRange) as
					| { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } }
					| undefined;
				if (!uri || !range) continue;
				const fpath = uriToPath(uri);
				const sl = (range.start?.line ?? 0) + 1;
				const sc = (range.start?.character ?? 0) + 1;
				const el = (range.end?.line ?? 0) + 1;
				const ec = (range.end?.character ?? 0) + 1;
				locations.push({
					file: fpath,
					relative_file: path.relative(this.cwd, fpath),
					start_line: sl,
					start_col: sc,
					end_line: el,
					end_col: ec,
					preview: getPreviewLine(fpath, sl),
				});
			}
			return locations;
		};

		let defs = await probe(coords.line, coords.col);
		if (defs.length > 0) return { definitions: defs, resolvedLine: coords.line, resolvedCol: coords.col };

		for (const altCol of coords.alternativeCols) {
			if (altCol === coords.col) continue;
			defs = await probe(coords.line, altCol);
			if (defs.length > 0) return { definitions: defs, resolvedLine: coords.line, resolvedCol: altCol };
		}

		return { definitions: [], resolvedLine: coords.line, resolvedCol: coords.col };
	}

	async getReferences(
		filePath: string,
		line?: number,
		col?: number,
		symbol?: string,
		includeDeclaration = true,
		limit = 50,
	): Promise<{
		references: LocationResult[];
		total: number;
		truncated: boolean;
		resolvedLine: number;
		resolvedCol: number;
	}> {
		const absPath = path.resolve(this.cwd, filePath);
		const coords = resolveSymbolCoordinates(absPath, line, col, symbol);
		const client = await this.ensureDocumentOpen(absPath);
		if (!client) {
			return { references: [], total: 0, truncated: false, resolvedLine: coords.line, resolvedCol: coords.col };
		}

		const probe = async (
			l: number,
			c: number,
		): Promise<{ references: LocationResult[]; total: number; truncated: boolean }> => {
			const params = {
				textDocument: { uri: pathToUri(absPath) },
				position: { line: Math.max(0, l - 1), character: Math.max(0, c - 1) },
				context: { includeDeclaration },
			};
			const resp = await client
				.request<Array<Record<string, unknown>>>("textDocument/references", params, 6000)
				.catch(() => []);
			if (!Array.isArray(resp)) return { references: [], total: 0, truncated: false };

			const refs: LocationResult[] = [];
			let count = 0;
			let truncated = false;

			for (const item of resp) {
				count++;
				if (refs.length < limit) {
					const uri = item.uri as string | undefined;
					const range = item.range as
						| { start?: { line?: number; character?: number }; end?: { line?: number; character?: number } }
						| undefined;
					if (!uri || !range) continue;
					const fpath = uriToPath(uri);
					const sl = (range.start?.line ?? 0) + 1;
					const sc = (range.start?.character ?? 0) + 1;
					const el = (range.end?.line ?? 0) + 1;
					const ec = (range.end?.character ?? 0) + 1;
					refs.push({
						file: fpath,
						relative_file: path.relative(this.cwd, fpath),
						start_line: sl,
						start_col: sc,
						end_line: el,
						end_col: ec,
						preview: getPreviewLine(fpath, sl),
					});
				} else {
					truncated = true;
				}
			}
			return { references: refs, total: count, truncated };
		};

		let res = await probe(coords.line, coords.col);
		if (res.references.length > 0) {
			return { ...res, resolvedLine: coords.line, resolvedCol: coords.col };
		}

		for (const altCol of coords.alternativeCols) {
			if (altCol === coords.col) continue;
			res = await probe(coords.line, altCol);
			if (res.references.length > 0) {
				return { ...res, resolvedLine: coords.line, resolvedCol: altCol };
			}
		}

		return { references: [], total: 0, truncated: false, resolvedLine: coords.line, resolvedCol: coords.col };
	}

	async getDocumentSymbols(filePath: string): Promise<SymbolResult[]> {
		const client = await this.ensureDocumentOpen(filePath);
		if (!client) return [];
		const absPath = path.resolve(this.cwd, filePath);

		const params = { textDocument: { uri: pathToUri(absPath) } };
		const resp = await client.request<Array<Record<string, unknown>>>("textDocument/documentSymbol", params, 5000);
		if (!Array.isArray(resp)) return [];

		const parseHierarchy = (syms: Array<Record<string, unknown>>, depth = 0): SymbolResult[] => {
			const items: SymbolResult[] = [];
			for (const sym of syms) {
				const kindNum = typeof sym.kind === "number" ? sym.kind : 0;
				const kindName = LSP_SYMBOL_KINDS[kindNum] || String(sym.kind || "Symbol");
				const range = (sym.selectionRange ||
					sym.range ||
					(sym.location as Record<string, unknown>)?.range) as {
					start?: { line?: number };
					end?: { line?: number };
				};
				const sl = (range?.start?.line ?? 0) + 1;
				const el = (range?.end?.line ?? range?.start?.line ?? 0) + 1;
				items.push({
					name: String(sym.name || ""),
					kind: kindName,
					detail: sym.detail ? String(sym.detail) : undefined,
					depth,
					start_line: sl,
					end_line: el,
				});
				if (Array.isArray(sym.children) && sym.children.length > 0) {
					items.push(...parseHierarchy(sym.children as Array<Record<string, unknown>>, depth + 1));
				}
			}
			return items;
		};

		return parseHierarchy(resp, 0);
	}

	async getWorkspaceSymbols(query = ""): Promise<SymbolResult[]> {
		// Run workspace symbol query across all active language servers
		const results: SymbolResult[] = [];
		for (const client of this.servers.values()) {
			if (!client.isInitialized) continue;
			try {
				const resp = await client.request<Array<Record<string, unknown>>>("workspace/symbol", { query }, 4000);
				if (Array.isArray(resp)) {
					for (const sym of resp) {
						const kindNum = typeof sym.kind === "number" ? sym.kind : 0;
						const kindName = LSP_SYMBOL_KINDS[kindNum] || String(sym.kind || "Symbol");
						const loc = sym.location as { uri?: string; range?: { start?: { line?: number; character?: number } } };
						let locResult: LocationResult | undefined;
						if (loc?.uri && loc.range) {
							const fpath = uriToPath(loc.uri);
							locResult = {
								file: fpath,
								relative_file: path.relative(this.cwd, fpath),
								start_line: (loc.range.start?.line ?? 0) + 1,
								start_col: (loc.range.start?.character ?? 0) + 1,
								end_line: (loc.range.start?.line ?? 0) + 1,
								end_col: (loc.range.start?.character ?? 0) + 1,
							};
						}
						results.push({
							name: String(sym.name || ""),
							kind: kindName,
							container: sym.containerName ? String(sym.containerName) : undefined,
							location: locResult,
						});
						if (results.length >= 100) break;
					}
				}
			} catch {
				// Ignore server errors on workspace symbols
			}
		}
		return results;
	}

	async getCallHierarchy(
		filePath: string,
		line?: number,
		col?: number,
		symbol?: string,
		direction: "incoming" | "outgoing" | "both" = "both",
	): Promise<{
		root?: CallHierarchyResultItem;
		incoming?: CallHierarchyResultItem[];
		outgoing?: CallHierarchyResultItem[];
	}> {
		const absPath = path.resolve(this.cwd, filePath);
		const coords = resolveSymbolCoordinates(absPath, line, col, symbol);
		const client = await this.ensureDocumentOpen(absPath);
		if (!client) return {};

		const probe = async (l: number, c: number): Promise<Record<string, unknown> | null> => {
			const params = {
				textDocument: { uri: pathToUri(absPath) },
				position: { line: Math.max(0, l - 1), character: Math.max(0, c - 1) },
			};
			const prep = await client
				.request<Array<Record<string, unknown>>>("textDocument/prepareCallHierarchy", params, 4000)
				.catch(() => []);
			if (!Array.isArray(prep) || prep.length === 0) return null;
			return prep[0];
		};

		let targetItem = await probe(coords.line, coords.col);
		if (!targetItem) {
			for (const altCol of coords.alternativeCols) {
				if (altCol === coords.col) continue;
				targetItem = await probe(coords.line, altCol);
				if (targetItem) break;
			}
		}
		if (!targetItem) return {};

		const rootUri = (targetItem.uri as string) || pathToUri(absPath);
		const rootPath = uriToPath(rootUri);
		const rootRange = (targetItem.selectionRange || targetItem.range) as {
			start?: { line?: number; character?: number };
		};
		const rootKindNum = typeof targetItem.kind === "number" ? targetItem.kind : 0;
		const root: CallHierarchyResultItem = {
			name: String(targetItem.name || ""),
			kind: LSP_SYMBOL_KINDS[rootKindNum] || String(targetItem.kind || "Function"),
			detail: targetItem.detail ? String(targetItem.detail) : undefined,
			file: rootPath,
			relative_file: path.relative(this.cwd, rootPath),
			line: (rootRange?.start?.line ?? 0) + 1,
			col: (rootRange?.start?.character ?? 0) + 1,
		};

		const incoming: CallHierarchyResultItem[] = [];
		const outgoing: CallHierarchyResultItem[] = [];

		if (direction === "incoming" || direction === "both") {
			const incResp = await client
				.request<Array<Record<string, unknown>>>("callHierarchy/incomingCalls", { item: targetItem }, 4000)
				.catch(() => []);
			if (Array.isArray(incResp)) {
				for (const call of incResp) {
					const caller = call.from as Record<string, unknown>;
					if (!caller) continue;
					const curi = (caller.uri as string) || "";
					const cpath = uriToPath(curi);
					const crange = (caller.selectionRange || caller.range) as {
						start?: { line?: number; character?: number };
					};
					const csl = (crange?.start?.line ?? 0) + 1;
					const csc = (crange?.start?.character ?? 0) + 1;
					const ckindNum = typeof caller.kind === "number" ? caller.kind : 0;
					incoming.push({
						name: String(caller.name || ""),
						kind: LSP_SYMBOL_KINDS[ckindNum] || String(caller.kind || "Function"),
						detail: caller.detail ? String(caller.detail) : undefined,
						file: cpath,
						relative_file: path.relative(this.cwd, cpath),
						line: csl,
						col: csc,
						preview: getPreviewLine(cpath, csl),
					});
				}
			}
		}

		if (direction === "outgoing" || direction === "both") {
			const outResp = await client
				.request<Array<Record<string, unknown>>>("callHierarchy/outgoingCalls", { item: targetItem }, 4000)
				.catch(() => []);
			if (Array.isArray(outResp)) {
				for (const call of outResp) {
					const callee = call.to as Record<string, unknown>;
					if (!callee) continue;
					const curi = (callee.uri as string) || "";
					const cpath = uriToPath(curi);
					const crange = (callee.selectionRange || callee.range) as {
						start?: { line?: number; character?: number };
					};
					const csl = (crange?.start?.line ?? 0) + 1;
					const csc = (crange?.start?.character ?? 0) + 1;
					const ckindNum = typeof callee.kind === "number" ? callee.kind : 0;
					outgoing.push({
						name: String(callee.name || ""),
						kind: LSP_SYMBOL_KINDS[ckindNum] || String(callee.kind || "Function"),
						detail: callee.detail ? String(callee.detail) : undefined,
						file: cpath,
						relative_file: path.relative(this.cwd, cpath),
						line: csl,
						col: csc,
						preview: getPreviewLine(cpath, csl),
					});
				}
			}
		}

		return { root, incoming, outgoing };
	}

	async getHover(
		filePath: string,
		line?: number,
		col?: number,
		symbol?: string,
	): Promise<{ hover: string | null; resolvedLine: number; resolvedCol: number }> {
		const absPath = path.resolve(this.cwd, filePath);
		const coords = resolveSymbolCoordinates(absPath, line, col, symbol);
		const client = await this.ensureDocumentOpen(absPath);
		if (!client) return { hover: null, resolvedLine: coords.line, resolvedCol: coords.col };

		const extractText = (contents: unknown): string => {
			if (!contents) return "";
			if (typeof contents === "string") return contents;
			if (typeof contents === "object") {
				const obj = contents as Record<string, unknown>;
				if (obj.kind && obj.value) return String(obj.value);
				if (obj.language && obj.value) return `\`\`\`${obj.language}\n${obj.value}\n\`\`\``;
				if (Array.isArray(contents)) {
					return contents
						.map(extractText)
						.filter((s) => s.length > 0)
						.join("\n\n");
				}
			}
			return "";
		};

		const probe = async (l: number, c: number): Promise<string | null> => {
			const params = {
				textDocument: { uri: pathToUri(absPath) },
				position: { line: Math.max(0, l - 1), character: Math.max(0, c - 1) },
			};
			const resp = await client.request<Record<string, unknown>>("textDocument/hover", params, 4000).catch(() => null);
			if (!resp || !resp.contents) return null;
			const text = extractText(resp.contents).trim();
			return text.length > 0 ? text : null;
		};

		let hoverText = await probe(coords.line, coords.col);
		if (hoverText) {
			return { hover: hoverText, resolvedLine: coords.line, resolvedCol: coords.col };
		}

		for (const altCol of coords.alternativeCols) {
			if (altCol === coords.col) continue;
			hoverText = await probe(coords.line, altCol);
			if (hoverText) {
				return { hover: hoverText, resolvedLine: coords.line, resolvedCol: altCol };
			}
		}

		return { hover: null, resolvedLine: coords.line, resolvedCol: coords.col };
	}

	getDiagnostics(filePath?: string, line?: number, severity?: string): DiagnosticItem[] {
		let all: DiagnosticItem[] = [];
		if (filePath) {
			const abs = path.resolve(this.cwd, filePath);
			all = this.diagnostics.get(abs) || [];
		} else {
			for (const items of this.diagnostics.values()) {
				all.push(...items);
			}
		}

		if (line !== undefined) {
			all = all.filter((d) => d.line === line);
		}
		if (severity === "error") {
			all = all.filter((d) => d.severity === "ERROR");
		} else if (severity === "warning") {
			all = all.filter((d) => d.severity === "ERROR" || d.severity === "WARN");
		}
		return all;
	}

	getActiveServers(): Array<{ name: string; command: string; pid?: number; initialized: boolean }> {
		const list: Array<{ name: string; command: string; pid?: number; initialized: boolean }> = [];
		for (const client of this.servers.values()) {
			list.push({
				name: client.name,
				command: `${client.command} ${client.args.join(" ")}`.trim(),
				pid: client.proc?.pid,
				initialized: client.isInitialized,
			});
		}
		return list;
	}

	getOpenFiles(): string[] {
		return Array.from(this.openDocs.keys()).map((p) => path.relative(this.cwd, p));
	}

	async shutdown(): Promise<void> {
		for (const client of this.servers.values()) {
			await client.shutdown();
		}
		this.servers.clear();
		this.openDocs.clear();
		this.diagnostics.clear();
	}
}

// ---------------------------------------------------------------------------
// 4. Neovim RPC Bridge Client ($NVIM Attached Mode)
// ---------------------------------------------------------------------------

class NvimRpcBridge {
	private socketPath: string;

	constructor(socketPath: string) {
		this.socketPath = socketPath;
	}

	async isConnected(): Promise<boolean> {
		try {
			const res = await this.execLua("return 1");
			return res === 1;
		} catch {
			return false;
		}
	}

	async execLua<T>(chunk: string): Promise<T> {
		const code = `return vim.json.encode((function()\n${chunk}\nend)())`;
		const socket = connect(this.socketPath);
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new Error("Neovim RPC request timed out"));
			}, 4000);

			socket.once("error", (err) => {
				clearTimeout(timer);
				socket.destroy();
				reject(err);
			});

			socket.once("connect", () => {
				const msgId = 1;
				// Encode RPC request [0, msgId, "nvim_exec_lua", [code, []]]
				const payload = Buffer.concat([
					Buffer.from([0x94, 0x00, 0x01]),
					Buffer.from([0xad]),
					Buffer.from("nvim_exec_lua"),
					Buffer.from([0x92]),
					encodeString(code),
					Buffer.from([0x90]),
				]);
				socket.write(payload);
			});

			let incoming = Buffer.alloc(0);
			socket.on("data", (chunk: Buffer) => {
				incoming = Buffer.concat([incoming, chunk]);
				// Fast extraction of msgpack string response
				try {
					const jsonStr = extractMsgpackString(incoming);
					if (jsonStr !== null) {
						clearTimeout(timer);
						socket.end();
						resolve(JSON.parse(jsonStr) as T);
					}
				} catch {
					// Wait for more data
				}
			});
		});
	}
}

function encodeString(str: string): Buffer {
	const bytes = Buffer.from(str, "utf-8");
	const len = bytes.length;
	if (len < 32) return Buffer.concat([Buffer.from([0xa0 | len]), bytes]);
	if (len < 256) return Buffer.concat([Buffer.from([0xd9, len]), bytes]);
	if (len < 65536) {
		const h = Buffer.alloc(3);
		h[0] = 0xda;
		h.writeUInt16BE(len, 1);
		return Buffer.concat([h, bytes]);
	}
	const h = Buffer.alloc(5);
	h[0] = 0xdb;
	h.writeUInt32BE(len, 1);
	return Buffer.concat([h, bytes]);
}

function extractMsgpackString(buf: Buffer): string | null {
	// Look for string bytes in RPC response [1, id, error, result]
	if (buf.length < 5) return null;
	for (let i = 0; i < buf.length - 2; i++) {
		const byte = buf[i];
		let strLen = -1;
		let strStart = -1;
		if (byte >= 0xa0 && byte <= 0xbf) {
			strLen = byte & 0x1f;
			strStart = i + 1;
		} else if (byte === 0xd9 && i + 1 < buf.length) {
			strLen = buf[i + 1];
			strStart = i + 2;
		} else if (byte === 0xda && i + 2 < buf.length) {
			strLen = buf.readUInt16BE(i + 1);
			strStart = i + 3;
		} else if (byte === 0xdb && i + 4 < buf.length) {
			strLen = buf.readUInt32BE(i + 1);
			strStart = i + 5;
		}
		if (strLen >= 0 && strStart >= 0 && strStart + strLen <= buf.length) {
			const slice = buf.subarray(strStart, strStart + strLen).toString("utf-8");
			if (slice.startsWith("{") || slice.startsWith("[") || slice === "null" || slice === "true") {
				return slice;
			}
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// 5. Dual-Backend Router & Tool Handlers
// ---------------------------------------------------------------------------

class LspRouter {
	public headless: HeadlessLspManager;
	public nvim: NvimRpcBridge | null = null;
	public socketPath?: string;

	constructor(cwd: string, socketPath?: string) {
		this.headless = new HeadlessLspManager(cwd);
		this.socketPath = socketPath;
		if (socketPath) {
			this.nvim = new NvimRpcBridge(socketPath);
		}
	}

	async isNvimAttached(): Promise<boolean> {
		if (!this.nvim) return false;
		return this.nvim.isConnected();
	}

	async resolveBackend(): Promise<"nvim" | "headless"> {
		if (this.socketPath && (await this.isNvimAttached())) {
			return "nvim";
		}
		return "headless";
	}

	async definition(
		targetPath: string | undefined,
		line?: number,
		col?: number,
		symbol?: string,
	): Promise<{ definitions: LocationResult[]; resolvedLine: number; resolvedCol: number }> {
		const absPath = targetPath ? path.resolve(this.headless.cwd, targetPath) : "";
		return this.headless.getDefinition(absPath, line, col, symbol);
	}

	async references(
		targetPath: string | undefined,
		line?: number,
		col?: number,
		symbol?: string,
		includeDeclaration = true,
		limit = 50,
	): Promise<{
		references: LocationResult[];
		total: number;
		truncated: boolean;
		resolvedLine: number;
		resolvedCol: number;
	}> {
		const absPath = targetPath ? path.resolve(this.headless.cwd, targetPath) : "";
		return this.headless.getReferences(absPath, line, col, symbol, includeDeclaration, limit);
	}

	async documentSymbols(targetPath: string | undefined): Promise<SymbolResult[]> {
		const absPath = targetPath ? path.resolve(this.headless.cwd, targetPath) : "";
		return this.headless.getDocumentSymbols(absPath);
	}

	async workspaceSymbols(query = ""): Promise<SymbolResult[]> {
		return this.headless.getWorkspaceSymbols(query);
	}

	async callHierarchy(
		targetPath: string | undefined,
		line?: number,
		col?: number,
		symbol?: string,
		direction: "incoming" | "outgoing" | "both" = "both",
	): Promise<{
		root?: CallHierarchyResultItem;
		incoming?: CallHierarchyResultItem[];
		outgoing?: CallHierarchyResultItem[];
	}> {
		const absPath = targetPath ? path.resolve(this.headless.cwd, targetPath) : "";
		return this.headless.getCallHierarchy(absPath, line, col, symbol, direction);
	}

	async hover(
		targetPath: string | undefined,
		line?: number,
		col?: number,
		symbol?: string,
	): Promise<{ hover: string | null; resolvedLine: number; resolvedCol: number }> {
		const absPath = targetPath ? path.resolve(this.headless.cwd, targetPath) : "";
		return this.headless.getHover(absPath, line, col, symbol);
	}

	diagnostics(targetPath?: string, line?: number, severity?: string): DiagnosticItem[] {
		return this.headless.getDiagnostics(targetPath, line, severity);
	}
}

// ---------------------------------------------------------------------------
// 6. Tool Schemas & Extension Registration
// ---------------------------------------------------------------------------

const lspDefinitionParameters = Type.Object({
	path: Type.String({ description: "Target file path." }),
	line: Type.Optional(Type.Number({ description: "1-indexed line number of the symbol (optional if symbol name is unique)." })),
	col: Type.Optional(Type.Number({ description: "1-indexed column number (optional, automatically snaps to identifier on the line)." })),
	symbol: Type.Optional(Type.String({ description: "Exact symbol name to jump to (optional, resolves line and column automatically)." })),
});

const lspReferencesParameters = Type.Object({
	path: Type.String({ description: "Target file path." }),
	line: Type.Optional(Type.Number({ description: "1-indexed line number of the symbol." })),
	col: Type.Optional(Type.Number({ description: "1-indexed column number (optional, automatically snaps to identifier on the line)." })),
	symbol: Type.Optional(Type.String({ description: "Exact symbol name to search references for (optional, resolves coordinates automatically)." })),
	include_declaration: Type.Optional(
		Type.Boolean({ description: "Include declaration in references (default: true)." }),
	),
	limit: Type.Optional(Type.Number({ description: "Max references to return (default: 50)." })),
});

const lspSymbolsParameters = Type.Object({
	path: Type.Optional(
		Type.String({ description: "File path for document symbols. If omitted, search workspace symbols." }),
	),
	query: Type.Optional(Type.String({ description: "Search query for workspace symbol search." })),
	scope: Type.Optional(
		StringEnum(["document", "workspace"] as const, {
			description:
				"Symbol scope: document (file structural outline) or workspace (search symbols across project). Default: document.",
		}),
	),
});

const lspCallHierarchyParameters = Type.Object({
	path: Type.String({ description: "Target file path." }),
	line: Type.Optional(Type.Number({ description: "1-indexed line number of the target function/method." })),
	col: Type.Optional(Type.Number({ description: "1-indexed column number of the target function/method." })),
	symbol: Type.Optional(Type.String({ description: "Exact function or method name (optional, resolves coordinates automatically)." })),
	direction: Type.Optional(
		StringEnum(["incoming", "outgoing", "both"] as const, {
			description: "Call hierarchy direction: incoming (callers), outgoing (callees), or both (default: both).",
		}),
	),
});

const lspHoverParameters = Type.Object({
	path: Type.String({ description: "Target file path." }),
	line: Type.Optional(Type.Number({ description: "1-indexed line number of the symbol." })),
	col: Type.Optional(Type.Number({ description: "1-indexed column number (optional, automatically snaps to identifier on the line)." })),
	symbol: Type.Optional(Type.String({ description: "Exact symbol name to inspect (optional, resolves line and column automatically)." })),
});

const lspDiagnosticsParameters = Type.Object({
	path: Type.Optional(Type.String({ description: "File path to query diagnostics for." })),
	line: Type.Optional(Type.Number({ description: "Optional 1-indexed line number to filter diagnostics." })),
	severity: Type.Optional(
		StringEnum(["error", "warning", "all"] as const, {
			description: "Minimum severity to include (default: all).",
		}),
	),
});

export default function lspExtension(pi: ExtensionAPI): void {
	let router: LspRouter | null = null;

	function getRouter(cwd: string): LspRouter {
		if (!router || router.headless.cwd !== cwd) {
			router = new LspRouter(cwd, process.env.NVIM);
		}
		return router;
	}

	pi.registerTool({
		name: "lsp_definition",
		label: "LSP Definition",
		description:
			"Jump to the definition or declaration of a symbol using the Language Server Protocol. Returns exact file path, line, column, and code preview snippet.",
		promptSnippet: "Go to symbol definition via LSP",
		promptGuidelines: [
			"Use lsp_definition to jump directly to symbol definitions across workspace files and third-party dependencies.",
		],
		parameters: lspDefinitionParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const r = getRouter(ctx.cwd);
				const res = await r.definition(params.path, params.line, params.col, params.symbol);
				const defs = res.definitions;
				if (defs.length === 0) {
					return textResult(
						`No definition found for symbol at ${params.path}:${res.resolvedLine}:${res.resolvedCol}.`,
						{ res },
					);
				}
				const lines = [`### LSP Definition (${defs.length} found)`];
				for (const def of defs) {
					lines.push(`- **\`${def.relative_file || def.file}:${def.start_line}:${def.start_col}\`**`);
					if (def.preview) {
						lines.push(`  \`${def.preview}\``);
					}
				}
				return textResult(lines.join("\n"), { res });
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	pi.registerTool({
		name: "lsp_references",
		label: "LSP References",
		description:
			"Find all usages, references, and call sites of a symbol across the project using the Language Server Protocol.",
		promptSnippet: "Find symbol references across workspace via LSP",
		promptGuidelines: [
			"Use lsp_references before refactoring functions, classes, or variables to ensure all call sites are identified safely.",
		],
		parameters: lspReferencesParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const r = getRouter(ctx.cwd);
				const result = await r.references(
					params.path,
					params.line,
					params.col,
					params.symbol,
					params.include_declaration !== false,
					params.limit || 50,
				);
				if (result.references.length === 0) {
					return textResult(
						`No references found for symbol at ${params.path}:${result.resolvedLine}:${result.resolvedCol}.`,
						{ result },
					);
				}
				const totalStr = `${result.total} found`;
				const truncStr = result.truncated ? `, showing first ${result.references.length}` : "";
				const lines = [`### LSP References (${totalStr}${truncStr})`];
				for (const ref of result.references) {
					const preview = ref.preview ? `: \`${ref.preview}\`` : "";
					lines.push(`- \`${ref.relative_file || ref.file}:${ref.start_line}:${ref.start_col}\`${preview}`);
				}
				return textResult(lines.join("\n"), { result });
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	pi.registerTool({
		name: "lsp_symbols",
		label: "LSP Symbols",
		description:
			"Retrieve structural symbol outlines (classes, methods, functions, types) for a file (scope: document) or search symbols across the workspace (scope: workspace).",
		promptSnippet: "Inspect document structure outline or search workspace symbols via LSP",
		promptGuidelines: [
			"Use lsp_symbols to inspect file outlines (classes, methods, functions) or search workspace symbols without manual regex parsing.",
		],
		parameters: lspSymbolsParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const r = getRouter(ctx.cwd);
				const scope = params.scope || (params.query ? "workspace" : params.path ? "document" : "workspace");
				if (scope === "workspace" || (params.query && !params.path)) {
					const syms = await r.workspaceSymbols(params.query || "");
					if (syms.length === 0) {
						return textResult(`No workspace symbols matching "${params.query || ""}".`, { syms });
					}
					const lines = [`### Workspace Symbols: query="${params.query || ""}" (${syms.length} found)`];
					for (const sym of syms) {
						const loc = sym.location
							? ` in \`${sym.location.relative_file || sym.location.file}:${sym.location.start_line}\``
							: "";
						const container = sym.container ? ` (${sym.container})` : "";
						lines.push(`- [${sym.kind}] \`${sym.name}\`${container}${loc}`);
					}
					return textResult(lines.join("\n"), { syms });
				} else {
					if (!params.path) {
						return textResult("Please provide a file path for document symbols.", {});
					}
					const syms = await r.documentSymbols(params.path);
					if (syms.length === 0) {
						return textResult(`No document symbols found for ${params.path}.`, { syms });
					}
					const lines = [`### Document Symbols: \`${params.path}\` (${syms.length} symbols)`];
					for (const sym of syms) {
						const indent = "  ".repeat(sym.depth || 0);
						const range = sym.start_line
							? ` (lines ${sym.start_line}${sym.end_line && sym.end_line !== sym.start_line ? `-${sym.end_line}` : ""})`
							: "";
						const detail = sym.detail ? ` — *${sym.detail}*` : "";
						lines.push(`${indent}- [${sym.kind}] \`${sym.name}\`${detail}${range}`);
					}
					return textResult(lines.join("\n"), { syms });
				}
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	pi.registerTool({
		name: "lsp_call_hierarchy",
		label: "LSP Call Hierarchy",
		description:
			"Inspect incoming callers (functions that call this) and outgoing callees (functions called by this) for a function or method using LSP.",
		promptSnippet: "Inspect incoming/outgoing call hierarchy of a function via LSP",
		promptGuidelines: [
			"Use lsp_call_hierarchy to trace execution flows and understand function dependencies across the codebase.",
		],
		parameters: lspCallHierarchyParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const r = getRouter(ctx.cwd);
				const dir = params.direction || "both";
				const res = await r.callHierarchy(params.path, params.line, params.col, params.symbol, dir);
				if (!res.root) {
					return textResult(
						`Call hierarchy not supported or no symbol found in ${params.path}.`,
						{ res },
					);
				}
				const root = res.root;
				const lines = [
					`### Call Hierarchy: \`${root.name}\` [${root.kind}] (\`${root.relative_file || root.file}:${root.line}\`)`,
				];
				if (res.incoming && res.incoming.length > 0) {
					lines.push("");
					lines.push(`#### Incoming Calls (Callers — ${res.incoming.length}):`);
					for (const call of res.incoming) {
						const preview = call.preview ? ` \`${call.preview}\`` : "";
						lines.push(`- [${call.kind}] \`${call.name}\` in \`${call.relative_file || call.file}:${call.line}\`${preview}`);
					}
				} else if (dir === "incoming" || dir === "both") {
					lines.push("");
					lines.push("*No incoming callers found.*");
				}

				if (res.outgoing && res.outgoing.length > 0) {
					lines.push("");
					lines.push(`#### Outgoing Calls (Callees — ${res.outgoing.length}):`);
					for (const call of res.outgoing) {
						const preview = call.preview ? ` \`${call.preview}\`` : "";
						lines.push(`- [${call.kind}] \`${call.name}\` in \`${call.relative_file || call.file}:${call.line}\`${preview}`);
					}
				} else if (dir === "outgoing" || dir === "both") {
					lines.push("");
					lines.push("*No outgoing callees found.*");
				}
				return textResult(lines.join("\n"), { res });
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	pi.registerTool({
		name: "lsp_hover",
		label: "LSP Hover",
		description:
			"Get LSP hover information (type annotations, inferred types, docstrings) for a symbol at a given line and column or by symbol name.",
		promptSnippet: "Inspect type signatures and docstrings at cursor via LSP",
		promptGuidelines: [
			"Use lsp_hover to check exact type signatures and docstrings of unfamiliar functions or variables.",
		],
		parameters: lspHoverParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const r = getRouter(ctx.cwd);
				const res = await r.hover(params.path, params.line, params.col, params.symbol);
				if (!res.hover) {
					return textResult(`No hover info available at ${params.path}:${res.resolvedLine}:${res.resolvedCol}.`, {});
				}
				const lines = [`### LSP Hover (\`${params.path}:${res.resolvedLine}:${res.resolvedCol}\`)`, "", res.hover];
				return textResult(lines.join("\n"), { hover: res.hover, line: res.resolvedLine, col: res.resolvedCol });
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	pi.registerTool({
		name: "lsp_diagnostics",
		label: "LSP Diagnostics",
		description:
			"Query live LSP compiler and linter diagnostics for a file or line. Returns compile errors, type mismatches, and warnings.",
		promptSnippet: "Query live LSP compiler/linter diagnostics",
		promptGuidelines: [
			"Use lsp_diagnostics to check compiler and type errors across files before and after edits.",
		],
		parameters: lspDiagnosticsParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const r = getRouter(ctx.cwd);
				const diags = r.diagnostics(params.path, params.line, params.severity);
				if (diags.length === 0) {
					return textResult("No matching LSP diagnostics.", { diags });
				}
				const lines = [`### LSP Diagnostics (${diags.length})`];
				for (const d of diags) {
					const src = d.source ? ` (${d.source}${d.code !== undefined ? ` ${d.code}` : ""})` : "";
					lines.push(`- [${d.severity}] \`${d.relative_file || d.file}:${d.line}:${d.col}\` ${d.message}${src}`);
				}
				return textResult(lines.join("\n"), { diags });
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	// --- Buffer Sync Hook ----------------------------------------------------
	pi.on("tool_result", async (event, ctx) => {
		if (!(isWriteToolResult(event) || isEditToolResult(event))) return;
		if (event.isError) return;
		const rawPath = event.input.path;
		if (typeof rawPath !== "string" || rawPath.length === 0) return;

		const r = getRouter(ctx.cwd);
		r.headless.syncDocument(rawPath);
	});

	// --- Slash Command -------------------------------------------------------
	pi.registerCommand("lsp", {
		description: "Display Language Server Protocol backend status, active servers, and diagnostics",
		handler: async (_args, ctx) => {
			const r = getRouter(ctx.cwd);
			const nvimAttached = await r.isNvimAttached();
			const activeServers = r.headless.getActiveServers();
			const openFiles = r.headless.getOpenFiles();
			const allDiags = r.headless.getDiagnostics();

			const lines: string[] = ["### LSP Bridge Status", ""];
			if (nvimAttached) {
				lines.push(`- **Active Backend:** Editor-Attached (Neovim RPC: \`${r.socketPath}\`)`);
			} else {
				lines.push("- **Active Backend:** Standalone Headless (JSON-RPC stdio)");
			}

			lines.push("");
			lines.push(`#### Running Language Servers (${activeServers.length})`);
			if (activeServers.length === 0) {
				lines.push("*(No language servers currently spawned. Servers start lazily on first tool call.)*");
			} else {
				for (const s of activeServers) {
					const pidStr = s.pid ? ` (PID: ${s.pid})` : "";
					const status = s.initialized ? "✓ ready" : "⏳ initializing";
					lines.push(`- **${s.name}**${pidStr} — \`${s.command}\` [${status}]`);
				}
			}

			lines.push("");
			lines.push(`#### Open Documents (${openFiles.length})`);
			if (openFiles.length === 0) {
				lines.push("*(No active documents open in headless AST)*");
			} else {
				for (const f of openFiles) {
					lines.push(`- \`${f}\``);
				}
			}

			if (allDiags.length > 0) {
				lines.push("");
				lines.push(`#### Active Diagnostics (${allDiags.length})`);
				for (const d of allDiags.slice(0, 10)) {
					lines.push(`- [${d.severity}] \`${d.relative_file}:${d.line}\` ${d.message}`);
				}
				if (allDiags.length > 10) {
					lines.push(`*(...and ${allDiags.length - 10} more)*`);
				}
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// --- Lifecycle -----------------------------------------------------------
	pi.on("session_shutdown", async () => {
		if (router) {
			await router.headless.shutdown();
			router = null;
		}
	});

	// Failsafe: kill child processes if parent Node process exits abruptly
	process.on("exit", () => {
		if (router) {
			for (const client of router.headless.getActiveServers()) {
				if (client.pid) {
					try {
						process.kill(client.pid, "SIGKILL");
					} catch {
						// Process already dead
					}
				}
			}
		}
	});
}
