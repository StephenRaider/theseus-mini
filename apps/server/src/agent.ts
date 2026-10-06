/**
 * Headless runner: give an employee a task from the terminal and supervise it.
 *
 *   pnpm agent "Run the integrity check on this week's payment batch"
 *   pnpm agent --scripted "Empanel the T-2026-14 bidders"      (no API key needed)
 *
 * Options
 *   --scripted          use the scripted stand-in model (known demo requests only)
 *   --live-world        use the running `pnpm kaveri` instead of a fresh in-process world
 *   --approve all|none  decide every approval automatically (default: ask you)
 *   --cache             reuse identical model answers from .theseus/model-cache (saves quota)
 *   --log FILE          also write every event as JSON lines
 *   --pace MS           pause MS after every step so you can follow along and interrupt
 *
 * While it runs, type a message and press Enter to talk to the employee
 * (e.g. "hold everything to Shree Ganesh", "skip PL-07", "how far are you?").
 * Commands: approve <id> | reject <id> | answer <q_id> <text> | status | quit
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { EventLog } from "@theseus/core";
import { REPO_ROOT, createHarness, modelFromEnv } from "./harness.ts";
import { attachPrinter } from "./printer.ts";
import { scriptedModel } from "./scripted.ts";
import { inProcessWorld, liveWorld } from "./world.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const VALUE_OPTS = new Set(["--approve", "--log", "--pace"]);
const request = args.filter((a, i) => !a.startsWith("--") && !VALUE_OPTS.has(args[i - 1] ?? "")).join(" ").trim();

if (!request) {
  console.log('Usage: pnpm agent [--scripted] [--live-world] [--approve all|none] [--cache] "your request"');
  process.exit(1);
}

const envFile = join(REPO_ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const world = flag("live-world") ? liveWorld() : await inProcessWorld();
const model = flag("scripted") ? scriptedModel() : modelFromEnv({ cache: flag("cache") });
const logFile = opt("log");
const log = new EventLog(logFile ? { file: logFile } : {});
const { kernel, employee } = await createHarness({ world, model, log, stepDelayMs: Number(opt("pace") ?? 0) });
attachPrinter(kernel);

const auto = opt("approve");
console.log(`\x1b[2mWorld: ${world.mode} · workspace: ${world.workspaceDir} · model: ${model.name}\x1b[0m`);
console.log(`\x1b[2mType a message to talk to ${employee.name} while it works; "approve <id>", "reject <id>", "status", "quit".\x1b[0m\n`);

if (auto) {
  kernel.log.subscribe((e) => {
    if (e.type === "approval.requested") setTimeout(() => void kernel.command({ type: "resolve_approval", approvalId: e.payload.id, decision: auto === "none" ? "rejected" : "approved" }), 0);
  });
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (raw) => {
  const line = raw.trim();
  if (!line) return;
  const [cmd, id, ...rest] = line.split(/\s+/);
  if (cmd === "quit" || cmd === "exit") process.exit(0);
  if (cmd === "status") {
    const run = [...kernel.runs.values()].pop();
    console.log(run ? kernel.status(run.task.id) : "No task yet.");
    return;
  }
  if ((cmd === "approve" || cmd === "reject") && id) {
    const ids = id === "all" ? kernel.pendingApprovals().map((a) => a.id) : [id];
    for (const a of ids) void kernel.command({ type: "resolve_approval", approvalId: a, decision: cmd === "approve" ? "approved" : "rejected" });
    return;
  }
  if (cmd === "answer" && id && rest.length) return void kernel.command({ type: "answer_question", questionId: id, answer: rest.join(" ") });
  void kernel.send(employee.id, line);
});

let stdinClosed = false;
rl.on("close", () => (stdinClosed = true));

await kernel.send(employee.id, request);

// Exit once the work is finished and nothing waits for you.
const timer = setInterval(async () => {
  await kernel.settled();
  const busyTask = [...kernel.runs.values()].some((r) => !["done", "failed", "cancelled"].includes(r.task.status));
  const waitingOnYou = kernel.pendingApprovals().length > 0;
  if (waitingOnYou && stdinClosed) {
    clearInterval(timer);
    console.log(`\nStill waiting for you on: ${kernel.pendingApprovals().map((a) => `${a.id} (${a.title})`).join("; ")}. Run interactively (or with --approve all) to decide.`);
    process.exit(0);
  }
  if (!busyTask && !waitingOnYou) {
    clearInterval(timer);
    const calls = kernel.log.ofType("model.called");
    console.log(`\n\x1b[2mModel calls this run: ${calls.length} (${calls.filter((c) => c.payload.cached).length} cached). Events: ${kernel.log.events.length}.\x1b[0m`);
    process.exit(0);
  }
}, 500);
