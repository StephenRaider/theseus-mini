import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileSandbox } from "../src/files.ts";
import { fileTools } from "../src/filetools.ts";
import { ToolGateway } from "../src/gateway.ts";
import { EventLog, IdMaker } from "../src/log.ts";

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "theseus-trust-"));
  await fs.mkdir(path.join(root, "Incoming"));
  await fs.writeFile(path.join(root, "Incoming", "scan0231.pdf"), "pdf-bytes");
  const log = new EventLog();
  const g = new ToolGateway({ log, ids: new IdMaker(), tools: fileTools(new FileSandbox([{ id: "w", label: "W", path: root }]), "w"), sleep: async () => {} });
  const exists = (p: string) => fs.stat(path.join(root, p)).then(() => true, () => false);
  return { root, log, g, exists };
}

describe("trust: undo and rehearsal", () => {
  it("a move records an effect that undoes it, and the file comes back where it was", async () => {
    const { log, g, exists } = await setup();
    const r = await g.call("files.move", { from: "Incoming/scan0231.pdf", to: "Onboarding/Nandi/GST Certificate.pdf" }, { employeeId: "e", taskId: "t1" });
    expect(r.ok).toBe(true);
    expect(await exists("Onboarding/Nandi/GST Certificate.pdf")).toBe(true);
    const fx = log.ofType("effect.recorded");
    expect(fx).toHaveLength(1);
    expect(fx[0]!.payload.summary).toBe("Moved Incoming/scan0231.pdf → Onboarding/Nandi/GST Certificate.pdf");
    const u = fx[0]!.payload.undo!;
    expect((await g.call(u.tool, u.input, { employeeId: "e", taskId: "t1" })).ok).toBe(true);
    expect(await exists("Incoming/scan0231.pdf")).toBe(true);
  });

  it("never overwrites: a taken name gets a free one", async () => {
    const { g, root } = await setup();
    await fs.writeFile(path.join(root, "Incoming", "b.pdf"), "other");
    await g.call("files.move", { from: "Incoming/scan0231.pdf", to: "Sorted/X.pdf" }, { employeeId: "e" });
    const r = await g.call<{ to: string }>("files.move", { from: "Incoming/b.pdf", to: "Sorted/X.pdf" }, { employeeId: "e" });
    expect(r.ok && r.data.to).not.toBe("Sorted/X.pdf");
    expect(await fs.readFile(path.join(root, "Sorted", "X.pdf"), "utf8")).toBe("pdf-bytes");
  });

  it("a rehearsed task previews its writes and changes nothing; reads still work", async () => {
    const { log, g, exists } = await setup();
    g.rehearsing.add("t2");
    const list = await g.call("files.list", {}, { employeeId: "e", taskId: "t2" });
    expect(list.ok).toBe(true);
    const r = await g.call("files.move", { from: "Incoming/scan0231.pdf", to: "Onboarding/Nandi/GST Certificate.pdf" }, { employeeId: "e", taskId: "t2" });
    expect(r.ok && (r.data as { previewed?: boolean }).previewed).toBe(true);
    expect(await exists("Incoming/scan0231.pdf")).toBe(true);
    expect(log.ofType("effect.previewed")[0]!.payload.summary).toBe("Move Incoming/scan0231.pdf → Onboarding/Nandi/GST Certificate.pdf");
    expect(log.ofType("effect.recorded")).toHaveLength(0);
  });

  it("the internal trash tool is never offered to the model", async () => {
    const { g } = await setup();
    expect(g.describe().map((t) => t.name)).not.toContain("files.trash");
    expect(g.describe().map((t) => t.name)).toContain("files.move");
  });
});
