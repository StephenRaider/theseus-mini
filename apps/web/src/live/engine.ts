/**
 * Live engine: the UI's connection to the REAL employees.
 *
 * The desktop app runs the kernel in its own process (apps/server/src/host.ts);
 * this class receives its events through the bridge and folds them into the
 * same AppState the replay produced, so every component works unchanged.
 * Commands go back the same way. Nothing is simulated here: time is real,
 * and the UI changes only when an event arrives.
 *
 * Events arrive in bursts (a batch check emits thousands), so they're queued
 * and applied together a few times a second instead of re-rendering per event.
 */
import type { Command, TheseusEvent } from "@theseus/protocol";
import { alertish } from "../components/ui.tsx";
import type { AgentBridge, AgentInfo, AgentMode, AgentSnapshot } from "../bridge.ts";
import { emptyState, reduceAll, type AppState } from "../state/store.ts";

const FLUSH_MS = 80;

export class LiveEngine {
  readonly kind = "live" as const;
  state: AppState = emptyState();
  info: AgentInfo | null = null;
  error: string | null = null;
  /** True until the first snapshot arrives (or while restarting). */
  connecting = true;
  private lastSeq = -1;
  private queue: TheseusEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private offs: (() => void)[] = [];

  constructor(private readonly agent: AgentBridge) {}

  /**
   * Start listening to the agent. Called from a React effect, so it can run
   * start → dispose → start (React's StrictMode does exactly that in dev).
   * Listeners therefore live between start() and dispose(), never in the
   * constructor, and every start() re-reads the snapshot so nothing that
   * happened in between is missed (sequence numbers drop the overlap).
   */
  start(): void {
    if (this.offs.length) return;
    this.offs.push(this.agent.onEvent((e) => this.enqueue(e)));
    this.offs.push(
      this.agent.onStatus((s) => {
        this.info = s.info;
        this.error = s.error;
        if (s.error) alertish(`Agent: ${s.error}`);
        this.emit();
      }),
    );
    this.offs.push(this.agent.onReset(() => this.clear()));
    void this.agent.init().then((snap) => this.load(snap), (err: Error) => this.fail(err));
  }

  get now(): string {
    return new Date().toISOString();
  }

  get hasStarted(): boolean {
    return Object.keys(this.state.tasks).length > 0;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  send(c: Command): void {
    this.agent.command(c).catch((err: Error) => alertish(err));
  }

  /** Fresh company world; optionally switch live ↔ demo. */
  restart(mode?: AgentMode): void {
    this.clear();
    this.connecting = true;
    this.emit();
    this.agent.restart(mode).then((snap) => this.load(snap), (err: Error) => this.fail(err));
  }

  dispose(): void {
    for (const off of this.offs) off();
    this.offs = [];
  }

  /* ---------------- internals */

  private load(snap: AgentSnapshot) {
    this.info = snap.info;
    this.error = snap.error;
    this.connecting = false;
    for (const e of snap.events) this.enqueue(e);
    this.flush();
  }

  private fail(err: Error) {
    this.connecting = false;
    this.error = err.message;
    alertish(err);
    this.emit();
  }

  private clear() {
    this.state = emptyState();
    this.lastSeq = -1;
    this.queue = [];
    this.emit();
  }

  private enqueue(e: TheseusEvent) {
    this.queue.push(e);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // The snapshot and the live stream can overlap; the log's sequence numbers make it exact.
    const bySeq = new Map<number, TheseusEvent>();
    for (const e of this.queue) if (e.seq > this.lastSeq) bySeq.set(e.seq, e);
    const fresh = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    this.queue = [];
    if (!fresh.length) return;
    this.lastSeq = fresh[fresh.length - 1]!.seq;
    this.state = reduceAll(fresh, this.state);
    this.emit();
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}

export type { AgentInfo };
