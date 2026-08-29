import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { explainCategory, summarize, verdictLabel, verdictTone } from "./copy.js";
import { GROUP_LABELS, PRESETS, type Preset } from "./presets.js";
import { resetConversation, runEngine, type TraceEntry } from "./engine.js";
import { normalize } from "@bouncer/core";
import type { BookingStage, SenderRole } from "@bouncer/core";

const CONVERSATION_ID = "playground";

type Theme = "light" | "dark";

function getInitialTheme(): Theme {
  const fromUrl = new URLSearchParams(window.location.search).get("theme");
  if (fromUrl === "light" || fromUrl === "dark") return fromUrl;
  const saved = localStorage.getItem("gk-theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function App(): JSX.Element {
  const [entries, setEntries] = useState<TraceEntry[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [role, setRole] = useState<SenderRole>("guest");
  const [stage, setStage] = useState<BookingStage>("pre_booking");
  const [busy, setBusy] = useState(false);
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("gk-theme", theme);
  }, [theme]);

  const send = useCallback(
    async (text: string, asRole = role, asStage = stage) => {
      const trimmed = text.trim();
      if (trimmed === "" || busy) return;

      setBusy(true);
      try {
        const entry = await runEngine(trimmed, asRole, asStage, CONVERSATION_ID);
        setEntries((prev) => [...prev, entry]);
        setDraft("");
        // Open the newest result automatically so the reason is visible
        // without an extra click — that's the whole point of trying it.
        setOpenId(entry.id);
      } finally {
        setBusy(false);
      }
    },
    [busy, role, stage],
  );

  const usePreset = useCallback(
    (preset: Preset) => {
      if (preset.role !== undefined) setRole(preset.role);
      if (preset.stage !== undefined) setStage(preset.stage);
      void send(preset.text, preset.role ?? role, preset.stage ?? stage);
    },
    [role, send, stage],
  );

  const reset = useCallback(() => {
    resetConversation();
    setEntries([]);
    setOpenId(null);
  }, []);

  // Land on a worked example rather than an empty inbox.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    void (async () => {
      // One innocent message and one evasion, so the first screen shows both
      // outcomes rather than only what gets stopped.
      await send("the villa is ₹98,765 for 5 nights, 4 adults 2 kids", "host", "pre_booking");
      await send(PRESETS[0]!.text, "guest", "pre_booking");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries.length]);

  const totals = useMemo(() => {
    const cost = entries.reduce((sum, e) => sum + e.result.cost_usd, 0);
    const stopped = entries.filter((e) => e.result.verdict !== "allow").length;
    return { cost, stopped, count: entries.length };
  }, [entries]);

  const grouped = useMemo(() => {
    const map = new Map<Preset["group"], Preset[]>();
    for (const preset of PRESETS) {
      const list = map.get(preset.group) ?? [];
      list.push(preset);
      map.set(preset.group, list);
    }
    return [...map];
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            G
          </span>
          <span className="brand-name">Bouncer</span>
          <span className="brand-tag">catches shared contact info &amp; unsafe messages</span>
        </div>
        <div className="topbar-spacer" />
        <div className="stats-strip">
          <span>
            <b>{totals.count}</b> checked
          </span>
          <span>
            <b>{totals.stopped}</b> stopped
          </span>
        </div>
        <button
          className="theme-toggle"
          onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
          aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
        >
          {theme === "light" ? <MoonIcon /> : <SunIcon />}
        </button>
      </header>

      <div className="body">
        <aside className="sidebar">
          <h2 className="sidebar-title">Try a message</h2>
          {grouped.map(([group, presets]) => (
            <div className="sidebar-group" key={group}>
              <h3 className="sidebar-group-title">{GROUP_LABELS[group]}</h3>
              {presets.map((preset) => (
                <button className="preset-btn" key={preset.label} onClick={() => usePreset(preset)} disabled={busy}>
                  <span className="preset-btn-label">
                    <span className="preset-dot" data-kind={preset.group} aria-hidden="true" />
                    {preset.label}
                  </span>
                  <span className="preset-btn-note">{preset.note}</span>
                </button>
              ))}
            </div>
          ))}
        </aside>

        <main className="main">
          <div className="toolbar">
            <div className="pillgroup" role="group" aria-label="Who's sending">
              {(["guest", "host"] as const).map((r) => (
                <button key={r} aria-pressed={role === r} onClick={() => setRole(r)}>
                  {r === "guest" ? "Guest" : "Host"}
                </button>
              ))}
            </div>
            <div className="pillgroup" role="group" aria-label="Booking stage">
              {(["pre_booking", "post_booking"] as const).map((s) => (
                <button key={s} aria-pressed={stage === s} onClick={() => setStage(s)}>
                  {s === "pre_booking" ? "Before booking" : "After booking"}
                </button>
              ))}
            </div>
            <div className="toolbar-spacer" />
            <button className="clear-btn" onClick={reset} disabled={entries.length === 0}>
              Clear chat
            </button>
          </div>

          <div className="thread-scroll">
            {entries.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon" aria-hidden="true">
                  💬
                </div>
                <h3>Nothing sent yet</h3>
                <p>Pick a message on the left, or write your own below.</p>
              </div>
            ) : (
              <div className="thread">
                {entries.map((entry) => (
                  <Message
                    key={entry.id}
                    entry={entry}
                    open={entry.id === openId}
                    onToggle={() => setOpenId((cur) => (cur === entry.id ? null : entry.id))}
                  />
                ))}
                <div ref={threadEndRef} />
              </div>
            )}
          </div>

          <div className="composer-wrap">
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                void send(draft);
              }}
            >
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send(draft);
                  }
                }}
                placeholder={`Write a message as ${role === "guest" ? "the guest" : "the host"}…`}
                aria-label="Message"
                rows={1}
              />
              <button className="send-btn" type="submit" disabled={busy || draft.trim() === ""} aria-label="Send">
                <SendIcon />
              </button>
            </form>
            <p className="composer-hint">Runs in your browser — nothing is sent to a server.</p>
          </div>
        </main>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- message -- */

function Message({
  entry,
  open,
  onToggle,
}: {
  entry: TraceEntry;
  open: boolean;
  onToggle: () => void;
}): JSX.Element {
  const { result, action } = entry;
  const withheld = action.deliveredText === null;
  const tone = verdictTone(result.verdict);

  return (
    <div className="row" data-role={entry.role}>
      <div className="row-meta">
        <span>{entry.role === "guest" ? "Guest" : "Host"}</span>
        <span>·</span>
        <span>{entry.stage === "pre_booking" ? "before booking" : "after booking"}</span>
      </div>

      {/* Always show what the sender actually typed. Replacing it with system
          copy hides the very thing the demo exists to show, and reads as if
          the user had sent "This message wasn't delivered." */}
      <div className={`bubble${withheld ? " is-withheld" : action.action === "mask" ? " is-masked" : ""}`}>
        {withheld ? entry.text : renderMasked(action.deliveredText ?? entry.text)}
      </div>

      {withheld && <p className="delivery-note">Not sent to the other person</p>}

      <div className="verdict-row">
        <button className="verdict-btn" data-tone={tone} aria-expanded={open} onClick={onToggle}>
          <VerdictIcon tone={tone} />
          {verdictLabel(result.verdict)}
          <ChevronIcon />
        </button>
      </div>

      {open && <WhyPanel entry={entry} />}
    </div>
  );
}

/** Render mask characters as a subtly highlighted run, so it reads as "hidden" not "typo". */
function renderMasked(text: string): React.ReactNode {
  const parts = text.split(/(•+)/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) => (part.startsWith("•") ? <mark key={i}>{part}</mark> : part));
}

/* -------------------------------------------------------------- why panel */

function WhyPanel({ entry }: { entry: TraceEntry }): JSX.Element {
  const { result } = entry;
  const [showAdvanced, setShowAdvanced] = useState(false);
  const views = useMemo(() => normalize(entry.text), [entry.text]);

  const reasons = result.categories.map(explainCategory);
  const crossMessage = (result.signals["cross_message_categories"] as string[] | undefined) ?? [];
  const tone = verdictTone(result.verdict);

  return (
    <div className="why-panel">
      <p className="why-summary">{summarize(result.categories, result.verdict)}</p>

      {reasons.length > 0 && (
        <ul className="reason-list">
          {reasons.map((reason, i) => (
            <li className="reason-item" data-tone={tone} key={i}>
              <span className="reason-bullet" aria-hidden="true" />
              {reason}
            </li>
          ))}
        </ul>
      )}

      {crossMessage.length > 0 && (
        <ul className="reason-list">
          {crossMessage.map((category, i) => (
            <li className="reason-item is-cross" data-tone={tone} key={i}>
              <span className="reason-bullet" aria-hidden="true" />
              <span>
                {explainCategory(category)}{" "}
                <span className="reason-scope">— seen in an earlier message</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {result.signals["merged_fragments"] !== undefined && (
        <ul className="reason-list">
          <li className="reason-item" data-tone="stop">
            <span className="reason-bullet" aria-hidden="true" />
            Combined with an earlier message, this forms the number{" "}
            {String(result.signals["merged_fragments"])}
          </li>
        </ul>
      )}

      <div className="why-meta">
        <span>
          Checked in <b>{fmtMs(result.latency_ms)}</b>
        </span>
        <span>
          Cost <b>${result.cost_usd.toFixed(5)}</b>
        </span>
        <span>
          Decided by <b>{friendlyTier(result.resolved_by)}</b>
        </span>
      </div>

      <button className="why-advanced-toggle" onClick={() => setShowAdvanced((v) => !v)}>
        {showAdvanced ? "Hide technical details" : "Show technical details"}
      </button>

      {showAdvanced && (
        <dl className="advanced">
          <div className="advanced-row">
            <dt>original</dt>
            <dd>{views.raw}</dd>
          </div>
          <div className="advanced-row">
            <dt>cleaned up</dt>
            <dd data-changed={views.denoised !== views.folded}>{views.denoised}</dd>
          </div>
          {views.digitRuns.length > 0 && (
            <div className="advanced-row">
              <dt>numbers found</dt>
              <dd data-changed="true">{views.digitRuns.map((r) => r.digits).join(", ")}</dd>
            </div>
          )}
          <div className="advanced-row">
            <dt>risk score</dt>
            <dd>{Number(result.signals["risk_score"] ?? 0).toFixed(2)}</dd>
          </div>
          <div className="advanced-row">
            <dt>categories</dt>
            <dd>{result.categories.length > 0 ? result.categories.join(", ") : "none"}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

function friendlyTier(resolvedBy: string): string {
  if (resolvedBy === "cache") return "cached result";
  if (resolvedBy.startsWith("tier5")) return "AI review";
  if (resolvedBy.startsWith("tier4")) return "pattern model";
  if (resolvedBy.startsWith("tier3")) return "risk score";
  if (resolvedBy.startsWith("tier2")) return "rule match";
  return "quick check";
}

function fmtMs(ms: number): string {
  if (ms >= 1) return `${ms.toFixed(1)} ms`;
  if (ms >= 0.01) return `${ms.toFixed(2)} ms`;
  return `${Math.max(1, Math.round(ms * 1000))} µs`;
}

/* ---------------------------------------------------------------- icons -- */

function VerdictIcon({ tone }: { tone: "good" | "caution" | "stop" }): JSX.Element {
  if (tone === "good") {
    return (
      <svg className="verdict-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M4 10.5l3.5 3.5L16 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }
  if (tone === "caution") {
    return (
      <svg className="verdict-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="2" />
        <path d="M10 6.5v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <circle cx="10" cy="13.2" r="1" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg className="verdict-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="2" />
      <path d="M6.5 6.5l7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function ChevronIcon(): JSX.Element {
  return (
    <svg className="verdict-chevron" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SendIcon(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M3 10l14-6-6 14-2-6-6-2z" fill="currentColor" />
    </svg>
  );
}

function SunIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="3.5" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M10 2.5v2M10 15.5v2M17.5 10h-2M4.5 10h-2M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4M15.3 15.3l-1.4-1.4M6.1 6.1L4.7 4.7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonIcon(): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M16.5 12.3A6.8 6.8 0 017.7 3.5a7 7 0 108.8 8.8z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
