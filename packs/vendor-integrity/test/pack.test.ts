import { loadRolePack, validatePlaybookAgainstManifest } from "@theseus/core";
import { describe, expect, it } from "vitest";
import { PACK_DIR } from "../src/index.ts";

describe("vendor-integrity role pack", () => {
  it("loads the manifest and all playbooks without problems", async () => {
    const pack = await loadRolePack(PACK_DIR);
    expect(pack.manifest.id).toBe("vendor-integrity");
    expect([...pack.playbooks.keys()].sort()).toEqual(["bank-change-request", "onboard-contractor", "payment-batch-check"]);
  });

  it("guard rail: a playbook edit that sneaks in an undeclared or too-risky tool is rejected", async () => {
    const { manifest, playbooks } = await loadRolePack(PACK_DIR);
    const pb = structuredClone(playbooks.get("payment-batch-check")!);
    pb.steps[0]!.tools.push("payments.release_batch"); // irreversible tool in a read step
    pb.steps[1]!.tools.push("shell.exec"); // not part of this role at all
    const problems = validatePlaybookAgainstManifest(pb, manifest);
    expect(problems).toEqual([
      'step "vendor" (risk write) uses irreversible tool "payments.release_batch"',
      'step "bank" uses undeclared tool "shell.exec"',
    ]);
  });
});
