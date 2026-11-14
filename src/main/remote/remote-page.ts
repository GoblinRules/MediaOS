// The phone remote page: what a phone sees at http://<box>:<port>/remote. Written by the lead; the server only fills
// in a per-response CSP nonce. Nothing about the phone or the box is baked into the page.
//
// Request contract (every call is a POST with Content-Type application/json, the header X-MediaOS-Remote: 1, which
// forces a CORS preflight for any cross-origin caller (the server refuses those), and a JSON body of at most 1 KB):
//   POST /remote/pair    { code: '12345678', previous?: token } -> { ok: true, token } | { error }
//       previous is the token this phone already held, if any; the server drops that phone entry so a re-pair
//       doesn't list the same phone twice. An unknown previous token is ignored.
//   POST /remote/key     { action }  + Authorization: Bearer   -> { ok: true, volume?: 0-100 } | { error }
//       action is one of PHONE_ACTIONS. The page does its own hold timing: holding Home sends 'recovery' instead of
//       'home', and held arrows repeat. volume comes back for volumeUp/volumeDown when the box knows the level.
//   POST /remote/text    { text: '...' } or { backspace: true } + Authorization: Bearer -> { ok: true } | { error }
//   POST /remote/forget  {}  + Authorization: Bearer           -> { ok: true } | { error }  (removes this phone)
// Errors: 'expired' (pairing code used or timed out), 'wrong-code', 'unpaired' (token unknown or removed; HTTP 401),
// 'rate', 'off' (Phone remote is switched off in Settings), 'bad-request'. Any other failure is shown as a general one.
// The token lives in localStorage under TOKEN_KEY. A code in the address (?code=, from the TV's QR code) is swapped
// for a token straight away and then removed from the address bar and history entry.

export const PHONE_ACTIONS = [
  'up', 'down', 'left', 'right', 'select', 'back', 'home', 'recovery', 'menu',
  'playPause', 'rewind', 'fastForward', 'volumeUp', 'volumeDown',
] as const
export type PhoneAction = (typeof PHONE_ACTIONS)[number]

/** Longest text one /remote/text call may carry, in characters. */
export const PHONE_TEXT_LIMIT = 200
export const TOKEN_KEY = 'mediaos-remote-token'

const NONCE = /^[A-Za-z0-9+/=_-]{16,64}$/

export function remotePage(opts: { nonce: string }): string {
  if (!NONCE.test(opts.nonce)) throw new Error('Bad nonce')
  const n = opts.nonce
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#111318">
<title>TV remote</title>
<style nonce="${n}">
:root { color-scheme: light dark; --bg: #f4f5f7; --card: #fff; --text: #16181d; --muted: #5b6270; --line: #d5d9e0;
  --key: #e7eaf0; --key-down: #cfd5df; --accent: #2f6fde; --accent-text: #fff; --good: #1d7a3e; --bad: #b3261e; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #111318; --card: #1b1e25; --text: #eceef2; --muted: #a3a9b6; --line: #343944;
    --key: #262a33; --key-down: #3a404c; --accent: #6d9cf0; --accent-text: #0b1020; --good: #6fd08f; --bad: #ff8a80; }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 17px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 26rem; margin: 0 auto; padding: 20px 16px calc(32px + env(safe-area-inset-bottom)); }
h1 { font-size: 1.45rem; line-height: 1.25; margin: 0 0 8px; }
p { margin: 0 0 16px; color: var(--muted); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 16px; }
.btn { display: flex; align-items: center; justify-content: center; width: 100%; min-height: 52px; padding: 12px 16px;
  border-radius: 10px; border: 1px solid var(--line); background: var(--card); color: var(--text); font: inherit;
  font-weight: 600; cursor: pointer; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); margin-top: 16px; }
.btn:disabled { opacity: 0.55; cursor: default; }
label.field { display: block; font-weight: 600; margin-bottom: 6px; }
input.code { width: 100%; padding: 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg);
  color: var(--text); font: 600 1.6rem/1.2 ui-monospace, Menlo, Consolas, monospace; letter-spacing: 0.3em;
  text-align: center; }
.status { margin: 14px 0 0; font-weight: 600; min-height: 1.45em; color: var(--muted); }
.status.good { color: var(--good); }
.status.bad { color: var(--bad); }
.pad { user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; touch-action: manipulation; }
.key { display: flex; align-items: center; justify-content: center; min-height: 60px; border: 0; border-radius: 14px;
  background: var(--key); color: var(--text); font: 600 1rem/1.2 inherit; cursor: pointer; padding: 6px;
  -webkit-tap-highlight-color: transparent; }
.key.down { background: var(--key-down); }
.key:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.key svg { width: 26px; height: 26px; fill: currentColor; }
.r90 { transform: rotate(90deg); } .r180 { transform: rotate(180deg); } .r270 { transform: rotate(270deg); }
.dpad { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 4px auto 14px; max-width: 19rem; }
.dpad .key { aspect-ratio: 1 / 1; min-height: 0; }
.dpad .ok { background: var(--accent); color: var(--accent-text); border-radius: 50%; font-size: 1.15rem; }
.dpad .ok.down { filter: brightness(0.85); }
.row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 8px; }
.row.two { grid-template-columns: repeat(2, 1fr); }
.key small { display: block; font-weight: 500; color: var(--muted); font-size: 0.8rem; }
.hint { font-size: 0.85rem; text-align: center; margin: 2px 0 12px; }
.type { margin-top: 18px; }
.typerow { display: flex; gap: 8px; }
.typerow input { flex: 1; min-width: 0; padding: 12px; border-radius: 10px; border: 1px solid var(--line);
  background: var(--card); color: var(--text); font: inherit; }
.typerow .key { min-width: 64px; min-height: 50px; }
.foot { margin-top: 28px; text-align: center; }
.link { background: none; border: 0; color: var(--muted); font: inherit; font-size: 0.9rem; text-decoration: underline;
  cursor: pointer; padding: 8px; }
</style>
</head>
<body>
<main>
<section id="pairing" hidden>
<h1>Use your phone as a TV remote</h1>
<p id="pairIntro">On the TV, go to Settings › Remotes › Pair a phone. Type the 8-digit code it shows.</p>
<div class="card">
<label class="field" for="code">Code from the TV</label>
<input class="code" id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" pattern="[0-9]*"
  spellcheck="false">
<button type="button" class="btn primary" id="pair">Pair</button>
<p class="status" id="pairStatus" role="status" aria-live="polite"></p>
</div>
</section>

<section id="remote" class="pad" hidden>
<div class="dpad">
  <span></span>
  <button type="button" class="key" data-action="up" data-repeat aria-label="Up">${arrow(0)}</button>
  <span></span>
  <button type="button" class="key" data-action="left" data-repeat aria-label="Left">${arrow(270)}</button>
  <button type="button" class="key ok" data-action="select">OK</button>
  <button type="button" class="key" data-action="right" data-repeat aria-label="Right">${arrow(90)}</button>
  <span></span>
  <button type="button" class="key" data-action="down" data-repeat aria-label="Down">${arrow(180)}</button>
  <span></span>
</div>
<div class="row">
  <button type="button" class="key" data-action="back">Back</button>
  <button type="button" class="key" data-action="home" data-hold="recovery">Home</button>
  <button type="button" class="key" data-action="menu">Menu</button>
</div>
<p class="hint">Hold Home for the Recovery menu.</p>
<div class="row">
  <button type="button" class="key" data-action="rewind" data-repeat aria-label="Rewind">${icon('rew')}</button>
  <button type="button" class="key" data-action="playPause" aria-label="Play or pause">${icon('pp')}</button>
  <button type="button" class="key" data-action="fastForward" data-repeat aria-label="Fast forward">${icon('ff')}</button>
</div>
<div class="row two">
  <button type="button" class="key" data-action="volumeDown" data-repeat>Volume −</button>
  <button type="button" class="key" data-action="volumeUp" data-repeat>Volume +</button>
</div>
<p class="status" id="status" role="status" aria-live="polite"></p>
<div class="type">
  <label class="field" for="text">Type on the TV</label>
  <div class="typerow">
    <input id="text" maxlength="${PHONE_TEXT_LIMIT}" autocomplete="off" autocapitalize="off" autocorrect="off"
      spellcheck="false" enterkeyhint="send">
    <button type="button" class="key" id="send">Send</button>
    <button type="button" class="key" id="erase" data-repeat aria-label="Delete a letter">⌫</button>
  </div>
</div>
<div class="foot"><button type="button" class="link" id="forget">Stop using this phone as a remote</button></div>
</section>
</main>
<script nonce="${n}">
(function () {
  var TOKEN_KEY = '${TOKEN_KEY}';
  var MESSAGES = {
    expired: 'This code has expired. On the TV, go to Settings › Remotes › Pair a phone for a new one.',
    'wrong-code': "That code isn't right. Check the code on the TV and try again.",
    unpaired: "This phone isn't paired any more. Pair it again from the TV.",
    rate: 'Too many tries. Wait a minute, then try again.',
    off: 'The phone remote is switched off on the TV. Turn it on in Settings › Remotes.',
    offline: "Can't reach the TV. Check your phone is on the same Wi-Fi.",
    short: 'Type all 8 digits of the code.',
    other: "That didn't work. Try again."
  };
  var memoryToken = null;
  function readToken() {
    try { return localStorage.getItem(TOKEN_KEY) || memoryToken; } catch (e) { return memoryToken; }
  }
  function saveToken(t) {
    memoryToken = t;
    try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch (e) { /* private mode */ }
  }
  function $(id) { return document.getElementById(id); }
  function show(el, message, tone) {
    el.textContent = message || '';
    el.className = 'status' + (tone ? ' ' + tone : '');
  }
  function post(path, body, auth) {
    var headers = { 'Content-Type': 'application/json', 'X-MediaOS-Remote': '1' };
    if (auth) headers.Authorization = 'Bearer ' + auth;
    return fetch(path, {
      method: 'POST', headers: headers, body: JSON.stringify(body || {}),
      cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer'
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (reply) {
        if (response.ok && reply && reply.ok === true) return reply;
        var error = reply && typeof reply.error === 'string' ? reply.error : (response.status === 401 ? 'unpaired' : 'other');
        throw { error: error };
      });
    }, function () { throw { error: 'offline' }; });
  }

  // ---- Pairing ----
  var codeBox = $('code'), pairBtn = $('pair'), pairStatus = $('pairStatus');
  function showPairing(message) {
    $('remote').hidden = true;
    $('pairing').hidden = false;
    show(pairStatus, message, message ? 'bad' : '');
  }
  function showRemote() {
    $('pairing').hidden = true;
    $('remote').hidden = false;
  }
  function pair(code) {
    var previous = readToken();
    if (!/^[0-9]{8}$/.test(code)) { show(pairStatus, MESSAGES.short, 'bad'); return; }
    pairBtn.disabled = true;
    show(pairStatus, 'Pairing…');
    post('/remote/pair', previous ? { code: code, previous: previous } : { code: code }).then(function (reply) {
      if (typeof reply.token !== 'string' || !reply.token) throw { error: 'other' };
      saveToken(reply.token);
      codeBox.value = '';
      pairBtn.disabled = false;
      showRemote();
      show($('status'), 'Paired. Your phone is now a remote for this TV.', 'good');
    }).catch(function (e) {
      pairBtn.disabled = false;
      show(pairStatus, MESSAGES[e && e.error] || MESSAGES.other, 'bad');
    });
  }
  codeBox.addEventListener('input', function () {
    var digits = codeBox.value.replace(/[^0-9]/g, '').slice(0, 8);
    if (digits !== codeBox.value) codeBox.value = digits;
    show(pairStatus, '');
  });
  codeBox.addEventListener('keydown', function (e) { if (e.key === 'Enter') pair(codeBox.value); });
  pairBtn.addEventListener('click', function () { pair(codeBox.value); });

  // ---- Remote ----
  var status = $('status');
  var inFlight = 0;
  var statusTimer = null;
  function flash(message, tone) {
    show(status, message, tone);
    clearTimeout(statusTimer);
    if (tone !== 'bad') statusTimer = setTimeout(function () { show(status, ''); }, 2500);
  }
  function failed(e) {
    var error = e && e.error;
    if (error === 'unpaired') { saveToken(null); showPairing(MESSAGES.unpaired); return; }
    flash(MESSAGES[error] || MESSAGES.other, 'bad');
  }
  function send(path, body) {
    var token = readToken();
    if (!token) { showPairing(''); return; }
    if (inFlight >= 4) return; // a slow network: drop presses rather than queue a burst the TV acts on later
    inFlight++;
    post(path, body, token).then(function (reply) {
      inFlight--;
      if (status.className.indexOf('bad') >= 0) show(status, '');
      if (typeof reply.volume === 'number') flash('Volume ' + Math.round(reply.volume) + '%');
    }, function (e) { inFlight--; failed(e); });
  }
  function tap() { try { if (navigator.vibrate) navigator.vibrate(8); } catch (e) { /* not supported */ } }

  var HOLD_MS = 1500, REPEAT_DELAY = 400, REPEAT_EVERY = 150;
  function wire(el, onPress) {
    var holdTimer = null, repeatTimer = null, held = false, active = false;
    function stop() {
      clearTimeout(holdTimer); clearInterval(repeatTimer); clearTimeout(repeatTimer);
      holdTimer = repeatTimer = null;
      el.classList.remove('down');
    }
    el.addEventListener('pointerdown', function (e) {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* older browsers */ }
      active = true; held = false;
      el.classList.add('down');
      tap();
      var hold = el.getAttribute('data-hold');
      if (hold) {
        holdTimer = setTimeout(function () { held = true; tap(); onPress(hold); }, HOLD_MS);
        return; // the normal action fires on release, unless the hold fired
      }
      onPress(null);
      if (el.hasAttribute('data-repeat')) {
        repeatTimer = setTimeout(function () {
          repeatTimer = setInterval(function () { onPress(null); }, REPEAT_EVERY);
        }, REPEAT_DELAY);
      }
    });
    el.addEventListener('pointerup', function () {
      if (!active) return;
      active = false;
      var fireOnRelease = el.getAttribute('data-hold') && !held;
      stop();
      if (fireOnRelease) onPress(null);
    });
    el.addEventListener('pointercancel', function () { active = false; stop(); });
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    // Keyboard and screen-reader activation (no pointer events): one press, no hold or repeat.
    el.addEventListener('click', function (e) { if (e.detail === 0) onPress(null); });
  }
  Array.prototype.forEach.call(document.querySelectorAll('[data-action]'), function (el) {
    wire(el, function (holdAction) { send('/remote/key', { action: holdAction || el.getAttribute('data-action') }); });
  });

  var textBox = $('text');
  function sendText() {
    var value = textBox.value;
    if (!value) return;
    send('/remote/text', { text: value.slice(0, ${PHONE_TEXT_LIMIT}) });
    textBox.value = '';
  }
  $('send').addEventListener('click', sendText);
  textBox.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); sendText(); } });
  wire($('erase'), function () { send('/remote/text', { backspace: true }); });

  $('forget').addEventListener('click', function () {
    if (!confirm('Stop using this phone as a remote? You can pair it again from the TV.')) return;
    var token = readToken();
    if (!token) { showPairing(''); return; }
    // Keep the token until the TV has really removed this phone, so a failed request can be tried again.
    post('/remote/forget', {}, token).then(function () {
      saveToken(null);
      showPairing('');
    }, failed);
  });

  // ---- Start ----
  var params = new URLSearchParams(location.search);
  var codeInAddress = (params.get('code') || '').replace(/[^0-9]/g, '');
  if (params.has('code')) {
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* keep going */ }
  }
  if (readToken() && !codeInAddress) showRemote();
  else if (codeInAddress) { showPairing(''); codeBox.value = codeInAddress.slice(0, 8); pair(codeBox.value); }
  else showPairing('');
})();
</script>
</body>
</html>
`
}

function arrow(deg: number): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" class="r${deg}"><path d="M12 6l7 9H5z"/></svg>`
}

function icon(kind: 'rew' | 'pp' | 'ff'): string {
  const paths = {
    rew: 'M11 6v12L3 12zm9 0v12l-8-6z',
    pp: 'M4 5v14l9-7zm11 0h2v14h-2zm4 0h2v14h-2z',
    ff: 'M4 6v12l8-6zm9 0v12l8-6z',
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[kind]}"/></svg>`
}
