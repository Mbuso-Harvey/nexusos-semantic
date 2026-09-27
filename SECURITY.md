# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.3.x   | :white_check_mark: |
| < 0.3.0 | :x:                |

## Reporting a Vulnerability

We take the security of NexusOS Semantic and kinetic agent automation seriously. If you identify a security vulnerability or exploit vector, please disclose it responsibly:

1. **Authoritative channel (LIVE) — GitHub private vulnerability reporting.**

   **Security Contact:** `https://github.com/Mbuso-Harvey/nexusos-semantic/security/advisories/new`

   Use the **Report a vulnerability** button on this repository's Security tab
   (the form above). Your report stays private (advisory-tracked) and reaches
   the maintainers of the published `agent-web-graph` package as well as this
   repository.

   *Live proof, 2026-09-27:* REST
   `GET /repos/Mbuso-Harvey/nexusos-semantic/private-vulnerability-reporting`
   returns `{"enabled":true}`, and this repository's `/security` page renders
   the **Report a vulnerability** control linking to the URL above.

2. **RETIRED channel — do not use email to `security@nexusos-systems.org`.**
   That mailbox is **not operational**: as of 2026-09-27 the domain
   `nexusos-systems.org` returns **NXDOMAIN** (no A, no MX — Google DoH,
   Cloudflare DoH, 8.8.8.8, 1.1.1.1), so mail sent there is undeliverable. The
   address is retained below only as a record of the retired channel. It becomes
   valid again only if the domain is registered, an MX is published, and
   `pnpm run wave2:verify-disclosure` in the `agent-web-graph` repository proves
   it live.

3. **Response SLA:** the maintainers will acknowledge receipt within 48 hours
   and provide a patch or mitigation timeline within 7 days. The SLA is a
   commitment, not a measured metric; no historical response-time measurement
   has been recorded.

4. **Public Disclosure:** please refrain from publicly disclosing the issue
   until a patch has been merged and released.

---

## Agent Safety Architecture

NexusOS Semantic executes kinetic and semantic actions against target environments (Web, Desktop, Mobile). To prevent unintended side effects, the substrate enforces a three-tier safety classification model:

### Execution Tiers

1. **`READ` (Passive / Idempotent)**
   - Querying the accessibility tree (`graph_query`, `graph_path`).
   - Extracting computed styles, element bounds, ARIA states, and design tokens.
   - Performing non-mutating inspections.
   - Guaranteed safe for unattended autonomous execution.

2. **`EXECUTE` (Standard / Low-Risk Kinetic Actions)**
   - Element focus, synthetic mouse pointer moves, and scrolling.
   - Typing into non-sensitive input fields.
   - Clicking ordinary navigation links and read-only buttons.
   - Monitored by the substrate with deterministic rollbacks where supported.

3. **`CONFIRM` (Sensitive / Irreversible Actions)**
   - Submitting forms, deleting records, financial transactions, and credential inputs.
   - OS-level desktop actions outside the target application boundary.
   - Mobile hardware trigger resets or system package modifications.
   - **Policy:** By default, actions marked `CONFIRM` require explicit co-confirmation or signed authorization policies from the orchestrating agent or human supervisor.

---

## Substrate Guardrails

- **Desktop Isolation:** Windows UIA and macOS AX automation are scoped strictly to the requested window handle (`hwnd` / process ID). Unfocused system background interception is rejected.
- **Mobile ADB Sandboxing:** Mobile shell invocations validate commands against a strict whitelist; raw unbounded shell execution is blocked.
- **WebDriver BiDi / CDP:** Web connections mandate authenticated tokens or local loopback interfaces (`127.0.0.1`) to prevent remote cross-site hijacking.
