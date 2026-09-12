# Prompt Snippets

Mix-and-match single-purpose prompt rules that are prepended or appended to
**your message** when you send it. Unlike skills, each snippet is a tiny,
standalone instruction — toggle exactly the ones you want per message. Unlike
prompt templates (`/name`) or `/skill:` commands, snippets are not a canned
prompt: they wrap whatever you typed.

## Usage

- Press **alt+s** or run **/snippets** to open the toggle menu.
  - `up`/`down` to navigate, `space` to toggle, `enter` to apply, `esc` to cancel.
  - `tab` previews the highlighted snippet (name, placement, order, filename,
    and full body; `up`/`down` scroll long bodies). `tab` or `esc` returns to
    the list with your cursor position preserved.
  - The menu is framed with top/bottom border lines and scrolls when the list
    exceeds the viewport (max height adapts to your terminal), with
    `↑ n more` / `↓ n more` indicators when clipped.
- Active snippets show up as a widget above the editor:
  - `↑ prepend: ...` (accent color) — inserted before your message
  - `↓ append: ...` (warning color) — inserted after your message
- When you send a message, active snippet bodies are merged into the message
  text: prepend group (sorted by `order`) → your text → append group (sorted
  by `order`), separated by blank lines.
- Toggles reset to **all off** after each natural message and at session start.
  Running a slash command (`/checkpoint`, `/review`, `/skill:...`) does **not**
  consume toggles — see below.

## Snippet files

Snippets live in `snippets/` next to `index.ts` — one markdown file each,
with frontmatter:

```markdown
---
name: Concise
description: Keep answers short and to the point
placement: prepend
order: 10
---
Keep your response concise. Skip preamble and unnecessary explanation.
```

| Field | Required | Notes |
|---|---|---|
| `name` | no | Display name; defaults to the filename without `.md` |
| `description` | no | Shown next to the name in the toggle menu |
| `placement` | no | `prepend` or `append` (default: `append`) |
| `order` | no | Number; sorts snippets within their group, in the menu and in the applied text (default: `9999`, ties broken by name) |

Files are re-scanned every time the menu opens and every time a message is
sent, so edits take effect immediately — no `/reload` needed.

## Interaction with slash commands

Pi only expands a command when the message **starts** with `/` and is exactly
`/name [args]`. Snippets deliberately do **not** apply to such messages:

- Prepending a snippet would hide the leading `/` and the command would never
  expand (you'd send the literal text instead).
- Appending a snippet would be parsed as the command's arguments and either
  substituted at a `$@` placeholder or silently dropped.

Instead, the extension detects a known extension command, `/skill:...`, or
prompt template and **steps aside**: the command runs normally, the snippet is
skipped for that turn, and the toggles are **kept** for your next natural
message (with a notification).

Consequence: snippets decorate ordinary messages, not command invocations. If
you want a rule to apply inside a command, put it in that command's template
or skill body.

## Install

See the [parent README](../README.md) for the three install methods. As a
directory with `index.ts`, this extension is auto-discovered when linked/copied
to `~/.pi/agent/extensions/prompt-snippets/` or installed with
`pi install <path-to-this-directory>`. Run `/reload` (or restart pi) afterwards.
