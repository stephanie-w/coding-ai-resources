# HTML Report Format

Render the architectural review as a single self-contained HTML file in the OS temp directory. Tailwind and Mermaid load from CDNs. Mix Mermaid (for graph/flow/sequence diagrams) with hand-built `<div>`s and inline SVG (for cross-sections, mass diagrams, and call-graph collapses) so the report reads as editorial rather than generic.

## Scaffold

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Architecture review for {{repo name}}</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script type="module">
      import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
      mermaid.initialize({ startOnLoad: true, theme: "neutral", securityLevel: "loose" });
    </script>
    <style>
      .seam { stroke-dasharray: 4 4; }
      .leak { stroke: #dc2626; }
      .deep { background: linear-gradient(135deg, #0f172a, #1e293b); }
    </style>
  </head>
  <body class="bg-stone-50 text-slate-900 font-sans">
    <main class="max-w-5xl mx-auto px-6 py-12 space-y-12">
      <header>...</header>
      <section id="candidates" class="space-y-10">...</section>
      <section id="top-recommendation">...</section>
    </main>
    <script>
      async function copyIssue(btn) {
        const card = btn.closest("article");
        const title = card.querySelector("[data-issue-title]")?.textContent.trim() ?? "";
        const files = [...card.querySelectorAll("[data-issue-file]")].map(el => "`" + el.textContent.trim() + "`").join(", ");
        const problem = card.querySelector("[data-issue-problem]")?.textContent.trim() ?? "";
        const solution = card.querySelector("[data-issue-solution]")?.textContent.trim() ?? "";
        const wins = [...card.querySelectorAll("[data-issue-win]")].map(el => "- " + el.textContent.trim()).join("\n");
        const md = [
          `### ${title}`,
          files ? `**Files:** ${files}` : "",
          `**Problem:** ${problem}`,
          `**Solution:** ${solution}`,
          wins ? `**Benefits:**\n${wins}` : ""
        ].filter(Boolean).join("\n\n");
        try {
          await navigator.clipboard.writeText(md);
        } catch {
          const ta = Object.assign(document.createElement("textarea"), { value: md });
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        const orig = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => { btn.textContent = orig; }, 1500);
      }
    </script>
  </body>
</html>
```

## Header

Repo name, date, and a compact legend:
- Solid box = module
- Dashed line = seam
- Red arrow = leakage
- Thick dark box = deep module

No introduction paragraph—go straight into the candidates.

## Candidate Card

Each candidate is one `<article>`:
- **Title** (`data-issue-title`): short, names the deepening (e.g., "Collapse the feature transform pipeline").
- **Badge row**: recommendation strength (`Strong` = emerald, `Worth exploring` = amber, `Speculative` = slate) + dependency category (`in-process`, `local-substitutable`, `ports & adapters`, `mock`), plus a subtle **"Copy for GitHub Issue"** button (`onclick="copyIssue(this)"`) on the right.
- **Files** (`data-issue-file` per path): monospaced list (`font-mono text-sm`).
- **Before / After diagram**: two columns side by side (~320px tall so they fit without scrolling).
- **Problem** (`data-issue-problem`): one sentence.
- **Solution** (`data-issue-solution`): one sentence.
- **Wins** (`data-issue-win` per `<li>`): bullets, <=6 words each, naming gains in glossary terms (e.g., *"Locality: train and serve share transform"*, *"Tests hit one interface"*, *"Delete 3 shallow wrappers"*).
- **ADR callout** (only if applicable): one line in an amber-tinted box.

Every copyable attribute must sit directly on the element holding its content, not on a wrapper, or the "Copy for GitHub Issue" button extracts blanks or duplicate labels. The `data-issue-problem` / `data-issue-solution` spans wrap only the sentence text after the label, and each file path is its own `data-issue-file` element:

```html
<p><span class="font-semibold text-red-700">Problem:</span> <span data-issue-problem>One-sentence friction.</span></p>
<p><span class="font-semibold text-emerald-700">Solution:</span> <span data-issue-solution>One-sentence deepening.</span></p>
<p class="font-mono text-sm text-slate-600">
  <span data-issue-file>src/pkg/module_a.py</span> ·
  <span data-issue-file>src/pkg/module_b.py</span>
</p>
```

## Diagram Patterns

Vary the pattern to fit the candidate:
- **Mermaid graph**: for dependency tangles, call chains, or training/serving duplication (`flowchart LR` with `classDef leak stroke:#dc2626,stroke-width:2px;`).
- **Cross-section** (HTML/Tailwind): horizontal bands (`h-12 border-l-4`) for over-layered CRUD (`Router → Service → Repo → Mapper`) collapsing into 1–2 thick bands.
- **Mass diagram** (HTML/SVG): two rectangles per module—interface height vs. implementation height—showing a shallow wide-interface module collapsing into a deep narrow-interface module.
- **Call-graph collapse** (HTML/SVG): nested boxes before, consolidated into one thick-bordered dark module with faded internals after.

Use `text-xs uppercase tracking-wider` for module labels inside custom diagrams.

## Top Recommendation Section

One larger card at the end: candidate name, one sentence on why to tackle it first, and an anchor link to its card.

## Tone & Vocabulary

Use the glossary terms strictly: **module**, **interface**, **implementation**, **depth**, **deep**, **shallow**, **seam**, **adapter**, **leverage**, **locality**.
Never substitute *component*, *service*, *unit* (for module), *API/signature* (for interface), or *boundary* (for seam).
Keep prose sparse and direct—if a diagram needs a paragraph to explain it, redraw the diagram.
