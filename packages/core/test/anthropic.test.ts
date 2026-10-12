import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AnthropicAdapter, ModelError, SpendMeter, costOf, generateJson, type AnthropicLike, type AnthropicReply } from "../src/index.ts";

const reply = (over: Partial<AnthropicReply> = {}): AnthropicReply => ({
  content: [{ type: "text", text: '{"ok":true}' }],
  stop_reason: "end_turn",
  usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  ...over,
});

function fake(...replies: (AnthropicReply | Error)[]) {
  const calls: Record<string, unknown>[] = [];
  const client: AnthropicLike = {
    beta: {
      messages: {
        async create(body) {
          calls.push(body);
          const r = replies.shift() ?? reply();
          if (r instanceof Error) throw r;
          return r;
        },
      },
    },
  };
  return { client, calls };
}
const req = { purpose: "operate.step", system: "You are Employee 1.", prompt: "STABLE PART|VOLATILE PART", thinking: "low" as const, cacheSplit: 12 };

describe("cost maths (what the $20 is spent on)", () => {
  it("prices cache writes at 1.25x and cache reads at 0.1x of input", () => {
    // Sonnet 5.5: $2 in / $10 out per MTok
    expect(costOf("claude-sonnet-5-5", { input_tokens: 1_000_000, output_tokens: 0 })).toBeCloseTo(2);
    expect(costOf("claude-sonnet-5-5", { input_tokens: 0, output_tokens: 1_000_000 })).toBeCloseTo(10);
    expect(costOf("claude-sonnet-5-5", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 })).toBeCloseTo(2.5);
    expect(costOf("claude-sonnet-5-5", { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.2);
    expect(costOf("claude-haiku-5-5", { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBeCloseTo(0.6);
  });
  it("never under-counts a model it doesn't know", () => {
    expect(costOf("claude-future-9", { input_tokens: 1_000_000, output_tokens: 0 })).toBe(10);
  });
});

describe("spend meter: a hard cap that survives restarts", () => {
  it("stops calls at the cap, with a message that says how to continue", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "spend-")), "s.json");
    const m = new SpendMeter(0.01, file);
    m.check();
    m.add("claude-sonnet-5-5", { input_tokens: 1_000_000, output_tokens: 0 }); // $2
    expect(() => m.check()).toThrow(/Claude budget reached: \$2\.00 spent of the \$0\.01 cap/);
    // A new process picks up where the last one stopped.
    const again = new SpendMeter(0.01, file);
    expect(again.spent).toBeCloseTo(2);
    expect(() => again.check()).toThrow(ModelError);
    expect(JSON.parse(await readFile(file, "utf8")).byModel["claude-sonnet-5-5"].calls).toBe(1);
  });
});

describe("Claude adapter", () => {
  it("sends the right request: tiering, low effort, JSON schema in the system prompt, cache breakpoint at the split", async () => {
    const { client, calls } = fake(reply({ content: [{ type: "text", text: '{"a":1}' }] }), reply());
    const a = new AnthropicAdapter({ client, meter: new SpendMeter(5) });
    await a.generate({ ...req, jsonSchema: { type: "object" } });
    const b = calls[0]!;
    expect(b.model).toBe("claude-sonnet-5-5");
    expect(b.output_config).toEqual({ effort: "low" });
    expect(b).not.toHaveProperty("temperature");
    expect((b.system as { text: string }[])[0]!.text).toBe('You are Employee 1.\n\nReply with ONE JSON object only (no prose, no code fences) that matches this JSON Schema:\n{"type":"object"}');
    expect((b.messages as { content: unknown[] }[])[0]!.content).toEqual([
      { type: "text", text: "STABLE PART|", cache_control: { type: "ephemeral" } },
      { type: "text", text: "VOLATILE PART" },
    ]);
    // Cheap mechanical calls go to the small model; mid/high thinking maps to effort.
    await a.generate({ purpose: "triage", system: "s", prompt: "p", thinking: "medium" });
    expect(calls[1]!.model).toBe("claude-haiku-5-5");
    expect(calls[1]!.output_config).toEqual({ effort: "medium" });
    expect(JSON.stringify(calls[1]!.messages)).not.toContain("cache_control"); // no split → plain
  });

  it("asks for the server-side refusal fallback on Sonnet only, and drops it for good if the API rejects it", async () => {
    const reject = new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "unknown beta: server-side-fallback" } }, "unknown beta", new Headers());
    const { client, calls } = fake(reject, reply(), reply());
    const a = new AnthropicAdapter({ client, meter: new SpendMeter(5) });
    expect(a.body(req)).toMatchObject({ betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" });
    expect(a.body({ ...req, purpose: "summary" })).not.toHaveProperty("fallbacks"); // Haiku: no server-side fallback
    const out = await a.generate(req);
    expect(out.text).toBe('{"ok":true}');
    expect(calls).toHaveLength(2);
    expect(calls[1]).not.toHaveProperty("fallbacks");
    await a.generate(req);
    expect(calls[2]).not.toHaveProperty("fallbacks"); // stays off
  });

  it("meters every call and reports cost, tokens and cache reads", async () => {
    const meter = new SpendMeter(5);
    const { client } = fake(reply({ usage: { input_tokens: 100, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 4000 } }));
    const res = await new AnthropicAdapter({ client, meter }).generate(req);
    // 100×$2 + 4000×$0.2 + 500×$10 per MTok = 0.0002 + 0.0008 + 0.005
    expect(res.usage?.costUsd).toBeCloseTo(0.006);
    expect(res.usage).toMatchObject({ inputTokens: 4100, outputTokens: 500, cacheReadTokens: 4000 });
    expect(meter.spent).toBeCloseTo(0.006);
    expect(meter.totals.cacheReadTokens).toBe(4000);
  });

  it("refuses to call once the cap is spent (no request goes out)", async () => {
    const meter = new SpendMeter(0.001);
    meter.add("claude-sonnet-5-5", { input_tokens: 10_000, output_tokens: 0 });
    const { client, calls } = fake();
    await expect(new AnthropicAdapter({ client, meter }).generate(req)).rejects.toMatchObject({ kind: "quota" });
    expect(calls).toHaveLength(0);
  });

  it("maps failures to the kernel's error kinds", async () => {
    const mk = (status: number, message: string) => Anthropic.APIError.generate(status, { type: "error", error: { type: "x", message } }, message, new Headers({ "retry-after": "7" }));
    const kinds: [Error, string][] = [
      [mk(401, "bad key"), "auth"],
      [mk(429, "slow down"), "rate_limited"],
      [mk(400, "Your credit balance is too low"), "quota"],
      [mk(400, "messages: bad"), "bad_request"],
      [mk(529, "overloaded"), "server"],
    ];
    for (const [err, kind] of kinds) {
      const a = new AnthropicAdapter({ client: fake(err).client, meter: new SpendMeter(5), fallback: false });
      await expect(a.generate(req)).rejects.toMatchObject({ kind });
    }
    const rl = await new AnthropicAdapter({ client: fake(mk(429, "x")).client, meter: new SpendMeter(5), fallback: false }).generate(req).catch((e: ModelError) => e);
    expect((rl as ModelError).retryAfterMs).toBe(7000);
  });

  it("turns a safety refusal and an empty/cut-off answer into clear errors", async () => {
    const refuse = fake(reply({ stop_reason: "refusal", content: [], stop_details: { category: "cyber", explanation: null } }));
    await expect(new AnthropicAdapter({ client: refuse.client, meter: new SpendMeter(5) }).generate(req)).rejects.toMatchObject({ kind: "blocked", message: expect.stringContaining("cyber") });
    const cut = fake(reply({ stop_reason: "max_tokens", content: [] }));
    await expect(new AnthropicAdapter({ client: cut.client, meter: new SpendMeter(5) }).generate(req)).rejects.toMatchObject({ kind: "parse", message: expect.stringContaining("cut off") });
  });

  it("works with the kernel's JSON helper, including its one repair round (prose around JSON is tolerated)", async () => {
    const { client, calls } = fake(reply({ content: [{ type: "text", text: "Sure!\n```json\n{\"n\": \"five\"}\n```" }] }), reply({ content: [{ type: "text", text: '{"n": 5}' }] }));
    const a = new AnthropicAdapter({ client, meter: new SpendMeter(5) });
    const out = await generateJson((r) => a.generate(r), { purpose: "route", system: "s", prompt: "STABLE|VOLATILE", cacheSplit: 7 }, z.object({ n: z.number() }));
    expect(out).toEqual({ n: 5 });
    expect(calls).toHaveLength(2);
    // The repair appends to the end, so the cached prefix is untouched.
    const second = (calls[1]!.messages as { content: { text: string }[] }[])[0]!.content;
    expect(second[0]!.text).toBe("STABLE|");
    expect(second[1]!.text).toContain("YOUR PREVIOUS REPLY WAS INVALID");
  });
});
