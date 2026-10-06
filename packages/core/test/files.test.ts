import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileSandbox, SandboxError, cleanRel, isInside } from "../src/files.ts";

let tmp: string;
let root: string;
let outside: string;
let box: FileSandbox;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "theseus-files-"));
  root = path.join(tmp, "workspace");
  outside = path.join(tmp, "secret");
  await fs.mkdir(path.join(root, "Vendor Desk"), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, "Vendor Desk", "register.csv"), "a,b\n1,2\n");
  await fs.writeFile(path.join(root, ".hidden"), "x");
  await fs.writeFile(path.join(outside, "passwords.txt"), "hunter2");
  // A link inside the workspace that points outside it (junction on Windows, symlink here).
  await fs.symlink(outside, path.join(root, "escape"), "dir");
  box = new FileSandbox([{ id: "workspace", label: "Workspace", path: root }]);
});
afterAll(() => fs.rm(tmp, { recursive: true, force: true }));

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof SandboxError ? e.code : String(e);
  }
};

describe("cleanRel / isInside", () => {
  it("normalises separators and dots", () => {
    expect(cleanRel("Vendor Desk\\Policies\\.\\a.pdf")).toBe("Vendor Desk/Policies/a.pdf");
    expect(cleanRel("")).toBe("");
  });
  it("rejects absolute paths, drive letters, NUL and ..", () => {
    expect(() => cleanRel("/etc/passwd")).toThrow(SandboxError);
    expect(() => cleanRel("C:\\Windows")).toThrow(SandboxError);
    expect(() => cleanRel("a\0b")).toThrow(SandboxError);
    expect(() => cleanRel("a/../../b")).toThrow(SandboxError);
  });
  it("isInside is not fooled by name prefixes", () => {
    expect(isInside("/w/root", "/w/root/a")).toBe(true);
    expect(isInside("/w/root", "/w/root")).toBe(true);
    expect(isInside("/w/root", "/w/root2/a")).toBe(false);
    expect(isInside("/w/root", "/w/root/..foo")).toBe(true);
  });
});

describe("FileSandbox", () => {
  it("resolves paths inside a granted folder", async () => {
    expect(await box.resolve("workspace", "Vendor Desk/register.csv")).toBe(
      path.join(await fs.realpath(root), "Vendor Desk", "register.csv"),
    );
  });
  it("refuses unknown roots, .. escapes and links that point outside", async () => {
    expect(await code(box.resolve("nope", "a"))).toBe("unknown_root");
    expect(await code(box.resolve("workspace", "../secret/passwords.txt"))).toBe("outside_root");
    expect(await code(box.resolve("workspace", "escape/passwords.txt"))).toBe("outside_root");
    expect(await code(box.readText("workspace", "escape/passwords.txt"))).toBe("outside_root");
    expect(await code(box.writeNew("workspace", "escape/new.txt", "x"))).toBe("outside_root");
  });
  it("lists folders first, hides dotfiles and links", async () => {
    const entries = await box.readDir("workspace");
    expect(entries.map((e) => e.name)).toEqual(["Vendor Desk"]);
    const all = await box.walk("workspace");
    expect(all.some((e) => e.rel === "Vendor Desk/register.csv")).toBe(true);
  });
  it("never overwrites: writeNew picks a free name", async () => {
    const a = await box.writeNew("workspace", "Outbox/report.txt", "one");
    const b = await box.writeNew("workspace", "Outbox/report.txt", "two");
    expect([a, b]).toEqual(["Outbox/report.txt", "Outbox/report (1).txt"]);
    expect(await box.readText("workspace", a)).toBe("one");
    expect(await box.readText("workspace", b)).toBe("two");
  });
  it("imports outside files by copying them in (the source is untouched)", async () => {
    const rel = await box.importFile("workspace", "Attachments", path.join(outside, "passwords.txt"));
    expect(rel).toBe("Attachments/passwords.txt");
    expect(await fs.readFile(path.join(outside, "passwords.txt"), "utf8")).toBe("hunter2");
  });
  it("reports missing files and size limits", async () => {
    expect(await code(box.readText("workspace", "missing.txt"))).toBe("not_found");
    expect(await code(box.readText("workspace", "Vendor Desk/register.csv", 2))).toBe("too_large");
  });
});
