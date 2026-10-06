# Theseus Mini

A harness for **AI employees** that take a goal, plan, use real tools, recover from failures, verify the outcome and report with evidence, while a human supervises through a three-column interface.

The first employee is a **Vendor & Contractor Integrity Specialist** at *Kaveri Infra Pvt Ltd* (fictional). Its job is to make sure the company only pays the right party, the right amount, into the right account.

> Status: **M3, desktop app v0.** An Electron app with the three-column interface (WhatsApp-style employee list · chat with timestamps and files · live plan grid you can steer), sandboxed access to local files, and a scripted replay of the vendor-desk demo (no API key needed). Underneath: contracts, role pack, deterministic checks and the mock company *Kaveri Infra* (six websites + a workspace of real Excel/PDF/Word files, 12 planted traps). Next: the live agent loop.

## Quick start

Requirements: **Node 22+**, **pnpm 10** (`npm i -g pnpm` or `corepack enable`), git.

```bash
pnpm install
pnpm check        # typecheck every package + run all tests
```

Run the desktop app (generates `./workspace` on first run):

```bash
pnpm app           # Electron window, UI reloads live while you edit apps/web
pnpm app:prod      # same, from the built UI
pnpm web           # the UI in a normal browser (no local-file features)
```

Click **Try the demo** in Theseus's chat. Two employees start working; approve or reject their requests in the chat, click any row in the plan grid to hold / skip / retry it, or message a working employee to nudge it (“Hold everything to Shree Ganesh”). Results land as real files in `workspace/` and show up in the Files tab.

Run the mock company (seven local sites + a workspace folder):

```bash
pnpm kaveri        # Control Room http://localhost:4100 · Mail :4101 · ERP :4102 · Bharat Bank :4103 · GST :4104 · Udyam :4105 · eProcure :4106
pnpm world:reset   # regenerate ./workspace (Vendor Register.xlsx, policy PDF, Word templates) without starting the sites
```

Copy `.env.example` to `.env` and add a model key when the agent loop lands.

## How this repo is worked on

- **Claude** (cloud) writes the code, tests and docs, and runs the full check before delivering.
- **Antigravity** (local) handles installs, commits and pushes.
- **GitHub Actions** re-runs `pnpm check` on every push (`.github/workflows/ci.yml`).

## Layout

| Path | What | Status |
|---|---|---|
| `packages/protocol` | The contract: Zod types for employees, tasks, plans, events, commands, tools, widgets, planks. Includes the pure plan-patch logic (skip-and-continue scheduling) | ✅ M1 |
| `packages/core` | The **keel**: agent loop, tool router, permission gate, retries, verifier, event log. So far: role-pack loading with guard rails, and `FileSandbox` (the only way to touch local files) | 🟡 |
| `packages/browser` | Playwright wrapper | ⏳ |
| `packs/vendor-integrity` | Role pack: `pack.yaml`, 3 playbooks, and deterministic validators (GSTIN, PAN, IFSC, TDS Sec. 393, MSME 43B(h), duplicate matching) | ✅ M1 |
| `apps/kaveri` | Mock company *Kaveri Infra Pvt Ltd* as **separate sites**: Mail (attachments, drafts), ERP (vendor master with maker-checker, payment batch + Excel export, HR/debarment), Bharat Bank (penny-drop, guarantee confirmation, bulk payment upload with maker-checker), GST portal, Udyam portal, eProcure (tender + bidder docs). Local **workspace** of real `.xlsx`/`.pdf`/`.docx` files. Seeded scenario (12 traps), fault injection, Control Room with ground truth | ✅ M2b |
| `apps/server` | Runs employees, stores events, WebSocket API | ⏳ |
| `apps/web` | Three-column UI (React + Vite): employee list with live status and red/yellow/green badges, chat with day separators, approval cards and nudges, plan grid with item actions, Files and Activity tabs. Driven by a **replay engine**, a simulated kernel that speaks the real protocol | ✅ M3 |
| `apps/desktop` | Electron shell. Only the main process touches the disk, through `FileSandbox` (granted folders only, symlink-escape checks, never overwrites); the UI gets a narrow typed bridge (`window.theseus`) | ✅ M3 |
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
| Electron, React, Vite, esbuild | Desktop app and UI | MIT |
| Inter, JetBrains Mono (`@fontsource`) | Fonts, bundled for offline use | OFL |
