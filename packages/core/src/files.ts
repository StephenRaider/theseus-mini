/**
 * File sandbox: the only way Theseus (the app or an agent) touches the disk.
 *
 * Work happens inside GRANTED FOLDERS ("roots"). Every path is given relative
 * to a root and checked twice:
 *   1. lexically: no absolute paths, drive letters, NUL bytes or `..` escapes;
 *   2. physically: the real location (after following symlinks / junctions)
 *      must still be inside the root's real location.
 * Writes never overwrite: new files only (overwrites need a human, see the
 * risk tiers in the Framework Spec), so `writeNew` picks a free name instead.
 */
import fs from "node:fs/promises";
import path from "node:path";

export interface Root {
  /** Stable id used in messages and attachments, e.g. "workspace". */
  id: string;
  /** Shown in the UI. */
  label: string;
  /** Absolute path on this computer. */
  path: string;
}

export type SandboxErrorCode = "unknown_root" | "invalid_path" | "outside_root" | "not_found" | "too_large";

export class SandboxError extends Error {
  constructor(
    public readonly code: SandboxErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface FileEntry {
  name: string;
  /** Path relative to the root, always with forward slashes. */
  rel: string;
  kind: "file" | "dir";
  size: number;
  mtimeMs: number;
}

/** True when `child` is `parent` or somewhere below it. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Normalise a root-relative path to forward slashes; throws on anything that could escape. */
export function cleanRel(rel: string): string {
  if (rel.includes("\0")) throw new SandboxError("invalid_path", "Path contains a NUL byte");
  const unified = rel.replace(/\\/g, "/").trim();
  if (unified.startsWith("/") || /^[a-zA-Z]:/.test(unified)) throw new SandboxError("invalid_path", `Absolute paths are not allowed: ${rel}`);
  const parts: string[] = [];
  for (const part of unified.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") throw new SandboxError("outside_root", `"..": path leaves the granted folder: ${rel}`);
    parts.push(part);
  }
  return parts.join("/");
}

/** realpath of the deepest existing ancestor, with the missing tail re-appended. */
async function realpathNearest(p: string): Promise<string> {
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return path.join(await fs.realpath(cur), ...tail.reverse());
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const parent = path.dirname(cur);
      if (parent === cur) throw e;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

export class FileSandbox {
  private roots = new Map<string, Root>();

  constructor(roots: Root[] = []) {
    for (const r of roots) this.grant(r);
  }

  grant(root: Root): void {
    if (!path.isAbsolute(root.path)) throw new SandboxError("invalid_path", `Root must be absolute: ${root.path}`);
    this.roots.set(root.id, { ...root, path: path.resolve(root.path) });
  }

  revoke(rootId: string): void {
    this.roots.delete(rootId);
  }

  list(): Root[] {
    return [...this.roots.values()];
  }

  root(rootId: string): Root {
    const r = this.roots.get(rootId);
    if (!r) throw new SandboxError("unknown_root", `No granted folder "${rootId}"`);
    return r;
  }

  /** Absolute, symlink-resolved path for `rel` inside `rootId`, or a SandboxError. */
  async resolve(rootId: string, rel: string): Promise<string> {
    const root = this.root(rootId);
    const clean = cleanRel(rel);
    const lexical = path.join(root.path, ...clean.split("/").filter(Boolean));
    if (!isInside(root.path, lexical)) throw new SandboxError("outside_root", `Outside the granted folder: ${rel}`);
    const realRoot = await realpathNearest(root.path);
    const real = await realpathNearest(lexical);
    if (!isInside(realRoot, real)) throw new SandboxError("outside_root", `Link points outside the granted folder: ${rel}`);
    return real;
  }

  /** Entries of a folder (hidden files and links skipped), folders first, then by name. */
  async readDir(rootId: string, rel = ""): Promise<FileEntry[]> {
    const abs = await this.resolve(rootId, rel);
    let dirents;
    try {
      dirents = await fs.readdir(abs, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new SandboxError("not_found", `Folder not found: ${rel || "/"}`);
      throw e;
    }
    const base = cleanRel(rel);
    const out: FileEntry[] = [];
    for (const d of dirents) {
      if (d.name.startsWith(".")) continue;
      if (!d.isFile() && !d.isDirectory()) continue;
      const st = await fs.stat(path.join(abs, d.name));
      out.push({ name: d.name, rel: base ? `${base}/${d.name}` : d.name, kind: d.isDirectory() ? "dir" : "file", size: st.size, mtimeMs: st.mtimeMs });
    }
    return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
  }

  /** Every file below `rel`, depth-limited. Used for the live Files panel. */
  async walk(rootId: string, rel = "", maxDepth = 4): Promise<FileEntry[]> {
    const out: FileEntry[] = [];
    const visit = async (r: string, depth: number) => {
      for (const e of await this.readDir(rootId, r)) {
        out.push(e);
        if (e.kind === "dir" && depth < maxDepth) await visit(e.rel, depth + 1);
      }
    };
    await visit(rel, 0);
    return out;
  }

  async readText(rootId: string, rel: string, maxBytes = 512 * 1024): Promise<string> {
    const abs = await this.resolve(rootId, rel);
    const st = await fs.stat(abs).catch(() => null);
    if (!st?.isFile()) throw new SandboxError("not_found", `File not found: ${rel}`);
    if (st.size > maxBytes) throw new SandboxError("too_large", `File is larger than ${maxBytes} bytes`);
    return fs.readFile(abs, "utf8");
  }

  /** Raw bytes of a file (PDFs, spreadsheets). */
  async readBytes(rootId: string, rel: string, maxBytes = 20 * 1024 * 1024): Promise<Buffer> {
    const abs = await this.resolve(rootId, rel);
    const st = await fs.stat(abs).catch(() => null);
    if (!st?.isFile()) throw new SandboxError("not_found", `File not found: ${rel}`);
    if (st.size > maxBytes) throw new SandboxError("too_large", `File is larger than ${maxBytes} bytes`);
    return fs.readFile(abs);
  }

  /** Size of an existing file, or undefined. */
  async sizeOf(rootId: string, rel: string): Promise<number | undefined> {
    const abs = await this.resolve(rootId, rel);
    const st = await fs.stat(abs).catch(() => null);
    return st?.isFile() ? st.size : undefined;
  }

  /** A name that doesn't exist yet: "report.docx" → "report (1).docx". */
  async freeName(rootId: string, rel: string): Promise<string> {
    const clean = cleanRel(rel);
    const dir = path.posix.dirname(clean);
    const ext = path.posix.extname(clean);
    const stem = path.posix.basename(clean, ext);
    for (let i = 0; i < 1000; i++) {
      const name = i === 0 ? `${stem}${ext}` : `${stem} (${i})${ext}`;
      const candidate = dir === "." ? name : `${dir}/${name}`;
      const abs = await this.resolve(rootId, candidate);
      try {
        await fs.access(abs);
      } catch {
        return candidate;
      }
    }
    throw new SandboxError("invalid_path", `No free name for ${rel}`);
  }

  /** Create a NEW file (parent folders included). Never overwrites; returns the path actually used. */
  async writeNew(rootId: string, rel: string, data: string | Uint8Array): Promise<string> {
    const target = await this.freeName(rootId, rel);
    const abs = await this.resolve(rootId, target);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, data, { flag: "wx" });
    return target;
  }

  /** Copy a file from anywhere on the computer INTO a root (how user attachments enter the sandbox). */
  async importFile(rootId: string, relDir: string, sourceAbs: string): Promise<string> {
    const st = await fs.stat(sourceAbs).catch(() => null);
    if (!st?.isFile()) throw new SandboxError("not_found", `Not a file: ${sourceAbs}`);
    const dir = cleanRel(relDir);
    const target = await this.freeName(rootId, dir ? `${dir}/${path.basename(sourceAbs)}` : path.basename(sourceAbs));
    const abs = await this.resolve(rootId, target);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.copyFile(sourceAbs, abs, fs.constants.COPYFILE_EXCL);
    return target;
  }

}
