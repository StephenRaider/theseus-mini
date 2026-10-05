import { getDocument } from "../docs/pdf.ts";
import { esc, THEMES } from "../html.ts";
import { KaveriError, type Kaveri } from "../store.ts";
import { actorOf, createSite, sendFile, str, type Req } from "./common.ts";

/** Kaveri Mail: the AP team's webmail (inbox, drafts with attachments, send-with-approval). */
export function mailSite(kaveri: Kaveri) {
  const site = createSite(kaveri, THEMES.mail([["/", "Inbox"], ["/?folder=drafts", "Drafts"], ["/?folder=sent", "Sent"], ["/compose", "Compose"]]));
  const { app, page, back } = site;

  async function attachmentBytes(id: string, name: string) {
    const key = kaveri.attachmentKey(id, name);
    if (key.startsWith("upload:")) {
      const f = kaveri.uploads.get(key);
      if (!f) throw new KaveriError(404, "NOT_FOUND", "Attachment missing");
      return { mime: f.mime, data: f.data };
    }
    const pdf = await getDocument(key);
    if (!pdf) throw new KaveriError(404, "NOT_FOUND", "Document missing");
    return { mime: "application/pdf", data: Buffer.from(pdf) };
  }

  /* ------------------------------------------------------------- API */
  app.get("/api/messages", async (req: Req) => {
    await kaveri.gate("mail.search", "read");
    return kaveri.listMail({ folder: req.query.folder, q: req.query.q });
  });
  app.get("/api/messages/:id", async (req: Req) => {
    await kaveri.gate("mail.read", "read");
    return kaveri.getMail(req.params.id!);
  });
  app.get("/api/messages/:id/attachments/:name", async (req: Req, reply) => {
    await kaveri.gate("mail.download_attachment", "read");
    const f = await attachmentBytes(req.params.id!, req.params.name!);
    return sendFile(reply, req.params.name!, f.mime, f.data);
  });
  /** JSON draft: attachments as base64 so an agent can attach files it generated. */
  app.post("/api/drafts", async (req: Req) => {
    await kaveri.gate("mail.draft_reply", "write");
    const atts = (req.body.attachments as Array<{ name: string; mime?: string; base64: string }> | undefined) ?? [];
    return kaveri.saveDraft(
      {
        to: str(req.body.to), subject: str(req.body.subject), body: str(req.body.body),
        files: atts.map((a) => ({ name: a.name, mime: a.mime ?? "application/octet-stream", data: Buffer.from(a.base64, "base64") })),
      },
      actorOf(req),
    );
  });
  app.post("/api/messages/:id/send", async (req: Req) => {
    await kaveri.gate("mail.send", "write");
    return kaveri.sendDraft(req.params.id!, str(req.body.approvedBy) || undefined);
  });

  /* ------------------------------------------------------------ HTML */
  app.get("/", async (req: Req, reply) => {
    await kaveri.gate("mail.search", "read");
    const folder = req.query.folder ?? "inbox";
    const rows = kaveri.listMail({ folder, q: req.query.q });
    return page(reply, "Mail", folder === "inbox" ? "/" : `/?folder=${folder}`, `
      <h1>${esc(folder[0]!.toUpperCase() + folder.slice(1))} <span class="muted">(${rows.length})</span></h1>
      <form class="row" method="get" action="/" role="search"><input type="hidden" name="folder" value="${esc(folder)}">
        <input name="q" aria-label="Search mail" placeholder="Search mail" value="${esc(req.query.q)}" size="40"><button>Search</button></form>
      <div class="card" style="margin-top:16px;padding:0"><table><thead><tr><th>From</th><th>Subject</th><th>📎</th><th>Received</th></tr></thead><tbody>
      ${rows.map((m) => `<tr class="${m.read ? "" : "unread"}" data-mail-id="${m.id}"><td>${esc(m.fromName)}<div class="muted mono">${esc(folder === "inbox" ? m.from : m.to)}</div></td>
        <td><a href="/m/${m.id}">${esc(m.subject)}</a></td><td>${m.attachments.length || ""}</td><td class="mono">${esc(m.receivedAt.slice(0, 16).replace("T", " "))}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">Nothing here</td></tr>'}
      </tbody></table></div>`, req.query.flash);
  });

  app.get("/m/:id", async (req: Req, reply) => {
    await kaveri.gate("mail.read", "read");
    const m = kaveri.getMail(req.params.id!);
    return page(reply, m.subject, "", `
      <p><a href="/">← Inbox</a></p><div class="card"><h1>${esc(m.subject)}</h1>
      <dl><dt>From</dt><dd>${esc(m.fromName)} &lt;<span class="mono">${esc(m.from)}</span>&gt;</dd><dt>To</dt><dd class="mono">${esc(m.to)}</dd>
      <dt>Date</dt><dd class="mono">${esc(m.receivedAt)}</dd><dt>Message id</dt><dd class="mono">${m.id}</dd></dl>
      <hr style="border:0;border-top:1px solid var(--border);margin:16px 0"><pre>${esc(m.body)}</pre>
      ${m.attachments.length ? `<h2>Attachments</h2><ul>${m.attachments.map((a) => `<li><a href="/m/${m.id}/attachments/${encodeURIComponent(a.name)}" target="_blank" download="${esc(a.name)}">${esc(a.name)}</a></li>`).join("")}</ul>` : ""}
      ${m.folder === "inbox" ? `<p><a href="/compose?to=${encodeURIComponent(m.from)}&subject=${encodeURIComponent(`Re: ${m.subject}`)}">Reply</a></p>` : ""}
      ${m.folder === "drafts" ? `<form method="post" action="/m/${m.id}/send" class="row"><button class="primary">Send</button><span class="muted">Sending outside the company needs a human sender.</span></form>` : ""}
      </div>`, req.query.flash);
  });
  app.get("/m/:id/attachments/:name", async (req: Req, reply) => {
    await kaveri.gate("mail.download_attachment", "read");
    const f = await attachmentBytes(req.params.id!, req.params.name!);
    return sendFile(reply, req.params.name!, f.mime, f.data);
  });
  app.post("/m/:id/send", async (req: Req, reply) => {
    await kaveri.gate("mail.send", "write");
    const actor = actorOf(req);
    kaveri.sendDraft(req.params.id!, actor.startsWith("user:") ? actor : undefined);
    return back(reply, "/?folder=sent", "Message sent.");
  });

  app.get("/compose", async (req: Req, reply) =>
    page(reply, "Compose", "/compose", `<h1>New message</h1><form class="card" method="post" action="/compose" enctype="multipart/form-data" style="display:grid;gap:10px;max-width:760px">
      <label>To <input name="to" type="email" required value="${esc(req.query.to)}" style="width:100%"></label>
      <label>Subject <input name="subject" required value="${esc(req.query.subject)}" style="width:100%"></label>
      <label>Message <textarea name="body" rows="12" style="width:100%"></textarea></label>
      <label>Attach files <input name="files" type="file" multiple></label>
      <div class="row"><button class="primary">Save draft</button><span class="muted">Drafts are reviewed before sending.</span></div></form>`));
  app.post("/compose", async (req, reply) => {
    await kaveri.gate("mail.draft_reply", "write");
    const fields: Record<string, string> = {};
    const files: { name: string; mime: string; data: Buffer }[] = [];
    for await (const part of req.parts()) {
      if (part.type === "file") {
        const data = await part.toBuffer();
        if (part.filename && data.length) files.push({ name: part.filename, mime: part.mimetype, data });
      } else fields[part.fieldname] = String(part.value);
    }
    const d = kaveri.saveDraft({ to: fields.to ?? "", subject: fields.subject ?? "", body: fields.body ?? "", files }, actorOf(req));
    return back(reply, `/m/${d.id}`, "Draft saved.");
  });

  return site;
}
