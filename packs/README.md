# Building a new employee (role pack)

**Theseus is a platform for AI employees.** The platform (the *keel*) is fixed and knows nothing
about any job: it plans, runs steps, calls tools through a safety gateway, asks for approval,
takes your messages mid-work, verifies the result and reports. A **role pack** turns it into a
specific employee. `vendor-integrity` is the first pack; this is how you add the next one.

## What the platform gives every employee (you write none of this)

| Platform capability | Where |
|---|---|
| Agent loop: understand, plan, run, verify, report | `packages/core/src/kernel.ts` |
| Tool gateway: risk tiers, approvals, standing instructions ("hold X"), idempotency, retries, evidence | `packages/core/src/gateway.ts` |
| Computer use: real browser, per-click risk, screenshots as evidence, live Screen tab | `packages/browser`, `packages/core/src/browsertools.ts` |
| Hands-on "operate" mode for one-off jobs across systems | `packages/core/src/operate.ts` |
| Files: read PDF/Excel/Word, search inside files, save (sandboxed) | `packages/core/src/filetools.ts` |
| Plans for unseen tasks composed from the pack's tools | `packages/core/src/program.ts` |
| Theseus the manager, the desktop app, chat, plan grid, approvals | `apps/server`, `apps/web`, `apps/desktop` |

## What a pack provides

1. **`pack.yaml`**: identity (`persona`), the tools the role may use with risk tiers, its scope (what it does and refuses), named checks, and, for computer use, which web apps it may open and which buttons are risky (`ui_risks`).
2. **`playbooks/*.yaml`**: procedures the employee knows (items × steps). Optional: without playbooks the employee still works through composed plans and operate mode.
3. **Code** (`src/`): the tools (thin wrappers over your systems), deterministic checks and rules, step handlers for each playbook, and the `PackRuntime` glue (see below).

## The contract: `PackRuntime` (`packages/core/src/kernel.ts`)

| Field | Required | What it does |
|---|---|---|
| `manifest`, `playbooks` | yes | loaded and cross-checked from `pack.yaml` + `playbooks/` by `loadRolePack` |
| `tools` | yes | the tool implementations (`read` / `write` / `irreversible`) |
| `orient(...)` | yes | look around before deciding: list the emails, files, records that exist |
| `today()` | yes | the world's date |
| `handlers`, `params`, `discover` | for playbooks | step code, what a playbook needs to start, how to find its items |
| `verify`, `report` | recommended | independent re-check of the outcome, and the summary |
| `resolveTarget`, `itemSubjects`, `holdCall` | for "hold X" | map words to records and define the protective action |
| `lookup` | optional | "tell me everything about X" and drafting letters from records |
| `apps`, `subjectsIn` | for computer use | the web apps it may open; which records a page is about |

## Steps to add an employee

1. `cp -r packs/_template packs/<your-role>`; set `id`, `name`, `persona`, `tools`, `scope`, `checks`.
2. Write the tools in `src/` (start with read-only ones); declare each in `pack.yaml` with its risk.
3. Write one playbook, or skip them and rely on composed plans / operate mode.
4. Export a factory that returns a `PackRuntime` (copy `packs/vendor-integrity/src/runtime/index.ts`).
5. Register it: one line in `apps/server/src/packs.ts`.
6. Run it: `THESEUS_PACK=<your-role> pnpm agent "..."`; add tests next to the code.

The safety rules do not depend on your prompts: approvals, risk tiers and standing instructions
are enforced in the gateway for every pack.
