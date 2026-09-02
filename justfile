# ==============================================================================
# Coding AI Resources Catalog Automation
# ==============================================================================

set shell := ["bash", "-uc"]

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

# Install a single package into a target project directory
install-pack pack target:
    #!/usr/bin/env bash
    TARGET_DIR=$(cd "{{invocation_directory()}}" && realpath "{{target}}")
    if [ ! -d "$TARGET_DIR" ]; then
        echo "Error: Target directory '$TARGET_DIR' does not exist." >&2
        exit 1
    fi
    if [ "$TARGET_DIR" = "{{justfile_directory()}}" ]; then
        echo "Error: Cannot install packages into the resource catalog itself." >&2
        exit 1
    fi
    cd "$TARGET_DIR" && pi install -l "{{justfile_directory()}}/packages/{{pack}}"

# Remove a package from a target project directory
remove-pack pack target:
    #!/usr/bin/env bash
    TARGET_DIR=$(cd "{{invocation_directory()}}" && realpath "{{target}}")
    if [ ! -d "$TARGET_DIR" ]; then
        echo "Error: Target directory '$TARGET_DIR' does not exist." >&2
        exit 1
    fi
    cd "$TARGET_DIR" && pi remove "{{pack}}"

# Install full Python stack (core + python-dev + agent tooling) into a target project
setup-python target:
    #!/usr/bin/env bash
    TARGET_DIR=$(cd "{{invocation_directory()}}" && realpath "{{target}}")
    if [ ! -d "$TARGET_DIR" ]; then
        echo "Error: Target directory '$TARGET_DIR' does not exist." >&2
        exit 1
    fi
    if [ "$TARGET_DIR" = "{{justfile_directory()}}" ]; then
        echo "Error: Cannot initialize the resource catalog itself." >&2
        exit 1
    fi
    just -f "{{justfile()}}" install-pack core "$TARGET_DIR"
    just -f "{{justfile()}}" install-pack python-dev "$TARGET_DIR"
    just -f "{{justfile()}}" init-project-tools "$TARGET_DIR"
    echo "✓ Python agent stack initialized in $TARGET_DIR."

# Copy agent justfile template into a target project workspace
init-project-tools target:
    #!/usr/bin/env bash
    TARGET_DIR=$(cd "{{invocation_directory()}}" && realpath "{{target}}")
    if [ ! -d "$TARGET_DIR" ]; then
        echo "Error: Target directory '$TARGET_DIR' does not exist." >&2
        exit 1
    fi
    if [ "$TARGET_DIR" = "{{justfile_directory()}}" ]; then
        echo "Error: Cannot copy tools into the resource catalog itself." >&2
        exit 1
    fi
    cp "{{justfile_directory()}}/templates/justfiles/justfile.agent" "$TARGET_DIR/justfile.agent"
    echo "✓ Copied justfile.agent to $TARGET_DIR."

# Run cross-project reflection in a dedicated Pi session to evolve this repository
reflect timespan="30d":
    #!/usr/bin/env bash
    PROMPTS=$(python3 skills/analyze-sessions/scripts/prompts.py --since "{{timespan}}" --corrections)
    if [ -z "$PROMPTS" ]; then
        echo "No prompt corrections found in the last {{timespan}}."
        exit 0
    fi
    pi "I have extracted the following human prompt corrections across all sessions from the last {{timespan}}. Please group recurring friction points and propose specific diffs to our files in agents/ or instructions/:" "$PROMPTS"

# Test-run Pi with skills loaded directly from this repository
test-pack pack="core" *args="":
    pi --skill "{{justfile_directory()}}/skills/analyze-sessions" \
       --skill "{{justfile_directory()}}/skills/html2md" \
       --skill "{{justfile_directory()}}/skills/idea-refine" {{args}}
