import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
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
  const saveDocx: Tool<DocxInput> = {
    name: "files.save_docx",
    description: "Save a NEW Word document (.docx) in the workspace from headings, paragraphs, bullet lists and tables (never overwrites)",
    risk: "write",
    idempotent: false,
    input: DocxInput,
    output: "{ path }",
    async run(doc, ctx) {
      const rel = doc.path.toLowerCase().endsWith(".docx") ? doc.path : `${doc.path}.docx`;
      const used = await sandbox.writeNew(rootId, rel, await buildDocx(doc)).catch(sandboxFailure);
      ctx.evidence({ kind: "document", summary: `Saved ${used}`, source: `file:${used}`, ref: used });
      return { path: used };
    },
  };
  return [list, read, save, saveDocx];
}

/* ------------------------------------------------------------------ Word documents */

export const DocxBlock = z.object({
  kind: z.enum(["heading", "paragraph", "bullets", "table"]),
  text: z.string().optional().describe("heading / paragraph text"),
  items: z.array(z.string()).optional().describe("bullets"),
  rows: z.array(z.array(z.string())).optional().describe("table rows; first row is the header"),
});
export const DocxInput = z.object({
  path: z.string().describe('Workspace path, e.g. "Drafts/Letter.docx"'),
  title: z.string().optional(),
  /** Small grey line under the title, e.g. "Ref: KIPL/VD/2026/014 · 7 Oct 2026". */
  subtitle: z.string().optional(),
  blocks: z.array(DocxBlock),
});
export type DocxInput = z.infer<typeof DocxInput>;

/** Plain, formal Word layout: title, optional reference line, then the blocks. */
export async function buildDocx(d: Omit<DocxInput, "path">): Promise<Uint8Array> {
  const para = (text: string, opts: { bold?: boolean; size?: number; color?: string } = {}) =>
    new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text, ...(opts.bold ? { bold: true } : {}), ...(opts.size ? { size: opts.size } : {}), ...(opts.color ? { color: opts.color } : {}) })] });
  const children: (Paragraph | Table)[] = [];
  if (d.title) children.push(new Paragraph({ heading: HeadingLevel.TITLE, alignment: AlignmentType.LEFT, children: [new TextRun({ text: d.title })] }));
  if (d.subtitle) children.push(para(d.subtitle, { color: "666666", size: 20 }));
  for (const b of d.blocks) {
    if (b.kind === "heading" && b.text) children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 240, after: 120 }, children: [new TextRun({ text: b.text })] }));
    else if (b.kind === "paragraph" && b.text !== undefined) for (const line of b.text.split("\n")) children.push(para(line));
    else if (b.kind === "bullets") for (const it of b.items ?? []) children.push(new Paragraph({ bullet: { level: 0 }, children: [new TextRun({ text: it })] }));
    else if (b.kind === "table" && b.rows?.length) {
      children.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: b.rows.map((r, i) => new TableRow({ children: r.map((c) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: c, ...(i === 0 ? { bold: true } : {}) })] })] })) })),
        }),
      );
      children.push(para(""));
    }
  }
  return new Uint8Array(await Packer.toBuffer(new Document({ sections: [{ children }] })));
}
