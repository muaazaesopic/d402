# d402 landing page

Landing page designs exported from Claude Design. `d402 Landing v5.dc.html` is the latest version. The earlier versions are kept for reference.

Run the page with the signup form working:

```bash
node landing/server.js   # http://localhost:8402
```

The server serves v5 at `/` and saves early-access emails to `landing/data/early-access.jsonl`, one JSON object per line. That folder is gitignored, so signups never get committed.

You can also open any `.dc.html` file straight in a browser, but the signup form needs the server. Each page loads `support.js` from this folder, so keep the files together. `styles.css` and `_ds/` hold the Modernist design system the designs were built on.
