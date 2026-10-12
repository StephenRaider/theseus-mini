# Live check suite (real Claude, real browser)

Runs real scenarios against a real model and checks the **outcome in the mock company's systems**
(what was held, what was booked, what the verifier concluded), never the employee's wording. It
prints a pass/fail report with the cost of every case, and stops at a spend cap so the credits last.

```
pnpm live:ping                       one tiny call: is the key set up right? (a fraction of a cent)
pnpm live:check --list               the cases and their cost estimates
pnpm live:check                      smoke set  (refuse · batch · operate)      about $0.35
pnpm live:check --set standard       the whole demo (11 cases)                  about $1
pnpm live:check --set full           + faults, rejection, the hold gate (14)    about $2
pnpm live:check --cases operate      one or more cases by id (comma separated)
pnpm live:check --headed --slowmo 300   watch the employee's browser work
pnpm live:check --budget 1.5         stop starting new cases once this run has cost $1.50
pnpm live:check --retry-failed       run each failed case once more (flaky vs consistent)
pnpm live:check --scripted           no key: the offline stand-in model (checks the suite itself, free)
```

A failing case never stops the run: every case is attempted, so the report shows all successes and all failures.
Saved in `.theseus/live-check/`: the report (`.txt`, `.json`), **every prompt and reply of every model call grouped by case**
(`.model.jsonl`), and the full event log of each failed case (a folder named like the report). These contain no API key.

Estimates are deliberately conservative (measured: an operate step is ~3.7k tokens, ~2.7k of it cached
after the first step). Reports are saved to `.theseus/live-check/<time>.txt` and `.json`.

## Where the API key goes (on your PC)

1. In the project folder (the one that contains `package.json`, e.g. `D:\Theseus Mini Project`), copy the template:
   `Copy-Item .env.example .env`
2. Open `.env` in Notepad and set these lines (no quotes, no spaces around `=`):
   ```
   ANTHROPIC_API_KEY=sk-ant-...your key...
   MODEL_PROVIDER=anthropic
   ANTHROPIC_BUDGET_USD=12
   ```
   Get the key at console.anthropic.com → API keys. `ANTHROPIC_BUDGET_USD` is the hard cap for the whole project:
   every call is metered (`.theseus/anthropic-spend.json`) and calls stop at the cap. Leave `GEMINI_API_KEY` as it is.
3. `.env` is git-ignored: it never leaves your PC. Never paste the key into a chat, an issue or a commit.
4. Check it: `pnpm live:ping` should print `Provider: anthropic · model: anthropic:claude-sonnet-5-5` and `OK: the model answered {"ok":true,"word":"ready"}`.
5. The desktop app reads the same `.env` (restart the app after editing it).

How Claude is used (to keep the $20 going far): Sonnet 5.5 for judgement calls, Haiku 5.5 for triage and
summaries, low reasoning effort, prompt caching on the stable part of every prompt, and a spend cap.
Switch models with `ANTHROPIC_MODEL` / `ANTHROPIC_MODEL_SMALL` in `.env`.

## Reading a report

```
PASS  batch   Whole playbook: integrity check of the 65-line payment batch
      2 model calls · 9034 tokens · $0.021 · 14s · route tier 1
      ✓ Held exactly the four bad lines (bank change, duplicate, inactive, debarred)
      ...
FAIL  composed-emd ...
      ✗ It flagged the fake guarantee (Sri Lakshmi Buildcon) and nothing else  [flagged: ]
      employee said: ...
```

A `✗` names what is wrong in the systems, in brackets. `route tier` shows how the employee chose to handle it
(1 = a whole playbook, 2 = part of one, 3 = a plan it composed itself). A failure on a live model is information,
not necessarily a bug: report it with the case id and the "employee said" text.

## Instructions for Antigravity (copy and paste)

> You are setting up and testing Theseus Mini on this Windows PC. Work in the project folder
> (`D:\Theseus Mini Project`, or wherever the repo lives). Do NOT print, echo, log or commit the contents of `.env`
> or any API key. Never force-push. If a command fails, show me the exact error and stop; do not improvise fixes
> that change source code unless I ask.
>
> **Stage A: get the code and build it**
> 1. `git status` must be clean (if not, `git stash` and tell me).
> 2. `git fetch origin`, then `git checkout claude/cloud-session-credits-d0s27a` and `git pull origin claude/cloud-session-credits-d0s27a`.
> 3. `node -v` must be 22 or higher (24 recommended, see `.nvmrc`). `corepack enable`, then `pnpm -v` must be 10.x.
> 4. `pnpm install`, then `pnpm browser:install` (downloads Chromium, about 150 MB, once).
> 5. `pnpm check`. Expect all tests to pass (about 190). Report the final "Tests N passed" line. If anything fails, stop here.
>
> **Stage B: the desktop app (no API key needed)**
> 6. Bundle it: `pnpm --filter @theseus/desktop build`. (A packaged installer does not exist yet.)
> 7. Automated window check: `$env:THESEUS_SMOKE="1"; $env:THESEUS_MODE="demo"; pnpm app:prod` should end with `[smoke] OK`. (Optional: add `$env:THESEUS_SMOKE_REQUEST="Find the latest invoice from Hoysala Steel, extract the amount and due date, enter it into FinDesk and tell me once it's done"` and `$env:THESEUS_SMOKE_SHOTS="shots"` to run the browser example and save screenshots of the three views, including the Screen tab.)
> 8. Then start it for me to use: `pnpm app`. Tell me it opened (Employee 1, Theseus, three columns).
>
> **Stage C: I have added my API key (do this only after I say so)**
> 9. Check the key is present WITHOUT printing it: `Select-String -Path .env -Pattern '^ANTHROPIC_API_KEY=.+' -Quiet` (must be True) and that `.env` contains `MODEL_PROVIDER=anthropic`.
> 10. `pnpm live:ping`. It must print `OK`. If it prints an auth or credit error, stop and show it.
> 11. Smoke set, hidden browser: `pnpm live:check`. Then smoke set with the browser visible so I can watch: `pnpm live:check --cases operate --headed --slowmo 300`.
> 12. Only if the smoke set passed and the running total is under $2: `pnpm live:check --set standard --budget 1.5`.
> 13. Only if I ask: `pnpm live:check --set full --budget 2.5`.
> 14. The desktop app on Claude: `$env:THESEUS_MODE="live"; pnpm app`. In Theseus's chat click the first example request ("Find the latest invoice from Hoysala Steel…"), open Employee 1, and watch the Plan tab and the Screen tab. Tell me what you see.
>
> **After every stage, report:** the exact commands you ran, pass/fail per case, the saved report path
> (`.theseus/live-check/…txt`), the line `Claude total $X of $Y cap`, and for any failed case the `✗` lines and the
> "employee said" text, verbatim. Never run any live stage a second time without telling me what it will cost.
> Stop immediately if a message says the Claude budget was reached.
