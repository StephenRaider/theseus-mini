/**
 * For whoever plays the model in a --proxy run: waits for the next unanswered request and prints it
 * exactly as the API would have received it, plus where to write the reply.
 *
 *   pnpm --filter @theseus/evals exec tsx src/proxy-next.ts <dir>
 *
 * Prints one of: a request (REQUEST 0007 …), "NO REQUEST YET" (call again), or "RUN FINISHED".
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: proxy-next.ts <dir>");
  process.exit(2);
}
const waitMs = Number(process.argv[3] ?? 100_000);
const t0 = Date.now();
const pending = () =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => /^req-\d+\.json$/.test(f) && !existsSync(join(dir, f.replace("req-", "res-"))))
        .sort()
    : [];
for (;;) {
  const p = pending();
  if (p.length) {
    const req = JSON.parse(readFileSync(join(dir, p[0]!), "utf8")) as { id: string; case: string; purpose: string; system: string; prompt: string; jsonSchema: unknown; images: { file: string; mime: string; name?: string }[] };
    const out = join(dir, `res-${req.id}.json`);
    console.log(`REQUEST ${req.id}  case=${req.case}  purpose=${req.purpose}${p.length > 1 ? `  (${p.length - 1} more waiting)` : ""}`);
    console.log(`WRITE YOUR REPLY TO: ${out}`);
    console.log(req.jsonSchema ? "REPLY FORMAT: ONLY the JSON object (no prose, no code fences) that matches the schema." : "REPLY FORMAT: this request has NO schema: write the plain text answer the prompt asks for (not JSON).");
    console.log("\n===== SYSTEM =====\n" + req.system);
    console.log("\n===== JSON SCHEMA =====\n" + JSON.stringify(req.jsonSchema));
    if (req.images.length) console.log(`\n===== IMAGES (open each with the Read tool) =====\n${req.images.map((i) => `${i.file}${i.name ? `  (${i.name})` : ""}`).join("\n")}`);
    console.log("\n===== PROMPT =====\n" + req.prompt);
    process.exit(0);
  }
  if (existsSync(join(dir, "DONE"))) {
    console.log("RUN FINISHED");
    process.exit(0);
  }
  if (Date.now() - t0 > waitMs) {
    console.log("NO REQUEST YET (the run is still working; call again)");
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 400));
}
