# Game Development Board

Electron app (Windows, NSIS installer, electron-updater via GitHub Releases).

- `npm test` runs `test/core.test.js` (store + MCP + transports). Keep it green.
- `src/core` must stay dependency-free plain Node: it is copied to `resources/mcp-server` and run with `ELECTRON_RUN_AS_NODE=1` as the stdio MCP server.
- Board writes go through `BoardStore.applyPatch` (upserts/deletes) so renderer edits and MCP edits never overwrite each other.
- Release: bump `version` in package.json and push to main; `.github/workflows/release.yml` publishes `vX.Y.Z` with `Game-Development-Board-Setup.exe` + `latest.yml`. Keep `artifactName` stable; the README download link depends on it.
- Renderer is vanilla JS (no build step). Theme colors are CSS variables in `styles.css` (light default, `[data-theme="dark"]`).
