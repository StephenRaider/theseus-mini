# Theseus Mini

A harness for **AI employees** that take a goal, plan, use real tools, recover from failures, verify the outcome and report with evidence, while a human supervises through a three-column interface.

The first employee is a **Vendor & Contractor Integrity Specialist** at *Kaveri Infra Pvt Ltd* (fictional). Its job is to make sure the company only pays the right party, the right amount, into the right account.

> Status: **M2, the world.** Contracts, role pack, deterministic checks and the mock company *Kaveri Infra* (mail, ERP, bank, GST portal) with 12 planted real-world traps. Next: the three-column UI. Public design docs: [Framework Spec](docs/Framework%20Spec.md), [Role Research](docs/Role%20Research.md), [Role Dossier](docs/Role%20Dossier%20-%20Vendor%20%26%20Contractor%20Integrity.md).

## Quick start

Requirements: **Node 22+**, **pnpm 10** (`npm i -g pnpm` or `corepack enable`), git.

```bash
pnpm install
pnpm check        # typecheck every package + run all tests
```

Run the mock company and open it in a browser:

```bash
pnpm kaveri       # → http://localhost:4100  (Mail · Vendors · Payments · GST Portal · Bank · HR · Admin)
```

Copy `.env.example` to `.env` and add a model key when the agent loop lands.

## How this repo is worked on

- **Claude** (cloud) writes the code, tests and docs, and runs the full check before delivering.
- **Antigravity** (local) handles installs, commits and pushes, following a private handoff note.
- **GitHub Actions** re-runs `pnpm check` on every push (`.github/workflows/ci.yml`).

## Layout

| Path | What | Status |
|---|---|---|
| `packages/protocol` | The contract: Zod types for employees, tasks, plans, events, commands, tools, widgets, planks. Includes the pure plan-patch logic (skip-and-continue scheduling) | ✅ M1 |
| `packages/core` | The **keel**: agent loop, tool router, permission gate, retries, verifier, event log. M1 has role-pack loading with guard rails | 🟡 |
| `packages/browser` | Playwright wrapper | ⏳ |
| `packs/vendor-integrity` | Role pack: `pack.yaml`, 3 playbooks, and deterministic validators (GSTIN, PAN, IFSC, TDS Sec. 393, MSME 43B(h), duplicate matching) | ✅ M1 |
| `apps/kaveri` | Mock company *Kaveri Infra Pvt Ltd*: mail with real PDF attachments, ERP (vendor master with maker-checker, payment batches), bank (penny-drop, guarantee confirmation), GST portal, HR and debarment lists. Seeded scenario with 12 traps, fault injection, ground truth at `/__admin` | ✅ M2 |
| `apps/server` | Runs employees, stores events, WebSocket API | ⏳ |
| `apps/web` | Three-column UI | ⏳ |
| `evals` | Task suite + pass^k reports | ⏳ |

## Key ideas (short)

- **Keel vs planks.** `core` knows nothing about vendors. Everything domain-specific lives in a role pack (playbooks, tools, checks) that can be versioned, and changed by the employee through a proposal → eval → human approval flow.
- **The plan is shared state.** The agent and the user edit the same plan, only through patches; every patch is an event. A stuck item is parked (`needs_you`) and the rest keep going.
- **Risk tiers.** `read` and `write` run automatically (logged, reversible); `irreversible` actions (activate vendor, change bank, release payment) always pause for approval.
- **Verification is separate.** A verifier re-reads fresh state against success criteria and never trusts the agent's own claims.

## External data and services

| Thing | Use | Licence / note |
|---|---|---|
| [Razorpay IFSC dataset](https://github.com/razorpay/ifsc) (`ifsc` npm) | Offline IFSC existence + bank names | MIT |
| [Razorpay IFSC API](https://ifsc.razorpay.com) | Live branch details (falls back to offline if unreachable) | Public, free |
| zod, yaml, vitest, TypeScript | Schemas, YAML, tests | MIT / ISC |
