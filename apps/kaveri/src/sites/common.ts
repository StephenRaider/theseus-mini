import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { errorPage, layout, type Theme } from "../html.ts";
import { KaveriError, type Kaveri } from "../store.ts";

export type Body = Record<string, unknown>;
export type Req = FastifyRequest<{ Params: Record<string, string>; Querystring: Record<string, string>; Body: Body }>;

/** Ports of the separate sites (one Node process, many "systems"). */
export const PORTS = {
  control: 4100,
  mail: 4101,
  erp: 4102,
  bank: 4103,
  gst: 4104,
  udyam: 4105,
  eproc: 4106,
} as const;
export type SiteKey = keyof typeof PORTS;
export const siteUrl = (k: SiteKey, host = "localhost") => `http://${host}:${PORTS[k]}`;

/**
 * Who is acting. Agents send `x-actor: agent:<employee id>` (the harness sets
 * it on API calls AND on its browser), the web UI otherwise acts as the human
 * user `user:web`. The world's rules (maker-checker etc.) depend on it.
 */
export const actorOf = (req: FastifyRequest) => String(req.headers["x-actor"] ?? "user:web");
export const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

export interface Site {
  app: FastifyInstance;
  theme: Theme;
  page: (reply: FastifyReply, title: string, active: string, body: string, flash?: string) => FastifyReply;
  back: (reply: FastifyReply, to: string, flash: string) => FastifyReply;
}

export function createSite(kaveri: Kaveri, theme: Theme): Site {
  const app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 });
  app.register(formbody);
  app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 10 } });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const e =
      err instanceof KaveriError
        ? err
        : new KaveriError(err.statusCode ?? 500, err.statusCode && err.statusCode < 500 ? "BAD_REQUEST" : "INTERNAL", err.message);
    if (req.url.startsWith("/api") || req.url.startsWith("/__admin")) return reply.status(e.status).send({ error: { code: e.code, message: e.message } });
    return reply.status(e.status).type("text/html").send(errorPage(theme, e.status, e.code, e.message));
  });

  return {
    app,
    theme,
    page: (reply, title, active, body, flash) => reply.type("text/html").send(layout(theme, title, active, body, flash)),
    back: (reply, to, flash) => reply.redirect(`${to}${to.includes("?") ? "&" : "?"}flash=${encodeURIComponent(flash)}`),
  };
}

/** Send generated/uploaded document bytes inline. */
export function sendFile(reply: FastifyReply, name: string, mime: string, data: Uint8Array | Buffer) {
  return reply.type(mime).header("content-disposition", `inline; filename="${name.replace(/"/g, "")}"`).send(Buffer.from(data));
}
