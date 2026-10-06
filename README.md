# Theseus Mini

A harness for **AI employees** that take a goal, plan, use real tools, recover from failures, verify the outcome and report with evidence, while a human supervises through a three-column interface.

The first employee is a **Vendor & Contractor Integrity Specialist** at *Kaveri Infra Pvt Ltd* (fictional). Its job is to make sure the company only pays the right party, the right amount, into the right account.

> Status: **M3b, live agent loop, wired into the desktop app.** A real kernel runs each employee end to end: it looks around first (inbox, portals, workspace files), decides how to handle the request (a whole playbook, part of one, or a plan it composes from its tools for a task it has never seen), works through every item with deterministic checks, asks before anything irreversible, takes your messages mid-work without stopping, verifies on a fresh read and reports. The desktop app now runs the real employees (in their own process) and shows all of it: Theseus hands your request to an employee, the plan grid fills in live, approvals and questions appear in the chat, and your messages steer the work while it runs. Underneath: contracts, role pack, deterministic checks and the mock company *Kaveri Infra* (six websites + a workspace of real Excel/PDF/Word files, 12 planted traps).

## Quick start

Requirements: **Node 24** (22+ works), **pnpm 10** (`npm i -g pnpm` or `corepack enable`), git.

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

The app starts the employees in a separate process with a fresh copy of the company world. With `GEMINI_API_KEY` in `.env` it runs **Live** on Gemini; without it, **Demo** (a scripted model for the example requests; tools, checks and company systems are real). Switch with the button at the bottom left; the ↻ button resets the world. Click an example request in Theseus's chat (or type your own): Theseus hands it to an employee, and you can open their chat to approve, answer questions, or steer them (“hold everything to Malnad Transport”, “how far are you?”, “pause”). Click any row in the plan grid to hold / skip / retry it. Results land as real files in `workspace/` and show up in the Files tab. In a plain browser (`pnpm web`) the UI falls back to the scripted M3 replay.

Run the mock company (seven local sites + a workspace folder):

```bash
pnpm kaveri        # Control Room http://localhost:4100 · Mail :4101 · ERP :4102 · Bharat Bank :4103 · GST :4104 · Udyam :4105 · eProcure :4106
pnpm world:reset   # regenerate ./workspace (Vendor Register.xlsx, policy PDF, Word templates) without starting the sites
```

### Give an employee a task (headless)

```bash
pnpm agent --scripted "Run the integrity check on this week's payment batch"   # no API key needed
pnpm agent "Empanel the three bidders who qualified on T-2026-14"              # live model (needs .env)
```

Copy `.env.example` to `.env` and set `GEMINI_API_KEY` (free tier; `GEMINI_MODEL=gemini-3.5-flash-lite` by default). While it runs, type to talk to the employee: `hold everything to Shree Ganesh`, `skip PL-07`, `how far are you?`, `pause`, `resume`; decide approvals with `approve apr_001` / `reject apr_001`. Each run starts a fresh in-process copy of the company world (and regenerates `workspace/`), so runs are repeatable. Options: `--approve all|none`, `--pace 300` (slow down to watch and interrupt), `--cache` (reuse identical model answers), `--live-world` (use the running `pnpm kaveri` and watch the sites change in a browser), `--log run.jsonl`.

What it can be asked (the employee picks the route itself):

| Kind | Example | How |
|---|---|---|
| Whole playbook | "Run the integrity check on this week's payment batch" | 65 lines × 6 checks, deterministic, 1 model call |
| Part of a playbook | "Only check the GSTINs of the T-14 bidders" · "Recheck the TDS on W41" | runs just those steps (plus what they depend on) |
| Adjacent, no playbook | "Confirm the EMD guarantees of the T-14 bidders with the banks" · "Which vendors are dormant?" | the model writes a small plan from the tools once; the kernel runs it |
| Out of scope | "Write me a poem" | politely refused |

## How this repo is worked on

- **Claude** (cloud) writes the code, tests and docs, and runs the full check before delivering.
- **Antigravity** (local) handles installs, commits and pushes.
- **GitHub Actions** re-runs `pnpm check` on every push (`.github/workflows/ci.yml`).

## Layout

| Path | What | Status |
|---|---|---|
| `packages/protocol` | The contract: Zod types for employees, tasks, plans, events, commands, tools, widgets, planks. Includes the pure plan-patch logic (skip-and-continue scheduling) | ✅ M1 |
| `packages/core` | The **keel**: kernel (orient → route → plan → run → verify → report), tool gateway (risk tiers, approvals, standing constraints, idempotency, retries), conversation lane (mid-work messages and questions), composed plans for unseen tasks, event log, model adapter (Gemini REST + free-tier rate limiter + cache), `FileSandbox` and file tools | ✅ M3b |
| `packages/browser` | Playwright wrapper | ⏳ |
| `packs/vendor-integrity` | Role pack: `pack.yaml` (tools, checks, scope charter), playbooks, deterministic validators (GSTIN, PAN, IFSC, TDS Sec. 393, MSME 43B(h), duplicate matching), and its runtime: tools over the company's systems and step handlers for the batch check and empanelment | ✅ M3b |
| `apps/kaveri` | Mock company *Kaveri Infra Pvt Ltd* as **separate sites**: Mail (attachments, drafts), ERP (vendor master with maker-checker, payment batch + Excel export, HR/debarment), Bharat Bank (penny-drop, guarantee confirmation, bulk payment upload with maker-checker), GST portal, Udyam portal, eProcure (tender + bidder docs). Local **workspace** of real `.xlsx`/`.pdf`/`.docx` files. Seeded scenario (12 traps), fault injection, Control Room with ground truth | ✅ M2b |
| `apps/server` | Wires a harness (kernel + pack + model + world); the **agent host** the desktop app runs in its own process (plays Theseus, the manager, too); the `pnpm agent` CLI; an in-process world for tests; a scripted stand-in model | ✅ M3b |
| `apps/web` | Three-column UI (React + Vite): employee list with live status and red/yellow/green badges, chat with day separators, approval cards and nudges, plan grid with item actions, Files and Activity tabs. In the desktop app it shows the **live employees** (questions, standing instructions, what they looked at); in a plain browser it falls back to the M3 replay | ✅ M3b |
| `apps/desktop` | Electron shell. Only the main process touches the disk, through `FileSandbox` (granted folders only, symlink-escape checks, never overwrites); it forks the agent host and relays its events; the UI gets a narrow typed bridge (`window.theseus`) | ✅ M3b |
| `evals` | Task suite + pass^k reports | ⏳ |

## Key ideas (short)

- **Keel vs planks.** `core` knows nothing about vendors. Everything domain-specific lives in a role pack (playbooks, tools, checks) that can be versioned, and changed by the employee through a proposal → eval → human approval flow.
- **The plan is shared state.** The agent and the user edit the same plan, only through patches; every patch is an event. A stuck item is parked (`needs_you`) and the rest keep going.
- **Risk tiers.** `read` and `write` run automatically (logged, reversible); `irreversible` actions (activate vendor, change bank, release payment) always pause for approval.
- **Verification is separate.** A verifier re-reads fresh state against success criteria and never trusts the agent's own claims.
- **Deterministic first, model last.** The model routes the request and composes plans for new tasks; checks, maths and record lookups are plain code, so a weak free-tier model is enough and results are repeatable.
- **Messages never stop the work.** A message mid-task is triaged (question, steer, info, pause…). A steer like "hold everything to X" becomes a standing constraint checked at the tool gateway before every write, so it holds even if the model forgets it.

## External data and services

| Thing | Use | Licence / note |
|---|---|---|
| [Razorpay IFSC dataset](https://github.com/razorpay/ifsc) (`ifsc` npm) | Offline IFSC existence + bank names | MIT |
| [Razorpay IFSC API](https://ifsc.razorpay.com) | Live branch details (falls back to offline if unreachable) | Public, free |
| zod, yaml, vitest, TypeScript | Schemas, YAML, tests | MIT / ISC |
| Electron, React, Vite, esbuild | Desktop app and UI | MIT |
| Inter, JetBrains Mono (`@fontsource`) | Fonts, bundled for offline use | OFL |
