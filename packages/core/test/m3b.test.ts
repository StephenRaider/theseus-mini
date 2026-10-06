import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  EventLog,
  GeminiAdapter,
  IdMaker,
  ModelError,
  RateLimiter,
  ScriptedModel,
  ToolFailure,
  ToolGateway,
  evalCondition,
  generateJson,
  getPath,
  interpolate,
  matchesItem,
  triageByRules,
  unsupportedClaims,
  validateProgram,
  type Tool,
} from "../src/index.ts";

/* ------------------------------------------------------------------ gateway */

function gw(tools: Tool[]) {
  const log = new EventLog();
  return { log, g: new ToolGateway({ log, ids: new IdMaker(), tools, sleep: async () => {} }) };
}

const writeTool = (name: string, extra: Partial<Tool> = {}): Tool<{ id: string }> => ({
  name,
  description: "",
  risk: "write",
  idempotent: false,
  input: z.object({ id: z.string() }),
  subjects: ({ id }) => [`vendor:${id}`],
  run: async ({ id }) => ({ id, n: Math.random() }),
  ...extra,
});

describe("tool gateway", () => {
  it("refuses irreversible calls without a human approval", async () => {
    const { g } = gw([writeTool("x.activate", { risk: "irreversible" })]);
    const r = await g.call("x.activate", { id: "V-1" }, { employeeId: "e" });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.class).toBe("policy_violation");
    const ok = await g.call("x.activate", { id: "V-1" }, { employeeId: "e", approval: { approvalId: "apr_1", decidedBy: "user:you" } });
    expect(ok.ok).toBe(true);
    const agent = await g.call("x.activate", { id: "V-1" }, { employeeId: "e", approval: { approvalId: "apr_1", decidedBy: "employee:e" } });
    expect(agent.ok).toBe(false);
  });

  it("standing constraints block writes on protected subjects, but never protective holds", async () => {
    const { g } = gw([writeTool("x.pay"), writeTool("x.hold", { protective: true })]);
    g.addConstraint({ id: "c1", employeeId: "e", text: "don't pay V-1", subjects: ["vendor:V-1"], itemIds: [], blocks: "writes" });
    const blocked = await g.call("x.pay", { id: "V-1" }, { employeeId: "e" });
    expect(!blocked.ok && blocked.blockedBy?.id).toBe("c1");
    expect((await g.call("x.pay", { id: "V-2" }, { employeeId: "e" })).ok).toBe(true);
    expect((await g.call("x.hold", { id: "V-1" }, { employeeId: "e" })).ok).toBe(true);
    // Another employee isn't bound by my instruction to this employee.
    expect((await g.call("x.pay", { id: "V-1" }, { employeeId: "other" })).ok).toBe(true);
  });

  it("idempotency: the same write under the same key is not repeated", async () => {
    let runs = 0;
    const { g } = gw([writeTool("x.pay", { run: async () => ++runs })]);
    const a = await g.call("x.pay", { id: "V-1" }, { employeeId: "e", idempotencyKey: "k1" });
    const b = await g.call("x.pay", { id: "V-1" }, { employeeId: "e", idempotencyKey: "k1" });
    expect(runs).toBe(1);
    expect(b.ok && b.replayed).toBe(true);
    expect(a.ok && b.ok && a.data === b.data).toBe(true);
  });

  it("retries transient failures, classifies the rest, validates input", async () => {
    let n = 0;
    const flaky: Tool<{ id: string }> = {
      ...writeTool("x.read"),
      risk: "read",
      run: async () => {
        if (++n < 3) throw new ToolFailure("transient", "timeout");
        return "ok";
      },
    };
    const retries: number[] = [];
    const { g } = gw([flaky, writeTool("x.nf", { run: async () => Promise.reject(new ToolFailure("not_found", "nope")) })]);
    const r = await g.call("x.read", { id: "a" }, { employeeId: "e", onRetry: (a) => retries.push(a) });
    expect(r.ok).toBe(true);
    expect(retries).toEqual([1, 2]);
    const nf = await g.call("x.nf", { id: "a" }, { employeeId: "e" });
    expect(!nf.ok && nf.error.class).toBe("not_found");
    const bad = await g.call("x.read", { id: 5 }, { employeeId: "e" });
    expect(!bad.ok && bad.error.class).toBe("validation");
    const unknown = await g.call("rm.rf", {}, { employeeId: "e" });
    expect(!unknown.ok && unknown.error.class).toBe("policy_violation");
  });
});

/* ------------------------------------------------------------------ composed programs */

describe("composed programs (tier 3)", () => {
  const scope = { item: { id: "V-1", until: "2026-10-20" }, steps: { paid: { bills: [{ paidOn: "2026-01-02" }, { paidOn: "2026-03-05" }] }, verify: { confirmed: false } } };
  it("paths, aggregates and templates", () => {
    expect(getPath(scope, "steps.paid.bills[].paidOn")).toEqual(["2026-01-02", "2026-03-05"]);
    expect(interpolate("{{item.id}}", scope)).toBe("V-1");
    expect(interpolate("Vendor {{item.id}} ok", scope)).toBe("Vendor V-1 ok");
    expect(interpolate("{{steps.verify.confirmed}}", scope)).toBe(false);
  });
  it("conditions, including dates relative to the world's today", () => {
    const today = "2026-10-07";
    expect(evalCondition({ path: "steps.verify.confirmed", op: "eq", value: "false" }, scope, today)).toBe(true);
    expect(evalCondition({ path: "steps.paid.bills[].paidOn", agg: "max", op: "days_ago_gt", value: "180" }, scope, today)).toBe(true);
    expect(evalCondition({ path: "steps.paid.bills[].paidOn", agg: "count", op: "gte", value: "2" }, scope, today)).toBe(true);
    expect(evalCondition({ path: "item.until", op: "days_until_lt", value: "30" }, scope, today)).toBe(true);
    expect(evalCondition({ path: "item.missing", op: "days_ago_gt", value: "1" }, scope, today)).toBe(true); // never = long ago
  });
  it("rejects programs that use unknown or irreversible tools", () => {
    const tools = new Map([
      ["a.list", { risk: "read" }],
      ["a.pay", { risk: "irreversible" }],
    ]);
    const reg = { has: (n: string) => tools.has(n), get: (n: string) => tools.get(n) };
    const problems = validateProgram(
      {
        title: "t",
        itemKind: "x",
        items: { tool: "a.list", args: {}, listPath: "", idPath: "id", labelTemplate: "{{item.id}}" },
        steps: [
          { id: "pay", title: "Pay", tool: "a.pay", args: {} },
          { id: "Bad-Id", title: "x", tool: "nope", args: {} },
        ],
        columns: [],
      },
      reg,
    );
    expect(problems.join(" ")).toMatch(/irreversible/);
    expect(problems.join(" ")).toMatch(/unknown tool "nope"/);
    expect(problems.join(" ")).toMatch(/snake_case/);
  });
});

/* ------------------------------------------------------------------ conversation lane */

describe("triage rules (no model needed for the common cases)", () => {
  const t = (s: string, open = 0) => triageByRules(s, { openQuestions: open });
  it("steers", () => {
    expect(t("Hold everything to Shree Ganesh Constructions, it's under dispute.")).toMatchObject({ kind: "steer", action: "hold", target: "Shree Ganesh Constructions" });
    expect(t("don't pay Deccan Quarry")).toMatchObject({ kind: "steer", action: "hold", target: "Deccan Quarry" });
    expect(t("skip bidder B")).toMatchObject({ kind: "steer", action: "skip", target: "bidder B" });
    expect(t("do Tunga Electricals first")).toMatchObject({ kind: "steer", action: "prioritise", target: "Tunga Electricals" });
    expect(t("release PL-07")).toMatchObject({ kind: "steer", action: "release", target: "PL-07" });
  });
  it("control, questions, answers", () => {
    expect(t("pause")?.kind).toBe("pause");
    expect(t("hold on")?.kind).toBe("pause");
    expect(t("carry on")?.kind).toBe("resume");
    expect(t("cancel this")?.kind).toBe("stop");
    expect(t("stop paying Malnad")).toMatchObject({ kind: "steer", action: "hold" });
    expect(t("why is PL-03 held?")?.kind).toBe("question");
    expect(t("PB-2026-W41", 1)?.kind).toBe("info");
    expect(t("PB-2026-W41", 0)).toBeNull(); // → model
  });
  it("matches items by name, id or ref token", () => {
    const it1 = { id: "B", label: "Vrishabha Earthmovers", ref: "T-2026-14#B", held: false };
    expect(matchesItem(it1, "B")).toBe(true);
    expect(matchesItem(it1, "vrishabha")).toBe(true);
    expect(matchesItem(it1, "Nandi")).toBe(false);
  });
});

/* ------------------------------------------------------------------ models */

describe("model plumbing", () => {
  it("generateJson repairs one bad reply, then validates", async () => {
    const m = new ScriptedModel([
      { purpose: "p", reply: "not json at all", times: 1 },
      { purpose: "p", reply: "```json\n{\"n\": 3}\n```" },
    ]);
    const out = await generateJson((r) => m.generate(r), { purpose: "p", system: "s", prompt: "q" }, z.object({ n: z.number() }));
    expect(out).toEqual({ n: 3 });
    expect(m.calls[1]!.prompt).toContain("PREVIOUS REPLY WAS INVALID");
    expect(m.calls[0]!.jsonSchema).toMatchObject({ type: "object" });
  });

  it("rate limiter spaces calls and stops at the daily budget", async () => {
    let now = Date.parse("2026-10-07T10:00:00Z");
    const waits: number[] = [];
    const rl = new RateLimiter({ rpm: 15, rpd: 2 }, { now: () => now, sleep: async (ms) => void waits.push(ms) });
    await rl.acquire();
    await rl.acquire();
    expect(waits[0]).toBeGreaterThanOrEqual(4000);
    now += 10_000;
    await expect(rl.acquire()).rejects.toMatchObject({ kind: "quota" });
  });

  it("Gemini adapter: request shape, thought parts skipped, 429 retried with the server's delay, bad key reported", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const replies = [
      new Response(JSON.stringify({ error: { code: 429, message: "Resource exhausted", details: [{ retryDelay: "2s" }] } }), { status: 429 }),
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "thinking…", thought: true }, { text: '{"ok":true}' }] } }] }), { status: 200 }),
    ];
    const slept: number[] = [];
    const g = new GeminiAdapter({
      apiKey: "test-key",
      model: "gemini-3.5-flash-lite",
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return replies.shift()!;
      }) as unknown as typeof fetch,
      sleep: async (ms) => void slept.push(ms),
    });
    const res = await g.generate({ purpose: "route", system: "sys", prompt: "hi", jsonSchema: { type: "object" }, thinking: "low" });
    expect(res.text).toBe('{"ok":true}');
    expect(slept).toEqual([2000]);
    expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent");
    expect(calls[0]!.url).not.toContain("test-key");
    expect((calls[0]!.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.generationConfig).toEqual({ responseMimeType: "application/json", responseJsonSchema: { type: "object" }, thinkingConfig: { thinkingLevel: "low" } });
    expect(body.generationConfig.temperature).toBeUndefined();

    const bad = new GeminiAdapter({ apiKey: "x", model: "m", fetch: (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch });
    await expect(bad.generate({ purpose: "p", system: "s", prompt: "p" })).rejects.toMatchObject({ kind: "auth" });
    expect(() => new GeminiAdapter({ apiKey: "", model: "m" })).toThrow(ModelError);
  });

  it("evidence-bound summaries: ids and numbers must appear in the results", () => {
    const facts = JSON.stringify([{ id: "PBG/SBI/2026/40917", amount: 980000 }]);
    expect(unsupportedClaims("Guarantee PBG/SBI/2026/40917 for 9,80,000 failed", facts)).toEqual([]);
    expect(unsupportedClaims("Guarantee PBG/HDFC/2026/11111 failed", facts)).toEqual(["PBG/HDFC/2026/11111"]);
  });
});
