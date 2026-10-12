// Renders the pictures in the messy Incoming folder (apps/kaveri/assets/scans/*.png).
// Run once with: node packages/browser/scripts/render-scans.mjs   (the PNGs are committed)
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { SCANS, scanPath } from "../../../apps/kaveri/src/intake.ts";

const exe = process.env.CHROMIUM_PATH ?? (process.env.PLAYWRIGHT_BROWSERS_PATH ? `${process.env.PLAYWRIGHT_BROWSERS_PATH}/chromium` : undefined);
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const THEME = { pan: ["#dfe9f5", "#1b3b6f"], gst: ["#f6efd9", "#6b4a12"], cheque: ["#e9f3e4", "#245a2b"] };
const tilt = { pan: -1.1, gst: 0.7, cheque: -0.6 };

const html = (s) => {
  const [bg, ink] = THEME[s.kind];
  const rows = s.lines.map((l) => { const i = l.indexOf(": "); return i > 0 ? `<div class=r><span class=k>${esc(l.slice(0, i))}</span><span class=v>${esc(l.slice(i + 2))}</span></div>` : `<div class=big>${esc(l)}</div>`; }).join("");
  return `<body style="margin:0;background:#8d8d88;width:900px;height:560px;display:flex;align-items:center;justify-content:center;font-family:Arial,sans-serif">
<style>.card{width:780px;padding:28px 36px;background:${bg};color:${ink};transform:rotate(${tilt[s.kind]}deg);box-shadow:0 6px 18px #0006;position:relative}
.t{font-weight:700;letter-spacing:.06em;font-size:19px;border-bottom:2px solid ${ink};padding-bottom:10px;margin-bottom:14px}
.r{display:flex;font-size:21px;margin:11px 0}.k{width:330px;opacity:.75}.v{font-weight:700;font-family:'Courier New',monospace}.big{font-size:44px;opacity:.25;font-weight:700;margin:6px 0;letter-spacing:.2em}
.g{position:absolute;inset:0;background:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'><filter id='n'><feTurbulence baseFrequency='.9' numOctaves='2'/><feColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 .11 0'/></filter><rect width='300' height='300' filter='url(%23n)'/></svg>")}</style>
<div class=card><div class=t>${esc(s.title)}</div>${rows}<div class=g></div></div></body>`;
};

const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
mkdirSync(new URL("../../../apps/kaveri/assets/scans", import.meta.url), { recursive: true });
for (const s of SCANS) {
  await page.setContent(html(s));
  await page.screenshot({ path: scanPath(s), type: "png" });
  console.log("rendered", s.file);
}
await browser.close();
