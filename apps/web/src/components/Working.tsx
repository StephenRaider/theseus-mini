/**
 * Show working: every line of the final report with the sources behind it,
 * and a plain-language chain of facts -> evidence -> tool call. Where nothing
 * was recorded, it says so rather than guessing.
 */
import type { Evidence, Task } from "@theseus/protocol";
import { useMemo, useState } from "react";
import { bridge } from "../bridge.ts";
import { clock } from "../state/selectors.ts";
import type { AppState, ToolCallView } from "../state/store.ts";
import { basename, describeEvidence, humanTool, linkReport, lineHasSource, reportOf, sourceTarget, workingRows, type ReportLine } from "../state/trust.ts";
import { Tag, alertish } from "./ui.tsx";
import { Empty } from "./Work.tsx";

const TONE = { pass: "green", fail: "red", uncertain: "yellow" } as const;

export function Working({ state, task }: { state: AppState; task: Task }) {
  const lines = useMemo(() => linkReport(state, task.id), [state, task.id]);
  const rows = useMemo(() => workingRows(state, task.id), [state, task.id]);
  const [open, setOpen] = useState<string | null>(null);
  const report = reportOf(state, task.id);

  if (!report && !rows.length) return <Empty title="No working to show yet" text="Once this employee has read something or reported back, each line links to where it came from." />;

  return (
    <div className="working">
      {report ? (
        <section>
          <div className="section-title">Final answer, line by line</div>
          <div className="working__report">
            {lines.map((l, i) =>
              l.kind === "heading" ? (
                <div key={i} className="working__heading">
                  {l.text}
                </div>
              ) : (
                <ReportRow key={i} line={l} state={state} open={open === String(i)} onToggle={() => setOpen(open === String(i) ? null : String(i))} />
              ),
            )}
          </div>
        </section>
      ) : null}

      <section>
        <div className="section-title">What I looked at</div>
        {rows.length ? (
          rows.map((r) => (
            <div className="chain" key={r.evidence.id}>
              <div className="chain__sentence">{describeEvidence(r.evidence)}</div>
              {r.facts.length ? (
                <ul className="chain__facts">
                  {r.facts.map((f) => (
                    <li key={f.key}>
                      <span>{f.key}</span> <b>{f.value}</b>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="chain__meta">
                {r.calls.length ? r.calls.map((c) => <span key={c.callId} className="chain__call">{callSentence(c)}</span>) : <span className="chain__none">no tool call recorded for this</span>}
              </div>
              {r.supports.length ? <div className="chain__meta">Backs: {r.supports.join("; ")}</div> : null}
              <SourceButton evidence={r.evidence} />
            </div>
          ))
        ) : (
          <div className="working__none">No evidence was recorded for this task.</div>
        )}
      </section>
    </div>
  );
}

export function callSentence(c: ToolCallView): string {
  const arg = typeof c.input === "string" ? c.input : c.input && typeof c.input === "object" ? Object.values(c.input as Record<string, unknown>).find((v) => typeof v === "string") : undefined;
  const status = c.done ? (c.done.ok ? "worked" : `failed${c.done.error ? `: ${c.done.error}` : ""}`) : "still running";
  return `Used ${humanTool(c.tool)}${typeof arg === "string" ? ` on ${arg.length > 50 ? `…${arg.slice(-48)}` : arg}` : ""} at ${clock(c.at)} (${status})`;
}

function ReportRow({ line, state, open, onToggle }: { line: ReportLine; state: AppState; open: boolean; onToggle: () => void }) {
  const has = lineHasSource(line);
  return (
    <div className={`rline ${has ? "" : "rline--none"}`}>
      <button className="rline__text" onClick={onToggle} aria-expanded={open}>
        <span>{line.text}</span>
        {has ? (
          <Tag tone="accent">
            {line.evidenceIds.length + line.callIds.length + line.criteria.length} source{line.evidenceIds.length + line.callIds.length + line.criteria.length === 1 ? "" : "s"}
          </Tag>
        ) : (
          <Tag>no source recorded</Tag>
        )}
      </button>
      {open ? (
        <div className="rline__sources">
          {!has ? <div className="working__none">Nothing in the record ties this line to a document, record or tool call.</div> : null}
          {line.evidenceIds.map((id) => {
            const ev = state.evidence[id];
            return ev ? (
              <div key={id} className="src">
                <div>{describeEvidence(ev)}</div>
                <SourceButton evidence={ev} />
              </div>
            ) : null;
          })}
          {line.callIds.map((id) => {
            const c = state.toolCalls[id];
            return c ? (
              <div key={id} className="src">
                {callSentence(c)}
                {c.done?.preview ? <div className="src__preview mono">{c.done.preview}</div> : null}
              </div>
            ) : null;
          })}
          {line.criteria.map((c) => (
            <div key={c.criterionId} className="src">
              <Tag tone={TONE[c.verdict]}>{c.verdict}</Tag> Checked: {c.text}. {c.detail}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Open the document/file, web page or record behind a piece of evidence. */
export function SourceButton({ evidence }: { evidence: Evidence }) {
  const [shown, setShown] = useState(false);
  const target = sourceTarget(evidence);
  const b = bridge();
  const onOpen = () => {
    if (target.kind === "file" && b) b.open(target.rootId, target.rel).catch(alertish);
    else setShown((v) => !v);
  };
  if (target.kind === "url")
    return (
      <a className="btn btn--small" href={target.href} target="_blank" rel="noreferrer noopener">
        Open page
      </a>
    );
  return (
    <>
      <button className="btn btn--small" onClick={onOpen} title={evidence.source}>
        {target.kind === "file" && b ? `Open ${basename(evidence.source)}` : shown ? "Hide details" : "Show details"}
      </button>
      {shown ? (
        <div className="src__detail">
          <div>
            <b>{evidence.kind.replace("_", " ")}</b> · <span className="mono">{evidence.source}</span>
          </div>
          {target.kind === "image" ? <img className="src__img" src={target.src} alt={evidence.summary} /> : null}
          {evidence.ref ? <div className="mono">{evidence.ref}</div> : null}
          {evidence.fields ? <pre className="src__fields">{JSON.stringify(evidence.fields, null, 2)}</pre> : null}
        </div>
      ) : null}
    </>
  );
}
