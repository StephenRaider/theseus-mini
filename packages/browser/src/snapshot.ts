/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * What the agent "sees" of a web page: a compact text outline of the page
 * (headings, text, tables, forms) in which every element it can act on carries
 * a short ref like [e12]. The model answers "click e12" instead of guessing
 * CSS selectors or pixel positions, which is far more reliable for a weak
 * model and costs a fraction of a screenshot's tokens.
 *
 * Both functions below run INSIDE the page (page.evaluate), so they must be
 * self-contained: no imports, no closures over module scope.
 */

export interface RefInfo {
  role: string;
  name: string;
}

export interface OutlineResult {
  text: string;
  refs: Record<string, RefInfo>;
  truncated: boolean;
}

export interface ElementInfo {
  ref: string;
  role: string;
  name: string;
  tag: string;
  type?: string;
  href?: string;
  /** The form the element would submit (method/action honour formmethod/formaction). */
  form?: { method: string; action: string; fields: { name: string; label: string; value: string }[] };
  /** Text of the table row the element sits in (e.g. the record a "Hold" button acts on). */
  row?: string;
  heading?: string;
  title: string;
  url: string;
}

export const REF_ATTR = "data-tref";

/** Build the outline and (re)assign refs. Runs in the page. */
export function outlineInPage(opts: { maxChars: number; maxRows: number; maxOptions: number }): OutlineResult {
  const ATTR = "data-tref";
  for (const el of Array.from(document.querySelectorAll(`[${ATTR}]`))) el.removeAttribute(ATTR);
  let n = 0;
  const refs: Record<string, { role: string; name: string }> = {};
  const lines: string[] = [];
  let size = 0;
  let truncated = false;

  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const clip = (s: string, m = 160) => (s.length > m ? `${s.slice(0, m - 1)}…` : s);
  const q = (s: string) => `"${clip(s).replace(/"/g, "'")}"`;
  const BLOCK = "div,p,table,form,ul,ol,li,section,article,header,footer,nav,main,aside,h1,h2,h3,h4,h5,h6,dl,dt,dd,tr,fieldset,pre,details";

  const visible = (el: Element): boolean => {
    if ((el as HTMLElement).hidden || el.getAttribute("aria-hidden") === "true") return false;
    if (el instanceof HTMLInputElement && el.type === "hidden") return false;
    const st = getComputedStyle(el);
    return st.display !== "none" && st.visibility !== "hidden";
  };

  const ownText = (label: Element): string => {
    let t = "";
    for (const c of Array.from(label.childNodes)) {
      if (c.nodeType === Node.TEXT_NODE) t += ` ${c.textContent ?? ""}`;
      else if (c instanceof Element && !c.matches("input,select,textarea,button")) t += ` ${c.textContent ?? ""}`;
    }
    return clean(t);
  };

  const labelOf = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = clean(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" "));
      if (t) return t;
    }
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return ownText(l);
    }
    const wrap = el.closest("label");
    if (wrap) {
      const t = ownText(wrap);
      if (t) return t;
    }
    return clean(el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || "");
  };

  const isControl = (el: Element) =>
    el.matches("a[href],button,input,select,textarea,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem]");

  const token = (el: Element): string => {
    const ref = `e${++n}`;
    el.setAttribute(ATTR, ref);
    let role = "";
    let name = "";
    let extra = "";
    if (el instanceof HTMLAnchorElement || el.getAttribute("role") === "link") {
      role = "link";
      name = clean(el.textContent) || clean(el.getAttribute("aria-label")) || clean(el.getAttribute("title")) || clean(el.querySelector("img")?.getAttribute("alt"));
      const href = el.getAttribute("href") ?? "";
      if (href && !href.startsWith("javascript:")) {
        const u = new URL(href, location.href);
        extra = ` → ${u.origin === location.origin ? `${u.pathname}${u.search}` : u.href}`;
      }
    } else if (el instanceof HTMLSelectElement) {
      role = "select";
      name = labelOf(el);
      const opts = Array.from(el.options);
      const sel = el.selectedOptions[0];
      const shown = opts.slice(0, 25).map((o) => q(clean(o.textContent)));
      extra = ` selected=${q(clean(sel?.textContent))} options: ${shown.join(" | ")}${opts.length > 25 ? ` | … (${opts.length} options; select by name)` : ""}`;
    } else if (el instanceof HTMLTextAreaElement) {
      role = "textbox";
      name = labelOf(el);
      extra = ` value=${q(el.value)} (multi-line)${el.required ? " (required)" : ""}`;
    } else if (el instanceof HTMLInputElement) {
      const t = el.type.toLowerCase();
      if (t === "submit" || t === "button" || t === "reset" || t === "image") {
        role = "button";
        name = clean(el.value) || labelOf(el);
      } else if (t === "checkbox" || t === "radio") {
        role = t;
        name = labelOf(el);
        extra = el.checked ? " checked" : " unchecked";
      } else if (t === "file") {
        role = "file";
        name = labelOf(el);
        extra = el.files?.length ? ` attached=${q(Array.from(el.files).map((f) => f.name).join(", "))}` : " (no file)";
      } else {
        role = "textbox";
        name = labelOf(el);
        extra = ` value=${q(t === "password" ? (el.value ? "••••" : "") : el.value)}${t !== "text" ? ` (${t})` : ""}${el.required ? " (required)" : ""}`;
      }
      if (el.disabled) extra += " (disabled)";
    } else {
      role = el.getAttribute("role") === "checkbox" ? "checkbox" : el.getAttribute("role") === "tab" ? "tab" : "button";
      name = clean(el.textContent) || clean(el.getAttribute("aria-label")) || clean(el.getAttribute("title"));
      if ((el as HTMLButtonElement).disabled) extra += " (disabled)";
    }
    refs[ref] = { role, name };
    return `[${ref}] ${role} ${q(name)}${extra}`;
  };

  /** One line for an element whose content is all inline (text, links, buttons, fields). */
  const inline = (el: Element): string => {
    const parts: string[] = [];
    for (const c of Array.from(el.childNodes)) {
      if (c.nodeType === Node.TEXT_NODE) {
        const t = clean(c.textContent);
        if (t) parts.push(t);
      } else if (c instanceof Element) {
        if (!visible(c) || c.matches("script,style,template,noscript")) continue;
        if (isControl(c)) parts.push(token(c));
        else if (c.tagName === "LABEL" && c.querySelector("input,select,textarea")) parts.push(inline(c).replace(ownText(c), "").trim());
        else if (c.tagName === "LABEL" && (c as HTMLLabelElement).htmlFor) continue; // shown with its control
        else if (c.tagName === "BR") parts.push("·");
        else parts.push(inline(c));
      }
    }
    return clean(parts.filter(Boolean).join(" "));
  };

  const push = (depth: number, text: string) => {
    if (!text || truncated) return;
    const line = `${"  ".repeat(depth)}${text}`;
    if (size + line.length > opts.maxChars) {
      truncated = true;
      return;
    }
    size += line.length + 1;
    lines.push(line);
  };

  const table = (t: HTMLTableElement, depth: number) => {
    const rows = Array.from(t.rows).filter(visible);
    const cap = t.caption ? clean(t.caption.textContent) : "";
    push(depth, `table${cap ? ` ${q(cap)}` : ""} (${rows.length} rows):`);
    rows.slice(0, opts.maxRows).forEach((r) => {
      const cells = Array.from(r.cells).filter(visible).map((c) => inline(c) || "·");
      push(depth + 1, `| ${cells.join(" | ")} |`);
    });
    if (rows.length > opts.maxRows) push(depth + 1, `… ${rows.length - opts.maxRows} more rows not shown (search or filter to narrow it down)`);
  };

  const walk = (el: Element, depth: number) => {
    if (truncated || !visible(el) || el.matches("script,style,template,noscript,svg")) return;
    const role = el.getAttribute("role");
    if (role === "alert" || role === "status" || el.classList.contains("flash")) {
      push(depth, `[alert] ${inline(el)}`);
      return;
    }
    if (isControl(el)) return push(depth, token(el));
    if (el instanceof HTMLTableElement) return table(el, depth);
    if (el instanceof HTMLFormElement) {
      const method = (el.getAttribute("method") || "get").toUpperCase();
      const action = new URL(el.getAttribute("action") || location.href, location.href);
      const name = clean(el.getAttribute("aria-label") || el.getAttribute("name") || el.id || "");
      push(depth, `form${name ? ` ${q(name)}` : ""} (${method} ${action.pathname}):`);
      for (const c of Array.from(el.children)) walk(c, depth + 1);
      return;
    }
    if (el instanceof HTMLDListElement) {
      let term = "";
      for (const c of Array.from(el.children)) {
        if (c.tagName === "DT") term = inline(c);
        else if (c.tagName === "DD") push(depth, `${term}: ${inline(c)}`);
      }
      return;
    }
    const hasBlocks = !!el.querySelector(BLOCK);
    if (!hasBlocks) {
      const t = inline(el);
      if (!t) return;
      const h = /^H([1-6])$/.exec(el.tagName);
      push(depth, h ? `${"#".repeat(Number(h[1]))} ${t}` : el.tagName === "LI" ? `- ${t}` : t);
      return;
    }
    // Mixed content: loose text between blocks becomes its own line.
    const h = /^H([1-6])$/.exec(el.tagName);
    let buf: string[] = [];
    const flush = () => {
      const t = clean(buf.join(" "));
      if (t) push(depth, h ? `${"#".repeat(Number(h[1]))} ${t}` : t);
      buf = [];
    };
    for (const c of Array.from(el.childNodes)) {
      if (c.nodeType === Node.TEXT_NODE) buf.push(c.textContent ?? "");
      else if (c instanceof Element) {
        if (c.matches(BLOCK) || c.querySelector(BLOCK)) {
          flush();
          walk(c, depth);
        } else if (visible(c)) buf.push(isControl(c) ? token(c) : inline(c));
      }
    }
    flush();
  };

  walk(document.body, 0);
  return { text: lines.join("\n"), refs, truncated };
}

/** Everything the gateway needs to judge an action on one element. Runs in the page. */
export function describeInPage(ref: string): Omit<ElementInfo, "role" | "name"> & { found: boolean } {
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const el = document.querySelector(`[data-tref="${ref}"]`);
  const base = { ref, tag: "", title: document.title, url: location.href, heading: clean(document.querySelector("h1")?.textContent) };
  if (!el) return { ...base, found: false };
  const form = (el as HTMLButtonElement).form ?? el.closest("form");
  let f: ElementInfo["form"];
  if (form) {
    const method = (el.getAttribute("formmethod") || form.getAttribute("method") || "get").toLowerCase();
    const action = new URL(el.getAttribute("formaction") || form.getAttribute("action") || location.href, location.href).href;
    const fields = Array.from(form.elements)
      .filter((x): x is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement => x instanceof HTMLInputElement || x instanceof HTMLSelectElement || x instanceof HTMLTextAreaElement)
      .filter((x) => !(x instanceof HTMLInputElement) || !["submit", "button", "reset", "file", "password"].includes(x.type))
      .map((x) => {
        const label = x.id ? clean(document.querySelector(`label[for="${CSS.escape(x.id)}"]`)?.textContent) : "";
        const value = x instanceof HTMLSelectElement ? clean(x.selectedOptions[0]?.textContent) || x.value : x instanceof HTMLInputElement && (x.type === "checkbox" || x.type === "radio") ? (x.checked ? x.value || "on" : "") : x.value;
        return { name: x.name, label: label || clean(x.getAttribute("aria-label")) || x.name, value };
      });
    f = { method, action, fields };
  }
  const href = el instanceof HTMLAnchorElement ? el.href : undefined;
  const type = el instanceof HTMLInputElement || el instanceof HTMLButtonElement ? el.type : undefined;
  const row = clean(el.closest("tr")?.textContent);
  return { ...base, found: true, tag: el.tagName.toLowerCase(), ...(type ? { type } : {}), ...(href ? { href } : {}), ...(f ? { form: f } : {}), ...(row ? { row } : {}) };
}
