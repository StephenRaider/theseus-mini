import ExcelJS from "exceljs";
import { extractText, getDocumentProxy } from "unpdf";
import { z } from "zod";
import { SandboxError, type FileSandbox } from "./files.ts";
import { ToolFailure, type Tool } from "./gateway.ts";

/**
 * Generic file tools (keel, any role): look around the granted folders, read
 * PDFs / spreadsheets / text, save new files. They go through FileSandbox, so
 * nothing outside a granted folder can be read or written, and saving never
 * overwrites an existing file.
 */

/** Text of a document, whatever its format. */
export async function documentText(name: string, bytes: Uint8Array): Promise<string> {
  const ext = name.toLowerCase().split(".").pop();
  if (ext === "pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  }
  if (ext === "xlsx") {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
    const out: string[] = [];
    wb.eachSheet((ws) => {
      out.push(`# Sheet: ${ws.name}`);
      ws.eachRow({ includeEmpty: false }, (row, n) => {
        if (n > 300) return;
        const vals = (row.values as unknown[]).slice(1).map((v) => cellText(v));
        out.push(vals.join("\t"));
      });
    });
    return out.join("\n");
  }
  if (ext === "docx") throw new ToolFailure("validation", `${name} is a Word file; reading Word text isn't supported yet`);
  return Buffer.from(bytes).toString("utf8");
}

function cellText(v: unknown): string {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as { text?: string; result?: unknown; richText?: { text: string }[] };
    if (o.richText) return o.richText.map((r) => r.text).join("");
    if (o.text !== undefined) return String(o.text);
    if (o.result !== undefined) return String(o.result);
  }
  return String(v);
}

const sandboxFailure = (e: unknown): never => {
  if (e instanceof SandboxError) throw new ToolFailure(e.code === "not_found" ? "not_found" : "policy_violation", e.message);
  throw e;
};

export function fileTools(sandbox: FileSandbox, rootId: string): Tool[] {
  const list: Tool<{ folder?: string }> = {
    name: "files.list",
    description: "List files in the workspace (or a sub-folder), with sizes and dates",
    risk: "read",
    idempotent: true,
    input: z.object({ folder: z.string().optional() }),
    output: "{ files: [{ path, size, modified }] }",
    async run({ folder }) {
      const entries = await sandbox.walk(rootId, folder ?? "", 4).catch(sandboxFailure);
      return { files: entries.filter((e) => e.kind === "file").map((e) => ({ path: e.rel, size: e.size, modified: new Date(e.mtimeMs).toISOString() })) };
    },
  };
  const read: Tool<{ path: string }> = {
    name: "files.read_text",
    description: "Read a workspace file as text (PDF, Excel .xlsx, CSV, TXT)",
    risk: "read",
    idempotent: true,
    input: z.object({ path: z.string() }),
    output: "{ path, text }",
    async run({ path }, ctx) {
      const bytes = await sandbox.readBytes(rootId, path).catch(sandboxFailure);
      const text = await documentText(path, bytes);
      ctx.evidence({ kind: "document", summary: `Read ${path}`, source: `file:${path}`, ref: path });
      return { path, text: text.length > 60_000 ? `${text.slice(0, 60_000)}\n…(truncated)` : text };
    },
  };
  const save: Tool<{ path: string; text: string }> = {
    name: "files.save_text",
    description: "Save a NEW text/CSV/Markdown file in the workspace (never overwrites; picks a free name)",
    risk: "write",
    idempotent: false,
    input: z.object({ path: z.string(), text: z.string() }),
    output: "{ path }",
    async run({ path, text }, ctx) {
      const used = await sandbox.writeNew(rootId, path, text).catch(sandboxFailure);
      ctx.evidence({ kind: "document", summary: `Saved ${used}`, source: `file:${used}`, ref: used });
      return { path: used };
    },
  };
  return [list, read, save];
}
