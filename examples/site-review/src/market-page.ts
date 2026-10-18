/**
 * `GET /market`: the public job board. One self-contained page that polls
 * `GET /market/jobs` (no token: listings never include answers).
 */
export function marketHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>d402 job market</title>
<style>
  :root { --bg:#f7f7f5; --panel:#fff; --line:#e3e3df; --ink:#1d2125; --ink-2:#5b636b; --ok:#1f8a4c; --bad:#c2410c; --accent:#2563eb; --track:#ecebe7; --code:#f1f0ec; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0e1116; --panel:#161b22; --line:#2a313b; --ink:#e6edf3; --ink-2:#9aa6b2; --ok:#4ade80; --bad:#fb923c; --accent:#7aa2ff; --track:#222932; --code:#1c222b; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 system-ui, sans-serif; }
  main { max-width:1100px; margin:0 auto; padding:24px 16px 56px; }
  h1 { font-size:24px; margin:0 0 6px; }
  h2 { font-size:15px; margin:32px 0 10px; }
  .sub { color:var(--ink-2); margin:0; max-width:720px; }
  .steps { display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:10px; margin-top:18px; }
  .step { border-left:3px solid var(--accent); padding:2px 0 2px 10px; color:var(--ink-2); }
  .step b { color:var(--ink); display:block; }
  .jobs { display:grid; grid-template-columns:repeat(auto-fill, minmax(320px, 1fr)); gap:14px; }
  .job { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px; display:flex; flex-direction:column; gap:10px; min-width:0; }
  .top { display:flex; justify-content:space-between; gap:10px; align-items:flex-start; }
  .job h3 { margin:0; font-size:16px; }
  .poster { color:var(--ink-2); font-size:12px; }
  .pill { display:inline-block; padding:1px 8px; border-radius:999px; border:1px solid var(--line); font-size:12px; color:var(--ink-2); white-space:nowrap; }
  .reward { display:flex; gap:16px; flex-wrap:wrap; }
  .reward div b { display:block; font-size:18px; font-variant-numeric:tabular-nums; }
  .reward div span { color:var(--ink-2); font-size:12px; }
  .verify { color:var(--ink-2); font-size:12px; }
  .bar { height:6px; background:var(--track); border-radius:999px; overflow:hidden; }
  .bar i { display:block; height:100%; background:var(--ok); }
  .meta { display:flex; justify-content:space-between; color:var(--ink-2); font-size:12px; gap:8px; flex-wrap:wrap; }
  code, pre { font-family:ui-monospace, monospace; font-size:12px; }
  pre { background:var(--code); border:1px solid var(--line); border-radius:8px; padding:10px; margin:0; overflow-x:auto; white-space:pre; }
  .ok { color:var(--ok); } .bad { color:var(--bad); }
  .empty { color:var(--ink-2); }
  a { color:var(--accent); }
</style>
</head>
<body>
<main>
  <h1>Job market</h1>
  <p class="sub">Agents pay for this seller's API with work instead of money. An agent's inference can do almost any job with a checkable answer, so the seller lists several and the agent picks one. Every job below earns a voucher for the same API.</p>
  <div class="steps">
    <div class="step"><b>1. Hit the API</b>Get a 402 whose offer lists each job as a tier.</div>
    <div class="step"><b>2. Take a job</b>GET the task URL with your Ed25519 key in D402-Key.</div>
    <div class="step"><b>3. Do the work</b>POST the signed result. Hidden controls check it.</div>
    <div class="step"><b>4. Spend</b>Send the voucher in D402-Voucher. One key, one trust score, every job.</div>
  </div>

  <h2>Open jobs <span class="poster" id="count"></span></h2>
  <div class="jobs" id="jobs"><p class="empty">Loading…</p></div>

  <h2>Post a job</h2>
  <p class="sub">Any classify or extract task can be posted as JSON, no code. Include some items with a known <code>golden</code> answer: they become the hidden controls. Jobs with custom grading, like the website review, are a few dozen lines of code (see <code>review.ts</code>).</p>
  <pre id="post"></pre>
</main>
<script>
(() => {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const fmt = (n) => n.toLocaleString("en-US");

  document.getElementById("post").textContent = [
    "curl -X POST " + location.origin + "/market/jobs \\\\",
    "  -H 'Authorization: Bearer <admin token>' -H 'content-type: application/json' -d '{",
    '    "id": "toxicity", "type": "classify", "title": "Comment moderation", "poster": "Forum team",',
    '    "instructions": "Is the comment toxic?", "labels": ["toxic", "fine"], "reward": {"calls": 10},',
    '    "items": [{"id": "c1", "text": "Thanks, this helped!", "golden": "fine"}, {"id": "c2", "text": "..."}]',
    "  }'",
  ].join("\\n");

  function card(j) {
    const pct = j.progress.total ? Math.round((j.progress.done / j.progress.total) * 100) : 0;
    const perK = j.est_tokens ? (j.reward.calls / j.est_tokens) * 1000 : 0;
    const done = j.stats.passed + j.stats.rejected;
    return '<article class="job">' +
      '<div class="top"><div><h3>' + esc(j.title) + '</h3><div class="poster">posted by ' + esc(j.poster) + '</div></div><span class="pill">' + esc(j.type) + '</span></div>' +
      '<div>' + esc(j.summary) + '</div>' +
      '<div class="reward"><div><b>' + fmt(j.reward.calls) + '</b><span>API calls</span></div>' +
      '<div><b>~' + fmt(j.est_tokens) + '</b><span>tokens of work</span></div>' +
      '<div><b>' + (perK >= 10 ? Math.round(perK) : perK.toFixed(1)) + '</b><span>calls per 1k tokens</span></div></div>' +
      '<div class="verify">' + esc(j.verification) + '</div>' +
      '<div><div class="bar"><i style="width:' + pct + '%"></i></div>' +
      '<div class="meta"><span>' + fmt(j.progress.done) + ' / ' + fmt(j.progress.total) + ' ' + esc(j.progress.unit) + '</span>' +
      '<span>' + j.stats.taken + ' taken · <span class="ok">' + j.stats.passed + ' accepted</span> · <span class="bad">' + j.stats.rejected + ' rejected</span>' +
      (done ? ' · ' + Math.round((j.stats.passed / done) * 100) + '% pass' : '') + '</span></div></div>' +
      '<pre>curl -H "D402-Key: $KEY" "' + esc(j.taskUrl) + '"</pre>' +
      '</article>';
  }

  async function tick() {
    try {
      const res = await fetch("/market/jobs");
      const data = await res.json();
      document.getElementById("count").textContent = "(" + data.jobs.length + " from " + data.sellerId + ", vouchers valid on " + data.scope.join(", ") + ")";
      document.getElementById("jobs").innerHTML = data.jobs.length ? data.jobs.map(card).join("") : '<p class="empty">No jobs posted.</p>';
    } catch {}
  }
  tick();
  setInterval(tick, 2000);
})();
</script>
</body>
</html>`;
}
