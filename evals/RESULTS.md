# Eval results by kind of task

Every row below is a real run of the whole app (real kernel, real tools, real mock-company systems, real browser where
needed) with **Claude subagents playing the model** (no API credits spent, `pnpm live:check --proxy`). The checks look
at the outcome in the systems (what was held, booked, moved, drafted), never at the employee's wording.
A subagent is the same kind of model as the one the app calls in production (Sonnet class), but one run per case is
a sample, not a statistic. Wave = one round of runs after fixes from the round before.

## Summary

| Kind of task | Cases | Result (latest run) | Notes |
|---|---|---|---|
| Refusing out-of-role requests | refuse, refuse-b | 2/2 pass | |
| Whole playbooks (batch check, empanelment) | batch, nudge, empanel, batch-b, empanel-b | 5/5 pass | empanelment includes approvals and the human-gate |
| Part of a playbook | part-gstin, part-gstin-b | 2/2 pass | |
| Unseen tasks with a composed plan (read-only) | composed-emd, composed-dormant, + `-b` | 4/4 pass | |
| Lookups and drafting | lookup, draft, lookup-b, draft-b | 4/4 pass | |
| Computer use: enter an invoice in FinDesk | operate, post, reject, faults, hold, operate-b, operate-c | 7/7 pass | faults = expired session + HTTP 503 on save |
| **Messy document intake** (mixed formats, vision, sort, rename, find what is missing) | intake, intake-wide, intake-rehearse, intake-undo | 4/4 pass after fixes (see below) | the demo that matters |

Counts are from the most recent run of each case. Wave 1 (original 14 cases): 14/14. Wave 2 (10 re-phrased jobs + 4 intake): 10/14.
Intake needed four fix rounds (waves 3 to 6) before all four variants passed in the latest wave.

## Messy intake: what failed first, and what it taught us

| Wave | What happened | Cause | Fix |
|---|---|---|---|
| 2 | 4/4 failed: nothing moved | the request was routed to a read-only "composed plan"; the app's mode choice had no place for "sort and file" | route filing/sorting/mixed-write jobs to operate mode; read the policy first |
| 3 | files sorted correctly (10/10 filed, duplicate and unrelated set aside, pile restored by undo) but drafts, the PAN flag and the verifier failed | the employee's notes (`remember`) were rejected when a quote crossed a line break or a value was in its own words; the verifier re-read files it had moved; the checker ignored drafts saved to the mailbox and was strict about wording | quote/value matching tolerant of JSON line breaks and descriptive values; verifier follows moved files; checker accepts mailbox drafts and wording variants |
| 4 | rehearsal could not finish (writes only returned "previewed") and the verifier could not assert an empty folder | tool result did not say "count this as done, carry on"; no way to expect "empty" | rehearsal result says so; verifier told how to expect an empty list |
| 5 | intake, intake-wide, intake-rehearse pass; intake-undo fails | harness bug: the pre-undo snapshot left out mailbox drafts | fixed in the harness |
| 6 | intake-undo passes | | |

**Honest caveats**
- Waves 5 and 6 passed under a checker that counted a "request to the vendor" from the employee's final message if any draft existed. I
  tightened it afterwards (a real draft must name the vendor and the document). Under the tightened checker the `intake-rehearse`
  run would have failed two of its checks, because that employee skipped drafting for two vendors after seeing in the mailbox that the
  documents had already been emailed, which is a defensible judgement. The tightened checker has only been exercised offline (and by the
  `intake-undo` re-run), not by a fresh wave of all four intake cases.
- The mailbox holds some of the documents the folder lacks (Nandi's cheque, Sri Lakshmi's Udyam certificate). Whether "missing" means
  "missing from the folder" or "not yet received by us at all" is ambiguous even to a careful model; the requests now say "from this folder".
- `intake` only drafted what the policy requires; whether Udyam is needed depends on MSME status that the folder does not show. The checker
  accepts either a "Missing (if MSME)" row or a plain row.
- Single runs of a non-deterministic model: a pass is evidence, not a guarantee. Run `pnpm live:check --set full --retry-failed` on the real
  API to see variance.

## Friction collected from all runs (for prompt and tool improvements)

Confirmed and fixed: quote matching across lines/JSON layout; `null` for optional fields; `mail.search` empty folder; proof wording
("one contiguous quote"); stepIds dependency wording; verifier on moved files and empty results; rehearsal results; duplicate
transcription of the same picture; the plan prompt now says to remember policy rules.

Still open (not fixed, worth doing): route schema requires `tier`/`goal` even when refusing; `remember` capped at 8 per turn (tight for 13-file
jobs); `subgoalDone` cannot be null in the schema (now tolerated); tool descriptions mark `browser.fill_form` and friends "(read)"; a
"composed plan" summary can only mention rows in its table; the report does not name which checks failed for `intake-undo`'s pre-undo gate
(now it does).
