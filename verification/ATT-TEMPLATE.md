# Authorization-to-Test (ATT) & Rules of Engagement — design-partner template

> **TEMPLATE — NOT AN AGREEMENT BY ITSELF.** A signed copy must exist before
> ANY crawl or test against partner systems. It is filed in the private
> compliance archive and referenced from the target manifest
> (`verification/targets/<slug>.json`, `class: "design-partner"`) before any
> run is recorded in the ledger (ED-09 §2).

## 1. Parties

- **Testing party ("we"):** NexusOS Systems — legal entity: ____________
- **Authorizing party ("the Client"):** ____________ — authorized
  representative (name + role): ____________

## 2. Scope (exhaustive; anything not listed is OUT of scope)

- In-scope hosts/URLs: ____________
- In-scope accounts (**synthetic/test only**; never production user
  accounts): ____________
- Test window (UTC): from ____________ to ____________
- Environment: non-production / controlled. Production testing requires an
  additional, separate signature below.

## 3. What we will do

- Crawl the in-scope surfaces with NexusOS Semantic (WebDriver BiDi),
  bounded by the agreed per-run page budget, recording the produced
  semantic graph as evidence in the ledger (`verification/`).
- Read-only interaction by default; `CONFIRM`-tier actions only with
  per-action approval (see §4).

## 4. Hard prohibitions (non-negotiable)

1. No actions against systems outside the listed scope, including
   third-party scripts, iframes, or APIs reached from in-scope pages.
2. No destructive actions. `CONFIRM`-tier automation requires explicit
   per-action approval from the Client contact.
3. No use of real user credentials; no credential stuffing; synthetic
   accounts only.
4. No load generation: single-concurrency crawling, hard page budget per
   run, no DoS-shaped behaviour of any kind.
5. No social engineering, no physical access, no attempts on personnel.
6. No exfiltration of production personal data. Findings are redacted
   before leaving the Client environment.

## 5. Data handling

- Raw run artifacts remain in the Client environment or an agreed secure
   store; summaries recorded in the ledger contain no Client personal data.
- Findings are confidential for **90 days** from discovery; coordinated
   disclosure timeline agreed per finding.
- Accidental out-of-scope contact is reported to the Client contact within
   **24 hours**.

## 6. Contact & revocation

- Client 24h contact (during the window): ____________
- Our contact: `security@nexusos-systems.org`
- Either party may revoke in writing with immediate effect. On revocation
  or expiry we stop all testing and delete collected artifacts on request
  within 5 business days, certifying deletion in writing.
- A halt request from the Client contact stops all automated activity
  within **30 minutes**, confirmed in writing; resumption requires the
  Client's explicit written approval (ED-10 §2).

## 7. Signatures

Testing party: ____________ date ____________

Authorizing party: ____________ date ____________

(Additional signature for production-environment testing:)
Client executive: ____________ date ____________
