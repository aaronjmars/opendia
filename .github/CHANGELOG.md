# Changelog

Notable changes to the OpenDia MCP server and browser extension.

Release notes on the [Releases page](https://github.com/aeonfun/opendia/releases)
are written from this file, so land your entry in **Unreleased** with the change
itself rather than reconstructing it at tag time.

## Unreleased

### ⚠️ Breaking

- **`--tunnel` now requires a bearer token.** Publishing the MCP server through a
  tunnel used to mean anyone who learned the URL could drive your browser. `/sse`
  is now authenticated whenever the surface leaves this machine (`--tunnel`, or
  `--http-host=` set to a non-loopback address). The server generates a token at
  startup and prints it; pin a fixed one with `--token=<value>`.

  Existing tunnel users **must** add the header — an online AI connector that
  worked before will start returning `401` until it does:

  ```
  Authorization: Bearer <token>
  ```

  Purely local setups (`npx opendia`, Claude Desktop over stdio, the browser
  extension) are unaffected and need no token. (#55)

### Security

- Bind the extension control channel to loopback and gate its handshake. The
  WebSocket server listened on all interfaces, and because the connection handler
  hands the extension slot to whoever connects last, any reachable peer could evict
  the real extension, receive every automation command, and return fabricated
  results to the model. (#53)
- Bind the HTTP/SSE surface to loopback and refuse page origins. `POST /sse` passes
  its body to the MCP request handler, so the same control was reachable from the
  LAN and — via `Access-Control-Allow-Origin: *` — cross-origin from any website you
  visited. Both listeners now bind `127.0.0.1`, every request carrying a page
  `Origin` is rejected, and CORS is reflected only for allowed origins. (#55)
- Override `adm-zip` to `^0.6.0`, clearing GHSA-xcpc-8h2w-3j85 (crafted ZIP triggers
  a 4GB allocation). Dev-only and not reachable from `web-ext lint`; the override
  exists because `firefox-profile` pins `~0.5.x` and cannot reach the patch. (#56)
- Bump `node-forge` to 1.4.0 and `brace-expansion` to 1.1.15. (#43)

### Maintenance

- Dependency bumps: `ws` (#52), `web-ext` (#48), `actions/checkout` 4 → 7 (#46),
  `actions/setup-node` 4 → 7 (#47, #51).
- Consolidate community docs under `.github/` and add SECURITY + CONTRIBUTING (#44),
  move `LICENSE` back to the repo root so GitHub detects it (#45), update
  attribution to aeonfun / Aeon Inc (#49), aeon-style README (#50).

## v1.1.1 — 2026-07-03

MCP reliability fixes and Express 5. See the
[release notes](https://github.com/aeonfun/opendia/releases/tag/v1.1.1).

## v1.1.0 — 2025-07-20

Timeout fixes and expanded documentation. See the
[release notes](https://github.com/aeonfun/opendia/releases/tag/v1.1.0).
