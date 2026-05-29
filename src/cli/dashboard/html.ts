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
  .badge { font-size: 10px; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--line);
    text-transform: uppercase; letter-spacing: .04em; }
  .badge.live { color: var(--live); border-color: #224a2c; } .badge.stale { color: var(--stale); }
  .badge.none { color: var(--none); }
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
</style>
</head>
<body>
<header>
  <h1>gojaja <span style="color:var(--dim);font-weight:400">watch</span></h1>
  <span class="root" id="root">…</span>
  <div class="chips">
    <span class="chip"><span class="dot live pulse"></span><span id="upd">connecting…</span></span>
    <span class="chip">roles live <b id="c-live">–</b></span>
    <span class="chip">open RFCs <b id="c-rfc">–</b></span>
    <span class="chip">events <b id="c-ev">–</b></span>
  </div>
</header>
<div id="err"></div>
<main>
  <section><h2>Roles</h2><div class="roles" id="roles"></div></section>
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
      return '<div class="role"><div style="display:flex;justify-content:space-between;align-items:baseline">'+
        '<span class="name">'+esc(r.id)+'</span>'+
        '<span class="badge '+st+'">'+st+'</span></div>'+
        '<div class="title">'+esc(r.title)+'</div>'+
        '<div class="meta">'+meta+'</div>'+owns+waiting+'</div>';
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
    document.getElementById("c-rfc").textContent = s.counts.openRfcs;
    document.getElementById("c-ev").textContent = s.counts.totalEvents;
    document.getElementById("roles").innerHTML = renderRoles(s.roles);
    document.getElementById("board").innerHTML = renderBoard(s.tasks);
    document.getElementById("rfcs").innerHTML = renderRfcs(s.rfcs);
    document.getElementById("feed").innerHTML = renderFeed(s.events);
  }

  function tick(){
    fetch("/api/state", { cache: "no-store" })
      .then(function(r){ if(!r.ok) throw new Error("HTTP "+r.status); return r.json(); })
      .then(render)
      .catch(function(e){ showErr("Lost connection to gojaja watch ("+e.message+"). Is the server still running?"); });
  }
  tick();
  setInterval(tick, 2000);
</script>
</body>
</html>`;
