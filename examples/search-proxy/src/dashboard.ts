/**
 * `GET /dashboard`: a self-contained seller dashboard for demos.
 *
 * One HTML page (inline CSS + JS, no CDN, no framework) that polls the admin
 * endpoints every second:
 *   GET /.well-known/d402/admin/stats
 *   GET /.well-known/d402/admin/events
 *
 * The admin token comes from `?token=` on first load, is moved into
 * sessionStorage and scrubbed from the URL with history.replaceState, so the
 * address bar (and any screenshot of it) never shows it afterwards.
 *
 * The page itself is open; without a valid token it just shows "unauthorized".
 */

export const DASHBOARD_TOKEN_KEY = "d402.adminToken";

export function dashboardHtml(sellerId: string): string {
  const seller = escapeHtml(sellerId);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>d402 seller dashboard</title>
<style>
  :root {
    --bg: #0b0f14;
    --panel: #121820;
    --line: #243040;
    --ink: #e6edf3;
    --ink-2: #9fb0c3;
    --ink-3: #6b7a8c;
    --accent: #7dd3fc;
    --warn: #fbbf24;
    --bad: #f87171;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--ink); }
  body {
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
    font-size: 16px;
    line-height: 1.4;
    padding: 24px 32px 40px;
    min-height: 100vh;
  }
  header { display: flex; align-items: baseline; gap: 24px; flex-wrap: wrap; margin-bottom: 24px; }
  header h1 { font-size: 28px; font-weight: 600; margin: 0; letter-spacing: 0.02em; }
  header .seller { color: var(--ink-2); font-size: 18px; }
  header .state { margin-left: auto; color: var(--ink-3); font-size: 14px; }
  header .state.err { color: var(--bad); }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--ink-2); font-weight: 500; font-size: 14px; text-transform: uppercase; letter-spacing: 0.08em; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }

  table.cells { table-layout: fixed; margin-bottom: 32px; background: var(--panel); }
  table.cells td { border: 1px solid var(--line); text-align: center; padding: 20px 8px 16px; }
  table.cells .label { display: block; color: var(--ink-2); font-size: 15px; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 10px; }
  table.cells .value { display: block; font-size: 48px; font-weight: 700; line-height: 1; }
  table.cells td.hero .value { font-size: 72px; color: var(--accent); }
  table.cells td.blocked .value.nonzero { color: var(--bad); }

  section { margin-bottom: 32px; }
  section h2 { font-size: 16px; font-weight: 500; color: var(--ink-2); text-transform: uppercase; letter-spacing: 0.1em; margin: 0 0 8px; }
  table.agents td { font-size: 18px; }
  table.agents td.key { font-family: inherit; }
  table.agents tr.blocked td { color: var(--bad); }
  table.agents .tag { font-size: 13px; padding: 1px 6px; border: 1px solid currentColor; border-radius: 3px; }

  ol.events { list-style: none; margin: 0; padding: 0; background: var(--panel); border: 1px solid var(--line); max-height: 60vh; overflow-y: auto; }
  ol.events li { padding: 6px 12px; border-bottom: 1px solid var(--line); font-size: 17px; white-space: pre; overflow: hidden; text-overflow: ellipsis; }
  ol.events li .t { color: var(--ink-3); margin-right: 12px; }
  ol.events li.bundle_passed .type, ol.events li.item_resolved .type { color: var(--accent); }
  ol.events li.bundle_failed .type, ol.events li.agent_blocked .type { color: var(--bad); }
  ol.events li.voucher_issued .type { color: var(--warn); }
  .empty { color: var(--ink-3); padding: 12px; }
  .hint { color: var(--ink-3); font-size: 14px; }
  .hint code { color: var(--ink-2); }
</style>
</head>
<body>
<header>
  <h1>d402 seller dashboard</h1>
  <span class="seller" id="seller">${seller}</span>
  <span class="state" id="state">connecting</span>
</header>

<table class="cells" aria-label="pool counters">
  <tr>
    <td><span class="label">items total</span><span class="value" id="c-total">-</span></td>
    <td><span class="label">golden</span><span class="value" id="c-golden">-</span></td>
    <td><span class="label">unknown open</span><span class="value" id="c-open">-</span></td>
    <td class="hero"><span class="label">resolved</span><span class="value" id="c-resolved">-</span></td>
    <td><span class="label">agents</span><span class="value" id="c-agents">-</span></td>
    <td class="blocked"><span class="label">blocked agents</span><span class="value" id="c-blocked">-</span></td>
  </tr>
</table>

<section>
  <h2>agents</h2>
  <table class="agents">
    <thead><tr><th>key</th><th>model</th><th class="num">bundles</th><th class="num">accuracy</th><th>blocked</th></tr></thead>
    <tbody id="agents"><tr><td colspan="5" class="empty">no agents yet</td></tr></tbody>
  </table>
</section>

<section>
  <h2>events (last 30)</h2>
  <ol class="events" id="events"><li class="empty">no events yet</li></ol>
</section>

<p class="hint" id="hint" hidden>No admin token. Open this page as <code>/dashboard?token=&lt;adminToken&gt;</code> (the token is kept in sessionStorage, not in the URL).</p>

<script>
(function () {
  "use strict";
  var TOKEN_KEY = ${JSON.stringify(DASHBOARD_TOKEN_KEY)};
  var STATS_URL = "/.well-known/d402/admin/stats";
  var EVENTS_URL = "/.well-known/d402/admin/events";
  var MAX_EVENTS = 30;

  // --- token: ?token= -> sessionStorage, then scrub the URL -----------------
  var token = null;
  try {
    var params = new URLSearchParams(location.search);
    var fromUrl = params.get("token");
    if (fromUrl) {
      sessionStorage.setItem(TOKEN_KEY, fromUrl);
      params.delete("token");
      var rest = params.toString();
      history.replaceState(null, "", location.pathname + (rest ? "?" + rest : "") + location.hash);
    }
    token = sessionStorage.getItem(TOKEN_KEY);
  } catch (e) {
    token = fromUrl || null;
  }

  var $ = function (id) { return document.getElementById(id); };
  var state = $("state");
  if (!token) {
    state.textContent = "no token";
    state.className = "state err";
    $("hint").hidden = false;
    return;
  }

  function fmtTime(t) {
    var d = new Date(t * 1000);
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }
  function short(key) { return key ? key.slice(0, 12) : ""; }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function get(url) {
    return fetch(url, { headers: { Authorization: "Bearer " + token }, cache: "no-store" }).then(function (res) {
      if (res.status === 401) throw new Error("unauthorized (bad token)");
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  function setNum(id, n) {
    var el = $(id);
    el.textContent = String(n);
    el.className = "value" + (n > 0 ? " nonzero" : "");
  }

  function renderStats(body) {
    var s = body.stats;
    setNum("c-total", s.total);
    setNum("c-golden", s.golden);
    setNum("c-open", s.unknownOpen);
    setNum("c-resolved", s.resolved);
    setNum("c-agents", s.agents);
    setNum("c-blocked", s.blockedAgents);

    var rows = body.agents.slice().sort(function (a, b) { return b.bundles - a.bundles; });
    var html = "";
    for (var i = 0; i < rows.length; i++) {
      var a = rows[i];
      html += '<tr class="' + (a.blocked ? "blocked" : "") + '">' +
        '<td class="key" title="' + esc(a.publicKey) + '">' + esc(short(a.publicKey)) + "</td>" +
        "<td>" + esc(a.model || "-") + "</td>" +
        '<td class="num">' + a.bundles + "</td>" +
        '<td class="num">' + Math.round(a.accuracy * 100) + "%</td>" +
        "<td>" + (a.blocked ? '<span class="tag">BLOCKED</span>' : "no") + "</td></tr>";
    }
    $("agents").innerHTML = html || '<tr><td colspan="5" class="empty">no agents yet</td></tr>';
  }

  function describe(e) {
    switch (e.type) {
      case "bundle_issued": return "bundle issued   " + short(e.key) + " tier=" + e.tier + " " + e.bundleId;
      case "bundle_passed": return "bundle passed   " + short(e.key) + " tier=" + e.tier + " " + e.bundleId;
      case "bundle_failed": return "bundle failed   " + short(e.key) + " tier=" + e.tier + " " + e.bundleId;
      case "voucher_issued": return "voucher issued  " + short(e.key) + " calls=" + e.calls + " " + e.jti;
      case "item_resolved": return "item resolved   " + e.itemId + " -> " + e.answer + " (" + e.voters + " voters)";
      case "agent_blocked": return "agent blocked   " + short(e.key);
      default: return e.type;
    }
  }

  function renderEvents(body) {
    var list = body.events.slice(-MAX_EVENTS).reverse();
    var html = "";
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var text = describe(e);
      var typeLen = text.indexOf("  ") > 0 ? text.indexOf("  ") : text.length;
      html += '<li class="' + esc(e.type) + '"><span class="t">' + fmtTime(e.t) + "</span>" +
        '<span class="type">' + esc(text.slice(0, typeLen)) + "</span>" + esc(text.slice(typeLen)) + "</li>";
    }
    $("events").innerHTML = html || '<li class="empty">no events yet</li>';
  }

  var inFlight = false;
  function tick() {
    if (inFlight) return;
    inFlight = true;
    Promise.all([get(STATS_URL), get(EVENTS_URL)]).then(function (r) {
      renderStats(r[0]);
      renderEvents(r[1]);
      state.textContent = "live " + fmtTime(r[0].now);
      state.className = "state";
    }).catch(function (err) {
      state.textContent = String(err.message || err);
      state.className = "state err";
    }).then(function () { inFlight = false; });
  }
  tick();
  setInterval(tick, 1000);
})();
</script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
