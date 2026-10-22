## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Knowledge graph setup

`graphify-out/` is not committed; each checkout builds its own. In Claude Code, `.claude/settings.json` rebuilds it in the background when a session starts and after every turn, in the main checkout and in every worktree (graphify's own git hooks skip linked worktrees). The git hooks from `graphify hook install` also rebuild the main checkout's graph after commits and checkouts. A rebuild takes about 8 seconds and needs no API key. If `graphify-out/graph.json` is missing, install graphify (`uv tool install graphifyy` or `pip install graphifyy`) and run `graphify update .`.
