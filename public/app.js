let state = { notes: [], drafts: [], cadence: {}, config: {} };
let activeTab = 'review';

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = iso => iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.error === 'login required') {
    showLogin();
    throw new Error('Enter the password to continue.');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}

// Runs an action with its button disabled, then refreshes the page state.
async function busy(button, label, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    await fn();
    await refresh();
  } catch (err) {
    toast(err.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function showLogin() {
  $('#login').hidden = false;
  $('#app').hidden = true;
  $('#password').focus();
}

$('#login').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    await api('POST', '/api/login', { password: $('#password').value });
    $('#login').hidden = true;
    $('#app').hidden = false;
    await refresh();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
});

async function refresh() {
  state = await api('GET', '/api/state');
  render();
}

function render() {
  // Keep unsaved edits in any draft box across re-renders.
  const unsaved = {};
  document.querySelectorAll('textarea.post').forEach(t => {
    const d = state.drafts.find(x => x.id === t.dataset.id);
    if (d && t.value !== d.post) unsaved[t.dataset.id] = t.value;
  });
  renderCadence();
  renderSetup();
  const ready = state.drafts.filter(d => d.status === 'ready');
  const inbox = state.notes.filter(n => n.status === 'new' || n.status === 'triaged' || n.status === 'error');
  $('#count-review').textContent = ready.length || '';
  $('#count-notes').textContent = inbox.length || '';
  renderReview(ready);
  renderNotes();
  renderDone();
  Object.entries(unsaved).forEach(([id, value]) => {
    const t = document.querySelector(`textarea.post[data-id="${id}"]`);
    if (t) t.value = value;
  });
}

function renderCadence() {
  const c = state.cadence;
  const bars = Array.from({ length: c.target || 3 }, (_, i) => `<span class="${i < c.thisWeek ? 'on' : ''}"></span>`).join('');
  $('#cadence').innerHTML = `
    <small>This week</small>
    <strong>${c.thisWeek ?? 0}</strong> / ${c.target ?? 3} drafted
    <div class="meter">${bars}</div>
    <small>${c.approvedThisWeek ?? 0} posted · drafts land ${esc((c.days || []).join(', '))} at ${c.hour}:00${c.timezone ? ` (${esc(c.timezone)})` : ''}</small>`;
}

function renderSetup() {
  const cfg = state.config;
  const missing = [];
  if (!cfg.gemini) missing.push('<code>GEMINI_API_KEY</code> - needed to sort notes and write drafts');
  if (!cfg.telegram) missing.push('<code>TELEGRAM_BOT_TOKEN</code> - needed to pick up notes from Telegram');
  else if (!cfg.telegramChat) missing.push('<code>TELEGRAM_CHAT_ID</code> - send /start to the bot and it will reply with the value');
  $('#setup').hidden = !missing.length;
  $('#setup').innerHTML = missing.length ? `Setup: these settings are missing on the server:<br>${missing.join('<br>')}` : '';
}

function noteFor(draft) {
  return state.notes.find(n => n.id === draft.noteId) || { text: '(note missing)' };
}

function flagsHtml(lint) {
  if (!lint?.length) return '<div class="flag ok">Passes every voice check.</div>';
  const order = { error: 0, fill: 1, warn: 2 };
  return [...lint].sort((a, b) => order[a.severity] - order[b.severity])
    .map(i => `<div class="flag ${i.severity}"><strong>${esc(i.rule)}:</strong> ${esc(i.detail)}</div>`).join('');
}

function angleHtml(d) {
  const sources = d.sources?.length
    ? `<ul>${d.sources.map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a></li>`).join('')}</ul>`
    : '<div class="flag warn" style="margin-top:6px">No live search source came back. Check the news angle before posting.</div>';
  return `<div class="angle"><strong>Current angle.</strong> ${esc(d.angle || 'None given.')}${sources}</div>`;
}

function renderReview(ready) {
  const el = $('#tab-review');
  if (!ready.length) {
    el.innerHTML = `<div class="empty">Nothing waiting for you.<br>The next draft arrives on a scheduled day, or pick a note under <em>Notes</em> and draft it now.</div>`;
    return;
  }
  el.innerHTML = ready.map(d => {
    const note = noteFor(d);
    return `
    <article class="card" id="${d.id}">
      <h3>Draft from your note</h3>
      <div class="meta">${fmtDate(d.createdAt)} · ${d.trigger === 'schedule' ? 'scheduled' : d.trigger === 'redraft' ? 'redraft with your feedback' : 'drafted on request'}${d.autoRevised ? ' · auto-corrected once for voice rules' : ''}</div>
      <div class="source-note">${esc(note.text)}</div>
      ${angleHtml(d)}
      <textarea class="post" data-id="${d.id}">${esc(d.post)}</textarea>
      <div class="flags" data-flags="${d.id}">${flagsHtml(d.lint)}</div>
      ${d.forMeera ? `<details><summary>Notes for you from the drafter</summary><div class="for-meera">${esc(d.forMeera)}</div></details>` : ''}
      <div class="actions">
        <button data-act="copy" data-id="${d.id}">Copy &amp; mark posted</button>
        <button class="secondary" data-act="save" data-id="${d.id}">Save edits</button>
        <button class="danger" data-act="reject" data-id="${d.id}">Not this one</button>
      </div>
      <form class="redraft" data-id="${d.id}">
        <input placeholder="Or tell it what to change, e.g. 'lead with the CDSCO update, drop the Mumbai bit'">
        <button class="secondary" type="submit">Redraft</button>
      </form>
    </article>`;
  }).join('');

  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
}

function renderNotes() {
  const rank = n => ({ new: 0, error: 0, triaged: 1, drafted: 2 }[n.status] ?? 3);
  const notes = [...state.notes].sort((a, b) => rank(a) - rank(b));
  $('#notes-list').innerHTML = notes.length ? notes.map(n => {
    const t = n.triage;
    const verdict = n.status === 'drafted' ? 'drafted' : t?.verdict || 'new';
    const canDraft = n.status !== 'drafted' && n.status !== 'error';
    return `
    <article class="card note">
      <div>
        <div class="meta">${fmtDate(n.receivedAt)} · ${n.source === 'telegram' ? `Telegram${n.kind === 'voice' ? ' voice note' : ''}` : 'added here'}${n.forwardedFrom ? ` · forwarded from ${esc(n.forwardedFrom)}` : ''}</div>
        <div class="text">${esc(n.text)}</div>
        ${n.error ? `<div class="flag error">${esc(n.error)}</div>` : ''}
        ${t?.overriddenByMeera
          ? `<div class="why"><strong>You set this to ${esc(t.verdict)}.</strong>${t.reason ? ` The filter said ${esc(t.filterVerdict)}: ${esc(t.reason)}` : ''}</div>`
          : t?.reason ? `<div class="why"><strong>Why ${esc(t.verdict)} (${t.score}/10):</strong> ${esc(t.reason)}</div>` : ''}
        ${t?.angle ? `<div class="why"><strong>Angle:</strong> ${esc(t.angle)}</div>` : ''}
        ${t?.needsFromMeera?.length ? `<div class="why"><strong>Needs your data:</strong> ${esc(t.needsFromMeera.join('; '))}</div>` : ''}
      </div>
      <div class="note-side">
        <span class="verdict ${verdict === 'drafted' ? 'develop' : verdict}">${verdict}</span>
        ${canDraft ? `
          <div class="override">
            ${['develop', 'hold', 'skip'].filter(v => v !== t?.verdict).map(v => `<button class="secondary" data-verdict="${v}" data-id="${n.id}">${v}</button>`).join('')}
          </div>
          <button data-act="draft" data-id="${n.id}">Draft now</button>` : ''}
      </div>
    </article>`;
  }).join('') : '<div class="empty">No notes yet. Message the Telegram bot, or paste one above.</div>';
}

function renderDone() {
  const done = state.drafts.filter(d => d.status === 'approved' || d.status === 'rejected');
  $('#tab-done').innerHTML = done.length ? done.map(d => `
    <article class="card">
      <div class="meta">${d.status === 'approved' ? 'Posted' : 'Passed on'} · ${fmtDate(d.approvedAt || d.rejectedAt || d.createdAt)}</div>
      <div class="source-note">${esc(d.post)}</div>
      ${d.status === 'rejected' ? `<button class="secondary" data-act="restore" data-id="${d.id}">Back to review</button>` : ''}
    </article>`).join('') : '<div class="empty">Posted and passed-on drafts show up here.</div>';
}

function currentText(id) {
  return document.querySelector(`textarea.post[data-id="${id}"]`)?.value;
}

document.addEventListener('click', async e => {
  const tab = e.target.closest('.tab');
  if (tab) {
    activeTab = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
    document.querySelectorAll('.panel').forEach(p => { p.hidden = p.id !== `tab-${activeTab}`; });
    return;
  }

  const btn = e.target.closest('button[data-act], button[data-verdict]');
  if (!btn) return;
  const id = btn.dataset.id;

  if (btn.dataset.verdict) {
    return busy(btn, '...', () => api('POST', `/api/notes/${id}/verdict`, { verdict: btn.dataset.verdict }));
  }
  switch (btn.dataset.act) {
    case 'draft':
      return busy(btn, 'Searching news and drafting...', async () => {
        await api('POST', `/api/notes/${id}/draft`);
        toast('Draft ready under "To review".');
      });
    case 'save':
      return busy(btn, 'Saving...', async () => {
        await api('PUT', `/api/drafts/${id}`, { post: currentText(id) });
        toast('Saved. Voice checks re-run.');
      });
    case 'copy':
      return busy(btn, 'Copying...', async () => {
        const text = currentText(id);
        try { await navigator.clipboard.writeText(text); } catch { /* clipboard blocked - text is still saved */ }
        await api('PUT', `/api/drafts/${id}`, { post: text, status: 'approved' });
        toast('Copied. Paste it into LinkedIn.');
      });
    case 'reject':
      return busy(btn, '...', () => api('PUT', `/api/drafts/${id}`, { status: 'rejected' }));
    case 'restore':
      return busy(btn, '...', () => api('PUT', `/api/drafts/${id}`, { status: 'ready' }));
  }
});

document.addEventListener('submit', async e => {
  if (e.target.matches('.redraft')) {
    e.preventDefault();
    const input = e.target.querySelector('input');
    const btn = e.target.querySelector('button');
    return busy(btn, 'Redrafting...', async () => {
      await api('POST', `/api/drafts/${e.target.dataset.id}/redraft`, { feedback: input.value });
      toast('New version ready.');
    });
  }
  if (e.target.id === 'add-note') {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    return busy(btn, 'Adding...', async () => {
      await api('POST', '/api/notes', { text: $('#note-text').value });
      $('#note-text').value = '';
    });
  }
});

$('#run-triage').addEventListener('click', e => busy(e.target, 'Sorting...', async () => {
  const r = await api('POST', '/api/triage');
  toast(r.length ? `Sorted ${r.length} note(s).` : 'No new notes to sort.');
}));

$('#run-tick').addEventListener('click', e => busy(e.target, 'Running...', async () => {
  const r = await api('POST', '/api/tick');
  toast(r.message);
}));

refresh().catch(err => toast(err.message));
