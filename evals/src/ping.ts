/**
 * Is the API key set up right? One tiny call (a fraction of a cent) that prints the model, tokens,
 * cost and the running total against the cap. Run it before anything else.
 *   pnpm live:ping
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { generateJson } from "@theseus/core";
import { claudeSpend, modelFromEnv, noLiveModelReason, providerFromEnv, REPO_ROOT } from "@theseus/server";

if (existsSync(join(REPO_ROOT, ".env"))) process.loadEnvFile(join(REPO_ROOT, ".env"));
const provider = providerFromEnv();
if (!provider) {
  console.error(`No live model: ${noLiveModelReason()}.\nPut the key in the .env file at the project root (copy .env.example to .env first) and set MODEL_PROVIDER.`);
  process.exit(2);
}
const model = modelFromEnv();
console.log(`Provider: ${provider} · model: ${model.name}`);
try {
  const t0 = Date.now();
  let usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } | undefined;
  const out = await generateJson(
    async (r) => {
      const res = await model.generate(r);
      usage = res.usage;
      return res;
    },
    { purpose: "triage", system: "You are a connectivity check. Reply with JSON only.", prompt: 'Return {"ok": true, "word": "ready"}.', thinking: "low" },
    z.object({ ok: z.boolean(), word: z.string() }),
  );
  console.log(`OK: the model answered ${JSON.stringify(out)} in ${((Date.now() - t0) / 1000).toFixed(1)}s (${usage?.inputTokens ?? "?"} tokens in, ${usage?.outputTokens ?? "?"} out${usage?.costUsd !== undefined ? `, $${usage.costUsd.toFixed(5)}` : ""}).`);
  const s = claudeSpend();
  if (s) console.log(`Claude spend so far: $${s.spent.toFixed(4)} of the $${s.capUsd.toFixed(2)} cap.`);
} catch (e) {
  console.error(`FAILED: ${(e as Error).message}`);
  process.exit(1);
}
