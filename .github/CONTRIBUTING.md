# Contributing to OpenDia

Love to have your help making OpenDia better. It has two moving parts — a local
**MCP server** (`opendia-mcp/`) and a **browser extension** (`opendia-extension/`)
that talk to each other over a local WebSocket — and this guide covers building
both and landing a PR.

## Ways to contribute

- **MCP server** fixes/features (`opendia-mcp/` — Node, exposes the browser tools).
- **Extension** work (`opendia-extension/` — MV3 background/content scripts, popup;
  builds for Chrome and Firefox).
- **New browser tools / site support** — bridging a new capability across the
  server and extension.
- **Docs** — setup, tunnel mode, client compatibility.

## Before you start

- **Fork and branch from `main`.** Use a descriptive branch name (`feat/…`,
  `fix/…`, `docs/…`).
- **One change per PR.** Keep server and extension changes coherent — if a new tool
  needs both sides, that's one PR; unrelated refactors are separate.
- **Title as a [Conventional Commit](https://www.conventionalcommits.org/)** —
  `feat: …`, `fix: …`, `docs: …`. PRs are squash-merged, so the title becomes the
  commit subject.
- **Mind the security surface.** The extension holds broad permissions and the
  server can be tunneled publicly — read [`SECURITY.md`](SECURITY.md) before
  touching the bridge, permissions, or tunnel code.

## Development setup

**Prerequisites:** Node.js 20+.

```bash
git clone https://github.com/aeonfun/opendia.git && cd opendia

# 1. Start the MCP server
cd opendia-mcp
npm install
npm start                     # ws://localhost:5555, sse http://localhost:5556

# 2. Build + load the extension (in another shell)
cd ../opendia-extension
npm install
npm run build                 # builds dist/chrome and dist/firefox
```

Load the built extension:

- **Chrome** — `chrome://extensions/` → enable Developer mode → **Load unpacked**
  → `opendia-extension/dist/chrome`
- **Firefox** — `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on**
  → `opendia-extension/dist/firefox/manifest.json`

The extension auto-connects to the server on `localhost:5555`.

## Testing & CI

CI (`.github/workflows/ci.yml`) runs on every push and PR. Reproduce it locally
before pushing:

```bash
# MCP server
cd opendia-mcp && npm ci && node --check server.js

# Extension
cd opendia-extension && npm ci
npm run build                                   # Chrome + Firefox builds
node build.js validate                          # validate the builds
node test-extension.js                          # structure tests
npx web-ext lint --source-dir=dist/firefox --self-hosted   # Firefox lint
```

## Submitting a pull request

- Keep the diff focused and the title conventional; it becomes the squash commit.
- Explain **what** changed and **why**; link the issue (`Fixes #123`).
- Reproduce the CI steps above locally and confirm they pass.
- If you changed permissions, the tunnel, or the message bridge, call it out
  explicitly in the description — those touch the trust boundary.

## Reporting bugs & requesting features

Open an issue with repro steps, your browser + version, OpenDia version, whether
you ran in default or `--tunnel` mode, and what you expected vs. what happened.

**Found a security problem?** Don't open an issue — follow
[`SECURITY.md`](SECURITY.md) and report it privately.

## License

By contributing, you agree that your contributions are licensed under the
repository's [LICENSE](../LICENSE) (MIT).
