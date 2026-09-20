# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1.0 | :x:                |

## Reporting a Vulnerability

We take the security of NexusOS Semantic and kinetic agent automation seriously. If you identify a security vulnerability or exploit vector, please disclose it responsibly:

1. **GitHub private vulnerability reporting (preferred).** The repository is
   published; open a private vulnerability report via the Security tab so the
   disclosure stays advisory-tracked.
2. **Security Contact:** Email security alerts to `security@nexusos-systems.org`.
3. **Response SLA:** The NexusOS Systems security team will acknowledge receipt within 48 hours and provide a patch or mitigation timeline within 7 days.
4. **Public Disclosure:** Please refrain from publicly disclosing the issue until a patch has been merged and released.

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
