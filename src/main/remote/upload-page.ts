// The page a phone sees after scanning the TV's "Add a VPN location" QR code. Written by the lead; the server only
// fills in a per-response CSP nonce and whether the code was still live when the page was asked for.
// The page sends the file as the raw request body: POST /vpn-upload?code=<code>&name=<file name>, with the header
// X-MediaOS-Upload: 1 (forces a CORS preflight for any cross-origin caller, which the server refuses) and
// Content-Type application/octet-stream (a chosen file) or text/plain;charset=utf-8 (pasted text, no name).
// The server answers JSON: { ok: true } or { error: 'expired' | 'too-large' | 'rate' | 'empty' | 'bad-request' }.

export const UPLOAD_LIMIT_BYTES = 65536

export type UploadPageState = 'ready' | 'expired'

const NONCE = /^[A-Za-z0-9+/=_-]{16,64}$/

export function uploadPage(opts: { nonce: string; state: UploadPageState }): string {
  if (!NONCE.test(opts.nonce)) throw new Error('Bad nonce')
  const n = opts.nonce
  const ready = opts.state === 'ready'
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Send a VPN file to your TV</title>
<style nonce="${n}">
:root { color-scheme: light dark; --bg: #f4f5f7; --card: #fff; --text: #16181d; --muted: #5b6270; --line: #d5d9e0;
  --accent: #2f6fde; --accent-text: #fff; --good: #1d7a3e; --bad: #b3261e; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #111318; --card: #1b1e25; --text: #eceef2; --muted: #a3a9b6; --line: #343944;
    --accent: #6d9cf0; --accent-text: #0b1020; --good: #6fd08f; --bad: #ff8a80; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 17px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 32rem; margin: 0 auto; padding: 24px 16px 40px; }
h1 { font-size: 1.45rem; line-height: 1.25; margin: 0 0 8px; }
p { margin: 0 0 16px; color: var(--muted); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 16px; }
.btn { display: flex; align-items: center; justify-content: center; width: 100%; min-height: 52px; padding: 12px 16px;
  border-radius: 10px; border: 1px solid var(--line); background: var(--card); color: var(--text); font: inherit;
  font-weight: 600; cursor: pointer; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); margin-top: 16px; }
.btn:disabled { opacity: 0.55; cursor: default; }
input[type=file] { position: absolute; width: 1px; height: 1px; opacity: 0; overflow: hidden; }
input[type=file]:focus-visible + .btn { outline: 3px solid var(--accent); outline-offset: 2px; }
.chosen { margin: 8px 0 0; font-size: 0.95rem; color: var(--muted); overflow-wrap: anywhere; }
.or { display: flex; align-items: center; gap: 12px; margin: 18px 0 10px; color: var(--muted); font-size: 0.9rem; }
.or::before, .or::after { content: ""; flex: 1; border-top: 1px solid var(--line); }
label.paste { display: block; font-weight: 600; margin-bottom: 6px; }
textarea { width: 100%; min-height: 9rem; padding: 10px; border-radius: 10px; border: 1px solid var(--line);
  background: var(--bg); color: var(--text); font: 14px/1.4 ui-monospace, Menlo, Consolas, monospace; resize: vertical; }
.status { margin: 16px 0 0; font-weight: 600; min-height: 1.45em; }
.status.good { color: var(--good); }
.status.bad { color: var(--bad); }
.done { font-size: 1.15rem; font-weight: 600; color: var(--good); margin: 8px 0 0; }
.gone { font-size: 1.05rem; color: var(--text); }
</style>
</head>
<body>
<main>
<h1>Send a VPN file to your TV</h1>
${ready ? `<div id="form">
<p>Choose the WireGuard file from your VPN provider, then press Send.</p>
<div class="card">
<input type="file" id="file">
<label for="file" class="btn" id="choose">Choose file</label>
<p class="chosen" id="chosen">No file chosen</p>
<div class="or">or</div>
<label class="paste" for="text">Or paste the file's text here</label>
<textarea id="text" spellcheck="false" autocapitalize="off" autocomplete="off" autocorrect="off"></textarea>
<button type="button" class="btn primary" id="send">Send</button>
<p class="status" id="status" role="status" aria-live="polite"></p>
</div>
</div>
<p class="done" id="done" role="status" hidden>Sent. Carry on using your TV.</p>
<script nonce="${n}">
(function () {
  var LIMIT = ${UPLOAD_LIMIT_BYTES};
  var MESSAGES = {
    expired: 'This code has expired. Get a new one on the TV.',
    'too-large': 'This file is too large. WireGuard files are small, so check you chose the right one.',
    rate: 'Too many tries. Wait a minute, then try again.',
    empty: "Choose a file or paste the file's text first.",
    offline: "Couldn't reach the TV. Check your phone is on the same Wi-Fi as the TV, then try again.",
    other: "That didn't work. Try again."
  };
  var code = new URLSearchParams(location.search).get('code') || '';
  var file = document.getElementById('file');
  var chosen = document.getElementById('chosen');
  var text = document.getElementById('text');
  var send = document.getElementById('send');
  var status = document.getElementById('status');
  function show(message, tone) {
    status.textContent = message;
    status.className = 'status' + (tone ? ' ' + tone : '');
  }
  function picked() { return file.files && file.files.length ? file.files[0] : null; }
  file.addEventListener('change', function () {
    var f = picked();
    chosen.textContent = f ? f.name : 'No file chosen';
    if (f) text.value = '';
    show('');
  });
  text.addEventListener('input', function () {
    if (text.value && picked()) { file.value = ''; chosen.textContent = 'No file chosen'; }
    show('');
  });
  function finish(error) {
    if (!error) {
      document.getElementById('form').hidden = true;
      document.getElementById('done').hidden = false;
      return;
    }
    show(MESSAGES[error] || MESSAGES.other, 'bad');
    if (error === 'expired') { send.disabled = true; return; }
    send.disabled = false;
  }
  send.addEventListener('click', function () {
    var f = picked();
    var pasted = text.value.trim();
    if (!f && !pasted) { show(MESSAGES.empty, 'bad'); return; }
    if (f && f.size > LIMIT) { show(MESSAGES['too-large'], 'bad'); return; }
    var body = f ? f : pasted + '\\n';
    if (!f && new Blob([body]).size > LIMIT) { show(MESSAGES['too-large'], 'bad'); return; }
    var query = '?code=' + encodeURIComponent(code) + (f ? '&name=' + encodeURIComponent(f.name.slice(0, 200)) : '');
    send.disabled = true;
    show('Sending…');
    fetch('/vpn-upload' + query, {
      method: 'POST',
      headers: {
        'Content-Type': f ? 'application/octet-stream' : 'text/plain;charset=utf-8',
        'X-MediaOS-Upload': '1'
      },
      body: body,
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer'
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (reply) {
        if (response.ok && reply && reply.ok === true) finish(null);
        else finish(reply && typeof reply.error === 'string' ? reply.error : 'other');
      });
    }, function () { finish('offline'); });
  });
})();
</script>` : `<p class="gone">This code has expired. Get a new one on the TV.</p>`}
</main>
</body>
</html>
`
}
