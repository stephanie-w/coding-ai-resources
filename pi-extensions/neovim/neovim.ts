// ~/.pi/agent/extensions/neovim.ts
//
// Native Neovim integration extension for the pi coding agent.
//
// The extension speaks Neovim's MessagePack-RPC protocol directly over the Unix
// domain socket exposed in $NVIM (with a `nvim --server ... --remote-expr`
// fallback for hosts where the socket cannot be reached). It is completely
// inert when $NVIM is not set, so pi behaves exactly like a normal CLI agent
// outside of Neovim.
//
// Sections:
//   1. Lua value helpers
//   2. Minimal MessagePack codec (encode + decode)
//   3. RPC transports (socket primary, CLI fallback)
//   4. High level NvimClient
//   5. Context collection + rendering
//   6. Buffer synchronisation
//   7. Neovim-side Lua bindings (installed into the session at startup)
//   8. pi tools, commands and lifecycle hooks

import { execFile } from "node:child_process";
import { connect, type Socket } from "node:net";
import { basename, isAbsolute, resolve as resolvePath } from "node:path";
import { promisify } from "node:util";

import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type AgentToolResult,
	type ExtensionAPI,
	type ExtensionCommandContext,
	isEditToolResult,
	isToolCallEventType,
	isWriteToolResult,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// 1. Lua value helpers
// ---------------------------------------------------------------------------

/** Escape an arbitrary string as a Lua double-quoted string literal. */
function toLuaString(value: string): string {
	return `"${value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t")}"`;
}

/** Serialise a JSON-ish value into a Lua literal. Used to embed options safely. */
function toLuaValue(value: unknown): string {
	if (value === null || value === undefined) return "nil";
	switch (typeof value) {
		case "string":
			return toLuaString(value);
		case "number":
			return Number.isFinite(value) ? String(value) : "nil";
		case "boolean":
			return value ? "true" : "false";
		case "object": {
			if (Array.isArray(value)) {
				return `{ ${value.map(toLuaValue).join(", ")} }`;
			}
			const entries = Object.entries(value as Record<string, unknown>);
			const fields = entries.map(([key, val]) => `[${toLuaString(key)}] = ${toLuaValue(val)}`);
			return `{ ${fields.join(", ")} }`;
		}
		default:
			return "nil";
	}
}

/** Escape a Lua chunk so it can be passed to `luaeval()` as a Vim string. */
function toVimString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

// ---------------------------------------------------------------------------
// 2. Minimal MessagePack codec
// ---------------------------------------------------------------------------
//
// Neovim RPC frames are plain MessagePack values. We only need the subset the
// API produces (nil/bool/int/float/str/bin/array/map); ext types are skipped.

type MsgpackValue =
	| null
	| boolean
	| number
	| string
	| Uint8Array
	| MsgpackValue[]
	| { [key: string]: MsgpackValue };

class MsgpackIncomplete extends Error {}

function encodeMsgpack(value: unknown): Buffer {
	const chunks: Buffer[] = [];
	encodeMsgpackInto(value, chunks);
	return Buffer.concat(chunks);
}

function encodeMsgpackInto(value: unknown, out: Buffer[]): void {
	if (value === null || value === undefined) {
		out.push(Buffer.from([0xc0]));
		return;
	}
	if (typeof value === "boolean") {
		out.push(Buffer.from([value ? 0xc3 : 0xc2]));
		return;
	}
	if (typeof value === "number") {
		encodeNumber(value, out);
		return;
	}
	if (typeof value === "string") {
		encodeString(value, out);
		return;
	}
	if (value instanceof Uint8Array) {
		encodeBinary(value, out);
		return;
	}
	if (Array.isArray(value)) {
		if (value.length < 16) out.push(Buffer.from([0x90 | value.length]));
		else if (value.length < 0x10000) {
			const header = Buffer.allocUnsafe(3);
			header[0] = 0xdc;
			header.writeUInt16BE(value.length, 1);
			out.push(header);
		} else {
			const header = Buffer.allocUnsafe(5);
			header[0] = 0xdd;
			header.writeUInt32BE(value.length, 1);
			out.push(header);
		}
		for (const item of value) encodeMsgpackInto(item, out);
		return;
	}
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length < 16) out.push(Buffer.from([0x80 | entries.length]));
		else if (entries.length < 0x10000) {
			const header = Buffer.allocUnsafe(3);
			header[0] = 0xde;
			header.writeUInt16BE(entries.length, 1);
			out.push(header);
		} else {
			const header = Buffer.allocUnsafe(5);
			header[0] = 0xdf;
			header.writeUInt32BE(entries.length, 1);
			out.push(header);
		}
		for (const [key, item] of entries) {
			encodeString(key, out);
			encodeMsgpackInto(item, out);
		}
		return;
	}
	throw new Error(`Cannot MessagePack-encode value of type ${typeof value}`);
}

function encodeNumber(value: number, out: Buffer[]): void {
	if (!Number.isInteger(value)) {
		const buffer = Buffer.allocUnsafe(9);
		buffer[0] = 0xcb;
		buffer.writeDoubleBE(value, 1);
		out.push(buffer);
		return;
	}
	if (value >= 0) {
		if (value <= 0x7f) {
			out.push(Buffer.from([value]));
		} else if (value <= 0xff) {
			out.push(Buffer.from([0xcc, value]));
		} else if (value <= 0xffff) {
			const buffer = Buffer.allocUnsafe(3);
			buffer[0] = 0xcd;
			buffer.writeUInt16BE(value, 1);
			out.push(buffer);
		} else if (value <= 0xffffffff) {
			const buffer = Buffer.allocUnsafe(5);
			buffer[0] = 0xce;
			buffer.writeUInt32BE(value, 1);
			out.push(buffer);
		} else {
			const buffer = Buffer.allocUnsafe(9);
			buffer[0] = 0xcf;
			buffer.writeBigUInt64BE(BigInt(value), 1);
			out.push(buffer);
		}
		return;
	}
	if (value >= -32) {
		out.push(Buffer.from([0xe0 | (value + 32)]));
	} else if (value >= -128) {
		out.push(Buffer.from([0xd0, value & 0xff]));
	} else if (value >= -32768) {
		const buffer = Buffer.allocUnsafe(3);
		buffer[0] = 0xd1;
		buffer.writeInt16BE(value, 1);
		out.push(buffer);
	} else if (value >= -2147483648) {
		const buffer = Buffer.allocUnsafe(5);
		buffer[0] = 0xd2;
		buffer.writeInt32BE(value, 1);
		out.push(buffer);
	} else {
		const buffer = Buffer.allocUnsafe(9);
		buffer[0] = 0xd3;
		buffer.writeBigInt64BE(BigInt(value), 1);
		out.push(buffer);
	}
}

function encodeString(value: string, out: Buffer[]): void {
	const bytes = Buffer.from(value, "utf8");
	const length = bytes.length;
	if (length < 32) out.push(Buffer.from([0xa0 | length]));
	else if (length < 0x100) out.push(Buffer.from([0xd9, length]));
	else if (length < 0x10000) {
		const header = Buffer.allocUnsafe(3);
		header[0] = 0xda;
		header.writeUInt16BE(length, 1);
		out.push(header);
	} else {
		const header = Buffer.allocUnsafe(5);
		header[0] = 0xdb;
		header.writeUInt32BE(length, 1);
		out.push(header);
	}
	out.push(bytes);
}

function encodeBinary(value: Uint8Array, out: Buffer[]): void {
	const length = value.byteLength;
	const bytes = Buffer.from(value.buffer, value.byteOffset, length);
	if (length < 0x100) out.push(Buffer.from([0xc4, length]));
	else if (length < 0x10000) {
		const header = Buffer.allocUnsafe(3);
		header[0] = 0xc5;
		header.writeUInt16BE(length, 1);
		out.push(header);
	} else {
		const header = Buffer.allocUnsafe(5);
		header[0] = 0xc6;
		header.writeUInt32BE(length, 1);
		out.push(header);
	}
	out.push(bytes);
}

/** Decode the first complete MessagePack value, or null when more bytes are needed. */
function tryDecodeMsgpack(buffer: Buffer): { value: MsgpackValue; bytes: number } | null {
	const reader = new MsgpackReader(buffer);
	try {
		const value = reader.readValue();
		return { value, bytes: reader.position };
	} catch (error) {
		if (error instanceof MsgpackIncomplete) return null;
		throw error;
	}
}

class MsgpackReader {
	position = 0;
	private readonly buffer: Buffer;

	constructor(buffer: Buffer) {
		this.buffer = buffer;
	}

	readValue(): MsgpackValue {
		const byte = this.readUInt8();
		if (byte <= 0x7f) return byte;
		if (byte >= 0xe0) return byte - 256;
		if ((byte & 0xf0) === 0x80) return this.readMap(byte & 0x0f);
		if ((byte & 0xf0) === 0x90) return this.readArray(byte & 0x0f);
		if ((byte & 0xe0) === 0xa0) return this.readString(byte & 0x1f);
		switch (byte) {
			case 0xc0:
				return null;
			case 0xc2:
				return false;
			case 0xc3:
				return true;
			case 0xc4:
				return this.readBinary(this.readUInt8());
			case 0xc5:
				return this.readBinary(this.readUInt16());
			case 0xc6:
				return this.readBinary(this.readUInt32());
			case 0xc7: {
				const length = this.readUInt8();
				this.skip(1);
				return this.readBinary(length);
			}
			case 0xc8: {
				const length = this.readUInt16();
				this.skip(1);
				return this.readBinary(length);
			}
			case 0xc9: {
				const length = this.readUInt32();
				this.skip(1);
				return this.readBinary(length);
			}
			case 0xca:
				return this.readFloat32();
			case 0xcb:
				return this.readFloat64();
			case 0xcc:
				return this.readUInt8();
			case 0xcd:
				return this.readUInt16();
			case 0xce:
				return this.readUInt32();
			case 0xcf:
				return Number(this.readBigUInt64());
			case 0xd0:
				return this.readInt8();
			case 0xd1:
				return this.readInt16();
			case 0xd2:
				return this.readInt32();
			case 0xd3:
				return Number(this.readBigInt64());
			case 0xd4:
				this.skip(1);
				return null;
			case 0xd5:
				this.skip(2);
				return null;
			case 0xd6:
				this.skip(4);
				return null;
			case 0xd7:
				this.skip(8);
				return null;
			case 0xd8:
				this.skip(16);
				return null;
			case 0xd9:
				return this.readString(this.readUInt8());
			case 0xda:
				return this.readString(this.readUInt16());
			case 0xdb:
				return this.readString(this.readUInt32());
			case 0xdc:
				return this.readArray(this.readUInt16());
			case 0xdd:
				return this.readArray(this.readUInt32());
			case 0xde:
				return this.readMap(this.readUInt16());
			case 0xdf:
				return this.readMap(this.readUInt32());
			default:
				throw new Error(`Unsupported MessagePack byte 0x${byte.toString(16)}`);
		}
	}

	private need(count: number): void {
		if (this.position + count > this.buffer.length) throw new MsgpackIncomplete();
	}

	private readUInt8(): number {
		this.need(1);
		const value = this.buffer[this.position];
		this.position += 1;
		return value;
	}

	private readUInt16(): number {
		this.need(2);
		const value = this.buffer.readUInt16BE(this.position);
		this.position += 2;
		return value;
	}

	private readUInt32(): number {
		this.need(4);
		const value = this.buffer.readUInt32BE(this.position);
		this.position += 4;
		return value;
	}

	private readBigUInt64(): bigint {
		this.need(8);
		const value = this.buffer.readBigUInt64BE(this.position);
		this.position += 8;
		return value;
	}

	private readInt8(): number {
		this.need(1);
		const value = this.buffer.readInt8(this.position);
		this.position += 1;
		return value;
	}

	private readInt16(): number {
		this.need(2);
		const value = this.buffer.readInt16BE(this.position);
		this.position += 2;
		return value;
	}

	private readInt32(): number {
		this.need(4);
		const value = this.buffer.readInt32BE(this.position);
		this.position += 4;
		return value;
	}

	private readBigInt64(): bigint {
		this.need(8);
		const value = this.buffer.readBigInt64BE(this.position);
		this.position += 8;
		return value;
	}

	private readFloat32(): number {
		this.need(4);
		const value = this.buffer.readFloatBE(this.position);
		this.position += 4;
		return value;
	}

	private readFloat64(): number {
		this.need(8);
		const value = this.buffer.readDoubleBE(this.position);
		this.position += 8;
		return value;
	}

	private readString(length: number): string {
		this.need(length);
		const value = this.buffer.toString("utf8", this.position, this.position + length);
		this.position += length;
		return value;
	}

	private readBinary(length: number): Uint8Array {
		this.need(length);
		const value = this.buffer.subarray(this.position, this.position + length);
		this.position += length;
		return value;
	}

	private readArray(length: number): MsgpackValue[] {
		const value = new Array<MsgpackValue>(length);
		for (let index = 0; index < length; index += 1) value[index] = this.readValue();
		return value;
	}

	private readMap(length: number): { [key: string]: MsgpackValue } {
		const value: { [key: string]: MsgpackValue } = {};
		for (let index = 0; index < length; index += 1) {
			const key = this.readValue();
			value[String(key)] = this.readValue();
		}
		return value;
	}

	private skip(count: number): void {
		this.need(count);
		this.position += count;
	}
}

// ---------------------------------------------------------------------------
// 3. RPC transports
// ---------------------------------------------------------------------------

class NvimError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NvimError";
	}
}

interface NvimRpcTransport {
	connect(): Promise<void>;
	request(method: string, params: unknown[]): Promise<unknown>;
	notify(method: string, params: unknown[]): void;
	close(): void;
}

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

/** Primary transport: a long-lived MessagePack-RPC connection to $NVIM. */
class NvimSocketTransport implements NvimRpcTransport {
	private socket: Socket | null = null;
	private incoming = Buffer.alloc(0);
	private nextMessageId = 1;
	private pending = new Map<number, PendingRequest>();
	private connectPromise: Promise<void> | null = null;
	private readonly socketPath: string;
	private readonly timeoutMs: number;

	constructor(socketPath: string, timeoutMs = 5000) {
		this.socketPath = socketPath;
		this.timeoutMs = timeoutMs;
	}

	async connect(): Promise<void> {
		if (this.socket && !this.socket.destroyed) return;
		if (this.connectPromise) return this.connectPromise;
		this.connectPromise = new Promise<void>((resolveConnect, rejectConnect) => {
			const socket = connect(this.socketPath);
			const onStartupError = (error: Error) => {
				socket.destroy();
				rejectConnect(error);
			};
			socket.once("error", onStartupError);
			socket.once("connect", () => {
				socket.off("error", onStartupError);
				socket.on("error", (error) => this.handleDisconnect(error));
				socket.on("close", () => this.handleDisconnect(new NvimError("Neovim RPC connection closed")));
				socket.on("data", (chunk: Buffer) => this.handleData(chunk));
				this.socket = socket;
				resolveConnect();
			});
		}).finally(() => {
			this.connectPromise = null;
		});
		return this.connectPromise;
	}

	async request(method: string, params: unknown[]): Promise<unknown> {
		await this.connect();
		const socket = this.socket;
		if (!socket) throw new NvimError("Neovim RPC socket is not connected");
		const id = this.nextMessageId;
		this.nextMessageId += 1;
		return new Promise<unknown>((resolveRequest, rejectRequest) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				rejectRequest(new NvimError(`Neovim RPC request '${method}' timed out after ${this.timeoutMs}ms`));
			}, this.timeoutMs);
			this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
			try {
				socket.write(encodeMsgpack([0, id, method, params]));
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				rejectRequest(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	notify(method: string, params: unknown[]): void {
		void this.connect()
			.then(() => {
				this.socket?.write(encodeMsgpack([2, method, params]));
			})
			.catch(() => {
				// Notifications are best effort.
			});
	}

	close(): void {
		this.rejectPending(new NvimError("Neovim RPC client closed"));
		const socket = this.socket;
		this.socket = null;
		socket?.end();
		socket?.destroy();
	}

	private handleData(chunk: Buffer): void {
		this.incoming = Buffer.concat([this.incoming, chunk]);
		for (;;) {
			const decoded = tryDecodeMsgpack(this.incoming);
			if (!decoded) break;
			this.incoming = this.incoming.subarray(decoded.bytes);
			this.handleMessage(decoded.value);
		}
	}

	private handleMessage(message: MsgpackValue): void {
		if (!Array.isArray(message) || message.length < 3) return;
		const [kind, id] = message;
		if (kind === 1) {
			if (typeof id !== "number") return;
			const pending = this.pending.get(id);
			if (!pending) return;
			this.pending.delete(id);
			clearTimeout(pending.timer);
			const error = message[2];
			if (error) pending.reject(new NvimError(formatRpcError(error)));
			else pending.resolve(message[3]);
			return;
		}
		if (kind === 0 && typeof id === "number") {
			// We are not a server; answer any unexpected callback with an error.
			this.socket?.write(encodeMsgpack([1, id, [0, "unsupported request"], null]));
		}
	}

	private handleDisconnect(error: Error): void {
		this.socket = null;
		this.incoming = Buffer.alloc(0);
		this.rejectPending(error);
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
}

/**
 * Fallback transport: shells out to `nvim --server <socket> --remote-expr`.
 * Slower, but works when the runtime cannot open the Unix socket directly.
 */
class NvimCliTransport implements NvimRpcTransport {
	private readonly socketPath: string;

	constructor(socketPath: string) {
		this.socketPath = socketPath;
	}

	async connect(): Promise<void> {
		// Nothing to establish; each request spawns a short-lived client.
	}

	async request(method: string, params: unknown[]): Promise<unknown> {
		if (method !== "nvim_exec_lua") {
			throw new NvimError(`CLI transport does not support RPC method '${method}'`);
		}
		const [code] = params as [string, unknown[]];
		const expression = `luaeval(${toVimString(`(function() ${code} end)()`)})`;
		const { stdout } = await execFileAsync(
			"nvim",
			["--server", this.socketPath, "--remote-expr", expression],
			{ timeout: 5000 },
		);
		return stdout.trim();
	}

	notify(method: string, params: unknown[]): void {
		void this.request(method, params).catch(() => {
			// Notifications are best effort.
		});
	}

	close(): void {
		// Nothing to close.
	}
}

function formatRpcError(error: MsgpackValue): string {
	if (Array.isArray(error)) {
		const [type, message] = error;
		return `[${String(type)}] ${String(message ?? "")}`;
	}
	if (typeof error === "string") return error;
	return JSON.stringify(error);
}

// ---------------------------------------------------------------------------
// 4. High level client
// ---------------------------------------------------------------------------

class NvimClient {
	private transport: NvimRpcTransport | null = null;
	private readonly socketPath: string;

	constructor(socketPath: string) {
		this.socketPath = socketPath;
	}

	private async getTransport(): Promise<NvimRpcTransport> {
		if (this.transport) return this.transport;
		// Escape hatch for environments where the Unix socket cannot be opened
		// directly (or for debugging): PI_NVIM_TRANSPORT=cli.
		if (process.env.PI_NVIM_TRANSPORT === "cli") {
			this.transport = new NvimCliTransport(this.socketPath);
			return this.transport;
		}
		const socketTransport = new NvimSocketTransport(this.socketPath);
		try {
			await socketTransport.connect();
			this.transport = socketTransport;
		} catch {
			socketTransport.close();
			this.transport = new NvimCliTransport(this.socketPath);
		}
		return this.transport;
	}

	/** Execute a Lua chunk and JSON-decode its return value. */
	async execJson<T>(chunk: string): Promise<T> {
		const code = `return vim.json.encode((function()\n${chunk}\nend)())`;
		const transport = await this.getTransport();
		const raw = await transport.request("nvim_exec_lua", [code, []]);
		if (typeof raw !== "string") throw new NvimError("Unexpected Neovim RPC response type");
		try {
			return JSON.parse(raw) as T;
		} catch {
			throw new NvimError(`Neovim returned invalid JSON: ${raw.slice(0, 200)}`);
		}
	}

	/** Fire-and-forget Lua execution (a real RPC notification on the socket transport). */
	notifyLua(chunk: string): void {
		void this.getTransport()
			.then((transport) => transport.notify("nvim_exec_lua", [chunk, []]))
			.catch(() => {
				// Best effort.
			});
	}

	async ping(): Promise<boolean> {
		try {
			const value = await this.execJson<number>("return 1");
			return value === 1;
		} catch {
			return false;
		}
	}

	async command(command: string, target?: string): Promise<CommandResult> {
		const normalized = command.replace(/^:/, "");
		return this.execJson<CommandResult>(buildCommandChunk(normalized, target));
	}

	close(): void {
		this.transport?.close();
		this.transport = null;
	}
}

interface CommandResult {
	blocked?: boolean;
	reason?: string;
	buffer?: string;
}

/**
 * Run an Ex command in the context of the user's active code buffer rather than
 * pi's terminal buffer. Force-reload commands that would discard unsaved work
 * are refused. An explicit target (path or buffer number) overrides the default.
 */
function buildCommandChunk(command: string, target?: string): string {
	return `
local command = ${toLuaString(command)}
local target = ${target ? toLuaString(target) : "nil"}

local function is_code_buffer(buf)
  if not vim.api.nvim_buf_is_valid(buf) then return false end
  if vim.bo[buf].buftype ~= "" then return false end
  if vim.api.nvim_buf_get_name(buf) == "" then return false end
  return true
end

local bufnr = -1
if target and target ~= "" then
  bufnr = vim.fn.bufnr(target)
  if bufnr == -1 then
    local absolute = vim.fn.fnamemodify(target, ":p")
    bufnr = vim.fn.bufnr(absolute)
    if bufnr == -1 then
      for _, candidate in ipairs(vim.api.nvim_list_bufs()) do
        local candidate_name = vim.api.nvim_buf_get_name(candidate)
        if candidate_name ~= "" and vim.fn.fnamemodify(candidate_name, ":p") == absolute then
          bufnr = candidate
          break
        end
      end
    end
  end
else
  local current = vim.api.nvim_get_current_buf()
  if is_code_buffer(current) then
    bufnr = current
  else
    for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
      local candidate = vim.api.nvim_win_get_buf(win)
      if is_code_buffer(candidate) then
        bufnr = candidate
        break
      end
    end
  end
end

local trimmed = command:gsub("^%s*:?%s*", "")
local force_reload = trimmed:match("^e!") ~= nil
  or trimmed:match("^edit!") ~= nil
  or trimmed:match("^checkt") ~= nil
  or (trimmed:match("bufdo%s") ~= nil and trimmed:find("e!", 1, true) ~= nil)
  or (trimmed:match("windo%s") ~= nil and trimmed:find("e!", 1, true) ~= nil)
if force_reload and bufnr ~= -1 and vim.bo[bufnr].modified then
  return {
    blocked = true,
    reason = "Refusing to force-reload " .. vim.api.nvim_buf_get_name(bufnr) .. ": it has unsaved changes.",
    buffer = vim.api.nvim_buf_get_name(bufnr),
  }
end

if bufnr ~= -1 and vim.api.nvim_buf_is_loaded(bufnr) then
  vim.api.nvim_buf_call(bufnr, function() vim.cmd(command) end)
else
  vim.cmd(command)
end
return {
  blocked = false,
  buffer = bufnr ~= -1 and vim.api.nvim_buf_get_name(bufnr) or "",
}
`;
}

// ---------------------------------------------------------------------------
// 5. Context collection + rendering
// ---------------------------------------------------------------------------

interface NvimSelection {
	kind: "visual" | "pending";
	text: string;
	start_line: number;
	start_col: number;
	end_line: number;
	end_col: number;
	mode?: string;
}

interface NvimDiagnostic {
	line: number;
	col: number;
	end_line?: number;
	end_col?: number;
	severity: "ERROR" | "WARN" | "INFO" | "HINT" | string;
	message: string;
	source?: string;
	code?: string | number;
}

interface NvimBufferInfo {
	bufnr: number;
	name: string;
	modified: boolean;
	current: boolean;
}

interface NvimContext {
	connected: boolean;
	has_buffer: boolean;
	bufnr?: number;
	file?: string;
	relative_file?: string;
	file_name?: string;
	filetype?: string;
	cursor_line?: number;
	cursor_col?: number;
	total_lines?: number;
	modified?: boolean;
	modifiable?: boolean;
	changedtick?: number;
	mode?: string;
	selection?: NvimSelection | null;
	context?: { start_line: number; end_line: number; lines: string[] };
	diagnostics?: NvimDiagnostic[];
	open_buffers?: NvimBufferInfo[];
}

interface ContextOptions {
	contextLines?: number;
	includeBuffers?: boolean;
	includeDiagnostics?: boolean;
	includeSelection?: boolean;
}

function buildContextChunk(options: ContextOptions): string {
	return `
local opts = ${toLuaValue({
		context_lines: options.contextLines ?? 50,
		include_buffers: options.includeBuffers ?? true,
		include_diagnostics: options.includeDiagnostics ?? true,
		include_selection: options.includeSelection ?? true,
	})}
local context_lines = tonumber(opts.context_lines) or 50
local include_diagnostics = opts.include_diagnostics ~= false
local include_selection = opts.include_selection ~= false

local function is_code_buffer(buf)
  if not vim.api.nvim_buf_is_valid(buf) then return false end
  if not vim.api.nvim_buf_is_loaded(buf) then return false end
  if vim.bo[buf].buftype ~= "" then return false end
  if vim.api.nvim_buf_get_name(buf) == "" then return false end
  return true
end

-- Pick the file buffer the user actually cares about. When pi is focused, the
-- current buffer is pi's own terminal, so fall through to the most recently
-- used code window in the current tabpage.
local function pick()
  local current = vim.api.nvim_get_current_buf()
  local current_win = vim.api.nvim_get_current_win()
  if is_code_buffer(current) then return current, current_win end
  for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
    local buf = vim.api.nvim_win_get_buf(win)
    if is_code_buffer(buf) then return buf, win end
  end
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if is_code_buffer(buf) then return buf, nil end
  end
  return nil, nil
end

local bufnr, win = pick()
if not bufnr then
  return { connected = true, has_buffer = false }
end

local path = vim.api.nvim_buf_get_name(bufnr)
local relative = vim.fn.fnamemodify(path, ":~:.")
local name = vim.fn.fnamemodify(path, ":t")
local filetype = vim.bo[bufnr].filetype
local modified = vim.bo[bufnr].modified
local modifiable = vim.bo[bufnr].modifiable
local total_lines = vim.api.nvim_buf_line_count(bufnr)
local changedtick = vim.api.nvim_buf_get_changedtick(bufnr)
local mode = vim.fn.mode()

local cursor_line, cursor_col = 1, 1
if win and vim.api.nvim_win_is_valid(win) then
  local cursor = vim.api.nvim_win_get_cursor(win)
  cursor_line, cursor_col = cursor[1], cursor[2] + 1
end

local selection = nil
local function capture_selection(startpos, endpos, kind)
  local sl, sc = startpos[2], startpos[3]
  local el, ec = endpos[2], endpos[3]
  if sl > el or (sl == el and sc > ec) then
    sl, el = el, sl
    sc, ec = ec, sc
  end
  local selected = vim.api.nvim_buf_get_lines(bufnr, sl - 1, el, false)
  return {
    kind = kind,
    text = table.concat(selected, string.char(10)),
    start_line = sl,
    start_col = sc,
    end_line = el,
    end_col = ec,
    mode = mode,
  }
end

if include_selection and (mode == "v" or mode == "V" or mode == string.char(22)) then
  local ok, live = pcall(capture_selection, vim.fn.getpos("v"), vim.fn.getpos("."), "visual")
  if ok then selection = live end
end
if include_selection and not selection and vim.g.pi_selection and vim.g.pi_selection ~= "" then
  local ok, decoded = pcall(vim.json.decode, vim.g.pi_selection)
  if ok and type(decoded) == "table" and decoded.text then
    local max_age = tonumber(vim.g.pi_selection_ttl) or 300
    local age = os.time() - (tonumber(decoded.time) or 0)
    if age <= max_age then selection = decoded end
  end
end

local start_line, end_line
if selection then
  start_line = tonumber(selection.start_line) or cursor_line
  end_line = tonumber(selection.end_line) or cursor_line
else
  start_line = math.max(1, cursor_line - context_lines)
  end_line = math.min(total_lines, cursor_line + context_lines)
end
start_line = math.max(1, math.min(start_line, total_lines))
end_line = math.max(start_line, math.min(end_line, total_lines))
local lines = vim.api.nvim_buf_get_lines(bufnr, start_line - 1, end_line, false)

local diagnostics = {}
if include_diagnostics then
  local severity_names = { "ERROR", "WARN", "INFO", "HINT" }
  local ok, found = pcall(vim.diagnostic.get, bufnr)
  if ok then
    for _, diagnostic in ipairs(found) do
      table.insert(diagnostics, {
        line = diagnostic.lnum + 1,
        col = diagnostic.col + 1,
        end_line = diagnostic.end_lnum and (diagnostic.end_lnum + 1) or nil,
        end_col = diagnostic.end_col and (diagnostic.end_col + 1) or nil,
        severity = severity_names[diagnostic.severity] or tostring(diagnostic.severity),
        message = diagnostic.message,
        source = diagnostic.source,
        code = diagnostic.code,
      })
    end
  end
end

local buffers = {}
if opts.include_buffers ~= false then
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buf) and vim.api.nvim_get_option_value("buflisted", { buf = buf }) then
      local buffer_name = vim.api.nvim_buf_get_name(buf)
      if buffer_name ~= "" and vim.bo[buf].buftype == "" then
        table.insert(buffers, {
          bufnr = buf,
          name = vim.fn.fnamemodify(buffer_name, ":~:."),
          modified = vim.bo[buf].modified,
          current = buf == bufnr,
        })
      end
    end
  end
end

return {
  connected = true,
  has_buffer = true,
  bufnr = bufnr,
  file = path,
  relative_file = relative,
  file_name = name,
  filetype = filetype,
  cursor_line = cursor_line,
  cursor_col = cursor_col,
  total_lines = total_lines,
  modified = modified,
  modifiable = modifiable,
  changedtick = changedtick,
  mode = mode,
  selection = selection,
  context = { start_line = start_line, end_line = end_line, lines = lines },
  diagnostics = diagnostics,
  open_buffers = buffers,
}
`;
}

async function collectContext(client: NvimClient, options: ContextOptions = {}): Promise<NvimContext> {
	return client.execJson<NvimContext>(buildContextChunk(options));
}

function numberLines(lines: string[], startLine: number): string {
	const width = String(startLine + lines.length - 1).length;
	return lines.map((line, index) => `${String(startLine + index).padStart(width, " ")} | ${line}`).join("\n");
}

function renderCodeBlock(context: NvimContext): string {
	const filetype = context.filetype ?? "";
	if (context.selection) {
		return `\`\`\`${filetype}\n${context.selection.text}\n\`\`\``;
	}
	if (context.context) {
		return `\`\`\`${filetype}\n${numberLines(context.context.lines, context.context.start_line)}\n\`\`\``;
	}
	return "";
}

function renderDiagnostics(diagnostics: NvimDiagnostic[]): string {
	return diagnostics
		.map((diagnostic) => {
			const location = `${diagnostic.line}:${diagnostic.col}`;
			const source = diagnostic.source
				? ` (${diagnostic.source}${diagnostic.code !== undefined ? ` ${diagnostic.code}` : ""})`
				: "";
			return `- [${diagnostic.severity}] ${location} ${diagnostic.message}${source}`;
		})
		.join("\n");
}

function formatContext(context: NvimContext, options: { includeBuffers?: boolean } = {}): string {
	if (!context.connected) return "Neovim is not reachable.";
	if (!context.has_buffer) return "Neovim is connected, but no file buffer is open.";

	const lines: string[] = [];
	lines.push("### Neovim Context");
	lines.push(`- **File:** \`${context.relative_file || context.file || "(unnamed)"}\``);
	lines.push(`- **Filetype:** \`${context.filetype || "plain"}\``);
	lines.push(
		`- **Cursor:** line ${context.cursor_line ?? 1}, column ${context.cursor_col ?? 1} of ${context.total_lines ?? 1}`,
	);
	lines.push(`- **Buffer modified:** ${context.modified ? "yes" : "no"}${context.modifiable === false ? " (buffer is nomodifiable)" : ""}`);
	if (context.modified) {
		lines.push(
			"- **Heads up:** this buffer has unsaved changes. If you need to modify this file, ask the user to save or discard it in Neovim first — do not attempt to reload the buffer.",
		);
	}

	if (context.selection) {
		const label = context.selection.kind === "visual" ? "Visual selection" : "Last visual selection";
		lines.push("");
		lines.push(`#### ${label} (lines ${context.selection.start_line}-${context.selection.end_line})`);
		lines.push(`\`\`\`${context.filetype || ""}`);
		lines.push(context.selection.text);
		lines.push("```");
	}

	if (context.context) {
		lines.push("");
		lines.push(`#### Source (lines ${context.context.start_line}-${context.context.end_line})`);
		lines.push(`\`\`\`${context.filetype || ""}`);
		lines.push(numberLines(context.context.lines, context.context.start_line));
		lines.push("```");
	}

	const diagnostics = context.diagnostics ?? [];
	if (diagnostics.length > 0) {
		lines.push("");
		lines.push(`#### Diagnostics (${diagnostics.length})`);
		lines.push(renderDiagnostics(diagnostics));
	}

	if (options.includeBuffers !== false && context.open_buffers && context.open_buffers.length > 0) {
		lines.push("");
		lines.push(`#### Open buffers (${context.open_buffers.length})`);
		for (const buffer of context.open_buffers) {
			const flags = [buffer.modified ? "modified" : undefined, buffer.current ? "current" : undefined]
				.filter(Boolean)
				.join(", ");
			lines.push(`- [${buffer.bufnr}] \`${buffer.name}\`${flags ? ` (${flags})` : ""}`);
		}
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 6. Buffer synchronisation
// ---------------------------------------------------------------------------

/**
 * Reload a file buffer from disk after pi wrote to it. This is sent as a
 * fire-and-forget RPC notification: we only touch buffers that are unmodified
 * (so the user never loses unsaved work) and use a targeted `:edit` inside
 * `nvim_buf_call`. Neovim's 'undoreload' keeps the undo tree intact, and we
 * restore every window view so the cursor does not jump.
 */
function buildSyncChunk(absolutePath: string): string {
	return `
local requested = ${toLuaString(absolutePath)}
local absolute = vim.fn.fnamemodify(requested, ":p")
local bufnr = vim.fn.bufnr(absolute)
if bufnr == -1 then
  for _, candidate in ipairs(vim.api.nvim_list_bufs()) do
    local candidate_name = vim.api.nvim_buf_get_name(candidate)
    if candidate_name ~= "" and vim.fn.fnamemodify(candidate_name, ":p") == absolute then
      bufnr = candidate
      break
    end
  end
end
if bufnr == -1 then
  return { synced = false, reason = "not-open", path = absolute }
end
if not vim.api.nvim_buf_is_loaded(bufnr) then
  return { synced = false, reason = "not-loaded", bufnr = bufnr, path = absolute }
end
if vim.bo[bufnr].buftype ~= "" then
  return { synced = false, reason = "not-file", bufnr = bufnr, path = absolute }
end
if vim.bo[bufnr].modified then
  vim.notify("[pi] " .. absolute .. " has unsaved changes; skipped reload", vim.log.levels.WARN)
  return { synced = false, reason = "modified", bufnr = bufnr, path = absolute }
end
local views = {}
for _, window in ipairs(vim.fn.win_findbuf(bufnr)) do
  if vim.api.nvim_win_is_valid(window) then
    views[window] = vim.api.nvim_win_call(window, function() return vim.fn.winsaveview() end)
  end
end
local ok, err = pcall(function()
  vim.api.nvim_buf_call(bufnr, function()
    vim.cmd("silent! edit")
  end)
end)
for window, view in pairs(views) do
  if vim.api.nvim_win_is_valid(window) then
    vim.api.nvim_win_call(window, function() vim.fn.winrestview(view) end)
  end
end
if not ok then
  vim.notify("[pi] Failed to reload " .. absolute .. ": " .. tostring(err), vim.log.levels.ERROR)
  return { synced = false, reason = "error", error = tostring(err), bufnr = bufnr, path = absolute }
end
return { synced = true, bufnr = bufnr, path = absolute }
`;
}

/** Fire-and-forget a buffer reload as a real RPC notification. */
function notifyBufferSync(client: NvimClient, absolutePath: string): void {
	client.notifyLua(buildSyncChunk(absolutePath));
}

interface BufferStatus {
	open: boolean;
	bufnr?: number;
	name?: string;
	modified?: boolean;
	buftype?: string;
}

/** Report whether a path is loaded in Neovim and whether its buffer is dirty. */
function buildBufferStatusChunk(absolutePath: string): string {
	return `
local requested = ${toLuaString(absolutePath)}
local absolute = vim.fn.fnamemodify(requested, ":p")
local bufnr = vim.fn.bufnr(absolute)
if bufnr == -1 then
  for _, candidate in ipairs(vim.api.nvim_list_bufs()) do
    local candidate_name = vim.api.nvim_buf_get_name(candidate)
    if candidate_name ~= "" and vim.fn.fnamemodify(candidate_name, ":p") == absolute then
      bufnr = candidate
      break
    end
  end
end
if bufnr == -1 or not vim.api.nvim_buf_is_loaded(bufnr) then
  return { open = false }
end
return {
  open = true,
  bufnr = bufnr,
  name = vim.api.nvim_buf_get_name(bufnr),
  modified = vim.bo[bufnr].modified,
  buftype = vim.bo[bufnr].buftype,
}
`;
}

async function getBufferStatus(client: NvimClient, absolutePath: string): Promise<BufferStatus> {
	return client.execJson<BufferStatus>(buildBufferStatusChunk(absolutePath));
}

// ---------------------------------------------------------------------------
// 7. Neovim-side Lua bindings
// ---------------------------------------------------------------------------
//
// Installed once per session. Provides `:Pi <action>` and `<Plug>` mappings that
// capture the current visual selection and forward a preset command to the pi
// terminal. Users can map their preferred keys to the <Plug> mappings, e.g.:
//
//   vim.keymap.set("x", "<leader>ae", "<Plug>(PiExplain)")
//   vim.keymap.set("x", "<leader>ar", "<Plug>(PiRefactor)")
//   vim.keymap.set("n", "<leader>af", "<Plug>(PiFix)")
//   vim.keymap.set("n", "<leader>ag", "<Plug>(PiReview)")

const NVIM_BINDINGS_LUA = `
-- Installed by the pi Neovim extension (idempotent).
_G.PiNvim = _G.PiNvim or {}
local Pi = _G.PiNvim

Pi.actions = {
  review = "/nvim-review",
  explain = "/nvim-explain",
  refactor = "/nvim-refactor",
  fix = "/nvim-fix",
}

-- Capture the live visual selection into vim.g.pi_selection so pi can read it
-- even after Neovim leaves visual mode.
function Pi.capture_selection()
  local mode = vim.fn.mode()
  if mode ~= "v" and mode ~= "V" and mode ~= string.char(22) then return end
  local startpos = vim.fn.getpos("v")
  local endpos = vim.fn.getpos(".")
  local sl, sc = startpos[2], startpos[3]
  local el, ec = endpos[2], endpos[3]
  if sl <= 0 or el <= 0 then return end
  if sl > el or (sl == el and sc > ec) then
    sl, el = el, sl
    sc, ec = ec, sc
  end
  local lines = vim.api.nvim_buf_get_lines(0, sl - 1, el, false)
  if #lines == 0 then return end
  vim.g.pi_selection = vim.json.encode({
    kind = "pending",
    text = table.concat(lines, string.char(10)),
    start_line = sl,
    start_col = sc,
    end_line = el,
    end_col = ec,
    mode = mode,
    time = os.time(),
  })
end

-- Locate the terminal channel running pi. Override with:
--   vim.g.pi_term_channel = <channel id>
function Pi.find_terminal()
  if type(vim.g.pi_term_channel) == "number" and vim.g.pi_term_channel ~= 0 then
    return vim.g.pi_term_channel
  end
  for _, buf in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_is_loaded(buf) and vim.bo[buf].buftype == "terminal" then
      local channel = vim.bo[buf].channel
      local name = string.lower(tostring(vim.api.nvim_buf_get_name(buf) or ""))
      local title = string.lower(tostring(vim.b[buf].term_title or ""))
      if channel and channel ~= 0 then
        if string.find(name, "pi", 1, true) or string.find(title, "pi", 1, true) then
          return channel
        end
      end
    end
  end
  return nil
end

function Pi.send(action)
  Pi.capture_selection()
  local command = Pi.actions[action]
  if not command and type(action) == "string" and action:sub(1, 1) == "/" then
    command = action
  end
  if not command then
    vim.notify("[pi] Unknown action: " .. tostring(action), vim.log.levels.ERROR)
    return
  end
  local channel = Pi.find_terminal()
  if not channel then
    vim.notify("[pi] Could not find the pi terminal. Set vim.g.pi_term_channel.", vim.log.levels.WARN)
    return
  end
  vim.api.nvim_chan_send(channel, command .. string.char(13))
end

pcall(vim.api.nvim_del_user_command, "Pi")
vim.api.nvim_create_user_command("Pi", function(args)
  -- When invoked from visual mode Neovim passes the selection as a range
  -- (":'<,'>Pi explain"). Stash those exact lines for pi to read.
  if args.range >= 1 then
    local lines = vim.api.nvim_buf_get_lines(0, args.line1 - 1, args.line2, false)
    if #lines > 0 then
      vim.g.pi_selection = vim.json.encode({
        kind = "pending",
        text = table.concat(lines, string.char(10)),
        start_line = args.line1,
        end_line = args.line2,
        start_col = 1,
        end_col = #(lines[#lines] or ""),
        time = os.time(),
      })
    end
  end
  Pi.send(args.args ~= "" and args.args or "explain")
end, {
  nargs = "?",
  range = true,
  complete = function()
    return { "review", "explain", "refactor", "fix" }
  end,
  desc = "Send a preset prompt to the pi agent",
})

vim.keymap.set("n", "<Plug>(PiReview)", function() Pi.send("review") end, { silent = true })
vim.keymap.set("n", "<Plug>(PiExplain)", function() Pi.send("explain") end, { silent = true })
vim.keymap.set("x", "<Plug>(PiExplain)", function() Pi.send("explain") end, { silent = true })
vim.keymap.set("x", "<Plug>(PiRefactor)", function() Pi.send("refactor") end, { silent = true })
vim.keymap.set("n", "<Plug>(PiFix)", function() Pi.send("fix") end, { silent = true })
`;

// ---------------------------------------------------------------------------
// 8. pi tools, commands and lifecycle hooks
// ---------------------------------------------------------------------------

const getContextParameters = Type.Object({
	include_buffers: Type.Optional(
		Type.Boolean({ description: "Include other listed buffers in the result (default: true)." }),
	),
	context_lines: Type.Optional(
		Type.Number({ description: "Lines of surrounding source to include when there is no selection (default: 50)." }),
	),
	include_diagnostics: Type.Optional(
		Type.Boolean({ description: "Include LSP diagnostics for the buffer (default: true)." }),
	),
});

const readBufferParameters = Type.Object({
	target: Type.Optional(
		Type.String({ description: "Buffer name or number. Defaults to the active code buffer." }),
	),
});

const commandParameters = Type.Object({
	command: Type.String({ description: "Ex command to run, with or without a leading ':' (e.g. 'checktime', ':w')." }),
	buffer: Type.Optional(
		Type.String({
			description: "File path or buffer number to run the command in. Defaults to the user's active code buffer.",
		}),
	),
});

const diagnosticsParameters = Type.Object({
	scope: Type.Optional(
		StringEnum(["line", "buffer"] as const, {
			description: "Return diagnostics for the cursor line or the whole buffer (default: buffer).",
		}),
	),
	severity: Type.Optional(
		StringEnum(["error", "warning", "all"] as const, {
			description: "Minimum severity to include (default: all).",
		}),
	),
});

function textResult(text: string, details: unknown): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function errorResult(error: unknown): AgentToolResult<unknown> {
	const message = errorMessage(error);
	return { content: [{ type: "text", text: `Neovim error: ${message}` }], details: { error: message } };
}

function truncateText(text: string, maxLines: number, maxChars = 20000): string {
	const lines = text.split("\n");
	const sliced = lines.length > maxLines ? `${lines.slice(0, maxLines).join("\n")}\n… (truncated)` : text;
	return sliced.length > maxChars ? `${sliced.slice(0, maxChars)}\n… (truncated)` : sliced;
}

async function runContextPrompt(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	client: NvimClient,
	options: ContextOptions & { instruction: string },
): Promise<void> {
	let context: NvimContext;
	try {
		context = await collectContext(client, options);
	} catch (error) {
		ctx.ui.notify(`[Neovim] ${errorMessage(error)}`, "error");
		return;
	}
	if (!context.has_buffer) {
		ctx.ui.notify("[Neovim] No file buffer is open.", "warning");
		return;
	}

	const parts: string[] = [options.instruction, ""];
	const location = `${context.relative_file || context.file || "(unnamed)"} (${context.filetype || "plain"})`;
	parts.push(`File: \`${location}\`, cursor at ${context.cursor_line}:${context.cursor_col}.`);
	if (context.selection) {
		parts.push(
			`${context.selection.kind === "visual" ? "Current visual selection" : "Last captured selection"}: lines ${context.selection.start_line}-${context.selection.end_line}.`,
		);
	}
	parts.push("");
	parts.push(renderCodeBlock(context));

	const diagnostics = context.diagnostics ?? [];
	if (diagnostics.length > 0) {
		parts.push("");
		parts.push("Relevant diagnostics:");
		parts.push(renderDiagnostics(diagnostics));
	}

	pi.sendUserMessage(parts.join("\n"));
}

async function runGitReview(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const run = async (args: string[]): Promise<string> => {
		try {
			const result = await pi.exec("git", args, { cwd: ctx.cwd });
			return result.stdout.trim();
		} catch (error) {
			return "";
		}
	};

	const status = await run(["status", "--short"]);
	const unstaged = await run(["diff", "--no-color"]);
	const staged = await run(["diff", "--cached", "--no-color"]);

	if (!status && !unstaged && !staged) {
		ctx.ui.notify("[Neovim] Nothing to review (no git changes or not a git repository).", "info");
		return;
	}

	const parts: string[] = [
		"Review the current git changes. Focus on correctness, edge cases, and regressions. Call out anything risky before suggesting edits.",
	];
	if (status) parts.push("", "### git status", "```", truncateText(status, 200), "```");
	if (unstaged) parts.push("", "### unstaged diff", "```diff", truncateText(unstaged, 400), "```");
	if (staged) parts.push("", "### staged diff", "```diff", truncateText(staged, 400), "```");
	pi.sendUserMessage(parts.join("\n"));
}

export default function neovimExtension(pi: ExtensionAPI): void {
	const socketPath = process.env.NVIM;

	// Outside Neovim there is nothing to do. pi keeps its standard CLI behavior.
	if (!socketPath) return;

	const client = new NvimClient(socketPath);

	// Buffers that pi tried to edit while they had unsaved changes. While a lock
	// is active, mutating tools are blocked until the user saves or discards the
	// buffer, so the agent cannot route around the conflict.
	const bufferLocks = new Map<string, string>();
	const LOCKED_TOOLS = new Set(["write", "edit", "bash", "powershell", "nvim_command"]);

	async function refreshBufferLocks(): Promise<void> {
		for (const path of [...bufferLocks.keys()]) {
			try {
				const status = await getBufferStatus(client, path);
				if (!(status.open && status.buftype === "" && status.modified)) {
					bufferLocks.delete(path);
				}
			} catch {
				// Neovim is unreachable: the lock is moot.
				bufferLocks.delete(path);
			}
		}
	}

	function lockReason(): string {
		const names = [...bufferLocks.values()].map((name) => `\`${name}\``).join(", ");
		return (
			`A Neovim buffer conflict is active: ${names} has unsaved changes. ` +
			"Mutating tools (write, edit, bash, nvim_command) are blocked until the user saves or discards the buffer. " +
			"Do not try to work around it. Ask the user to resolve the file in Neovim, then continue."
		);
	}

	// --- Tools -------------------------------------------------------------

	pi.registerTool({
		name: "nvim_get_context",
		label: "Neovim Context",
		description:
			"Read the live Neovim editor context: active file, cursor position, buffer modification state, visual selection (or surrounding source), and LSP diagnostics. Use this before editing files that are open in Neovim.",
		promptSnippet: "Read the user's live Neovim editor context (file, cursor, selection, diagnostics)",
		promptGuidelines: [
			"Use nvim_get_context to inspect the user's live Neovim editor state before editing files they have open.",
			"If nvim_get_context reports a buffer is modified (unsaved changes), ask the user to save or discard it before editing that file; do not attempt to reload the buffer.",
		],
		parameters: getContextParameters,
		async execute(_toolCallId, params) {
			try {
				const context = await collectContext(client, {
					contextLines: params.context_lines,
					includeBuffers: params.include_buffers,
					includeDiagnostics: params.include_diagnostics,
				});
				// Clear a stale lock if the user has since saved or discarded.
				if (context.file && !context.modified) bufferLocks.delete(context.file);
				let text = formatContext(context, { includeBuffers: params.include_buffers });
				const lockedName = context.file ? bufferLocks.get(context.file) : undefined;
				if (lockedName) {
					text =
						`> ⚠️ **Neovim buffer conflict:** \`${lockedName}\` has unsaved changes. ` +
						"Mutating tools are blocked until the user saves or discards it.\n\n" +
						text;
				}
				return textResult(text, { context, locked: Boolean(lockedName) });
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	pi.registerTool({
		name: "nvim_read_buffer",
		label: "Read Neovim Buffer",
		description:
			"Read the live in-memory contents of a Neovim buffer, including unsaved changes. Defaults to the active code buffer.",
		promptSnippet: "Read in-memory buffer contents from Neovim, including unsaved edits",
		promptGuidelines: [
			"Use nvim_read_buffer when you need unsaved editor contents instead of the file on disk.",
		],
		parameters: readBufferParameters,
		async execute(_toolCallId, params) {
			try {
				const target = params.target ?? "";
				const result = await client.execJson<{
					found: boolean;
					bufnr?: number;
					name?: string;
					lines?: string[];
					total_lines?: number;
				}>(buildReadBufferChunk(target));

				if (!result.found) {
					return textResult("No matching buffer is loaded in Neovim.", { target });
				}
				const text = (result.lines ?? []).join("\n");
				const truncated = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
				let output = truncated.content;
				if (truncated.truncated) {
					output += `\n\n[Buffer truncated: showing ${truncated.outputLines} of ${truncated.totalLines} lines${result.name ? ` from ${result.name}` : ""}]`;
				}
				return textResult(output.length > 0 ? output : "(Buffer is empty)", {
					bufnr: result.bufnr,
					name: result.name,
					totalLines: result.total_lines,
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	pi.registerTool({
		name: "nvim_command",
		label: "Neovim Command",
		description:
			"Run an Ex command in the parent Neovim session. Commands run in the context of the user's active code buffer (not pi's terminal), and force-reload commands that would discard unsaved changes are refused. Optionally pass `buffer` to target a specific file.",
		promptSnippet: "Run an Ex command in the user's Neovim editor",
		promptGuidelines: [
			"Use nvim_command to run Ex commands such as checktime or w; it targets the user's active code buffer, not pi's terminal buffer.",
		],
		parameters: commandParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const result = await client.command(params.command, params.buffer);
				if (result.blocked) {
					ctx.ui.notify(
						`[Neovim] ${result.reason ?? "unsafe command"} Save or discard your changes first.`,
						"warning",
					);
					return textResult(`Refused in Neovim: ${result.reason ?? "unsafe command"}`, {
						blocked: true,
						reason: result.reason,
					});
				}
				const where = result.buffer ? ` in \`${result.buffer}\`` : "";
				return textResult(`Executed in Neovim${where}: ${params.command}`, {
					command: params.command,
					buffer: result.buffer,
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	pi.registerTool({
		name: "nvim_diagnostics",
		label: "Neovim Diagnostics",
		description:
			"Get LSP diagnostics reported by Neovim for the current cursor line or the whole buffer. Use this to find lint/type errors without the user pasting them.",
		promptSnippet: "Read LSP diagnostics from the user's Neovim editor",
		promptGuidelines: [
			"Use nvim_diagnostics to check for LSP errors and warnings in the user's Neovim buffer before and after edits.",
		],
		parameters: diagnosticsParameters,
		async execute(_toolCallId, params) {
			try {
				const context = await collectContext(client, {
					contextLines: 0,
					includeBuffers: false,
					includeDiagnostics: true,
				});
				if (!context.has_buffer) {
					return textResult("No file buffer is open in Neovim.", {});
				}
				let diagnostics = context.diagnostics ?? [];
				if (params.scope === "line") {
					diagnostics = diagnostics.filter((diagnostic) => diagnostic.line === context.cursor_line);
				}
				if (params.severity === "error") {
					diagnostics = diagnostics.filter((diagnostic) => diagnostic.severity === "ERROR");
				} else if (params.severity === "warning") {
					diagnostics = diagnostics.filter(
						(diagnostic) => diagnostic.severity === "ERROR" || diagnostic.severity === "WARN",
					);
				}
				const text =
					diagnostics.length === 0 ? "No matching LSP diagnostics." : renderDiagnostics(diagnostics);
				return textResult(text, {
					file: context.relative_file,
					cursorLine: context.cursor_line,
					diagnostics,
				});
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	// --- Commands ----------------------------------------------------------
	//
	// These are the presets invoked by the Neovim bindings (:Pi <action> or the
	// <Plug>(Pi*) mappings).

	pi.registerCommand("nvim-explain", {
		description: "Explain the current Neovim selection or cursor context",
		handler: async (_args, ctx) => {
			await runContextPrompt(pi, ctx, client, {
				instruction:
					"Explain the following code clearly and concisely. Describe what it does, any subtle behavior, and anything that looks off.",
				contextLines: 15,
			});
		},
	});

	pi.registerCommand("nvim-refactor", {
		description: "Suggest a refactor for the current Neovim selection or cursor context",
		handler: async (_args, ctx) => {
			await runContextPrompt(pi, ctx, client, {
				instruction:
					"Propose a refactor for the following code. Explain the reasoning and only apply edits once the approach is clear.",
				contextLines: 15,
			});
		},
	});

	pi.registerCommand("nvim-fix", {
		description: "Fix LSP diagnostics on the current line or in the current Neovim buffer",
		handler: async (_args, ctx) => {
			let context: NvimContext;
			try {
				context = await collectContext(client, { contextLines: 20, includeBuffers: false });
			} catch (error) {
				ctx.ui.notify(`[Neovim] ${errorMessage(error)}`, "error");
				return;
			}
			if (!context.has_buffer) {
				ctx.ui.notify("[Neovim] No file buffer is open.", "warning");
				return;
			}
			const all = context.diagnostics ?? [];
			const lineDiagnostics = all.filter((diagnostic) => diagnostic.line === context.cursor_line);
			const diagnostics = lineDiagnostics.length > 0 ? lineDiagnostics : all;
			if (diagnostics.length === 0) {
				ctx.ui.notify("[Neovim] No LSP diagnostics in the current buffer.", "info");
				return;
			}
			const scope =
				lineDiagnostics.length > 0 ? `line ${context.cursor_line}` : "the current buffer";
			const parts: string[] = [
				`Fix the following LSP diagnostics on ${scope} in \`${context.relative_file || context.file}\`.`,
				"",
				renderDiagnostics(diagnostics),
				"",
				renderCodeBlock(context),
			];
			pi.sendUserMessage(parts.join("\n"));
		},
	});

	pi.registerCommand("nvim-review", {
		description: "Review the current git changes with Neovim context",
		handler: async (_args, ctx) => {
			await runGitReview(pi, ctx);
		},
	});

	// --- Lifecycle hooks ---------------------------------------------------

	// Detect edit/write conflicts with unsaved Neovim buffers and lock them.
	// While locked, mutating tools are blocked so the agent cannot work around
	// the conflict. Locks clear automatically once the buffer is saved/discarded.
	pi.on("tool_call", async (event, ctx) => {
		if (bufferLocks.size > 0) await refreshBufferLocks();

		if (bufferLocks.size > 0 && LOCKED_TOOLS.has(event.toolName)) {
			return { block: true, reason: lockReason() };
		}

		if (!(isToolCallEventType("write", event) || isToolCallEventType("edit", event))) return;
		const rawPath = event.input.path;
		if (!rawPath) return;
		const absolutePath = isAbsolute(rawPath) ? rawPath : resolvePath(ctx.cwd, rawPath);
		try {
			const status = await getBufferStatus(client, absolutePath);
			if (status.open && status.buftype === "" && status.modified) {
				const name = basename(absolutePath);
				bufferLocks.set(absolutePath, name);
				ctx.ui.notify(
					`[Neovim] ${name} has unsaved changes. pi is blocked until you save or discard it.`,
					"warning",
				);
				return { block: true, reason: lockReason() };
			}
		} catch {
			// If Neovim is unreachable we must not block normal editing.
		}
	});

	// Keep Neovim buffers in sync whenever pi writes to a file that is open in
	// an unmodified buffer. Emitted as an RPC notification.
	pi.on("tool_result", async (event, ctx) => {
		if (!(isWriteToolResult(event) || isEditToolResult(event))) return;
		if (event.isError) return;
		const rawPath = event.input.path;
		if (typeof rawPath !== "string" || rawPath.length === 0) return;

		const absolutePath = isAbsolute(rawPath) ? rawPath : resolvePath(ctx.cwd, rawPath);
		// Fire-and-forget: Neovim reloads the buffer itself and notifies the user
		// if it had to skip because of unsaved changes.
		notifyBufferSync(client, absolutePath);
	});

	pi.on("session_start", async (_event, ctx) => {
		bufferLocks.clear();
		const connected = await client.ping();
		if (!connected) {
			ctx.ui.notify("[Neovim] $NVIM is set, but the Neovim RPC socket is not reachable.", "warning");
			return;
		}
		// Install the Neovim-side helpers and keymaps (best effort).
		client.notifyLua(NVIM_BINDINGS_LUA);
		try {
			const context = await collectContext(client, {
				contextLines: 0,
				includeBuffers: false,
				includeDiagnostics: false,
			});
			if (context.has_buffer) {
				ctx.ui.notify(`[Neovim] Connected to ${context.relative_file}`, "info");
			} else {
				ctx.ui.notify("[Neovim] Connected (no file buffer open)", "info");
			}
		} catch {
			// Connection is already confirmed; ignore context probing errors.
		}
	});

	pi.on("session_shutdown", () => {
		bufferLocks.clear();
		client.close();
	});
}

// Kept separate from the context path so reading a buffer stays small.
function buildReadBufferChunk(target: string): string {
	return `
local target = ${toLuaString(target)}
local bufnr = -1
if target ~= "" then
  bufnr = vim.fn.bufnr(target)
  if bufnr == -1 then
    local absolute = vim.fn.fnamemodify(target, ":p")
    bufnr = vim.fn.bufnr(absolute)
    if bufnr == -1 then
      for _, candidate in ipairs(vim.api.nvim_list_bufs()) do
        local candidate_name = vim.api.nvim_buf_get_name(candidate)
        if candidate_name ~= "" and vim.fn.fnamemodify(candidate_name, ":p") == absolute then
          bufnr = candidate
          break
        end
      end
    end
  end
else
  bufnr = vim.api.nvim_get_current_buf()
  if vim.bo[bufnr].buftype == "terminal" then
    for _, win in ipairs(vim.api.nvim_tabpage_list_wins(0)) do
      local candidate = vim.api.nvim_win_get_buf(win)
      if vim.bo[candidate].buftype == "" and vim.api.nvim_buf_get_name(candidate) ~= "" then
        bufnr = candidate
        break
      end
    end
  end
end
if bufnr == -1 or not vim.api.nvim_buf_is_valid(bufnr) then
  return { found = false }
end
return {
  found = true,
  bufnr = bufnr,
  name = vim.api.nvim_buf_get_name(bufnr),
  total_lines = vim.api.nvim_buf_line_count(bufnr),
  lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false),
}
`;
}
