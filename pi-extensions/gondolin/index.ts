/**
 * Pi + Gondolin Sandbox Extension
 *
 * Runs pi's built-in tools (read, write, edit, bash, ls, find, grep) inside a
 * local Gondolin micro-VM. The host working directory is mounted at /workspace
 * in the guest.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ReadonlyProvider, RealFSProvider, VM, createHttpHooks } from "@earendil-works/gondolin";
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

export type MountConfig = {
  /** Host path (supports ~ for home directory) */
  hostPath: string;
  /** Guest mount path (defaults to matching host path) */
  guestPath?: string;
  /** Mount mode: 'ro' (read-only) or 'rw' (read-write) */
  mode: "ro" | "rw";
  /** Description / purpose */
  description?: string;
};

export type BootstrapFileConfig = {
  /** Host source file path (supports ~ for home directory) */
  hostPath: string;
  /** Guest destination path (defaults to /root/<relative_to_home> or hostPath) */
  guestPath?: string;
  /** Description / purpose */
  description?: string;
};

/**
 * Single files injected into the guest filesystem on sandbox bootstrap.
 * Add dotfiles or configuration files here (e.g. .gitconfig, .npmrc, .pypirc).
 */
export const DEFAULT_BOOTSTRAP_FILES: BootstrapFileConfig[] = [
  { hostPath: "~/.gitconfig", guestPath: "/root/.gitconfig", description: "Host git user configuration" },
  { hostPath: "~/.npmrc", guestPath: "/root/.npmrc", description: "Host npm configuration" },
  { hostPath: "~/.pypirc", guestPath: "/root/.pypirc", description: "Host PyPI configuration" },
];

/**
 * Standard host directories mounted into Gondolin for daily development.
 * Add or adjust entries here to maintain the agent's host access list.
 */
export const DEFAULT_DAILY_DEV_MOUNTS: MountConfig[] = [
  // Pi Agent code, typings, docs & global CLI tools
  { hostPath: "~/.npm-global", mode: "ro", description: "Pi source code, docs & global npm packages" },
  // Pi persona, skills, extensions & session logs
  { hostPath: "~/.pi/agent", mode: "ro", description: "Global Pi persona, settings, and skills" },
  // Standard Agent Skills directory
  { hostPath: "~/.agents/skills", mode: "ro", description: "Global Agent skills directory" },
  // Git config directory (if present)
  { hostPath: "~/.config/git", mode: "ro", description: "Host git user config directory" },
  // Fast package manager caches
  { hostPath: "~/.cache/uv", mode: "rw", description: "uv Python package cache" },
  { hostPath: "~/.cache/pip", mode: "rw", description: "pip cache" },
  { hostPath: "~/.npm", mode: "rw", description: "npm package cache" },
];

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

function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
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
  let trimmed = stripAtPrefix(inputPath.trim());
  if (!trimmed) return GUEST_WORKSPACE;
  trimmed = expandTilde(trimmed);
  if (path.isAbsolute(trimmed)) {
    // If the path exists on the host as a symlink pointing elsewhere,
    // resolve its realpath so Gondolin's RealFSProvider boundary checks target the correct mount provider.
    try {
      if (fs.existsSync(trimmed)) {
        trimmed = fs.realpathSync(trimmed);
      }
    } catch {
      // ignore
    }
    if (isInsideHostPath(localCwd, trimmed)) return hostPathToGuest(localCwd, trimmed);
    return path.posix.resolve("/", toPosix(trimmed));
  }
  return path.posix.resolve(GUEST_WORKSPACE, toPosix(trimmed));
}

function resolveDevMounts(): {
  mounts: Record<string, any>;
  guestEnv: Record<string, string>;
  mountedDescriptions: string[];
} {
  const mounts: Record<string, any> = {};
  const guestEnv: Record<string, string> = {};
  const mountedDescriptions: string[] = [];

  const mountDirectory = (
    hostPathRaw: string,
    guestPathRaw?: string,
    mode: "ro" | "rw" = "ro",
    description?: string,
  ) => {
    const hostPath = expandTilde(hostPathRaw);
    if (!fs.existsSync(hostPath)) return;

    try {
      const stat = fs.statSync(hostPath);
      if (!stat.isDirectory()) return;
    } catch {
      return;
    }

    const guestPath = guestPathRaw ? expandTilde(guestPathRaw) : hostPath;
    if (mounts[guestPath]) return;

    const baseProvider = new RealFSProvider(hostPath);
    const provider = mode === "ro" ? new ReadonlyProvider(baseProvider) : baseProvider;

    mounts[guestPath] = provider;

    if (hostPath.startsWith(os.homedir())) {
      const rootEquiv = path.posix.join("/root", path.posix.relative(os.homedir(), hostPath));
      if (!mounts[rootEquiv]) {
        mounts[rootEquiv] = provider;
      }
    }

    mountedDescriptions.push(
      description ? `${hostPathRaw} [${mode}] (${description})` : `${hostPathRaw} [${mode}]`,
    );
  };

  // 1. Mount standard development directories
  for (const entry of DEFAULT_DAILY_DEV_MOUNTS) {
    mountDirectory(entry.hostPath, entry.guestPath, entry.mode, entry.description);
  }

  // 2. Discover and mount realpath targets for any symlinks in ~/.pi/agent (e.g. skills, AGENTS.md, extensions)
  try {
    const piDir = path.join(os.homedir(), ".pi/agent");
    const dirsToScan = [piDir, path.join(piDir, "extensions")];
    for (const dir of dirsToScan) {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        try {
          const lstat = fs.lstatSync(full);
          if (lstat.isSymbolicLink()) {
            const real = fs.realpathSync(full);
            if (!real.startsWith(piDir)) {
              const stat = fs.statSync(real);
              if (stat.isDirectory()) {
                mountDirectory(
                  real,
                  real,
                  "ro",
                  `Symlink target for ~/.pi/agent/${path.relative(piDir, full)}`,
                );
              } else if (stat.isFile()) {
                const parentDir = path.dirname(real);
                mountDirectory(
                  parentDir,
                  parentDir,
                  "ro",
                  `Parent dir of symlink ~/.pi/agent/${path.relative(piDir, full)}`,
                );
              }
            }
          }
        } catch {
          // ignore individual symlink resolution failures
        }
      }
    }
  } catch {
    // ignore
  }

  // 3. Dynamically discover and mount skills if running from a cloned catalog repository
  try {
    const currentFilePath = fileURLToPath(import.meta.url);
    const realPath = fs.realpathSync(currentFilePath);
    const candidateCatalogRoot = path.resolve(path.dirname(realPath), "../..");
    const candidateSkills = path.join(candidateCatalogRoot, "skills");
    if (fs.existsSync(candidateSkills)) {
      mountDirectory(candidateSkills, candidateSkills, "ro", "Catalog skills");
    }
  } catch {
    // ignore
  }

  // Forward Git author & committer identity to the guest environment
  try {
    const gitConfigPath = path.join(os.homedir(), ".gitconfig");
    if (fs.existsSync(gitConfigPath)) {
      const content = fs.readFileSync(gitConfigPath, "utf8");
      const nameMatch = content.match(/^\s*name\s*=\s*(.+)$/m);
      const emailMatch = content.match(/^\s*email\s*=\s*(.+)$/m);
      if (nameMatch) {
        guestEnv.GIT_AUTHOR_NAME = nameMatch[1].trim();
        guestEnv.GIT_COMMITTER_NAME = nameMatch[1].trim();
      }
      if (emailMatch) {
        guestEnv.GIT_AUTHOR_EMAIL = emailMatch[1].trim();
        guestEnv.GIT_COMMITTER_EMAIL = emailMatch[1].trim();
      }
    }
  } catch {
    // Ignore git config parse errors
  }

  // Handle npm-global specific guest environment variables (NODE_PATH and PATH)
  const hostNpmGlobal = path.join(os.homedir(), ".npm-global");
  if (fs.existsSync(hostNpmGlobal)) {
    guestEnv.NODE_PATH = `/root/.npm-global/lib/node_modules:${hostNpmGlobal}/lib/node_modules`;
    guestEnv.PATH = `/root/.npm-global/bin:${hostNpmGlobal}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
  }

  // Parse custom mounts from environment: GONDOLIN_MOUNTS="HOST:GUEST[:ro]"
  const envMounts = process.env.GONDOLIN_MOUNTS || process.env.GONDOLIN_EXTRA_MOUNTS;
  if (envMounts) {
    for (const spec of envMounts.split(",")) {
      const parts = spec.trim().split(":");
      if (parts.length >= 2) {
        const host = expandTilde(parts[0]);
        const guest = expandTilde(parts[1]);
        const isRo = parts[2] === "ro";
        if (fs.existsSync(host)) {
          try {
            const stat = fs.statSync(host);
            if (stat.isDirectory()) {
              const base = new RealFSProvider(host);
              mounts[guest] = isRo ? new ReadonlyProvider(base) : base;
              mountedDescriptions.push(`${parts[0]} -> ${parts[1]} [${isRo ? "ro" : "rw"}]`);
            }
          } catch {
            // ignore
          }
        }
      }
    }
  }

  return { mounts, guestEnv, mountedDescriptions };
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

async function bootstrapGuestFiles(activeVm: VM): Promise<string[]> {
  const bootstrapped: string[] = [];
  for (const entry of DEFAULT_BOOTSTRAP_FILES) {
    const hostPath = expandTilde(entry.hostPath);
    if (!fs.existsSync(hostPath)) continue;

    try {
      const stat = fs.statSync(hostPath);
      if (!stat.isFile()) continue;

      const content = fs.readFileSync(hostPath, "utf8");
      const guestTarget =
        entry.guestPath ??
        (hostPath.startsWith(os.homedir())
          ? path.posix.join("/root", path.posix.relative(os.homedir(), hostPath))
          : hostPath);

      const parentDir = path.posix.dirname(guestTarget);
      if (parentDir && parentDir !== "/" && parentDir !== ".") {
        try {
          await activeVm.fs.mkdir(parentDir, { recursive: true });
        } catch {
          // ignore if directory exists
        }
      }

      await activeVm.fs.writeFile(guestTarget, content, { encoding: "utf8" });
      bootstrapped.push(entry.hostPath);
    } catch {
      // ignore individual file seed errors
    }
  }
  return bootstrapped;
}

export default function (pi: ExtensionAPI) {
  const localCwd = process.cwd();

  // Subagents (PI_SUBAGENT_DEPTH >= 1) must not attempt to boot a nested micro-VM.
  const subagentDepth = Number(process.env.PI_SUBAGENT_DEPTH ?? "0");
  if (Number.isFinite(subagentDepth) && subagentDepth >= 1) {
    return;
  }

  // Bypass Gondolin sandbox when explicitly disabled via environment variable
  if (process.env.GONDOLIN_DISABLED === "1" || process.env.NO_SANDBOX === "1") {
    pi.registerCommand("gondolin", {
      description: "Manage Gondolin sandbox (status)",
      handler(_args, ctx) {
        ctx.ui.notify("Gondolin Sandbox is BYPASSED (GONDOLIN_DISABLED is set). Running natively on host.", "info");
      },
    });
    return;
  }

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

      const devMounts = resolveDevMounts();

      const created = await VM.create({
        sandbox: {
          imagePath: process.env.GONDOLIN_DEFAULT_IMAGE || "custom-dev:latest",
        },
        httpHooks,
        env: {
          ...(env || {}),
          ...devMounts.guestEnv,
        },
        vfs: {
          mounts: {
            [GUEST_WORKSPACE]: new RealFSProvider(localCwd),
            ...devMounts.mounts,
          },
        },
      });

      await bootstrapGuestFiles(created);

      vm = created;
      guestEnv = { ...(env || {}), ...devMounts.guestEnv };
      ctx?.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg(
          "accent",
          `Gondolin: running (${localCwd} -> ${GUEST_WORKSPACE})`,
        ),
      );
      const devCount = devMounts.mountedDescriptions.length;
      const mountSummary = devCount > 0 ? ` (+ ${devCount} dev mount${devCount > 1 ? "s" : ""})` : "";
      ctx?.ui.notify(
        `Gondolin VM ready. Host ${localCwd} mounted at ${GUEST_WORKSPACE}${mountSummary}`,
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
    const devMounts = resolveDevMounts();
    const mountedList = devMounts.mountedDescriptions.join(", ") || "none";

    const gondolinEnvNotice = `
## Gondolin Sandbox Environment
All tool and shell operations (read, write, edit, bash, ls, grep, find) execute inside an isolated **Gondolin Alpine Linux micro-VM**:
- **Workspace**: Host working directory \`${localCwd}\` is mounted at \`${GUEST_WORKSPACE}\`. All project paths are relative to \`${GUEST_WORKSPACE}\`.
- **User & OS**: Running as \`root\` on Alpine Linux. Pre-installed tools include \`uv\`, \`python3\`, \`nodejs\`, \`npm\`, \`git\`, \`ripgrep\`, \`fd\`, \`just\`, \`curl\`. Package manager is \`apk\`.
- **Mounted Directories**: ${mountedList}.
- **Bootstrapped Dotfiles**: \`~/.gitconfig\`, \`~/.npmrc\`, \`~/.pypirc\` are seeded into \`/root/\`.
- **Network Boundaries**: Outbound internet is strictly filtered by an HTTP proxy to approved registries: \`github.com\`, \`pypi.org\`, \`registry.npmjs.org\`, \`crates.io\`. Arbitrary external domains are blocked.
- **Diagnostics**:
  - Host paths outside mounted directories (e.g. \`/home/...\`) do not exist in the guest. Always use \`${GUEST_WORKSPACE}\` or mounted paths.
  - If network requests fail with 403 / proxy block, verify if the domain is on the allowed registry list.
  - Subagents and background tasks share or spawn inside this micro-VM sandbox environment.
`;

    let modified = event.systemPrompt.replace(
      `Current working directory: ${localCwd}`,
      `Current working directory: ${GUEST_WORKSPACE} (Gondolin VM, mounted from host: ${localCwd})`,
    );

    modified += `\n${gondolinEnvNotice.trim()}\n`;

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
        const devMounts = resolveDevMounts();
        const mountsList = devMounts.mountedDescriptions.join(", ");
        ctx.ui.notify(
          `Gondolin Sandbox is ACTIVE.\nWorkspace: ${localCwd} -> ${GUEST_WORKSPACE}\nDev Mounts: ${mountsList || "none"}\nAllowed hosts: github.com, pypi.org, npmjs.org, crates.io`,
          "info",
        );
      }
    },
  });
}
