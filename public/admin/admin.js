// Gamer Xperience admin. A small single-page app with hash routes like #/bookings/<id>.
const TOKEN_KEY = 'gamerxp-admin-token';
const THEME_KEY = 'gxp-admin-theme';
const view = document.getElementById('view');
const notice = document.getElementById('notice');
const sidebar = document.getElementById('sidebar');
const topbar = document.getElementById('topbar');
const pageTitle = document.getElementById('page-title');
const topbarActions = document.getElementById('topbar-actions');

// Labels ------------------------------------------------------------------------

const STAGES = ['new', 'contacted', 'confirmed', 'deposit_paid', 'scheduled', 'party_held', 'completed'];
const STATUS_LABELS = {
  new: 'Nieuw', contacted: 'Contact opgenomen', confirmed: 'Bevestigd', deposit_paid: 'Aanbetaling ontvangen',
  scheduled: 'Ingepland', party_held: 'Feest geweest', completed: 'Afgerond', cancelled: 'Geannuleerd',
};
const STATUS_TONE = {
  new: 'warning', contacted: 'info', confirmed: 'primary', deposit_paid: 'success', scheduled: 'violet',
  party_held: 'violet', completed: '', cancelled: 'danger',
};
// Stages where the parent gets an email when the booking moves there.
const EMAIL_STAGES = new Set(['confirmed', 'deposit_paid', 'completed', 'cancelled']);
const SLOT_LABELS = { ochtend: 'Ochtend', middag: 'Middag', avond: 'Avond' };
const WAITING = {
  me: { label: 'Jouw beurt', tone: 'warning' },
  customer: { label: 'Wacht op klant', tone: 'info' },
  nobody: { label: 'Geen actie', tone: '' },
};
const CHANNELS = { website: 'Website', email: 'E-mail', whatsapp: 'WhatsApp', phone: 'Telefoon', in_person: 'Persoonlijk', other: 'Anders' };
const PAYMENT_KINDS = {
  deposit: 'Aanbetaling', payment: 'Betaling', refund: 'Terugbetaling',
  security_deposit: 'Borg ontvangen', security_deposit_returned: 'Borg terugbetaald',
};
const PAYMENT_METHODS = { bank: 'Overboeking', cash: 'Contant', tikkie: 'Tikkie', other: 'Anders' };
const REVIEW = {
  none: { label: 'Nog niet gevraagd', tone: '' },
  requested: { label: 'Gevraagd', tone: 'info' },
  received: { label: 'Ontvangen', tone: 'success' },
  declined: { label: 'Geen review', tone: '' },
};
const EVENT_ICONS = { created: '✨', status: '➡️', note: '📝', task: '☑️', email: '✉️', update: '✏️', payment: '💶', agreement: '🤝', message: '💬', review: '⭐' };
const WEEKDAYS = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag'];

// Formatting --------------------------------------------------------------------

const euro = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
const fmtEuro = (cents) => euro.format((cents ?? 0) / 100);
const fmtDate = (d) =>
  new Intl.DateTimeFormat('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${d}T00:00:00Z`));
const fmtLongDate = (d) =>
  new Intl.DateTimeFormat('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
const fmtDateTime = (d) => new Intl.DateTimeFormat('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(d));
const todayIso = () => new Date().toLocaleDateString('en-CA');
const daysUntil = (d) => Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${todayIso()}T00:00:00Z`)) / 86400000);
const parseEuro = (v) => Math.round(Number(String(v).replace(/[^\d,.-]/g, '').replace(',', '.')) * 100) || 0;
const euroInput = (cents) => ((cents ?? 0) / 100).toFixed(2).replace('.', ',');
const when = (b) => `${fmtDate(b.partyDate)} · ${b.startTime ?? SLOT_LABELS[b.timeSlot]}`;
const displayName = (b) => (b.childName ? `${b.childName}${b.childAge ? ` (${b.childAge})` : ''}` : b.parentName);
const isOpen = (b) => !['completed', 'cancelled'].includes(b.status);

// Storage and API ---------------------------------------------------------------

function storeTheme(value) {
  try { localStorage.setItem(THEME_KEY, value); } catch {}
}
function getToken() {
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}
function setToken(token) {
  try { token ? sessionStorage.setItem(TOKEN_KEY, token) : sessionStorage.removeItem(TOKEN_KEY); } catch {}
}

async function api(path, options = {}) {
  const res = await fetch(`/api/admin${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(getToken() ? { authorization: `Bearer ${getToken()}` } : {}),
    },
  });
  if (res.status === 401 && path !== '/login') {
    setToken(null);
    render();
    throw new Error('Sessie verlopen, log opnieuw in.');
  }
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `Fout ${res.status}`);
  return body;
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
const patchJson = (path, body) => api(path, { method: 'PATCH', body: JSON.stringify(body) });
const del = (path) => api(path, { method: 'DELETE' });

function flash(type, message) {
  notice.className = `toast ${type}`;
  notice.textContent = message;
  notice.hidden = false;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => (notice.hidden = true), type === 'error' ? 6000 : 3000);
}

// Runs an action, shows a message and re-renders. Used by most buttons and forms.
function action(fn, message) {
  return async (e) => {
    e?.preventDefault?.();
    try {
      const result = await fn(e);
      if (result === false) return;
      if (message) flash('ok', message);
      await render();
    } catch (err) {
      flash('error', err.message);
    }
  };
}

// Tiny element helper: h('td', { class: 'x', onclick }, 'text', childEl, [more])
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat(Infinity).filter((c) => c != null && c !== false).map((c) => (c instanceof Node ? c : String(c))));
  return el;
}

const badge = (text, tone = '') => h('span', { class: `badge ${tone}` }, text);
const statusBadge = (s) => badge(STATUS_LABELS[s] ?? s, STATUS_TONE[s]);
const waitingBadge = (w) => badge(WAITING[w]?.label ?? w, WAITING[w]?.tone);
const progressBar = (done, total) =>
  h('div', { class: 'progress', title: `${done} van ${total} taken klaar` },
    h('div', { class: 'progress-fill', style: `width: ${total ? Math.round((done / total) * 100) : 0}%` }));
const table = (headers, rows, empty = 'Niets gevonden.') =>
  rows.length
    ? h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, headers.map((t) => h('th', {}, t)))), h('tbody', {}, rows)))
    : h('p', { class: 'empty' }, empty);
const field = (label, input, hint) => h('div', { class: 'field' }, h('label', {}, label), input, hint && h('small', {}, hint));
const card = (title, ...children) =>
  h('section', { class: 'card' },
    title && (typeof title === 'string' ? h('div', { class: 'card-head' }, h('h2', {}, title)) : title),
    children);
const cardHead = (title, ...extra) => h('div', { class: 'card-head' }, h('h2', {}, title), h('div', { class: 'badges' }, extra));

function paymentBadges(b) {
  if (b.status === 'cancelled') return [];
  const out = [];
  if (b.depositPaid) out.push(badge('Aanbetaling ✓', 'success'));
  else if (['confirmed', 'deposit_paid', 'scheduled', 'party_held'].includes(b.status)) out.push(badge('Aanbetaling open', 'danger'));
  if (b.paidCents > 0 && b.outstandingCents > 0) out.push(badge(`Nog ${fmtEuro(b.outstandingCents)}`, 'warning'));
  if (b.outstandingCents === 0 && b.priceCents > 0) out.push(badge('Volledig betaald', 'success'));
  return out;
}

function dueBadge(b) {
  if (!isOpen(b)) return null;
  const days = daysUntil(b.partyDate);
  if (days < 0 && b.status !== 'party_held') return badge(`${-days} dagen geleden`, 'danger');
  if (days === 0) return badge('Vandaag!', 'danger');
  if (days > 0 && days <= 7) return badge(`over ${days} ${days === 1 ? 'dag' : 'dagen'}`, 'warning');
  return null;
}

// Moves a booking to another stage, asking whether to email the parent where relevant.
async function moveBooking(id, status) {
  const notifyCustomer = EMAIL_STAGES.has(status)
    ? confirm(`Naar "${STATUS_LABELS[status]}": de klant een e-mail sturen?\n\nOK = met e-mail, Annuleren = zonder e-mail`)
    : false;
  await patchJson(`/bookings/${id}`, { status, notifyCustomer });
  flash('ok', `Verplaatst naar "${STATUS_LABELS[status]}".`);
}

function setPage(title, ...actions) {
  pageTitle.textContent = title;
  topbarActions.replaceChildren(...actions.flat().filter(Boolean));
  document.title = `${title} · Gamer Xperience Admin`;
}

// Views -------------------------------------------------------------------------

function loginView() {
  sidebar.hidden = true;
  topbar.hidden = true;
  const form = document.getElementById('login-tpl').content.firstElementChild.cloneNode(true);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { token } = await api('/login', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
      setToken(token);
      render();
    } catch (err) {
      flash('error', err.message);
    }
  });
  view.replaceChildren(form);
}

async function boardView() {
  const [columns, o] = await Promise.all([api('/pipeline'), api('/overview')]);
  setPage('Pipeline', h('a', { class: 'btn', href: '#/calendar' }, 'Agenda'));

  const stat = (num, label, href, tone) =>
    h('a', { class: `stat ${num && num !== fmtEuro(0) ? tone : ''}`, href }, h('div', { class: 'num' }, num), h('div', { class: 'lbl' }, label));
  const bookingCard = (b, column) => {
    const i = STAGES.indexOf(column.key);
    const next = i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1] : null;
    return h('article', { class: `board-card ${b.waitingOn === 'me' && isOpen(b) ? 'me' : ''}` },
      h('a', { class: 'title', href: `#/bookings/${b.id}` }, displayName(b)),
      h('div', { class: 'meta' }, when(b)),
      h('div', { class: 'meta' }, `${b.city} · ${b.packageName}${b.extraStations ? ` +${b.extraStations}` : ''} · ${fmtEuro(b.priceCents)}`),
      h('div', { class: 'badges' }, isOpen(b) && waitingBadge(b.waitingOn), dueBadge(b), paymentBadges(b)),
      progressBar(b.tasksDone, b.tasksTotal),
      next && h('button', { class: 'btn small', onclick: action(() => moveBooking(b.id, next)) }, `→ ${STATUS_LABELS[next]}`));
  };

  view.replaceChildren(
    h('div', { class: 'stats' },
      stat(o.waitingOnMe, 'Boekingen: jouw beurt', '#/list?waitingOn=me', 'alert'),
      stat(o.messagesWaiting, 'Berichten te beantwoorden', '#/messages', 'alert'),
      stat(o.depositOpen, 'Aanbetaling nog open', '#/list?payment=deposit_open', 'warn'),
      stat(fmtEuro(o.outstandingCents), 'Nog te ontvangen', '#/list?payment=outstanding', ''),
      stat(o.nextSevenDays, 'Feestjes komende 7 dagen', '#/calendar', ''),
      stat(o.reviewsToRequest, 'Reviews te vragen', '#/reviews', 'warn'),
      stat(o.waitingOnCustomer, 'Wachten op klant', '#/list?waitingOn=customer', '')),
    h('div', { class: 'board' },
      columns.map((c) => h('section', { class: 'board-col' },
        h('header', {}, h('span', {}, c.label), h('span', { class: 'count' }, c.bookings.length)),
        c.bookings.length ? c.bookings.map((b) => bookingCard(b, c)) : h('p', { class: 'empty' }, '–')))),
    h('p', { class: 'muted small' }, 'Afgeronde en geannuleerde boekingen worden 30 dagen getoond. Alle boekingen staan onder "Boekingen".'),
  );
}

async function listView() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const keys = ['status', 'from', 'q', 'waitingOn', 'payment', 'review'];
  const query = new URLSearchParams(keys.filter((k) => params.get(k)).map((k) => [k, params.get(k)]));
  const bookings = await api(`/bookings?${query}`);
  setPage('Boekingen');

  const filter = (key, value) => {
    value ? params.set(key, value) : params.delete(key);
    location.hash = `#/list?${params}`;
  };
  const select = (key, options) => h('select', { onchange: (e) => filter(key, e.target.value) },
    Object.entries(options).map(([v, l]) => h('option', { value: v, selected: (params.get(key) ?? '') === v }, l)));

  view.replaceChildren(
    h('div', { class: 'toolbar' },
      field('Zoeken', h('input', { type: 'search', value: params.get('q') ?? '', placeholder: 'Naam, referentie, plaats…', onchange: (e) => filter('q', e.target.value) })),
      field('Fase', select('status', { '': 'Alle', ...STATUS_LABELS })),
      field('Beurt', select('waitingOn', { '': 'Alle', me: 'Jouw beurt', customer: 'Wacht op klant' })),
      field('Betaling', select('payment', { '': 'Alle', deposit_open: 'Aanbetaling open', outstanding: 'Nog niet volledig betaald' })),
      field('Vanaf datum', h('input', { type: 'date', value: params.get('from') ?? '', onchange: (e) => filter('from', e.target.value) })),
      params.toString() && h('a', { class: 'btn ghost', href: '#/list' }, 'Filters wissen')),
    table(['Datum', 'Klant', 'Plaats', 'Pakket', 'Fase', 'Beurt', 'Betaald', 'Taken'],
      bookings.map((b) => h('tr', { class: 'clickable', onclick: () => (location.hash = `#/bookings/${b.id}`) },
        h('td', { class: 'nowrap' }, when(b)),
        h('td', {}, h('strong', {}, displayName(b)), h('div', { class: 'muted small' }, b.parentName)),
        h('td', {}, b.city),
        h('td', {}, b.packageName),
        h('td', {}, statusBadge(b.status)),
        h('td', {}, isOpen(b) && waitingBadge(b.waitingOn)),
        h('td', { class: 'nowrap' }, `${fmtEuro(b.paidCents)} / ${fmtEuro(b.priceCents)}`, h('div', { class: 'badges' }, paymentBadges(b))),
        h('td', {}, progressBar(b.tasksDone, b.tasksTotal)))),
      'Geen boekingen gevonden.'),
  );
}

// Email templates for quick replies. {placeholders} are filled from the booking.
const TEMPLATES = {
  details: {
    label: 'Vraag naar details',
    subject: 'Je aanvraag bij Gamer Xperience ({ref})',
    body: 'Hoi {naam},\n\nBedankt voor je aanvraag voor {datum}! Om alles goed voor te bereiden heb ik nog een paar vragen:\n\n- Hoeveel kinderen komen er ongeveer?\n- In welke ruimte vindt het feest plaats (en is er een grote tafel)?\n- Zijn er favoriete games?\n\nLaat het me weten, dan zet ik je datum vast.',
  },
  quote: {
    label: 'Prijsopgave',
    subject: 'Prijsopgave voor je feest ({ref})',
    body: 'Hoi {naam},\n\nHierbij de prijsopgave voor {datum}:\n\n{prijsregels}\n\nTotaal: {totaal}\n\nOm de datum vast te zetten vragen we een aanbetaling van {aanbetaling}. Laat je weten of je akkoord bent?',
  },
  unavailable: {
    label: 'Datum niet beschikbaar',
    subject: 'Over je aanvraag voor {datum}',
    body: 'Hoi {naam},\n\nHelaas zijn we op {datum} al volgeboekt. Zou een andere datum ook kunnen? Op gamerxp.nl/reserveer zie je welke dagen nog vrij zijn.',
  },
  deposit: {
    label: 'Herinnering aanbetaling',
    subject: 'Herinnering aanbetaling ({ref})',
    body: 'Hoi {naam},\n\nWe hebben je aanbetaling van {aanbetaling} voor {datum} nog niet ontvangen. Zou je die binnen een paar dagen willen overmaken onder vermelding van {ref}? Daarna staat je feest definitief vast.',
  },
  final: {
    label: 'Laatste details voor het feest',
    subject: 'Bijna zover: je feest op {datum}',
    body: 'Hoi {naam},\n\nNog even en dan is het feest! Ik kom {aankomst} om alles op te bouwen (ongeveer 60 minuten).\n\nNog te betalen: {openstaand}. Dat kan vooraf via overboeking of contant op de dag zelf.\n\nTot snel!',
  },
};

function fillTemplate(text, b) {
  const vars = {
    naam: b.parentName.split(' ')[0],
    ref: b.reference,
    datum: `${fmtLongDate(b.partyDate)} (${(b.startTime ?? SLOT_LABELS[b.timeSlot]).toLowerCase()})`,
    prijsregels: b.priceLines.map((l) => `- ${l.label}: ${fmtEuro(l.amountCents)}`).join('\n'),
    totaal: fmtEuro(b.priceCents),
    aanbetaling: fmtEuro(b.depositCents),
    openstaand: fmtEuro(b.outstandingCents),
    aankomst: b.startTime ? `een uur voor ${b.startTime}` : 'een uur voor de start',
  };
  return text.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);
}

function messageThread(items) {
  if (!items.length) return h('p', { class: 'empty' }, 'Nog geen berichten.');
  return h('ul', { class: 'thread' }, items.map((c) => {
    const long = c.body.length > 400;
    const body = h('div', { class: `msg-body ${long ? 'clamped' : ''}`, title: long ? 'Klik om alles te tonen' : null }, c.body);
    if (long) body.addEventListener('click', () => body.classList.toggle('clamped'));
    return h('li', { class: `msg ${c.direction}` },
      h('div', { class: 'msg-meta' },
        badge(c.direction === 'in' ? `↓ ${CHANNELS[c.channel]}` : `↑ ${CHANNELS[c.channel]}`, c.direction === 'in' ? 'warning' : 'primary'),
        c.delivery === 'failed' && badge('Versturen mislukt', 'danger'),
        h('span', {}, `${fmtDateTime(c.createdAt)} · ${c.actor}`)),
      c.subject && h('div', { class: 'msg-subject' }, c.subject),
      body);
  }));
}

// Send an email, or log a WhatsApp message, call or email received elsewhere.
function composer({ booking, onSubmit, emailConfigured }) {
  let mode = 'email';
  const subject = h('input', { name: 'subject', maxlength: 200, placeholder: 'Onderwerp' });
  const body = h('textarea', { name: 'body', required: true, rows: 7, placeholder: 'Typ je bericht… (je ondertekening wordt bij e-mails automatisch toegevoegd)' });
  const direction = h('select', { name: 'direction' }, h('option', { value: 'in' }, 'Ontvangen van klant'), h('option', { value: 'out' }, 'Verstuurd aan klant'));
  const channel = h('select', { name: 'channel' }, ['whatsapp', 'phone', 'email', 'in_person', 'other'].map((c) => h('option', { value: c }, CHANNELS[c])));
  const templateSelect = booking && h('select', {
    'aria-label': 'Sjabloon',
    onchange: (e) => {
      const t = TEMPLATES[e.target.value];
      if (t) {
        subject.value = fillTemplate(t.subject, booking);
        body.value = fillTemplate(t.body, booking);
      }
      e.target.value = '';
    },
  }, h('option', { value: '' }, 'Sjabloon…'), Object.entries(TEMPLATES).map(([k, t]) => h('option', { value: k }, t.label)));

  const emailFields = h('div', { class: 'inline', style: 'margin-bottom:8px' }, h('div', { class: 'field', style: 'flex:1' }, subject), templateSelect && h('div', { class: 'field' }, templateSelect));
  const logFields = h('div', { class: 'row', hidden: true }, field('Richting', direction), field('Kanaal', channel));
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'E-mail versturen');
  const tabButtons = [
    h('button', { type: 'button', class: 'on', onclick: () => setMode('email') }, '✉ E-mail sturen'),
    h('button', { type: 'button', onclick: () => setMode('log') }, '✎ WhatsApp / telefoon vastleggen'),
  ];
  function setMode(m) {
    mode = m;
    tabButtons[0].classList.toggle('on', m === 'email');
    tabButtons[1].classList.toggle('on', m === 'log');
    emailFields.hidden = m !== 'email';
    logFields.hidden = m !== 'log';
    submit.textContent = m === 'email' ? 'E-mail versturen' : 'Opslaan in logboek';
  }
  return h('form', {
    onsubmit: action(() => onSubmit(mode === 'email'
      ? { direction: 'out', channel: 'email', subject: subject.value, body: body.value, send: true }
      : { direction: direction.value, channel: channel.value, body: body.value, send: false })),
  },
    h('div', { class: 'tabs' }, tabButtons), emailFields, logFields, h('div', { class: 'field' }, body),
    !emailConfigured && h('p', { class: 'muted small' }, 'Let op: e-mail (SMTP) is nog niet ingesteld. Berichten worden gelogd maar niet echt verstuurd.'),
    submit);
}

async function bookingDetailView(id) {
  const [b, me] = await Promise.all([api(`/bookings/${id}`), api('/me')]);
  const patch = (body, message) => action(() => patchJson(`/bookings/${id}`, body), message);
  const current = STAGES.indexOf(b.status);
  const statusLink = `${location.origin}/status?t=${encodeURIComponent(b.statusToken)}`;

  setPage(`${displayName(b)} · ${b.reference}`,
    h('a', { class: 'btn', href: '#/board' }, '← Pipeline'),
    h('button', { class: 'btn', onclick: async () => {
      try { await navigator.clipboard.writeText(statusLink); flash('ok', 'Statuslink gekopieerd.'); }
      catch { prompt('Statuslink voor de klant:', statusLink); }
    } }, 'Statuslink kopiëren'),
    b.status !== 'cancelled'
      ? h('button', { class: 'btn danger', onclick: action(() => moveBooking(id, 'cancelled')) }, 'Annuleren')
      : h('button', { class: 'btn', onclick: action(() => moveBooking(id, 'new')) }, 'Heropenen'));

  // Phase, whose turn, payment state.
  const turn = h('div', { class: 'segmented', title: 'Wie is er aan zet?' },
    Object.entries(WAITING).map(([k, w]) => h('button', {
      type: 'button', class: b.waitingOn === k ? 'on' : '', onclick: patch({ waitingOn: k }, `Gezet op "${w.label}".`),
    }, w.label)));
  const head = h('div', { class: 'detail-head' }, statusBadge(b.status), turn, dueBadge(b), paymentBadges(b));

  const stepper = h('ol', { class: 'stepper' },
    STAGES.map((s, i) => h('li', { class: b.status === 'cancelled' ? 'todo' : i < current ? 'done' : i === current ? 'current' : 'todo' },
      h('button', { type: 'button', disabled: s === b.status, onclick: action(() => moveBooking(id, s)) },
        h('span', { class: 'dot' }, i < current && b.status !== 'cancelled' ? '✓' : i + 1), h('span', {}, STATUS_LABELS[s])))));

  // Customer and party.
  const planForm = h('form', { class: 'inline', onsubmit: action(() => {
    const f = planForm.elements;
    return patchJson(`/bookings/${id}`, { partyDate: f.partyDate.value, timeSlot: f.timeSlot.value, startTime: f.startTime.value || null });
  }, 'Planning opgeslagen.') },
    field('Datum', h('input', { type: 'date', name: 'partyDate', value: b.partyDate, required: true })),
    field('Dagdeel', h('select', { name: 'timeSlot' }, Object.entries(SLOT_LABELS).map(([k, l]) => h('option', { value: k, selected: k === b.timeSlot }, l)))),
    field('Starttijd', h('input', { type: 'time', name: 'startTime', value: b.startTime ?? '' })),
    h('button', { class: 'btn', type: 'submit' }, 'Opslaan'));
  const phoneDigits = b.phone.replace(/\D/g, '').replace(/^0/, '31');
  const customer = card('Klant en feest',
    h('dl', { class: 'details' },
      h('dt', {}, 'Klant'), h('dd', {}, b.parentName),
      h('dt', {}, 'E-mail'), h('dd', {}, h('a', { href: `mailto:${b.email}` }, b.email)),
      h('dt', {}, 'Telefoon'), h('dd', {}, b.phone
        ? [h('a', { href: `tel:${b.phone.replace(/[^\d+]/g, '')}` }, b.phone), ' · ', h('a', { href: `https://wa.me/${phoneDigits}`, target: '_blank', rel: 'noopener' }, 'WhatsApp')]
        : '–'),
      h('dt', {}, 'Adres'), h('dd', {},
        h('a', { href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${b.street}, ${b.postalCode} ${b.city}`)}`, target: '_blank', rel: 'noopener' },
          `${b.street}, ${b.postalCode} ${b.city}`)),
      h('dt', {}, 'Wanneer'), h('dd', {}, `${fmtLongDate(b.partyDate)}, ${SLOT_LABELS[b.timeSlot].toLowerCase()}${b.startTime ? ` om ${b.startTime}` : ''}`),
      h('dt', {}, 'Pakket'), h('dd', {}, `${b.packageName}${b.extraStations ? ` + ${b.extraStations} extra station(s)` : ''}`),
      h('dt', {}, 'Jarige'), h('dd', {}, b.childName ? `${b.childName}${b.childAge ? `, wordt ${b.childAge}` : ''}` : '–'),
      h('dt', {}, 'Kinderen'), h('dd', {}, b.guestCount ?? '–'),
      h('dt', {}, 'Details'), h('dd', {}, b.notes || '–'),
      h('dt', {}, 'Aangevraagd'), h('dd', {}, fmtDateTime(b.createdAt))),
    h('h3', { style: 'margin-top:16px' }, 'Planning'),
    planForm);

  // Price calculator.
  const extrasBox = h('div', {});
  const addExtraRow = (e = { label: '', amountCents: 0 }) => {
    const row = h('div', { class: 'extra-row' },
      h('input', { name: 'extraLabel', value: e.label, placeholder: 'Omschrijving (bijv. extra uur, korting)', maxlength: 100 }),
      h('input', { name: 'extraAmount', value: euroInput(e.amountCents), inputmode: 'decimal', title: 'Negatief bedrag voor korting' }),
      h('button', { type: 'button', class: 'icon-btn', title: 'Verwijderen', onclick: () => row.remove() }, '✕'));
    extrasBox.append(row);
  };
  b.priceExtras.forEach(addExtraRow);
  const priceForm = h('form', { onsubmit: action(() => {
    const f = priceForm.elements;
    const labels = [...priceForm.querySelectorAll('[name=extraLabel]')];
    const amounts = [...priceForm.querySelectorAll('[name=extraAmount]')];
    return patchJson(`/bookings/${id}`, {
      extraStations: Number(f.extraStations.value),
      travelKm: f.travelKm.value === '' ? null : Number(f.travelKm.value.replace(',', '.')),
      eveningSurcharge: f.eveningSurcharge.checked,
      depositCents: parseEuro(f.deposit.value),
      priceExtras: labels.map((l, i) => ({ label: l.value.trim(), amountCents: parseEuro(amounts[i].value) })).filter((e) => e.label),
    });
  }, 'Prijs bijgewerkt.') },
    h('div', { class: 'row' },
      field('Extra gamestations', h('select', { name: 'extraStations' },
        [0, 1, 2].map((n) => h('option', { value: n, selected: n === b.extraStations }, n ? `+${n} (${fmtEuro(n * 2500)})` : 'Geen')))),
      field('Afstand enkele reis (km)', h('div', { class: 'inline' },
        h('input', { name: 'travelKm', value: b.travelKm ?? '', inputmode: 'decimal', style: 'width:90px' }),
        h('button', { type: 'button', class: 'btn small', onclick: action(() => post(`/bookings/${id}/distance`), 'Afstand berekend.') }, 'Bereken'))),
      field('Aanbetaling (€)', h('input', { name: 'deposit', value: euroInput(b.depositCents), inputmode: 'decimal' }))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'eveningSurcharge', checked: b.eveningSurcharge }), ' Avondtoeslag (eindtijd na 19:30)'),
    h('div', { class: 'label', style: 'margin:12px 0 6px' }, "Extra's en kortingen"),
    extrasBox,
    h('div', { class: 'inline' },
      h('button', { type: 'button', class: 'btn small', onclick: () => addExtraRow() }, '+ Regel'),
      h('button', { class: 'btn primary', type: 'submit', style: 'margin-left:auto' }, 'Prijs opslaan')));
  const priceCard = card('Prijsberekening',
    h('table', { class: 'price-table' },
      h('tbody', {}, b.priceLines.map((l) => h('tr', {}, h('td', {}, l.label), h('td', {}, fmtEuro(l.amountCents))))),
      h('tfoot', {}, h('tr', {}, h('td', {}, 'Totaal'), h('td', {}, fmtEuro(b.priceCents))))),
    h('details', { class: 'collapsible', style: 'margin-top:12px', open: b.travelKm === null },
      h('summary', {}, 'Prijs aanpassen'), h('div', { style: 'margin-top:10px' }, priceForm)));

  // Payments.
  const payForm = h('form', { class: 'inline', onsubmit: action(() => {
    const f = payForm.elements;
    return post(`/bookings/${id}/payments`, {
      kind: f.kind.value, amountCents: parseEuro(f.amount.value), method: f.method.value, paidOn: f.paidOn.value, note: f.note.value,
    });
  }, 'Betaling geregistreerd.') },
    field('Soort', h('select', { name: 'kind' }, Object.entries(PAYMENT_KINDS).map(([k, l]) => h('option', { value: k, selected: k === (b.depositPaid ? 'payment' : 'deposit') }, l)))),
    field('Bedrag (€)', h('input', { name: 'amount', required: true, inputmode: 'decimal', style: 'width:100px', value: euroInput(b.depositPaid ? b.outstandingCents : b.depositCents) })),
    field('Hoe', h('select', { name: 'method' }, Object.entries(PAYMENT_METHODS).map(([k, l]) => h('option', { value: k }, l)))),
    field('Datum', h('input', { type: 'date', name: 'paidOn', value: todayIso(), required: true })),
    field('Notitie', h('input', { name: 'note', maxlength: 500 })),
    h('button', { class: 'btn primary', type: 'submit' }, 'Toevoegen'));
  const paymentsCard = card('Betalingen',
    h('div', { class: 'money-summary' },
      h('div', {}, h('div', { class: 'lbl' }, 'Totaal'), h('div', { class: 'val' }, fmtEuro(b.priceCents))),
      h('div', {}, h('div', { class: 'lbl' }, 'Betaald'), h('div', { class: 'val' }, fmtEuro(b.paidCents))),
      h('div', {}, h('div', { class: 'lbl' }, `Aanbetaling (${fmtEuro(b.depositCents)})`), h('div', { class: 'val' }, b.depositPaid ? badge('Betaald ✓', 'success') : badge('Open', 'danger'))),
      h('div', {}, h('div', { class: 'lbl' }, 'Nog te betalen'), h('div', { class: 'val', style: `color:var(--${b.outstandingCents ? 'warning' : 'success'})` }, fmtEuro(b.outstandingCents))),
      b.securityDepositHeldCents > 0 && h('div', {}, h('div', { class: 'lbl' }, 'Borg in bezit'), h('div', { class: 'val' }, fmtEuro(b.securityDepositHeldCents)))),
    b.payments.length
      ? h('ul', { class: 'list-plain' }, b.payments.map((p) => h('li', {},
          h('span', {}, h('strong', {}, PAYMENT_KINDS[p.kind]), ` ${fmtEuro(p.amountCents)} · ${PAYMENT_METHODS[p.method]} · ${fmtDate(p.paidOn)}`, p.note && h('span', { class: 'muted' }, ` – ${p.note}`)),
          h('button', { class: 'icon-btn', title: 'Verwijderen', onclick: action(() => confirm('Deze betaling verwijderen?') ? del(`/bookings/${id}/payments/${p.id}`) : false, 'Betaling verwijderd.') }, '✕'))))
      : h('p', { class: 'muted' }, 'Nog geen betalingen.'),
    h('div', { style: 'margin-top:12px' }, payForm),
    b.depositPaid && ['new', 'contacted', 'confirmed'].includes(b.status) &&
      h('p', {}, h('button', { class: 'btn success', onclick: action(() => moveBooking(id, 'deposit_paid')) }, 'Aanbetaling is binnen → zet op "Aanbetaling ontvangen"')));

  // Agreements.
  const agreementForm = h('form', { class: 'inline', onsubmit: action(() => post(`/bookings/${id}/agreements`, { text: agreementForm.elements.text.value }), 'Afspraak toegevoegd.') },
    h('div', { class: 'field', style: 'flex:1' }, h('input', { name: 'text', required: true, maxlength: 1000, placeholder: 'Bijv. "Starttijd 14:00", "Fortnite + Minecraft", "Feest in de garage"' })),
    h('button', { class: 'btn', type: 'submit' }, 'Toevoegen'));
  const agreementsCard = card('Afspraken',
    b.agreements.length
      ? h('ul', { class: 'list-plain' }, b.agreements.map((a) => h('li', {},
          h('span', {}, '🤝 ', a.text, h('span', { class: 'muted small' }, ` · ${fmtDateTime(a.createdAt)}`)),
          h('button', { class: 'icon-btn', title: 'Verwijderen', onclick: action(() => del(`/bookings/${id}/agreements/${a.id}`), 'Afspraak verwijderd.') }, '✕'))))
      : h('p', { class: 'muted' }, 'Nog geen afspraken vastgelegd.'),
    h('div', { style: 'margin-top:10px' }, agreementForm));

  // Communication.
  const commCard = card(cardHead('Communicatie', isOpen(b) && waitingBadge(b.waitingOn)),
    composer({
      booking: b,
      emailConfigured: me.emailConfigured,
      onSubmit: async (msg) => {
        await post(`/bookings/${id}/messages`, msg);
        flash('ok', msg.send ? 'E-mail verstuurd.' : 'Bericht opgeslagen.');
      },
    }),
    messageThread(b.communications));

  // Checklist.
  const tasksByStage = STAGES.map((s) => ({ stage: s, tasks: b.tasks.filter((t) => t.stage === s) })).filter((g) => g.tasks.length);
  const newTask = h('form', { class: 'inline', style: 'margin-top:10px', onsubmit: action(() => post(`/bookings/${id}/tasks`, Object.fromEntries(new FormData(newTask))), 'Taak toegevoegd.') },
    h('select', { name: 'stage', style: 'width:auto' }, STAGES.map((s) => h('option', { value: s, selected: s === b.status }, STATUS_LABELS[s]))),
    h('input', { name: 'label', required: true, maxlength: 200, placeholder: 'Nieuwe taak…', style: 'flex:1;width:auto' }),
    h('button', { class: 'btn', type: 'submit' }, 'Toevoegen'));
  const checklist = card(cardHead('Checklist', h('span', { class: 'muted' }, `${b.tasksDone}/${b.tasksTotal}`)),
    progressBar(b.tasksDone, b.tasksTotal),
    tasksByStage.map((g) => h('div', { class: `task-group ${g.stage === b.status ? 'active' : ''}` },
      h('h3', {}, STATUS_LABELS[g.stage]),
      g.tasks.map((t) => h('label', { class: `task ${t.done ? 'is-done' : ''}` },
        h('input', { type: 'checkbox', checked: t.done, onchange: action(() => patchJson(`/bookings/${id}/tasks/${t.id}`, { done: !t.done })) }),
        h('span', {}, t.label),
        t.doneAt && h('small', {}, fmtDateTime(t.doneAt)))))),
    newTask);

  // Review.
  const reviewCard = ['party_held', 'completed'].includes(b.status) && card('Google review',
    h('div', { class: 'inline' },
      badge(REVIEW[b.reviewStatus].label, REVIEW[b.reviewStatus].tone),
      b.reviewRequestedAt && h('span', { class: 'muted small' }, `gevraagd op ${fmtDateTime(b.reviewRequestedAt)}`)),
    h('div', { class: 'inline', style: 'margin-top:10px' },
      b.reviewStatus !== 'received' && h('button', {
        class: 'btn primary', disabled: !me.reviewUrlConfigured,
        title: me.reviewUrlConfigured ? null : 'Stel eerst GOOGLE_REVIEW_URL in',
        onclick: action(() => post(`/bookings/${id}/review-request`), 'Reviewverzoek verstuurd.'),
      }, b.reviewStatus === 'requested' ? 'Opnieuw vragen' : 'Review vragen per e-mail'),
      b.reviewStatus !== 'received' && h('button', { class: 'btn', onclick: patch({ reviewStatus: 'received' }, 'Gemarkeerd als ontvangen.') }, '★ Review ontvangen'),
      b.reviewStatus === 'none' && h('button', { class: 'btn ghost', onclick: patch({ reviewStatus: 'declined' }, 'Opgeslagen.') }, 'Geen review')),
    !me.reviewUrlConfigured && h('p', { class: 'muted small' }, 'Tip: zet je Google-reviewlink in GOOGLE_REVIEW_URL, dan gaat die automatisch mee in de e-mail.'));

  // Timeline and internal notes.
  const noteForm = h('form', { class: 'inline', onsubmit: action(() => post(`/bookings/${id}/notes`, { message: noteForm.elements.message.value }), 'Notitie toegevoegd.') },
    h('div', { class: 'field', style: 'flex:1' }, h('input', { name: 'message', required: true, maxlength: 5000, placeholder: 'Interne notitie (alleen voor jou)' })),
    h('button', { class: 'btn', type: 'submit' }, 'Opslaan'));
  const eventText = (e) => {
    if (e.type === 'created') return 'Aanvraag ontvangen via de website';
    if (e.type === 'status') return `${STATUS_LABELS[e.fromStatus] ?? e.fromStatus} → ${STATUS_LABELS[e.toStatus] ?? e.toStatus}`;
    return e.message;
  };
  const timeline = card('Tijdlijn', noteForm,
    h('ol', { class: 'timeline', style: 'margin-top:12px' },
      b.events.map((e) => h('li', {},
        h('span', { class: 'ev-icon' }, EVENT_ICONS[e.type] ?? '•'),
        h('div', {}, h('div', { class: 'pre' }, eventText(e)), h('div', { class: 'muted small' }, `${fmtDateTime(e.createdAt)} · ${e.actor}`))))));

  view.replaceChildren(
    head,
    card(null, stepper),
    h('div', { class: 'detail-grid', style: 'margin-top:16px' },
      h('div', { class: 'stack' }, customer, priceCard, paymentsCard, agreementsCard),
      h('div', { class: 'stack' }, commCard, reviewCard, checklist, timeline)),
  );
}

async function messagesView(selectedId) {
  const [messages, me, selected] = await Promise.all([
    api('/messages'), api('/me'), selectedId ? api(`/messages/${selectedId}`) : null,
  ]);
  setPage('Berichten');

  const list = h('div', { class: 'card inbox-list' },
    messages.length
      ? messages.map((m) => h('a', { class: `inbox-item ${m.id === selected?.id ? 'active' : ''} ${m.handled ? 'handled' : ''}`, href: `#/messages/${m.id}` },
          h('div', { class: 'top' }, h('strong', {}, m.name), h('span', { class: 'muted small' }, fmtDateTime(m.lastMessageAt ?? m.createdAt))),
          h('div', { class: 'preview' }, m.message),
          h('div', { class: 'badges', style: 'margin-top:4px' }, m.handled ? badge('Afgehandeld', 'success') : waitingBadge(m.waitingOn))))
      : h('p', { class: 'empty' }, 'Nog geen berichten via het contactformulier.'));

  const detail = selected
    ? card(h('div', { class: 'card-head' },
        h('div', {}, h('h2', {}, selected.name), h('div', { class: 'muted small' },
          h('a', { href: `mailto:${selected.email}` }, selected.email), selected.phone ? ` · ${selected.phone}` : '')),
        h('div', { class: 'inline' },
          !selected.handled && waitingBadge(selected.waitingOn),
          h('button', { class: 'btn small', onclick: action(() => patchJson(`/messages/${selected.id}`, { handled: !selected.handled }), selected.handled ? 'Weer geopend.' : 'Afgehandeld.') },
            selected.handled ? 'Heropenen' : '✓ Afgehandeld'))),
        composer({
          emailConfigured: me.emailConfigured,
          onSubmit: async (msg) => {
            await post(`/messages/${selected.id}/replies`, msg);
            flash('ok', msg.send ? 'E-mail verstuurd.' : 'Bericht opgeslagen.');
          },
        }),
        messageThread(selected.communications))
    : card(null, h('p', { class: 'empty' }, 'Kies een bericht om te lezen en te beantwoorden.'));

  view.replaceChildren(h('div', { class: 'inbox' }, list, detail));
}

async function reviewsView() {
  const [received, requested, open, me] = await Promise.all([
    api('/bookings?review=received'), api('/bookings?review=requested'), api('/bookings?review=none'), api('/me'),
  ]);
  setPage('Reviews', h('a', { class: 'btn', href: 'https://business.google.com/reviews', target: '_blank', rel: 'noopener' }, 'Google-reviews bekijken ↗'));
  const rows = (list) => list.map((b) => h('tr', {},
    h('td', { class: 'nowrap' }, fmtDate(b.partyDate)),
    h('td', {}, h('a', { href: `#/bookings/${b.id}` }, displayName(b)), h('div', { class: 'muted small' }, b.parentName)),
    h('td', {}, b.city),
    h('td', {}, badge(REVIEW[b.reviewStatus].label, REVIEW[b.reviewStatus].tone), b.reviewRequestedAt && h('div', { class: 'muted small' }, fmtDateTime(b.reviewRequestedAt))),
    h('td', { class: 'right nowrap' },
      b.reviewStatus !== 'received' && h('button', { class: 'btn small primary', disabled: !me.reviewUrlConfigured, onclick: action(() => post(`/bookings/${b.id}/review-request`), 'Reviewverzoek verstuurd.') },
        b.reviewStatus === 'requested' ? 'Opnieuw vragen' : 'Vraag review'), ' ',
      b.reviewStatus !== 'received' && h('button', { class: 'btn small', onclick: action(() => patchJson(`/bookings/${b.id}`, { reviewStatus: 'received' }), 'Gemarkeerd als ontvangen.') }, '★ Ontvangen'))));
  const headers = ['Feest', 'Klant', 'Plaats', 'Review', ''];
  view.replaceChildren(
    !me.reviewUrlConfigured && h('div', { class: 'notice warn' },
      'Stel GOOGLE_REVIEW_URL in (in .env) met de reviewlink uit je Google Bedrijfsprofiel ("Reviews vragen"). Dan stuur je met één klik een reviewverzoek.'),
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('div', { class: 'num' }, received.length), h('div', { class: 'lbl' }, 'Reviews ontvangen')),
      h('div', { class: 'stat' }, h('div', { class: 'num' }, requested.length), h('div', { class: 'lbl' }, 'Gevraagd, nog niet ontvangen')),
      h('div', { class: `stat ${open.length ? 'warn' : ''}` }, h('div', { class: 'num' }, open.length), h('div', { class: 'lbl' }, 'Nog niet gevraagd'))),
    card('Nog vragen', table(headers, rows(open), 'Alle klanten na het feest zijn al gevraagd.')),
    card('Gevraagd', table(headers, rows(requested), 'Geen openstaande verzoeken.')),
    card('Ontvangen', table(headers, rows(received), 'Nog geen reviews gemarkeerd als ontvangen.')),
  );
}

async function availabilityView() {
  const [av, blocked, overrides] = await Promise.all([api('/availability'), api('/blocked-dates'), api('/availability/overrides')]);
  setPage('Beschikbaarheid', h('a', { class: 'btn', href: '#/calendar' }, 'Agenda bekijken'));
  const num = (name, value, min, max) => h('input', { type: 'number', name, value, min, max, required: true });

  const scheduleForm = h('form', { onsubmit: action(() => {
    const f = scheduleForm.elements;
    const weekly = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [d, Object.fromEntries(av.slots.map((s) => [s.key, f[`w${d}-${s.key}`].checked]))]));
    return api('/availability', { method: 'PUT', body: JSON.stringify({
      settings: {
        slotCapacity: Number(f.slotCapacity.value), dailyCapacity: Number(f.dailyCapacity.value),
        minLeadDays: Number(f.minLeadDays.value), maxAdvanceDays: Number(f.maxAdvanceDays.value),
      },
      slots: av.slots.map((s) => ({ key: s.key, start: f[`start-${s.key}`].value, end: f[`end-${s.key}`].value })),
      weekly,
    }) });
  }, 'Beschikbaarheid opgeslagen. De website toont dit direct.') },
    h('div', { class: 'table-wrap' }, h('table', { class: 'schedule' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), av.slots.map((s) => h('th', {}, `${s.label} (${s.start}–${s.end})`)))),
      h('tbody', {}, WEEKDAYS.map((name, i) => h('tr', {},
        h('th', {}, name),
        av.slots.map((s) => h('td', {}, h('input', { type: 'checkbox', name: `w${i + 1}-${s.key}`, checked: av.weekly[i + 1][s.key], 'aria-label': `${name} ${s.label}` })))))))),
    h('h3', { style: 'margin-top:16px' }, 'Tijden per dagdeel'),
    h('div', { class: 'row' }, av.slots.map((s) => field(s.label, h('div', { class: 'time-range' },
      h('input', { type: 'time', name: `start-${s.key}`, value: s.start, required: true }), '–',
      h('input', { type: 'time', name: `end-${s.key}`, value: s.end, required: true }))))),
    h('h3', {}, 'Capaciteit en boekingsperiode'),
    h('div', { class: 'row' },
      field('Feestjes per dagdeel', num('slotCapacity', av.settings.slotCapacity, 1, 10), 'Hoeveel sets je tegelijk kunt uitleveren.'),
      field('Feestjes per dag', num('dailyCapacity', av.settings.dailyCapacity, 1, 10)),
      field('Minimaal dagen vooruit', num('minLeadDays', av.settings.minLeadDays, 0, 60)),
      field('Maximaal dagen vooruit', num('maxAdvanceDays', av.settings.maxAdvanceDays, 7, 730))),
    h('button', { class: 'btn primary', type: 'submit' }, 'Opslaan'));

  const blockForm = h('form', { class: 'inline', onsubmit: action(() => {
    const { date, reason } = Object.fromEntries(new FormData(blockForm));
    return api(`/blocked-dates/${date}`, { method: 'PUT', body: JSON.stringify({ reason }) });
  }, 'Dag geblokkeerd.') },
    field('Datum', h('input', { type: 'date', name: 'date', required: true, min: todayIso() })),
    field('Reden (optioneel)', h('input', { name: 'reason', maxlength: 200, placeholder: 'Bijv. vakantie' })),
    h('button', { class: 'btn', type: 'submit' }, 'Hele dag blokkeren'));

  const overrideForm = h('form', { class: 'inline', onsubmit: action(() => {
    const { date, slot, open, reason } = Object.fromEntries(new FormData(overrideForm));
    return api(`/availability/overrides/${date}/${slot}`, { method: 'PUT', body: JSON.stringify({ open: open === 'true', reason }) });
  }, 'Uitzondering opgeslagen.') },
    field('Datum', h('input', { type: 'date', name: 'date', required: true, min: todayIso() })),
    field('Dagdeel', h('select', { name: 'slot' }, av.slots.map((s) => h('option', { value: s.key }, s.label)))),
    field('Wordt', h('select', { name: 'open' }, h('option', { value: 'true' }, 'Extra open'), h('option', { value: 'false' }, 'Gesloten'))),
    field('Reden (optioneel)', h('input', { name: 'reason', maxlength: 200 })),
    h('button', { class: 'btn', type: 'submit' }, 'Toevoegen'));

  view.replaceChildren(
    card('Weekrooster', h('p', { class: 'muted' }, 'Vink aan op welke dagdelen je normaal gesproken feestjes doet. Bezoekers kunnen alleen die dagdelen boeken.'), scheduleForm),
    card('Hele dagen blokkeren', blockForm,
      h('div', { style: 'margin-top:12px' }, table(['Datum', 'Reden', ''], blocked.map((d) => h('tr', {},
        h('td', {}, fmtDate(d.date)), h('td', {}, d.reason || '–'),
        h('td', { class: 'right' }, h('button', { class: 'btn small', onclick: action(() => del(`/blocked-dates/${d.date}`), 'Vrijgegeven.') }, 'Vrijgeven')))),
        'Geen geblokkeerde dagen.'))),
    card('Uitzonderingen per dagdeel', h('p', { class: 'muted' }, 'Open een extra dagdeel dat normaal dicht is, of sluit er een dat normaal open is.'), overrideForm,
      h('div', { style: 'margin-top:12px' }, table(['Datum', 'Dagdeel', '', 'Reden', ''], overrides.map((o) => h('tr', {},
        h('td', {}, fmtDate(o.date)), h('td', {}, SLOT_LABELS[o.slot]),
        h('td', {}, badge(o.open ? 'Extra open' : 'Gesloten', o.open ? 'success' : 'danger')),
        h('td', {}, o.reason || '–'),
        h('td', { class: 'right' }, h('button', { class: 'btn small', onclick: action(() => del(`/availability/overrides/${o.date}/${o.slot}`), 'Verwijderd.') }, 'Verwijderen')))),
        'Geen uitzonderingen.'))),
  );
}

async function calendarView() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const month = params.get('month') ?? todayIso().slice(0, 7);
  const cal = await api(`/calendar?month=${month}`);
  const shift = (n) => {
    const d = new Date(`${month}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + n);
    return d.toISOString().slice(0, 7);
  };
  const title = new Intl.DateTimeFormat('nl-NL', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`));
  const offset = (new Date(`${month}-01T00:00:00Z`).getUTCDay() + 6) % 7;
  setPage('Agenda',
    h('div', { class: 'cal-nav' },
      h('a', { class: 'btn small', href: `#/calendar?month=${shift(-1)}`, 'aria-label': 'Vorige maand' }, '‹'),
      h('strong', {}, title),
      h('a', { class: 'btn small', href: `#/calendar?month=${shift(1)}`, 'aria-label': 'Volgende maand' }, '›'),
      h('a', { class: 'btn small', href: '#/calendar' }, 'Vandaag')),
    h('a', { class: 'btn', href: '#/availability' }, 'Beschikbaarheid'));

  const dayCell = (d) => h('div', { class: `cal-cell ${d.blocked ? 'blocked' : ''} ${d.date === todayIso() ? 'today' : ''} ${d.date < todayIso() ? 'past' : ''}` },
    h('div', { class: 'cal-date' }, Number(d.date.slice(8)), d.blocked && h('span', { class: 'muted small' }, ` ${d.reason || 'geblokkeerd'}`)),
    d.slots.map((s) => {
      const bookings = d.bookings.filter((b) => b.timeSlot === s.key);
      const short = SLOT_LABELS[s.key].slice(0, 3);
      if (bookings.length) {
        return bookings.map((b) => h('a', { class: `cal-chip booked st-${b.status}`, href: `#/bookings/${b.id}`, title: `${STATUS_LABELS[b.status]} · ${b.packageName}` },
          `${b.startTime ?? short} ${b.childName || b.parentName} · ${b.city}`));
      }
      if (d.blocked || !s.open) return h('span', { class: 'cal-chip closed' }, `${short} –`);
      return h('span', { class: `cal-chip ${s.available ? 'free' : 'full'}` }, `${short} ${s.available ? 'vrij' : 'vol'}`);
    }));

  view.replaceChildren(
    h('div', { class: 'admin-cal' },
      ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'].map((w) => h('div', { class: 'cal-wd' }, w)),
      Array.from({ length: offset }, () => h('div', { class: 'cal-pad' })),
      cal.days.map(dayCell)),
    h('p', { class: 'muted small', style: 'margin-top:10px' },
      badge('vrij', 'success'), ' te boeken · ', badge('geboekt', 'violet'), ' klik voor details · ', badge('aanvraag', 'warning'), ' nog niet bevestigd · grijs = gesloten'),
  );
}

async function packagesView() {
  const packages = await api('/packages');
  setPage('Pakketten');
  const editor = (p) => {
    const form = h('form', { class: 'card', onsubmit: action(() => {
      const d = Object.fromEntries(new FormData(form));
      return api(p ? `/packages/${p.id}` : '/packages', { method: p ? 'PATCH' : 'POST', body: JSON.stringify({
        slug: d.slug, name: d.name, description: d.description,
        maxPlayers: Number(d.maxPlayers), durationHours: Number(String(d.durationHours).replace(',', '.')),
        priceCents: parseEuro(d.price), sortOrder: Number(d.sortOrder), active: form.elements.active.checked,
      }) });
    }, 'Pakket opgeslagen.') },
      h('h2', {}, p ? p.name : 'Nieuw pakket'),
      h('div', { class: 'row' },
        field('Naam', h('input', { name: 'name', required: true, value: p?.name ?? '' })),
        field('Slug (in de URL)', h('input', { name: 'slug', required: true, pattern: '[a-z0-9-]+', value: p?.slug ?? '' })),
        field('Prijs (€)', h('input', { name: 'price', required: true, inputmode: 'decimal', value: p ? euroInput(p.priceCents) : '' }))),
      h('div', { class: 'row' },
        field('Stations', h('input', { type: 'number', name: 'maxPlayers', min: 1, required: true, value: p?.maxPlayers ?? 8 })),
        field('Duur (uren)', h('input', { name: 'durationHours', required: true, inputmode: 'decimal', value: String(p?.durationHours ?? 3).replace('.', ',') })),
        field('Volgorde', h('input', { type: 'number', name: 'sortOrder', value: p?.sortOrder ?? 0 }))),
      field('Omschrijving', h('textarea', { name: 'description' }, p?.description ?? '')),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'active', checked: p ? p.active : true }), ' Zichtbaar in het boekingsformulier'),
      h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn primary', type: 'submit' }, 'Opslaan')));
    return form;
  };
  view.replaceChildren(
    h('p', { class: 'muted' }, 'Prijswijzigingen gelden voor nieuwe boekingen; bestaande boekingen houden hun prijs. De pakketteksten op de website staan in site/partials/packages.html.'),
    h('div', { class: 'package-grid' }, packages.map(editor), editor(null)),
  );
}

// Router -------------------------------------------------------------------------

async function updateCounts() {
  try {
    const [o, me] = await Promise.all([api('/overview'), api('/me')]);
    const set = (id, n) => {
      const el = document.getElementById(id);
      el.textContent = n;
      el.hidden = !n;
    };
    set('count-messages', o.messagesWaiting);
    set('count-reviews', o.reviewsToRequest);
    document.getElementById('me').textContent = me.email;
  } catch {}
}

async function render() {
  if (!getToken()) return loginView();
  sidebar.hidden = false;
  topbar.hidden = false;
  sidebar.classList.remove('open');
  const [path] = location.hash.slice(1).split('?');
  const parts = (path || '/board').split('/').filter(Boolean);
  for (const a of document.querySelectorAll('.side-nav a')) {
    a.classList.toggle('active', a.dataset.route === parts[0] || (a.dataset.route === 'list' && parts[0] === 'bookings'));
  }
  updateCounts();
  try {
    if (parts[0] === 'bookings' && parts[1]) await bookingDetailView(parts[1]);
    else if (parts[0] === 'list') await listView();
    else if (parts[0] === 'calendar') await calendarView();
    else if (parts[0] === 'messages') await messagesView(parts[1] ? Number(parts[1]) : null);
    else if (parts[0] === 'reviews') await reviewsView();
    else if (parts[0] === 'availability') await availabilityView();
    else if (parts[0] === 'packages') await packagesView();
    else await boardView();
  } catch (err) {
    flash('error', err.message);
  }
}

// Light/dark theme toggle.
const themeToggle = document.getElementById('theme-toggle');
const applyThemeLabel = () => {
  themeToggle.textContent = document.documentElement.dataset.theme === 'dark' ? '☀ Licht thema' : '☾ Donker thema';
};
themeToggle.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  storeTheme(next);
  applyThemeLabel();
});
applyThemeLabel();

document.getElementById('menu-btn').addEventListener('click', () => sidebar.classList.toggle('open'));
document.getElementById('logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' }).catch(() => {});
  setToken(null);
  render();
});
window.addEventListener('hashchange', render);
render();
