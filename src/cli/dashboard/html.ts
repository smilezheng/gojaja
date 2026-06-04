/**
 * Self-contained dashboard page served by `gojaja watch`. No external
 * assets (offline-friendly, CSP-clean). The page polls `/api/state`
 * every couple of seconds and re-renders. The client JS deliberately
 * avoids template literals so this file can stay a single TS template
 * string without backtick-escaping every line.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>gojaja watch</title>
<style>
  /* v3.0.x T4: light-colour palette. The previous dark-mode tokens
     are retained as comments alongside each new value for easy
     rollback (pre-T4 commits also have them in git history if you
     want to revert this whole file). All hard-coded #hex values
     elsewhere in the stylesheet were tokenised here too so a
     future theme switch only needs to edit this :root block.

     v3.0.x T6: warmed up the previously cold off-white background
     to a subtle cream / beige tint. Easier on the eyes for long
     watch sessions. The accent / status / priority colours are
     unchanged (they already work on either warm or cold whites). */
  :root {
    color-scheme: light;
    --bg: #faf6ec;        /* was #f6f8fa (T4 cold white); was #0f1115 (pre-T4 dark) */
    --panel: #fffdf6;     /* was #ffffff; very faint cream, still reads as white but harmonises with --bg */
    --panel2: #f3ecdc;    /* was #f1f4f8; warm step between bg and panel */
    --line: #d9d0bc;      /* was #d8dee5; warm gray-beige border */
    --fg: #1a1f29;        /* was #e6e8ee */
    --dim: #6b6453;       /* was #57606a; warmer gray for secondary text */
    --accent: #0969da;    /* was #6ea8fe */
    --live: #1a7f37;      /* was #3fb950 */
    --stale: #9a6700;     /* was #d29922 */
    --none: #6e7781;      /* was #6b7280 */
    /* v3.0.x N: working = neutral blue (informational, NOT alarm).
       Init card's dirty-git warning + danger button keep --stalled
       red since those ARE real warnings. */
    --working: #0969da; --working-bg: #ddf4ff; --working-border: #80ccff;
    --stalled: #cf222e; --stalled-bg: #ffebe9; --stalled-border: #ffc4be;
    /* Priority swatches.
       v3.0.x T13: P0 was red (#cf222e), but red is also our
       "danger / blocked / error" colour and the dual-use was
       confusing — a P0 task and a blocked task both read as
       red even though one is "do this first" and the other is
       "this is stuck". P0 is now bright green (matches --live);
       red is reserved for danger semantics (.blk block icon,
       error feedback, required-field markers — all migrated to
       --err-border below). */
    --p0: #1a7f37;        /* was #cf222e (T13); was #f85149 (pre-T4 dark) */
    --p1: #9a6700;        /* was #d29922 */
    --p2: #0969da;        /* was #6ea8fe */
    --p3: #57606a;        /* was #8b93a7 */
    /* T4 new tokens: previously hard-coded inline. */
    --live-border: #aceebb;        /* was #224a2c */
    --system-bubble-bg: #ddf4ff;   /* was #1d2638 */
    --system-bubble-border: #80ccff;
    --system-bubble-who: #0550ae;  /* was #8cb4ff */
    /* v3.0.x T11: per-category event-type pill colours. Applied
       to the .ety chip in the bubble-meta row so the operator
       can distinguish a REPORT from a WORKLOG from an RFC_* at a
       glance. Same hue family as the rest of the palette
       (accent/live/stale already exist) plus one new purple for
       RFCs because they have their own narrative colour. */
    --type-report: var(--accent);   /* communication */
    --type-worklog: var(--live);    /* progress signal */
    --type-task: var(--stale);      /* task action (amber) */
    --type-rfc: #8250df;            /* RFC narrative (purple) */
    --type-role: var(--dim);        /* governance (muted) */
    --err-bg: #ffebe9;             /* was #3d1418 */
    --err-border: #cf222e;         /* was #f85149 */
    --err-fg: #82071e;             /* was #ffb4ae */
    --btn-fg-on-accent: #ffffff;   /* was #0b1220 */
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  header { position: sticky; top: 0; z-index: 5; background: var(--panel);
    border-bottom: 1px solid var(--line); padding: 10px 16px; display: flex;
    align-items: center; gap: 14px; flex-wrap: wrap; }
  header h1 { font-size: 15px; margin: 0; font-weight: 650; letter-spacing: .2px; }
  header .root { color: var(--dim); font-family: ui-monospace, monospace; font-size: 12px; }
  .chips { display: flex; gap: 8px; margin-left: auto; align-items: center; }
  .chip { background: var(--panel2); border: 1px solid var(--line); border-radius: 999px;
    padding: 3px 10px; color: var(--dim); }
  .chip b { color: var(--fg); }
  /* Language picker sits inline with the chips, styled to match.
     Native <select> for accessibility / keyboard support; the
     chip-like skin keeps it visually consistent. */
  .lang-picker { background: var(--panel2); border: 1px solid var(--line);
    border-radius: 999px; padding: 2px 22px 2px 10px; color: var(--fg);
    font: 12px ui-sans-serif, system-ui; cursor: pointer;
    appearance: none; -webkit-appearance: none;
    background-image: linear-gradient(45deg, transparent 50%, var(--dim) 50%),
      linear-gradient(135deg, var(--dim) 50%, transparent 50%);
    background-position: calc(100% - 11px) 50%, calc(100% - 7px) 50%;
    background-size: 4px 4px, 4px 4px; background-repeat: no-repeat; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
  .dot.live { background: var(--live); } .dot.stale { background: var(--stale); }
  .dot.none { background: var(--none); }
  .pulse { animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
  main { padding: 16px; display: grid; gap: 16px; max-width: 1500px; margin: 0 auto; }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
  section > h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em;
    color: var(--dim); margin: 0 0 10px; font-weight: 600; }
  .roles { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
  .role { background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; padding: 10px; }
  .role .name { font-weight: 650; }
  .role .title { color: var(--dim); font-size: 12px; }
  .role .meta { color: var(--dim); font-size: 11px; margin-top: 6px; font-family: ui-monospace, monospace; }
  .role .waiting { margin-top: 6px; color: var(--accent); font-size: 11px; }
  .role.working { background: var(--working-bg); border-color: var(--working-border); }
  .role .working-note { margin-top: 6px; color: var(--working); font-size: 11px; }
  .badge { font-size: 10px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line);
    text-transform: uppercase; letter-spacing: .04em; }
  .badge.live { color: var(--live); border-color: var(--live-border); } .badge.stale { color: var(--stale); }
  .badge.none { color: var(--none); }
  .badge.working { color: var(--working); border-color: var(--working-border); }
  .board { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; }
  /* v3.0.x T16: the entire Task board section is collapsible (mirrors
     RFC's per-card collapse from T7). When collapsed, every column's
     <h3> stays visible — including its task count — so the operator
     can still see the workload distribution at a glance, but the
     individual cards (and the per-column "—" empty placeholder) are
     hidden. Toggling state lives in localStorage so a poll-driven
     re-render snaps back to the user's intent and survives reloads. */
  .board.collapsed .task,
  .board.collapsed .empty { display: none; }
  .board.collapsed .col h3 {
    margin: 0;
    padding-bottom: 0;
    border-bottom: 0;
  }
  /* The Task board section heading itself is the click target. We
     inject a caret like RFCs use; reusing .rfc-caret would leak
     RFC styling, so it has its own .board-caret declared next to
     the existing .legend rules below to keep them grouped. */
  .board-head { cursor: pointer; user-select: none; display: inline-flex;
    align-items: baseline; gap: 7px; }
  .board-caret { font-family: ui-monospace, monospace; color: var(--dim);
    display: inline-block; width: 10px; text-align: center; font-size: 11px; }
  /* Column header: status label + a count "pill" sitting flush
     against the label. Previously the layout was space-between, which
     pushed the count to the right edge of the column — so visually
     it read as belonging to the NEXT column (only 10 px of grid gap
     to its right vs. a full column width to its label on the left).
     We pin the count next to its own label and give it a chip
     background so its column ownership is unambiguous; the bottom
     border under the whole header reinforces "this is the start of
     a column" framing. */
  .col h3 {
    font-size: 11px; color: var(--dim); margin: 0 0 8px; font-weight: 600;
    display: flex; align-items: center; gap: 7px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--line);
    text-transform: uppercase; letter-spacing: .06em;
  }
  .col h3 .count {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 20px; height: 18px; padding: 0 6px;
    background: var(--panel2); border: 1px solid var(--line);
    border-radius: 999px;
    font-size: 10px; color: var(--fg); font-weight: 600;
    letter-spacing: 0;
  }
  .task { background: var(--panel2); border: 1px solid var(--line); border-left-width: 3px;
    border-radius: 6px; padding: 7px 8px; margin-bottom: 7px; }
  .task .tid { font-family: ui-monospace, monospace; color: var(--dim); font-size: 11px; }
  .task .tt { margin: 2px 0; }
  .task .to { color: var(--dim); font-size: 11px; }
  .task.p0 { border-left-color: var(--p0); } .task.p1 { border-left-color: var(--p1); }
  .task.p2 { border-left-color: var(--p2); } .task.p3 { border-left-color: var(--p3); }
  /* v3.0.x T12: priority legend rendered next to the Task board
     section title. Each chip mimics the actual task card — same
     3px left stripe in the matching priority colour — so the
     visual association is instant. Sized down + dim so it lives
     as a subtitle, not a competing heading. */
  .legend { font-size: 11px; font-weight: 400; text-transform: none;
    letter-spacing: 0; color: var(--dim); display: inline-flex;
    gap: 6px; margin-left: 12px; vertical-align: middle; }
  .legend .leg { display: inline-block; padding: 1px 6px;
    border: 1px solid var(--line); border-left-width: 3px;
    border-radius: 3px; font-family: ui-monospace, monospace;
    font-size: 10px; color: var(--fg); background: var(--panel2); }
  .legend .leg-p0 { border-left-color: var(--p0); }
  .legend .leg-p1 { border-left-color: var(--p1); }
  .legend .leg-p2 { border-left-color: var(--p2); }
  .legend .leg-p3 { border-left-color: var(--p3); }
  /* v3.0.x T13: blocked-by-deps marker keeps the red
     (sourced from --err-border now; --p0 went green). */
  .blk { color: var(--err-border); font-size: 11px; }
  .rfcs { display: flex; flex-direction: column; gap: 10px; }
  .rfc { background: var(--panel2); border: 1px solid var(--line); border-radius: 6px;
    padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
  /* v3.0.x T7: RFCs are collapsed by default (head row only); click
     the head to expand. Expansion state survives polling re-renders
     and page reloads via localStorage (see expandedRfcs Set in JS). */
  .rfc.collapsed > :not(.rfc-head) { display: none; }
  .rfc.collapsed { padding: 8px 12px; }
  .rfc-head { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap;
    cursor: pointer; user-select: none; }
  .rfc-caret { font-family: ui-monospace, monospace; color: var(--dim);
    display: inline-block; width: 10px; text-align: center; }
  .rfc .rid { font-family: ui-monospace, monospace; color: var(--dim); }
  .rfc .st { font-size: 10px; text-transform: uppercase; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line); }
  .rfc .st.open { color: var(--live); } .rfc .st.revising { color: var(--stale); }
  .rfc .st.accepted { color: var(--accent); } .rfc .st.rejected { color: var(--none); }
  .rfc-title { font-weight: 600; flex: 1; }
  .rfc-meta { color: var(--dim); font-size: 11px; }
  .rfc-desc { color: var(--fg); font-size: 12px; white-space: pre-wrap;
    background: var(--panel); border-left: 2px solid var(--line);
    padding: 6px 8px; border-radius: 4px; }
  .rfc-options { display: flex; flex-direction: column; gap: 3px;
    background: var(--panel); border: 1px solid var(--line);
    border-radius: 4px; padding: 6px 8px; }
  .rfc-options .opt { display: grid; grid-template-columns: 60px 1fr;
    gap: 8px; font-size: 12px; }
  .rfc-options .opt .oid { font-family: ui-monospace, monospace;
    color: var(--accent); }
  .rfc-section-h { color: var(--dim); font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.5px; }
  .rfc-comments { display: flex; flex-direction: column; gap: 5px; }
  .rfc-cmt { font-size: 12px; padding: 4px 0; border-bottom: 1px dashed var(--line); }
  .rfc-cmt:last-child { border-bottom: none; }
  .rfc-cmt .cmt-who { color: var(--accent); font-weight: 600; }
  .rfc-cmt .cmt-kind { font-size: 10px; text-transform: uppercase;
    padding: 1px 5px; border-radius: 999px; border: 1px solid var(--line);
    color: var(--dim); margin-left: 6px; }
  .rfc-cmt .cmt-kind.pre-decision { color: var(--stale); }
  .rfc-cmt .cmt-kind.ack { color: var(--live); }
  .rfc-cmt .cmt-kind.object { color: var(--none); }
  .rfc-cmt .cmt-body { white-space: pre-wrap; color: var(--fg); margin-top: 2px; }
  .rfc-cmt .cmt-reply { padding-left: 14px; border-left: 2px solid var(--line); }
  .rfc-decision { background: var(--panel); border: 1px solid var(--accent);
    border-radius: 4px; padding: 8px 10px; }
  .rfc-decision.rejected { border-color: var(--none); }
  .rfc-decision .dec-head { font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.5px; color: var(--accent); }
  .rfc-decision.rejected .dec-head { color: var(--none); }
  .rfc-decision .dec-body { white-space: pre-wrap; font-size: 12px;
    margin-top: 4px; color: var(--fg); }
  /* Activity tab — chat-bubble layout (v3.0.x M).
     Member-authored events line up on the left; SYSTEM events
     (project-owner announcements) line up on the right. Multi-line
     bodies wrap natively. The first line of each bubble is the
     "@<recipient>" header (or "@All" for to === "*"); the body
     starts on the next line so multi-line messages render legibly.

     v3.0.x T8: feed grew from max-height 540px to a viewport-aware
     cap. Short windows scale down (75vh keeps the feed below the
     fold); tall monitors get up to 900px before scrolling kicks
     in. The previous fixed 540px wasted vertical real estate on
     larger displays. */
  .feed { max-height: min(900px, 75vh); overflow: auto; padding: 8px 0;
    display: flex; flex-direction: column; gap: 8px; }
  .bubble-row { display: flex; gap: 8px; align-items: flex-start; }
  .bubble-row.from-system { justify-content: flex-end; }
  .bubble-row.from-member { justify-content: flex-start; }
  .bubble { max-width: 72%; background: var(--panel2);
    border: 1px solid var(--line); border-radius: 10px;
    padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }
  .bubble.from-system { background: var(--system-bubble-bg); border-color: var(--system-bubble-border); }
  /* v3.0.x T10: dashed divider between the bubble's meta row
     (sender + event-type pill + ref + timestamp) and the body
     half (@to + message text). Visually separates "envelope" from
     "letter". Dashed (rather than solid) so it doesn't fight the
     bubble's solid outer border. */
  .bubble-meta { display: flex; gap: 8px; font-size: 11px;
    color: var(--dim); align-items: baseline;
    border-bottom: 1px dashed var(--line);
    padding-bottom: 6px; margin-bottom: 6px; }
  .bubble-meta .who { color: var(--fg); font-weight: 600; }
  .bubble.from-system .bubble-meta .who { color: var(--system-bubble-who); }
  /* Default event-type pill — overridden per-category below
     (v3.0.x T11) so each event class reads at a glance. */
  .bubble-meta .ety { font-size: 10px; text-transform: uppercase;
    letter-spacing: 0.5px; padding: 1px 5px; border-radius: 999px;
    border: 1px solid var(--line); color: var(--dim);
    font-weight: 600; }
  .bubble-meta .ety.type-report  { color: var(--type-report);  border-color: var(--type-report);  }
  .bubble-meta .ety.type-worklog { color: var(--type-worklog); border-color: var(--type-worklog); }
  .bubble-meta .ety.type-task    { color: var(--type-task);    border-color: var(--type-task);    }
  .bubble-meta .ety.type-rfc     { color: var(--type-rfc);     border-color: var(--type-rfc);     }
  .bubble-meta .ety.type-role    { color: var(--type-role);    border-color: var(--type-role);    }
  .bubble-meta .ref { font-family: ui-monospace, monospace;
    color: var(--accent); }
  .bubble-meta .et { font-family: ui-monospace, monospace; }
  .bubble-to { font-size: 12px; color: var(--dim); }
  .bubble-to .at-target { color: var(--accent); font-weight: 600; }
  .bubble-to .at-target.all { color: var(--stale); }
  .bubble-body { font-size: 13px; color: var(--fg); white-space: pre-wrap;
    word-wrap: break-word; line-height: 1.45; }
  .bubble-body.empty { color: var(--dim); font-style: italic; }
  .empty { color: var(--dim); font-style: italic; }
  #err { display: none; background: var(--err-bg); border: 1px solid var(--err-border); color: var(--err-fg);
    padding: 8px 12px; border-radius: 8px; margin: 0 16px; }
  /* Actions panel: project-owner write surface. Hidden when the
     server reports !capabilities.writeEnabled (non-loopback bind). */
  .actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; }
  .action { background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
  .action h3 { font-size: 12px; margin: 0 0 10px; font-weight: 600; color: var(--fg);
    text-transform: uppercase; letter-spacing: .06em; }
  .action label { display: block; font-size: 11px; color: var(--dim); margin: 8px 0 3px; }
  /* Required-field marker. Only shown on labels whose backend
     handler refuses the request when the field is empty (see
     postReport / postRfc / postTask / postRole / postPrompt /
     postActivate in src/cli/commands/watch.ts). The asterisk colour
     reuses the danger red (--err-border) so it reads "you must
     fill this" without an extra palette token. v3.0.x T13: was
     sourced from --p0 before P0 went green; the asterisk is
     "required → red" by web convention, not "P0-priority". */
  .action label.req::before { content: "* "; color: var(--err-border); font-weight: 700; }
  .action input, .action select, .action textarea {
    width: 100%; box-sizing: border-box; background: var(--bg); color: var(--fg);
    border: 1px solid var(--line); border-radius: 5px; padding: 6px 8px; font: 12px ui-monospace, monospace; }
  .action textarea { min-height: 60px; resize: vertical; }
  .action button { margin-top: 10px; background: var(--accent); color: var(--btn-fg-on-accent); border: 0;
    border-radius: 5px; padding: 6px 14px; font: 600 12px ui-sans-serif, system-ui;
    cursor: pointer; }
  .action button:disabled { opacity: .5; cursor: not-allowed; }
  .action .feedback { margin-top: 8px; font-size: 11px; min-height: 14px; }
  .action .feedback.ok { color: var(--live); }
  /* v3.0.x T13: error feedback stays red (--err-border) — was
     --p0 before P0 went green. Errors are danger, not P0. */
  .action .feedback.err { color: var(--err-border); }
  .action .hint { font-size: 11px; color: var(--dim); margin-top: 6px; }
  /* Tab nav. Sits under the sticky header; switches which top-level
     panel is visible. Active tab uses the accent underline. */
  .tabs { display: flex; gap: 0; border-bottom: 1px solid var(--line);
    background: var(--panel); padding: 0 16px; position: sticky; top: 49px; z-index: 4; }
  .tab { padding: 10px 14px; border: 0; background: transparent; color: var(--dim);
    font: 600 12px ui-sans-serif, system-ui; cursor: pointer;
    border-bottom: 2px solid transparent; margin-bottom: -1px;
    text-transform: uppercase; letter-spacing: .06em; }
  .tab.active { color: var(--fg); border-bottom-color: var(--accent); }
  .tab:hover:not(.active) { color: var(--fg); }
  /* Small numeric badge embedded inside a tab label (e.g. archived
     count). Sits flush after the label, in muted panel chrome so it
     reads as metadata rather than a competing visual element. */
  .tab .tab-count {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 18px; height: 16px; padding: 0 5px; margin-left: 6px;
    background: var(--panel2); border: 1px solid var(--line);
    border-radius: 999px;
    font-size: 10px; color: var(--fg); font-weight: 600;
    letter-spacing: 0;
  }
  .panel { display: none; }
  .panel.active { display: grid; gap: 16px; }
  /* Archived tab: one block per day, newest day first. Each block
     leads with a date header, followed by a compact list of cards
     (id · title · owner · priority). The cards are intentionally
     leaner than the board cards — these are historical records, not
     work in flight, and the user is scanning for "did we ship X"
     not "what's the next move on Y". */
  .archived-list { display: flex; flex-direction: column; gap: 18px; }
  .archived-day { background: var(--panel2); border: 1px solid var(--line);
    border-radius: 8px; padding: 10px 12px; }
  .archived-day h3 { font-size: 12px; color: var(--dim); margin: 0 0 8px;
    font-weight: 600; text-transform: uppercase; letter-spacing: .06em;
    display: flex; align-items: center; gap: 8px;
    padding-bottom: 6px; border-bottom: 1px solid var(--line); }
  .archived-day h3 .count {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 20px; height: 18px; padding: 0 6px;
    background: var(--bg); border: 1px solid var(--line);
    border-radius: 999px; font-size: 10px; color: var(--fg); font-weight: 600;
  }
  .arch-card { display: grid;
    grid-template-columns: 80px 1fr 140px 40px;
    gap: 10px; align-items: baseline;
    padding: 5px 0; border-bottom: 1px dashed var(--line); }
  .arch-card:last-child { border-bottom: 0; }
  .arch-card .aid { font-family: ui-monospace, monospace; color: var(--dim); font-size: 11px; }
  .arch-card .att { color: var(--fg); }
  .arch-card .ato { color: var(--dim); font-size: 12px; }
  .arch-card .apr { font-family: ui-monospace, monospace; font-size: 11px; text-align: right; }
  .arch-card .apr.p0 { color: var(--p0); } .arch-card .apr.p1 { color: var(--p1); }
  .arch-card .apr.p2 { color: var(--p2); } .arch-card .apr.p3 { color: var(--p3); }
  /* Init landing page — shown ONLY when /api/state reports
     !initialised. Centred card with the project root, git status,
     and a single big primary action. */
  .init-screen { display: none; min-height: 60vh; align-items: center; justify-content: center; }
  .init-screen.active { display: flex; }
  .init-card { max-width: 640px; background: var(--panel); border: 1px solid var(--line);
    border-radius: 12px; padding: 28px 32px; }
  .init-card h2 { margin: 0 0 4px; font-size: 18px; font-weight: 650; letter-spacing: .2px;
    text-transform: none; color: var(--fg); }
  .init-card .root-line { color: var(--dim); font-family: ui-monospace, monospace; font-size: 12px;
    margin-bottom: 16px; word-break: break-all; }
  .init-card .git { background: var(--panel2); border: 1px solid var(--line); border-radius: 6px;
    padding: 10px 12px; font-size: 12px; margin: 12px 0; }
  .init-card .git.warn { border-color: var(--stale); }
  .init-card .git.bad { border-color: var(--stalled); background: var(--stalled-bg); }
  .init-card .git pre { margin: 6px 0 0; font: 11px ui-monospace, monospace; color: var(--dim);
    white-space: pre-wrap; word-break: break-all; max-height: 160px; overflow: auto; }
  .init-card button.primary { background: var(--accent); color: var(--btn-fg-on-accent); border: 0;
    border-radius: 6px; padding: 9px 18px; font: 600 13px ui-sans-serif, system-ui;
    cursor: pointer; margin-top: 8px; }
  .init-card button.primary:disabled { opacity: .5; cursor: not-allowed; }
  .init-card button.danger { background: var(--stalled); }
  .init-card .feedback { margin-top: 10px; font-size: 12px; min-height: 16px; }
  .init-card .feedback.err { color: var(--err-border); } /* T13: red, not P0 (now green) */
  .init-card .feedback.ok { color: var(--live); }

  /* Responsive breakpoints. The dashboard was designed for a 1500px
     workstation; below that the 6-column kanban, the 320px-min action
     cards, and the 4-column archived rows all overflow or shrink to
     illegibility. Three breakpoints:

       - tablet  (<=1024px): kanban switches to a horizontal-scroll
         strip with fixed 200px columns (preserves the column-per-
         status mental model — swipe instead of squeeze); roles /
         actions / setup drop their minmax floors so they collapse
         to one column gracefully.
       - phone   (<=640px):  header / tabs collapse, paddings tighten,
         bubbles widen to ~92%, archived rows stack vertically.
       - tiny    (<=380px):  last bit of padding stripped so the
         dashboard is still usable on a 360px viewport (common
         Android width).

     The kanban deliberately uses horizontal scroll rather than
     reflowing into one column per status: at this point the
     board's value IS the side-by-side comparison across statuses,
     and a vertical accordion loses that. */
  @media (max-width: 1024px) {
    main { padding: 12px; gap: 12px; }
    section { padding: 10px 12px; }
    .roles { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
    .actions { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
    .board {
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: 200px;
      grid-template-columns: none;
      overflow-x: auto;
      padding-bottom: 8px;
      scroll-snap-type: x mandatory;
      -webkit-overflow-scrolling: touch;
    }
    .board .col { scroll-snap-align: start; }
    .bubble { max-width: 85%; }
    .feed { max-height: min(700px, 65vh); }
  }
  @media (max-width: 640px) {
    header { padding: 8px 12px; gap: 8px; }
    header h1 { font-size: 14px; }
    header .root { font-size: 11px; word-break: break-all; }
    .chips { margin-left: 0; gap: 6px; width: 100%; }
    .chip { padding: 2px 8px; font-size: 11px; }
    /* Header wraps to two rows on phone (chips drop below the
       title), so its height is no longer the 49px the desktop
       sticky-tabs offset assumed. Drop position:sticky on both
       header and tabs to avoid an overlap; the dashboard is short
       enough on phone that scroll-to-top is cheap. */
    header { position: static; }
    .tabs { position: static; padding: 0 8px; overflow-x: auto;
      white-space: nowrap; -webkit-overflow-scrolling: touch; }
    .tab { padding: 9px 10px; }
    main { padding: 10px; gap: 10px; }
    section { padding: 10px; border-radius: 8px; }
    .roles { grid-template-columns: 1fr; gap: 8px; }
    .actions { grid-template-columns: 1fr; gap: 10px; }
    .board { grid-auto-columns: 180px; }
    .bubble { max-width: 92%; }
    .bubble-meta { flex-wrap: wrap; gap: 6px; }
    /* Archived rows: the 4-column grid (id / title / owner / pri)
       loses the title column to nothing on phone widths. Stack the
       fields so each card reads top-to-bottom; pri stays inline
       with id as a chip pair. */
    .arch-card {
      grid-template-columns: 1fr;
      gap: 2px;
      padding: 8px 0;
    }
    .arch-card .aid::after { content: " · "; color: var(--dim); }
    .arch-card .apr { text-align: left; }
    .init-card { padding: 20px 18px; border-radius: 8px; }
    .init-card h2 { font-size: 16px; }
    .legend { flex-wrap: wrap; margin-left: 8px; }
    .rfc-options .opt { grid-template-columns: 50px 1fr; gap: 6px; }
  }
  @media (max-width: 380px) {
    main { padding: 8px; }
    section { padding: 8px; }
    .board { grid-auto-columns: 160px; }
    .bubble { max-width: 96%; padding: 7px 8px; }
    .feed { max-height: min(560px, 60vh); }
  }
</style>
</head>
<body>
<header>
  <h1>gojaja <span style="color:var(--dim);font-weight:400">watch</span></h1>
  <span class="root" id="root">…</span>
  <div class="chips">
    <span class="chip"><span class="dot live pulse"></span><span id="upd" data-i18n="header.connecting">connecting…</span></span>
    <span class="chip"><span data-i18n="header.rolesLive">roles live</span> <b id="c-live">–</b></span>
    <span class="chip" id="chip-working" style="display:none"><span data-i18n="header.working">working</span> <b id="c-working">–</b></span>
    <span class="chip"><span data-i18n="header.openRfcs">open RFCs</span> <b id="c-rfc">–</b></span>
    <span class="chip"><span data-i18n="header.events">events</span> <b id="c-ev">–</b></span>
    <select id="lang-picker" class="lang-picker" title="Language / 语言">
      <option value="en">EN</option>
      <option value="zh-CN">中文</option>
    </select>
  </div>
</header>
<div id="err"></div>

<!-- Init landing page — shown ONLY when /api/state reports
     !initialised. Replaces the tabbed dashboard until the user
     completes init. -->
<div class="init-screen" id="init-screen">
  <div class="init-card">
    <h2 data-i18n="init.title">Initialise this project</h2>
    <div class="root-line" id="init-root">…</div>
    <p style="margin:0 0 4px;color:var(--dim)" data-i18n-html="init.blurb">
      <code>gojaja init</code> creates a <code>.gojaja/</code> directory at the
      project root with the durable team-coordination state (events, sessions,
      tasks, RFCs). Re-running it on a project that already has the layer is a
      no-op until you <code>gojaja reset</code>.
    </p>
    <div id="init-git"></div>
    <button class="primary" id="init-go" data-i18n="init.button">Initialise</button>
    <div class="feedback" id="init-fb"></div>
  </div>
</div>

<!-- Tab nav (hidden until initialised). Each .tab toggles the
     matching .panel by id. -->
<nav class="tabs" id="tabs" style="display:none">
  <button class="tab active" data-tab="dashboard"><span data-i18n="tabs.dashboard">Dashboard</span></button>
  <button class="tab" data-tab="archived"><span data-i18n="tabs.archived">Archived</span> <span class="tab-count" id="tab-archived-count" style="display:none">0</span></button>
  <button class="tab" data-tab="setup"><span data-i18n="tabs.setup">Setup</span></button>
  <button class="tab" data-tab="actions"><span data-i18n="tabs.actions">Actions</span></button>
</nav>

<main id="panels" style="display:none">
<section class="panel active" id="panel-dashboard">
  <section><h2 data-i18n="sec.roles">Roles</h2><div class="roles" id="roles"></div></section>
  <section><h2><span class="board-head" id="board-head" data-i18n-attr="title:sec.boardCollapseHint" title="Click to collapse / expand the task board"><span class="board-caret" id="board-caret">▼</span><span data-i18n="sec.taskBoard">Task board</span></span> <span class="legend" data-i18n-attr="title:sec.legendTitle" title="Priority legend — set per task via --priority. Bar colour matches each card's left stripe.">
    <span class="leg leg-p0">P0</span>
    <span class="leg leg-p1">P1</span>
    <span class="leg leg-p2">P2</span>
    <span class="leg leg-p3">P3</span>
  </span></h2><div class="board" id="board"></div></section>
  <section><h2 data-i18n="sec.rfcs">RFCs</h2><div class="rfcs" id="rfcs"></div></section>
  <section><h2 data-i18n="sec.activity">Activity</h2><div class="feed" id="feed"></div></section>
</section>

<section class="panel" id="panel-archived">
  <section>
    <h2><span data-i18n="sec.archived">Archived tasks</span> <span style="color:var(--dim);text-transform:none;letter-spacing:0;font-weight:400" data-i18n="sec.archivedSub">— tasks auto-hidden from the active board after 48 h in Done. Grouped by the day they were last updated (local time).</span></h2>
    <div id="archived" class="archived-list"></div>
  </section>
</section>

<section class="panel" id="panel-setup">
  <section id="sec-setup" style="display:none">
    <h2><span data-i18n="setup.title">Setup</span> <span style="color:var(--dim);text-transform:none;letter-spacing:0;font-weight:400" data-i18n="setup.subtitle">— roles, runtime files, per-window activation</span></h2>
    <div class="actions">
      <div class="action">
        <h3 data-i18n="setup.role.title">Create role</h3>
        <label class="req" data-i18n-html="setup.role.id">Id (no spaces; <code>[A-Za-z0-9_-]</code>)</label>
        <input id="role-id" placeholder="Backend" />
        <label data-i18n="setup.role.titleLabel">Title (human-readable)</label>
        <input id="role-title" placeholder="Backend Engineer" />
        <label data-i18n="setup.role.desc">Description (one line, optional)</label>
        <input id="role-desc" />
        <label data-i18n="setup.role.owns">Owns (comma-separated paths)</label>
        <input id="role-owns" placeholder="src/api/,src/db/" />
        <label data-i18n="setup.role.reports">Reports to (comma-separated roles)</label>
        <input id="role-reports" placeholder="TL,CTO" />
        <label data-i18n="setup.role.mne">Must not edit (comma-separated paths)</label>
        <input id="role-mne" />
        <button id="role-go" data-i18n="setup.role.button">Create role</button>
        <div class="feedback" id="role-fb"></div>
        <div class="hint" data-i18n-html="setup.role.hint">After create, fill the TBD sections in <code>.gojaja/roles/&lt;id&gt;.md</code> before activating.</div>
      </div>

      <div class="action">
        <h3 data-i18n="setup.prompt.title">Install runtime files</h3>
        <label class="req" data-i18n="setup.prompt.target">Target host</label>
        <select id="prompt-target">
          <option value="agents" selected data-i18n="setup.prompt.optAgents">agents (writes AGENTS.md — covers Codex / Cursor / Copilot / Windsurf / Zed)</option>
          <option value="claude" data-i18n="setup.prompt.optClaude">claude (writes CLAUDE.md)</option>
          <option value="cursor" data-i18n="setup.prompt.optCursor">cursor (writes .cursor/rules/gojaja-runtime.mdc)</option>
          <option value="generic" data-i18n="setup.prompt.optGeneric">generic (preview only — bundled into activate snippet)</option>
        </select>
        <label style="display:flex;align-items:center;gap:6px;margin-top:10px;font-size:12px;color:var(--fg)">
          <input type="checkbox" id="prompt-force" style="width:auto;margin:0" />
          <span data-i18n="setup.prompt.force">Force rewrite (overwrite even if file is byte-identical)</span>
        </label>
        <label style="display:flex;align-items:center;gap:6px;margin-top:6px;font-size:12px;color:var(--fg)">
          <input type="checkbox" id="prompt-no-handbook" style="width:auto;margin:0" />
          <span data-i18n="setup.prompt.noHandbook">Skip the cheatsheet (smaller card, less guidance)</span>
        </label>
        <button id="prompt-go" data-i18n="setup.prompt.button">Install</button>
        <div class="feedback" id="prompt-fb"></div>
        <div class="hint" data-i18n="setup.prompt.hint">Hosts only inject these files when an agent window first opens — restart any open window after a write.</div>
      </div>

      <div class="action">
        <h3 data-i18n="setup.act.title">Activate (per-window snippet)</h3>
        <label class="req" data-i18n="setup.act.role">Role</label>
        <select id="act-role"></select>
        <label class="req" data-i18n="setup.act.target">Target host</label>
        <select id="act-target">
          <option value="agents" selected>agents</option>
          <option value="claude">claude</option>
          <option value="cursor">cursor</option>
          <option value="generic" data-i18n="setup.act.optGeneric">generic (snippet bundles runtime body)</option>
        </select>
        <button id="act-go" data-i18n="setup.act.button">Generate snippet</button>
        <div class="feedback" id="act-fb"></div>
        <textarea id="act-out" readonly data-i18n-attr="placeholder:setup.act.outPlaceholder" placeholder="(snippet appears here after Generate)" style="margin-top:8px;min-height:120px;font-size:11px"></textarea>
        <button id="act-copy" data-i18n="setup.act.copyButton" style="background:var(--panel2);color:var(--fg);border:1px solid var(--line);margin-top:6px;display:none">Copy snippet</button>
        <div class="hint" data-i18n-html="setup.act.hint">Paste the snippet into the agent window's chat to bind that window to the role. Refuses if the role's <code>.md</code> still has TBD sections.</div>
      </div>
    </div>
    <div class="hint" style="margin-top:10px;color:var(--dim);font-size:11px" data-i18n-html="setup.footer">
      Setup actions require <code>.gojaja/</code> to exist (run <em>Initialise</em> first if missing) and must be on a loopback bind to be visible.
    </div>
  </section>
</section>

<section class="panel" id="panel-actions">
  <section id="sec-actions" style="display:none">
    <h2><span data-i18n="actions.title">Actions</span> <span style="color:var(--dim);text-transform:none;letter-spacing:0;font-weight:400" data-i18n-html="actions.subtitle">— posted as <code style="background:var(--panel2);padding:1px 5px;border-radius:3px">SYSTEM</code> (project-owner)</span></h2>
    <div class="actions">
      <div class="action">
        <h3 data-i18n="actions.report.title">Send report</h3>
        <label class="req" data-i18n="actions.report.to">To role</label>
        <select id="rep-to"></select>
        <label class="req" data-i18n="actions.report.message">Message</label>
        <textarea id="rep-msg" data-i18n-attr="placeholder:actions.report.msgPlaceholder" placeholder="What you need them to do next."></textarea>
        <label data-i18n="actions.report.ref">Ref (optional)</label>
        <input id="rep-ref" placeholder="T-0001 / RFC-0007 / ..." />
        <button id="rep-go" data-i18n="actions.report.button">Send report</button>
        <div class="feedback" id="rep-fb"></div>
      </div>
      <div class="action">
        <h3 data-i18n="actions.rfc.title">Open RFC</h3>
        <label class="req" data-i18n="actions.rfc.slug">Slug</label>
        <input id="rfc-slug" placeholder="lowercase-with-dashes" />
        <label class="req" data-i18n="actions.rfc.titleLabel">Title</label>
        <input id="rfc-title" />
        <label class="req" data-i18n="actions.rfc.deciders">Deciders (comma-separated roles)</label>
        <input id="rfc-deciders" placeholder="CTO,CPO" />
        <label data-i18n="actions.rfc.voters">Voters (comma-separated, optional)</label>
        <input id="rfc-voters" />
        <label data-i18n="actions.rfc.options">Options (id:summary, comma-separated, optional)</label>
        <input id="rfc-options" placeholder="A:do this,B:do that" />
        <label data-i18n="actions.rfc.desc">Description</label>
        <textarea id="rfc-desc" data-i18n-attr="placeholder:actions.rfc.descPlaceholder" placeholder="Context the voters/deciders need to weigh in."></textarea>
        <button id="rfc-go" data-i18n="actions.rfc.button">Open RFC</button>
        <div class="feedback" id="rfc-fb"></div>
      </div>
      <div class="action">
        <h3 data-i18n="actions.task.title">Create task</h3>
        <label class="req" data-i18n="actions.task.titleLabel">Title</label>
        <input id="task-title" />
        <label data-i18n="actions.task.owner">Owner (optional)</label>
        <select id="task-owner"><option value="" data-i18n="actions.task.unassigned">(unassigned)</option></select>
        <label data-i18n="actions.task.priority">Priority</label>
        <select id="task-pri">
          <option value="P0">P0</option>
          <option value="P1">P1</option>
          <option value="P2" selected>P2</option>
          <option value="P3">P3</option>
        </select>
        <label data-i18n="actions.task.acc">Acceptance criteria (optional)</label>
        <textarea id="task-acc" data-i18n-attr="placeholder:actions.task.accPlaceholder" placeholder="What 'done' looks like."></textarea>
        <button id="task-go" data-i18n="actions.task.button">Create task</button>
        <div class="feedback" id="task-fb"></div>
      </div>
    </div>
    <div class="hint" style="margin-top:10px;color:var(--dim);font-size:11px" data-i18n-html="actions.footer">
      All actions emit events as <code>from: SYSTEM</code> — the same as running
      the gojaja CLI in a shell with no <code>GOJAJA_SESSION</code>. Visible only when watch is bound to loopback.
    </div>
  </section>
</section>

</main>
<script>
  var STATUSES = ["Backlog","Pending","InProgress","Blocked","Review","Done"];

  /* -------------------- i18n (T15) -------------------------------
   * All user-facing static text lives in MESSAGES below, keyed by
   * dotted-namespace path. Server-side data (role ids, status
   * enum values stored on disk, error message bodies) is never
   * translated — the contract values stay verbatim; we only
   * translate the human-readable wrapper around them.
   *
   * Languages: en (default fallback) + zh-CN.
   * Adding a language = one new object inside MESSAGES + one
   * <option> in the #lang-picker. The t() lookup falls back to
   * en for any missing keys so a partial translation never
   * breaks the UI.
   *
   * Storage-key vs display split:
   *   - STATUSES = ["Backlog","Pending",...]  (storage keys; the
   *     board uses these to bucket tasks. Display goes through
   *     t("status.Backlog") etc.)
   *   - role healthStatus values ("no-session","stale-session",
   *     "waiting","active","working") similarly stay as CSS
   *     class names; display strings pulled from t().
   *   - Priorities P0..P3 are universal; not translated. */
  var MESSAGES = {
    en: {
      "header.connecting": "connecting…",
      "header.rolesLive": "roles live",
      "header.working": "working",
      "header.openRfcs": "open RFCs",
      "header.events": "events",
      "header.updated": "updated {ago}",
      "header.lostConnection": "Lost connection to gojaja watch ({error}). Is the server still running?",

      "tabs.dashboard": "Dashboard",
      "tabs.archived": "Archived",
      "tabs.setup": "Setup",
      "tabs.actions": "Actions",

      "sec.roles": "Roles",
      "sec.taskBoard": "Task board",
      "sec.legendTitle": "Priority legend — set per task via --priority. Bar colour matches each card's left stripe.",
      "sec.boardCollapseHint": "Click to collapse / expand the task board",
      "sec.rfcs": "RFCs",
      "sec.activity": "Activity",
      "sec.archived": "Archived tasks",
      "sec.archivedSub": "— tasks auto-hidden from the active board after 48 h in Done. Grouped by the day they were last updated (local time).",

      "status.Backlog": "Backlog",
      "status.Pending": "Pending",
      "status.InProgress": "InProgress",
      "status.Blocked": "Blocked",
      "status.Review": "Review",
      "status.Done": "Done",

      "badge.live": "live",
      "badge.stale": "stale",
      "badge.none": "none",
      "badge.working": "working",

      "role.noSession": "no active session",
      "role.sessionMeta": "pid {pid} @ {host} · hb {ago}",
      "role.owns": "owns: {paths}",
      "role.waiting": "⏳ waiting for {condition} · {until}",
      "role.waitingAttention": "attention",
      "role.workingNote": "💼 Working — heads down for {age}. No gojaja activity since; usually means writing code or running tests.",

      "role.empty": "No roles registered.",
      "rfcs.empty": "No RFCs.",
      "board.empty": "—",
      "feed.empty": "No events yet.",
      "archived.empty": "No archived tasks yet. Tasks land here automatically after sitting in Done for 48 h.",

      "rfc.clickCollapse": "Click to collapse",
      "rfc.clickExpand": "Click to expand",
      "rfc.deciders": "deciders: {list}",
      "rfc.voters": "voters: {list}",
      "rfc.tasks": "tasks: {list}",
      "rfc.deadline": "deadline: {when}",
      "rfc.options": "Options",
      "rfc.optionNoSummary": "(no summary)",
      "rfc.comments": "Comments ({n})",
      "rfc.decisionBy": "{outcome} by {who}",
      "rfc.decisionOption": " · option {id}",

      "feed.atAll": "@All",
      "feed.noBody": "({type} — no message body)",

      "task.unassigned": "(unassigned)",
      "task.blocked": "⛔ {deps}",

      "time.justNow": "just now",
      "time.sAgo": "{n}s ago",
      "time.mAgo": "{n}m ago",
      "time.hAgo": "{n}h ago",
      "time.dAgo": "{n}d ago",
      "time.noDeadline": "no deadline",
      "time.passed": "deadline passed",
      "time.inS": "in {n}s",
      "time.inM": "in {n}m",
      "time.inH": "in {n}h",
      "time.sShort": "{n}s",
      "time.mShort": "{n}m",
      "time.hShort": "{n}h",
      "time.dShort": "{n}d",
      "time.unknown": "?",
      "time.today": "Today",
      "time.yesterday": "Yesterday",

      "init.title": "Initialise this project",
      "init.blurb": "<code>gojaja init</code> creates a <code>.gojaja/</code> directory at the project root with the durable team-coordination state (events, sessions, tasks, RFCs). Re-running it on a project that already has the layer is a no-op until you <code>gojaja reset</code>.",
      "init.button": "Initialise",
      "init.buttonForce": "I understand — force init anyway",
      "init.buttonNoGit": "Initialise without git",
      "init.initialising": "initialising…",
      "init.done": "Initialised. Loading dashboard…",
      "init.alreadyDone": "Already initialised — refreshing.",
      "init.refused": "Refused.",
      "init.gitClean": "git: clean working tree — gojaja's changes will land in a revertable state.",
      "init.gitDirty": "<b>git: uncommitted changes detected.</b> Commit or stash them before init so the layer's changes are easy to revert.",
      "init.gitNotRepo": "<b>Not a git repository.</b> Without version control there is no clean way to undo gojaja's changes if something goes wrong. Strongly recommended: run <code>git init &amp;&amp; git add -A &amp;&amp; git commit -m initial</code> first. Otherwise click below to proceed anyway.",
      "init.unknownRoot": "(unknown root)",

      "setup.title": "Setup",
      "setup.subtitle": "— roles, runtime files, per-window activation",
      "setup.role.title": "Create role",
      "setup.role.id": "Id (no spaces; <code>[A-Za-z0-9_-]</code>)",
      "setup.role.titleLabel": "Title (human-readable)",
      "setup.role.desc": "Description (one line, optional)",
      "setup.role.owns": "Owns (comma-separated paths)",
      "setup.role.reports": "Reports to (comma-separated roles)",
      "setup.role.mne": "Must not edit (comma-separated paths)",
      "setup.role.button": "Create role",
      "setup.role.hint": "After create, fill the TBD sections in <code>.gojaja/roles/&lt;id&gt;.md</code> before activating.",
      "setup.role.creating": "creating…",
      "setup.role.created": "Created role '{id}'.",
      "setup.role.needsFill": " Edit {path} to fill the TBD sections before activating.",
      "setup.prompt.title": "Install runtime files",
      "setup.prompt.target": "Target host",
      "setup.prompt.optAgents": "agents (writes AGENTS.md — covers Codex / Cursor / Copilot / Windsurf / Zed)",
      "setup.prompt.optClaude": "claude (writes CLAUDE.md)",
      "setup.prompt.optCursor": "cursor (writes .cursor/rules/gojaja-runtime.mdc)",
      "setup.prompt.optGeneric": "generic (preview only — bundled into activate snippet)",
      "setup.prompt.force": "Force rewrite (overwrite even if file is byte-identical)",
      "setup.prompt.noHandbook": "Skip the cheatsheet (smaller card, less guidance)",
      "setup.prompt.button": "Install",
      "setup.prompt.hint": "Hosts only inject these files when an agent window first opens — restart any open window after a write.",
      "setup.prompt.installing": "installing…",
      "setup.prompt.previewed": "Generic target previewed (no files written; bundled into the activate snippet).",
      "setup.prompt.installed": "Installed. Restart any open agent window for it to pick up the new rules.",
      "setup.prompt.unchanged": "Already up to date — no files changed.",
      "setup.prompt.wrote": "WROTE ",
      "setup.prompt.unchangedPrefix": "UNCHANGED ",
      "setup.act.title": "Activate (per-window snippet)",
      "setup.act.role": "Role",
      "setup.act.target": "Target host",
      "setup.act.optGeneric": "generic (snippet bundles runtime body)",
      "setup.act.button": "Generate snippet",
      "setup.act.outPlaceholder": "(snippet appears here after Generate)",
      "setup.act.copyButton": "Copy snippet",
      "setup.act.hint": "Paste the snippet into the agent window's chat to bind that window to the role. Refuses if the role's <code>.md</code> still has TBD sections.",
      "setup.act.generating": "generating…",
      "setup.act.ready": "Snippet ready — copy and paste into the agent window for '{role}'.",
      "setup.act.copied": "Copied to clipboard.",
      "setup.act.copyFailed": "Copy failed — select the snippet manually.",
      "setup.act.pickRole": "Pick a role first.",
      "setup.footer": "Setup actions require <code>.gojaja/</code> to exist (run <em>Initialise</em> first if missing) and must be on a loopback bind to be visible.",

      "actions.title": "Actions",
      "actions.subtitle": "— posted as <code style=\\"background:var(--panel2);padding:1px 5px;border-radius:3px\\">SYSTEM</code> (project-owner)",
      "actions.footer": "All actions emit events as <code>from: SYSTEM</code> — the same as running the gojaja CLI in a shell with no <code>GOJAJA_SESSION</code>. Visible only when watch is bound to loopback.",
      "actions.report.title": "Send report",
      "actions.report.to": "To role",
      "actions.report.message": "Message",
      "actions.report.msgPlaceholder": "What you need them to do next.",
      "actions.report.ref": "Ref (optional)",
      "actions.report.button": "Send report",
      "actions.report.sending": "sending…",
      "actions.report.sent": "Reported {id}.",
      "actions.rfc.title": "Open RFC",
      "actions.rfc.slug": "Slug",
      "actions.rfc.titleLabel": "Title",
      "actions.rfc.deciders": "Deciders (comma-separated roles)",
      "actions.rfc.voters": "Voters (comma-separated, optional)",
      "actions.rfc.options": "Options (id:summary, comma-separated, optional)",
      "actions.rfc.desc": "Description",
      "actions.rfc.descPlaceholder": "Context the voters/deciders need to weigh in.",
      "actions.rfc.button": "Open RFC",
      "actions.rfc.creating": "creating…",
      "actions.rfc.created": "Created {id}.",
      "actions.task.title": "Create task",
      "actions.task.titleLabel": "Title",
      "actions.task.owner": "Owner (optional)",
      "actions.task.unassigned": "(unassigned)",
      "actions.task.priority": "Priority",
      "actions.task.acc": "Acceptance criteria (optional)",
      "actions.task.accPlaceholder": "What 'done' looks like.",
      "actions.task.button": "Create task",
      "actions.task.creating": "creating…",
      "actions.task.created": "Created {id}.",

      "fillRole.selectRole": "(select role)",
      "fillRole.noRoles": "(no roles yet — Create role first)",
      "fillRole.broadcast": "@All — broadcast (SYSTEM)",
    },
    "zh-CN": {
      "header.connecting": "连接中…",
      "header.rolesLive": "在线角色",
      "header.working": "工作中",
      "header.openRfcs": "未决 RFC",
      "header.events": "事件数",
      "header.updated": "{ago}已更新",
      "header.lostConnection": "已与 gojaja watch 断开连接（{error}）。服务还在运行吗？",

      "tabs.dashboard": "概览",
      "tabs.archived": "已归档",
      "tabs.setup": "设置",
      "tabs.actions": "操作",

      "sec.roles": "角色",
      "sec.taskBoard": "任务看板",
      "sec.legendTitle": "优先级图例 — 通过 --priority 设置。颜色与每张卡片左侧条带一致。",
      "sec.boardCollapseHint": "点击折叠 / 展开任务看板",
      "sec.rfcs": "RFC",
      "sec.activity": "活动",
      "sec.archived": "已归档任务",
      "sec.archivedSub": "— 在 Done 状态停留 48 小时后自动从主看板隐藏，按本地最后更新日期分组。",

      "status.Backlog": "待办",
      "status.Pending": "待处理",
      "status.InProgress": "进行中",
      "status.Blocked": "受阻",
      "status.Review": "评审中",
      "status.Done": "已完成",

      "badge.live": "在线",
      "badge.stale": "已过期",
      "badge.none": "无",
      "badge.working": "工作中",

      "role.noSession": "无活动会话",
      "role.sessionMeta": "pid {pid} @ {host} · 心跳 {ago}",
      "role.owns": "负责：{paths}",
      "role.waiting": "⏳ 等待 {condition} · {until}",
      "role.waitingAttention": "处理",
      "role.workingNote": "💼 工作中 — 已专注 {age}。期间无 gojaja 活动；通常意味着正在写代码或跑测试。",

      "role.empty": "尚未注册角色。",
      "rfcs.empty": "暂无 RFC。",
      "board.empty": "—",
      "feed.empty": "暂无事件。",
      "archived.empty": "暂无已归档任务。任务在 Done 状态停留 48 小时后会自动归档到此。",

      "rfc.clickCollapse": "点击折叠",
      "rfc.clickExpand": "点击展开",
      "rfc.deciders": "决策者：{list}",
      "rfc.voters": "投票者：{list}",
      "rfc.tasks": "关联任务：{list}",
      "rfc.deadline": "截止：{when}",
      "rfc.options": "选项",
      "rfc.optionNoSummary": "（无说明）",
      "rfc.comments": "评论（{n}）",
      "rfc.decisionBy": "{outcome} · 决策者 {who}",
      "rfc.decisionOption": " · 选项 {id}",

      "feed.atAll": "@所有人",
      "feed.noBody": "（{type} — 无消息正文）",

      "task.unassigned": "（未分配）",
      "task.blocked": "⛔ {deps}",

      "time.justNow": "刚刚",
      "time.sAgo": "{n} 秒前",
      "time.mAgo": "{n} 分前",
      "time.hAgo": "{n} 小时前",
      "time.dAgo": "{n} 天前",
      "time.noDeadline": "无截止",
      "time.passed": "已过期",
      "time.inS": "{n} 秒后",
      "time.inM": "{n} 分后",
      "time.inH": "{n} 小时后",
      "time.sShort": "{n}秒",
      "time.mShort": "{n}分",
      "time.hShort": "{n}时",
      "time.dShort": "{n}天",
      "time.unknown": "?",
      "time.today": "今天",
      "time.yesterday": "昨天",

      "init.title": "初始化此项目",
      "init.blurb": "<code>gojaja init</code> 会在项目根目录创建 <code>.gojaja/</code> 目录，用于持久化团队协作状态（事件、会话、任务、RFC）。已存在该目录时再次运行是无操作，除非先 <code>gojaja reset</code>。",
      "init.button": "初始化",
      "init.buttonForce": "我知道风险 — 强制初始化",
      "init.buttonNoGit": "无 git 初始化",
      "init.initialising": "初始化中…",
      "init.done": "已初始化。正在加载面板…",
      "init.alreadyDone": "已初始化 — 刷新中。",
      "init.refused": "已拒绝。",
      "init.gitClean": "git：工作区干净 — gojaja 的改动后续可回滚。",
      "init.gitDirty": "<b>git：检测到未提交改动。</b>请先提交或 stash，以便 gojaja 的改动易于回滚。",
      "init.gitNotRepo": "<b>不是 git 仓库。</b>没有版本控制时无法干净地撤销 gojaja 的改动。强烈建议先运行 <code>git init &amp;&amp; git add -A &amp;&amp; git commit -m initial</code>。否则点击下方按钮直接继续。",
      "init.unknownRoot": "（未知根目录）",

      "setup.title": "设置",
      "setup.subtitle": "— 角色、运行时文件、按窗口激活",
      "setup.role.title": "创建角色",
      "setup.role.id": "ID（不含空格；<code>[A-Za-z0-9_-]</code>）",
      "setup.role.titleLabel": "标题（人类可读）",
      "setup.role.desc": "描述（一行，可选）",
      "setup.role.owns": "拥有路径（逗号分隔）",
      "setup.role.reports": "汇报对象（逗号分隔的角色）",
      "setup.role.mne": "禁止编辑路径（逗号分隔）",
      "setup.role.button": "创建角色",
      "setup.role.hint": "创建后，请先在 <code>.gojaja/roles/&lt;id&gt;.md</code> 中填写 TBD 段落再激活。",
      "setup.role.creating": "创建中…",
      "setup.role.created": "已创建角色 '{id}'。",
      "setup.role.needsFill": " 请在激活前编辑 {path} 填充 TBD 段落。",
      "setup.prompt.title": "安装运行时文件",
      "setup.prompt.target": "目标宿主",
      "setup.prompt.optAgents": "agents（写入 AGENTS.md — 适用于 Codex / Cursor / Copilot / Windsurf / Zed）",
      "setup.prompt.optClaude": "claude（写入 CLAUDE.md）",
      "setup.prompt.optCursor": "cursor（写入 .cursor/rules/gojaja-runtime.mdc）",
      "setup.prompt.optGeneric": "generic（仅预览 — 内嵌到 activate 片段中）",
      "setup.prompt.force": "强制重写（即使文件字节相同也覆盖）",
      "setup.prompt.noHandbook": "跳过 cheatsheet（卡片更小，指引更少）",
      "setup.prompt.button": "安装",
      "setup.prompt.hint": "宿主仅在 agent 窗口首次打开时注入这些文件 — 写入后请重启已打开的窗口。",
      "setup.prompt.installing": "安装中…",
      "setup.prompt.previewed": "generic 目标已预览（未写入文件；已内嵌到 activate 片段）。",
      "setup.prompt.installed": "已安装。请重启已打开的 agent 窗口以应用新规则。",
      "setup.prompt.unchanged": "已是最新 — 没有文件被修改。",
      "setup.prompt.wrote": "已写入 ",
      "setup.prompt.unchangedPrefix": "未变更 ",
      "setup.act.title": "激活（按窗口生成片段）",
      "setup.act.role": "角色",
      "setup.act.target": "目标宿主",
      "setup.act.optGeneric": "generic（片段内嵌运行时正文）",
      "setup.act.button": "生成片段",
      "setup.act.outPlaceholder": "（生成后片段会出现在此）",
      "setup.act.copyButton": "复制片段",
      "setup.act.hint": "将片段粘贴到 agent 窗口的聊天中，将该窗口绑定到角色。如果角色的 <code>.md</code> 仍有 TBD 段落，会被拒绝。",
      "setup.act.generating": "生成中…",
      "setup.act.ready": "片段已就绪 — 复制并粘贴到 '{role}' 的 agent 窗口。",
      "setup.act.copied": "已复制到剪贴板。",
      "setup.act.copyFailed": "复制失败 — 请手动选择片段。",
      "setup.act.pickRole": "请先选择一个角色。",
      "setup.footer": "Setup 操作需要 <code>.gojaja/</code> 已存在（若缺失请先运行 <em>初始化</em>），且必须绑定到 loopback 地址才可见。",

      "actions.title": "操作",
      "actions.subtitle": "— 以 <code style=\\"background:var(--panel2);padding:1px 5px;border-radius:3px\\">SYSTEM</code>（项目所有者）身份发布",
      "actions.footer": "所有操作以 <code>from: SYSTEM</code> 发布事件 — 等同于在没有 <code>GOJAJA_SESSION</code> 的 shell 中运行 gojaja CLI。仅在绑定 loopback 时可见。",
      "actions.report.title": "发送通知",
      "actions.report.to": "目标角色",
      "actions.report.message": "消息",
      "actions.report.msgPlaceholder": "你希望他们下一步做什么。",
      "actions.report.ref": "引用（可选）",
      "actions.report.button": "发送通知",
      "actions.report.sending": "发送中…",
      "actions.report.sent": "已发送 {id}。",
      "actions.rfc.title": "新建 RFC",
      "actions.rfc.slug": "Slug",
      "actions.rfc.titleLabel": "标题",
      "actions.rfc.deciders": "决策者（逗号分隔的角色）",
      "actions.rfc.voters": "投票者（逗号分隔，可选）",
      "actions.rfc.options": "选项（id:说明，逗号分隔，可选）",
      "actions.rfc.desc": "描述",
      "actions.rfc.descPlaceholder": "决策者/投票者需要的背景信息。",
      "actions.rfc.button": "新建 RFC",
      "actions.rfc.creating": "创建中…",
      "actions.rfc.created": "已创建 {id}。",
      "actions.task.title": "新建任务",
      "actions.task.titleLabel": "标题",
      "actions.task.owner": "负责人（可选）",
      "actions.task.unassigned": "（未分配）",
      "actions.task.priority": "优先级",
      "actions.task.acc": "验收标准（可选）",
      "actions.task.accPlaceholder": "完成的判定标准。",
      "actions.task.button": "新建任务",
      "actions.task.creating": "创建中…",
      "actions.task.created": "已创建 {id}。",

      "fillRole.selectRole": "（请选择角色）",
      "fillRole.noRoles": "（暂无角色 — 请先创建）",
      "fillRole.broadcast": "@所有人 — 广播（SYSTEM）",
    },
  };

  var LANG_KEY = "gojaja:lang";
  function detectLang(){
    try {
      var stored = localStorage.getItem(LANG_KEY);
      if(stored && MESSAGES[stored]) return stored;
    } catch(e){}
    var nav = (navigator.language || navigator.userLanguage || "en").toLowerCase();
    if(nav.indexOf("zh") === 0) return "zh-CN";
    return "en";
  }
  var currentLang = detectLang();
  function setLang(lang){
    if(!MESSAGES[lang]) lang = "en";
    currentLang = lang;
    try { localStorage.setItem(LANG_KEY, lang); } catch(e){}
  }
  /* t("key", { name: value }) — falls back to en, then to the
     raw key. Placeholders {name} are substituted last so a missing
     value renders as "{name}" (loud, easy to spot in QA). */
  function t(key, params){
    var dict = MESSAGES[currentLang] || MESSAGES.en;
    var str = dict[key];
    if(str == null) str = MESSAGES.en[key];
    if(str == null) str = key;
    if(params){
      str = str.replace(/\\{(\\w+)\\}/g, function(_, name){
        return params[name] == null ? "{" + name + "}" : String(params[name]);
      });
    }
    return str;
  }
  /* Walks every [data-i18n*] element and substitutes its text /
     innerHTML / attributes. Idempotent: call after each language
     change OR after any innerHTML write that re-introduces
     unlocalised static markup. */
  function applyI18n(root){
    root = root || document;
    root.querySelectorAll("[data-i18n]").forEach(function(el){
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    root.querySelectorAll("[data-i18n-html]").forEach(function(el){
      el.innerHTML = t(el.getAttribute("data-i18n-html"));
    });
    root.querySelectorAll("[data-i18n-attr]").forEach(function(el){
      var pairs = (el.getAttribute("data-i18n-attr") || "").split(";");
      pairs.forEach(function(p){
        var i = p.indexOf(":"); if(i < 0) return;
        var attr = p.slice(0, i).trim();
        var key = p.slice(i + 1).trim();
        if(attr && key) el.setAttribute(attr, t(key));
      });
    });
  }
  function bindLangPicker(){
    var sel = document.getElementById("lang-picker");
    if(!sel) return;
    sel.value = currentLang;
    sel.addEventListener("change", function(){
      setLang(sel.value);
      applyI18n();
      tick();
    });
  }
  /* -------------------- end i18n --------------------------------- */

  /* v3.0.x T7: tracks which RFCs the user has chosen to expand.
     The dashboard re-renders the RFCs list every poll
     (innerHTML = renderRfcs(...)), which would otherwise nuke
     expansion state — keeping the source of truth in this Set
     plus localStorage means a poll-driven re-render snaps each
     card back to the user's intent. */
  var EXPANDED_RFCS_KEY = "gojaja:expandedRfcs";
  var expandedRfcs = (function(){
    try {
      var raw = localStorage.getItem(EXPANDED_RFCS_KEY);
      if(!raw) return new Set();
      return new Set(JSON.parse(raw));
    } catch(e){ return new Set(); }
  })();
  function persistExpandedRfcs(){
    try { localStorage.setItem(EXPANDED_RFCS_KEY, JSON.stringify([...expandedRfcs])); }
    catch(e){}
  }

  /* v3.0.x T16: tracks whether the user has collapsed the entire
     task board section. Mirrors expandedRfcs above but for a single
     boolean — when true, the board renders only column headers
     (status name + count), hiding individual task cards. */
  var BOARD_COLLAPSED_KEY = "gojaja:boardCollapsed";
  var boardCollapsed = (function(){
    try { return localStorage.getItem(BOARD_COLLAPSED_KEY) === "1"; }
    catch(e){ return false; }
  })();
  function persistBoardCollapsed(){
    try { localStorage.setItem(BOARD_COLLAPSED_KEY, boardCollapsed ? "1" : "0"); }
    catch(e){}
  }
  function esc(s){ s = (s==null?"":String(s));
    return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function ago(iso){ if(!iso) return ""; var ts = Date.parse(iso); if(!isFinite(ts)) return "";
    var s = Math.max(0, Math.floor((Date.now()-ts)/1000));
    if(s<60) return t("time.sAgo",{n:s});
    var m=Math.floor(s/60); if(m<60) return t("time.mAgo",{n:m});
    var h=Math.floor(m/60); if(h<24) return t("time.hAgo",{n:h});
    return t("time.dAgo",{n:Math.floor(h/24)}); }
  function until(iso){ if(!iso) return t("time.noDeadline");
    var ts=Date.parse(iso); if(!isFinite(ts)) return "";
    var s=Math.floor((ts-Date.now())/1000); if(s<=0) return t("time.passed");
    if(s<60) return t("time.inS",{n:s});
    var m=Math.floor(s/60); if(m<60) return t("time.inM",{n:m});
    return t("time.inH",{n:Math.floor(m/60)}); }
  function condText(c){ if(!c) return ""; return c.ref ? (c.kind+":"+c.ref) : c.kind; }

  function fmtAge(ms){ if(ms==null||!isFinite(ms)) return t("time.unknown");
    var s=Math.max(0,Math.floor(ms/1000));
    if(s<60) return t("time.sShort",{n:s});
    var m=Math.floor(s/60); if(m<60) return t("time.mShort",{n:m});
    var h=Math.floor(m/60); if(h<24) return t("time.hShort",{n:h});
    return t("time.dShort",{n:Math.floor(h/24)}); }

  function renderRoles(roles){
    if(!roles.length) return '<div class="empty">'+esc(t("role.empty"))+'</div>';
    return roles.map(function(r){
      var st = r.session.state;
      var meta = "";
      if(st!=="none"){
        meta = esc(t("role.sessionMeta", {
          pid: r.session.pid, host: r.session.host, ago: ago(r.session.heartbeatAt),
        }));
      } else { meta = esc(t("role.noSession")); }
      var waiting = r.wait
        ? '<div class="waiting">'+esc(t("role.waiting", {
            condition: condText(r.wait.for) || t("role.waitingAttention"),
            until: until(r.wait.deadline),
          }))+'</div>'
        : "";
      var owns = (r.owns&&r.owns.length)
        ? '<div class="meta">'+esc(t("role.owns", { paths: r.owns.join(", ") }))+'</div>'
        : "";
      var working = r.healthStatus === "working";
      var workingNote = working
        ? '<div class="working-note">'+
          esc(t("role.workingNote", { age: fmtAge(r.lastActionAgeMs) }))+
          '</div>'
        : "";
      var badge = working
        ? '<span class="badge working">'+esc(t("badge.working"))+'</span>'
        : '<span class="badge '+st+'">'+esc(t("badge."+st))+'</span>';
      return '<div class="role'+(working?' working':'')+'"><div style="display:flex;justify-content:space-between;align-items:baseline">'+
        '<span class="name">'+esc(r.id)+'</span>'+
        badge+'</div>'+
        '<div class="title">'+esc(r.title)+'</div>'+
        '<div class="meta">'+meta+'</div>'+owns+waiting+workingNote+'</div>';
    }).join("");
  }

  function renderBoard(tasks){
    var byStatus = {}; STATUSES.forEach(function(s){ byStatus[s]=[]; });
    tasks.forEach(function(tk){ (byStatus[tk.status]||(byStatus[tk.status]=[])).push(tk); });
    return STATUSES.map(function(s){
      var list = byStatus[s]||[];
      var cards = list.map(function(tk){
        var pri = (tk.priority||"P2").toLowerCase();
        var blk = (tk.dependsOn&&tk.dependsOn.length)
          ? '<div class="blk">'+esc(t("task.blocked",{deps:tk.dependsOn.join(", ")}))+'</div>'
          : "";
        var deliv = tk.deliverables ? ' · '+tk.deliverables+'📎' : "";
        return '<div class="task '+esc(pri)+'"><div class="tid">'+esc(tk.id)+' · '+esc(tk.priority||"")+deliv+'</div>'+
          '<div class="tt">'+esc(tk.title)+'</div>'+
          '<div class="to">'+esc(tk.owner||t("task.unassigned"))+'</div>'+blk+'</div>';
      }).join("") || '<div class="empty">'+esc(t("board.empty"))+'</div>';
      return '<div class="col"><h3>'+esc(t("status."+s))+'<span class="count">'+list.length+'</span></h3>'+cards+'</div>';
    }).join("");
  }

  function renderRfcs(rfcs){
    if(!rfcs.length) return '<div class="empty">'+esc(t("rfcs.empty"))+'</div>';
    return rfcs.map(function(r){
      var expanded = expandedRfcs.has(r.id);
      var caret = expanded ? "▼" : "▶";
      var headMeta = esc(t("rfc.deciders",{list:(r.deciders||[]).join(", ")}))+
        ' · '+esc(t("rfc.voters",{list:(r.voters||[]).join(", ")}))+
        ((r.relatedTasks&&r.relatedTasks.length)
          ? ' · '+esc(t("rfc.tasks",{list:r.relatedTasks.join(", ")})) : "")+
        (r.deadline ? ' · '+esc(t("rfc.deadline",{when:r.deadline})) : "");
      var headTitle = expanded ? t("rfc.clickCollapse") : t("rfc.clickExpand");
      var head =
        '<div class="rfc-head" data-rfc-id="'+esc(r.id)+'" title="'+esc(headTitle)+'">'+
          '<span class="rfc-caret">'+caret+'</span>'+
          '<span class="rid">'+esc(r.id)+'</span>'+
          '<span class="st '+esc(r.status)+'">'+esc(r.status)+'</span>'+
          '<span class="rfc-title">'+esc(r.title)+'</span>'+
          '<span class="rfc-meta">'+headMeta+'</span>'+
        '</div>';

      var desc = "";
      if(r.description && r.description.length > 0){
        desc = '<div class="rfc-desc">'+esc(r.description)+'</div>';
      }

      var opts = "";
      if(r.options && r.options.length > 0){
        opts =
          '<div class="rfc-section-h">'+esc(t("rfc.options"))+'</div>'+
          '<div class="rfc-options">'+
            r.options.map(function(o){
              return '<div class="opt"><span class="oid">'+esc(o.id)+'</span>'+
                '<span>'+esc(o.summary || t("rfc.optionNoSummary"))+'</span></div>';
            }).join("")+
          '</div>';
      }

      var cmts = "";
      if(r.comments && r.comments.length > 0){
        cmts =
          '<div class="rfc-section-h">'+esc(t("rfc.comments",{n:r.comments.length}))+'</div>'+
          '<div class="rfc-comments">'+
            r.comments.map(function(c){
              var kindBadge = "";
              if(c.kind){
                kindBadge = '<span class="cmt-kind '+esc(c.kind)+'">'+
                  esc(c.kind)+'</span>';
              }
              var pref = c.preferred
                ? '<span class="rfc-meta"> → '+esc(c.preferred)+'</span>'
                : "";
              var cls = c.replyTo ? "rfc-cmt cmt-reply" : "rfc-cmt";
              return '<div class="'+cls+'">'+
                '<span class="cmt-who">'+esc(c.role)+'</span>'+
                kindBadge+pref+
                '<span class="rfc-meta"> · '+esc(ago(c.ts))+'</span>'+
                '<div class="cmt-body">'+esc(c.rationale || "")+'</div>'+
                '</div>';
            }).join("")+
          '</div>';
      }

      var dec = "";
      if(r.decision){
        var decCls = r.decision.outcome === "rejected"
          ? "rfc-decision rejected" : "rfc-decision";
        var optStr = r.decision.chosenOption
          ? esc(t("rfc.decisionOption",{id:r.decision.chosenOption})) : "";
        dec =
          '<div class="'+decCls+'">'+
            '<div class="dec-head">'+
              esc(t("rfc.decisionBy",{outcome:r.decision.outcome,who:r.decision.decidedBy}))+
              optStr+
              ' · '+esc(ago(r.decision.ts))+
            '</div>'+
            '<div class="dec-body">'+esc(r.decision.rationale || "")+'</div>'+
          '</div>';
      }

      var rfcCls = expanded ? "rfc expanded" : "rfc collapsed";
      return '<div class="'+rfcCls+'">'+head+desc+opts+cmts+dec+'</div>';
    }).join("");
  }

  /**
   * Format a Date as the local-day label shown above each Archived
   * block. "Today" / "Yesterday" for the two most recent days, then
   * a plain ISO-ish YYYY-MM-DD. Uses the browser's local timezone
   * (consistent with the user's reading "what shipped this week").
   */
  function archDayLabel(d){
    var today = new Date();
    var sameYMD = function(a, b){
      return a.getFullYear() === b.getFullYear() &&
        a.getMonth() === b.getMonth() &&
        a.getDate() === b.getDate();
    };
    if(sameYMD(d, today)) return t("time.today");
    var yest = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if(sameYMD(d, yest)) return t("time.yesterday");
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var dd = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + dd;
  }

  /**
   * Group archived tasks by the local day of their updatedAt and
   * render each day as a block. Server pre-sorts the list newest-first
   * so a single pass preserves order both within and across days.
   * Day buckets keyed by YYYY-MM-DD in local time (collision-proof
   * for the duration of the page; we don't need sortable keys because
   * server order is the source of truth).
   */
  function renderArchived(tasks){
    if(!tasks || !tasks.length){
      return '<div class="empty">'+esc(t("archived.empty"))+'</div>';
    }
    var days = []; // ordered [{ key, label, items }]
    var byKey = {};
    tasks.forEach(function(tk){
      var d = new Date(tk.updatedAt);
      if(isNaN(d.getTime())) d = new Date(0);
      var key = d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
      var bucket = byKey[key];
      if(!bucket){
        bucket = { key: key, label: archDayLabel(d), items: [] };
        byKey[key] = bucket;
        days.push(bucket);
      }
      bucket.items.push(tk);
    });
    return days.map(function(day){
      var cards = day.items.map(function(tk){
        var pri = (tk.priority || "P2").toLowerCase();
        return '<div class="arch-card">'+
          '<span class="aid">'+esc(tk.id)+'</span>'+
          '<span class="att">'+esc(tk.title)+'</span>'+
          '<span class="ato">'+esc(tk.owner || t("task.unassigned"))+'</span>'+
          '<span class="apr '+esc(pri)+'">'+esc(tk.priority || "")+'</span>'+
          '</div>';
      }).join("");
      return '<div class="archived-day">'+
        '<h3>'+esc(day.label)+'<span class="count">'+day.items.length+'</span></h3>'+
        cards+'</div>';
    }).join("");
  }

  /* v3.0.x T11: bucket each event's type into one of five visual
     categories so the .ety pill picks up the matching colour. The
     categories track narrative role:
       REPORT   -> communication (blue / accent)
       WORKLOG  -> progress signal (green / live)
       TASK_*   -> task action (amber / stale)
       RFC_*    -> RFC narrative (purple)
       ROLE_*   -> governance (muted gray)
     Anything outside these falls through to the default pill
     (gray on gray) — operational events have already been
     filtered out at buildSnapshot (T9). */
  function eventTypeClass(t){
    if(t === "REPORT") return "type-report";
    if(t === "WORKLOG") return "type-worklog";
    if(t.indexOf("TASK_") === 0) return "type-task";
    if(t.indexOf("RFC_") === 0) return "type-rfc";
    if(t.indexOf("ROLE_") === 0) return "type-role";
    return "";
  }

  function renderFeed(events){
    if(!events.length) return '<div class="empty">'+esc(t("feed.empty"))+'</div>';
    return events.map(function(e){
      var isSystem = e.from === "SYSTEM";
      var rowCls = isSystem ? "bubble-row from-system" : "bubble-row from-member";
      var bubbleCls = isSystem ? "bubble from-system" : "bubble from-member";

      var toLabel = e.to === "*"
        ? '<span class="at-target all">'+esc(t("feed.atAll"))+'</span>'
        : '<span class="at-target">@'+esc(e.to)+'</span>';

      var refLine = e.ref
        ? '<span class="ref">'+esc(e.ref)+'</span>' : "";

      var bodyHtml;
      if(e.message){
        bodyHtml = '<div class="bubble-body">'+esc(e.message)+'</div>';
      } else {
        bodyHtml = '<div class="bubble-body empty">'+
          esc(t("feed.noBody",{type:e.type}))+'</div>';
      }

      var etyCls = eventTypeClass(e.type);
      var etyClsAttr = etyCls ? (' '+etyCls) : "";
      return '<div class="'+rowCls+'">'+
        '<div class="'+bubbleCls+'">'+
          '<div class="bubble-meta">'+
            '<span class="who">'+esc(e.from)+'</span>'+
            '<span class="ety'+etyClsAttr+'">'+esc(e.type)+'</span>'+
            refLine+
            '<span class="et">'+esc(ago(e.ts))+'</span>'+
          '</div>'+
          '<div class="bubble-to">'+toLabel+'</div>'+
          bodyHtml+
        '</div>'+
      '</div>';
    }).join("");
  }

  function showErr(msg){ var el=document.getElementById("err"); el.textContent=msg; el.style.display="block"; }
  function clearErr(){ document.getElementById("err").style.display="none"; }

  function render(s){
    clearErr();
    // Two top-level UIs depending on whether the project has run
    // gojaja init yet. The state envelope from /api/state carries
    // an "initialised" boolean to drive this branch; uninitialised
    // projects get a single-screen "Initialise" landing page (no
    // tabs, no chips for counts that would all be zero anyway).
    if(!s.initialised){ renderInitScreen(s); return; }
    showInitialisedChrome();
    document.getElementById("root").textContent = s.project.root+"  ·  v"+s.project.version;
    document.getElementById("upd").textContent = t("header.updated", {ago: ago(s.project.generatedAt)});
    document.getElementById("c-live").textContent = s.counts.liveRoles;
    var workingCount = s.counts.workingRoles || 0;
    var workingChip = document.getElementById("chip-working");
    document.getElementById("c-working").textContent = workingCount;
    workingChip.style.display = workingCount > 0 ? "" : "none";
    workingChip.style.color = workingCount > 0 ? "var(--working)" : "";
    document.getElementById("c-rfc").textContent = s.counts.openRfcs;
    document.getElementById("c-ev").textContent = s.counts.totalEvents;
    document.getElementById("roles").innerHTML = renderRoles(s.roles);
    document.getElementById("board").innerHTML = renderBoard(s.tasks);
    applyBoardCollapsed();
    document.getElementById("rfcs").innerHTML = renderRfcs(s.rfcs);
    document.getElementById("feed").innerHTML = renderFeed(s.events);
    var archived = s.archivedTasks || [];
    document.getElementById("archived").innerHTML = renderArchived(archived);
    var archCountBadge = document.getElementById("tab-archived-count");
    if(archived.length > 0){
      archCountBadge.textContent = archived.length;
      archCountBadge.style.display = "";
    } else {
      archCountBadge.style.display = "none";
    }
    renderActions(s);
  }

  // ---- Init landing page ---------------------------------------

  /**
   * State machine for the Initialise button:
   *   - "ready"   plain init, force=false; first click on a clean repo
   *   - "confirm" the previous attempt was refused with INIT_GIT_GATE
   *               (dirty / not-a-repo) and the user is being asked to
   *               re-submit with force:true. The button label and
   *               style change to "I understand, force init".
   */
  var initButtonState = "ready";

  function showInitScreen(){
    document.getElementById("init-screen").classList.add("active");
    document.getElementById("tabs").style.display = "none";
    document.getElementById("panels").style.display = "none";
    // Some chips lose meaning on the init screen (zero-state); hide
    // the count chips but keep the "updated" pulse so the user can
    // see watch is alive.
    ["c-live","c-working","c-rfc","c-ev"].forEach(function(id){
      var el = document.getElementById(id);
      if(el && el.parentElement) el.parentElement.style.display = "none";
    });
    document.getElementById("chip-working").style.display = "none";
  }

  function showInitialisedChrome(){
    document.getElementById("init-screen").classList.remove("active");
    document.getElementById("tabs").style.display = "";
    document.getElementById("panels").style.display = "";
    ["c-live","c-rfc","c-ev"].forEach(function(id){
      var el = document.getElementById(id);
      if(el && el.parentElement) el.parentElement.style.display = "";
    });
  }

  function renderInitScreen(s){
    showInitScreen();
    document.getElementById("init-root").textContent = (s.project && s.project.root) || t("init.unknownRoot");
    var git = (s.init && s.init.git) || { kind: "clean" };
    document.getElementById("init-git").innerHTML = renderGitState(git);
    var btn = document.getElementById("init-go");
    if(git.kind === "dirty"){
      btn.textContent = t("init.buttonForce");
      btn.classList.add("danger");
      initButtonState = "confirm";
    } else if(git.kind === "not-a-repo"){
      btn.textContent = t("init.buttonNoGit");
      btn.classList.add("danger");
      initButtonState = "confirm";
    } else {
      btn.textContent = t("init.button");
      btn.classList.remove("danger");
      initButtonState = "ready";
    }
  }

  function renderGitState(git){
    if(git.kind === "clean"){
      return '<div class="git">'+t("init.gitClean")+'</div>';
    }
    if(git.kind === "dirty"){
      var sample = (git.sample || []).map(function(l){ return esc(l); }).join("\\n");
      return '<div class="git bad">'+t("init.gitDirty")+
        '<pre>'+sample+'</pre></div>';
    }
    return '<div class="git warn">'+t("init.gitNotRepo")+'</div>';
  }

  function bindInitButton(){
    document.getElementById("init-go").addEventListener("click", function(){
      var btn = this;
      var fb = document.getElementById("init-fb");
      var force = (initButtonState === "confirm");
      btn.disabled = true; fb.className = "feedback"; fb.textContent = t("init.initialising");
      postJson("/api/init", { force: force }).then(function(r){
        btn.disabled = false;
        if(r.ok){
          fb.className = "feedback ok";
          fb.textContent = t("init.done");
          // Force an immediate refresh so the dashboard chrome
          // takes over without the next 2 s poll lag.
          setTimeout(tick, 200);
          return;
        }
        if(r.body && r.body.errorCode === "INIT_GIT_GATE"){
          fb.className = "feedback err";
          fb.textContent = r.body.error || t("init.refused");
          if(r.body.git){
            document.getElementById("init-git").innerHTML = renderGitState(r.body.git);
          }
          btn.textContent = (r.body.git && r.body.git.kind === "dirty")
            ? t("init.buttonForce")
            : t("init.buttonNoGit");
          btn.classList.add("danger");
          initButtonState = "confirm";
          return;
        }
        if(r.body && r.body.errorCode === "ALREADY_INITIALISED"){
          fb.className = "feedback ok";
          fb.textContent = t("init.alreadyDone");
          setTimeout(tick, 200);
          return;
        }
        fb.className = "feedback err";
        fb.textContent = (r.body && r.body.error) || ("HTTP " + r.status);
      }).catch(function(e){
        btn.disabled = false;
        fb.className = "feedback err";
        fb.textContent = String(e);
      });
    });
  }

  // ---- Tab switching --------------------------------------------

  function bindTabs(){
    var tabs = document.querySelectorAll(".tab");
    tabs.forEach(function(t){
      t.addEventListener("click", function(){
        tabs.forEach(function(x){ x.classList.remove("active"); });
        t.classList.add("active");
        var which = t.getAttribute("data-tab");
        document.querySelectorAll(".panel").forEach(function(p){
          p.classList.toggle("active", p.id === "panel-"+which);
        });
      });
    });
  }

  // ---- Actions panel (loopback-only) ----------------------------

  function fillRoleSelects(roles){
    // Snapshot current selection so re-renders during typing do not
    // wipe what the user just picked.
    var ids = roles.map(function(r){ return r.id; });
    // [elementId, emptyOptionLabel, allowBroadcast]: rep-to / act-role
    // start blank so the operator must explicitly pick a recipient;
    // task-owner keeps "(unassigned)". rep-to additionally offers
    // a top-of-list "@All — broadcast (SYSTEM)" entry as the v3.0.x
    // SYSTEM-broadcast surface; selecting it sends to="*" via the
    // existing /api/report endpoint, which the server posts as
    // from="SYSTEM" (the dashboard's Send Report panel is always a
    // project-owner action — see the section header).
    [
      ["rep-to", "fillRole.selectRole", true, false],
      ["task-owner", "task.unassigned", false, true],
      ["act-role", "fillRole.selectRole", false, false],
    ].forEach(function(spec){
      var sel = document.getElementById(spec[0]);
      if(!sel) return;
      var prev = sel.value;
      var emptyKey = spec[1];
      var allowBroadcast = spec[2];
      var isOwnerLike = spec[3];
      var opts;
      if(ids.length === 0){
        opts = isOwnerLike
          ? '<option value="">'+esc(t("task.unassigned"))+'</option>'
          : '<option value="">'+esc(t("fillRole.noRoles"))+'</option>';
      } else {
        opts = '<option value="">'+esc(t(emptyKey))+'</option>';
        if(allowBroadcast){
          opts += '<option value="*">'+esc(t("fillRole.broadcast"))+'</option>';
        }
        opts += ids.map(function(id){
          return '<option value="'+esc(id)+'">'+esc(id)+'</option>';
        }).join("");
      }
      if(sel.innerHTML !== opts){ sel.innerHTML = opts; }
      var stillValid = (prev === "*" && allowBroadcast) ||
                       (prev && ids.indexOf(prev) >= 0);
      if(stillValid){ sel.value = prev; }
    });
  }

  function renderActions(s){
    var enabled = s.capabilities && s.capabilities.writeEnabled;
    var actionsSec = document.getElementById("sec-actions");
    var setupSec = document.getElementById("sec-setup");
    actionsSec.style.display = enabled ? "" : "none";
    setupSec.style.display = enabled ? "" : "none";
    if(!enabled) return;
    fillRoleSelects(s.roles || []);
  }

  function setFb(id, kind, msg){
    var el = document.getElementById(id);
    el.className = "feedback " + (kind || "");
    el.textContent = msg || "";
  }

  function postJson(url, body){
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(function(r){
      return r.json().then(function(j){ return { ok: r.ok, status: r.status, body: j }; });
    });
  }

  function bindActionButtons(){
    var splitCsv = function(s){ return (s||"").split(",").map(function(x){return x.trim();}).filter(Boolean); };

    document.getElementById("rep-go").addEventListener("click", function(){
      var btn = this;
      var to = document.getElementById("rep-to").value;
      if(!to){ setFb("rep-fb", "err", t("setup.act.pickRole")); return; }
      btn.disabled = true; setFb("rep-fb", "", t("actions.report.sending"));
      postJson("/api/report", {
        to: to,
        message: document.getElementById("rep-msg").value,
        ref: document.getElementById("rep-ref").value,
      }).then(function(r){
        btn.disabled = false;
        if(!r.ok){ setFb("rep-fb", "err", r.body.error || ("HTTP "+r.status)); return; }
        setFb("rep-fb", "ok", t("actions.report.sent", {id: (r.body.event && r.body.event.id) || ""}));
        document.getElementById("rep-to").value = "";
        document.getElementById("rep-msg").value = "";
        document.getElementById("rep-ref").value = "";
        tick();
      }).catch(function(e){ btn.disabled = false; setFb("rep-fb", "err", String(e)); });
    });
    document.getElementById("rfc-go").addEventListener("click", function(){
      var btn = this; btn.disabled = true; setFb("rfc-fb", "", t("actions.rfc.creating"));
      var optsRaw = splitCsv(document.getElementById("rfc-options").value);
      var opts = optsRaw.map(function(p){
        var i = p.indexOf(":"); return i < 0 ? null : { id: p.slice(0,i).trim(), summary: p.slice(i+1).trim() };
      }).filter(Boolean);
      postJson("/api/rfc", {
        slug: document.getElementById("rfc-slug").value.trim(),
        title: document.getElementById("rfc-title").value.trim(),
        deciders: splitCsv(document.getElementById("rfc-deciders").value),
        voters: splitCsv(document.getElementById("rfc-voters").value),
        options: opts,
        description: document.getElementById("rfc-desc").value,
      }).then(function(r){
        btn.disabled = false;
        if(!r.ok){ setFb("rfc-fb", "err", r.body.error || ("HTTP "+r.status)); return; }
        setFb("rfc-fb", "ok", t("actions.rfc.created", {id: (r.body.proposal && r.body.proposal.id) || ""}));
        ["rfc-slug","rfc-title","rfc-deciders","rfc-voters","rfc-options","rfc-desc"].forEach(function(id){
          document.getElementById(id).value = "";
        });
        tick();
      }).catch(function(e){ btn.disabled = false; setFb("rfc-fb", "err", String(e)); });
    });

    document.getElementById("role-go").addEventListener("click", function(){
      var btn = this; btn.disabled = true; setFb("role-fb", "", t("setup.role.creating"));
      postJson("/api/role", {
        id: document.getElementById("role-id").value.trim(),
        title: document.getElementById("role-title").value.trim(),
        description: document.getElementById("role-desc").value,
        owns: splitCsv(document.getElementById("role-owns").value),
        reportsTo: splitCsv(document.getElementById("role-reports").value),
        mustNotEdit: splitCsv(document.getElementById("role-mne").value),
      }).then(function(r){
        btn.disabled = false;
        if(!r.ok){ setFb("role-fb", "err", r.body.error || ("HTTP "+r.status)); return; }
        var msg = t("setup.role.created", {id: (r.body.role && r.body.role.id) || ""});
        if(r.body.needsFill){
          msg += t("setup.role.needsFill", {path: r.body.rolePath});
        }
        setFb("role-fb", "ok", msg);
        ["role-id","role-title","role-desc","role-owns","role-reports","role-mne"].forEach(function(id){
          document.getElementById(id).value = "";
        });
        tick();
      }).catch(function(e){ btn.disabled = false; setFb("role-fb", "err", String(e)); });
    });

    document.getElementById("prompt-go").addEventListener("click", function(){
      var btn = this; btn.disabled = true; setFb("prompt-fb", "", t("setup.prompt.installing"));
      postJson("/api/prompt", {
        target: document.getElementById("prompt-target").value,
        forceRewrite: document.getElementById("prompt-force").checked,
        withHandbook: !document.getElementById("prompt-no-handbook").checked,
      }).then(function(r){
        btn.disabled = false;
        if(!r.ok){ setFb("prompt-fb", "err", r.body.error || ("HTTP "+r.status)); return; }
        var wrote = r.body.wrote || [];
        if(wrote.length === 0 && r.body.status === "previewed"){
          setFb("prompt-fb", "ok", t("setup.prompt.previewed"));
          return;
        }
        var lines = wrote.map(function(w){
          return (w.result === "wrote" ? t("setup.prompt.wrote") : t("setup.prompt.unchangedPrefix")) + w.path;
        });
        var head = r.body.requiresWindowRestart
          ? t("setup.prompt.installed")
          : t("setup.prompt.unchanged");
        setFb("prompt-fb", "ok", head + " (" + lines.join("; ") + ")");
      }).catch(function(e){ btn.disabled = false; setFb("prompt-fb", "err", String(e)); });
    });

    document.getElementById("act-go").addEventListener("click", function(){
      var btn = this;
      var role = document.getElementById("act-role").value;
      if(!role){ setFb("act-fb", "err", t("setup.act.pickRole")); return; }
      btn.disabled = true; setFb("act-fb", "", t("setup.act.generating"));
      var out = document.getElementById("act-out");
      var copyBtn = document.getElementById("act-copy");
      out.value = "";
      copyBtn.style.display = "none";
      postJson("/api/activate", {
        role: role,
        target: document.getElementById("act-target").value,
      }).then(function(r){
        btn.disabled = false;
        if(!r.ok){ setFb("act-fb", "err", r.body.error || ("HTTP "+r.status)); return; }
        out.value = r.body.activation || "";
        copyBtn.style.display = "";
        setFb("act-fb", "ok", t("setup.act.ready", {role: r.body.role}));
      }).catch(function(e){ btn.disabled = false; setFb("act-fb", "err", String(e)); });
    });

    document.getElementById("act-copy").addEventListener("click", function(){
      var out = document.getElementById("act-out");
      out.select();
      var doneOk = function(){ setFb("act-fb", "ok", t("setup.act.copied")); };
      var doneFail = function(){ setFb("act-fb", "err", t("setup.act.copyFailed")); };
      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(out.value).then(doneOk).catch(function(){
          try { document.execCommand("copy"); doneOk(); } catch (e) { doneFail(); }
        });
      } else {
        try { document.execCommand("copy"); doneOk(); } catch (e) { doneFail(); }
      }
    });

    document.getElementById("task-go").addEventListener("click", function(){
      var btn = this; btn.disabled = true; setFb("task-fb", "", t("actions.task.creating"));
      postJson("/api/task", {
        title: document.getElementById("task-title").value.trim(),
        owner: document.getElementById("task-owner").value || null,
        priority: document.getElementById("task-pri").value,
        acceptance: document.getElementById("task-acc").value,
      }).then(function(r){
        btn.disabled = false;
        if(!r.ok){ setFb("task-fb", "err", r.body.error || ("HTTP "+r.status)); return; }
        setFb("task-fb", "ok", t("actions.task.created", {id: (r.body.task && r.body.task.id) || ""}));
        ["task-title","task-acc"].forEach(function(id){ document.getElementById(id).value = ""; });
        tick();
      }).catch(function(e){ btn.disabled = false; setFb("task-fb", "err", String(e)); });
    });
  }

  function tick(){
    fetch("/api/state", { cache: "no-store" })
      .then(function(r){ if(!r.ok) throw new Error("HTTP "+r.status); return r.json(); })
      .then(render)
      .catch(function(e){ showErr(t("header.lostConnection", {error: e.message})); });
  }

  /* v3.0.x T16: sync the board's collapsed class + caret to the
     persisted boardCollapsed flag. Called after each render() so
     poll-driven re-renders snap back to the user's intent. */
  function applyBoardCollapsed(){
    var board = document.getElementById("board");
    if(board) board.classList.toggle("collapsed", boardCollapsed);
    var caret = document.getElementById("board-caret");
    if(caret) caret.textContent = boardCollapsed ? "▶" : "▼";
  }

  /* v3.0.x T16: click handler for the Task board section heading.
     Toggles the persisted flag and updates the rendered DOM in
     place — no /api/state round-trip. */
  function bindBoardCollapseToggle(){
    var head = document.getElementById("board-head");
    if(!head) return;
    head.addEventListener("click", function(){
      boardCollapsed = !boardCollapsed;
      persistBoardCollapsed();
      applyBoardCollapsed();
    });
  }

  /* v3.0.x T7: delegated click handler for RFC head rows. Toggles
     expansion state (Set + localStorage) and updates the affected
     card's class / caret in place — no /api/state round-trip. */
  function bindRfcCollapseToggle(){
    var container = document.getElementById("rfcs");
    if(!container) return;
    container.addEventListener("click", function(ev){
      var head = ev.target.closest(".rfc-head");
      if(!head || !container.contains(head)) return;
      var id = head.getAttribute("data-rfc-id");
      if(!id) return;
      if(expandedRfcs.has(id)) expandedRfcs.delete(id);
      else expandedRfcs.add(id);
      persistExpandedRfcs();
      var card = head.closest(".rfc");
      if(!card) return;
      var nowExpanded = expandedRfcs.has(id);
      card.classList.toggle("expanded", nowExpanded);
      card.classList.toggle("collapsed", !nowExpanded);
      var caret = head.querySelector(".rfc-caret");
      if(caret) caret.textContent = nowExpanded ? "▼" : "▶";
      head.setAttribute("title", t(nowExpanded ? "rfc.clickCollapse" : "rfc.clickExpand"));
    });
  }

  applyI18n();
  bindLangPicker();
  bindActionButtons();
  bindInitButton();
  bindTabs();
  bindBoardCollapseToggle();
  bindRfcCollapseToggle();
  tick();
  setInterval(tick, 2000);
</script>
</body>
</html>`;
