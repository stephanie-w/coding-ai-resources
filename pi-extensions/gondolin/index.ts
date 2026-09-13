/**
 * Pi + Gondolin Sandbox Extension
 *
 * Runs pi's built-in tools (read, write, edit, bash, ls, find, grep) inside a
 * local Gondolin micro-VM. The host working directory is mounted at /workspace
 * in the guest.
 */

import path from "node:path";
import { RealFSProvider, VM, createHttpHooks } from "@earendil-works/gondolin";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type BashOperations,
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  DEFAULT_MAX_BYTES,
  type EditOperations,
  type FindOperations,
  formatSize,
  type GrepToolDetails,
  type GrepToolInput,
  type LsOperations,
  type ReadOperations,
  truncateHead,
  truncateLine,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";

const GUEST_WORKSPACE = "/workspace";
const DEFAULT_GREP_LIMIT = 100;

type TextToolResult<TDetails> = {
  content: Array<{ type: "text"; text: string }>;
  details: TDetails | undefined;
};

function stripAtPrefix(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

function toPosix(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

function isInsideHostPath(root: string, value: string): boolean {
  const relativePath = path.relative(root, value);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function hostPathToGuest(localCwd: string, hostPath: string): string {
  const relativePath = path.relative(localCwd, hostPath);
  if (!isInsideHostPath(localCwd, hostPath)) return toPosix(hostPath);
  return relativePath ? path.posix.join(GUEST_WORKSPACE, toPosix(relativePath)) : GUEST_WORKSPACE;
}

function toGuestPath(localCwd: string, inputPath: string): string {
  const trimmed = stripAtPrefix(inputPath.trim());
  if (!trimmed) return GUEST_WORKSPACE;
  if (path.isAbsolute(trimmed)) {
    if (isInsideHostPath(localCwd, trimmed)) return hostPathToGuest(localCwd, trimmed);
    return path.posix.resolve("/", toPosix(trimmed));
  }
  return path.posix.resolve(GUEST_WORKSPACE, toPosix(trimmed));
}

function createGondolinReadOps(vm: VM, localCwd: string): ReadOperations {
  return {
    readFile: async (filePath) => vm.fs.readFile(toGuestPath(localCwd, filePath)),
    access: async (filePath) => {
      await vm.fs.access(toGuestPath(localCwd, filePath));
    },
    detectImageMimeType: async (filePath) => {
      const ext = path.posix.extname(toGuestPath(localCwd, filePath)).toLowerCase();
      if (ext === ".png") return "image/png";
      if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
      if (ext === ".gif") return "image/gif";
      if (ext === ".webp") return "image/webp";
      return null;
    },
  };
}

function createGondolinWriteOps(vm: VM, localCwd: string): WriteOperations {
  return {
    writeFile: async (filePath, content) => {
      await vm.fs.writeFile(toGuestPath(localCwd, filePath), content, { encoding: "utf8" });
    },
    mkdir: async (dirPath) => {
      await vm.fs.mkdir(toGuestPath(localCwd, dirPath), { recursive: true });
    },
  };
}

function createGondolinEditOps(vm: VM, localCwd: string): EditOperations {
  const readOps = createGondolinReadOps(vm, localCwd);
  const writeOps = createGondolinWriteOps(vm, localCwd);
  return {
    readFile: readOps.readFile,
    writeFile: writeOps.writeFile,
    access: readOps.access,
  };
}

function createGondolinLsOps(vm: VM, localCwd: string): LsOperations {
  return {
    exists: async (filePath) => {
      try {
        await vm.fs.access(toGuestPath(localCwd, filePath));
        return true;
      } catch {
        return false;
      }
    },
    stat: async (filePath) => vm.fs.stat(toGuestPath(localCwd, filePath)),
    readdir: async (dirPath) => vm.fs.listDir(toGuestPath(localCwd, dirPath)),
  };
}

async function walkGuestFiles(
  vm: VM,
  root: string,
  visit: (guestPath: string, relativePath: string) => Promise<boolean>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) throw new Error("Operation aborted");
  const stat = await vm.fs.stat(root, { signal });
  if (!stat.isDirectory()) return visit(root, path.posix.basename(root));

  const walkDirectory = async (dir: string, relativeDir: string): Promise<boolean> => {
    if (signal?.aborted) throw new Error("Operation aborted");
    const entries = await vm.fs.listDir(dir, { signal });
    for (const entry of entries) {
      if (entry === ".git" || entry === "node_modules") continue;
      const guestPath = path.posix.join(dir, entry);
      const relativePath = relativeDir ? path.posix.join(relativeDir, entry) : entry;
      let entryStat: Awaited<ReturnType<VM["fs"]["stat"]>>;
      try {
        entryStat = await vm.fs.stat(guestPath, { signal });
      } catch {
        continue;
      }
      if (entryStat.isDirectory()) {
        if (!(await walkDirectory(guestPath, relativePath))) return false;
      } else if (!(await visit(guestPath, relativePath))) {
        return false;
      }
    }
    return true;
  };

  return walkDirectory(root, "");
}

function matchesToolGlob(relativePath: string, pattern: string): boolean {
  const normalizedPattern = toPosix(pattern);
  if (normalizedPattern.includes("/")) {
    return (
      path.posix.matchesGlob(relativePath, normalizedPattern) ||
      path.posix.matchesGlob(relativePath, `**/${normalizedPattern}`)
    );
  }
  return path.posix.matchesGlob(path.posix.basename(relativePath), normalizedPattern);
}

function createGondolinFindOps(vm: VM, localCwd: string): FindOperations {
  return {
    exists: async (filePath) => {
      try {
        await vm.fs.access(toGuestPath(localCwd, filePath));
        return true;
      } catch {
        return false;
      }
    },
    glob: async (pattern, cwd, options) => {
      const root = toGuestPath(localCwd, cwd);
      const results: string[] = [];
      await walkGuestFiles(vm, root, async (guestPath, relativePath) => {
        if (results.length >= options.limit) return false;
        if (matchesToolGlob(relativePath, pattern)) results.push(guestPath);
        return results.length < options.limit;
      });
      return results;
    },
  };
}

function createLineMatcher(pattern: string, literal: boolean | undefined, ignoreCase: boolean | undefined) {
  if (literal) {
    const needle = ignoreCase ? pattern.toLowerCase() : pattern;
    return (line: string) => (ignoreCase ? line.toLowerCase() : line).includes(needle);
  }
  const regex = new RegExp(pattern, ignoreCase ? "i" : undefined);
  return (line: string) => regex.test(line);
}

function appendGrepBlock(params: {
  outputLines: string[];
  lines: string[];
  relativePath: string;
  lineIndex: number;
  contextLines: number;
}): boolean {
  let linesTruncated = false;
  const start = params.contextLines > 0 ? Math.max(0, params.lineIndex - params.contextLines) : params.lineIndex;
  const end =
    params.contextLines > 0
      ? Math.min(params.lines.length - 1, params.lineIndex + params.contextLines)
      : params.lineIndex;

  for (let index = start; index <= end; index++) {
    const rawLine = params.lines[index] ?? "";
    const { text, wasTruncated } = truncateLine(rawLine.replace(/\r/g, ""));
    if (wasTruncated) linesTruncated = true;
    const separator = index === params.lineIndex ? ":" : "-";
    params.outputLines.push(`${params.relativePath}${separator}${index + 1}${separator} ${text}`);
  }
  return linesTruncated;
}

async function executeGondolinGrep(
  vm: VM,
  localCwd: string,
  params: GrepToolInput,
  signal?: AbortSignal,
): Promise<TextToolResult<GrepToolDetails>> {
  const root = toGuestPath(localCwd, params.path ?? ".");
  const rootStat = await vm.fs.stat(root, { signal });
  const rootIsDirectory = rootStat.isDirectory();
  const matcher = createLineMatcher(params.pattern, params.literal, params.ignoreCase);
  const contextLines = params.context && params.context > 0 ? params.context : 0;
  const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
  const outputLines: string[] = [];
  const details: GrepToolDetails = {};
  let matchCount = 0;
  let matchLimitReached = false;
  let linesTruncated = false;

  await walkGuestFiles(
    vm,
    root,
    async (guestPath, relativePath) => {
      if (matchCount >= effectiveLimit) return false;
      if (params.glob && !matchesToolGlob(relativePath, params.glob)) return true;
      let content: string;
      try {
        content = await vm.fs.readFile(guestPath, { encoding: "utf8", signal });
      } catch {
        return true;
      }
      const lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      const displayPath = rootIsDirectory ? relativePath : path.posix.basename(guestPath);
      for (let index = 0; index < lines.length; index++) {
        if (signal?.aborted) throw new Error("Operation aborted");
        if (!matcher(lines[index] ?? "")) continue;
        matchCount++;
        if (appendGrepBlock({ outputLines, lines, relativePath: displayPath, lineIndex: index, contextLines })) {
          linesTruncated = true;
        }
        if (matchCount >= effectiveLimit) {
          matchLimitReached = true;
          return false;
        }
      }
      return true;
    },
    signal,
  );

  if (matchCount === 0) return { content: [{ type: "text", text: "No matches found" }], details: undefined };

  const rawOutput = outputLines.join("\n");
  const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
  const notices: string[] = [];
  let output = truncation.content;

  if (matchLimitReached) {
    details.matchLimitReached = effectiveLimit;
    notices.push(`${effectiveLimit} matches limit reached`);
  }
  if (linesTruncated) {
    details.linesTruncated = true;
    notices.push("long lines truncated");
  }
  if (truncation.truncated) {
    details.truncation = truncation;
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
  }
  if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

  return {
    content: [{ type: "text", text: output }],
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}

const SENSITIVE_PATTERN = /(KEY|TOKEN|SECRET|AUTH|PASSWORD|CREDENTIAL|PRIVATE)/i;

function sanitizeEnv(
  env?: NodeJS.ProcessEnv,
  guestEnv?: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = { ...guestEnv };
  if (!env) return out;
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string" && !SENSITIVE_PATTERN.test(k)) {
      out[k] = v;
    }
  }
  delete out.DEEPSEEK_API_KEY;
  return out;
}

function createGondolinBashOps(
  vm: VM,
  localCwd: string,
  guestEnv?: Record<string, string>,
): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const guestCwd = toGuestPath(localCwd, cwd);

      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      let timedOut = false;
      const timer =
        timeout && timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              ac.abort();
            }, timeout * 1000)
          : undefined;

      try {
        const proc = vm.exec(["/bin/bash", "-lc", command], {
          cwd: guestCwd,
          signal: ac.signal,
          env: sanitizeEnv(env, guestEnv),
          stdout: "pipe",
          stderr: "pipe",
        });

        for await (const chunk of proc.output()) {
          onData(chunk.data);
        }

        const r = await proc;
        return { exitCode: r.exitCode };
      } catch (err) {
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

export default function (pi: ExtensionAPI) {
  const localCwd = process.cwd();

  const localRead = createReadTool(GUEST_WORKSPACE);
  const localWrite = createWriteTool(GUEST_WORKSPACE);
  const localEdit = createEditTool(GUEST_WORKSPACE);
  const localBash = createBashTool(GUEST_WORKSPACE);
  const localGrep = createGrepTool(GUEST_WORKSPACE);
  const localFind = createFindTool(GUEST_WORKSPACE);
  const localLs = createLsTool(GUEST_WORKSPACE);

  let vm: VM | null = null;
  let vmStarting: Promise<VM> | null = null;
  let guestEnv: Record<string, string> = {};

  async function ensureVm(ctx?: ExtensionContext): Promise<VM> {
    if (vm) return vm;
    if (vmStarting) return vmStarting;

    vmStarting = (async () => {
      ctx?.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg(
          "accent",
          `Gondolin: starting (mount ${GUEST_WORKSPACE})`,
        ),
      );

      const { httpHooks, env } = createHttpHooks({
        allowedHosts: [
          "github.com",
          "raw.githubusercontent.com",
          "api.github.com",
          "pypi.org",
          "files.pythonhosted.org",
          "registry.npmjs.org",
          "crates.io",
          "static.crates.io",
        ],
        secrets: {
          ...(process.env.GITHUB_TOKEN
            ? {
                GITHUB_TOKEN: {
                  hosts: ["api.github.com", "raw.githubusercontent.com", "github.com"],
                  value: process.env.GITHUB_TOKEN,
                },
              }
            : {}),
        },
      });

      const created = await VM.create({
        sandbox: {
          imagePath: process.env.GONDOLIN_DEFAULT_IMAGE || "custom-dev:latest",
        },
        httpHooks,
        env,
        vfs: {
          mounts: {
            [GUEST_WORKSPACE]: new RealFSProvider(localCwd),
          },
        },
      });

      vm = created;
      guestEnv = env || {};
      ctx?.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg(
          "accent",
          `Gondolin: running (${localCwd} -> ${GUEST_WORKSPACE})`,
        ),
      );
      ctx?.ui.notify(
        `Gondolin VM ready. Host ${localCwd} mounted at ${GUEST_WORKSPACE}`,
        "info",
      );
      return created;
    })();

    return vmStarting;
  }

  pi.on("session_start", async (_event, ctx) => {
    await ensureVm(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (!vm) return;
    ctx.ui.setStatus(
      "gondolin",
      ctx.ui.theme.fg("muted", "Gondolin: stopping"),
    );
    try {
      await vm.close();
    } finally {
      vm = null;
      vmStarting = null;
      guestEnv = {};
    }
  });

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createReadTool(GUEST_WORKSPACE, {
        operations: createGondolinReadOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createWriteTool(GUEST_WORKSPACE, {
        operations: createGondolinWriteOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createEditTool(GUEST_WORKSPACE, {
        operations: createGondolinEditOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createBashTool(GUEST_WORKSPACE, {
        operations: createGondolinBashOps(activeVm, localCwd, guestEnv),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localLs,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createLsTool(GUEST_WORKSPACE, {
        operations: createGondolinLsOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localFind,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createFindTool(GUEST_WORKSPACE, {
        operations: createGondolinFindOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localGrep,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      return executeGondolinGrep(activeVm, localCwd, params, signal);
    },
  });

  pi.on("user_bash", (_event, ctx) => {
    if (!vm) return;
    return { operations: createGondolinBashOps(vm, localCwd, guestEnv) };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await ensureVm(ctx);
    const modified = event.systemPrompt.replace(
      `Current working directory: ${localCwd}`,
      `Current working directory: ${GUEST_WORKSPACE} (Gondolin VM, mounted from host: ${localCwd})`,
    );
    return { systemPrompt: modified };
  });

  pi.registerCommand("gondolin", {
    description: "Manage Gondolin sandbox (status or reset)",
    getArgumentCompletions: (prefix) =>
      "reset".startsWith(prefix.trim())
        ? [{ value: "reset", label: "reset — restart and clear the micro-VM" }]
        : null,
    async handler(args, ctx) {
      if (args.trim() === "reset") {
        if (vm) {
          ctx.ui.setStatus("gondolin", ctx.ui.theme.fg("muted", "Gondolin: resetting..."));
          await vm.close();
          vm = null;
          vmStarting = null;
          await ensureVm(ctx);
          ctx.ui.notify("Gondolin micro-VM has been reset.", "info");
        } else {
          await ensureVm(ctx);
          ctx.ui.notify("Gondolin micro-VM started.", "info");
        }
      } else {
        ctx.ui.notify(
          `Gondolin Sandbox is ACTIVE.\nMounted: ${localCwd} -> ${GUEST_WORKSPACE}\nAllowed hosts: github.com, pypi.org, npmjs.org, crates.io`,
          "info",
        );
      }
    },
  });
}
