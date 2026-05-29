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
  :root {
    --bg: #0f1115; --panel: #171a21; --panel2: #1e222b; --line: #2a2f3a;
    --fg: #e6e8ee; --dim: #8b93a7; --accent: #6ea8fe;
    --live: #3fb950; --stale: #d29922; --none: #6b7280;
    --stalled: #f85149; --stalled-bg: #3d1418; --stalled-border: #6e2128;
    --p0: #f85149; --p1: #d29922; --p2: #6ea8fe; --p3: #8b93a7;
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
  .role.stalled { background: var(--stalled-bg); border-color: var(--stalled-border); }
  .role .stalled-warn { margin-top: 6px; color: var(--stalled); font-size: 11px; font-weight: 600; }
  .badge { font-size: 10px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line);
    text-transform: uppercase; letter-spacing: .04em; }
  .badge.live { color: var(--live); border-color: #224a2c; } .badge.stale { color: var(--stale); }
  .badge.none { color: var(--none); }
  .badge.stalled { color: var(--stalled); border-color: var(--stalled-border); }
  .board { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; }
  .col h3 { font-size: 11px; color: var(--dim); margin: 0 0 8px; font-weight: 600;
    display: flex; justify-content: space-between; }
  .task { background: var(--panel2); border: 1px solid var(--line); border-left-width: 3px;
    border-radius: 6px; padding: 7px 8px; margin-bottom: 7px; }
  .task .tid { font-family: ui-monospace, monospace; color: var(--dim); font-size: 11px; }
  .task .tt { margin: 2px 0; }
  .task .to { color: var(--dim); font-size: 11px; }
  .task.p0 { border-left-color: var(--p0); } .task.p1 { border-left-color: var(--p1); }
  .task.p2 { border-left-color: var(--p2); } .task.p3 { border-left-color: var(--p3); }
  .blk { color: var(--p0); font-size: 11px; }
  .rfcs { display: flex; flex-direction: column; gap: 8px; }
  .rfc { background: var(--panel2); border: 1px solid var(--line); border-radius: 6px;
    padding: 8px 10px; display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
  .rfc .rid { font-family: ui-monospace, monospace; color: var(--dim); }
  .rfc .st { font-size: 10px; text-transform: uppercase; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line); }
  .rfc .st.open { color: var(--live); } .rfc .st.revising { color: var(--stale); }
  .rfc .st.accepted { color: var(--accent); } .rfc .st.rejected { color: var(--none); }
  .feed { max-height: 420px; overflow: auto; }
  .ev { display: grid; grid-template-columns: 70px 130px 1fr; gap: 10px; padding: 5px 0;
    border-bottom: 1px solid var(--line); align-items: baseline; }
  .ev .et { color: var(--dim); font-size: 11px; font-family: ui-monospace, monospace; }
  .ev .ety { font-size: 11px; }
  .ev .em { color: var(--dim); }
  .ev .who { color: var(--fg); }
  .empty { color: var(--dim); font-style: italic; }
  #err { display: none; background: #3d1418; border: 1px solid #f85149; color: #ffb4ae;
    padding: 8px 12px; border-radius: 8px; margin: 0 16px; }
  /* Actions panel: project-owner write surface. Hidden when the
     server reports !capabilities.writeEnabled (non-loopback bind). */
  .actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; }
  .action { background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; padding: 12px; }
  .action h3 { font-size: 12px; margin: 0 0 10px; font-weight: 600; color: var(--fg);
    text-transform: uppercase; letter-spacing: .06em; }
  .action label { display: block; font-size: 11px; color: var(--dim); margin: 8px 0 3px; }
  .action input, .action select, .action textarea {
    width: 100%; box-sizing: border-box; background: var(--bg); color: var(--fg);
    border: 1px solid var(--line); border-radius: 5px; padding: 6px 8px; font: 12px ui-monospace, monospace; }
  .action textarea { min-height: 60px; resize: vertical; }
  .action button { margin-top: 10px; background: var(--accent); color: #0b1220; border: 0;
    border-radius: 5px; padding: 6px 14px; font: 600 12px ui-sans-serif, system-ui;
    cursor: pointer; }
  .action button:disabled { opacity: .5; cursor: not-allowed; }
  .action .feedback { margin-top: 8px; font-size: 11px; min-height: 14px; }
  .action .feedback.ok { color: var(--live); }
  .action .feedback.err { color: var(--p0); }
  .action .hint { font-size: 11px; color: var(--dim); margin-top: 6px; }
</style>
</head>
<body>
<header>
  <h1>gojaja <span style="color:var(--dim);font-weight:400">watch</span></h1>
  <span class="root" id="root">…</span>
  <div class="chips">
    <span class="chip"><span class="dot live pulse"></span><span id="upd">connecting…</span></span>
    <span class="chip">roles live <b id="c-live">–</b></span>
    <span class="chip" id="chip-stalled" style="display:none">stalled <b id="c-stalled">–</b></span>
    <span class="chip">open RFCs <b id="c-rfc">–</b></span>
    <span class="chip">events <b id="c-ev">–</b></span>
  </div>
</header>
<div id="err"></div>
<main>
  <section><h2>Roles</h2><div class="roles" id="roles"></div></section>
  <section id="sec-actions" style="display:none">
    <h2>Actions <span style="color:var(--dim);text-transform:none;letter-spacing:0;font-weight:400">— posted as <code style="background:var(--panel2);padding:1px 5px;border-radius:3px">SYSTEM</code> (project-owner)</span></h2>
    <div class="actions">
      <div class="action">
        <h3>Send report</h3>
        <label>To role</label>
        <select id="rep-to"></select>
        <label>Message</label>
        <textarea id="rep-msg" placeholder="What you need them to do next."></textarea>
        <label>Ref (optional)</label>
        <input id="rep-ref" placeholder="T-0001 / RFC-0007 / ..." />
        <button id="rep-go">Send report</button>
        <div class="feedback" id="rep-fb"></div>
      </div>
      <div class="action">
        <h3>Open RFC</h3>
        <label>Slug</label>
        <input id="rfc-slug" placeholder="lowercase-with-dashes" />
        <label>Title</label>
        <input id="rfc-title" />
        <label>Deciders (comma-separated roles)</label>
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
        <label>Title</label>
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
  <section><h2>Task board</h2><div class="board" id="board"></div></section>
  <section><h2>RFCs</h2><div class="rfcs" id="rfcs"></div></section>
  <section><h2>Activity</h2><div class="feed" id="feed"></div></section>
</main>
<script>
  var STATUSES = ["Backlog","Ready","InProgress","Blocked","Review","Done"];
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
      var stalled = r.healthStatus === "stalled-no-wait";
      // The most common per-turn failure mode: agent ran ack, saw the
      // success line, then sat silent waiting for user input. Live
      // session, no wait.json, no recent action — surfaced here so
      // the operator can nudge.
      var stalledWarn = stalled
        ? '<div class="stalled-warn">⚠ stalled — last action '+
          esc(fmtAge(r.lastActionAgeMs))+
          ' ago, no <code>gojaja wait</code> since. Nudge the role to wait or end the turn.</div>'
        : "";
      var badge = stalled
        ? '<span class="badge stalled">stalled</span>'
        : '<span class="badge '+st+'">'+st+'</span>';
      return '<div class="role'+(stalled?' stalled':'')+'"><div style="display:flex;justify-content:space-between;align-items:baseline">'+
        '<span class="name">'+esc(r.id)+'</span>'+
        badge+'</div>'+
        '<div class="title">'+esc(r.title)+'</div>'+
        '<div class="meta">'+meta+'</div>'+owns+waiting+stalledWarn+'</div>';
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
      return '<div class="col"><h3>'+s+'<span>'+list.length+'</span></h3>'+cards+'</div>';
    }).join("");
  }

  function renderRfcs(rfcs){
    if(!rfcs.length) return '<div class="empty">No RFCs.</div>';
    return rfcs.map(function(r){
      return '<div class="rfc"><span class="rid">'+esc(r.id)+'</span>'+
        '<span class="st '+esc(r.status)+'">'+esc(r.status)+'</span>'+
        '<span style="flex:1">'+esc(r.title)+'</span>'+
        '<span class="role-meta" style="color:var(--dim);font-size:11px">deciders: '+esc((r.deciders||[]).join(", "))+
        ' · voters: '+esc((r.voters||[]).join(", "))+
        ((r.relatedTasks&&r.relatedTasks.length)?' · tasks: '+esc(r.relatedTasks.join(", ")):"")+'</span></div>';
    }).join("");
  }

  function renderFeed(events){
    if(!events.length) return '<div class="empty">No events yet.</div>';
    return events.map(function(e){
      var who = esc(e.from)+" → "+esc(e.to)+(e.ref?' ('+esc(e.ref)+')':"");
      var msg = e.message ? '<span class="em"> — '+esc(e.message)+'</span>' : "";
      return '<div class="ev"><span class="et">'+esc(ago(e.ts))+'</span>'+
        '<span class="ety">'+esc(e.type)+'</span>'+
        '<span><span class="who">'+who+'</span>'+msg+'</span></div>';
    }).join("");
  }

  function showErr(msg){ var el=document.getElementById("err"); el.textContent=msg; el.style.display="block"; }
  function clearErr(){ document.getElementById("err").style.display="none"; }

  function render(s){
    clearErr();
    document.getElementById("root").textContent = s.project.root+"  ·  v"+s.project.version;
    document.getElementById("upd").textContent = "updated "+ago(s.project.generatedAt);
    document.getElementById("c-live").textContent = s.counts.liveRoles;
    var stalledCount = s.counts.stalledRoles || 0;
    var stalledChip = document.getElementById("chip-stalled");
    document.getElementById("c-stalled").textContent = stalledCount;
    stalledChip.style.display = stalledCount > 0 ? "" : "none";
    stalledChip.style.color = stalledCount > 0 ? "var(--stalled)" : "";
    document.getElementById("c-rfc").textContent = s.counts.openRfcs;
    document.getElementById("c-ev").textContent = s.counts.totalEvents;
    document.getElementById("roles").innerHTML = renderRoles(s.roles);
    document.getElementById("board").innerHTML = renderBoard(s.tasks);
    document.getElementById("rfcs").innerHTML = renderRfcs(s.rfcs);
    document.getElementById("feed").innerHTML = renderFeed(s.events);
    renderActions(s);
  }

  // ---- Actions panel (loopback-only) ----------------------------

  function fillRoleSelects(roles){
    // Snapshot current selection so re-renders during typing do not
    // wipe what the user just picked.
    var ids = roles.map(function(r){ return r.id; });
    [["rep-to", false], ["task-owner", true]].forEach(function(spec){
      var sel = document.getElementById(spec[0]);
      if(!sel) return;
      var prev = sel.value;
      var allowEmpty = spec[1];
      var opts = (allowEmpty ? '<option value="">(unassigned)</option>' : "") +
        ids.map(function(id){ return '<option value="'+esc(id)+'">'+esc(id)+'</option>'; }).join("");
      if(sel.innerHTML !== opts){ sel.innerHTML = opts; }
      if(prev && ids.indexOf(prev) >= 0){ sel.value = prev; }
    });
  }

  function renderActions(s){
    var sec = document.getElementById("sec-actions");
    var enabled = s.capabilities && s.capabilities.writeEnabled;
    sec.style.display = enabled ? "" : "none";
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
    document.getElementById("rep-go").addEventListener("click", function(){
      var btn = this; btn.disabled = true; setFb("rep-fb", "", "sending…");
      postJson("/api/report", {
        to: document.getElementById("rep-to").value,
        message: document.getElementById("rep-msg").value,
        ref: document.getElementById("rep-ref").value,
      }).then(function(r){
        btn.disabled = false;
        if(!r.ok){ setFb("rep-fb", "err", r.body.error || ("HTTP "+r.status)); return; }
        setFb("rep-fb", "ok", "Reported "+(r.body.event && r.body.event.id || "")+".");
        document.getElementById("rep-msg").value = "";
        document.getElementById("rep-ref").value = "";
        tick();
      }).catch(function(e){ btn.disabled = false; setFb("rep-fb", "err", String(e)); });
    });
    document.getElementById("rfc-go").addEventListener("click", function(){
      var btn = this; btn.disabled = true; setFb("rfc-fb", "", "creating…");
      var splitCsv = function(s){ return (s||"").split(",").map(function(x){return x.trim();}).filter(Boolean); };
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
  tick();
  setInterval(tick, 2000);
</script>
</body>
</html>`;
