import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { THESEUS_ID, type Command, type TheseusEvent } from "@theseus/protocol";
import { AgentHost } from "@theseus/server/host";
import { describe, expect, it } from "vitest";
import type { AgentBridge, AgentSnapshot } from "../src/bridge.ts";
import { LiveEngine } from "../src/live/engine.ts";
import { badges, sidebarPreview } from "../src/state/selectors.ts";

/** The UI's live engine wired to a real agent host through a fake bridge (what Electron does with IPC). */
async function wire() {
  const listeners = new Set<(e: TheseusEvent) => void>();
  const events: TheseusEvent[] = [];
  const host = await AgentHost.create({
    mode: "demo",
    workspaceDir: await mkdtemp(join(tmpdir(), "theseus-ui-")),
    stepDelayMs: 0,
    onEvent: (e) => {
      events.push(e);
      for (const l of listeners) l(e);
    },
  });
  const bridge: AgentBridge = {
    // The snapshot overlaps with events that also arrive on the stream: the engine must not double them.
    init: async (): Promise<AgentSnapshot> => ({ info: host.info, error: null, events: [...events] }),
    command: async (c: Command) => host.command(c),
    restart: async () => ({ info: host.info, error: null, events: [] }),
    onEvent: (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    onStatus: () => () => {},
    onReset: () => () => {},
    frames: async () => [],
    onFrame: () => () => {},
  };
  const engine = new LiveEngine(bridge);
  engine.start();
  const flushed = () => new Promise((r) => setTimeout(r, 150));
  return { host, engine, flushed };
}

describe("live engine (UI ↔ real employees)", () => {
  it("folds the snapshot and the stream into one state, without duplicates", async () => {
    const { engine, host, flushed } = await wire();
    for (const e of host.kernel.log.events.slice(0, 3)) (engine as unknown as { enqueue(e: TheseusEvent): void }).enqueue(e); // overlap
    await flushed();
    expect(engine.info?.mode).toBe("demo");
    expect(engine.state.employeeOrder.filter((id) => id === THESEUS_ID)).toHaveLength(1);
    expect(engine.state.messages[THESEUS_ID]).toHaveLength(1);
  });

  it("a request to Theseus shows up as delegated work, with approvals and questions in the badges", async () => {
    const { engine, host, flushed } = await wire();
    await flushed();
    engine.send({ type: "send_message", threadId: THESEUS_ID, text: "Empanel the three bidders who qualified on T-2026-14", attachments: [] });
    await new Promise((r) => setTimeout(r, 50));
    await host.kernel.settled();
    await flushed();
    const s = engine.state;
    expect(s.employees.emp_1?.status).toBe("waiting_on_user");
    expect(badges(s, "emp_1", 0).needsYou).toBe(3); // 3 approvals (activate A, email B, conflict C)
    expect(sidebarPreview(s, "emp_1", engine.now).kind).toBe("waiting");
    expect(Object.values(s.questions).some((q) => !q.blocking && q.default === "yes")).toBe(true);
    expect(Object.values(s.orients)[0]?.found.length).toBeGreaterThan(0);
    // Approve from the UI → the real ERP activates the vendor.
    const apr = Object.values(s.approvals).find((a) => a.title.startsWith("Activate"))!;
    engine.send({ type: "resolve_approval", approvalId: apr.id, decision: "approved" });
    await new Promise((r) => setTimeout(r, 50));
    await host.kernel.settled();
    await flushed();
    expect(engine.state.approvals[apr.id]?.status).toBe("approved");
  });

  it("keeps receiving events after React's dev double-mount (start → dispose → start)", async () => {
    // The bug Jyotiraditya hit: in `pnpm app` (dev, StrictMode) the engine stopped listening,
    // so sent messages vanished and nothing ever appeared.
    const { engine, host, flushed } = await wire();
    engine.dispose();
    engine.start();
    await flushed();
    engine.send({ type: "send_message", threadId: THESEUS_ID, text: "Run the integrity check on this week's payment batch", attachments: [] });
    await new Promise((r) => setTimeout(r, 50));
    await host.kernel.settled();
    await flushed();
    expect(engine.state.messages[THESEUS_ID]?.some((m) => m.text.includes("integrity check"))).toBe(true);
    expect(Object.values(engine.state.tasks).some((t) => t.status === "done")).toBe(true);
  });
});
