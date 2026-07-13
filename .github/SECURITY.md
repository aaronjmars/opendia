# Security Policy

OpenDia connects an AI model to your real browser. The extension holds broad
permissions — `<all_urls>` host access, plus `tabs`, `history`, `bookmarks`,
`cookies`/sessions, `scripting`, and `webNavigation` — and a local MCP server
exposes browser control over `ws://localhost:5555` (and `http://localhost:5556/sse`),
optionally tunneled to the public internet. That is a large, sensitive attack
surface, so this policy is deliberate about what's in scope and how to report a
problem privately.

## Reporting a vulnerability

**Please don't open a public issue for a security problem.** Use GitHub's
**Private Vulnerability Reporting (PVR)** instead:

➡️ **[Report a vulnerability](https://github.com/aeonfun/opendia/security/advisories/new)**

(Repo → **Security** tab → **Report a vulnerability**.) This opens a private
advisory that only the maintainers can see — never a public issue, so a fix can
ship before the details are out.

Please include what you can:

- Which component is affected — the **extension** (`opendia-extension/`:
  `background.js`, `content.js`, popup) or the **MCP server** (`opendia-mcp/`).
- A minimal reproduction or proof of concept.
- The impact you can demonstrate — a web page or another extension driving the
  browser through the MCP bridge, exfiltration of cookies/history/bookmarks,
  cross-origin action with the user's live sessions, or exposure of the local
  server beyond the intended trust boundary.
- Browser + version (Chrome/Firefox/Chromium), OpenDia version, and whether you
  were running in default or `--tunnel` mode.

**Response targets** — best effort; this is a small project:

| Stage | Target |
|-------|--------|
| Acknowledge the report | within 7 days |
| Initial assessment / severity | within 14 days |
| Fix or mitigation on `main` | as fast as the severity warrants |

We follow **coordinated disclosure**: please give us a reasonable window to ship
a fix before you disclose publicly. We'll credit you in the advisory unless you'd
rather stay anonymous.

## Supported versions

Security fixes land on the `main` branch of
[`aeonfun/opendia`](https://github.com/aeonfun/opendia) and the latest
published [`opendia`](https://www.npmjs.com/package/opendia) npm release + extension
build.

| Version | Supported |
|---------|-----------|
| `main` / latest npm + extension build | ✅ Yes |
| Older releases | ❌ No — update to latest |

## Security model

The trust boundary is **your machine**. The MCP server and extension are designed
to talk only to each other, locally.

- **The local server is localhost-scoped by default.** The extension auto-connects
  to `ws://localhost:5555`; SSE is on `http://localhost:5556`. Anything that lets an
  arbitrary web page or a *different* extension reach that bridge and issue browser
  actions is a serious finding.
- **`--tunnel` mode is opt-in and public.** `npx opendia --tunnel` publishes the
  local server through an ngrok tunnel so a remote client (e.g. ChatGPT) can reach
  it. **Anyone who learns that URL can drive your browser with your logged-in
  sessions.** Treat the tunnel URL as a secret, only enable it when you need it, and
  shut it down afterward. Weaknesses in how the tunnel is exposed or authenticated
  are in scope.
- **The extension acts as you.** Because it uses your existing cookies, sessions,
  and saved credentials, every action runs with your authority. Only pair OpenDia
  with an AI client you trust — a malicious or prompt-injected model can ask the
  browser to do anything you can.
- **Untrusted page content is data, not instructions.** Page text the model reads
  can contain injection attempts; content that escalates into unintended browser
  actions or data exfiltration is in scope.
- **Nothing is sent to us.** OpenDia does no cloud processing and no telemetry —
  your browsing data stays local. A code path that ships browser data to a
  third party is a bug, report it.

## Scope

**In scope:**

- A web page or third-party extension issuing MCP/browser actions through the
  local bridge (e.g. via `externally_connectable` or an unauthenticated WS/SSE).
- Exfiltration of cookies, history, bookmarks, stored credentials, or open-tab
  content beyond the intended local flow.
- The `--tunnel` path exposing the server without adequate protection.
- Prompt injection from page content that crosses into unintended actions.
- Code execution or privilege escalation in the extension or server.

**Out of scope:**

- Intended behavior of a **trusted** AI client you connected — OpenDia deliberately
  gives it broad browser control (this is documented; only use trusted models).
- Running `--tunnel` and sharing the URL publicly yourself.
- The anti-detection bypasses functioning as designed on Twitter/X, LinkedIn,
  Facebook (a site's own ToS/detection is between you and that site).
- Vulnerabilities in the browser, ngrok, or the AI client — report to that vendor.

---

> **Maintainers:** the Report-a-vulnerability link only works once PVR is enabled
> — **Settings → Code security and analysis → Private vulnerability reporting →
> Enable**.

Thanks for helping keep OpenDia and the people who run it safe.
