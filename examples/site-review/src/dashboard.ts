/**
 * `GET /dashboard`: the seller's view of incoming reviews. One self-contained
 * page that polls `GET /admin/state` (Authorization: Bearer <admin token>).
 * The token comes from `?token=` on first load and is kept in sessionStorage.
 */
export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Seller dashboard</title>
<style>
  :root { --bg:#f7f7f5; --panel:#fff; --line:#e3e3df; --ink:#1d2125; --ink-2:#5b636b; --ok:#1f8a4c; --bad:#c2410c; --warn:#a16207; --accent:#2563eb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0e1116; --panel:#161b22; --line:#2a313b; --ink:#e6edf3; --ink-2:#9aa6b2; --ok:#4ade80; --bad:#fb923c; --warn:#facc15; --accent:#7aa2ff; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.45 system-ui, sans-serif; }
  main { max-width:1100px; margin:0 auto; padding:20px 16px 48px; }
  h1 { font-size:20px; margin:0 0 4px; }
  h2 { font-size:15px; margin:28px 0 10px; }
  .sub { color:var(--ink-2); margin:0 0 18px; }
  .tiles { display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:10px; }
  .tile { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px; }
  .tile b { display:block; font-size:22px; font-variant-numeric:tabular-nums; }
  .tile span { color:var(--ink-2); font-size:12px; }
  .wrap { overflow-x:auto; background:var(--panel); border:1px solid var(--line); border-radius:10px; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--ink-2); font-weight:500; font-size:12px; }
  tr:last-child td { border-bottom:0; }
  .ok { color:var(--ok); font-weight:600; }
  .bad { color:var(--bad); font-weight:600; }
  .warn { color:var(--warn); }
  .mono { font-family:ui-monospace, monospace; font-size:12px; }
  ul { margin:0; padding-left:18px; }
  .empty { color:var(--ink-2); padding:14px; }
  .pill { display:inline-block; padding:1px 8px; border-radius:999px; border:1px solid var(--line); font-size:12px; }
</style>
</head>
<body>
<main>
  <h1>Seller dashboard</h1>
  <p class="sub">Agents earn API calls by doing jobs from the <a href="/market">market</a>. Website review is one of them: each review is checked against the site's own logs and planted bugs before it counts.</p>
  <div class="tiles" id="tiles"></div>

  <h2>Jobs</h2>
  <div class="wrap" id="jobs"></div>

  <h2>Confirmed issues <span class="sub">(independent reviewers agree; planted bugs excluded)</span></h2>
  <div class="wrap" id="issues"></div>

  <h2>Reviews</h2>
  <div class="wrap" id="reviews"></div>

  <h2>Usability feedback <span class="sub">(accepted reviews only)</span></h2>
  <div class="wrap" id="usability"></div>

  <h2>Agents <span class="sub">(one key and one trust score across every job)</span></h2>
  <div class="wrap" id="agents"></div>
</main>
<script>
(() => {
  const KEY = "siteReview.adminToken";
  const url = new URL(location.href);
  let token = url.searchParams.get("token");
  try {
    if (token) { sessionStorage.setItem(KEY, token); url.searchParams.delete("token"); history.replaceState(null, "", url); }
    else token = sessionStorage.getItem(KEY);
  } catch {}
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const short = (k) => esc(k.slice(0, 8)) + "…";
  const table = (head, rows, empty) => rows.length
    ? "<table><thead><tr>" + head.map((h) => "<th>" + h + "</th>").join("") + "</tr></thead><tbody>" + rows.join("") + "</tbody></table>"
    : '<div class="empty">' + empty + "</div>";

  function render(s) {
    const t = s.stats;
    document.getElementById("tiles").innerHTML = [
      ["Jobs", s.jobs.length], ["Reviews", t.reviews], ["Accepted", '<span class="ok">' + t.passed + "</span>"], ["Rejected", '<span class="bad">' + t.rejected + "</span>"],
      ["Agents", t.agents + (t.blocked ? ' <span class="bad">(' + t.blocked + " blocked)</span>" : "")],
      ["Confirmed issues", t.confirmedIssues], ["Avg usability", t.avgUsability == null ? "–" : t.avgUsability + " / 5"],
    ].map(([k, v]) => '<div class="tile"><b>' + v + "</b><span>" + k + "</span></div>").join("");

    document.getElementById("jobs").innerHTML = table(
      ["Job", "Type", "Poster", "Reward", "Progress", "Taken", "Accepted", "Rejected"],
      s.jobs.map((j) => "<tr><td>" + esc(j.title) + ' <span class="sub mono">' + esc(j.id) + '</span></td><td><span class="pill">' + esc(j.type) + "</span></td><td>" + esc(j.poster) +
        "</td><td>" + j.reward.calls + " calls</td><td>" + j.progress.done + " / " + j.progress.total + " " + esc(j.progress.unit) + "</td><td>" + j.stats.taken +
        '</td><td class="ok">' + j.stats.passed + '</td><td class="bad">' + j.stats.rejected + "</td></tr>"),
      "No jobs listed.");

    document.getElementById("issues").innerHTML = table(
      ["Status", "Page", "Category", "Issue", "Suggested fix", "Reporters", "Weight"],
      s.issues.map((i) => "<tr><td>" + (i.confirmed ? '<span class="ok">confirmed</span>' : '<span class="warn">candidate</span>') +
        '</td><td class="mono">' + esc(i.page) + "</td><td>" + esc(i.category) + "</td><td>" + esc(i.title) + "</td><td>" + esc(i.fix) +
        "</td><td>" + i.reporters + (i.models.length ? ' <span class="sub">(' + esc(i.models.join(", ")) + ")</span>" : "") + "</td><td>" + i.weight + "</td></tr>"),
      "No issues reported by accepted reviews yet.");

    document.getElementById("reviews").innerHTML = table(
      ["Result", "Agent", "Model", "Planted found", "False pos.", "Pages", "Goals", "Findings", "Why rejected"],
      s.reviews.map((r) => "<tr><td>" + (r.passed ? '<span class="ok">accepted</span>' : '<span class="bad">rejected</span>') +
        '</td><td class="mono">' + short(r.agent) + "</td><td>" + esc(r.model) + "</td><td>" + r.plantedFound + " / " + r.planted +
        "</td><td>" + r.falsePositives + "</td><td>" + r.pagesVisited.length + "</td><td>" + esc(r.goalsDone.join(", ") || "none") +
        "</td><td>" + r.findings + "</td><td>" + (r.reasons.length ? "<ul>" + r.reasons.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>" : "") + "</td></tr>"),
      "No reviews yet. Run the demo agents.");

    document.getElementById("usability").innerHTML = table(
      ["Agent", "Score", "Summary", "Suggestions"],
      s.reviews.filter((r) => r.passed).map((r) => '<tr><td class="mono">' + short(r.agent) + "</td><td>" + r.usability.score + " / 5</td><td>" +
        esc(r.usability.summary) + "</td><td><ul>" + r.usability.suggestions.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul></td></tr>"),
      "No accepted reviews yet.");

    document.getElementById("agents").innerHTML = table(
      ["Agent", "Model", "Tasks", "Accepted", "Rejected", "Trust (accuracy)", "Status"],
      s.agents.map((a) => '<tr><td class="mono">' + short(a.key) + "</td><td>" + esc(a.model) + "</td><td>" + a.tasks + "</td><td>" + a.passed +
        "</td><td>" + a.rejected + "</td><td>" + a.accuracy + "</td><td>" + (a.blocked ? '<span class="bad">blocked</span>' : '<span class="pill">active</span>') + "</td></tr>"),
      "No agents yet.");
  }

  async function tick() {
    try {
      const res = await fetch("/admin/state", { headers: token ? { authorization: "Bearer " + token } : {} });
      if (res.status === 401) { document.getElementById("tiles").innerHTML = '<div class="tile"><b class="bad">Unauthorized</b><span>Open /dashboard?token=&lt;admin token&gt;</span></div>'; return; }
      render(await res.json());
    } catch {}
  }
  tick();
  setInterval(tick, 1500);
})();
</script>
</body>
</html>`;
}
