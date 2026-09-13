/**
 * pi-repl — Python eval + inspection against the project's uv environment.
 *
 * Registers two tools:
 * - py_eval: run a snippet with `uv run python -c`.
 * - py_inspect: introspect a dotted path (signature, docstring, type hints, source).
 *
 * Stateless: every call shells out to `uv run`, which resolves the project
 * environment from pyproject.toml/uv.lock in the working directory. Self-gates
 * (returns a clean error) when no pyproject.toml is present.
 */

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function isUvProject(cwd: string): boolean {
  return existsSync(join(cwd, "pyproject.toml"));
}

function compact(text: string, max = 4000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (truncated ${text.length - max} chars)`;
}

function textResult(text: string, details: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

function notUvProject(cwd: string): AgentToolResult<unknown> {
  return textResult(`pi-repl: not a uv project (no pyproject.toml in ${cwd}).`, { error: "no-pyproject" });
}

// ---------------------------------------------------------------------------
// py_inspect: embedded inspector script (JSON on stdout)
// ---------------------------------------------------------------------------

const INSPECT_SCRIPT = `
import importlib, inspect, json, sys, typing

target = sys.argv[1]

def resolve(target):
    parts = target.split(".")
    for i in range(len(parts), 0, -1):
        modname = ".".join(parts[:i])
        try:
            obj = importlib.import_module(modname)
        except ImportError:
            continue
        for attr in parts[i:]:
            obj = getattr(obj, attr)
        return obj
    raise ImportError("cannot import " + target)

def kind_of(obj):
    if inspect.ismodule(obj):
        return "module"
    if inspect.isclass(obj):
        return "class"
    if inspect.isfunction(obj) or inspect.ismethod(obj) or inspect.isbuiltin(obj):
        return "function"
    return "object"

try:
    obj = resolve(target)
    kind = kind_of(obj)
    out = {"name": target, "kind": kind}
    if kind in ("function", "class"):
        try:
            out["signature"] = str(inspect.signature(obj))
        except Exception:
            pass
        doc = inspect.getdoc(obj)
        if doc:
            for line in doc.splitlines():
                if line.strip():
                    out["doc"] = line.strip()
                    break
        hint_target = obj if kind == "function" else getattr(obj, "__init__", obj)
        try:
            hints = typing.get_type_hints(hint_target)
            out["hints"] = {k: str(v) for k, v in hints.items()}
        except Exception:
            pass
    try:
        out["file"] = inspect.getsourcefile(obj)
        out["line"] = inspect.getsourcelines(obj)[1]
    except Exception:
        pass
    print(json.dumps(out))
except Exception as e:
    print(json.dumps({"name": target, "error": str(e)}))
`.trim();

function formatInspect(data: any): string {
  if (data?.error) return `py_inspect: ${data.error}`;
  const lines = [`${data.name} — ${data.kind}`];
  if (data.signature) lines.push(`signature: ${data.signature}`);
  if (data.doc) lines.push(`doc: ${data.doc}`);
  if (data.hints && Object.keys(data.hints).length > 0) {
    lines.push(`hints: ${Object.entries(data.hints).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
  }
  if (data.file) lines.push(`source: ${data.file}:${data.line ?? "?"}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// py_eval formatting
// ---------------------------------------------------------------------------

function formatEval(res: { stdout: string; stderr: string; code: number; killed: boolean }): string {
  const parts: string[] = [];
  const out = res.stdout.trim();
  const err = res.stderr.trim();
  if (out) parts.push(out);
  if (err) parts.push(`stderr:\n${err}`);
  if (res.code !== 0) parts.push(`exit code: ${res.code}`);
  if (res.killed) parts.push("(killed by timeout)");
  return compact(parts.join("\n") || "(no output)");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function piRepl(pi: ExtensionAPI) {
  pi.registerTool({
    name: "py_eval",
    label: "Python Eval (uv)",
    description:
      "Run a Python snippet in the project's uv environment (uv run python -c). Use to verify behavior, test hypotheses, and inspect runtime values against the project's actual dependencies.",
    promptSnippet: "Run a Python snippet in the project's uv environment.",
    promptGuidelines: [
      "Use py_eval to verify Python behavior against the project's actual environment before writing code.",
      "Prefer py_inspect for signatures/docstrings; use py_eval for runtime behavior and experiments.",
    ],
    parameters: Type.Object({
      code: Type.String({ description: "Python code to execute (top-level statements)." }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 15, max 120)." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!isUvProject(ctx.cwd)) return notUvProject(ctx.cwd);
      const timeoutMs = Math.round(clamp(params.timeout ?? 15, 1, 120) * 1000);
      const res = await pi.exec("uv", ["run", "python", "-c", params.code], { cwd: ctx.cwd, timeout: timeoutMs });
      return textResult(formatEval(res), { code: res.code, killed: res.killed });
    },
  });

  pi.registerTool({
    name: "py_inspect",
    label: "Python Inspect (uv)",
    description:
      "Inspect a Python symbol (function, class, or module) in the project's uv environment: signature, first docstring line, type hints, and source location. Accepts a dotted path like 'pkg.module.func'.",
    promptSnippet: "Inspect a Python symbol's signature, docstring, type hints, and source location.",
    promptGuidelines: [
      "Use py_inspect to confirm signatures and docs before calling project functions.",
      "Prefer py_inspect over reading source files when you only need the signature or docstring.",
    ],
    parameters: Type.Object({
      target: Type.String({ description: "Dotted path to inspect, e.g. 'pkg.module.func' or 'json.dumps'." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!isUvProject(ctx.cwd)) return notUvProject(ctx.cwd);
      const res = await pi.exec("uv", ["run", "python", "-c", INSPECT_SCRIPT, params.target], {
        cwd: ctx.cwd,
        timeout: 15000,
      });
      if (res.code !== 0) {
        return textResult(compact(`py_inspect failed:\n${res.stderr.trim() || res.stdout.trim()}`), { code: res.code });
      }
      let data: any;
      try {
        data = JSON.parse(res.stdout.trim());
      } catch {
        return textResult(compact(res.stdout.trim() || res.stderr.trim()), {});
      }
      return textResult(formatInspect(data), data);
    },
  });
}
