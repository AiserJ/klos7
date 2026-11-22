/* KLOS7 — V1
 * Garde-robe de tenues stockée localement (IndexedDB) + suggestions selon la météo (Open-Meteo).
 */
'use strict';

const APP_VERSION = '1.0.0';
// Lien vers ton formulaire de retours (Google Form, Tally…). Laisse vide pour masquer le bouton.
const FEEDBACK_URL = '';

/* =========================================================
   Tags prédéfinis
   ========================================================= */
const TAGS = {
  temp: [
    { id: 'froid', label: 'Froid', hint: '< 8°' },
    { id: 'frais', label: 'Frais', hint: '8–15°' },
    { id: 'doux', label: 'Doux', hint: '15–22°' },
    { id: 'chaud', label: 'Chaud', hint: '> 22°' },
  ],
  style: [
    { id: 'street', label: 'Streetwear' },
    { id: 'casual', label: 'Casual' },
    { id: 'chic', label: 'Chic' },
    { id: 'sport', label: 'Sport' },
  ],
  occasion: [
    { id: 'quotidien', label: 'Quotidien' },
    { id: 'travail', label: 'Travail' },
    { id: 'soiree', label: 'Soirée' },
    { id: 'weekend', label: 'Week-end' },
  ],
};
const GROUP_LABEL = { temp: 'Température', style: 'Style', occasion: 'Occasion' };
const BUCKETS = TAGS.temp.map(t => t.id); // froid → chaud
const TAG_LABEL = {};
Object.values(TAGS).flat().forEach(t => { TAG_LABEL[t.id] = t.label; });

/* =========================================================
   Utilitaires
   ========================================================= */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayStr = () => ymd(new Date());
const tomorrowStr = () => { const d = new Date(); d.setDate(d.getDate() + 1); return ymd(d); };
const parseYmd = s => { const [a, b, c] = s.split('-').map(Number); return new Date(a, b - 1, c); };
const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
const fmtLong = s => parseYmd(s).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtShort = s => parseYmd(s).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const fmtSize = b => b < 1024 * 1024 ? `${Math.round(b / 1024)} Ko` : `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`;
const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* =========================================================
   Stockage local (IndexedDB)
   ========================================================= */
let dbPromise;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open('klos7', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('outfits')) d.createObjectStore('outfits', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbPromise;
}
function run(storeName, mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const tx = d.transaction(storeName, mode);
    const req = fn(tx.objectStore(storeName));
    let result;
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}
const Outfits = {
  all: () => run('outfits', 'readonly', s => s.getAll()),
  put: o => run('outfits', 'readwrite', s => s.put(o)),
  del: id => run('outfits', 'readwrite', s => s.delete(id)),
  clear: () => run('outfits', 'readwrite', s => s.clear()),
};
const KV = {
  get: k => run('kv', 'readonly', s => s.get(k)),
  set: (k, v) => run('kv', 'readwrite', s => s.put(v, k)),
  clear: () => run('kv', 'readwrite', s => s.clear()),
};

// URLs d'images (Blob → objectURL), mises en cache pour éviter les fuites mémoire
const urlCache = new Map();
function imgURL(o, kind = 'thumb') {
  const blob = o[kind] || o.image;
  if (!blob) return '';
  const k = `${o.id}:${kind}`;
  if (!urlCache.has(k)) urlCache.set(k, URL.createObjectURL(blob));
  return urlCache.get(k);
}
function dropURLs(id) {
  for (const [k, u] of urlCache) if (k.startsWith(id + ':')) { URL.revokeObjectURL(u); urlCache.delete(k); }
}

/* =========================================================
   Compression des photos
   ========================================================= */
const IMG_MAX = 1280, IMG_Q = 0.78;
const THUMB_MAX = 420, THUMB_Q = 0.7;

async function loadImage(file) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* repli ci-dessous */ }
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    const u = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(u); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(u); reject(new Error('image illisible')); };
    img.src = u;
  });
}
function resizeTo(src, max, quality) {
  const w = src.width, h = src.height;
  const scale = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return new Promise((resolve, reject) => c.toBlob(b => b ? resolve(b) : reject(new Error('compression impossible')), 'image/jpeg', quality));
}
async function compressPhoto(file) {
  const src = await loadImage(file);
  const [image, thumb] = await Promise.all([resizeTo(src, IMG_MAX, IMG_Q), resizeTo(src, THUMB_MAX, THUMB_Q)]);
  if (src.close) src.close();
  return { image, thumb, originalSize: file.size };
}

/* =========================================================
   Météo (Open-Meteo, gratuit, sans clé)
   ========================================================= */
const WX_LABEL = {
  0: 'Ensoleillé', 1: 'Plutôt dégagé', 2: 'Partiellement nuageux', 3: 'Couvert',
  45: 'Brouillard', 48: 'Brouillard givrant',
  51: 'Bruine légère', 53: 'Bruine', 55: 'Bruine dense', 56: 'Bruine verglaçante', 57: 'Bruine verglaçante',
  61: 'Pluie faible', 63: 'Pluie', 65: 'Forte pluie', 66: 'Pluie verglaçante', 67: 'Pluie verglaçante',
  71: 'Neige faible', 73: 'Neige', 75: 'Forte neige', 77: 'Grains de neige',
  80: 'Averses', 81: 'Averses', 82: 'Fortes averses', 85: 'Averses de neige', 86: 'Averses de neige',
  95: 'Orage', 96: 'Orage et grêle', 99: 'Orage et grêle',
};
function wxKind(c) {
  if (c === 0) return 'sun';
  if (c <= 2) return 'partly';
  if (c === 3) return 'cloud';
  if (c === 45 || c === 48) return 'fog';
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'snow';
  if (c >= 95) return 'storm';
  if ((c >= 51 && c <= 67) || (c >= 80 && c <= 82)) return 'rain';
  return 'cloud';
}
function wxIcon(code) {
  const cloud = '<path d="M7 19h10.5a4.5 4.5 0 0 0 .6-8.96A6 6 0 0 0 6.6 9.6 4.75 4.75 0 0 0 7 19z"/>';
  const k = wxKind(code);
  const inner = {
    sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
    partly: '<path d="M9 3v1.4M3.6 5.4l1 1M2 10.5h1.4M14.4 5.4l-1 1"/><path d="M5.6 11.3A3.8 3.8 0 0 1 12.4 8"/><path d="M9 20h8.5a3.8 3.8 0 0 0 .5-7.56A5 5 0 0 0 8.6 12 4 4 0 0 0 9 20z"/>',
    cloud,
    rain: '<path d="M7 15.5h10.5a4.2 4.2 0 0 0 .6-8.36A5.6 5.6 0 0 0 6.6 6.4 4.4 4.4 0 0 0 7 15.5z"/><path d="M8 18.5l-1 2.5M12 18.5l-1 2.5M16 18.5l-1 2.5"/>',
    snow: '<path d="M7 15.5h10.5a4.2 4.2 0 0 0 .6-8.36A5.6 5.6 0 0 0 6.6 6.4 4.4 4.4 0 0 0 7 15.5z"/><path d="M8 19h.01M12 20h.01M16 19h.01M10 22h.01M14 22h.01"/>',
    storm: '<path d="M7 15.5h10.5a4.2 4.2 0 0 0 .6-8.36A5.6 5.6 0 0 0 6.6 6.4 4.4 4.4 0 0 0 7 15.5z"/><path d="M12.5 15.5L10.5 19h3l-2 3.5"/>',
    fog: '<path d="M4 9h16M3 13h18M5 17h14"/>',
  }[k];
  return `<svg class="wx-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}
function bucketFor(feels) {
  if (feels >= 22) return 'chaud';
  if (feels >= 15) return 'doux';
  if (feels >= 8) return 'frais';
  return 'froid';
}
const ADVICE = {
  froid: 'Grosse couche : manteau, superpositions, bonnet si besoin.',
  frais: 'Une veste ou un bon sweat, ça passe.',
  doux: 'Une couche légère suffit.',
  chaud: 'Léger et respirant.',
};

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
function weatherURL(loc) {
  const p = new URLSearchParams({
    latitude: loc.lat.toFixed(4),
    longitude: loc.lon.toFixed(4),
    current: 'temperature_2m,apparent_temperature,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_probability_max',
    timezone: 'auto',
    forecast_days: '3',
  });
  return `https://api.open-meteo.com/v1/forecast?${p}`;
}
const locKey = loc => `${loc.lat.toFixed(3)},${loc.lon.toFixed(3)}`;

async function loadWeather(force = false) {
  if (!state.loc) return;
  const key = locKey(state.loc);
  const cached = await KV.get('weather');
  if (cached && cached.key === key) {
    state.weather = cached.data;
    state.weatherAt = cached.at;
    if (!force && Date.now() - cached.at < 30 * 60 * 1000) { state.weatherStatus = 'ok'; render(); return; }
  }
  state.weatherStatus = 'loading';
  render();
  try {
    const data = await fetchJSON(weatherURL(state.loc));
    state.weather = data;
    state.weatherAt = Date.now();
    state.weatherStatus = 'ok';
    await KV.set('weather', { key, at: state.weatherAt, data });
  } catch (e) {
    state.weatherStatus = state.weather ? 'stale' : 'error';
  }
  render();
}

function dayInfo(offset) {
  const w = state.weather;
  if (!w || !w.daily) return null;
  const date = offset === 0 ? todayStr() : tomorrowStr();
  const i = w.daily.time.indexOf(date);
  if (i < 0) return null;
  const D = w.daily;
  const amax = D.apparent_temperature_max[i], amin = D.apparent_temperature_min[i];
  const feels = 0.6 * amax + 0.4 * amin; // pondéré vers la journée
  const code = D.weather_code[i];
  const pp = D.precipitation_probability_max[i] ?? 0;
  const kind = wxKind(code);
  return {
    date, code, kind,
    label: WX_LABEL[code] || '—',
    tmax: D.temperature_2m_max[i], tmin: D.temperature_2m_min[i],
    feels, pp,
    bucket: bucketFor(feels),
    rainy: pp >= 50 || kind === 'rain' || kind === 'storm' || kind === 'snow',
    current: offset === 0 && w.current ? w.current : null,
  };
}

/* =========================================================
   Moteur de suggestion
   ========================================================= */
function lastWornBefore(o, date) {
  const past = (o.worn || []).filter(d => d < date).sort();
  return past.length ? past[past.length - 1] : null;
}
function rankOutfits(list, d, occasion, date) {
  return list.map(o => {
    let s = 0;
    const reasons = [];
    const temps = o.tags.temp || [];

    if (d) {
      const feels = Math.round(d.feels);
      const target = BUCKETS.indexOf(d.bucket);
      if (temps.includes(d.bucket)) {
        s += 10;
        reasons.push(`Parfaite pour un temps ${TAG_LABEL[d.bucket].toLowerCase()} (${feels}° ressentis)`);
      } else if (temps.some(t => Math.abs(BUCKETS.indexOf(t) - target) === 1)) {
        s += 4;
        reasons.push(`Proche du temps prévu (${feels}° ressentis) : ajuste avec une couche`);
      } else {
        s -= 10;
        reasons.push(`Pas idéale pour ${feels}° ressentis, mais c'est la plus proche`);
      }
      if (d.rainy) {
        if (o.tags.rain) { s += 5; reasons.push('Résiste à la pluie annoncée'); }
        else { s -= 3; reasons.push('Pluie annoncée : prévois une veste imperméable et évite le daim'); }
      }
    }

    if (occasion !== 'all') {
      if ((o.tags.occasion || []).includes(occasion)) { s += 8; reasons.push(`Taguée ${TAG_LABEL[occasion]}`); }
      else s -= 6;
    }

    const last = lastWornBefore(o, date);
    if (!last) { s += 8; reasons.push('Jamais portée : c\'est le moment'); }
    else {
      const days = daysBetween(last, date);
      s += Math.min(days, 30) / 3;
      if (days < 3) s -= 8;
      reasons.push(days >= 14 ? `Pas portée depuis ${days} jours` : `Portée il y a ${plural(days, 'jour')}`);
    }

    s += Math.random() * 2.5; // un peu de variété
    return { o, s, reasons };
  }).sort((a, b) => b.s - a.s);
}

/* =========================================================
   État de l'app
   ========================================================= */
const state = {
  tab: 'today',
  outfits: [],
  loc: null,
  weather: null,
  weatherAt: 0,
  weatherStatus: 'idle',
  day: new Date().getHours() >= 18 ? 1 : 0, // le soir, on prépare demain
  occasion: 'all',
  suggestion: null,  // { id, date, reasons }
  skipped: [],
  filters: { temp: null, style: null, occasion: null },
  cityResults: [],
  draft: null,
};
const selectedDate = () => (state.day === 0 ? todayStr() : tomorrowStr());

/* =========================================================
   Rendu
   ========================================================= */
function render() {
  $('#topDate').textContent = new Date().toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
  for (const t of ['today', 'closet', 'settings']) $(`#view-${t}`).hidden = state.tab !== t;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === state.tab));
  if (state.tab === 'today') renderToday();
  if (state.tab === 'closet') renderCloset();
  if (state.tab === 'settings') renderSettings();
}

function chip(label, on, attrs, hint = '') {
  return `<button class="chip ${on ? 'on' : ''}" ${attrs}>${esc(label)}${hint ? ` <small>${esc(hint)}</small>` : ''}</button>`;
}
function tagsHTML(o) {
  const t = [...(o.tags.temp || []), ...(o.tags.style || []), ...(o.tags.occasion || [])].map(id => `<span class="tag">${esc(TAG_LABEL[id])}</span>`);
  if (o.tags.rain) t.push('<span class="tag">Pluie OK</span>');
  return `<div class="tags">${t.join('')}</div>`;
}

/* ---------- Localisation ---------- */
function citySearchHTML() {
  return `
    <input class="input city-input" type="search" placeholder="Rechercher une ville…" autocomplete="off" enterkeyhint="search">
    <div class="city-results"></div>`;
}
function locationPromptHTML() {
  return `
    <div class="card" style="margin-top:8px">
      <h2 class="h-display" style="font-size:24px">Où es-tu&nbsp;?</h2>
      <p class="muted" style="margin:8px 0 14px">KLOS7 a besoin de ta ville pour la météo. Rien n'est envoyé ailleurs qu'au service météo.</p>
      <button class="btn block" data-act="geo">Me localiser</button>
      <div class="label">ou choisis une ville</div>
      ${citySearchHTML()}
    </div>`;
}

/* ---------- Aujourd'hui ---------- */
function weatherHTML(d) {
  if (!state.weather && state.weatherStatus === 'loading') {
    return `<div class="wx wx-skeleton"><div class="spinner"></div></div>`;
  }
  if (!d) {
    return `<div class="card"><p style="margin:0 0 12px">Impossible de récupérer la météo pour le moment.</p><button class="btn ghost" data-act="retry-wx">Réessayer</button></div>`;
  }
  const big = d.current ? Math.round(d.current.temperature_2m) : Math.round(d.tmax);
  const advice = ADVICE[d.bucket] + (d.rainy ? ' <strong>Pluie probable : pense aux pièces qui ne craignent pas l\'eau.</strong>' : '');
  const stale = state.weatherStatus === 'stale'
    ? `<div class="wx-stale">Hors ligne · météo du ${new Date(state.weatherAt).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>` : '';
  return `
    <div class="wx">
      <div class="wx-top">
        <div>
          <div class="wx-temp">${big}<small>°</small></div>
          <div class="wx-label">${esc(d.label)}</div>
          <div class="wx-place">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z"/></svg>
            ${esc(state.loc.name)} · ${state.day === 0 ? 'maintenant' : 'demain'}
          </div>
        </div>
        ${wxIcon(d.code)}
      </div>
      <div class="wx-stats">
        <div class="wx-stat"><b>${Math.round(d.tmin)}° / ${Math.round(d.tmax)}°</b><span>Min / max</span></div>
        <div class="wx-stat"><b>${Math.round(d.feels)}°</b><span>Ressenti</span></div>
        <div class="wx-stat"><b>${Math.round(d.pp)}%</b><span>Pluie</span></div>
      </div>
      <div class="wx-advice">${advice}</div>
      ${stale}
    </div>`;
}

function outfitCardHTML(o, { badge, reasons, actions }) {
  return `
    <div class="outfit-card">
      <div class="ph">
        <img src="${imgURL(o, 'image')}" alt="Tenue">
        ${badge ? `<span class="badge">${esc(badge)}</span>` : ''}
      </div>
      <div class="body">
        ${tagsHTML(o)}
        ${o.note ? `<div class="note">${esc(o.note)}</div>` : ''}
        ${reasons && reasons.length ? `<ul class="reasons">${reasons.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
        ${actions}
      </div>
    </div>`;
}

function renderToday() {
  const el = $('#view-today');
  if (!state.loc) { el.innerHTML = locationPromptHTML(); return; }

  const d = dayInfo(state.day);
  const date = selectedDate();
  const isTomorrow = state.day === 1;
  const evening = new Date().getHours() >= 18;
  let html = `
    <div class="seg">
      <button class="seg-btn ${state.day === 0 ? 'on' : ''}" data-act="day" data-day="0">Aujourd'hui</button>
      <button class="seg-btn ${state.day === 1 ? 'on' : ''}" data-act="day" data-day="1">Demain</button>
    </div>`;
  if (isTomorrow && evening) {
    html += `<div class="banner">🌙 Ce soir, prépare ta tenue de demain&nbsp;: ${esc(fmtLong(date))}.</div>`;
  }
  html += weatherHTML(d);

  html += `<div class="label">Occasion</div><div class="chips scroll">
    ${chip('Toutes', state.occasion === 'all', 'data-act="occ" data-v="all"')}
    ${TAGS.occasion.map(t => chip(t.label, state.occasion === t.id, `data-act="occ" data-v="${t.id}"`)).join('')}
  </div>`;

  const chosen = state.outfits.find(o => (o.worn || []).includes(date));
  const sug = state.suggestion && state.suggestion.date === date ? state.outfits.find(o => o.id === state.suggestion.id) : null;

  if (state.outfits.length === 0) {
    html += `
      <div class="empty">
        <div class="h-display">Garde-robe vide</div>
        <p>Ajoute tes premières tenues en photo, KLOS7 s'occupe du reste.</p>
        <button class="btn" data-act="add">Ajouter une tenue</button>
      </div>`;
  } else if (sug) {
    html += outfitCardHTML(sug, {
      badge: isTomorrow ? 'Pour demain' : 'Suggestion',
      reasons: state.suggestion.reasons,
      actions: `<div class="btn-row">
        <button class="btn" data-act="wear" data-id="${sug.id}">${isTomorrow ? 'Je la prépare' : 'Je la porte'}</button>
        <button class="btn soft" data-act="another">Une autre</button>
      </div>`,
    });
  } else if (chosen) {
    html += outfitCardHTML(chosen, {
      badge: isTomorrow ? 'Prête pour demain' : 'Tenue du jour',
      reasons: [],
      actions: `<div class="btn-row"><button class="btn ghost" data-act="change" data-id="${chosen.id}">Changer de tenue</button></div>`,
    });
  } else {
    html += `
      <button class="inspire" data-act="inspire">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/></svg>
        Inspire-moi
      </button>
      <div class="inspire-sub">${plural(state.outfits.length, 'tenue')} dans ta garde-robe</div>`;
  }
  el.innerHTML = html;
}

/* ---------- Garde-robe ---------- */
function renderCloset() {
  const el = $('#view-closet');
  const f = state.filters;
  const list = state.outfits
    .filter(o => (!f.temp || o.tags.temp.includes(f.temp)) && (!f.style || o.tags.style.includes(f.style)) && (!f.occasion || o.tags.occasion.includes(f.occasion)))
    .sort((a, b) => b.created - a.created);

  let html = `<div class="closet-head"><h1 class="section-title">Garde-robe</h1><span class="count">${plural(list.length, 'tenue')}</span></div>`;
  if (state.outfits.length === 0) {
    html += `<div class="empty"><div class="h-display">Rien ici… pour l'instant</div><p>Prends ta tenue du jour en photo pour commencer.</p><button class="btn" data-act="add">Ajouter une tenue</button></div>`;
    el.innerHTML = html;
    return;
  }
  html += `<div class="filters">${['temp', 'style', 'occasion'].map(g => `
    <div class="chips scroll">${TAGS[g].map(t => chip(t.label, f[g] === t.id, `data-act="filter" data-g="${g}" data-v="${t.id}"`)).join('')}</div>`).join('')}
  </div>`;
  if (list.length === 0) {
    html += `<div class="empty"><p>Aucune tenue ne correspond à ces filtres.</p><button class="btn ghost" data-act="clear-filters">Effacer les filtres</button></div>`;
  } else {
    const today = todayStr();
    html += `<div class="grid">${list.map(o => `
      <button data-act="open" data-id="${o.id}" aria-label="Voir la tenue">
        <img src="${imgURL(o, 'thumb')}" alt="" loading="lazy">
        ${(o.worn || []).includes(today) ? '<span class="worn-dot">Auj.</span>' : ''}
      </button>`).join('')}</div>`;
  }
  el.innerHTML = html;
}

/* ---------- Réglages ---------- */
async function renderSettings() {
  const el = $('#view-settings');
  const totalBytes = state.outfits.reduce((n, o) => n + (o.image?.size || 0) + (o.thumb?.size || 0), 0);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  el.innerHTML = `
    <h1 class="section-title">Réglages</h1>

    <div class="card">
      <div class="label" style="margin-top:0">Localisation</div>
      <div class="set-row"><b>${state.loc ? esc(state.loc.name) : 'Non définie'}</b><button class="btn soft" data-act="geo" style="min-height:40px">Me localiser</button></div>
      <div style="margin-top:12px">${citySearchHTML()}</div>
    </div>

    <div class="card">
      <div class="label" style="margin-top:0">Stockage sur ce téléphone</div>
      <div class="set-row"><span>${plural(state.outfits.length, 'tenue')}</span><b>${fmtSize(totalBytes)}</b></div>
      <div class="small muted" id="quota" style="margin-top:6px"></div>
    </div>

    <div class="card">
      <div class="label" style="margin-top:0">Sauvegarde</div>
      <p class="small muted" style="margin:0 0 12px">Tes tenues ne sont stockées que sur ce téléphone. Exporte régulièrement une sauvegarde (iCloud Drive, Fichiers…) pour ne rien perdre.</p>
      <div class="btn-row" style="margin-top:0">
        <button class="btn" data-act="export">Exporter</button>
        <button class="btn ghost" data-act="import">Importer</button>
      </div>
    </div>

    ${isStandalone ? '' : `
    <div class="card">
      <div class="label" style="margin-top:0">Installer KLOS7</div>
      <ol class="steps">
        <li><b>iPhone</b> : dans Safari, touche <b>Partager</b> puis <b>Sur l'écran d'accueil</b>.</li>
        <li><b>Android</b> : dans Chrome, menu ⋮ puis <b>Installer l'application</b>.</li>
      </ol>
    </div>`}

    ${FEEDBACK_URL ? `
    <div class="card">
      <div class="label" style="margin-top:0">Version de test</div>
      <p class="small muted" style="margin:0 0 12px">Un bug, une idée ? Ton avis fait avancer KLOS7.</p>
      <a class="btn block" href="${esc(FEEDBACK_URL)}" target="_blank" rel="noopener" style="text-decoration:none">Donner mon avis</a>
    </div>` : ''}

    <div class="card">
      <div class="label" style="margin-top:0">Zone sensible</div>
      <button class="btn danger block" data-act="wipe">Effacer toutes mes données</button>
    </div>

    <p class="small muted" style="text-align:center;margin-top:18px">KLOS7 v${APP_VERSION} · Météo : Open-Meteo.com</p>`;

  if (navigator.storage && navigator.storage.estimate) {
    try {
      const { usage, quota } = await navigator.storage.estimate();
      const q = $('#quota');
      if (q && quota) q.textContent = `Espace utilisé par l'app : ${fmtSize(usage || 0)} sur ${fmtSize(quota)} disponibles`;
    } catch (e) { /* ignore */ }
  }
}

/* =========================================================
   Feuilles (détail / éditeur)
   ========================================================= */
function openSheet(html) {
  const s = $('#sheet');
  s.querySelector('.sheet-panel').innerHTML = `<div class="sheet-grip"></div>${html}`;
  s.hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeSheet() {
  $('#sheet').hidden = true;
  document.body.style.overflow = '';
  if (state.draft?.previewURL) URL.revokeObjectURL(state.draft.previewURL);
  state.draft = null;
}

function openDetail(id) {
  const o = state.outfits.find(x => x.id === id);
  if (!o) return;
  const worn = (o.worn || []).slice().sort();
  const today = todayStr();
  const wornToday = worn.includes(today);
  const past = worn.filter(d => d <= today);
  openSheet(`
    <div class="sheet-head"><h2 class="h-display">Tenue</h2><button class="icon-btn" data-act="close-sheet" aria-label="Fermer">✕</button></div>
    <img class="detail-img" src="${imgURL(o, 'image')}" alt="Tenue">
    <div style="margin-top:12px">${tagsHTML(o)}</div>
    ${o.note ? `<div class="note">${esc(o.note)}</div>` : ''}
    <div class="meta muted">
      <span>Ajoutée le ${esc(fmtShort(ymd(new Date(o.created))))}</span>
      <span>${past.length ? `Portée ${past.length} fois · dernière fois le ${esc(fmtShort(past[past.length - 1]))}` : 'Jamais portée'}</span>
    </div>
    <button class="btn block" style="margin-top:16px" data-act="toggle-today" data-id="${o.id}">${wornToday ? 'Retirer de la tenue du jour' : 'Je la porte aujourd\'hui'}</button>
    <div class="btn-row">
      <button class="btn soft" data-act="edit" data-id="${o.id}">Modifier</button>
      <button class="btn danger" data-act="delete" data-id="${o.id}">Supprimer</button>
    </div>`);
}

function openEditor(id) {
  const o = id ? state.outfits.find(x => x.id === id) : null;
  state.draft = o
    ? { ...o, tags: { temp: [...o.tags.temp], style: [...o.tags.style], occasion: [...o.tags.occasion], rain: !!o.tags.rain }, isNew: false }
    : { id: uid(), created: Date.now(), worn: [], note: '', image: null, thumb: null, tags: { temp: [], style: [], occasion: [], rain: false }, isNew: true };
  renderEditor();
}
function renderEditor() {
  const d = state.draft;
  if (!d) return;
  const preview = d.previewURL || (d.image && !d.isNew ? imgURL(d, 'image') : '');
  const group = g => `
    <div class="label">${GROUP_LABEL[g]}${g === 'temp' ? ' <span style="text-transform:none;letter-spacing:0">· pour quel temps ?</span>' : ''}</div>
    <div class="chips">${TAGS[g].map(t => chip(t.label, d.tags[g].includes(t.id), `data-act="ed-chip" data-g="${g}" data-v="${t.id}"`, t.hint || '')).join('')}</div>`;

  const panel = `
    <div class="sheet-head"><h2 class="h-display">${d.isNew ? 'Nouvelle tenue' : 'Modifier'}</h2><button class="icon-btn" data-act="close-sheet" aria-label="Fermer">✕</button></div>
    <button class="photo-zone" data-act="ed-photo">
      ${d.busy ? '<div class="spinner"></div>' : preview
        ? `<img src="${preview}" alt="Aperçu"><span class="photo-change">Changer la photo</span>`
        : `<div class="ph-hint">
             <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.5"/></svg>
             <b>Ajouter la photo</b><span class="small muted">Appareil photo ou galerie</span>
           </div>`}
    </button>
    ${d.sizeInfo ? `<div class="photo-size">${esc(d.sizeInfo)}</div>` : ''}
    ${group('temp')}
    <div class="label">Pluie</div>
    <button class="switch-row" data-act="ed-rain" style="width:100%">
      <span style="text-align:left"><b>Résiste à la pluie</b><br><span class="small muted">Imper, sneakers qui ne craignent pas l'eau…</span></span>
      <span class="switch ${d.tags.rain ? 'on' : ''}"></span>
    </button>
    ${group('style')}
    ${group('occasion')}
    <div class="label">Note (optionnel)</div>
    <textarea class="input" id="edNote" rows="2" maxlength="200" placeholder="Ex. AF1 blanches, cargo noir, veste en jean">${esc(d.note)}</textarea>
    <button class="btn block" style="margin-top:18px" data-act="ed-save" ${d.busy ? 'disabled' : ''}>${d.isNew ? 'Enregistrer la tenue' : 'Enregistrer'}</button>`;

  const s = $('#sheet');
  const panelEl = s.querySelector('.sheet-panel');
  if (s.hidden) openSheet(panel);
  else { const top = panelEl.scrollTop; panelEl.innerHTML = `<div class="sheet-grip"></div>${panel}`; panelEl.scrollTop = top; }
}

async function handlePhoto(file) {
  const d = state.draft;
  if (!d || !file) return;
  d.busy = true; renderEditor();
  try {
    const { image, thumb, originalSize } = await compressPhoto(file);
    if (d.previewURL) URL.revokeObjectURL(d.previewURL);
    d.image = image; d.thumb = thumb; d.imageChanged = true;
    d.previewURL = URL.createObjectURL(image);
    d.sizeInfo = `Compressée : ${fmtSize(originalSize)} → ${fmtSize(image.size + thumb.size)}`;
  } catch (e) {
    toast('Impossible de lire cette photo');
  }
  d.busy = false; renderEditor();
}

async function saveDraft() {
  const d = state.draft;
  if (!d) return;
  d.note = ($('#edNote')?.value || '').trim();
  if (!d.image) { toast('Ajoute une photo de la tenue'); return; }
  if (!d.tags.temp.length) { toast('Choisis au moins une température'); return; }
  const o = { id: d.id, created: d.created, image: d.image, thumb: d.thumb, note: d.note, worn: d.worn || [], tags: d.tags };
  try {
    await Outfits.put(o);
  } catch (e) {
    toast('Enregistrement impossible : espace insuffisant ?');
    return;
  }
  if (d.imageChanged) dropURLs(o.id);
  const i = state.outfits.findIndex(x => x.id === o.id);
  if (i >= 0) state.outfits[i] = o; else state.outfits.push(o);
  const wasNew = d.isNew;
  closeSheet();
  toast(wasNew ? 'Tenue ajoutée à ta garde-robe' : 'Tenue mise à jour');
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  render();
}

/* =========================================================
   Actions
   ========================================================= */
function inspire() {
  const date = selectedDate();
  const d = dayInfo(state.day);
  let pool = state.outfits.filter(o => !state.skipped.includes(o.id));
  if (!pool.length) {
    state.skipped = [];
    pool = state.outfits.slice();
    toast('Tu as fait le tour, on recommence !');
  }
  const [best] = rankOutfits(pool, d, state.occasion, date);
  if (!best) return;
  state.suggestion = { id: best.o.id, date, reasons: best.reasons };
  render();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function setWorn(id, date, on) {
  const o = state.outfits.find(x => x.id === id);
  if (!o) return;
  const set = new Set(o.worn || []);
  if (on) {
    // une seule tenue par jour
    for (const other of state.outfits) {
      if (other.id !== id && (other.worn || []).includes(date)) {
        other.worn = other.worn.filter(x => x !== date);
        await Outfits.put(other);
      }
    }
    set.add(date);
  } else set.delete(date);
  o.worn = [...set].sort();
  await Outfits.put(o);
}

async function geolocate() {
  if (!navigator.geolocation) { toast('Localisation non disponible, cherche ta ville'); return; }
  toast('Localisation en cours…');
  navigator.geolocation.getCurrentPosition(async pos => {
    await setLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude, name: 'Ma position' });
  }, () => toast('Localisation refusée : cherche ta ville à la place'), { enableHighAccuracy: false, timeout: 12000, maximumAge: 600000 });
}
async function setLocation(loc) {
  state.loc = loc;
  state.cityResults = [];
  await KV.set('loc', loc);
  state.suggestion = null;
  if (state.tab === 'settings') toast(`Localisation : ${loc.name}`);
  await loadWeather(true);
}

let cityTimer;
function onCityInput(input) {
  clearTimeout(cityTimer);
  const q = input.value.trim();
  const box = input.parentElement.querySelector('.city-results');
  if (q.length < 2) { box.innerHTML = ''; return; }
  cityTimer = setTimeout(async () => {
    try {
      const data = await fetchJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=fr&format=json`);
      state.cityResults = data.results || [];
      box.innerHTML = state.cityResults.length
        ? state.cityResults.map((r, i) => `<button data-act="pick-city" data-i="${i}">${esc(r.name)}<small>${esc([r.admin1, r.country].filter(Boolean).join(', '))}</small></button>`).join('')
        : '<div class="small muted">Aucune ville trouvée</div>';
    } catch (e) {
      box.innerHTML = '<div class="small muted">Recherche impossible (hors ligne ?)</div>';
    }
  }, 350);
}

/* ---------- Sauvegarde ---------- */
const blobToDataURL = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
const dataURLToBlob = u => fetch(u).then(r => r.blob());

async function exportData() {
  if (!state.outfits.length) { toast('Rien à exporter pour l\'instant'); return; }
  toast('Préparation de la sauvegarde…');
  const outfits = [];
  for (const o of state.outfits) {
    outfits.push({ ...o, image: await blobToDataURL(o.image), thumb: o.thumb ? await blobToDataURL(o.thumb) : null });
  }
  const json = JSON.stringify({ app: 'klos7', version: APP_VERSION, exportedAt: new Date().toISOString(), loc: state.loc, outfits });
  const name = `klos7-sauvegarde-${todayStr()}.json`;
  const file = new File([json], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Sauvegarde KLOS7' }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'klos7' || !Array.isArray(data.outfits)) throw new Error('format');
    let n = 0;
    for (const raw of data.outfits) {
      if (!raw.id || !raw.image) continue;
      const o = {
        id: raw.id,
        created: raw.created || Date.now(),
        note: raw.note || '',
        worn: Array.isArray(raw.worn) ? raw.worn : [],
        tags: { temp: raw.tags?.temp || [], style: raw.tags?.style || [], occasion: raw.tags?.occasion || [], rain: !!raw.tags?.rain },
        image: await dataURLToBlob(raw.image),
        thumb: raw.thumb ? await dataURLToBlob(raw.thumb) : null,
      };
      await Outfits.put(o);
      dropURLs(o.id);
      n++;
    }
    if (!state.loc && data.loc) { state.loc = data.loc; await KV.set('loc', data.loc); loadWeather(true); }
    state.outfits = await Outfits.all();
    toast(`${plural(n, 'tenue')} importée${n > 1 ? 's' : ''}`);
    render();
  } catch (e) {
    toast('Fichier de sauvegarde invalide');
  }
}

async function wipe() {
  if (!confirm('Effacer toutes tes tenues et réglages de ce téléphone ? Cette action est définitive.')) return;
  await Outfits.clear();
  await KV.clear();
  for (const id of state.outfits.map(o => o.id)) dropURLs(id);
  Object.assign(state, { outfits: [], loc: null, weather: null, suggestion: null, skipped: [], tab: 'today' });
  toast('Données effacées');
  render();
}

/* =========================================================
   Événements
   ========================================================= */
document.addEventListener('click', async e => {
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const { act, id } = t.dataset;
  switch (act) {
    case 'tab':
      state.tab = t.dataset.tab;
      if (state.tab !== 'settings') state.cityResults = [];
      render();
      window.scrollTo(0, 0);
      break;
    case 'add':
      openEditor();
      $('#fileInput').click(); // ouvre directement l'appareil photo / la galerie
      break;
    case 'day':
      state.day = Number(t.dataset.day);
      state.suggestion = null; state.skipped = [];
      render();
      break;
    case 'occ':
      state.occasion = t.dataset.v;
      if (state.suggestion) { state.skipped = []; inspire(); } else render();
      break;
    case 'inspire':
      state.skipped = [];
      inspire();
      break;
    case 'another':
      if (state.suggestion) state.skipped.push(state.suggestion.id);
      inspire();
      break;
    case 'wear': {
      const date = selectedDate();
      await setWorn(id, date, true);
      state.suggestion = null; state.skipped = [];
      toast(state.day === 1 ? 'Tenue de demain prête ✓' : 'Bonne journée, tenue validée ✓');
      render();
      break;
    }
    case 'change': {
      await setWorn(id, selectedDate(), false);
      state.skipped = [id];
      inspire();
      break;
    }
    case 'retry-wx':
      loadWeather(true);
      break;
    case 'geo':
      geolocate();
      break;
    case 'pick-city': {
      const r = state.cityResults[Number(t.dataset.i)];
      if (r) await setLocation({ lat: r.latitude, lon: r.longitude, name: r.name });
      break;
    }
    case 'filter': {
      const g = t.dataset.g;
      state.filters[g] = state.filters[g] === t.dataset.v ? null : t.dataset.v;
      render();
      break;
    }
    case 'clear-filters':
      state.filters = { temp: null, style: null, occasion: null };
      render();
      break;
    case 'open':
      openDetail(id);
      break;
    case 'close-sheet':
      closeSheet();
      break;
    case 'toggle-today': {
      const o = state.outfits.find(x => x.id === id);
      const on = !(o.worn || []).includes(todayStr());
      await setWorn(id, todayStr(), on);
      toast(on ? 'Tenue du jour enregistrée ✓' : 'Retirée de la tenue du jour');
      openDetail(id);
      render();
      break;
    }
    case 'edit':
      closeSheet();
      openEditor(id);
      break;
    case 'delete': {
      if (!confirm('Supprimer cette tenue ?')) return;
      await Outfits.del(id);
      dropURLs(id);
      state.outfits = state.outfits.filter(o => o.id !== id);
      if (state.suggestion?.id === id) state.suggestion = null;
      closeSheet();
      toast('Tenue supprimée');
      render();
      break;
    }
    case 'ed-photo':
      $('#fileInput').click();
      break;
    case 'ed-chip': {
      const arr = state.draft.tags[t.dataset.g];
      const i = arr.indexOf(t.dataset.v);
      if (i >= 0) arr.splice(i, 1); else arr.push(t.dataset.v);
      state.draft.note = $('#edNote')?.value ?? state.draft.note;
      renderEditor();
      break;
    }
    case 'ed-rain':
      state.draft.tags.rain = !state.draft.tags.rain;
      state.draft.note = $('#edNote')?.value ?? state.draft.note;
      renderEditor();
      break;
    case 'ed-save':
      saveDraft();
      break;
    case 'export':
      exportData();
      break;
    case 'import':
      $('#importInput').click();
      break;
    case 'wipe':
      wipe();
      break;
  }
});

document.addEventListener('input', e => {
  if (e.target.matches('.city-input')) onCityInput(e.target);
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet();
});
$('#fileInput').addEventListener('change', e => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (f) handlePhoto(f);
});
$('#importInput').addEventListener('change', e => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (f) importData(f);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.loc) {
    // au retour dans l'app : météo rafraîchie si elle a plus de 30 min
    if (Date.now() - state.weatherAt > 30 * 60 * 1000) loadWeather();
    else render();
  }
});

/* =========================================================
   Démarrage
   ========================================================= */
async function init() {
  try {
    state.outfits = (await Outfits.all()) || [];
    state.loc = (await KV.get('loc')) || null;
  } catch (e) {
    toast('Stockage local indisponible (navigation privée ?)');
  }
  render();
  if (state.loc) loadWeather();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
init();
