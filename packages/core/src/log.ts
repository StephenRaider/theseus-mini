import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Actor, EventBody, TheseusEvent } from "@theseus/protocol";

/**
 * The append-only event log: the single source of truth (Framework Spec §6).
 * Everything the kernel does becomes an event here; the UI, replays, evals
 * and (from M4) crash-proof resume are all derived from it.
 *
 * Optional `file`: every event is also appended as one JSON line, so a run
 * can be inspected or replayed later.
 */
export interface LogMeta {
  actor: Actor;
  employeeId?: string;
  taskId?: string;
}

export type Clock = () => string;
export const systemClock: Clock = () => new Date().toISOString();

export class EventLog {
  readonly events: TheseusEvent[] = [];
  private listeners = new Set<(e: TheseusEvent) => void>();
  private seq = 0;

  constructor(private readonly opts: { clock?: Clock; file?: string } = {}) {
    if (opts.file) mkdirSync(dirname(opts.file), { recursive: true });
  }

  get now(): string {
    return (this.opts.clock ?? systemClock)();
  }

  append(body: EventBody, meta: LogMeta): TheseusEvent {
    const e = {
      id: `evt_${String(this.seq + 1).padStart(5, "0")}`,
      seq: this.seq++,
      ts: this.now,
      actor: meta.actor,
      ...(meta.employeeId ? { employeeId: meta.employeeId } : {}),
      ...(meta.taskId ? { taskId: meta.taskId } : {}),
      ...body,
    } as TheseusEvent;
    this.events.push(e);
    if (this.opts.file) appendFileSync(this.opts.file, `${JSON.stringify(e)}\n`);
    for (const fn of this.listeners) fn(e);
    return e;
  }

  subscribe(fn: (e: TheseusEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** All events of one type, narrowed. */
  ofType<T extends TheseusEvent["type"]>(type: T): Extract<TheseusEvent, { type: T }>[] {
    return this.events.filter((e) => e.type === type) as Extract<TheseusEvent, { type: T }>[];
  }
}

/** Readable, prefixed, per-run ids: task_001, apr_003, q_002… */
export class IdMaker {
  private counters = new Map<string, number>();
  next(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}_${String(n).padStart(3, "0")}`;
  }
}
