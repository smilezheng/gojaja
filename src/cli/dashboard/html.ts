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
     future theme switch only needs to edit this :root block. */
  :root {
    color-scheme: light;
    --bg: #f6f8fa;        /* was #0f1115 */
    --panel: #ffffff;     /* was #171a21 */
    --panel2: #f1f4f8;    /* was #1e222b */
    --line: #d8dee5;      /* was #2a2f3a */
    --fg: #1a1f29;        /* was #e6e8ee */
    --dim: #57606a;       /* was #8b93a7 */
    --accent: #0969da;    /* was #6ea8fe */
    --live: #1a7f37;      /* was #3fb950 */
    --stale: #9a6700;     /* was #d29922 */
    --none: #6e7781;      /* was #6b7280 */
    /* v3.0.x N: working = neutral blue (informational, NOT alarm).
       Init card's dirty-git warning + danger button keep --stalled
       red since those ARE real warnings. */
    --working: #0969da; --working-bg: #ddf4ff; --working-border: #80ccff;
    --stalled: #cf222e; --stalled-bg: #ffebe9; --stalled-border: #ffc4be;
    --p0: #cf222e;        /* was #f85149 */
    --p1: #9a6700;        /* was #d29922 */
    --p2: #0969da;        /* was #6ea8fe */
    --p3: #57606a;        /* was #8b93a7 */
    /* T4 new tokens: previously hard-coded inline. */
    --live-border: #aceebb;        /* was #224a2c */
    --system-bubble-bg: #ddf4ff;   /* was #1d2638 */
    --system-bubble-border: #80ccff;
    --system-bubble-who: #0550ae;  /* was #8cb4ff */
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
  .blk { color: var(--p0); font-size: 11px; }
  .rfcs { display: flex; flex-direction: column; gap: 10px; }
  .rfc { background: var(--panel2); border: 1px solid var(--line); border-radius: 6px;
    padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
  .rfc-head { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
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
     starts on the next line so multi-line messages render legibly. */
  .feed { max-height: 540px; overflow: auto; padding: 8px 0;
    display: flex; flex-direction: column; gap: 8px; }
  .bubble-row { display: flex; gap: 8px; align-items: flex-start; }
  .bubble-row.from-system { justify-content: flex-end; }
  .bubble-row.from-member { justify-content: flex-start; }
  .bubble { max-width: 72%; background: var(--panel2);
    border: 1px solid var(--line); border-radius: 10px;
    padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }
  .bubble.from-system { background: var(--system-bubble-bg); border-color: var(--system-bubble-border); }
  .bubble-meta { display: flex; gap: 8px; font-size: 11px;
    color: var(--dim); align-items: baseline; }
  .bubble-meta .who { color: var(--fg); font-weight: 600; }
  .bubble.from-system .bubble-meta .who { color: var(--system-bubble-who); }
  .bubble-meta .ety { font-size: 10px; text-transform: uppercase;
    letter-spacing: 0.5px; padding: 1px 5px; border-radius: 999px;
    border: 1px solid var(--line); color: var(--dim); }
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
     reuses the P0 red so it reads "you must fill this" without an
     extra palette token. */
  .action label.req::before { content: "* "; color: var(--p0); font-weight: 700; }
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
  .action .feedback.err { color: var(--p0); }
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
  .init-card .feedback.err { color: var(--p0); }
  .init-card .feedback.ok { color: var(--live); }
</style>
</head>
<body>
<header>
  <h1>gojaja <span style="color:var(--dim);font-weight:400">watch</span></h1>
  <span class="root" id="root">…</span>
  <div class="chips">
    <span class="chip"><span class="dot live pulse"></span><span id="upd">connecting…</span></span>
    <span class="chip">roles live <b id="c-live">–</b></span>
    <span class="chip" id="chip-working" style="display:none">working <b id="c-working">–</b></span>
    <span class="chip">open RFCs <b id="c-rfc">–</b></span>
    <span class="chip">events <b id="c-ev">–</b></span>
  </div>
</header>
<div id="err"></div>

<!-- Init landing page — shown ONLY when /api/state reports
     !initialised. Replaces the tabbed dashboard until the user
     completes init. -->
<div class="init-screen" id="init-screen">
  <div class="init-card">
    <h2>Initialise this project</h2>
    <div class="root-line" id="init-root">…</div>
    <p style="margin:0 0 4px;color:var(--dim)">
      <code>gojaja init</code> creates a <code>.gojaja/</code> directory at the
      project root with the durable team-coordination state (events, sessions,
      tasks, RFCs). Re-running it on a project that already has the layer is a
      no-op until you <code>gojaja reset</code>.
    </p>
    <div id="init-git"></div>
    <button class="primary" id="init-go">Initialise</button>
    <div class="feedback" id="init-fb"></div>
  </div>
</div>

<!-- Tab nav (hidden until initialised). Each .tab toggles the
     matching .panel by id. -->
<nav class="tabs" id="tabs" style="display:none">
  <button class="tab active" data-tab="dashboard">Dashboard</button>
  <button class="tab" data-tab="archived">Archived <span class="tab-count" id="tab-archived-count" style="display:none">0</span></button>
  <button class="tab" data-tab="setup">Setup</button>
  <button class="tab" data-tab="actions">Actions</button>
</nav>

<main id="panels" style="display:none">
<section class="panel active" id="panel-dashboard">
  <section><h2>Roles</h2><div class="roles" id="roles"></div></section>
  <section><h2>Task board</h2><div class="board" id="board"></div></section>
  <section><h2>RFCs</h2><div class="rfcs" id="rfcs"></div></section>
  <section><h2>Activity</h2><div class="feed" id="feed"></div></section>
</section>

<section class="panel" id="panel-archived">
  <section>
    <h2>Archived tasks <span style="color:var(--dim);text-transform:none;letter-spacing:0;font-weight:400">— tasks auto-hidden from the active board after 48 h in Done. Grouped by the day they were last updated (local time).</span></h2>
    <div id="archived" class="archived-list"></div>
  </section>
</section>

<section class="panel" id="panel-setup">
  <section id="sec-setup" style="display:none">
    <h2>Setup <span style="color:var(--dim);text-transform:none;letter-spacing:0;font-weight:400">— roles, runtime files, per-window activation</span></h2>
    <div class="actions">
      <div class="action">
        <h3>Create role</h3>
        <label class="req">Id (no spaces; <code>[A-Za-z0-9_-]</code>)</label>
        <input id="role-id" placeholder="Backend" />
        <label>Title (human-readable)</label>
        <input id="role-title" placeholder="Backend Engineer" />
        <label>Description (one line, optional)</label>
        <input id="role-desc" />
        <label>Owns (comma-separated paths)</label>
        <input id="role-owns" placeholder="src/api/,src/db/" />
        <label>Reports to (comma-separated roles)</label>
        <input id="role-reports" placeholder="TL,CTO" />
        <label>Must not edit (comma-separated paths)</label>
        <input id="role-mne" />
        <button id="role-go">Create role</button>
        <div class="feedback" id="role-fb"></div>
        <div class="hint">After create, fill the TBD sections in <code>.gojaja/roles/&lt;id&gt;.md</code> before activating.</div>
      </div>

      <div class="action">
        <h3>Install runtime files</h3>
        <label class="req">Target host</label>
        <select id="prompt-target">
          <option value="agents" selected>agents (writes AGENTS.md — covers Codex / Cursor / Copilot / Windsurf / Zed)</option>
          <option value="claude">claude (writes CLAUDE.md)</option>
          <option value="cursor">cursor (writes .cursor/rules/gojaja-runtime.mdc)</option>
          <option value="generic">generic (preview only — bundled into activate snippet)</option>
        </select>
        <label style="display:flex;align-items:center;gap:6px;margin-top:10px;font-size:12px;color:var(--fg)">
          <input type="checkbox" id="prompt-force" style="width:auto;margin:0" />
          Force rewrite (overwrite even if file is byte-identical)
        </label>
        <label style="display:flex;align-items:center;gap:6px;margin-top:6px;font-size:12px;color:var(--fg)">
          <input type="checkbox" id="prompt-no-handbook" style="width:auto;margin:0" />
          Skip the cheatsheet (smaller card, less guidance)
        </label>
        <button id="prompt-go">Install</button>
        <div class="feedback" id="prompt-fb"></div>
        <div class="hint">Hosts only inject these files when an agent window first opens — restart any open window after a write.</div>
      </div>

      <div class="action">
        <h3>Activate (per-window snippet)</h3>
        <label class="req">Role</label>
        <select id="act-role"></select>
        <label class="req">Target host</label>
        <select id="act-target">
          <option value="agents" selected>agents</option>
          <option value="claude">claude</option>
          <option value="cursor">cursor</option>
          <option value="generic">generic (snippet bundles runtime body)</option>
        </select>
        <button id="act-go">Generate snippet</button>
        <div class="feedback" id="act-fb"></div>
        <textarea id="act-out" readonly placeholder="(snippet appears here after Generate)" style="margin-top:8px;min-height:120px;font-size:11px"></textarea>
        <button id="act-copy" style="background:var(--panel2);color:var(--fg);border:1px solid var(--line);margin-top:6px;display:none">Copy snippet</button>
        <div class="hint">Paste the snippet into the agent window's chat to bind that window to the role. Refuses if the role's <code>.md</code> still has TBD sections.</div>
      </div>
    </div>
    <div class="hint" style="margin-top:10px;color:var(--dim);font-size:11px">
      Setup actions require <code>.gojaja/</code> to exist (run <em>Initialise</em> first if missing) and must be on a loopback bind to be visible.
    </div>
  </section>
</section>

<section class="panel" id="panel-actions">
  <section id="sec-actions" style="display:none">
    <h2>Actions <span style="color:var(--dim);text-transform:none;letter-spacing:0;font-weight:400">— posted as <code style="background:var(--panel2);padding:1px 5px;border-radius:3px">SYSTEM</code> (project-owner)</span></h2>
    <div class="actions">
      <div class="action">
        <h3>Send report</h3>
        <label class="req">To role</label>
        <select id="rep-to"></select>
        <label class="req">Message</label>
        <textarea id="rep-msg" placeholder="What you need them to do next."></textarea>
        <label>Ref (optional)</label>
        <input id="rep-ref" placeholder="T-0001 / RFC-0007 / ..." />
        <button id="rep-go">Send report</button>
        <div class="feedback" id="rep-fb"></div>
      </div>
      <div class="action">
        <h3>Open RFC</h3>
        <label class="req">Slug</label>
        <input id="rfc-slug" placeholder="lowercase-with-dashes" />
        <label class="req">Title</label>
        <input id="rfc-title" />
        <label class="req">Deciders (comma-separated roles)</label>
        <input id="rfc-deciders" placeholder="CTO,CPO" />
        <label>Voters (comma-separated, optional)</label>
        <input id="rfc-voters" />
        <label>Options (id:summary, comma-separated, optional)</label>
        <input id="rfc-options" placeholder="A:do this,B:do that" />
        <label>Description</label>
        <textarea id="rfc-desc" placeholder="Context the voters/deciders need to weigh in."></textarea>
        <button id="rfc-go">Open RFC</button>
        <div class="feedback" id="rfc-fb"></div>
      </div>
      <div class="action">
        <h3>Create task</h3>
        <label class="req">Title</label>
        <input id="task-title" />
        <label>Owner (optional)</label>
        <select id="task-owner"><option value="">(unassigned)</option></select>
        <label>Priority</label>
        <select id="task-pri">
          <option value="P0">P0</option>
          <option value="P1">P1</option>
          <option value="P2" selected>P2</option>
          <option value="P3">P3</option>
        </select>
        <label>Acceptance criteria (optional)</label>
        <textarea id="task-acc" placeholder="What 'done' looks like."></textarea>
        <button id="task-go">Create task</button>
        <div class="feedback" id="task-fb"></div>
      </div>
    </div>
    <div class="hint" style="margin-top:10px;color:var(--dim);font-size:11px">
      All actions emit events as <code>from: SYSTEM</code> — the same as running
      the gojaja CLI in a shell with no <code>GOJAJA_SESSION</code>. Visible only when watch is bound to loopback.
    </div>
  </section>
</section>

</main>
<script>
  var STATUSES = ["Backlog","Pending","InProgress","Blocked","Review","Done"];
  function esc(s){ s = (s==null?"":String(s));
    return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
  function ago(iso){ if(!iso) return ""; var t = Date.parse(iso); if(!isFinite(t)) return "";
    var s = Math.max(0, Math.floor((Date.now()-t)/1000));
    if(s<60) return s+"s ago"; var m=Math.floor(s/60); if(m<60) return m+"m ago";
    var h=Math.floor(m/60); if(h<24) return h+"h ago"; return Math.floor(h/24)+"d ago"; }
  function until(iso){ if(!iso) return "no deadline"; var t=Date.parse(iso); if(!isFinite(t)) return "";
    var s=Math.floor((t-Date.now())/1000); if(s<=0) return "deadline passed";
    if(s<60) return "in "+s+"s"; var m=Math.floor(s/60); if(m<60) return "in "+m+"m";
    return "in "+Math.floor(m/60)+"h"; }
  function condText(c){ if(!c) return "attention"; return c.ref ? (c.kind+":"+c.ref) : c.kind; }

  function fmtAge(ms){ if(ms==null||!isFinite(ms)) return "?"; var s=Math.max(0,Math.floor(ms/1000));
    if(s<60) return s+"s"; var m=Math.floor(s/60); if(m<60) return m+"m";
    var h=Math.floor(m/60); if(h<24) return h+"h"; return Math.floor(h/24)+"d"; }

  function renderRoles(roles){
    if(!roles.length) return '<div class="empty">No roles registered.</div>';
    return roles.map(function(r){
      var st = r.session.state;
      var meta = "";
      if(st!=="none"){
        meta = "pid "+esc(r.session.pid)+" @ "+esc(r.session.host)+" · hb "+ago(r.session.heartbeatAt);
      } else { meta = "no active session"; }
      var waiting = r.wait ? '<div class="waiting">⏳ waiting for '+esc(condText(r.wait.for))+" · "+esc(until(r.wait.deadline))+"</div>" : "";
      var owns = (r.owns&&r.owns.length) ? '<div class="meta">owns: '+esc(r.owns.join(", "))+"</div>" : "";
      // v3.0.x N: the role is "working" when it holds a live session
      // but hasn't posted gojaja activity recently. Empirically this
      // is the heads-down-on-code state, not a wedge. Treat
      // informationally; the operator can still see the dwell time
      // and nudge if context warrants.
      var working = r.healthStatus === "working";
      var workingNote = working
        ? '<div class="working-note">💼 Working — heads down for '+
          esc(fmtAge(r.lastActionAgeMs))+
          '. No <code>gojaja</code> activity since; usually means writing code or running tests.</div>'
        : "";
      var badge = working
        ? '<span class="badge working">working</span>'
        : '<span class="badge '+st+'">'+st+'</span>';
      return '<div class="role'+(working?' working':'')+'"><div style="display:flex;justify-content:space-between;align-items:baseline">'+
        '<span class="name">'+esc(r.id)+'</span>'+
        badge+'</div>'+
        '<div class="title">'+esc(r.title)+'</div>'+
        '<div class="meta">'+meta+'</div>'+owns+waiting+workingNote+'</div>';
    }).join("");
  }

  function renderBoard(tasks){
    var byStatus = {}; STATUSES.forEach(function(s){ byStatus[s]=[]; });
    tasks.forEach(function(t){ (byStatus[t.status]||(byStatus[t.status]=[])).push(t); });
    return STATUSES.map(function(s){
      var list = byStatus[s]||[];
      var cards = list.map(function(t){
        var pri = (t.priority||"P2").toLowerCase();
        var blk = (t.dependsOn&&t.dependsOn.length) ? '<div class="blk">⛔ '+esc(t.dependsOn.join(", "))+"</div>" : "";
        var deliv = t.deliverables ? ' · '+t.deliverables+'📎' : "";
        return '<div class="task '+esc(pri)+'"><div class="tid">'+esc(t.id)+' · '+esc(t.priority||"")+deliv+'</div>'+
          '<div class="tt">'+esc(t.title)+'</div>'+
          '<div class="to">'+esc(t.owner||"(unassigned)")+'</div>'+blk+'</div>';
      }).join("") || '<div class="empty">—</div>';
      return '<div class="col"><h3>'+s+'<span class="count">'+list.length+'</span></h3>'+cards+'</div>';
    }).join("");
  }

  function renderRfcs(rfcs){
    if(!rfcs.length) return '<div class="empty">No RFCs.</div>';
    return rfcs.map(function(r){
      var head =
        '<div class="rfc-head">'+
          '<span class="rid">'+esc(r.id)+'</span>'+
          '<span class="st '+esc(r.status)+'">'+esc(r.status)+'</span>'+
          '<span class="rfc-title">'+esc(r.title)+'</span>'+
          '<span class="rfc-meta">deciders: '+esc((r.deciders||[]).join(", "))+
          ' · voters: '+esc((r.voters||[]).join(", "))+
          ((r.relatedTasks&&r.relatedTasks.length)
            ? ' · tasks: '+esc(r.relatedTasks.join(", ")) : "")+
          (r.deadline ? ' · deadline: '+esc(r.deadline) : "")+
          '</span>'+
        '</div>';

      var desc = "";
      if(r.description && r.description.length > 0){
        desc = '<div class="rfc-desc">'+esc(r.description)+'</div>';
      }

      var opts = "";
      if(r.options && r.options.length > 0){
        opts =
          '<div class="rfc-section-h">Options</div>'+
          '<div class="rfc-options">'+
            r.options.map(function(o){
              return '<div class="opt"><span class="oid">'+esc(o.id)+'</span>'+
                '<span>'+esc(o.summary || "(no summary)")+'</span></div>';
            }).join("")+
          '</div>';
      }

      var cmts = "";
      if(r.comments && r.comments.length > 0){
        cmts =
          '<div class="rfc-section-h">Comments ('+r.comments.length+')</div>'+
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
          ? ' · option '+esc(r.decision.chosenOption) : "";
        dec =
          '<div class="'+decCls+'">'+
            '<div class="dec-head">'+esc(r.decision.outcome)+
              ' by '+esc(r.decision.decidedBy)+
              optStr+
              ' · '+esc(ago(r.decision.ts))+
            '</div>'+
            '<div class="dec-body">'+esc(r.decision.rationale || "")+'</div>'+
          '</div>';
      }

      return '<div class="rfc">'+head+desc+opts+cmts+dec+'</div>';
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
    if(sameYMD(d, today)) return "Today";
    var yest = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    if(sameYMD(d, yest)) return "Yesterday";
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
      return '<div class="empty">No archived tasks yet. Tasks land here automatically after sitting in Done for 48 h.</div>';
    }
    var days = []; // ordered [{ key, label, items }]
    var byKey = {};
    tasks.forEach(function(t){
      var d = new Date(t.updatedAt);
      if(isNaN(d.getTime())) d = new Date(0);
      var key = d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
      var bucket = byKey[key];
      if(!bucket){
        bucket = { key: key, label: archDayLabel(d), items: [] };
        byKey[key] = bucket;
        days.push(bucket);
      }
      bucket.items.push(t);
    });
    return days.map(function(day){
      var cards = day.items.map(function(t){
        var pri = (t.priority || "P2").toLowerCase();
        return '<div class="arch-card">'+
          '<span class="aid">'+esc(t.id)+'</span>'+
          '<span class="att">'+esc(t.title)+'</span>'+
          '<span class="ato">'+esc(t.owner || "(unassigned)")+'</span>'+
          '<span class="apr '+esc(pri)+'">'+esc(t.priority || "")+'</span>'+
          '</div>';
      }).join("");
      return '<div class="archived-day">'+
        '<h3>'+esc(day.label)+'<span class="count">'+day.items.length+'</span></h3>'+
        cards+'</div>';
    }).join("");
  }

  function renderFeed(events){
    if(!events.length) return '<div class="empty">No events yet.</div>';
    return events.map(function(e){
      // v3.0.x M: chat-bubble layout. SYSTEM bubbles align right
      // (project-owner channel); member bubbles align left
      // (peers). The first line of each bubble is "@<to>" or "@All"
      // for to === "*"; the body starts on the next line so
      // multi-line content (heredoc / pipe / editor) renders
      // legibly without single-line truncation.
      var isSystem = e.from === "SYSTEM";
      var rowCls = isSystem ? "bubble-row from-system" : "bubble-row from-member";
      var bubbleCls = isSystem ? "bubble from-system" : "bubble from-member";

      // @to header. "*" → "@All" (broadcast). Otherwise "@<role>".
      // For events that are intrinsically broadcasts of a different
      // sort (WORKLOG, RFC_DECIDED, ...), to === "*" too; we render
      // them with "@All" uniformly so the reader can tell at a
      // glance that everyone receives them.
      var toLabel = e.to === "*"
        ? '<span class="at-target all">@All</span>'
        : '<span class="at-target">@'+esc(e.to)+'</span>';

      var refLine = e.ref
        ? '<span class="ref">'+esc(e.ref)+'</span>' : "";

      var bodyHtml;
      if(e.message){
        bodyHtml = '<div class="bubble-body">'+esc(e.message)+'</div>';
      } else {
        // No payload message — e.g. TASK_STATUS_CHANGED, RFC_DECIDED.
        // Render the event type alone so the bubble still carries
        // info without a body.
        bodyHtml = '<div class="bubble-body empty">('+esc(e.type)+
          ' — no message body)</div>';
      }

      return '<div class="'+rowCls+'">'+
        '<div class="'+bubbleCls+'">'+
          '<div class="bubble-meta">'+
            '<span class="who">'+esc(e.from)+'</span>'+
            '<span class="ety">'+esc(e.type)+'</span>'+
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
    document.getElementById("upd").textContent = "updated "+ago(s.project.generatedAt);
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
    document.getElementById("init-root").textContent = (s.project && s.project.root) || "(unknown root)";
    var git = (s.init && s.init.git) || { kind: "clean" };
    document.getElementById("init-git").innerHTML = renderGitState(git);
    var btn = document.getElementById("init-go");
    if(git.kind === "dirty"){
      btn.textContent = "I understand — force init anyway";
      btn.classList.add("danger");
      initButtonState = "confirm";
    } else if(git.kind === "not-a-repo"){
      btn.textContent = "Initialise without git";
      btn.classList.add("danger");
      initButtonState = "confirm";
    } else {
      btn.textContent = "Initialise";
      btn.classList.remove("danger");
      initButtonState = "ready";
    }
  }

  function renderGitState(git){
    if(git.kind === "clean"){
      return '<div class="git">git: clean working tree — gojaja\\'s changes will land in a revertable state.</div>';
    }
    if(git.kind === "dirty"){
      var sample = (git.sample || []).map(function(l){ return esc(l); }).join("\\n");
      return '<div class="git bad"><b>git: uncommitted changes detected.</b>'+
        ' Commit or stash them before init so the layer\\'s changes are easy to revert.'+
        '<pre>'+sample+'</pre></div>';
    }
    // not-a-repo
    return '<div class="git warn"><b>Not a git repository.</b>'+
      ' Without version control there is no clean way to undo gojaja\\'s changes if'+
      ' something goes wrong. Strongly recommended: run <code>git init &amp;&amp; git add -A &amp;&amp;'+
      ' git commit -m initial</code> first. Otherwise click below to proceed anyway.</div>';
  }

  function bindInitButton(){
    document.getElementById("init-go").addEventListener("click", function(){
      var btn = this;
      var fb = document.getElementById("init-fb");
      var force = (initButtonState === "confirm");
      btn.disabled = true; fb.className = "feedback"; fb.textContent = "initialising…";
      postJson("/api/init", { force: force }).then(function(r){
        btn.disabled = false;
        if(r.ok){
          fb.className = "feedback ok";
          fb.textContent = "Initialised. Loading dashboard…";
          // Force an immediate refresh so the dashboard chrome
          // takes over without the next 2 s poll lag.
          setTimeout(tick, 200);
          return;
        }
        if(r.body && r.body.errorCode === "INIT_GIT_GATE"){
          // Server's git inspection refused the first attempt.
          // Surface the detail and switch the button into
          // "confirm" mode for a second click.
          fb.className = "feedback err";
          fb.textContent = r.body.error || "Refused.";
          if(r.body.git){
            document.getElementById("init-git").innerHTML = renderGitState(r.body.git);
          }
          btn.textContent = (r.body.git && r.body.git.kind === "dirty")
            ? "I understand — force init anyway"
            : "Initialise without git";
          btn.classList.add("danger");
          initButtonState = "confirm";
          return;
        }
        if(r.body && r.body.errorCode === "ALREADY_INITIALISED"){
          // Race: another window or someone running gojaja init in
          // a terminal got there first. Refresh and the dashboard
          // chrome will load.
          fb.className = "feedback ok";
          fb.textContent = "Already initialised — refreshing.";
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
      ["rep-to", "(select role)", true],
      ["task-owner", "(unassigned)", false],
      ["act-role", "(select role)", false],
    ].forEach(function(spec){
      var sel = document.getElementById(spec[0]);
      if(!sel) return;
      var prev = sel.value;
      var emptyLabel = spec[1];
      var allowBroadcast = spec[2];
      var opts;
      if(ids.length === 0){
        opts = emptyLabel === "(unassigned)"
          ? '<option value="">(unassigned)</option>'
          : '<option value="">(no roles yet — Create role first)</option>';
      } else {
        opts = '<option value="">'+esc(emptyLabel)+'</option>';
        if(allowBroadcast){
          opts += '<option value="*">' +
                  '@All — broadcast (SYSTEM)' +
                  '</option>';
        }
        opts += ids.map(function(id){
          return '<option value="'+esc(id)+'">'+esc(id)+'</option>';
        }).join("");
      }
      if(sel.innerHTML !== opts){ sel.innerHTML = opts; }
      // Preserve a prior selection if it's still a valid pick. "*"
      // (broadcast) is valid only on rep-to.
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
      if(!to){ setFb("rep-fb", "err", "Pick a role first."); return; }
      btn.disabled = true; setFb("rep-fb", "", "sending…");
      postJson("/api/report", {
        to: to,
        message: document.getElementById("rep-msg").value,
        ref: document.getElementById("rep-ref").value,
      }).then(function(r){
        btn.disabled = false;
        if(!r.ok){ setFb("rep-fb", "err", r.body.error || ("HTTP "+r.status)); return; }
        setFb("rep-fb", "ok", "Reported "+(r.body.event && r.body.event.id || "")+".");
        document.getElementById("rep-to").value = "";
        document.getElementById("rep-msg").value = "";
        document.getElementById("rep-ref").value = "";
        tick();
      }).catch(function(e){ btn.disabled = false; setFb("rep-fb", "err", String(e)); });
    });
    document.getElementById("rfc-go").addEventListener("click", function(){
      var btn = this; btn.disabled = true; setFb("rfc-fb", "", "creating…");
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
        setFb("rfc-fb", "ok", "Created "+(r.body.proposal && r.body.proposal.id || "")+".");
        ["rfc-slug","rfc-title","rfc-deciders","rfc-voters","rfc-options","rfc-desc"].forEach(function(id){
          document.getElementById(id).value = "";
        });
        tick();
      }).catch(function(e){ btn.disabled = false; setFb("rfc-fb", "err", String(e)); });
    });

    document.getElementById("role-go").addEventListener("click", function(){
      var btn = this; btn.disabled = true; setFb("role-fb", "", "creating…");
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
        var msg = "Created role '"+(r.body.role && r.body.role.id || "")+"'.";
        if(r.body.needsFill){
          msg += " Edit "+r.body.rolePath+" to fill the TBD sections before activating.";
        }
        setFb("role-fb", "ok", msg);
        ["role-id","role-title","role-desc","role-owns","role-reports","role-mne"].forEach(function(id){
          document.getElementById(id).value = "";
        });
        tick();
      }).catch(function(e){ btn.disabled = false; setFb("role-fb", "err", String(e)); });
    });

    document.getElementById("prompt-go").addEventListener("click", function(){
      var btn = this; btn.disabled = true; setFb("prompt-fb", "", "installing…");
      postJson("/api/prompt", {
        target: document.getElementById("prompt-target").value,
        forceRewrite: document.getElementById("prompt-force").checked,
        withHandbook: !document.getElementById("prompt-no-handbook").checked,
      }).then(function(r){
        btn.disabled = false;
        if(!r.ok){ setFb("prompt-fb", "err", r.body.error || ("HTTP "+r.status)); return; }
        var wrote = r.body.wrote || [];
        if(wrote.length === 0 && r.body.status === "previewed"){
          setFb("prompt-fb", "ok", "Generic target previewed (no files written; bundled into the activate snippet).");
          return;
        }
        var lines = wrote.map(function(w){ return (w.result === "wrote" ? "WROTE " : "UNCHANGED ") + w.path; });
        var head = r.body.requiresWindowRestart
          ? "Installed. Restart any open agent window for it to pick up the new rules."
          : "Already up to date — no files changed.";
        setFb("prompt-fb", "ok", head + " (" + lines.join("; ") + ")");
      }).catch(function(e){ btn.disabled = false; setFb("prompt-fb", "err", String(e)); });
    });

    document.getElementById("act-go").addEventListener("click", function(){
      var btn = this;
      var role = document.getElementById("act-role").value;
      if(!role){ setFb("act-fb", "err", "Pick a role first."); return; }
      btn.disabled = true; setFb("act-fb", "", "generating…");
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
        setFb("act-fb", "ok", "Snippet ready — copy and paste into the agent window for '"+r.body.role+"'.");
      }).catch(function(e){ btn.disabled = false; setFb("act-fb", "err", String(e)); });
    });

    document.getElementById("act-copy").addEventListener("click", function(){
      var out = document.getElementById("act-out");
      out.select();
      // navigator.clipboard requires a secure context (loopback counts
      // as secure on modern browsers); fall back to execCommand for
      // older ones. Either way the textarea selection is the visible
      // confirmation that the right text is being copied.
      var doneOk = function(){ setFb("act-fb", "ok", "Copied to clipboard."); };
      var doneFail = function(){ setFb("act-fb", "err", "Copy failed — select the snippet manually."); };
      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(out.value).then(doneOk).catch(function(){
          try { document.execCommand("copy"); doneOk(); } catch (e) { doneFail(); }
        });
      } else {
        try { document.execCommand("copy"); doneOk(); } catch (e) { doneFail(); }
      }
    });

    document.getElementById("task-go").addEventListener("click", function(){
      var btn = this; btn.disabled = true; setFb("task-fb", "", "creating…");
      postJson("/api/task", {
        title: document.getElementById("task-title").value.trim(),
        owner: document.getElementById("task-owner").value || null,
        priority: document.getElementById("task-pri").value,
        acceptance: document.getElementById("task-acc").value,
      }).then(function(r){
        btn.disabled = false;
        if(!r.ok){ setFb("task-fb", "err", r.body.error || ("HTTP "+r.status)); return; }
        setFb("task-fb", "ok", "Created "+(r.body.task && r.body.task.id || "")+".");
        ["task-title","task-acc"].forEach(function(id){ document.getElementById(id).value = ""; });
        tick();
      }).catch(function(e){ btn.disabled = false; setFb("task-fb", "err", String(e)); });
    });
  }

  function tick(){
    fetch("/api/state", { cache: "no-store" })
      .then(function(r){ if(!r.ok) throw new Error("HTTP "+r.status); return r.json(); })
      .then(render)
      .catch(function(e){ showErr("Lost connection to gojaja watch ("+e.message+"). Is the server still running?"); });
  }
  bindActionButtons();
  bindInitButton();
  bindTabs();
  tick();
  setInterval(tick, 2000);
</script>
</body>
</html>`;
