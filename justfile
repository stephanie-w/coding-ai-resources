# ==============================================================================
# Coding AI Resources Catalog Automation
# ==============================================================================

set shell := ["bash", "-uc"]
set positional-arguments := true

# List available recipes
default:
    @just --list

# Validate all package.json files with jq
validate:
    @for f in packages/*/package.json; do \
        echo "Validating $f..."; \
        jq . "$f" > /dev/null || exit 1; \
    done
    @echo "All package manifests are valid."

# Install a package globally for all sessions on this machine (default: core)
install-global pack="core":
    pi install "{{ justfile_directory() }}/packages/{{ pack }}"

# Remove a globally installed package
remove-global pack="core":
    pi remove "{{ pack }}-pack"

# Install a package locally into a specific target project
install-pack pack target:
    #!/usr/bin/env bash
    TARGET_DIR=$(cd "{{ invocation_directory() }}" && realpath "{{ target }}")
    if [ ! -d "$TARGET_DIR" ]; then
        echo "Error: Target directory '$TARGET_DIR' does not exist." >&2
        exit 1
    fi
    if [ "$TARGET_DIR" = "{{ justfile_directory() }}" ]; then
        echo "Error: Cannot install packages into the resource catalog itself." >&2
        exit 1
    fi
    cd "$TARGET_DIR" && pi install -l "{{ justfile_directory() }}/packages/{{ pack }}"

# Remove a locally installed package from a target project
remove-pack pack target:
    #!/usr/bin/env bash
    TARGET_DIR=$(cd "{{ invocation_directory() }}" && realpath "{{ target }}")
    if [ ! -d "$TARGET_DIR" ]; then
        echo "Error: Target directory '$TARGET_DIR' does not exist." >&2
        exit 1
    fi
    cd "$TARGET_DIR" && pi remove "{{ pack }}-pack"

# Initialize Python project workspace with justfile.agent and AGENTS.md (non-destructive)
setup-python target:
    @just -f {{ justfile() }} init-project-tools "{{ target }}"
    @echo "✓ Python project tooling & AGENTS.md initialized in $(cd "{{ invocation_directory() }}" && realpath "{{ target }}")."

# Copy agent justfile and AGENTS.md templates into a target project workspace (preserves existing files)
init-project-tools target:
    #!/usr/bin/env bash
    TARGET_DIR=$(cd "{{ invocation_directory() }}" && realpath "{{ target }}")
    if [ ! -d "$TARGET_DIR" ]; then
        echo "Error: Target directory '$TARGET_DIR' does not exist." >&2
        exit 1
    fi
    if [ "$TARGET_DIR" = "{{ justfile_directory() }}" ]; then
        echo "Error: Cannot copy tools into the resource catalog itself." >&2
        exit 1
    fi

    # 1. justfile.agent
    if [ ! -f "$TARGET_DIR/justfile.agent" ]; then
        cp "{{ justfile_directory() }}/templates/justfiles/justfile.agent" "$TARGET_DIR/justfile.agent"
        echo "✓ Copied justfile.agent to $TARGET_DIR."
    else
        echo "ℹ justfile.agent already exists in $TARGET_DIR (preserved)."
    fi

    # 2. AGENTS.md
    if [ ! -f "$TARGET_DIR/AGENTS.md" ]; then
        cp "{{ justfile_directory() }}/templates/AGENTS.md" "$TARGET_DIR/AGENTS.md"
        echo "✓ Copied AGENTS.md to $TARGET_DIR."
    else
        echo "ℹ AGENTS.md already exists in $TARGET_DIR (preserved)."
    fi

# Run cross-project reflection in a dedicated Pi session to evolve this repository
reflect timespan="30d":
    #!/usr/bin/env bash
    PROMPTS=$(python3 skills/analyze-sessions/scripts/prompts.py --since "{{ timespan }}" --corrections)
    if [ -z "$PROMPTS" ]; then
        echo "No prompt corrections found in the last {{ timespan }}."
        exit 0
    fi
    pi "I have extracted the following human prompt corrections across all sessions from the last {{ timespan }}. Please group recurring friction points and propose specific diffs to our files in agents/ or instructions/:" "$PROMPTS"

# Test-run Pi with skills loaded directly from this repository
test-pack pack="core" *args="":
    pi --skill "{{ justfile_directory() }}/skills/analyze-sessions" \
       --skill "{{ justfile_directory() }}/skills/html2md" \
       --skill "{{ justfile_directory() }}/skills/idea-refine" {{ args }}

# Start a dedicated teaching session with the teach persona
teach model="deepseek/deepseek-v4-flash":
    pi --model "{{ model }}" --append-system-prompt "{{ justfile_directory() }}/agents/teach.agent.md"

# One-time: make this repo's base persona Pi's global context file (~/.pi/agent/AGENTS.md)
link-persona:
    #!/usr/bin/env bash
    set -euo pipefail
    SRC="{{ justfile_directory() }}/agents/base.agent.md"
    DEST="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/AGENTS.md"

    if [ ! -f "$SRC" ]; then
        echo "✗ Missing base persona: $SRC" >&2
        exit 1
    fi

    mkdir -p "$(dirname "$DEST")"

    if [ -L "$DEST" ] && [ "$(readlink -f "$DEST")" = "$(readlink -f "$SRC")" ]; then
        echo "✓ Already linked: $DEST -> $SRC"
        exit 0
    fi

    if [ -e "$DEST" ] || [ -L "$DEST" ]; then
        echo "✗ $DEST already exists and is not this link. Refusing to overwrite." >&2
        echo "  Move it aside, then re-run 'just link-persona'." >&2
        exit 1
    fi

    ln -s "$SRC" "$DEST"
    echo "✓ Linked $DEST -> $SRC"

# Launch a pi session with the base persona plus an optional flavor overlay. Usage: just pi [flavor] [pi args...]
pi *args:
    #!/usr/bin/env bash
    set -euo pipefail
    ROOT="{{ justfile_directory() }}"
    BASE="$ROOT/agents/base.agent.md"
    FLAVORS="$ROOT/flavors"
    GLOBAL_AGENTS="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/AGENTS.md"

    if [ ! -f "$BASE" ]; then
        echo "✗ Missing base persona: $BASE" >&2
        exit 1
    fi

    # The base persona is either loaded globally (see `just link-persona`) or appended here.
    cmd=(pi)
    if [ "$(readlink -f "$GLOBAL_AGENTS" 2>/dev/null)" != "$(readlink -f "$BASE")" ]; then
        cmd+=(--append-system-prompt "$BASE")
    fi

    if [ $# -gt 0 ]; then
        case "$1" in
            -*) ;; # leading dash: a pi flag, not a flavor
            *)
                if [ -f "$FLAVORS/$1.md" ]; then
                    cmd+=(--append-system-prompt "$FLAVORS/$1.md")
                    shift
                else
                    echo "✗ Unknown flavor '$1'. Available:" >&2
                    for f in "$FLAVORS"/*.md; do
                        [ -e "$f" ] || continue
                        name="$(basename "$f" .md)"
                        if [ "$name" != "README" ]; then
                            echo "  - $name" >&2
                        fi
                    done
                    exit 1
                fi ;;
        esac
    fi

    exec "${cmd[@]}" "$@"
