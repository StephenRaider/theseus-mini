import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserError, BrowserPool } from "../src/index.ts";

/** A tiny web app: a list, a form with validation, a file link and a page that re-renders. */
let server: Server;
let base = "";
const saved: Record<string, string>[] = [];

const page = (body: string) => `<!doctype html><html><head><title>Test app</title><link href="https://fonts.example/x.css" rel="stylesheet"></head><body>${body}</body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const send = (html: string, status = 200) => {
      res.writeHead(status, { "content-type": "text/html" });
      res.end(page(html));
    };
    if (req.method === "POST" && url.pathname === "/invoices") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const f = Object.fromEntries(new URLSearchParams(body));
        saved.push({ ...f, actor: String(req.headers["x-actor"] ?? "") });
        if (!/^\d{2}\/\d{2}\/\d{4}$/.test(f.due ?? "")) return send(`<div role="alert">Due date must be DD/MM/YYYY</div><a href="/new">Back</a>`, 422);
        res.writeHead(303, { location: `/?flash=${encodeURIComponent(`Saved ${f.number}`)}` });
        res.end();
      });
      return;
    }
    if (url.pathname === "/") {
      const flash = url.searchParams.get("flash");
      return send(`${flash ? `<div class="flash" role="status">${flash}</div>` : ""}<h1>Invoices</h1><nav><a href="/new">New invoice</a> <a href="https://evil.example/">Elsewhere</a></nav>
        <table><thead><tr><th>No.</th><th>Vendor</th><th>Amount</th></tr></thead><tbody>
        <tr><td>INV-1</td><td>Hosur Steel</td><td>1,000 <a href="/inv/1">open</a></td></tr></tbody></table>
        <p>Total: <b>1</b> invoice. <a href="/file.pdf">Download register</a></p>`);
    }
    if (url.pathname === "/new")
      return send(`<h1>New invoice</h1><form method="post" action="/invoices" aria-label="Invoice">
        <label for="n">Invoice number</label><input id="n" name="number" required>
        <label>Due date <input name="due" placeholder="DD/MM/YYYY"></label>
        <label for="v">Vendor</label><select id="v" name="vendor"><option value="">— choose —</option><option value="V-1">Hosur Steel Fabricators</option><option value="V-2">Hosur Cement Works</option><option value="V-3">Arka Solar</option></select>
        <label><input type="checkbox" name="urgent"> Urgent</label>
        <button type="submit">Save invoice</button></form>`);
    if (url.pathname === "/confirm") return send(`<h1>Confirm</h1><button onclick="if(confirm('Really post?')) document.body.insertAdjacentHTML('beforeend','<p>Posted</p>')">Post</button>`);
    if (url.pathname === "/rerender")
      return send(`<h1>Re-render</h1><div id="box"><button>Alpha</button></div><button onclick="document.getElementById('box').innerHTML='<p>new</p><button>Alpha</button>'">Shuffle</button><p id="out"></p>
        <script>document.addEventListener('click',e=>{if(e.target.textContent==='Alpha')document.getElementById('out').textContent='alpha clicked'})</script>`);
    if (url.pathname === "/file.pdf") {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="register.pdf"' });
      return res.end("%PDF-1.4 fake");
    }
    send("<h1>Not found</h1>", 404);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

const pool = () => new BrowserPool({ allowOrigins: [base] });
let shared: BrowserPool;
beforeAll(() => {
  shared = pool();
});
afterAll(async () => {
  await shared?.close();
  server?.close();
});

describe("browser session (real Chromium)", () => {
  it("shows a page as an outline with refs: headings, tables, links, alerts", async () => {
    const s = await shared.session("a");
    const o = await s.open(`${base}/?flash=Hello`);
    expect(o.status).toBe(200);
    expect(o.outline).toContain("[alert] Hello");
    expect(o.outline).toContain("# Invoices");
    expect(o.outline).toMatch(/\| INV-1 \| Hosur Steel \| 1,000 \[e\d+\] link "open" → \/inv\/1 \|/);
    expect(o.outline).toMatch(/\[e\d+\] link "New invoice" → \/new/);
  });

  it("fills and submits a form; the server sees the agent's identity; validation errors come back as alerts", async () => {
    const p = new BrowserPool({ allowOrigins: [base] });
    try {
      const s = await p.session("emp_9", { "x-actor": "agent:emp_9" });
      let o = await s.open(`${base}/new`);
      expect(o.outline).toContain('form "Invoice" (POST /invoices):');
      const ref = (role: string, name: string) => Object.entries(s.refs).find(([, r]) => r.role === role && r.name === name)?.[0]!;
      expect(o.outline).toMatch(/textbox "Invoice number" value="" \(required\)/);
      await s.type(ref("textbox", "Invoice number"), "INV-9");
      await s.type(ref("textbox", "Due date"), "2026-10-31");
      // Partial option text is fine when unique; ambiguous text is refused.
      await expect(s.select(ref("select", "Vendor"), "hosur")).rejects.toThrow(/several options/);
      o = await s.select(ref("select", "Vendor"), "Hosur Steel");
      expect(o.outline).toMatch(/selected="Hosur Steel Fabricators"/);
      const info = await s.describe(ref("button", "Save invoice"));
      expect(info.form?.method).toBe("post");
      expect(info.form?.fields.find((f) => f.name === "vendor")?.value).toBe("Hosur Steel Fabricators");
      o = await s.click(ref("button", "Save invoice"));
      expect(o.navigated).toBe(true);
      expect(o.status).toBe(422);
      expect(o.outline).toContain("[alert] Due date must be DD/MM/YYYY");
      expect(saved.at(-1)).toMatchObject({ number: "INV-9", vendor: "V-1", actor: "agent:emp_9" });
      // Fix it and resubmit: lands on the list with a confirmation.
      await s.back();
      o = await s.look();
      await s.type(ref("textbox", "Due date"), "31/10/2026");
      o = await s.click(ref("button", "Save invoice"));
      expect(o.outline).toContain("[alert] Saved INV-9");
    } finally {
      await p.close();
    }
  });

  it("refuses to leave the allowed sites", async () => {
    const s = await shared.session("b");
    await expect(s.open("https://evil.example/")).rejects.toMatchObject({ kind: "blocked" });
    const o = await s.open(`${base}/`);
    const ref = Object.entries(s.refs).find(([, r]) => r.name === "Elsewhere")![0];
    await expect(s.click(ref)).rejects.toBeInstanceOf(BrowserError);
    expect(o.url).toContain(base);
  });

  it("finds an element again after the page re-renders, and reports a truly stale ref", async () => {
    const s = await shared.session("c");
    await s.open(`${base}/rerender`);
    const alpha = Object.entries(s.refs).find(([, r]) => r.name === "Alpha")![0];
    const shuffle = Object.entries(s.refs).find(([, r]) => r.name === "Shuffle")![0];
    await s.click(shuffle); // replaces the Alpha button (its ref attribute is gone)
    const o = await s.click(alpha, { role: "button", name: "Alpha" });
    expect(o.outline).toContain("alpha clicked");
    await expect(s.click("e999", { role: "button", name: "Nope" })).rejects.toMatchObject({ kind: "stale_ref" });
  });

  it("accepts a confirm dialog and reports its text; captures downloads", async () => {
    const s = await shared.session("d");
    await s.open(`${base}/confirm`);
    const post = Object.entries(s.refs).find(([, r]) => r.name === "Post")![0];
    const o = await s.click(post);
    expect(o.dialog).toBe("Really post?");
    expect(o.outline).toContain("Posted");
    await s.open(`${base}/`);
    const dl = Object.entries(s.refs).find(([, r]) => r.name === "Download register")![0];
    const o2 = await s.click(dl);
    expect(o2.download?.name).toBe("register.pdf");
    expect(o2.download?.bytes.toString()).toContain("%PDF");
  });
});
