import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelError, type ModelAdapter, type ModelRequest, type ModelResponse } from "./model.ts";

/**
 * A "model" that is a person (or another agent) at the other end of a folder.
 *
 * Every request the kernel makes is written as req-0007.json (+ any pictures as files next to it),
 * then the call waits until res-0007.json appears and uses its contents as the model's reply.
 * It exists for evaluation without spending API credits: a Claude subagent plays the model, reading
 * exactly what the API would receive and writing exactly what it would return.
 *
 *   <dir>/req-0007.json         { id, case, purpose, system, prompt, jsonSchema, thinking, images:[{file,mime,name}] }
 *   <dir>/req-0007.img0.png     the pictures, if any
 *   <dir>/res-0007.json         the reply: the JSON object itself (raw text is fine)
 *   <dir>/DONE                  written by the runner when it has finished
 */
export interface FileQueueOptions {
  dir: string;
  /** Shown in logs; default "proxy". */
  label?: string;
  pollMs?: number;
  /** Give up on one reply after this long (default 20 minutes). */
  timeoutMs?: number;
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

export class FileQueueModel implements ModelAdapter {
  readonly name: string;
  /** Which eval case is running (recorded in each request, for the reader's context). */
  caseId = "";
  private n = 0;

  constructor(private readonly opts: FileQueueOptions) {
    this.name = `proxy:${opts.label ?? "claude-subagent"}`;
    mkdirSync(opts.dir, { recursive: true });
  }

  async generate(req: ModelRequest): Promise<ModelResponse> {
    const id = String(++this.n).padStart(4, "0");
    const { dir } = this.opts;
    const images = (req.images ?? []).map((img, i) => {
      const file = `req-${id}.img${i}.${EXT[img.mime] ?? "bin"}`;
      writeFileSync(join(dir, file), Buffer.from(img.base64, "base64"));
      return { file: join(dir, file), mime: img.mime, ...(img.name ? { name: img.name } : {}) };
    });
    const body = { id, case: this.caseId, purpose: req.purpose, system: req.system, prompt: req.prompt, jsonSchema: req.jsonSchema ?? null, thinking: req.thinking ?? null, images };
    // Write then rename, so a reader never sees half a request.
    writeFileSync(join(dir, `req-${id}.json.tmp`), JSON.stringify(body, null, 1));
    renameSync(join(dir, `req-${id}.json.tmp`), join(dir, `req-${id}.json`));

    const res = join(dir, `res-${id}.json`);
    const t0 = Date.now();
    const limit = this.opts.timeoutMs ?? 20 * 60_000;
    for (;;) {
      if (existsSync(res)) {
        // Wait until the file stops growing (a writer may still be flushing it).
        const size = statSync(res).size;
        await new Promise((r) => setTimeout(r, 150));
        if (statSync(res).size === size && size > 0) return { text: readFileSync(res, "utf8") };
      }
      if (Date.now() - t0 > limit) throw new ModelError("network", `No reply to request ${id} after ${Math.round(limit / 60000)} minutes`);
      await new Promise((r) => setTimeout(r, this.opts.pollMs ?? 250));
    }
  }
}
