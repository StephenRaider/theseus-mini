import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Playbook, RolePackManifest, type RiskTier } from "@theseus/protocol";
import { parse as parseYaml } from "yaml";

export interface LoadedRolePack {
  manifest: RolePackManifest;
  playbooks: Map<string, Playbook>;
}

export class RolePackError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Role pack is invalid:\n- ${problems.join("\n- ")}`);
  }
}

const RISK_ORDER: Record<RiskTier, number> = { read: 0, write: 1, irreversible: 2 };

/**
 * Load and cross-validate a role pack directory:
 *   pack.yaml + playbooks/*.yaml
 * Beyond schema validation, it checks that every tool/check a playbook step
 * references is declared in the manifest, and that a step never uses a tool
 * riskier than the step's declared risk. These are the guard rails that
 * keep agent-proposed playbook edits (Ship of Theseus) inside the role's scope.
 */
export async function loadRolePack(dir: string): Promise<LoadedRolePack> {
  const problems: string[] = [];
  const manifest = RolePackManifest.parse(parseYaml(await readFile(join(dir, "pack.yaml"), "utf8")));
  const files = (await readdir(join(dir, "playbooks"))).filter((f) => f.endsWith(".yaml")).sort();
  const playbooks = new Map<string, Playbook>();
  for (const file of files) {
    const raw = parseYaml(await readFile(join(dir, "playbooks", file), "utf8"));
    const res = Playbook.safeParse(raw);
    if (!res.success) {
      problems.push(`${file}: ${res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
      continue;
    }
    if (playbooks.has(res.data.id)) problems.push(`${file}: duplicate playbook id "${res.data.id}"`);
    problems.push(...validatePlaybookAgainstManifest(res.data, manifest).map((p) => `${file}: ${p}`));
    playbooks.set(res.data.id, res.data);
  }
  if (problems.length) throw new RolePackError(problems);
  return { manifest, playbooks };
}

/** Cross-checks a single playbook (also used to vet agent-proposed edits). */
export function validatePlaybookAgainstManifest(pb: Playbook, manifest: RolePackManifest): string[] {
  const problems: string[] = [];
  const tools = new Map(manifest.tools.map((t) => [t.name, t]));
  const checks = new Set(manifest.checks.map((c) => c.id));
  const stepIds = new Set<string>();
  for (const step of pb.steps) {
    if (stepIds.has(step.id)) problems.push(`duplicate step id "${step.id}"`);
    stepIds.add(step.id);
    for (const t of step.tools) {
      const tool = tools.get(t);
      if (!tool) problems.push(`step "${step.id}" uses undeclared tool "${t}"`);
      else if (RISK_ORDER[tool.risk] > RISK_ORDER[step.risk])
        problems.push(`step "${step.id}" (risk ${step.risk}) uses ${tool.risk} tool "${t}"`);
    }
    for (const c of step.checks) if (!checks.has(c)) problems.push(`step "${step.id}" uses undeclared check "${c}"`);
  }
  return problems;
}
