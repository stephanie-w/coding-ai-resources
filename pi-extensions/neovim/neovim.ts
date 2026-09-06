// ~/.pi/agent/extensions/neovim.ts
// Native Neovim Integration Extension for Pi Coding Agent
// Automatically connects Pi to the parent Neovim editor session via $NVIM socket.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "@sinclair/typebox";

const execFileAsync = promisify(execFile);

// Helper to execute an expression on the parent Neovim server
async function nvimRemoteExpr(socketPath: string, expr: string): Promise<string> {
  // Ensure the expression is passed as a single-line string
  const cleanExpr = expr.replace(/\s+/g, " ").trim();
  try {
    const { stdout } = await execFileAsync(
      "nvim",
      ["--server", socketPath, "--remote-expr", cleanExpr],
      { timeout: 2500 }
    );
    return stdout.trim();
  } catch (err: any) {
    throw new Error(`Failed to query Neovim server: ${err.message}`);
  }
}

// Helper to send keys/commands to Neovim
async function nvimRemoteSend(socketPath: string, keys: string): Promise<void> {
  try {
    await execFileAsync(
      "nvim",
      ["--server", socketPath, "--remote-send", keys],
      { timeout: 2500 }
    );
  } catch (err: any) {
    throw new Error(`Failed to send command to Neovim server: ${err.message}`);
  }
}

export default function (pi: any) {
  const nvimSocket = process.env.NVIM;

  // Only activate if running inside an active Neovim terminal session
  if (!nvimSocket) {
    return;
  }

  // 1. TOOL: nvim_get_context
  // Inspects active file, cursor position, and open buffers in Neovim
  pi.registerTool({
    name: "nvim_get_context",
    description:
      "Get live context from the parent Neovim editor (active file, cursor line, filetype, and open buffer list).",
    parameters: Type.Object({
      include_buffers: Type.Optional(
        Type.Boolean({
          description: "Whether to list all open workspace buffers in Neovim (default: true).",
        })
      ),
    }),
    execute: async (_toolCallId: string, params: { include_buffers?: boolean }) => {
      // Calls v:lua.PiGetContext() with a single-line fallback
      const expr = `exists('*v:lua.PiGetContext') ? v:lua.PiGetContext() : json_encode({'active_file': expand('%:p'), 'relative_file': expand('%:~:.'), 'file_name': expand('%:t'), 'filetype': &filetype, 'cursor_line': line('.'), 'cursor_col': col('.'), 'total_lines': line('$'), 'modified': &modified == 1, 'open_buffers': map(getbufinfo({'buflisted': 1}), '{name: v:val.name, bufnr: v:val.bufnr, modified: v:val.modified == 1}')})`;

      try {
        const rawJson = await nvimRemoteExpr(nvimSocket, expr);
        const data = JSON.parse(rawJson);

        let output = `### Neovim Active Context\n`;
        output += `- **Active File:** \`${data.active_file || "None"}\` (relative: \`${data.relative_file || "None"}\`)\n`;
        output += `- **Filetype:** \`${data.filetype || "plain"}\`\n`;
        output += `- **Cursor Position:** Line ${data.cursor_line}, Column ${data.cursor_col} (Total lines: ${data.total_lines})\n`;
        output += `- **Modified on disk:** ${data.modified ? "Yes (unsaved changes in buffer)" : "No"}\n`;

        if (params.include_buffers !== false && data.open_buffers?.length > 0) {
          output += `\n### Open Listed Buffers (${data.open_buffers.length}):\n`;
          for (const buf of data.open_buffers) {
            if (buf.name) {
              output += `- [Buf #${buf.bufnr}] \`${buf.name}\`${buf.modified ? " *(unsaved)*" : ""}\n`;
            }
          }
        }

        return {
          content: [{ type: "text", text: output }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error fetching Neovim context: ${err.message}` }],
        };
      }
    },
  });

  // 2. TOOL: nvim_read_buffer
  // Reads in-memory buffer content directly from Neovim (even unsaved edits)
  pi.registerTool({
    name: "nvim_read_buffer",
    description:
      "Read the live in-memory buffer content from the parent Neovim session, capturing unsaved changes.",
    parameters: Type.Object({
      target: Type.Optional(
        Type.String({
          description: "File path or buffer number. If omitted, reads current active buffer.",
        })
      ),
    }),
    execute: async (_toolCallId: string, params: { target?: string }) => {
      const targetArg = params.target ? JSON.stringify(params.target) : "''";
      const expr = `exists('*v:lua.PiGetBufferContent') ? v:lua.PiGetBufferContent(${targetArg}) : join(getbufline(${targetArg} == '' ? '%' : ${targetArg}, 1, '$'), "\\n")`;

      try {
        const content = await nvimRemoteExpr(nvimSocket, expr);
        return {
          content: [
            {
              type: "text",
              text: content.length > 0 ? content : "(Buffer is empty)",
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error reading buffer from Neovim: ${err.message}` }],
        };
      }
    },
  });

  // 3. TOOL: nvim_command
  // Execute an Ex command or reload buffers in Neovim
  pi.registerTool({
    name: "nvim_command",
    description: "Send an Ex command to the parent Neovim editor (e.g. ':checktime', ':w', ':edit <path>').",
    parameters: Type.Object({
      command: Type.String({
        description: "The Vim command to run (e.g. ':checktime' to reload buffers, ':edit file.lua').",
      }),
    }),
    execute: async (_toolCallId: string, params: { command: string }) => {
      let cmd = params.command.trim();
      if (!cmd.startsWith(":") && !cmd.startsWith("<")) {
        cmd = `:${cmd}<CR>`;
      } else if (cmd.startsWith(":") && !cmd.endsWith("<CR>")) {
        cmd = `${cmd}<CR>`;
      }

      try {
        await nvimRemoteSend(nvimSocket, cmd);
        return {
          content: [{ type: "text", text: `Executed in Neovim: ${params.command}` }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text", text: `Error executing command in Neovim: ${err.message}` }],
        };
      }
    },
  });

  // 4. LIFECYCLE HOOK: Session Startup Notification
  pi.on("session_start", async (_event: any, ctx: any) => {
    try {
      const activeFile = await nvimRemoteExpr(nvimSocket, "expand('%:~:.')");
      if (activeFile && activeFile !== "") {
        ctx.ui?.notify?.(`[Neovim Connected] Active buffer: ${activeFile}`);
      }
    } catch {
      // Silently continue if initial query times out
    }
  });
}
