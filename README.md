# Theseus Mini

A harness for **AI employees** that take a goal, plan, use real tools, recover from failures, verify the outcome and report with evidence, while a human supervises through a three-column interface.

The first employee is a **Vendor & Contractor Integrity Specialist** at *Kaveri Infra Pvt Ltd* (fictional). Its job is to make sure the company only pays the right party, the right amount, into the right account.

> Status: **M3c, computer use.** Employees now operate the company's web apps in a real browser (Chromium via Playwright): they open pages, read them, fill and submit forms, recover when a session expires or a page errors, ask before anything irreversible, and an independent verifier re-reads the result fresh. The brief's own example ("find the latest invoice from X, extract the amount and due date, enter it into our internal system, tell me when done") runs end to end against **FinDesk**, a legacy AP system with no API. See [Computer use](#computer-use-operate-mode).
>
> Before that, **M3b: live agent loop, wired into the desktop app.** A real kernel runs each employee end to end: it looks around first (inbox, portals, workspace files), decides how to handle the request (a whole playbook, part of one, or a plan it composes from its tools for a task it has never seen), works through every item with deterministic checks, asks before anything irreversible, takes your messages mid-work without stopping, verifies on a fresh read and reports. The desktop app now runs the real employees (in their own process) and shows all of it: Theseus hands your request to an employee, the plan grid fills in live, approvals and questions appear in the chat, and your messages steer the work while it runs. Underneath: contracts, role pack, deterministic checks and the mock company *Kaveri Infra* (six websites + a workspace of real Excel/PDF/Word files, 12 planted traps).

## Quick start

Requirements: **Node 24** (22+ works), **pnpm 10** (`npm i -g pnpm` or `corepack enable`), git.

```bash
pnpm install
pnpm browser:install   # once: downloads the Chromium the employees use (Playwright)
pnpm check             # typecheck every package + run all tests
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

### Computer use (operate mode)

```bash
pnpm agent --scripted --headed --slowmo 300 "Find the latest invoice from Hoysala Steel, extract the amount and due date, enter it into FinDesk and tell me once it's done"
```

`--headed` shows the employee's browser window so you can watch it work (drop it to run hidden; `--approve all` decides approvals for you; add "post it to the ledger" to the request to see an approval). In the desktop app the same job is the first suggestion, and the employee's **Screen** tab shows its browser live after every action.

What happens, all of it real except the model's answers in `--scripted` mode:

1. **Route.** The request is a one-off hands-on job, so the router picks `mode=operate` (not a playbook, not a per-item check).
2. **Plan.** The model writes 2–6 *subgoals* it can see finished ("Find the latest Hoysala invoice email", "Read the invoice", "Open FinDesk's invoice form", "Enter and save the invoice"). They become the rows of the grid; the columns are **Do** and **Proof**.
3. **Observe → act, one action at a time.** Each turn the model sees the subgoal, its memory, the last few actions and the full result of the last one (a page as a text outline with element refs like `[e12] button "Save as draft"`, an email list, a PDF's text) and returns ONE action. It searches the mail (API), downloads and reads the PDF (files), then signs in to FinDesk, fills the form (`browser.fill_form`, all fields in one action) and clicks Save.
4. **Rails the kernel enforces, whatever the model says:**
   - *Risk per click.* A link or GET form is a read, a POST form a write (logged, screenshotted before/after), and the role pack's `ui_risks` mark the irreversible ones ("Post to ledger", "Send", "Release"). Those pause for your approval with the page, row and form values on the card; after you approve, the *same* click runs (the element is pinned by role and name, so a re-rendered page doesn't misfire).
   - *Standing instructions apply to clicks too.* "Hold everything to Hoysala" blocks a click whose page, table row or form values name Hoysala.
   - *Evidence-bound memory.* A fact is remembered only with an exact quote, and the kernel checks the quote really is in something the agent was shown. "Rs. 4,27,160.00" matches 427160; a made-up value or a reformatted date doesn't.
   - *Proof.* A subgoal counts as done only if the proof it quotes is on screen.
   - *Recovery.* Stale refs re-observe the page; a 503 or an expired session is just another page to react to; the same failing action three times, or a step budget, stops and asks you instead of spinning. Messages you send mid-work reach the next decision.
   - *Origins.* The browser can only reach the company's sites (an allow-list), and every request carries `x-actor: agent:<id>`, so FinDesk's audit log shows the agent.
5. **Verify, independently.** The verifier re-reads the *source* of every remembered fact (the PDF again, the mail search again), then opens the outcome fresh (FinDesk's record page) and checks the expected values are really there.
6. **Report** with the facts and where each was seen, what changed, what's still open, and the screenshots saved in `workspace/Evidence/<task>/`.

FinDesk itself (`apps/kaveri/src/sites/ap.ts`, port 4107) is deliberately legacy: single sign-on page, sessions that expire (fault `ap.session_expired`), dates only as DD/MM/YYYY, amounts digits-only, totals must add up, duplicates refused with a document number, a JS confirm before posting, and no JSON API at all.

What it can be asked (the employee picks the route itself):

| Kind | Example | How |
|---|---|---|
| Whole playbook | "Run the integrity check on this week's payment batch" | 65 lines × 6 checks, deterministic, 1 model call |
| Part of a playbook | "Only check the GSTINs of the T-14 bidders" · "Recheck the TDS on W41" | runs just those steps (plus what they depend on) |
| Adjacent, no playbook | "Confirm the EMD guarantees of the T-14 bidders with the banks" · "Which vendors are dormant?" | the model writes a small plan from the tools once; the kernel runs it |
| Hands-on job across systems | "Find the latest invoice from Hoysala Steel, extract the amount and due date, enter it into FinDesk and tell me once it's done" | plans subgoals, then works one action at a time in mail, files and a real browser; asks before posting (operate mode) |
| Out of scope | "Write me a poem" | politely refused |

## How this repo is worked on

- **Claude** (cloud) writes the code, tests and docs, and runs the full check before delivering.
- **Antigravity** (local) handles installs, commits and pushes.
- **GitHub Actions** re-runs `pnpm check` on every push (`.github/workflows/ci.yml`).

## Layout

| Path | What | Status |
|---|---|---|
| `packages/protocol` | The contract: Zod types for employees, tasks, plans, events, commands, tools, widgets, planks. Includes the pure plan-patch logic (skip-and-continue scheduling) | ✅ M1 |
| `packages/core` | The **keel**: kernel (orient → route → plan → run → verify → report), tool gateway (risk tiers decided per call, approvals, standing constraints, idempotency, retries), conversation lane (mid-work messages and questions), composed plans for unseen tasks, **operate mode** (`operate.ts`: subgoals, observe → act loop, evidence-bound memory, independent verifier), **browser tools** (`browsertools.ts`), event log, model adapter (Gemini REST + free-tier rate limiter + cache), `FileSandbox` and file tools (read PDF/Excel/Word, search inside files, save) | ✅ M3c |
| `packages/browser` | Real Chromium via Playwright, one isolated session per employee: pages as text outlines with element refs, actions (open, click, type, fill, select, upload, back), downloads, dialogs, screenshots, origin allow-list, classified errors | ✅ M3c |
| `packs/vendor-integrity` | Role pack: `pack.yaml` (tools, checks, scope charter), playbooks, deterministic validators (GSTIN, PAN, IFSC, TDS Sec. 393, MSME 43B(h), duplicate matching), and its runtime: tools over the company's systems and step handlers for the batch check and empanelment | ✅ M3b |
| `apps/kaveri` | Mock company *Kaveri Infra Pvt Ltd* as **separate sites**: Mail (attachments, drafts), ERP (vendor master with maker-checker, payment batch + Excel export, HR/debarment), Bharat Bank (penny-drop, guarantee confirmation, bulk payment upload with maker-checker), GST portal, Udyam portal, eProcure (tender + bidder docs). Local **workspace** of real `.xlsx`/`.pdf`/`.docx` files. Seeded scenario (12 traps), fault injection, Control Room with ground truth. **FinDesk**: legacy AP invoice register with web forms only (no API) | ✅ M3c |
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
- **Computer use is more tools, not a second agent.** Browser actions go through the same gateway as API calls, so risk tiers, approvals, standing constraints, retries and evidence apply unchanged. The agent sees pages as text outlines with refs (cheap, precise, weak-model friendly); screenshots are kept as evidence and for you to watch, not as the agent's eyes.
- **Use the API when there is one, the screen when there isn't.** Mail and ERP have tools; FinDesk only has forms. The operate prompt says so, and the verifier can check through either.
- **Messages never stop the work.** A message mid-task is triaged (question, steer, info, pause…). A steer like "hold everything to X" becomes a standing constraint checked at the tool gateway before every write, so it holds even if the model forgets it.

## Known limitations (computer use, M3c)

- Browser only: desktop apps (Excel, Word) are read and written as files, not driven with the mouse.
- The agent reads pages as DOM outlines. Canvas-heavy or image-only pages would need a vision fallback (the screenshots are already captured).
- Tested end to end with the scripted model (deterministic, in CI). The live Gemini path uses the same prompts and schemas but hasn't been tuned on long, messy pages yet. On the free tier (15 calls/min) the invoice job takes about a minute.
- Operate runs keep their memory in the process: a crash mid-task loses it (durable resume is M4).
- One browser session per employee: employees work in parallel but don't share logins.

## External data and services

| Thing | Use | Licence / note |
|---|---|---|
| [Razorpay IFSC dataset](https://github.com/razorpay/ifsc) (`ifsc` npm) | Offline IFSC existence + bank names | MIT |
| [Razorpay IFSC API](https://ifsc.razorpay.com) | Live branch details (falls back to offline if unreachable) | Public, free |
| zod, yaml, vitest, TypeScript | Schemas, YAML, tests | MIT / ISC |
| Playwright (`playwright-core`) + Chromium | The employees' browser (computer use) | Apache-2.0 / BSD |
| jszip | Reading Word (.docx) files | MIT |
| Electron, React, Vite, esbuild | Desktop app and UI | MIT |
| Inter, JetBrains Mono (`@fontsource`) | Fonts, bundled for offline use | OFL |
