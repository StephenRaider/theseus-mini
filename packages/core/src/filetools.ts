import { AlignmentType, Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from "docx";
import { createHash } from "node:crypto";
import ExcelJS from "exceljs";
import JSZip from "jszip";
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

/** A list the model typed as text: a JSON array, or one entry per line (or separated by |). */
const asList = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (t.startsWith("[")) {
    try {
      return JSON.parse(t);
    } catch {
      /* fall through to lines */
    }
  }
  return t.split(/\r?\n|\|/).map((x) => x.trim()).filter(Boolean);
};
const asMoves = (v: unknown): unknown => {
  const l = asList(v);
  if (!Array.isArray(l)) return l;
  return l.map((x) => {
    if (typeof x !== "string") return x;
    const [from, to] = x.split(/\s*(?:=>|->|→)\s*/);
    return { from: from?.trim() ?? "", to: to?.trim() ?? "" };
  });
};

const IMAGE_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
const IMAGE_INSTRUCTION =
  "This is a picture of a document (a scan or phone photo). Transcribe ALL the text on it exactly as printed, line by line, keeping labels and values together as 'Label: value'. Do not interpret or summarise. Put [illegible] where you cannot read something. If it is not a document, describe it in one line.";

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
  if (ext === "docx") return docxText(bytes);
  if (["doc", "xls", "ppt", "pptx", "zip", "jpg", "jpeg", "png", "gif", "exe"].includes(ext ?? "")) throw new ToolFailure("validation", `${name}: reading .${ext} files isn't supported`);
  return Buffer.from(bytes).toString("utf8");
}

/** Text of a Word document: paragraphs (and table cells) in order. */
async function docxText(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) throw new ToolFailure("validation", "Not a readable Word document");
  const decode = (t: string) => t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  return xml
    .split(/<\/w:p>/)
    .map((p) => decode((p.match(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>/g) ?? []).map((m) => (m === "<w:tab/>" ? "\t" : m.replace(/<[^>]+>/g, ""))).join("")))
    .filter((l) => l.trim())
    .join("\n");
}

const SEARCHABLE = /\.(pdf|xlsx|docx|csv|txt|md|json|tsv)$/i;

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
    output: "{ files: [{ path, size, modified, fingerprint }] } (same fingerprint = identical file)",
    async run({ folder }) {
      const entries = (await sandbox.walk(rootId, folder ?? "", 5).catch(sandboxFailure)).filter((e) => e.kind === "file");
      const files = [];
      for (const e of entries.slice(0, 300)) {
        const fingerprint = e.size <= 8 * 1024 * 1024 ? createHash("sha1").update(await sandbox.readBytes(rootId, e.rel).catch(() => Buffer.alloc(0))).digest("hex").slice(0, 8) : "";
        files.push({ path: e.rel, size: e.size, modified: new Date(e.mtimeMs).toISOString(), fingerprint });
      }
      return { files };
    },
  };
  const read: Tool<{ path: string }> = {
    name: "files.read_text",
    description: "Read a workspace file as text (PDF, Excel .xlsx, Word .docx, CSV, TXT, or a picture: JPG/PNG scans and photos are read by sight)",
    risk: "read",
    idempotent: true,
    input: z.object({ path: z.string() }),
    output: "{ path, text }",
    async run({ path }, ctx) {
      const bytes = await sandbox.readBytes(rootId, path).catch(sandboxFailure);
      const mime = IMAGE_MIME[path.toLowerCase().split(".").pop() ?? ""];
      if (mime) {
        if (!ctx.vision) throw new ToolFailure("validation", `${path}: this is a picture and no model that can look at pictures is attached`);
        const seen = await ctx.vision([{ mime, base64: Buffer.from(bytes).toString("base64"), name: path }], IMAGE_INSTRUCTION);
        ctx.evidence({ kind: "document", summary: `Read ${path} (a picture, read by sight)`, source: `file:${path}`, ref: path });
        return { path, text: `(picture, read by sight)\n${seen.trim()}` };
      }
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
      ctx.effect({ summary: `Created ${used}`, undo: { tool: "files.trash", input: { path: used } } });
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
      ctx.effect({ summary: `Created ${used}`, undo: { tool: "files.trash", input: { path: used } } });
      return { path: used };
    },
  };
  const saveXlsx: Tool<{ path: string; sheet?: string | undefined; rows: string[][] }> = {
    name: "files.save_xlsx",
    description: "Save a NEW Excel workbook (.xlsx). Args: path; sheet (optional name); rows = one table row per line, cells separated by ' | ', first line = column headings. Never overwrites",
    risk: "write",
    idempotent: false,
    input: z.object({
      path: z.string().describe('Workspace path, e.g. "Onboarding/Document Checklist.xlsx"'),
      sheet: z.string().optional(),
      rows: z.preprocess(
        (v) => (typeof v === "string" ? v.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split("|").map((c) => c.trim())) : v),
        z.array(z.array(z.string())).min(1).max(500),
      ),
    }),
    output: "{ path }",
    async explain({ path, rows }) {
      return { summary: `Create ${path} (${Math.max(0, rows.length - 1)} rows)` };
    },
    async run({ path, sheet, rows }, ctx) {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet((sheet ?? "Sheet1").slice(0, 31));
      rows.forEach((r) => ws.addRow(r));
      ws.getRow(1).font = { bold: true };
      ws.columns.forEach((c) => (c.width = 30));
      const rel = path.toLowerCase().endsWith(".xlsx") ? path : `${path}.xlsx`;
      const used = await sandbox.writeNew(rootId, rel, new Uint8Array(await wb.xlsx.writeBuffer())).catch(sandboxFailure);
      ctx.evidence({ kind: "document", summary: `Saved ${used}`, source: `file:${used}`, ref: used });
      ctx.effect({ summary: `Created ${used}`, undo: { tool: "files.trash", input: { path: used } } });
      return { path: used };
    },
  };
  const move: Tool<{ from: string; to: string }> = {
    name: "files.move",
    description: "Move or rename ONE file inside the workspace (creates the folder; never overwrites; can be undone). Use it to file documents under a standard name",
    risk: "write",
    idempotent: false,
    input: z.object({ from: z.string(), to: z.string().describe('New path including the new file name, e.g. "Onboarding/Nandi Roadways LLP/PAN Card - Nandi Roadways LLP.png"') }),
    output: "{ from, to }",
    async explain({ from, to }) {
      return { summary: `Move ${from} → ${to}` };
    },
    async run({ from, to }, ctx) {
      const used = await sandbox.move(rootId, from, to).catch(sandboxFailure);
      ctx.evidence({ kind: "document", summary: `Filed ${from} as ${used}`, source: `file:${used}`, ref: used });
      ctx.effect({ summary: `Moved ${from} → ${used}`, undo: { tool: "files.move", input: { from: used, to: from } } });
      return { from, to: used };
    },
  };
  const trash: Tool<{ path: string }> = {
    name: "files.trash",
    description: "Put a file the employee created into the hidden .trash folder (used by Undo)",
    risk: "write",
    idempotent: false,
    internal: true,
    input: z.object({ path: z.string() }),
    output: "{ path }",
    async run({ path }, ctx) {
      const used = await sandbox.move(rootId, path, `.trash/${path}`).catch(sandboxFailure);
      ctx.evidence({ kind: "document", summary: `Removed ${path} (kept in .trash)`, source: `file:${path}`, ref: path });
      return { path: used };
    },
  };
  const textCache = new Map<string, { mtime: number; text: string }>();
  const readMany: Tool<{ paths: string[] }> = {
    name: "files.read_many",
    description: "Read up to 8 workspace files in one go (same formats as files.read_text, pictures included). Args: paths = the file paths, one per line. Use it to go through a pile of documents quickly",
    risk: "read",
    idempotent: true,
    input: z.object({ paths: z.preprocess(asList, z.array(z.string()).min(1).max(8)) }),
    output: "{ files: [{ path, text | error }] }",
    async run({ paths }, ctx) {
      const files = [];
      for (const path of paths) {
        try {
          const r = (await read.run({ path }, ctx)) as { text: string };
          files.push({ path, text: r.text.length > 4000 ? `${r.text.slice(0, 4000)}\n…(truncated)` : r.text });
        } catch (e) {
          files.push({ path, error: (e as Error).message });
        }
      }
      return { files };
    },
  };
  const moveMany: Tool<{ moves: { from: string; to: string }[] }> = {
    name: "files.move_many",
    description: "Move or rename up to 15 files in one go (never overwrites; each can be undone). Args: moves = one move per line, written 'old path => new path'. Use it once you know where every file belongs",
    risk: "write",
    idempotent: false,
    input: z.object({ moves: z.preprocess(asMoves, z.array(z.object({ from: z.string().min(1), to: z.string().min(1) })).min(1).max(15)) }),
    output: "{ moved: [{ from, to }], failed: [{ from, error }] }",
    async explain({ moves }) {
      return { summary: moves.map((m) => `Move ${m.from} → ${m.to}`).join("\n") };
    },
    async run({ moves }, ctx) {
      const moved: { from: string; to: string }[] = [];
      const failed: { from: string; error: string }[] = [];
      for (const m of moves) {
        try {
          const used = await sandbox.move(rootId, m.from, m.to);
          ctx.evidence({ kind: "document", summary: `Filed ${m.from} as ${used}`, source: `file:${used}`, ref: used });
          ctx.effect({ summary: `Moved ${m.from} → ${used}`, undo: { tool: "files.move", input: { from: used, to: m.from } } });
          moved.push({ from: m.from, to: used });
        } catch (e) {
          failed.push({ from: m.from, error: (e as Error).message });
        }
      }
      return { moved, failed };
    },
  };
  const search: Tool<{ query: string; folder?: string }> = {
    name: "files.search",
    description: "Search the workspace: file names AND the text inside PDFs, Excel, Word, CSV and text files. Returns matching files with a snippet",
    risk: "read",
    idempotent: true,
    input: z.object({ query: z.string().min(1).describe("Words to find (all must appear), e.g. \"Hoysala invoice\""), folder: z.string().optional() }),
    output: "{ matches: [{ path, modified, where: name|content, snippet }] }",
    async run({ query, folder }) {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const entries = (await sandbox.walk(rootId, folder ?? "", 5).catch(sandboxFailure)).filter((e) => e.kind === "file");
      const matches: { path: string; modified: string; where: "name" | "content"; snippet?: string }[] = [];
      for (const e of entries) {
        const modified = new Date(e.mtimeMs).toISOString();
        if (words.every((w) => e.rel.toLowerCase().includes(w))) {
          matches.push({ path: e.rel, modified, where: "name" });
          continue;
        }
        if (!SEARCHABLE.test(e.rel) || e.size > 5 * 1024 * 1024) continue;
        let text = textCache.get(e.rel)?.mtime === e.mtimeMs ? textCache.get(e.rel)!.text : undefined;
        if (text === undefined) {
          text = await documentText(e.rel, await sandbox.readBytes(rootId, e.rel)).catch(() => "");
          textCache.set(e.rel, { mtime: e.mtimeMs, text });
        }
        const low = text.toLowerCase();
        if (!words.every((w) => low.includes(w))) continue;
        const at = low.indexOf(words[0]!);
        const snippet = text.slice(Math.max(0, at - 80), at + 160).replace(/\s+/g, " ").trim();
        matches.push({ path: e.rel, modified, where: "content", snippet });
        if (matches.length >= 25) break;
      }
      return { matches };
    },
  };
  return [list, read, readMany, search, save, saveDocx, saveXlsx, move, moveMany, trash];
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
