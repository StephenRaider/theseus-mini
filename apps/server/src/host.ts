/**
 * Agent host: runs the employees for the desktop app, in their OWN process.
 *
 * Electron's main process forks this file (with tsx) and relays messages:
 *   app → host   { type: "command", command }          (approve, hold, send a message…)
 *   host → app   { type: "ready", info } · { type: "event", event } · { type: "fatal", message }
 * Keeping the kernel out of the window's process means a crash in the agent
 * can't take the app down, and the UI only ever sees events (same protocol
 * as the replay it replaced).
 *
 * Modes: "live" (Gemini, needs GEMINI_API_KEY in .env) or "demo" (scripted
 * model: same kernel, tools, checks and world; only the model's answers are
 * canned, for the known demo requests).
 *
 * It also plays THESEUS, the manager: messages to Theseus are handed to an
 * idle employee (a new one is created if everyone is busy), and Theseus tells
 * you when that work finishes.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Kernel } from "@theseus/core";
import { THESEUS_ID, nextEmployeeName, type Command, type Employee, type TheseusEvent } from "@theseus/protocol";
import { REPO_ROOT, createHarness, modelFromEnv, recorder } from "./harness.ts";
import { scriptedModel } from "./scripted.ts";
import { inProcessWorld } from "./world.ts";

export type HostMode = "live" | "demo";

export interface HostInfo {
  mode: HostMode;
  model: string;
  /** Why this mode was chosen (e.g. "no GEMINI_API_KEY in .env"). */
  note?: string;
  workspaceDir: string;
  today: string;
  /** Example requests the UI can offer as one-click suggestions. */
  suggestions: string[];
}

export const SUGGESTIONS = [
  "Run the integrity check on this week's payment batch",
  "Empanel the three bidders who qualified on T-2026-14",
  "Only check the GSTINs of the T-14 bidders",
  "Confirm the EMD guarantees of the T-2026-14 bidders with the banks",
  "Which vendors haven't been paid in six months?",
];

export class AgentHost {
  private delegated = new Map<string, string>(); // taskId → employee name

  private constructor(
    readonly kernel: Kernel,
    readonly info: HostInfo,
  ) {}

  static async create(opts: { mode?: HostMode; workspaceDir?: string; onEvent: (e: TheseusEvent) => void; stepDelayMs?: number; record?: boolean }): Promise<AgentHost> {
    const envFile = join(REPO_ROOT, ".env");
    if (existsSync(envFile)) process.loadEnvFile(envFile);
    const hasKey = !!process.env.GEMINI_API_KEY?.trim();
    const mode: HostMode = opts.mode ?? (hasKey ? "live" : "demo");
    let note: string | undefined;
    let model;
    if (mode === "live" && hasKey) model = modelFromEnv();
    else {
      model = scriptedModel();
      note = mode === "live" ? "No GEMINI_API_KEY in .env, so running the demo model instead" : undefined;
    }
    const world = await inProcessWorld({ ...(opts.workspaceDir ? { workspaceDir: opts.workspaceDir } : {}) });
    // Flight recorder (.theseus/runs/): off in tests, on in the app.
    const rec = opts.record ? recorder("app") : undefined;
    if (rec) model = rec.trace(model);
    const { kernel } = await createHarness({ world, model, stepDelayMs: opts.stepDelayMs ?? 250, ...(rec ? { log: rec.log } : {}) });
    const info: HostInfo = {
      mode: model.name === "scripted" ? "demo" : "live",
      model: model.name,
      ...(note ? { note } : {}),
      workspaceDir: world.workspaceDir,
      today: world.today,
      suggestions: SUGGESTIONS,
    };
    const host = new AgentHost(kernel, info);

    // Replay what already happened (Employee 1 was created by the harness), then stream.
    for (const e of kernel.log.events) opts.onEvent(e);
    kernel.log.subscribe((e) => {
      opts.onEvent(e);
      host.onEvent(e);
    });
    host.introduceTheseus();
    return host;
  }

  private introduceTheseus() {
    const k = this.kernel;
    const theseus: Employee = { id: THESEUS_ID, kind: "manager", name: "Theseus", allowedTools: [], status: "idle", createdAt: k.log.now };
    k.log.append({ type: "employee.created", payload: theseus }, { actor: "system", employeeId: THESEUS_ID });
    const how =
      this.info.mode === "live"
        ? `I'm running live on ${this.info.model.replace(/^gemini:/, "")}.`
        : `I'm running in demo mode (a scripted model that knows the example requests below; tools, checks and the company systems are real).${this.info.note ? ` ${this.info.note}.` : ""}`;
    k.postMessage(
      THESEUS_ID,
      "theseus",
      `Hi, I'm Theseus. Tell me what you need from the vendor desk and I'll hand it to an employee. You can also message an employee directly, even while they work. ${how}`,
    );
  }

  async command(cmd: Command): Promise<void> {
    if (cmd.type === "send_message" && cmd.threadId === THESEUS_ID) return this.delegate(cmd.text);
    if (cmd.type === "create_employee") {
      const names = [...this.kernel.employees.values()].map((s) => s.employee.name);
      this.kernel.createEmployee({ name: cmd.name ?? nextEmployeeName("numbered", names), ...(cmd.scope ? { scope: cmd.scope } : {}) });
      return;
    }
    return this.kernel.command(cmd);
  }

  /**
   * Theseus is a manager, not a relay. Requests ABOUT the team (hire, who's
   * doing what, give this to Employee 2) are handled by Theseus itself, by
   * rules, with no model call. Everything else is real work and goes to an
   * employee.
   */
  private async delegate(text: string) {
    const k = this.kernel;
    k.postMessage(THESEUS_ID, "user", text);
    const say = (t: string) => k.postMessage(THESEUS_ID, "theseus", t);
    const intent = managerIntent(text, [...k.employees.values()].map((s) => s.employee.name));
    if (intent.kind === "hire") {
      const hired: string[] = [];
      for (let i = 0; i < intent.count; i++) {
        const names = [...k.employees.values()].map((s) => s.employee.name);
        hired.push(k.createEmployee({ name: nextEmployeeName("numbered", [...names, "Theseus"]) }).name);
      }
      const total = k.employees.size;
      say(
        intent.capped
          ? `I've added ${hired.join(", ")} (I add at most ${MAX_HIRE} at a time). You now have ${total} employees.`
          : `Done: ${hired.join(", ")} ${hired.length === 1 ? "has" : "have"} joined. You now have ${total} employees, and the new ${hired.length === 1 ? "one is" : "ones are"} free. Send me work and I'll spread it across whoever is free, or message any of them directly.`,
      );
      return;
    }
    if (intent.kind === "team") return say(this.teamStatus());
    if (intent.kind === "about") {
      return say(
        `I'm the manager. I hand your requests to the employees (whoever is free; I hire one if everyone's busy), keep track of who's doing what, and tell you when work finishes. Ask me things like "hire 2 more employees", "who's working on what?", or "give Employee 2 the GSTIN check". Every employee is a ${k.pack.manifest.name}, so the work itself is vendor and payment integrity.`,
      );
    }
    let st: (typeof k.employees extends Map<string, infer V> ? V : never) | undefined;
    if (intent.kind === "assign") {
      st = [...k.employees.values()].find((s) => s.employee.name.toLowerCase() === intent.employee.toLowerCase());
      if (st && (st.current || st.employee.status !== "idle")) {
        say(`${st.employee.name} is busy with "${st.current?.task.goal ?? st.current?.task.request ?? "a task"}". I've passed your message to them; they'll treat it as a note on their current work. If you meant a new task, say "give it to whoever is free".`);
        await k.send(st.employee.id, intent.text, { from: "theseus" });
        return;
      }
      text = intent.text;
    }
    st ??= [...k.employees.values()].find((s) => !s.current && s.employee.status === "idle");
    if (!st) {
      const names = [...k.employees.values()].map((s) => s.employee.name);
      const e = k.createEmployee({ name: nextEmployeeName("numbered", [...names, "Theseus"]) });
      st = k.employees.get(e.id)!;
    }
    const emp = st.employee;
    k.postMessage(THESEUS_ID, "theseus", `Handing this to ${emp.name}. Open their chat to watch, steer or answer questions.`);
    const before = new Set(k.runs.keys());
    const sent = k.send(emp.id, text, { from: "theseus" });
    const taskId = [...k.runs.keys()].find((id) => !before.has(id));
    if (taskId) this.delegated.set(taskId, emp.name);
    await sent;
  }

  /** "Who's doing what?" from the kernel's state. */
  private teamStatus(): string {
    const k = this.kernel;
    const lines = [...k.employees.values()].map((s) => {
      const e = s.employee;
      if (!s.current) return `• ${e.name}: free`;
      const t = s.current.task;
      const state = e.status === "waiting_on_user" ? "waiting for you" : e.status === "paused" ? "paused" : "working";
      return `• ${e.name}: ${state} on "${t.goal ?? t.request}". ${k.status(t.id)}`;
    });
    const waiting = k.pendingApprovals().length;
    return [`Here's the team:`, ...lines, waiting ? `${waiting} approval${waiting === 1 ? "" : "s"} waiting for you.` : ""].filter(Boolean).join("\n");
  }

  /** Theseus reports back when delegated work ends. */
  private onEvent(e: TheseusEvent) {
    if (e.type !== "task.status_changed") return;
    const name = this.delegated.get(e.payload.taskId);
    if (!name || !["done", "failed", "cancelled"].includes(e.payload.status)) return;
    this.delegated.delete(e.payload.taskId);
    const run = this.kernel.runs.get(e.payload.taskId);
    const last = this.kernel.log
      .ofType("message.posted")
      .filter((m) => m.payload.taskId === e.payload.taskId && m.payload.from.startsWith("employee:"))
      .at(-1)?.payload.text;
    const headline = (last ?? "").split("\n").filter(Boolean).slice(0, 2).join(" ");
    const verb = e.payload.status === "done" ? "finished" : e.payload.status === "failed" ? "couldn't finish" : "stopped";
    this.kernel.postMessage(THESEUS_ID, "theseus", `${name} ${verb} "${run?.task.goal ?? run?.task.request ?? "the task"}". ${headline}`.trim(), e.payload.taskId);
  }
}

/* ------------------------------------------------------------------ child-process entry */

type FromApp = { type: "command"; command: Command };

if (process.send && process.argv[1]?.endsWith("host.ts")) {
  const send = (m: unknown) => process.send?.(m);
  const mode = (process.argv[2] === "live" || process.argv[2] === "demo" ? process.argv[2] : undefined) as HostMode | undefined;
  try {
    const host = await AgentHost.create({
      ...(mode ? { mode } : {}),
      ...(process.env.THESEUS_WORKSPACE ? { workspaceDir: process.env.THESEUS_WORKSPACE } : {}),
      onEvent: (event) => send({ type: "event", event }),
      record: true,
      ...(process.env.THESEUS_STEP_MS ? { stepDelayMs: Number(process.env.THESEUS_STEP_MS) } : {}),
    });
    process.on("message", (m: FromApp) => {
      if (m?.type === "command") host.command(m.command).catch((err: Error) => send({ type: "error", message: err.message }));
    });
    send({ type: "ready", info: host.info });
  } catch (err) {
    send({ type: "fatal", message: (err as Error).message });
    process.exit(1);
  }
  process.on("disconnect", () => process.exit(0));
}

/* ------------------------------------------------------------------ what the manager is being asked */

export const MAX_HIRE = 5;
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, another: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, couple: 2, few: 3 };

export type ManagerIntent =
  | { kind: "hire"; count: number; capped: boolean }
  | { kind: "team" }
  | { kind: "about" }
  | { kind: "assign"; employee: string; text: string }
  | { kind: "work" };

/** Requests about the team itself, recognised by rules (no model call). Anything else is work. */
export function managerIntent(text: string, employeeNames: string[]): ManagerIntent {
  const t = text.toLowerCase().replace(/\s+/g, " ").trim();
  const hire = /\b(?:create|add|hire|make|spin up|bring (?:in|on))\b(?: me)?(?: (\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|another|a couple of|couple of|a few|few))?(?: more| new| extra)* (?:employees?|workers?|agents?|people|staff|hands|assistants?)\b/.exec(t);
  if (hire) {
    const raw = (hire[1] ?? "1").replace(/^a (couple|few)( of)?$/, "$1").replace(/ of$/, "");
    const n = /^\d+$/.test(raw) ? Number(raw) : (NUMBER_WORDS[raw] ?? 1);
    return { kind: "hire", count: Math.max(1, Math.min(n, MAX_HIRE)), capped: n > MAX_HIRE };
  }
  if (/\b(who('?s| is)( everyone)? (working|busy|free|idle|doing)|what('?s| is) (everyone|the team|each (one|employee)) (doing|working on|up to)|team status|status of (the team|everyone|all)|how('?s| is) (everyone|the team) doing|list (my |the )?employees)\b/.test(t)) return { kind: "team" };
  if (/^(what can you do|who are you|what do you do|how do you work|help)\b/.test(t) && !/\b(vendor|payment|batch|tender|gst|bank)\b/.test(t)) return { kind: "about" };
  for (const name of [...employeeNames].sort((a, b) => b.length - a.length)) {
    const n = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m =
      new RegExp(`^(?:ask|tell|have|get|let) ${n}(?: to)?[,:]? (.+)$`).exec(t) ??
      new RegExp(`^(?:give|assign|hand|send) (?:this|it|that)? ?(?:task |job )?to ${n}[,:]? (.+)$`).exec(t) ??
      new RegExp(`^(.+?),? (?:to|for) ${n}\\.?$`).exec(t) ??
      new RegExp(`^${n}[,:] (.+)$`).exec(t);
    if (m) {
      // Keep the user's own casing for the task text.
      const start = t.indexOf(m[1]!);
      return { kind: "assign", employee: name, text: text.replace(/\s+/g, " ").trim().slice(start, start + m[1]!.length) };
    }
  }
  return { kind: "work" };
}
