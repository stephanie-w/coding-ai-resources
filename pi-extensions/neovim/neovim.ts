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
// 6.5. Neovim LSP RPC helpers (definition, references, symbols, call hierarchy, hover)
// ---------------------------------------------------------------------------

interface LspLocation {
	file: string;
	relative_file: string;
	start_line: number;
	start_col: number;
	end_line: number;
	end_col: number;
	preview?: string;
}

interface LspDefinitionResult {
	success: boolean;
	reason?: string;
	file?: string;
	relative_file?: string;
	line?: number;
	col?: number;
	definitions?: LspLocation[];
}

interface LspReferencesResult {
	success: boolean;
	reason?: string;
	file?: string;
	relative_file?: string;
	line?: number;
	col?: number;
	total?: number;
	truncated?: boolean;
	references?: LspLocation[];
}

interface LspDocumentSymbol {
	name: string;
	kind: string;
	detail?: string;
	depth?: number;
	start_line?: number;
	end_line?: number;
}

interface LspWorkspaceSymbol {
	name: string;
	kind: string;
	container?: string;
	location?: LspLocation;
}

interface LspSymbolsResult {
	success: boolean;
	reason?: string;
	scope?: "document" | "workspace";
	file?: string;
	relative_file?: string;
	query?: string;
	symbols?: Array<LspDocumentSymbol | LspWorkspaceSymbol>;
}

interface LspCallHierarchyItem {
	name: string;
	kind: string;
	detail?: string;
	file: string;
	relative_file: string;
	line: number;
	col: number;
	preview?: string;
}

interface LspCallHierarchyResult {
	success: boolean;
	reason?: string;
	root?: {
		name: string;
		kind: string;
		detail?: string;
		file: string;
		relative_file: string;
		line: number;
		col: number;
	};
	incoming?: LspCallHierarchyItem[];
	outgoing?: LspCallHierarchyItem[];
}

interface LspHoverResult {
	success: boolean;
	reason?: string;
	file?: string;
	relative_file?: string;
	line?: number;
	col?: number;
	hover?: string;
}

const LSP_LUA_PREAMBLE = `
local SYMBOL_KINDS = {
  [1] = "File", [2] = "Module", [3] = "Namespace", [4] = "Package", [5] = "Class",
  [6] = "Method", [7] = "Property", [8] = "Field", [9] = "Constructor", [10] = "Enum",
  [11] = "Interface", [12] = "Function", [13] = "Variable", [14] = "Constant",
  [15] = "String", [16] = "Number", [17] = "Boolean", [18] = "Array", [19] = "Object",
  [20] = "Key", [21] = "Null", [22] = "EnumMember", [23] = "Struct", [24] = "Event",
  [25] = "Operator", [26] = "TypeParameter"
}

local function is_code_buffer(b)
  return vim.api.nvim_buf_is_valid(b) and vim.bo[b].buftype == "" and vim.api.nvim_buf_get_name(b) ~= ""
end

local function resolve_code_buffer(target_path)
  local bufnr = -1
  if target_path and target_path ~= "" then
    local absolute = vim.fn.fnamemodify(target_path, ":p")
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
    if bufnr == -1 and vim.fn.filereadable(absolute) == 1 then
      bufnr = vim.fn.bufadd(absolute)
      vim.fn.bufload(bufnr)
    end
    local name = bufnr ~= -1 and vim.api.nvim_buf_get_name(bufnr) or absolute
    return bufnr, name
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
      if bufnr == -1 then
        for _, b in ipairs(vim.api.nvim_list_bufs()) do
          if is_code_buffer(b) then bufnr = b; break end
        end
      end
    end
    local name = bufnr ~= -1 and vim.api.nvim_buf_get_name(bufnr) or ""
    return bufnr, name
  end
end

local function get_clients_for_buf(b)
  if vim.lsp.get_clients then
    return vim.lsp.get_clients({ bufnr = b })
  elseif vim.lsp.get_active_clients then
    return vim.lsp.get_active_clients({ bufnr = b })
  end
  return {}
end

local function get_preview_line(file_path, line_nr)
  if not line_nr or line_nr <= 0 then return "" end
  local b = vim.fn.bufnr(file_path)
  if b ~= -1 and vim.api.nvim_buf_is_loaded(b) then
    local total = vim.api.nvim_buf_line_count(b)
    if line_nr <= total then
      local lines = vim.api.nvim_buf_get_lines(b, line_nr - 1, line_nr, false)
      return lines[1] or ""
    end
  end
  if vim.fn.filereadable(file_path) == 1 then
    local lines = vim.fn.readfile(file_path, '', line_nr)
    if #lines >= line_nr then
      return lines[line_nr] or ""
    end
  end
  return ""
end

local function normalize_loc(loc)
  if not loc then return nil end
  local uri = loc.uri or loc.targetUri
  local range = loc.range or loc.targetSelectionRange or loc.targetRange
  if not uri or not range then return nil end
  local fname = vim.uri_to_fname(uri)
  local sl = (range.start and range.start.line or 0) + 1
  local sc = (range.start and range.start.character or 0) + 1
  local el = (range["end"] and range["end"].line or 0) + 1
  local ec = (range["end"] and range["end"].character or 0) + 1
  local preview = get_preview_line(fname, sl)
  return {
    file = fname,
    relative_file = vim.fn.fnamemodify(fname, ":~:."),
    start_line = sl,
    start_col = sc,
    end_line = el,
    end_col = ec,
    preview = preview:gsub("^%s+", ""):gsub("%s+$", ""),
  }
end
`;

function buildLspDefinitionChunk(target?: string, line?: number, col?: number): string {
	return `
${LSP_LUA_PREAMBLE}
local target = ${target ? toLuaString(target) : "nil"}
local line = ${line !== undefined ? line : "nil"}
local col = ${col !== undefined ? col : "nil"}

local bufnr, path = resolve_code_buffer(target)
if bufnr == -1 or not vim.api.nvim_buf_is_valid(bufnr) then
  return { success = false, reason = "No valid code buffer found in Neovim" }
end

local clients = get_clients_for_buf(bufnr)
if #clients == 0 then
  return { success = false, reason = "No LSP clients attached to buffer " .. path }
end

local line_idx = math.max(0, (line or 1) - 1)
local col_idx = math.max(0, (col or 1) - 1)
local params = {
  textDocument = { uri = vim.uri_from_bufnr(bufnr) },
  position = { line = line_idx, character = col_idx },
}

local responses = vim.lsp.buf_request_sync(bufnr, "textDocument/definition", params, 4000)
if not responses or vim.tbl_isempty(responses) then
  responses = vim.lsp.buf_request_sync(bufnr, "textDocument/typeDefinition", params, 3000)
end
if not responses or vim.tbl_isempty(responses) then
  return { success = false, reason = "LSP definition request timed out or returned no responses" }
end

local definitions = {}
for client_id, response in pairs(responses) do
  if response.result then
    local res = response.result
    if type(res) == "table" then
      if res.uri or res.targetUri then
        local item = normalize_loc(res)
        if item then table.insert(definitions, item) end
      else
        for _, loc in ipairs(res) do
          local item = normalize_loc(loc)
          if item then table.insert(definitions, item) end
        end
      end
    end
  end
end

return {
  success = true,
  file = path,
  relative_file = vim.fn.fnamemodify(path, ":~:."),
  line = line or 1,
  col = col or 1,
  definitions = definitions,
}
`;
}

function buildLspReferencesChunk(
	target?: string,
	line?: number,
	col?: number,
	includeDeclaration = true,
	limit = 50,
): string {
	return `
${LSP_LUA_PREAMBLE}
local target = ${target ? toLuaString(target) : "nil"}
local line = ${line !== undefined ? line : "nil"}
local col = ${col !== undefined ? col : "nil"}
local include_decl = ${includeDeclaration ? "true" : "false"}
local max_limit = ${limit > 0 ? limit : 50}

local bufnr, path = resolve_code_buffer(target)
if bufnr == -1 or not vim.api.nvim_buf_is_valid(bufnr) then
  return { success = false, reason = "No valid code buffer found in Neovim" }
end

local clients = get_clients_for_buf(bufnr)
if #clients == 0 then
  return { success = false, reason = "No LSP clients attached to buffer " .. path }
end

local line_idx = math.max(0, (line or 1) - 1)
local col_idx = math.max(0, (col or 1) - 1)
local params = {
  textDocument = { uri = vim.uri_from_bufnr(bufnr) },
  position = { line = line_idx, character = col_idx },
  context = { includeDeclaration = include_decl },
}

local responses = vim.lsp.buf_request_sync(bufnr, "textDocument/references", params, 5000)
if not responses or vim.tbl_isempty(responses) then
  return { success = false, reason = "LSP references request timed out or returned no responses" }
end

local refs = {}
local count = 0
local truncated = false

for client_id, response in pairs(responses) do
  if response.result and type(response.result) == "table" then
    for _, loc in ipairs(response.result) do
      count = count + 1
      if #refs < max_limit then
        local item = normalize_loc(loc)
        if item then table.insert(refs, item) end
      else
        truncated = true
      end
    end
  end
end

return {
  success = true,
  file = path,
  relative_file = vim.fn.fnamemodify(path, ":~:."),
  line = line or 1,
  col = col or 1,
  total = count,
  truncated = truncated,
  references = refs,
}
`;
}

function buildLspSymbolsChunk(target?: string, query?: string, scope: "document" | "workspace" = "document"): string {
	return `
${LSP_LUA_PREAMBLE}
local target = ${target ? toLuaString(target) : "nil"}
local query = ${query ? toLuaString(query) : "nil"}
local scope = ${toLuaString(scope)}

local bufnr, path = resolve_code_buffer(target)
local clients = bufnr ~= -1 and get_clients_for_buf(bufnr) or (vim.lsp.get_clients and vim.lsp.get_clients() or vim.lsp.get_active_clients())
if #clients == 0 then
  return { success = false, reason = "No LSP clients active in Neovim" }
end

if scope == "workspace" or (query and query ~= "") then
  local client_responses = vim.lsp.buf_request_sync(bufnr ~= -1 and bufnr or 0, "workspace/symbol", { query = query or "" }, 5000)
  if not client_responses or vim.tbl_isempty(client_responses) then
    return { success = false, reason = "No workspace symbols returned" }
  end
  local symbols = {}
  for _, resp in pairs(client_responses) do
    if resp.result and type(resp.result) == "table" then
      for _, sym in ipairs(resp.result) do
        local kind = SYMBOL_KINDS[sym.kind] or tostring(sym.kind)
        local loc = normalize_loc(sym.location)
        table.insert(symbols, {
          name = sym.name,
          kind = kind,
          container = sym.containerName,
          location = loc,
        })
        if #symbols >= 100 then break end
      end
    end
  end
  return {
    success = true,
    scope = "workspace",
    query = query or "",
    symbols = symbols,
  }
else
  if bufnr == -1 then
    return { success = false, reason = "No target buffer specified for document symbols" }
  end
  local params = { textDocument = { uri = vim.uri_from_bufnr(bufnr) } }
  local client_responses = vim.lsp.buf_request_sync(bufnr, "textDocument/documentSymbol", params, 4000)
  if not client_responses or vim.tbl_isempty(client_responses) then
    return { success = false, reason = "No document symbols returned for " .. path }
  end
  local function parse_hierarchy(syms, depth)
    local items = {}
    for _, sym in ipairs(syms) do
      local kind = SYMBOL_KINDS[sym.kind] or tostring(sym.kind)
      local start_line = (sym.selectionRange and sym.selectionRange.start.line or (sym.range and sym.range.start.line) or (sym.location and sym.location.range and sym.location.range.start.line) or 0) + 1
      local end_line = (sym.range and sym.range["end"].line or (sym.location and sym.location.range and sym.location.range["end"].line) or start_line - 1) + 1
      local entry = {
        name = sym.name,
        kind = kind,
        detail = sym.detail,
        depth = depth,
        start_line = start_line,
        end_line = end_line,
      }
      table.insert(items, entry)
      if sym.children and #sym.children > 0 then
        local children = parse_hierarchy(sym.children, depth + 1)
        for _, c in ipairs(children) do table.insert(items, c) end
      end
    end
    return items
  end

  local all_symbols = {}
  for _, resp in pairs(client_responses) do
    if resp.result and type(resp.result) == "table" then
      local parsed = parse_hierarchy(resp.result, 0)
      for _, p in ipairs(parsed) do table.insert(all_symbols, p) end
    end
  end

  return {
    success = true,
    scope = "document",
    file = path,
    relative_file = vim.fn.fnamemodify(path, ":~:."),
    symbols = all_symbols,
  }
end
`;
}

function buildLspCallHierarchyChunk(
	target?: string,
	line?: number,
	col?: number,
	direction: "incoming" | "outgoing" | "both" = "both",
): string {
	return `
${LSP_LUA_PREAMBLE}
local target = ${target ? toLuaString(target) : "nil"}
local line = ${line !== undefined ? line : "nil"}
local col = ${col !== undefined ? col : "nil"}
local dir = ${toLuaString(direction)}

local bufnr, path = resolve_code_buffer(target)
if bufnr == -1 or not vim.api.nvim_buf_is_valid(bufnr) then
  return { success = false, reason = "No valid code buffer found in Neovim" }
end

local clients = get_clients_for_buf(bufnr)
if #clients == 0 then
  return { success = false, reason = "No LSP clients attached to buffer " .. path }
end

local line_idx = math.max(0, (line or 1) - 1)
local col_idx = math.max(0, (col or 1) - 1)
local params = {
  textDocument = { uri = vim.uri_from_bufnr(bufnr) },
  position = { line = line_idx, character = col_idx },
}

local prep_responses = vim.lsp.buf_request_sync(bufnr, "textDocument/prepareCallHierarchy", params, 4000)
if not prep_responses or vim.tbl_isempty(prep_responses) then
  return { success = false, reason = "Call hierarchy not supported by LSP server or no symbol found at position" }
end

local target_item = nil
for _, resp in pairs(prep_responses) do
  if resp.result and type(resp.result) == "table" and #resp.result > 0 then
    target_item = resp.result[1]
    break
  end
end

if not target_item then
  return { success = false, reason = "No call hierarchy root symbol found at position" }
end

local incoming = {}
local outgoing = {}

if dir == "incoming" or dir == "both" then
  local inc_resp = vim.lsp.buf_request_sync(bufnr, "callHierarchy/incomingCalls", { item = target_item }, 4000)
  if inc_resp then
    for _, resp in pairs(inc_resp) do
      if resp.result and type(resp.result) == "table" then
        for _, call in ipairs(resp.result) do
          local caller = call.from
          local uri = caller.uri
          local fname = uri and vim.uri_to_fname(uri) or ""
          local r = caller.selectionRange or caller.range
          local sl = (r and r.start and r.start.line or 0) + 1
          local sc = (r and r.start and r.start.character or 0) + 1
          local preview = get_preview_line(fname, sl)
          table.insert(incoming, {
            name = caller.name,
            kind = SYMBOL_KINDS[caller.kind] or tostring(caller.kind),
            detail = caller.detail,
            file = fname,
            relative_file = vim.fn.fnamemodify(fname, ":~:."),
            line = sl,
            col = sc,
            preview = preview:gsub("^%s+", ""):gsub("%s+$", ""),
          })
        end
      end
    end
  end
end

if dir == "outgoing" or dir == "both" then
  local out_resp = vim.lsp.buf_request_sync(bufnr, "callHierarchy/outgoingCalls", { item = target_item }, 4000)
  if out_resp then
    for _, resp in pairs(out_resp) do
      if resp.result and type(resp.result) == "table" then
        for _, call in ipairs(resp.result) do
          local callee = call.to
          local uri = callee.uri
          local fname = uri and vim.uri_to_fname(uri) or ""
          local r = callee.selectionRange or callee.range
          local sl = (r and r.start and r.start.line or 0) + 1
          local sc = (r and r.start and r.start.character or 0) + 1
          local preview = get_preview_line(fname, sl)
          table.insert(outgoing, {
            name = callee.name,
            kind = SYMBOL_KINDS[callee.kind] or tostring(callee.kind),
            detail = callee.detail,
            file = fname,
            relative_file = vim.fn.fnamemodify(fname, ":~:."),
            line = sl,
            col = sc,
            preview = preview:gsub("^%s+", ""):gsub("%s+$", ""),
          })
        end
      end
    end
  end
end

local root_range = target_item.selectionRange or target_item.range
local root_fname = target_item.uri and vim.uri_to_fname(target_item.uri) or path
return {
  success = true,
  root = {
    name = target_item.name,
    kind = SYMBOL_KINDS[target_item.kind] or tostring(target_item.kind),
    detail = target_item.detail,
    file = root_fname,
    relative_file = vim.fn.fnamemodify(root_fname, ":~:."),
    line = (root_range and root_range.start and root_range.start.line or 0) + 1,
    col = (root_range and root_range.start and root_range.start.character or 0) + 1,
  },
  incoming = incoming,
  outgoing = outgoing,
}
`;
}

function buildLspHoverChunk(target?: string, line?: number, col?: number): string {
	return `
${LSP_LUA_PREAMBLE}
local target = ${target ? toLuaString(target) : "nil"}
local line = ${line !== undefined ? line : "nil"}
local col = ${col !== undefined ? col : "nil"}

local bufnr, path = resolve_code_buffer(target)
if bufnr == -1 or not vim.api.nvim_buf_is_valid(bufnr) then
  return { success = false, reason = "No valid code buffer found in Neovim" }
end

local clients = get_clients_for_buf(bufnr)
if #clients == 0 then
  return { success = false, reason = "No LSP clients attached to buffer " .. path }
end

local line_idx = math.max(0, (line or 1) - 1)
local col_idx = math.max(0, (col or 1) - 1)
local params = {
  textDocument = { uri = vim.uri_from_bufnr(bufnr) },
  position = { line = line_idx, character = col_idx },
}

local responses = vim.lsp.buf_request_sync(bufnr, "textDocument/hover", params, 4000)
if not responses or vim.tbl_isempty(responses) then
  return { success = false, reason = "No hover information returned" }
end

local function extract_text(contents)
  if not contents then return nil end
  if type(contents) == "string" then return contents end
  if type(contents) == "table" then
    if contents.kind and contents.value then
      return contents.value
    elseif contents.language and contents.value then
      return "\`\`\`" .. contents.language .. "\\n" .. contents.value .. "\\n\`\`\`"
    elseif #contents > 0 then
      local parts = {}
      for _, c in ipairs(contents) do
        local s = extract_text(c)
        if s and s ~= "" then table.insert(parts, s) end
      end
      return table.concat(parts, "\\n\\n")
    end
  end
  return nil
end

local hovers = {}
for client_id, resp in pairs(responses) do
  if resp.result and resp.result.contents then
    local txt = extract_text(resp.result.contents)
    if txt and txt ~= "" then
      table.insert(hovers, txt)
    end
  end
end

if #hovers == 0 then
  return { success = false, reason = "Empty hover response" }
end

return {
  success = true,
  file = path,
  relative_file = vim.fn.fnamemodify(path, ":~:."),
  line = line or 1,
  col = col or 1,
  hover = table.concat(hovers, "\\n\\n---\\n\\n"),
}
`;
}

// ---------------------------------------------------------------------------
// 7. Neovim-side Lua bindings
// ---------------------------------------------------------------------------
//
// Installed once per session. Provides `:Pi /<command>` and the `Pi.send()` Lua
// API, which capture the current visual selection and forward a command to the
// pi terminal. The command can be any pi slash command or prompt — there are no
// built-in presets. Users bind their own keys in Neovim, e.g.:
//
//   vim.keymap.set("x", "<leader>ae", function() _G.PiNvim.send("/explain") end)
//   vim.keymap.set("n", "<leader>af", function() _G.PiNvim.send("/fix") end)

const NVIM_BINDINGS_LUA = `
-- Installed by the pi Neovim extension (idempotent).
_G.PiNvim = _G.PiNvim or {}
local Pi = _G.PiNvim

-- Optional aliases: map a short name to a pi command, then call
-- Pi.send("name"). e.g. Pi.actions.review = "/review"
Pi.actions = Pi.actions or {}

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
    vim.notify("[pi] No command given. Pass '/<command>' or define Pi.actions.", vim.log.levels.ERROR)
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
  -- (":'<,'>Pi /explain"). Stash those exact lines for pi to read.
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
  if args.args == "" then
    vim.notify("[pi] Usage: :Pi /<command> (e.g. :Pi /explain)", vim.log.levels.WARN)
    return
  end
  Pi.send(args.args)
end, {
  nargs = "?",
  range = true,
  desc = "Send a slash-command to the pi agent",
})
`;

// ---------------------------------------------------------------------------
// 8. pi tools and lifecycle hooks
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

const lspDefinitionParameters = Type.Object({
	path: Type.Optional(Type.String({ description: "Target file path. Defaults to the active code buffer." })),
	line: Type.Number({ description: "1-indexed line number of the symbol." }),
	col: Type.Number({ description: "1-indexed column number of the symbol." }),
});

const lspReferencesParameters = Type.Object({
	path: Type.Optional(Type.String({ description: "Target file path. Defaults to the active code buffer." })),
	line: Type.Number({ description: "1-indexed line number of the symbol." }),
	col: Type.Number({ description: "1-indexed column number of the symbol." }),
	include_declaration: Type.Optional(
		Type.Boolean({ description: "Include declaration in references (default: true)." }),
	),
	limit: Type.Optional(Type.Number({ description: "Max references to return (default: 50)." })),
});

const lspSymbolsParameters = Type.Object({
	path: Type.Optional(
		Type.String({ description: "File path for document symbols. Defaults to active buffer if scope is document." }),
	),
	query: Type.Optional(Type.String({ description: "Search query for workspace symbol search." })),
	scope: Type.Optional(
		StringEnum(["document", "workspace"] as const, {
			description:
				"Symbol scope: document (file outline) or workspace (search symbols across project). Default: document.",
		}),
	),
});

const lspCallHierarchyParameters = Type.Object({
	path: Type.Optional(Type.String({ description: "Target file path. Defaults to the active code buffer." })),
	line: Type.Number({ description: "1-indexed line number of the target function/method." }),
	col: Type.Number({ description: "1-indexed column number of the target function/method." }),
	direction: Type.Optional(
		StringEnum(["incoming", "outgoing", "both"] as const, {
			description: "Call hierarchy direction: incoming (callers), outgoing (callees), or both (default: both).",
		}),
	),
});

const lspHoverParameters = Type.Object({
	path: Type.Optional(Type.String({ description: "Target file path. Defaults to the active code buffer." })),
	line: Type.Number({ description: "1-indexed line number of the symbol." }),
	col: Type.Number({ description: "1-indexed column number of the symbol." }),
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

	pi.registerTool({
		name: "nvim_lsp_definition",
		label: "Neovim LSP Definition",
		description:
			"Jump to the definition or declaration of a symbol using Neovim's active LSP client. Returns exact file, line, column, and preview snippet.",
		promptSnippet: "Go to symbol definition via Neovim LSP",
		promptGuidelines: [
			"Use nvim_lsp_definition to find exact definitions and implementations across workspace files and third-party dependencies.",
		],
		parameters: lspDefinitionParameters,
		async execute(_toolCallId, params) {
			try {
				const result = await client.execJson<LspDefinitionResult>(
					buildLspDefinitionChunk(params.path, params.line, params.col),
				);
				if (!result.success) {
					return textResult(`LSP Definition: ${result.reason ?? "No definition found."}`, { result });
				}
				if (!result.definitions || result.definitions.length === 0) {
					return textResult(
						`No definition found for symbol at ${result.relative_file || result.file || params.path || "buffer"}:${params.line}:${params.col}.`,
						{ result },
					);
				}
				const lines = [`### LSP Definition (${result.definitions.length} found)`];
				for (const def of result.definitions) {
					lines.push(`- **\`${def.relative_file || def.file}:${def.start_line}:${def.start_col}\`**`);
					if (def.preview) {
						lines.push(`  \`${def.preview}\``);
					}
				}
				return textResult(lines.join("\n"), { result });
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	pi.registerTool({
		name: "nvim_lsp_references",
		label: "Neovim LSP References",
		description:
			"Find all usages, references, and call sites of a symbol across the project using Neovim's active LSP client.",
		promptSnippet: "Find symbol references across the workspace via Neovim LSP",
		promptGuidelines: [
			"Use nvim_lsp_references before refactoring functions, classes, or variables to ensure all call sites are updated safely.",
		],
		parameters: lspReferencesParameters,
		async execute(_toolCallId, params) {
			try {
				const result = await client.execJson<LspReferencesResult>(
					buildLspReferencesChunk(
						params.path,
						params.line,
						params.col,
						params.include_declaration,
						params.limit,
					),
				);
				if (!result.success) {
					return textResult(`LSP References: ${result.reason ?? "No references found."}`, { result });
				}
				if (!result.references || result.references.length === 0) {
					return textResult(
						`No references found for symbol at ${result.relative_file || result.file || params.path || "buffer"}:${params.line}:${params.col}.`,
						{ result },
					);
				}
				const totalStr = result.total !== undefined ? `${result.total} found` : `${result.references.length} found`;
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
		name: "nvim_lsp_symbols",
		label: "Neovim LSP Symbols",
		description:
			"Retrieve structural symbol outlines (classes, methods, functions, types) for a file (scope: document) or search symbols across the workspace (scope: workspace) via Neovim's LSP.",
		promptSnippet: "List document symbol outline or search workspace symbols via Neovim LSP",
		promptGuidelines: [
			"Use nvim_lsp_symbols to inspect the structure of a file or search for symbols across the workspace without parsing raw files.",
		],
		parameters: lspSymbolsParameters,
		async execute(_toolCallId, params) {
			try {
				const scope = params.scope ?? "document";
				const result = await client.execJson<LspSymbolsResult>(
					buildLspSymbolsChunk(params.path, params.query, scope),
				);
				if (!result.success) {
					return textResult(`LSP Symbols: ${result.reason ?? "No symbols found."}`, { result });
				}
				if (!result.symbols || result.symbols.length === 0) {
					return textResult(
						scope === "workspace"
							? `No workspace symbols matching query "${params.query ?? ""}".`
							: `No document symbols found for ${result.relative_file || result.file || params.path || "buffer"}.`,
						{ result },
					);
				}
				if (result.scope === "workspace") {
					const lines = [`### Workspace Symbols: query="${result.query ?? ""}" (${result.symbols.length} found)`];
					for (const sym of result.symbols as LspWorkspaceSymbol[]) {
						const loc = sym.location
							? ` in \`${sym.location.relative_file || sym.location.file}:${sym.location.start_line}\``
							: "";
						const container = sym.container ? ` (${sym.container})` : "";
						lines.push(`- [${sym.kind}] \`${sym.name}\`${container}${loc}`);
					}
					return textResult(lines.join("\n"), { result });
				} else {
					const lines = [
						`### Document Symbols: \`${result.relative_file || result.file || params.path || "buffer"}\` (${result.symbols.length} symbols)`,
					];
					for (const sym of result.symbols as LspDocumentSymbol[]) {
						const indent = "  ".repeat(sym.depth || 0);
						const range = sym.start_line
							? ` (lines ${sym.start_line}${sym.end_line && sym.end_line !== sym.start_line ? `-${sym.end_line}` : ""})`
							: "";
						const detail = sym.detail ? ` — *${sym.detail}*` : "";
						lines.push(`${indent}- [${sym.kind}] \`${sym.name}\`${detail}${range}`);
					}
					return textResult(lines.join("\n"), { result });
				}
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	pi.registerTool({
		name: "nvim_lsp_call_hierarchy",
		label: "Neovim LSP Call Hierarchy",
		description:
			"Inspect incoming callers (functions that call this) and outgoing callees (functions called by this) for a function or method using Neovim's LSP.",
		promptSnippet: "Inspect incoming/outgoing call hierarchy of a function via Neovim LSP",
		promptGuidelines: [
			"Use nvim_lsp_call_hierarchy to trace execution flow and understand how a function is used across the codebase.",
		],
		parameters: lspCallHierarchyParameters,
		async execute(_toolCallId, params) {
			try {
				const direction = params.direction ?? "both";
				const result = await client.execJson<LspCallHierarchyResult>(
					buildLspCallHierarchyChunk(params.path, params.line, params.col, direction),
				);
				if (!result.success || !result.root) {
					return textResult(`LSP Call Hierarchy: ${result.reason ?? "Call hierarchy not available."}`, { result });
				}
				const root = result.root;
				const lines = [
					`### Call Hierarchy: \`${root.name}\` [${root.kind}] (\`${root.relative_file || root.file}:${root.line}\`)`,
				];
				if (result.incoming && result.incoming.length > 0) {
					lines.push("");
					lines.push(`#### Incoming Calls (Callers — ${result.incoming.length}):`);
					for (const call of result.incoming) {
						const preview = call.preview ? ` \`${call.preview}\`` : "";
						lines.push(`- [${call.kind}] \`${call.name}\` in \`${call.relative_file || call.file}:${call.line}\`${preview}`);
					}
				} else if (direction === "incoming" || direction === "both") {
					lines.push("");
					lines.push("*No incoming callers found.*");
				}

				if (result.outgoing && result.outgoing.length > 0) {
					lines.push("");
					lines.push(`#### Outgoing Calls (Callees — ${result.outgoing.length}):`);
					for (const call of result.outgoing) {
						const preview = call.preview ? ` \`${call.preview}\`` : "";
						lines.push(`- [${call.kind}] \`${call.name}\` in \`${call.relative_file || call.file}:${call.line}\`${preview}`);
					}
				} else if (direction === "outgoing" || direction === "both") {
					lines.push("");
					lines.push("*No outgoing callees found.*");
				}
				return textResult(lines.join("\n"), { result });
			} catch (error) {
				return errorResult(error);
			}
		},
	});

	pi.registerTool({
		name: "nvim_lsp_hover",
		label: "Neovim LSP Hover",
		description:
			"Get LSP hover information (type signatures, inferred types, docstrings) for a symbol at a given line and column via Neovim's LSP.",
		promptSnippet: "Inspect type signatures and docstrings at cursor via Neovim LSP",
		promptGuidelines: [
			"Use nvim_lsp_hover to check exact type annotations, return types, and docstrings of unfamiliar functions or variables.",
		],
		parameters: lspHoverParameters,
		async execute(_toolCallId, params) {
			try {
				const result = await client.execJson<LspHoverResult>(
					buildLspHoverChunk(params.path, params.line, params.col),
				);
				if (!result.success || !result.hover) {
					return textResult(`LSP Hover: ${result.reason ?? "No hover information available."}`, { result });
				}
				const lines = [
					`### LSP Hover (\`${result.relative_file || result.file || params.path || "buffer"}:${result.line}:${result.col}\`)`,
					"",
					result.hover,
				];
				return textResult(lines.join("\n"), { result });
			} catch (error) {
				return errorResult(error);
			}
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
