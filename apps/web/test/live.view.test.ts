import { describe, expect, it } from "vitest";
import { latestBrowserAction } from "../src/state/frames.ts";

describe("live browser view: what the employee is doing, in words", () => {
  const calls = {
    a: { taskId: "t1", tool: "browser.open", input: { url: "http://findesk/invoices/new" }, at: "2026-10-12T10:00:01Z" },
    b: { taskId: "t1", tool: "browser.fill_form", input: { e1: "x", e2: "y" }, at: "2026-10-12T10:00:02Z" },
    c: { taskId: "t1", tool: "browser.click", input: { ref: "e9", about: "Save as draft" }, at: "2026-10-12T10:00:03Z" },
    d: { taskId: "t2", tool: "browser.open", input: { url: "http://other" }, at: "2026-10-12T10:00:04Z" },
    e: { taskId: "t1", tool: "files.read_text", input: { path: "x.pdf" }, at: "2026-10-12T10:00:05Z" },
  };
  it("describes the newest browser action of that task only", () => {
    expect(latestBrowserAction(calls, "t1")).toBe('Clicking "Save as draft"');
    expect(latestBrowserAction(calls, "t2")).toBe("Opening http://other");
    expect(latestBrowserAction({ b: calls.b }, "t1")).toBe("Filling in the form (2 fields)");
    expect(latestBrowserAction(calls, "none")).toBeUndefined();
    expect(latestBrowserAction(calls, undefined)).toBeUndefined();
  });
});
