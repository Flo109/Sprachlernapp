'use strict';
/* Kurmancî Karteikarten – Progressive Web App
   Daten: IndexedDB (lokal auf dem Gerät). Übersetzung: kostenlose KI-Schlüssel (Gemini/Groq/OpenRouter) oder Google Übersetzer. */

const DAY = 86400000;
const INTERVALS = [0, 1, 3, 7, 14, 30, 60, 120]; // Tage bis zur nächsten Abfrage je Stufe
const MAX_LVL = INTERVALS.length - 1;
const DEFAULTS = { keys: { gemini: '', groq: '', openrouter: '', claude: '' }, claudeModel: 'claude-sonnet-5-5', models: {}, newPerDay: 15, sessionSize: 40 };
const S = { cards: new Map(), byDe: new Map(), byKu: new Map(), settings: { ...DEFAULTS }, daily: null };
let db, sess = null, current = 'learn';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const other = d => (d === 'dk' ? 'kd' : 'dk');
const collator = new Intl.Collator('de', { sensitivity: 'base' });
const NOAC = 'autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"';
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/* ---------- Text-Hilfen ---------- */
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFC')
    .replace(/[.,!?;:"„“”‚‘’'«»()[\]…¿¡–—]/g, ' ').replace(/\s+/g, ' ').trim();
}
function fold(s) { return norm(s).replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, ''); }
const ART = /^(der|die|das|den|dem|des|ein|eine|einen|einem|einer)\s+/;
const deKey = s => norm(s).replace(ART, '');
const kuKey = s => norm(s);
function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i), cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}
function startOfDay(t = Date.now()) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }
const fmtDate = t => new Date(t).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

/* ---------- Datenbank ---------- */
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('kurmanci', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('cards', { keyPath: 'id', autoIncrement: true });
      d.createObjectStore('meta');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const store = (name, mode = 'readonly') => db.transaction(name, mode).objectStore(name);
const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const getMeta = k => reqP(store('meta').get(k));
const setMeta = (k, v) => reqP(store('meta', 'readwrite').put(v, k));

function keysOf(c) { const p = c.type === 'word' ? '' : 'p:'; return [p + deKey(c.de), p + kuKey(c.ku)]; }
function indexCard(c) {
  S.cards.set(c.id, c);
  c._s = fold(c.de + ' | ' + c.ku);
  const [a, b] = keysOf(c);
  if (deKey(c.de)) S.byDe.set(a, c.id);
  if (kuKey(c.ku)) S.byKu.set(b, c.id);
}
function unindexCard(c) {
  const [a, b] = keysOf(c);
  if (S.byDe.get(a) === c.id) S.byDe.delete(a);
  if (S.byKu.get(b) === c.id) S.byKu.delete(b);
}
async function saveCard(c) {
  const data = { ...c }; delete data._s;
  if (data.id == null) delete data.id;
  c.id = await reqP(store('cards', 'readwrite').put(data));
  indexCard(c);
  return c;
}
async function deleteCard(c) {
  await reqP(store('cards', 'readwrite').delete(c.id));
  unindexCard(c); S.cards.delete(c.id);
}
function findDup(de, ku, type) {
  const p = type === 'word' ? '' : 'p:';
  const id = (deKey(de) && S.byDe.get(p + deKey(de))) || (kuKey(ku) && S.byKu.get(p + kuKey(ku)));
  return id ? S.cards.get(id) : null;
}
const newSrs = () => ({ lvl: 0, due: 0, reps: 0, lapses: 0, last: 0 });
const makeCard = (de, ku, type, created) => ({ de: de.trim(), ku: ku.trim(), type, created, updated: created, dk: newSrs(), kd: newSrs() });
const cardLevel = c => Math.min(c.dk.lvl, c.kd.lvl);

async function loadState() {
  const all = await reqP(store('cards').getAll());
  all.forEach(indexCard);
  const st = await getMeta('settings');
  if (st) {
    Object.assign(S.settings, st);
    S.settings.keys = { ...DEFAULTS.keys, ...(st.keys || {}) };
    if (st.apiKey && !S.settings.keys.claude) S.settings.keys.claude = st.apiKey;
    S.settings.models = st.models || {};
  }
  S.daily = await getMeta('daily');
  ensureDaily();
}
function ensureDaily() {
  if (!S.daily || S.daily.date !== todayStr()) S.daily = { date: todayStr(), newDone: 0, extraNew: 0, seen: [], reviewed: 0 };
}
const saveDaily = () => setMeta('daily', S.daily);
async function persist() {
  try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch { }
}

/* ---------- UI-Hilfen ---------- */
function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
function modal(html, onMount) {
  const m = $('#modal');
  m.innerHTML = `<div class="sheet">${html}</div>`; m.hidden = false;
  m.onclick = e => { if (e.target === m) closeModal(); };
  onMount && onMount($('.sheet', m));
}
function closeModal() { const m = $('#modal'); m.hidden = true; m.innerHTML = ''; }
const charBar = id => `<div class="chars" data-for="${id}">${['ê', 'î', 'û', 'ç', 'ş'].map(ch => `<button type="button" tabindex="-1">${ch}</button>`).join('')}</div>`;
document.addEventListener('pointerdown', e => {
  const b = e.target.closest('.chars button'); if (!b) return;
  e.preventDefault();
  const inp = document.getElementById(b.parentElement.dataset.for); if (!inp) return;
  const focused = document.activeElement === inp;
  const s = focused ? inp.selectionStart : inp.value.length, en = focused ? inp.selectionEnd : s;
  inp.setRangeText(b.textContent, s, en, 'end');
  inp.focus();
  inp.dispatchEvent(new Event('input', { bubbles: true }));
});
const lvlBadge = l => `<span class="lvl" style="--h:${10 + l * 17}">${l}</span>`;
function cardRow(c) {
  return `<div class="crow" data-id="${c.id}"><div class="txt"><div class="c-de">${esc(c.de)}</div><div class="c-ku">${esc(c.ku)}</div>${c.type === 'phrase' ? '<div class="tag">Satz/Wendung</div>' : ''}</div>${lvlBadge(cardLevel(c))}</div>`;
}
function bindRows(el, after) {
  el.querySelectorAll('.crow').forEach(r => (r.onclick = () => openEdit(S.cards.get(+r.dataset.id), after)));
}

/* ---------- Übersetzung ---------- */
const PROVIDERS = {
  gemini: { name: 'Google Gemini' }, groq: { name: 'Groq' }, openrouter: { name: 'OpenRouter' }, claude: { name: 'Claude' }
};
const ORDER = ['gemini', 'groq', 'openrouter', 'claude'];
const hasAI = () => ORDER.some(p => S.settings.keys[p]);
class HttpErr extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const errText = e => (e.status ? e.status + ' ' : '') + String(e.message || '').slice(0, 140);
async function postJSON(url, headers, body) {
  let r;
  try { r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }); }
  catch { throw new HttpErr(0, 'keine Verbindung'); }
  if (!r.ok) {
    let m = '';
    try { const j = await r.json(); m = (Array.isArray(j) ? j[0] : j).error?.message || JSON.stringify(j).slice(0, 200); } catch { }
    throw new HttpErr(r.status, m || 'HTTP ' + r.status);
  }
  return r.json();
}
async function getJSON(url, headers = {}) {
  let r;
  try { r = await fetch(url, { headers }); } catch { throw new HttpErr(0, 'keine Verbindung'); }
  if (!r.ok) { let m = ''; try { m = (await r.json()).error?.message || ''; } catch { } throw new HttpErr(r.status, m || 'HTTP ' + r.status); }
  return r.json();
}
const verNum = id => { const m = id.match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
// Ermittelt automatisch die aktuell verfügbaren (kostenlosen) Modelle eines Anbieters
async function modelsFor(p) {
  const cache = S.settings.models[p];
  if (cache && cache.t > Date.now() - 3 * DAY && cache.list.length) return cache.list;
  const key = S.settings.keys[p].trim();
  let list = [];
  try {
    if (p === 'gemini') {
      const j = await getJSON('https://generativelanguage.googleapis.com/v1beta/models?pageSize=300&key=' + encodeURIComponent(key));
      const ids = (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace('models/', ''))
        .filter(id => /flash|gemma/.test(id) && !/image|tts|audio|live|embed|vision|robotics|computer|omni|veo|lyria/.test(id));
      const score = id => (/gemma/.test(id) ? -100 : 0) + verNum(id) * 10 - (/lite/.test(id) ? 3 : 0) - (/preview|exp/.test(id) ? 1 : 0) - (/latest/.test(id) ? 50 : 0);
      list = [...new Set(ids)].sort((a, b) => score(b) - score(a)).slice(0, 6);
    } else if (p === 'groq') {
      const j = await getJSON('https://api.groq.com/openai/v1/models', { authorization: 'Bearer ' + key });
      const ids = (j.data || []).map(m => m.id).filter(id => !/whisper|guard|tts|playai|compound|orpheus|safeguard|prompt/.test(id));
      const pref = ['openai/gpt-oss-120b', 'moonshotai/kimi-k2-instruct-0905', 'moonshotai/kimi-k2-instruct', 'llama-3.3-70b-versatile', 'qwen/qwen3-32b', 'meta-llama/llama-4-maverick-17b-128e-instruct'];
      list = [...pref.filter(x => ids.includes(x)), ...ids.filter(x => !pref.includes(x))].slice(0, 4);
    }
  } catch (e) { if ([400, 401, 403].includes(e.status)) throw e; }
  if (p === 'openrouter') list = ['openrouter/free'];
  if (p === 'claude') list = [S.settings.claudeModel || DEFAULTS.claudeModel];
  if (!list.length) list = p === 'gemini' ? ['gemini-flash-latest', 'gemini-flash-lite-latest'] : ['llama-3.3-70b-versatile'];
  else { S.settings.models[p] = { t: Date.now(), list }; setMeta('settings', S.settings); }
  return list;
}
async function callProvider(p, model, system, messages, maxTokens) {
  const key = S.settings.keys[p].trim();
  if (p === 'gemini') {
    const gemma = model.startsWith('gemma');
    const msgs = gemma ? [{ role: 'user', content: system + '\n\n' + messages[0].content }, ...messages.slice(1)] : messages;
    const j = await postJSON(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {}, {
      ...(gemma ? {} : { systemInstruction: { parts: [{ text: system }] } }),
      contents: msgs.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: Math.max(maxTokens, 6000), temperature: 0.4, ...(gemma ? {} : { responseMimeType: 'application/json' }) }
    });
    const cand = j.candidates?.[0];
    const t = (cand?.content?.parts || []).filter(x => !x.thought).map(x => x.text || '').join('');
    if (!t) throw new HttpErr(500, 'leere Antwort' + (cand?.finishReason ? ' (' + cand.finishReason + ')' : ''));
    return t;
  }
  if (p === 'claude') {
    const j = await postJSON('https://api.anthropic.com/v1/messages', { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      { model, max_tokens: maxTokens, system, messages });
    return j.content.filter(b => b.type === 'text').map(b => b.text).join('');
  }
  const url = p === 'groq' ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions';
  const j = await postJSON(url, { authorization: 'Bearer ' + key },
    { model, max_tokens: Math.max(maxTokens, 3000), temperature: 0.4, messages: [{ role: 'system', content: system }, ...messages] });
  const t = (j.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (!t) throw new HttpErr(500, 'leere Antwort');
  return t;
}
// Fragt die KI; probiert nacheinander alle eingetragenen Anbieter und Modelle (z.B. wenn ein Tageslimit erreicht ist)
async function llm(system, messages, maxTokens = 1024, validate = null) {
  const provs = ORDER.filter(p => S.settings.keys[p]);
  if (!provs.length) throw new Error('Kein KI-Schlüssel hinterlegt (Einstellungen ⚙)');
  const errs = [];
  for (const p of provs) {
    let models;
    try { models = await modelsFor(p); } catch (e) { errs.push(`${PROVIDERS[p].name}: ${errText(e)}`); continue; }
    for (const m of models) {
      try {
        const t = await callProvider(p, m, system, messages, maxTokens);
        const out = validate ? validate(t) : t;
        ensureDaily(); S.daily.ai = (S.daily.ai || 0) + 1; saveDaily();
        S.lastAI = `${PROVIDERS[p].name} · ${m}`;
        return out;
      } catch (e) {
        errs.push(`${PROVIDERS[p].name} ${m}: ${errText(e)}`);
        if (e.status === 401 || e.status === 403 || /api.?key/i.test(e.message)) break; // Schlüssel ungültig → nächster Anbieter
      }
    }
  }
  const limit = errs.some(e => /429|quota|limit|exhaust/i.test(e));
  throw new Error(limit ? 'Tageslimit der kostenlosen KI erreicht. Morgen geht es wieder – oder trage in den Einstellungen einen weiteren kostenlosen Schlüssel ein.'
    : 'KI nicht erreichbar: ' + errs.slice(-2).join(' | '));
}
function parseJSON(t) {
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s < 0 || e < s) throw new Error('Unerwartete Antwort der KI');
  return JSON.parse(t.slice(s, e + 1));
}
const TRANSLATE_SYS = `Du bist ein präziser Übersetzer zwischen Deutsch und Kurmanji (Nordkurdisch, lateinisches Hawar-Alphabet mit ê, î, û, ç, ş). Du hilfst beim Erstellen von Lern-Karteikarten.
Antworte AUSSCHLIESSLICH mit einem JSON-Objekt ohne Markdown in diesem Format:
{"source":"de" oder "ku","type":"word" oder "phrase","de":"…","ku":"…","words":[{"de":"…","ku":"…"}]}
Regeln:
- "source" ist die Sprache der Eingabe. Behalte die Eingabe auf ihrer Seite bei (korrigiere nur offensichtliche Tippfehler oder fehlende Sonderzeichen).
- type "word": ein einzelnes Wort (ein deutsches Substantiv mit Artikel zählt als ein Wort). Gib beide Seiten in der Grundform an: deutsche Substantive mit bestimmtem Artikel (z.B. "der Hund"), Verben im Infinitiv; Kurmanji-Substantive in der unbestimmten Grundform (Rectus, ohne Ezafe), Verben im Infinitiv (z.B. "xwarin"). Bei mehreren gängigen Bedeutungen höchstens 2, getrennt durch " / ". "words" bleibt leer.
- type "phrase": Satz oder Wendung. Übersetze natürlich und grammatisch korrekt. In "words" stehen alle bedeutungstragenden Wörter des Satzes (Substantive, Verben, Adjektive, Adverbien, Pronomen, wichtige Präpositionen) als Paare in der Grundform wie oben beschrieben – ohne Duplikate und ohne Eigennamen.`;

async function translateAI(text, hint) {
  const h = hint === 'de' ? ' (Sprache: Deutsch)' : hint === 'ku' ? ' (Sprache: Kurmanji)' : '';
  const j = await llm(TRANSLATE_SYS, [{ role: 'user', content: `Eingabe${h}: ${text}` }], 1500, t => { const j = parseJSON(t); if (!j.de || !j.ku) throw new Error('unvollständig'); return j; });
  return { source: j.source, type: j.type === 'word' ? 'word' : 'phrase', de: j.de || '', ku: j.ku || '', words: Array.isArray(j.words) ? j.words : [] };
}
async function gtx(text, sl, tl) {
  let r;
  try { r = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`); }
  catch { throw new Error('Keine Internetverbindung zum Übersetzer'); }
  if (!r.ok) throw new Error('Übersetzer nicht erreichbar (' + r.status + ')');
  const j = await r.json();
  return { text: (j[0] || []).map(x => x[0]).join('').trim(), detected: j[2] };
}
async function translateGoogle(text, hint) {
  let src = hint;
  if (src === 'auto') src = (await gtx(text, 'auto', 'de')).detected === 'de' ? 'de' : 'ku';
  const tl = src === 'de' ? 'ku' : 'de';
  const main = (await gtx(text, src, tl)).text;
  const toks = text.trim().split(/\s+/);
  const isPhrase = toks.length > 2 || /[.!?,]/.test(text) || (toks.length === 2 && !(src === 'de' && ART.test(norm(text))));
  let words = [];
  if (isPhrase) {
    const seen = new Set();
    const ws = text.replace(/[.,!?;:"„“”‚‘’«»()[\]…¿¡–—]/g, ' ').split(/\s+/)
      .filter(w => w.length > 1 && !seen.has(w.toLowerCase()) && seen.add(w.toLowerCase())).slice(0, 25);
    const tr = await Promise.all(ws.map(w => gtx(w, src, tl).then(r => r.text).catch(() => '')));
    words = ws.map((w, i) => (src === 'de' ? { de: w, ku: tr[i] } : { de: tr[i], ku: w }))
      .filter(p => p.de && p.ku && norm(p.de) !== norm(p.ku));
  }
  return { source: src, type: isPhrase ? 'phrase' : 'word', de: src === 'de' ? text.trim() : main, ku: src === 'ku' ? text.trim() : main, words };
}

/* ---------- Lernsystem (Leitner-Stufen, beide Richtungen) ---------- */
function newLeft() { ensureDaily(); return Math.max(0, (+S.settings.newPerDay || 0) + S.daily.extraNew - S.daily.newDone); }
function candidates() {
  ensureDaily();
  const now = Date.now(), seen = new Set(S.daily.seen), rev = [], nw = [];
  for (const c of S.cards.values()) {
    const ok = d => !seen.has(c.id + ':' + other(d)); // Geschwister-Richtung am selben Tag nicht abfragen
    let best = null;
    for (const d of ['kd', 'dk']) {
      const s = c[d];
      if (s.reps > 0 && s.due <= now && ok(d) && (!best || s.due < best.due)) best = { c, d, due: s.due, isNew: false };
    }
    if (best) { rev.push(best); continue; }
    if (c.kd.reps === 0) { if (ok('kd')) nw.push({ c, d: 'kd', isNew: true }); }
    else if (c.dk.reps === 0 && c.kd.lvl >= 1 && ok('dk')) nw.push({ c, d: 'dk', isNew: true });
  }
  rev.sort((a, b) => a.due - b.due);
  nw.sort((a, b) => a.c.created - b.c.created || (a.c.type === 'word' ? 0 : 1) - (b.c.type === 'word' ? 0 : 1) || a.c.id - b.c.id);
  return { rev, nw };
}
function dueFor(lvl) {
  let days = INTERVALS[lvl];
  if (days >= 7) days = Math.round(days * (0.9 + Math.random() * 0.2)); // verteilt die Last
  return startOfDay() + days * DAY;
}
function checkAnswer(given, expected, isGerman, isWord) {
  const sep = isWord ? /\s*(?:;|\/|,|\n)\s*/ : /\s*(?:;|\s\/\s|\n)\s*/;
  const alts = [expected, ...expected.split(sep)].filter(Boolean);
  const g = norm(given), gf = fold(given);
  let best = { v: 'wrong' };
  for (const a of alts) {
    if (norm(a) === g) return { v: 'right' };
    if (best.v === 'near') continue;
    if (isGerman && deKey(a) && deKey(a) === deKey(given)) best = { v: 'near', note: 'Achte auf den Artikel.' };
    else if (fold(a) === gf) best = { v: 'near', note: 'Achte auf die Sonderzeichen (ê, î, û, ç, ş, ä, ö, ü …).' };
    else {
      const af = fold(a), dist = lev(af, gf);
      const tol = af.length <= 4 ? 0 : af.length <= 8 ? 1 : Math.max(2, Math.round(af.length * 0.12));
      if (dist <= tol) best = { v: 'near', note: 'Kleiner Tippfehler?' };
    }
  }
  return best;
}

/* ---------- Ansicht: Lernen ---------- */
function viewLearn(m) {
  if (sess) return renderQ();
  const { rev, nw } = candidates();
  const nl = Math.min(newLeft(), nw.length);
  const size = +S.settings.sessionSize || 40;
  const r = Math.min(rev.length, size), startN = r + Math.min(nl, size - r);
  const total = S.cards.size;
  const lv = new Array(MAX_LVL + 1).fill(0);
  for (const c of S.cards.values()) lv[cardLevel(c)]++;
  const maxLv = Math.max(1, ...lv);
  m.innerHTML = `
    <div class="stats">
      <div class="stat"><b>${rev.length}</b><span>fällig</span></div>
      <div class="stat"><b>${nl}</b><span>neu heute</span></div>
      <div class="stat"><b>${total}</b><span>Karten</span></div>
    </div>
    ${total === 0 ? `<div class="card"><h2>Bi xêr hatî! 👋</h2><p>Lege unter <b>➕ Neu</b> deine ersten Wörter oder Sätze an. Danach kannst du hier lernen.</p></div>` : ''}
    ${startN > 0 ? `<button class="btn big" id="l-start">Lernen starten · ${startN} Karten</button>`
      : total ? `<div class="card center"><p>✅ Für heute ist alles erledigt. Heute geübt: ${S.daily.reviewed}</p></div>` : ''}
    <div class="row" style="margin-top:0;margin-bottom:14px">
      ${nw.length > nl ? `<button class="btn ghost" id="l-extra">+10 neue Karten</button>` : ''}
      ${total ? `<button class="btn ghost" id="l-train">Freies Training</button>` : ''}
    </div>
    ${total ? `<div class="card"><h3 style="margin-top:0">Deine Stufen</h3><div class="lvbars">${lv.map((n, i) => `
      <div class="lvrow" data-l="${i}"><span class="lname">Stufe ${i}</span><span class="bar"><i style="width:${(n / maxLv) * 100}%"></i></span><span class="lnum">${n}</span></div>`).join('')}
      </div><p class="hint">Stufe 0 = neu bzw. zuletzt falsch · Stufe 7 = sitzt sicher. Eine Karte zählt mit ihrer schwächeren Richtung.</p></div>` : ''}`;
  $('#l-start') && ($('#l-start').onclick = () => startSession(false));
  $('#l-extra') && ($('#l-extra').onclick = () => { S.daily.extraNew += 10; saveDaily(); show('learn'); });
  $('#l-train') && ($('#l-train').onclick = () => startSession(true));
  $$('.lvrow', m).forEach(r => (r.onclick = () => { CV.lvl = r.dataset.l; CV.limit = 100; show('cards'); }));
}
function startSession(practice) {
  let q;
  if (practice) {
    const all = shuffle([...S.cards.values()]).sort((a, b) => cardLevel(a) - cardLevel(b));
    q = shuffle(all.slice(0, 20)).map(c => ({ c, d: Math.random() < 0.5 ? 'dk' : 'kd', isNew: false }));
  } else {
    const { rev, nw } = candidates(), size = +S.settings.sessionSize || 40;
    const r = rev.slice(0, size), n = nw.slice(0, Math.min(newLeft(), Math.max(0, size - r.length)));
    q = []; let i = 0, j = 0;
    while (i < r.length || j < n.length) { for (let k = 0; k < 3 && i < r.length; k++) q.push(r[i++]); if (j < n.length) q.push(n[j++]); }
  }
  if (!q.length) return toast('Gerade gibt es nichts zu lernen');
  sess = { q, idx: 0, failed: new Set(), practice, right: 0, wrong: 0, done: -1 };
  renderQ();
}
function renderQ() {
  const m = $('#main'), it = sess.q[sess.idx];
  if (!it) return renderSummary();
  const { c, d } = it, toKu = d === 'dk', long = c.type !== 'word';
  m.innerHTML = `
  <div class="session">
    <div class="sess-top"><button class="link" id="q-quit">✕ Beenden</button><span>${sess.q.length - sess.idx} übrig${sess.practice ? ' · Training (ohne Stufenänderung)' : ''}</span></div>
    <div class="qcard">
      <div class="qmeta">${toKu ? 'Deutsch → Kurmancî' : 'Kurmancî → Deutsch'} · ${it.isNew ? '<b class="new">neu</b>' : 'Stufe ' + c[d].lvl}${it.again ? ' · Wiederholung' : ''}</div>
      <div class="qprompt ${long ? 'long' : ''}">${esc(toKu ? c.de : c.ku)}</div>
    </div>
    <div id="q-answer">
      ${long ? `<textarea id="ans" rows="3" ${NOAC} placeholder="Übersetzung eingeben…"></textarea>` : `<input id="ans" ${NOAC} placeholder="Übersetzung eingeben…">`}
      ${toKu ? charBar('ans') : ''}
      <div class="row"><button class="btn ghost" id="q-dunno">Weiß nicht</button><button class="btn" id="q-check">Prüfen</button></div>
    </div>
    <div id="q-result"></div>
  </div>`;
  const ans = $('#ans'); ans.focus();
  ans.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doCheck(false); } });
  $('#q-check').onclick = () => doCheck(false);
  $('#q-dunno').onclick = () => doCheck(true);
  $('#q-quit').onclick = () => { sess = null; show('learn'); };
}
function doCheck(dunno) {
  const it = sess.q[sess.idx], { c, d } = it, toKu = d === 'dk';
  const expected = toKu ? c.ku : c.de, given = $('#ans').value.trim();
  if (!dunno && !given) return $('#ans').focus();
  const res = dunno ? { v: 'wrong' } : checkAnswer(given, expected, !toKu, c.type === 'word');
  $('#q-answer').hidden = true;
  const r = $('#q-result');
  const exp = `<div class="expected">${esc(expected)}</div>`;
  const your = given ? `<div class="yours">Deine Antwort: ${esc(given)}</div>` : '';
  let html;
  if (res.v === 'right') html = `<div class="res ok">✓ Richtig!</div>${exp}<div class="row"><button class="btn" data-ok="1" id="q-primary">Weiter</button></div>`;
  else if (res.v === 'near') html = `<div class="res near">≈ Fast richtig</div><div class="note">${esc(res.note)}</div>${exp}${your}
    <div class="row"><button class="btn ghost" data-ok="0">Als falsch werten</button><button class="btn" data-ok="1" id="q-primary">Als richtig werten</button></div>`;
  else html = `<div class="res bad">✗ ${dunno ? 'Lösung' : 'Leider falsch'}</div>${exp}${your}
    <div class="row">${given ? `<button class="btn ghost" data-ok="1" id="q-override">Ich hatte recht</button>` : ''}<button class="btn" data-ok="0" id="q-primary">Weiter</button></div>
    ${given && hasAI() ? `<button class="link small" id="q-ai">🤖 Von der KI prüfen lassen</button><div id="q-ai-out"></div>` : ''}`;
  r.innerHTML = html + `<div><button class="link small" id="q-edit">✎ Karte bearbeiten</button></div>`;
  $$('[data-ok]', r).forEach(b => (b.onclick = () => answer(b.dataset.ok === '1')));
  $('#q-primary').focus();
  $('#q-edit').onclick = () => openEdit(c, () => { $('.expected', r).textContent = toKu ? c.ku : c.de; });
  $('#q-ai') && ($('#q-ai').onclick = () => aiCheck(c, d, given));
}
async function aiCheck(c, d, given) {
  const out = $('#q-ai-out'), toKu = d === 'dk';
  out.innerHTML = '<div class="spinner"></div>';
  try {
    const j = await llm('Du bewertest Übersetzungen eines deutschsprachigen Kurmanji-Lernenden. Antworte nur mit JSON: {"ok":true oder false,"explanation":"kurze Erklärung auf Deutsch"}. ok=true, wenn die Antwort eine korrekte, bedeutungsgleiche Übersetzung ist, auch wenn sie von der erwarteten Lösung abweicht. Erkläre Fehler (auch bei ê/e, î/i, û/u, ç/c, ş/s) kurz und verständlich.',
      [{ role: 'user', content: `Richtung: ${toKu ? 'Deutsch → Kurmanji' : 'Kurmanji → Deutsch'}\nVorgabe: ${toKu ? c.de : c.ku}\nErwartete Lösung: ${toKu ? c.ku : c.de}\nAntwort des Lernenden: ${given}` }], 500, parseJSON);
    out.innerHTML = `<div class="aiout">${j.ok ? '✅' : '❌'} ${esc(j.explanation)}</div>`;
    if (j.ok && $('#q-override')) { $('#q-override').className = 'btn'; $('#q-override').textContent = 'Als richtig werten'; $('#q-primary').className = 'btn ghost'; }
  } catch (e) { out.innerHTML = `<div class="aiout">${esc(e.message)}</div>`; }
}
function answer(ok) {
  if (sess.done === sess.idx) return; // Doppeltipp verhindern
  sess.done = sess.idx;
  const it = sess.q[sess.idx], { c, d } = it, key = c.id + ':' + d;
  if (!sess.practice) {
    ensureDaily();
    const s = c[d];
    if (s.reps === 0) S.daily.newDone++;
    if (!S.daily.seen.includes(key)) S.daily.seen.push(key);
    if (ok) {
      s.lvl = sess.failed.has(key) ? Math.max(s.lvl, 1) : Math.min(MAX_LVL, s.lvl + 1);
      s.due = dueFor(s.lvl);
    } else {
      s.lvl = s.lvl >= 4 ? 2 : 0; // gut gelernte Karten fallen nicht ganz zurück
      s.lapses++; s.due = 0;
    }
    s.reps++; s.last = Date.now(); S.daily.reviewed++;
    saveCard(c); saveDaily();
  }
  if (ok) sess.right++;
  else {
    sess.wrong++;
    sess.failed.add(key);
    sess.q.splice(Math.min(sess.idx + 5, sess.q.length), 0, { c, d, isNew: false, again: true });
  }
  sess.idx++;
  renderQ();
}
function renderSummary() {
  const wasPractice = sess.practice, right = sess.right, wrong = sess.wrong;
  sess = null;
  const { rev, nw } = candidates(), more = rev.length + Math.min(newLeft(), nw.length);
  $('#main').innerHTML = `<div class="card center"><h2>Geschafft! 🎉</h2><p>${right} richtig · ${wrong} falsch</p>
    ${!wasPractice && more ? `<button class="btn big" id="s-more">Weiter lernen (${more})</button>` : ''}
    <button class="btn ghost" id="s-home" style="width:100%">Zur Übersicht</button></div>`;
  $('#s-more') && ($('#s-more').onclick = () => startSession(false));
  $('#s-home').onclick = () => show('learn');
}

/* ---------- Ansicht: Neue Karte ---------- */
let addLang = 'auto';
function viewAdd(m) {
  m.innerHTML = `
    <div class="card">
      <div class="seg" id="a-lang">${[['auto', 'Automatisch'], ['de', 'Deutsch'], ['ku', 'Kurmancî']].map(([k, l]) => `<button data-l="${k}" class="${k === addLang ? 'on' : ''}">${l}</button>`).join('')}</div>
      <textarea id="a-in" rows="2" ${NOAC} placeholder="Wort, Satz oder Wendung auf Deutsch oder Kurmancî"></textarea>
      ${charBar('a-in')}
      <div class="row"><button class="btn ghost" id="a-manual">Manuell</button><button class="btn" id="a-go">Übersetzen</button></div>
      ${hasAI() ? '' : '<p class="hint">Ohne KI-Schlüssel wird Google Übersetzer genutzt; Wörter aus Sätzen werden dann nicht in die Grundform gebracht. Ein kostenloser Schlüssel verbessert das: <a href="#" id="a-set">Einstellungen</a></p>'}
    </div>
    <div id="a-out"></div>
    <div id="a-recent"></div>`;
  $$('#a-lang button').forEach(b => (b.onclick = () => { addLang = b.dataset.l; $$('#a-lang button').forEach(x => x.classList.toggle('on', x === b)); }));
  const inp = $('#a-in');
  inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doTranslate(); } });
  $('#a-go').onclick = doTranslate;
  $('#a-manual').onclick = () => {
    const t = inp.value.trim();
    renderPreview({ type: t.split(/\s+/).length > 2 ? 'phrase' : 'word', de: addLang === 'ku' ? '' : t, ku: addLang === 'ku' ? t : '', words: [] });
  };
  $('#a-set') && ($('#a-set').onclick = e => { e.preventDefault(); openSettings(); });
  renderRecent();
}
async function doTranslate() {
  const text = $('#a-in').value.trim();
  if (!text) return $('#a-in').focus();
  const out = $('#a-out');
  out.innerHTML = '<div class="card"><div class="spinner"></div></div>';
  try {
    let res;
    if (hasAI()) {
      try { res = await translateAI(text, addLang); }
      catch (e) { toast(e.message + ' → Google Übersetzer wird genutzt', 4500); res = await translateGoogle(text, addLang); }
    } else res = await translateGoogle(text, addLang);
    renderPreview(res);
  } catch (e) {
    out.innerHTML = `<div class="card"><p>⚠ ${esc(e.message)}</p><p class="hint">Du kannst die Karte auch über „Manuell“ selbst ausfüllen.</p></div>`;
  }
}
function renderPreview(res) {
  const out = $('#a-out');
  const seenW = new Set();
  const words = (res.words || []).map(w => ({ de: String(w.de || '').trim(), ku: String(w.ku || '').trim() }))
    .filter(w => w.de && w.ku && !seenW.has(deKey(w.de)) && seenW.add(deKey(w.de)));
  let type = res.type, confirmDup = false;
  const rows = n => Math.min(4, Math.max(1, Math.ceil(n / 32)));
  out.innerHTML = `<div class="card">
    <label>Deutsch</label><textarea id="p-de" rows="${rows(res.de.length)}">${esc(res.de)}</textarea>
    <label>Kurmancî</label><textarea id="p-ku" rows="${rows(res.ku.length)}" ${NOAC}>${esc(res.ku)}</textarea>${charBar('p-ku')}
    <label>Typ</label><div class="seg" id="p-type"><button data-t="word">Wort</button><button data-t="phrase">Satz / Wendung</button></div>
    <div id="p-dup"></div>
    ${words.length ? `<h3>Einzelne Wörter als eigene Karten</h3><div class="wlist">${words.map((w, i) => {
      const dup = findDup(w.de, w.ku, 'word');
      return `<div class="wrow ${dup ? 'dup' : ''}"><input type="checkbox" data-i="${i}" ${dup ? 'disabled' : 'checked'}><input class="w-de" value="${esc(w.de)}"><input class="w-ku" value="${esc(w.ku)}" ${NOAC}>${dup ? `<small>schon vorhanden: ${esc(dup.de)} = ${esc(dup.ku)}</small>` : ''}</div>`;
    }).join('')}</div>` : ''}
    <div class="row"><button class="btn ghost" id="p-cancel">Verwerfen</button><button class="btn" id="p-save">Speichern</button></div>
  </div>`;
  const setType = t => { type = t; $$('#p-type button').forEach(b => b.classList.toggle('on', b.dataset.t === t)); };
  setType(type);
  $$('#p-type button').forEach(b => (b.onclick = () => setType(b.dataset.t)));
  const dupCheck = () => {
    confirmDup = false; $('#p-save').textContent = 'Speichern';
    const d = findDup($('#p-de').value, $('#p-ku').value, type);
    $('#p-dup').innerHTML = d ? `<div class="warn">⚠ Ähnliche Karte existiert schon: ${esc(d.de)} = ${esc(d.ku)}</div>` : '';
  };
  $('#p-de').oninput = $('#p-ku').oninput = dupCheck; dupCheck();
  $('#p-cancel').onclick = () => (out.innerHTML = '');
  $('#p-save').onclick = async () => {
    const de = $('#p-de').value.trim(), ku = $('#p-ku').value.trim();
    if (!de || !ku) return toast('Bitte beide Seiten ausfüllen');
    if (findDup(de, ku, type) && !confirmDup) { confirmDup = true; $('#p-save').textContent = 'Trotzdem speichern'; return; }
    const created = Date.now();
    await saveCard(makeCard(de, ku, type, created));
    let n = 0;
    for (const r of $$('.wrow', out)) {
      if (!r.querySelector('input[type=checkbox]').checked) continue;
      const wde = r.querySelector('.w-de').value.trim(), wku = r.querySelector('.w-ku').value.trim();
      if (wde && wku && !findDup(wde, wku, 'word')) { await saveCard(makeCard(wde, wku, 'word', created)); n++; }
    }
    persist();
    toast(n ? `Gespeichert: 1 Karte + ${n} Wörter` : 'Karte gespeichert');
    $('#a-in').value = ''; out.innerHTML = ''; renderRecent(); $('#a-in').focus();
  };
}
function renderRecent() {
  const el = $('#a-recent'); if (!el) return;
  const list = Array.from(S.cards.values()).slice(-8).reverse();
  el.innerHTML = list.length ? `<h3 class="lvl-h">Zuletzt hinzugefügt</h3>${list.map(cardRow).join('')}` : '';
  bindRows(el, renderRecent);
}

/* ---------- Ansicht: Kartenübersicht ---------- */
const CV = { q: '', lvl: 'all', type: 'all', sort: 'lvl', limit: 100 };
function viewCards(m) {
  m.innerHTML = `
    <div class="searchbar"><input id="c-q" type="search" placeholder="🔍 Suchen (Deutsch oder Kurmancî)…" value="${esc(CV.q)}" ${NOAC}></div>
    <div class="chips" id="c-lv"></div>
    <div class="row filters" style="margin-top:4px">
      <select id="c-type"><option value="all">Alle Typen</option><option value="word">Wörter</option><option value="phrase">Sätze / Wendungen</option></select>
      <select id="c-sort"><option value="lvl">Nach Stufe</option><option value="new">Neueste zuerst</option><option value="de">A–Z Deutsch</option><option value="ku">A–Z Kurmancî</option></select>
    </div>
    <div id="c-count" class="hint"></div>
    <div id="c-list" class="clist"></div>`;
  $('#c-type').value = CV.type; $('#c-sort').value = CV.sort;
  let t;
  $('#c-q').oninput = e => { clearTimeout(t); t = setTimeout(() => { CV.q = e.target.value; CV.limit = 100; renderCardList(); }, 150); };
  $('#c-type').onchange = e => { CV.type = e.target.value; CV.limit = 100; renderCardList(); };
  $('#c-sort').onchange = e => { CV.sort = e.target.value; CV.limit = 100; renderCardList(); };
  renderCardList();
}
function renderCardList() {
  const q = fold(CV.q), base = [];
  for (const c of S.cards.values()) {
    if (CV.type !== 'all' && c.type !== CV.type) continue;
    if (q && !c._s.includes(q)) continue;
    base.push(c);
  }
  const lv = new Array(MAX_LVL + 1).fill(0);
  base.forEach(c => lv[cardLevel(c)]++);
  $('#c-lv').innerHTML = `<button data-l="all" class="${CV.lvl === 'all' ? 'on' : ''}">Alle (${base.length})</button>` +
    lv.map((n, i) => `<button data-l="${i}" class="${CV.lvl === String(i) ? 'on' : ''}">Stufe ${i} (${n})</button>`).join('');
  $$('#c-lv button').forEach(b => (b.onclick = () => { CV.lvl = b.dataset.l; CV.limit = 100; renderCardList(); }));
  const arr = CV.lvl === 'all' ? base : base.filter(c => cardLevel(c) === +CV.lvl);
  const cmp = {
    new: (a, b) => b.id - a.id,
    de: (a, b) => collator.compare(deKey(a.de), deKey(b.de)),
    ku: (a, b) => collator.compare(a.ku, b.ku),
    lvl: (a, b) => cardLevel(a) - cardLevel(b) || collator.compare(deKey(a.de), deKey(b.de))
  }[CV.sort];
  arr.sort(cmp);
  $('#c-count').textContent = `${arr.length} Karte${arr.length === 1 ? '' : 'n'}`;
  let html = '', lastL = -1;
  for (const c of arr.slice(0, CV.limit)) {
    if (CV.sort === 'lvl' && cardLevel(c) !== lastL) { lastL = cardLevel(c); html += `<div class="lvl-h">Stufe ${lastL}</div>`; }
    html += cardRow(c);
  }
  if (arr.length > CV.limit) html += `<button class="btn ghost" id="c-more" style="width:100%">Weitere ${Math.min(100, arr.length - CV.limit)} anzeigen</button>`;
  if (!arr.length) html = `<p class="hint center">Keine Karten gefunden.</p>`;
  const list = $('#c-list');
  list.innerHTML = html;
  bindRows(list, renderCardList);
  $('#c-more') && ($('#c-more').onclick = () => { CV.limit += 100; renderCardList(); });
}
function dueText(s) {
  if (s.reps === 0) return 'noch nicht gelernt';
  return s.due <= Date.now() ? 'jetzt fällig' : 'nächste Abfrage am ' + fmtDate(s.due);
}
function openEdit(c, after) {
  if (!c) return;
  modal(`<h2>Karte bearbeiten</h2>
    <label>Deutsch</label><textarea id="e-de" rows="2">${esc(c.de)}</textarea>
    <label>Kurmancî</label><textarea id="e-ku" rows="2" ${NOAC}>${esc(c.ku)}</textarea>${charBar('e-ku')}
    <label>Typ</label><select id="e-type"><option value="word">Wort</option><option value="phrase">Satz / Wendung</option></select>
    <div class="srsinfo">Deutsch → Kurmancî: <b>Stufe ${c.dk.lvl}</b> · ${dueText(c.dk)}<br>Kurmancî → Deutsch: <b>Stufe ${c.kd.lvl}</b> · ${dueText(c.kd)}<br>
      <small>Erstellt am ${fmtDate(c.created)} · Fehler insgesamt: ${c.dk.lapses + c.kd.lapses}</small></div>
    <p class="hint">Textänderungen ändern die Stufe nicht.</p>
    <div class="row"><button class="btn ghost danger" id="e-del">Löschen</button><button class="btn ghost" id="e-cancel">Abbrechen</button><button class="btn" id="e-save">Speichern</button></div>`,
    sh => {
      $('#e-type', sh).value = c.type;
      $('#e-cancel', sh).onclick = closeModal;
      $('#e-save', sh).onclick = async () => {
        const de = $('#e-de', sh).value.trim(), ku = $('#e-ku', sh).value.trim();
        if (!de || !ku) return toast('Bitte beide Seiten ausfüllen');
        unindexCard(c);
        Object.assign(c, { de, ku, type: $('#e-type', sh).value, updated: Date.now() });
        await saveCard(c);
        closeModal(); toast('Gespeichert'); after && after();
      };
      let armed = false;
      $('#e-del', sh).onclick = async e => {
        if (!armed) { armed = true; e.target.textContent = 'Wirklich löschen?'; return; }
        await deleteCard(c); closeModal(); toast('Karte gelöscht');
        if (sess) sess.q = sess.q.filter((x, i) => i <= sess.idx || x.c !== c);
        after && after();
      };
    });
}

/* ---------- Ansicht: Dialog ---------- */
const TOPICS = ['Freies Gespräch über den Alltag', 'Sich vorstellen, Familie & Herkunft', 'Übersetzungsübung Deutsch → Kurmancî',
  'Grammatik: Präsens & Verbkonjugation', 'Grammatik: Vergangenheit & Ergativ', 'Grammatik: Ezafe & Possessiv',
  'Grammatik: Obliquus & Präpositionen', 'Grammatik: Fragen & Verneinung', 'Grammatik: Imperativ & Futur'];
let DLG = { active: false };
let PZ = null;
function pickVocab() {
  const words = [...S.cards.values()].filter(c => c.type === 'word');
  const learned = shuffle(words.filter(c => Math.max(c.dk.lvl, c.kd.lvl) >= 1)), fresh = shuffle(words.filter(c => Math.max(c.dk.lvl, c.kd.lvl) < 1));
  return [...learned.slice(0, 70), ...fresh.slice(0, 20)];
}
function dialogSystem(topic, level, extra, vocab) {
  return `Du bist ein geduldiger, freundlicher Kurmanji-Lehrer (Nordkurdisch, lateinisches Hawar-Alphabet mit ê, î, û, ç, ş) für einen deutschsprachigen Lernenden.
Niveau des Lernenden: ${level}. Übungsform/Thema: ${topic}.${extra ? ' Zusätzlicher Wunsch: ' + extra : ''}
Wortschatz des Lernenden (Grundformen, Deutsch = Kurmanji):
${vocab.length ? vocab.map(c => `${c.de} = ${c.ku}`).join('\n') : '(noch leer – verwende sehr einfachen Grundwortschatz)'}

Regeln:
- Bilde deine Sätze überwiegend aus diesem Wortschatz und beuge die Wörter grammatisch korrekt (Ezafe, Rectus/Obliquus, Verbkonjugation, Ergativ bei transitiven Verben in der Vergangenheit, Präpositionen/Zirkumpositionen usw.). Wörter außerhalb des Wortschatzes nur sparsam und dann in "new_words" (Grundform) auflisten.
- Führe einen echten Dialog bzw. eine Übung: stelle pro Antwort genau EINE Frage oder Aufgabe, auf die der Lernende auf Kurmanji antworten soll. Passe die Schwierigkeit an das Niveau und an seine bisherigen Antworten an.
- Prüfe jede Antwort des Lernenden genau. Lobe Richtiges kurz. Bei Fehlern: nenne in "corrected" die korrigierte Fassung und erkläre in "grammar" die betroffene Grammatik kurz, konkret und verständlich auf Deutsch (mit Mini-Beispiel).
- Bei einer Übersetzungsübung steht der zu übersetzende deutsche Satz in "task".
- Stellt der Lernende eine Frage auf Deutsch (z.B. „Was heißt …?“ oder zur Grammatik), beantworte sie in "feedback" und setze dann die Übung fort.

Antworte AUSSCHLIESSLICH mit einem JSON-Objekt ohne Markdown:
{"feedback":"Rückmeldung auf Deutsch (beim Start leer)","corrected":"korrigierte Fassung oder leer","grammar":"Grammatik-Erklärung oder leer","message_ku":"deine nächste Äußerung/Frage auf Kurmanji","message_de":"deutsche Übersetzung davon","task":"konkrete Aufgabe oder leer","hint":"Beispiel, wie man antworten könnte (Kurmanji) oder leer","new_words":[{"de":"…","ku":"…"}]}`;
}
function viewDialog(m) {
  if (PZ) return renderPuzzle(m);
  if (DLG.active) return renderChat(m);
  const hasKey = hasAI(), nWords = [...S.cards.values()].filter(c => c.type === 'word').length;
  m.innerHTML = `
    <div class="card">
      <h2>💬 Dialog mit KI-Lehrer</h2>
      ${hasKey ? `<p class="hint">Der Lehrer bildet Sätze aus deinen ${nWords} Wort-Karten, beugt sie grammatisch richtig, korrigiert deine Antworten und erklärt die Grammatik.</p>
        <label>Übungsform / Thema</label><select id="d-topic">${TOPICS.map(t => `<option>${esc(t)}</option>`).join('')}</select>
        <label>Niveau</label><select id="d-level"><option>Anfänger</option><option>Grundkenntnisse</option><option>Fortgeschritten</option></select>
        <label>Eigener Wunsch (optional)</label><input id="d-extra" placeholder="z.B. Gespräch beim Einkaufen, nur kurze Sätze …">
        <button class="btn big" id="d-start" style="margin-top:14px">Dialog starten</button>`
      : `<p>Für den Dialog-Modus braucht die App einen <b>kostenlosen KI-Schlüssel</b> (z.B. von Google Gemini), weil die Sätze und Korrekturen von einer KI erzeugt werden. Die Anleitung steht in den Einstellungen.</p>
        <button class="btn" id="d-set">Schlüssel eintragen</button>`}
    </div>
    <div class="card">
      <h2>🧩 Satz-Puzzle (offline)</h2>
      <p class="hint">Bringe die Wörter deiner gespeicherten Kurmancî-Sätze in die richtige Reihenfolge – gut für den Satzbau.</p>
      <button class="btn ghost" id="d-puzzle" style="width:100%">Puzzle starten</button>
    </div>`;
  $('#d-set') && ($('#d-set').onclick = openSettings);
  $('#d-start') && ($('#d-start').onclick = () => startDialog($('#d-topic').value, $('#d-level').value, $('#d-extra').value.trim()));
  $('#d-puzzle').onclick = startPuzzle;
}
async function startDialog(topic, level, extra) {
  DLG = { active: true, topic, messages: [], log: [], busy: false, system: dialogSystem(topic, level, extra, pickVocab()) };
  show('dialog');
  await sendDialog('Bitte beginne die Übung.', true);
}
function renderChat(m) {
  m.innerHTML = `
    <div class="chat-head"><span>${esc(DLG.topic)}</span><button class="link" id="d-end">✕ Beenden</button></div>
    <div class="chat" id="d-log"></div>
    <div class="composer">
      <textarea id="d-in" rows="2" ${NOAC} placeholder="Antwort auf Kurmancî (oder Frage auf Deutsch)…"></textarea>
      ${charBar('d-in')}
      <div class="row"><button class="btn" id="d-send">Senden</button></div>
    </div>`;
  $('#d-end').onclick = () => { DLG = { active: false }; show('dialog'); };
  const send = () => { const t = $('#d-in').value.trim(); if (!t || DLG.busy) return; $('#d-in').value = ''; sendDialog(t, false); };
  $('#d-send').onclick = send;
  $('#d-in').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  renderChatLog();
}
function tutorHtml(d, i) {
  let h = '';
  if (d.feedback || d.corrected || d.grammar)
    h += `<div class="fb">${d.feedback ? `<p>${esc(d.feedback)}</p>` : ''}${d.corrected ? `<p class="corr">✔ ${esc(d.corrected)}</p>` : ''}${d.grammar ? `<p>📘 ${esc(d.grammar)}</p>` : ''}</div>`;
  const nw = (Array.isArray(d.new_words) ? d.new_words : []).filter(w => w && w.de && w.ku);
  h += `<div class="bubble tutor">${d.task ? `<div class="task">${esc(d.task)}</div>` : ''}${d.message_ku ? `<div class="ku">${esc(d.message_ku)}</div>` : ''}
    ${d.message_de ? `<details><summary>Übersetzung</summary>${esc(d.message_de)}</details>` : ''}
    ${d.hint ? `<details><summary>Hilfe zur Antwort</summary>${esc(d.hint)}</details>` : ''}
    ${nw.length ? `<div class="nw">${nw.map((w, j) => `<button data-nw="${i}:${j}">${findDup(w.de, w.ku, 'word') ? '✓' : '+'} ${esc(w.ku)} = ${esc(w.de)}</button>`).join('')}</div>` : ''}</div>`;
  return h;
}
function renderChatLog() {
  const el = $('#d-log'); if (!el) return;
  el.innerHTML = DLG.log.map((e, i) => (e.role === 'user' ? `<div class="bubble user">${esc(e.text)}</div>` : tutorHtml(e.data, i))).join('') +
    (DLG.busy ? '<div class="spinner"></div>' : '');
  $$('[data-nw]', el).forEach(b => (b.onclick = async () => {
    const [i, j] = b.dataset.nw.split(':').map(Number), w = DLG.log[i].data.new_words[j];
    if (findDup(w.de, w.ku, 'word')) return toast('Schon vorhanden');
    await saveCard(makeCard(w.de, w.ku, 'word', Date.now()));
    b.textContent = `✓ ${w.ku} = ${w.de}`; toast('Als Karte gespeichert');
  }));
  $('#d-send') && ($('#d-send').disabled = DLG.busy);
  window.scrollTo(0, document.body.scrollHeight);
}
async function sendDialog(text, hidden) {
  if (DLG.busy) return;
  DLG.busy = true;
  DLG.messages.push({ role: 'user', content: text });
  if (!hidden) DLG.log.push({ role: 'user', text });
  renderChatLog();
  try {
    const M = DLG.messages;
    const msgs = M.length > 15 ? [M[0], M[1], ...M.slice(-13)] : M; // Verlauf begrenzen (Kosten)
    const t = await llm(DLG.system, msgs, 1500);
    let data;
    try { data = parseJSON(t); } catch { data = { message_ku: t }; }
    DLG.messages.push({ role: 'assistant', content: t });
    DLG.log.push({ role: 'tutor', data });
  } catch (e) {
    DLG.messages.pop();
    if (!hidden) { DLG.log.pop(); $('#d-in') && ($('#d-in').value = text); }
    toast(e.message, 4000);
    if (hidden && !DLG.log.length) { DLG = { active: false }; DLG.busy = false; return show('dialog'); }
  }
  DLG.busy = false;
  if (current === 'dialog') renderChatLog();
}

/* Satz-Puzzle */
function startPuzzle() {
  const ph = [...S.cards.values()].filter(c => c.type === 'phrase' && c.ku.trim().split(/\s+/).length >= 2);
  if (!ph.length) return toast('Lege zuerst ein paar Sätze an');
  shuffle(ph).sort((a, b) => cardLevel(a) - cardLevel(b));
  const c = ph[Math.floor(Math.random() * Math.max(1, Math.ceil(ph.length * 0.4)))];
  let toks = c.ku.trim().split(/\s+/).map((t, i) => ({ t, i }));
  let pool = shuffle([...toks]);
  if (toks.length > 2) for (let k = 0; k < 5 && pool.every((p, i) => p.i === i); k++) pool = shuffle(pool);
  PZ = { c, pool, ans: [], checked: false };
  show('dialog');
}
function renderPuzzle(m) {
  const { c } = PZ;
  m.innerHTML = `<div class="card">
    <div class="chat-head" style="margin:0"><span>🧩 Satz-Puzzle</span><button class="link" id="pz-end">✕ Beenden</button></div>
    <div class="qprompt long" style="text-align:center;margin:14px 0">${esc(c.de)}</div>
    <div class="pz-zone" id="pz-ans">${PZ.ans.map((x, i) => `<button class="pz-chip" data-a="${i}">${esc(x.t)}</button>`).join('')}</div>
    <div class="pz-zone" style="border-style:solid" id="pz-pool">${PZ.pool.map((x, i) => `<button class="pz-chip" data-p="${i}">${esc(x.t)}</button>`).join('')}</div>
    <div id="pz-res"></div>
    <div class="row"><button class="btn ghost" id="pz-next">Nächster Satz</button><button class="btn" id="pz-check">Prüfen</button></div></div>`;
  $('#pz-end').onclick = () => { PZ = null; show('dialog'); };
  $('#pz-next').onclick = startPuzzle;
  $$('[data-p]', m).forEach(b => (b.onclick = () => { PZ.ans.push(PZ.pool.splice(+b.dataset.p, 1)[0]); renderPuzzle(m); }));
  $$('[data-a]', m).forEach(b => (b.onclick = () => { PZ.pool.push(PZ.ans.splice(+b.dataset.a, 1)[0]); renderPuzzle(m); }));
  $('#pz-check').onclick = () => {
    const ok = norm(PZ.ans.map(x => x.t).join(' ')) === norm(c.ku);
    $('#pz-res').innerHTML = ok ? '<div class="res ok">✓ Richtig!</div>' : `<div class="res bad">✗ Noch nicht</div><div class="expected">${esc(c.ku)}</div>`;
  };
}

/* ---------- Einstellungen ---------- */
function readKeys(sh) {
  const keys = {};
  for (const p of ORDER) keys[p] = $('#k-' + p, sh).value.trim();
  for (const p of ORDER) if (keys[p] !== S.settings.keys[p]) delete S.settings.models[p];
  S.settings.keys = keys;
}
async function testProviders(out) {
  const lines = [];
  for (const p of ORDER) {
    if (!S.settings.keys[p]) continue;
    out.innerHTML = lines.join('<br>') + `<br>Teste ${PROVIDERS[p].name} …`;
    let ok = null, last = '';
    try {
      for (const m of await modelsFor(p)) {
        try { parseJSON(await callProvider(p, m, 'Antworte nur mit JSON.', [{ role: 'user', content: 'Gib {"ok":true} zurück.' }], 50)); ok = m; break; }
        catch (e) { last = errText(e); if (e.status === 401 || e.status === 403) break; }
      }
    } catch (e) { last = errText(e); }
    lines.push(ok ? `✅ ${PROVIDERS[p].name}: funktioniert (${esc(ok)})` : `❌ ${PROVIDERS[p].name}: ${esc(last)}`);
  }
  out.innerHTML = lines.length ? lines.join('<br>') : 'Kein Schlüssel eingetragen.';
}
function openSettings() {
  const st = S.settings, k = st.keys;
  const keyField = (p, ph, desc) => `<label>${PROVIDERS[p].name} <small>${desc}</small></label><input id="k-${p}" type="password" value="${esc(k[p])}" placeholder="${ph}" ${NOAC}>`;
  modal(`<h2>Einstellungen</h2>
    <h3 style="margin-top:6px">KI-Schlüssel (kostenlos)</h3>
    <p class="hint">Mit einem kostenlosen Schlüssel werden Übersetzungen besser (mit Grundformen bei Sätzen) und der Dialog-Modus funktioniert. Du brauchst nur einen. Mehrere sind besser: Ist bei einem das Tageslimit erreicht, springt automatisch der nächste ein. Ohne Schlüssel übersetzt die App über Google Übersetzer.</p>
    ${keyField('gemini', 'AIza…', '– empfohlen · aistudio.google.com/apikey')}
    ${keyField('groq', 'gsk_…', '– Reserve · console.groq.com/keys')}
    ${keyField('openrouter', 'sk-or-…', '– Reserve · openrouter.ai/keys')}
    <details style="margin-top:8px"><summary class="hint">Kostenpflichtig (optional, nicht nötig)</summary>${keyField('claude', 'sk-ant-…', '– Claude · console.anthropic.com')}</details>
    <div class="row"><button class="btn ghost" id="s-test">Schlüssel testen</button></div>
    <div id="s-test-out" class="hint"></div>
    <p class="hint">Heute ${S.daily.ai || 0} KI-Anfragen. Die Schlüssel bleiben nur auf diesem Gerät.</p>
    <div class="grid2">
      <div><label>Neue Karten pro Tag</label><input id="s-new" type="number" min="0" max="500" value="${st.newPerDay}"></div>
      <div><label>Karten pro Sitzung</label><input id="s-size" type="number" min="5" max="500" value="${st.sessionSize}"></div>
    </div>
    <div class="row"><button class="btn" id="s-save">Speichern</button></div>
    <h3>Datensicherung</h3>
    <p class="hint">Deine Karten sind nur auf diesem Gerät gespeichert. Exportiere ab und zu eine Sicherung (landet im Download-Ordner).</p>
    <div class="row"><button class="btn ghost" id="s-exp">Exportieren</button><button class="btn ghost" id="s-imp">Importieren</button></div>
    <input type="file" id="s-file" accept="application/json,.json" hidden>
    <p class="hint" id="s-persist"></p>
    <h3>So funktioniert das Lernen</h3>
    <p class="hint">Jede Karte wird in beide Richtungen abgefragt, jede Richtung hat ihre eigene Stufe (0–7). Neue Karten kommen zuerst als Kurmancî → Deutsch, die andere Richtung folgt ein paar Tage später. Beide Richtungen werden nie am selben Tag abgefragt.<br>
    <b>Richtig</b> → eine Stufe höher. Nächste Abfrage nach ${INTERVALS.slice(1).join(', ')} Tagen (Stufe 1–7).<br>
    <b>Falsch</b> → zurück auf Stufe 0 (ab Stufe 4 nur auf Stufe 2). Die Karte kommt in derselben Sitzung nach ein paar anderen Karten noch einmal.<br>
    Fällige Wiederholungen kommen vor neuen Karten. So wächst der tägliche Aufwand nicht ins Unendliche.</p>`,
    async sh => {
      $('#s-test', sh).onclick = async () => { readKeys(sh); await setMeta('settings', S.settings); testProviders($('#s-test-out', sh)); };
      $('#s-save', sh).onclick = async () => {
        readKeys(sh);
        S.settings.newPerDay = Math.max(0, parseInt($('#s-new', sh).value) || 0);
        S.settings.sessionSize = Math.max(5, parseInt($('#s-size', sh).value) || 40);
        await setMeta('settings', S.settings);
        closeModal(); toast('Einstellungen gespeichert'); show(current);
      };
      $('#s-exp', sh).onclick = exportData;
      $('#s-imp', sh).onclick = () => $('#s-file', sh).click();
      $('#s-file', sh).onchange = async e => {
        const f = e.target.files[0]; if (!f) return;
        try { const r = await importData(f); toast(`Import: ${r.added} neu, ${r.skipped} übersprungen (doppelt)`, 4000); closeModal(); show(current); }
        catch (err) { toast('Import fehlgeschlagen: ' + err.message, 4000); }
      };
      try {
        const p = await navigator.storage?.persisted?.();
        const est = await navigator.storage?.estimate?.();
        $('#s-persist', sh).textContent = `${S.cards.size} Karten · ${p ? 'dauerhafter Speicher aktiv ✓' : 'Speicher nicht als dauerhaft markiert'}${est ? ' · ' + (est.usage / 1048576).toFixed(1) + ' MB belegt' : ''}`;
      } catch { }
    });
}
function exportData() {
  const data = { app: 'kurmanci', version: 1, exported: new Date().toISOString(), cards: [...S.cards.values()].map(({ _s, ...c }) => c) };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.download = `kurmanci-sicherung-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
async function importData(file) {
  const data = JSON.parse(await file.text());
  const list = Array.isArray(data) ? data : data.cards || [];
  let added = 0, skipped = 0;
  const tx = db.transaction('cards', 'readwrite'), st = tx.objectStore('cards'), local = new Set(), fresh = [];
  for (const raw of list) {
    if (!raw || !raw.de || !raw.ku) continue;
    const type = raw.type === 'phrase' ? 'phrase' : 'word';
    const c = { de: String(raw.de), ku: String(raw.ku), type, created: raw.created || Date.now(), updated: raw.updated || Date.now(), dk: { ...newSrs(), ...raw.dk }, kd: { ...newSrs(), ...raw.kd } };
    const [a, b] = keysOf(c);
    if (findDup(c.de, c.ku, type) || local.has('d' + a) || local.has('k' + b)) { skipped++; continue; }
    local.add('d' + a); local.add('k' + b);
    const r = st.add(c);
    r.onsuccess = () => { c.id = r.result; fresh.push(c); };
    added++;
  }
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  fresh.forEach(indexCard);
  persist();
  return { added, skipped };
}

/* ---------- Start ---------- */
const VIEWS = { learn: viewLearn, add: viewAdd, dialog: viewDialog, cards: viewCards };
function show(view) {
  current = view;
  $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.v === view));
  const m = $('#main'); m.innerHTML = '';
  VIEWS[view](m);
  if (view !== 'dialog') window.scrollTo(0, 0);
}
(async function init() {
  try { db = await openDB(); await loadState(); }
  catch (e) { $('#main').innerHTML = `<div class="card">Fehler beim Öffnen der Datenbank: ${esc(e.message)}</div>`; return; }
  $$('.tabs button').forEach(b => (b.onclick = () => show(b.dataset.v)));
  $('#btn-settings').onclick = openSettings;
  document.addEventListener('visibilitychange', () => { if (!document.hidden && current === 'learn' && !sess) show('learn'); });
  show('learn');
  persist();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
})();
