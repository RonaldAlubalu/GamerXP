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
const PAYMENT_METHODS = { bank: 'Overboeking', cash: 'Contant', tikkie: 'Tikkie', mollie: 'Online (Mollie)', other: 'Anders' };
const MOLLIE_STATUS = { open: ['Open', 'warning'], pending: ['Bezig', 'info'], authorized: ['Geautoriseerd', 'info'], paid: ['Betaald', 'success'], canceled: ['Geannuleerd', ''], expired: ['Verlopen', ''], failed: ['Mislukt', 'danger'] };
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
  if (res.status === 401 && !path.startsWith('/login')) {
    setToken(null);
    render();
    throw new Error('Sessie verlopen, log opnieuw in.');
  }
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(body?.error || `Fout ${res.status}`), { code: body?.code });
  return body;
}
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
const patchJson = (path, body) => api(path, { method: 'PATCH', body: JSON.stringify(body) });
const del = (path) => api(path, { method: 'DELETE' });
const put = (path, body) => api(path, { method: 'PUT', body: JSON.stringify(body) });

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
// Every cell knows its column name, so on a phone a row can be shown as a card with labels.
const table = (headers, rows, empty = 'Niets gevonden.') => {
  if (!rows.length) return h('p', { class: 'empty' }, empty);
  for (const row of rows) [...(row?.children ?? [])].forEach((cell, i) => (cell.dataset.label = headers[i] ?? ''));
  return h('div', { class: 'table-wrap card-table' }, h('table', {}, h('thead', {}, h('tr', {}, headers.map((t) => h('th', {}, t)))), h('tbody', {}, rows)));
};
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

// The second step by email: "pending" stays in this browser between typing the password and
// opening the link from the mail (which may open in a new tab).
const PENDING_KEY = 'gxp_login_pending';
function getPending() {
  try { return localStorage.getItem(PENDING_KEY); } catch { return null; }
}
function setPending(value) {
  try { value ? localStorage.setItem(PENDING_KEY, value) : localStorage.removeItem(PENDING_KEY); } catch {}
}

// A device that passed the second step can be remembered for 30 days.
const DEVICE_KEY = 'gxp_device';
function getDevice() {
  try { return localStorage.getItem(DEVICE_KEY); } catch { return null; }
}
function finishLogin(res) {
  if (res.deviceToken) { try { localStorage.setItem(DEVICE_KEY, res.deviceToken); } catch {} }
  setPending(null);
  setToken(res.token);
  render();
}

function loginView(notice) {
  sidebar.hidden = true;
  topbar.hidden = true;
  const form = document.getElementById('login-tpl').content.firstElementChild.cloneNode(true);
  const codeField = form.querySelector('#l-code-field');
  const codeInput = form.querySelector('#l-code');
  let emailStep = false;
  const askMailCode = (minutes) => {
    emailStep = true;
    codeField.hidden = false;
    codeField.querySelector('label').textContent = 'Code uit de mail';
    codeField.querySelector('small').textContent =
      `We hebben je een mail gestuurd. Open de link in die mail op dit apparaat, of typ hier de code van 6 cijfers over.${minutes ? ` Geldig voor ${minutes} minuten.` : ''}`;
    codeInput.value = '';
    codeInput.focus();
  };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = Object.fromEntries(new FormData(form));
      if (!data.code) delete data.code;
      data.remember = form.querySelector('#l-remember').checked;
      if (getDevice()) data.device = getDevice();
      if (emailStep && data.code && getPending()) {
        return finishLogin(await api('/login/link', { method: 'POST', body: JSON.stringify({ pending: getPending(), code: data.code }) }));
      }
      const res = await api('/login', { method: 'POST', body: JSON.stringify(data) });
      if (res.step === 'email') {
        setPending(res.pending);
        return askMailCode(res.minutes);
      }
      finishLogin(res);
    } catch (err) {
      // Password accepted, second step needed: ask for the code and stay on the form.
      if (err.code === 'two_factor_required') {
        codeField.hidden = false;
        codeInput.focus();
        return;
      }
      if (err.code === 'invalid_code') codeInput.select();
      if (err.code === 'link_expired') {
        setPending(null);
        emailStep = false;
        codeField.hidden = true;
        codeInput.value = '';
      }
      flash('error', err.message);
    }
  });
  view.replaceChildren(form);
  if (notice) flash('error', notice);
}

// Opened from the login mail: finish the login that was started in this browser.
async function loginFromLink(token) {
  history.replaceState(null, '', `${location.pathname}#/`);
  const pending = getPending();
  if (!pending) {
    return loginView('Deze link werkt alleen op het apparaat waarop je inlogde. Log hier in, of typ daar de code uit de mail over.');
  }
  try {
    finishLogin(await api('/login/link', { method: 'POST', body: JSON.stringify({ pending, token }) }));
  } catch (err) {
    if (err.code === 'link_expired') setPending(null);
    loginView(err.message);
  }
}

// A booking that came in outside the website: phone, WhatsApp or the old site.
async function newBookingView() {
  const packages = (await api('/packages')).filter((p) => p.active !== false);
  setPage('Boeking toevoegen', h('a', { class: 'btn ghost', href: '#/list' }, 'Annuleren'));
  const input = (name, attrs = {}) => h('input', { name, ...attrs });
  const select = (name, options) => h('select', { name }, Object.entries(options).map(([v, l]) => h('option', { value: v }, l)));
  const startStatuses = Object.fromEntries(['new', 'contacted', 'confirmed', 'deposit_paid', 'scheduled', 'party_held', 'completed'].map((s) => [s, STATUS_LABELS[s]]));
  const form = h('form', { class: 'card', style: 'max-width:720px' },
    h('p', { class: 'muted' }, 'Voor een boeking die via telefoon, WhatsApp of de oude site is gemaakt. De klant krijgt hier geen e-mail van.'),
    h('div', { class: 'row', style: 'grid-template-columns:repeat(auto-fit,minmax(220px,1fr))' },
      field('Pakket', h('select', { name: 'packageId', required: true }, packages.map((p) => h('option', { value: p.id }, `${p.name} (${euro.format(p.priceCents / 100)})`)))),
      field('Fase', select('status', startStatuses), 'Waar staat deze boeking nu?'),
      field('Datum', input('partyDate', { type: 'date', required: true })),
      field('Tijdslot', select('timeSlot', SLOT_LABELS)),
      field('Naam ouder of contactpersoon', input('parentName', { required: true, maxlength: 100 })),
      field('E-mail', input('email', { type: 'email' }), 'Mag leeg blijven als je het nog niet weet.'),
      field('Telefoon', input('phone', { type: 'tel' })),
      field('Naam jarige', input('childName', { maxlength: 50 })),
      field('Leeftijd', input('childAge', { type: 'number', min: 1, max: 18 })),
      field('Aantal kinderen', input('guestCount', { type: 'number', min: 1, max: 40 })),
      field('Straat en huisnummer', input('street')),
      field('Postcode', input('postalCode', { placeholder: '1234 AB' })),
      field('Plaats', input('city', { required: true })),
      field('Extra gamestations', select('extraStations', { 0: 'Geen', 1: '1 extra', 2: '2 extra' })),
      field('Parkeren', select('parking', { '': 'Onbekend', free: 'Gratis', paid: 'Betaald' }))),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'decoration' }), ' Decoratie erbij (alleen bij Standaard een meerprijs)'),
    h('div', { id: 'review-choice', class: 'next-step', style: 'display:none' },
      h('strong', {}, 'Dit feest is al geweest. Nog te doen:'),
      h('label', { class: 'check', style: 'display:flex;margin-top:8px' }, h('input', { type: 'checkbox', name: 'askReview', checked: true }), ' Om een Google-review vragen (de klant krijgt automatisch een e-mail)'),
      h('p', { class: 'muted small', style: 'margin:6px 0 0' }, 'Op de checklist van de boeking blijven "reviewverzoek verstuurd" en "social post gemaakt" open staan tot je ze afvinkt.')),
    field('Afspraken en bijzonderheden', h('textarea', { name: 'notes', rows: 3, maxlength: 2000 })),
    h('button', { class: 'btn primary', type: 'submit' }, 'Boeking toevoegen'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const { status, askReview: _ask, ...body } = data;
    const past = ['party_held', 'completed'].includes(status);
    body.decoration = form.elements.decoration.checked;
    for (const key of ['childAge', 'guestCount']) if (!body[key]) delete body[key];
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      const created = await post('/bookings', body);
      if (status !== 'new') {
        // A party that is already over: no review request unless the box is ticked.
        await patchJson(`/bookings/${created.id}`, { status, notifyCustomer: false, ...(past && !form.elements.askReview.checked ? { reviewStatus: 'declined' } : {}) });
      }
      flash('ok', `Boeking ${created.reference} toegevoegd.`);
      location.hash = `#/bookings/${created.id}`;
    } catch (err) {
      button.disabled = false;
      flash('error', err.message);
    }
  });
  form.elements.status.addEventListener('change', (e) => {
    form.querySelector('#review-choice').style.display = ['party_held', 'completed'].includes(e.target.value) ? 'block' : 'none';
  });
  view.replaceChildren(form);
}

async function boardView() {
  const [columns, o] = await Promise.all([api('/pipeline'), api('/overview')]);
  setPage('Pipeline', h('a', { class: 'btn', href: '#/calendar' }, 'Agenda'));

  // Parties that are tomorrow: one click opens WhatsApp with the message ready, you press send.
  const reminders = o.remindersDue && me.role === 'owner' ? await api('/reminders') : [];
  const remind = (r, channel) => action(() => post(`/bookings/${r.id}/reminder`, { channel }),
    channel === 'email' ? 'Herinnering gemaild.' : 'Herinnering vastgelegd. Vergeet niet in WhatsApp op verzenden te drukken.');
  const reminderCard = reminders.length && card('Morgen is het zover: stuur een herinnering',
    reminders.map((r) => h('div', { class: 'reminder-row' },
      h('div', {},
        h('a', { href: `#/bookings/${r.id}` }, h('strong', {}, r.childName ? `${r.childName} (${r.parentName})` : r.parentName)),
        h('div', { class: 'muted small' }, `${r.startTime ? `${r.startTime} uur` : SLOT_LABELS[r.timeSlot]} · ${r.city}`),
        h('div', { class: 'muted small reminder-text' }, r.text)),
      h('div', { class: 'inline' },
        r.whatsappUrl
          ? h('a', { class: 'btn small primary', href: r.whatsappUrl, target: '_blank', rel: 'noopener', onclick: () => { remind(r, 'whatsapp')(); } }, 'WhatsApp openen')
          : h('span', { class: 'muted small' }, 'Geen telefoonnummer'),
        h('button', { class: 'btn small', onclick: remind(r, 'email') }, 'Per e-mail')))));

  const stat = (num, label, href, tone) =>
    h('a', { class: `stat ${tone === 'quiet' ? 'quiet' : num && num !== fmtEuro(0) ? tone : ''}`, href }, h('div', { class: 'num' }, num), h('div', { class: 'lbl' }, label));
  // Only an owner moves bookings. The card being dragged, while it is.
  const canMove = me.role === 'owner';
  let dragged = null;
  const bookingCard = (b, column) => {
    const i = STAGES.indexOf(column.key);
    const next = i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1] : null;
    return h('article', {
      class: `board-card ${b.waitingOn === 'me' && isOpen(b) ? 'me' : ''}`,
      draggable: canMove ? 'true' : null,
      ondragstart: (e) => {
        dragged = b;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', b.reference);
        e.currentTarget.classList.add('dragging');
      },
      ondragend: (e) => { dragged = null; e.currentTarget.classList.remove('dragging'); for (const el of view.querySelectorAll('.board-col.drop')) el.classList.remove('drop'); },
      // Anywhere on the card opens the booking; the button below keeps its own job.
      onclick: (e) => { if (!e.target.closest('button, a')) location.hash = `#/bookings/${b.id}`; },
    },
      h('a', { class: 'title', href: `#/bookings/${b.id}` }, displayName(b)),
      h('div', { class: 'meta' }, when(b)),
      h('div', { class: 'meta' }, `${b.city} · ${b.packageName}${b.extraStations ? ` +${b.extraStations}` : ''} · ${fmtEuro(b.priceCents)}`),
      h('div', { class: 'badges' }, isOpen(b) && waitingBadge(b.waitingOn), dueBadge(b), paymentBadges(b)),
      progressBar(b.tasksDone, b.tasksTotal),
      next && h('button', { class: 'btn small', onclick: action(() => moveBooking(b.id, next)) }, `→ ${STATUS_LABELS[next]}`));
  };

  // The board: a column per phase. A card can be dragged to another column (with a mouse), and
  // arrows and a fade at the edge show that there are more phases to the side.
  const board = h('div', { class: 'board' },
    columns.map((c) => {
      const col = h('section', { class: 'board-col' },
        h('header', {}, h('span', {}, c.label), h('span', { class: 'count' }, c.bookings.length)),
        c.bookings.length ? c.bookings.map((b) => bookingCard(b, c)) : h('p', { class: 'empty' }, '–'));
      if (canMove) {
        col.addEventListener('dragover', (e) => {
          if (!dragged || dragged.status === c.key) return;
          e.preventDefault();
          col.classList.add('drop');
        });
        col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drop'); });
        col.addEventListener('drop', (e) => {
          e.preventDefault();
          col.classList.remove('drop');
          const moved = dragged;
          dragged = null;
          if (!moved || moved.status === c.key) return;
          if (c.key === 'cancelled' && !confirm(`${displayName(moved)} annuleren?`)) return;
          action(() => moveBooking(moved.id, c.key))();
        });
      }
      return col;
    }));
  // Above the board, so they stay in sight however long the columns are.
  const toLeft = h('button', { class: 'btn small board-arrow left', type: 'button', onclick: () => board.scrollBy({ left: -board.clientWidth * 0.8, behavior: 'smooth' }) }, '‹ Eerdere fases');
  const toRight = h('button', { class: 'btn small board-arrow right', type: 'button', onclick: () => board.scrollBy({ left: board.clientWidth * 0.8, behavior: 'smooth' }) }, 'Meer fases ›');
  const boardWrap = h('div', { class: 'board-wrap' }, h('div', { class: 'board-nav' }, toLeft, toRight), h('div', { class: 'board-fade' }, board));
  function updateEdges() {
    const more = board.scrollWidth - board.clientWidth;
    boardWrap.classList.toggle('more-left', board.scrollLeft > 4);
    boardWrap.classList.toggle('more-right', more - board.scrollLeft > 4);
  }
  board.addEventListener('scroll', updateEdges, { passive: true });
  new ResizeObserver(updateEdges).observe(board);

  view.replaceChildren(
    ...(reminderCard ? [reminderCard] : []),
    h('div', { class: 'stats' },
      stat(o.waitingOnMe, 'Boekingen: jouw beurt', '#/list?waitingOn=me', 'alert'),
      stat(o.messagesWaiting, 'Berichten te beantwoorden', '#/messages', 'alert'),
      stat(o.depositOpen, 'Aanbetaling nog open', '#/list?payment=deposit_open', 'warn'),
      stat(o.reviewsToRequest, 'Reviews te vragen', '#/reviews', 'warn'),
      me.role === 'owner' && o.systemProblems > 0 && stat(o.systemProblems, 'Storing in een koppeling', '#/system', 'alert')),
    h('div', { class: 'stats quiet-row' },
      stat(o.nextSevenDays, 'feestjes komende 7 dagen', '#/calendar', 'quiet'),
      stat(o.waitingOnCustomer, 'wachten op klant', '#/list?waitingOn=customer', 'quiet'),
      stat(fmtEuro(o.outstandingCents), 'nog te ontvangen', '#/list?payment=outstanding', 'quiet')),
    boardWrap,
    h('p', { class: 'muted small' }, `${canMove ? 'Sleep een kaartje naar een andere fase, of gebruik de knop op het kaartje. ' : ''}Afgeronde en geannuleerde boekingen worden 30 dagen getoond. Alle boekingen staan onder "Boekingen".`),
  );
  updateEdges();
}

async function listView() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const keys = ['status', 'from', 'q', 'waitingOn', 'payment', 'review'];
  const query = new URLSearchParams(keys.filter((k) => params.get(k)).map((k) => [k, params.get(k)]));
  const bookings = await api(`/bookings?${query}`);
  // Several bookings at once, from a spreadsheet or .csv file that is read here in the browser.
  const importInput = h('input', { type: 'file', accept: '.xlsx,.csv', hidden: true, onchange: async () => {
    const file = importInput.files[0];
    importInput.value = '';
    if (!file) return;
    try {
      const [{ readRows }, { bookingsFromRows }, packages] = await Promise.all([import('/admin/inventory-file.js'), import('/admin/bookings-file.js'), api('/packages')]);
      const found = bookingsFromRows(await readRows(file), packages.filter((p) => p.active !== false));
      if (!found.bookings.length) throw new Error(found.problems.join(' ') || 'In dit bestand staan geen boekingen.');
      const lines = found.bookings.map((x) => `• ${fmtDate(x.body.partyDate)} · ${x.body.parentName} · ${x.body.city} (${STATUS_LABELS[x.status]})`);
      const skip = found.problems.length ? `\n\nDeze sla ik over:\n${found.problems.join('\n')}` : '';
      if (!confirm(`${found.bookings.length} boeking(en) toevoegen? Klanten krijgen hier geen e-mail van.\n\n${lines.join('\n')}${skip}`)) return;
      const failed = [...found.problems];
      let added = 0;
      for (const x of found.bookings) {
        try {
          const created = await post('/bookings', x.body);
          added++;
          // A party that is already over gets no automatic review request.
          if (x.status !== 'new') await patchJson(`/bookings/${created.id}`, { status: x.status, notifyCustomer: false, ...(['party_held', 'completed'].includes(x.status) ? { reviewStatus: 'declined' } : {}) });
        } catch (err) {
          failed.push(`Rij ${x.line} (${x.body.parentName}): ${err.message}`);
        }
      }
      if (failed.length) alert(`${added} toegevoegd. Niet gelukt:\n\n${failed.join('\n')}`);
      flash(added ? 'ok' : 'error', `${added} boeking(en) toegevoegd${failed.length ? `, ${failed.length} niet` : ''}.`);
      await render();
    } catch (err) {
      flash('error', err.message);
    }
  } });
  const template = async () => {
    const { bookingsTemplate } = await import('/admin/bookings-file.js');
    const link = h('a', { href: URL.createObjectURL(new Blob([bookingsTemplate()], { type: 'text/csv' })), download: 'boekingen-voorbeeld.csv' });
    link.click();
    URL.revokeObjectURL(link.href);
  };
  setPage('Boekingen',
    me.role === 'owner' && h('button', { class: 'btn', type: 'button', onclick: template }, 'Voorbeeldbestand'),
    me.role === 'owner' && h('button', { class: 'btn', type: 'button', onclick: () => importInput.click() }, 'Importeren'),
    me.role === 'owner' && h('a', { class: 'btn primary', href: '#/bookings/new' }, '+ Boeking toevoegen'));
  document.body.querySelector('#bookings-import')?.remove();
  importInput.id = 'bookings-import';
  document.body.append(importInput);

  const filter = (key, value) => {
    value ? params.set(key, value) : params.delete(key);
    location.hash = `#/list?${params}`;
  };
  const select = (key, options) => h('select', { onchange: (e) => filter(key, e.target.value) },
    Object.entries(options).map(([v, l]) => h('option', { value: v, selected: (params.get(key) ?? '') === v }, l)));

  // Under the list: what the bookings shown add up to. Cancelled ones don't count.
  const counted = bookings.filter((b) => b.status !== 'cancelled');
  const sum = (key) => counted.reduce((total, b) => total + (b[key] ?? 0), 0);
  const totalsBar = counted.length > 0 && h('div', { class: 'list-totals' },
    h('div', {}, h('span', {}, `${counted.length} ${counted.length === 1 ? 'boeking' : 'boekingen'}`), h('strong', {}, fmtEuro(sum('priceCents')))),
    h('div', {}, h('span', {}, 'Betaald'), h('strong', {}, fmtEuro(sum('paidCents')))),
    h('div', {}, h('span', {}, 'Nog te ontvangen'), h('strong', { class: sum('outstandingCents') ? 'warn' : '' }, fmtEuro(sum('outstandingCents')))),
    bookings.length > counted.length && h('p', { class: 'muted small' }, `${bookings.length - counted.length} geannuleerde boeking(en) niet meegeteld.`));
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
    totalsBar,
  );
}

// Ready-made messages, grouped by the moment you need them. {placeholders} are filled from the booking.
// They work for email and for WhatsApp; the subject is only used for email. A template with a
// `status` also moves the booking on to that stage when the message is sent.
const TEMPLATES = [
  { group: 'Na de aanvraag', label: 'Vraag naar details', status: 'contacted',
    subject: 'Je aanvraag bij Gamer Xperience ({ref})',
    body: 'Hoi {naam},\n\nBedankt voor je aanvraag voor {datum}! Om alles goed voor te bereiden heb ik nog een paar vragen:\n\n- Hoeveel kinderen komen er ongeveer?\n- In welke ruimte vindt het feest plaats, en is er een grote tafel?\n- Zijn er favoriete games?\n\nLaat het me weten, dan zet ik je datum vast.' },
  { group: 'Na de aanvraag', label: 'Prijsopgave', status: 'contacted',
    subject: 'Prijsopgave voor je feest ({ref})',
    body: 'Hoi {naam},\n\nHierbij de prijsopgave voor {datum}:\n\n{prijsregels}\n\nTotaal: {totaal}\n\nOm de datum vast te zetten vragen we een aanbetaling van {aanbetaling}. Laat je weten of je akkoord bent?' },
  { group: 'Na de aanvraag', label: 'Datum niet beschikbaar, andere datum?', status: 'contacted',
    subject: 'Over je aanvraag voor {datum}',
    body: 'Hoi {naam},\n\nHelaas zijn we op {datum} al volgeboekt. Zou een andere datum ook kunnen? Op gamerxp.nl/reserveer zie je welke dagen nog vrij zijn. Je mag me ook een paar data doorgeven, dan kijk ik met je mee.' },
  { group: 'Na de aanvraag', label: 'Het duurt iets langer',
    subject: 'Je aanvraag bij Gamer Xperience ({ref})',
    body: 'Hoi {naam},\n\nBedankt voor je geduld! Het is op dit moment erg druk, waardoor het iets langer duurt dan je van ons gewend bent. Je aanvraag voor {datum} staat genoteerd en je hoort uiterlijk morgen van mij.' },

  { group: 'Bevestigen en betalen', label: 'Datum is vrij, aanbetaling gevraagd', status: 'confirmed',
    subject: 'Goed nieuws: je datum is vrij ({ref})',
    body: 'Hoi {naam},\n\nGoed nieuws: {datum} is vrij en ik heb {feest} voor je vastgezet!\n\nDe prijs komt op {totaal}. Om de datum definitief te maken vragen we een aanbetaling van {aanbetaling}, binnen 5 dagen. Betalen en de voortgang volgen kan via deze link:\n{statuslink}\n\nHeb je nog vragen, stel ze gerust.' },
  { group: 'Bevestigen en betalen', label: 'Datum is vrij, met factuur aanbetaling', status: 'confirmed', invoice: 'deposit',
    subject: 'Goed nieuws: je datum is vrij ({ref})',
    body: 'Hoi {naam},\n\nGoed nieuws: {datum} is vrij en ik heb {feest} voor je vastgezet!\n\nDe prijs komt op {totaal}. Om de datum definitief te maken vragen we een aanbetaling van {aanbetaling}, binnen 5 dagen. De factuur zit in de bijlage; betalen gaat het makkelijkst met de QR-code op de factuur.\n\nDe voortgang van je feest volg je hier:\n{statuslink}\n\nHeb je nog vragen, stel ze gerust.' },
  { group: 'Bevestigen en betalen', label: 'Factuur restbedrag', invoice: 'final',
    subject: 'Factuur voor je feest ({ref})',
    body: 'Hoi {naam},\n\nIn de bijlage vind je de factuur voor het restbedrag van {feest} op {datum}. De aanbetaling is er al af. Betalen kan tot en met de dag van het feest; het makkelijkst gaat dat met de QR-code op de factuur.\n\nTot snel!' },
  { group: 'Bevestigen en betalen', label: 'Herinnering aanbetaling',
    subject: 'Herinnering aanbetaling ({ref})',
    body: 'Hoi {naam},\n\nWe hebben je aanbetaling van {aanbetaling} voor {datum} nog niet ontvangen. Zou je die binnen een paar dagen willen voldoen? Dat kan via {statuslink} of per overboeking onder vermelding van {ref}. Daarna staat je feest definitief vast.' },
  { group: 'Bevestigen en betalen', label: 'Aanbetaling ontvangen',
    subject: 'Aanbetaling ontvangen: je feest staat vast! ({ref})',
    body: 'Hoi {naam},\n\nBedankt, je aanbetaling is binnen. {Feest} op {datum} staat definitief in onze agenda! Vlak voor het feest neem ik contact op over de laatste details.' },
  { group: 'Bevestigen en betalen', label: 'Restbedrag nog open',
    subject: 'Restbedrag voor je feest ({ref})',
    body: 'Hoi {naam},\n\nVoor {datum} staat nog {openstaand} open. Je kunt dit vooraf betalen via {statuslink} of per overboeking, of contant op de dag zelf. Laat je even weten wat je voorkeur heeft?' },

  { group: 'Voorbereiding', label: 'Starttijd afstemmen',
    subject: 'Hoe laat begint het feest? ({ref})',
    body: 'Hoi {naam},\n\nHet feest op {datum} komt dichterbij! Hoe laat wil je dat de kinderen beginnen met gamen? Ik kom ongeveer een uur eerder om alles op te bouwen.' },
  { group: 'Voorbereiding', label: 'Laatste details (week ervoor)',
    subject: 'Bijna zover: je feest op {datum}',
    body: 'Hoi {naam},\n\nNog even en dan is het feest! Een paar dingen om af te stemmen:\n\n- Ik kom {aankomst} om alles op te bouwen (ongeveer 60 minuten).\n- Ik heb een grote tafel nodig en een stopcontact in de buurt.\n- Welke games staan bovenaan het lijstje van {kind}?\n\nNog te betalen: {openstaand}. Dat kan vooraf via overboeking of contant op de dag zelf.\n\nTot snel!' },
  { group: 'Voorbereiding', label: 'Vraag over parkeren',
    subject: 'Parkeren bij jullie ({ref})',
    body: 'Hoi {naam},\n\nIk kom met een bus vol apparatuur naar {adres}. Kan ik bij jullie voor de deur of op eigen terrein parkeren om uit te laden? Als er betaald parkeren geldt: parkeerkosten tot €10 nemen wij voor onze rekening, daarboven berekenen we ze door. Een bezoekersvergunning voorkomt dat.' },
  { group: 'Voorbereiding', label: 'Morgen is het zover',
    subject: 'Morgen is het zover! ({ref})',
    body: 'Hoi {naam}! Morgen is het zover: {feest} 🎮 Ik kom {aankomst} om alles op te bouwen. Zorg je voor een vrije tafel en een stopcontact in de buurt? We kijken ernaar uit!' },

  { group: 'Na het feest', label: 'Bedankt en vraag om review',
    subject: 'Bedankt voor het feest! ({ref})',
    body: 'Hoi {naam},\n\nBedankt dat we {feest} mochten verzorgen, wat een leuke groep! Ik hoop dat jullie er net zo van genoten hebben als wij.\n\nZou je ons willen helpen met een korte review op Google? Daar help je andere ouders enorm mee.' },

  { group: 'Wijzigen en annuleren', label: 'Wijziging bevestigd',
    subject: 'Je feest is aangepast ({ref})',
    body: 'Hoi {naam},\n\nIk heb je boeking aangepast. Het feest staat nu op {datum}. De actuele gegevens en de prijs vind je altijd op {statuslink}. Klopt er iets niet, laat het me dan weten.' },
  { group: 'Wijzigen en annuleren', label: 'Annulering bevestigd',
    subject: 'Je boeking is geannuleerd ({ref})',
    body: 'Hoi {naam},\n\nJammer dat het feest op {datum} niet doorgaat. Ik heb de boeking geannuleerd. Wil je later een nieuwe datum plannen, dan hoor ik het graag.' },
];

// For conversations from the contact form, where there is no booking yet.
const CONTACT_TEMPLATES = [
  { group: 'Antwoorden', label: 'Bedankt, verwijs naar reserveren',
    subject: 'Re: je bericht aan Gamer Xperience',
    body: 'Hoi {naam},\n\nBedankt voor je bericht! Leuk dat je aan een Gamer Xperience feest denkt. Op gamerxp.nl/reserveer zie je direct welke data vrij zijn en wat het voor jouw adres kost. Een aanvraag is vrijblijvend; daarna neem ik contact met je op.' },
  { group: 'Antwoorden', label: 'Prijzen en reiskosten',
    subject: 'Re: je bericht aan Gamer Xperience',
    body: 'Hoi {naam},\n\nBedankt voor je vraag! De Standaard Xperience (3 uur) kost €275 en de Ultimate Xperience (4 uur, met Game Master) €350. Daar komen alleen reiskosten bij: €0,50 per km heen en terug vanaf Eindhoven, met een maximum van €100. Op gamerxp.nl/reserveer zie je de prijs voor jouw adres.' },
  { group: 'Antwoorden', label: 'Komen jullie ook bij ons?',
    subject: 'Re: je bericht aan Gamer Xperience',
    body: 'Hoi {naam},\n\nJa, we komen door heel Nederland! De reiskosten zijn €0,50 per km heen en terug vanaf Eindhoven, met een maximum van €100. Vul op gamerxp.nl/reserveer je adres in, dan zie je meteen het totaal.' },
  { group: 'Antwoorden', label: 'Zakelijk of groot evenement',
    subject: 'Re: je bericht aan Gamer Xperience',
    body: 'Hoi {naam},\n\nBedankt voor je bericht! Voor een evenement maak ik graag een voorstel op maat. Kun je me laten weten:\n\n- de datum en de locatie;\n- hoeveel deelnemers je verwacht en welke leeftijd;\n- hoe lang het evenement duurt?\n\nDan hoor je snel van mij.' },
  { group: 'Antwoorden', label: 'Leeftijd en games',
    subject: 'Re: je bericht aan Gamer Xperience',
    body: 'Hoi {naam},\n\nGoede vraag! Onze feestjes zijn geschikt voor kinderen van ongeveer 6 tot 14 jaar. We hebben onder andere Fortnite, Minecraft, Roblox, Rocket League en Mario Kart, en voor de jongsten rustigere games. De kinderen mogen zelf kiezen; ik stem het aanbod af op de groep.' },
];

function fillTemplate(text, b) {
  const party = b.childName ? `het feest van ${b.childName}` : 'jullie feest';
  const vars = b.reference ? {
    naam: b.parentName.split(' ')[0],
    ref: b.reference,
    kind: b.childName || 'de jarige',
    feest: party,
    Feest: party.charAt(0).toUpperCase() + party.slice(1),
    datum: `${fmtLongDate(b.partyDate)} (${(b.startTime ?? SLOT_LABELS[b.timeSlot]).toLowerCase()})`,
    adres: `${b.street}, ${b.city}`,
    prijsregels: b.priceLines.map((l) => `- ${l.label}: ${fmtEuro(l.amountCents)}`).join('\n'),
    totaal: fmtEuro(b.priceCents),
    aanbetaling: fmtEuro(b.depositCents),
    openstaand: fmtEuro(b.outstandingCents),
    aankomst: b.startTime ? `een uur voor ${b.startTime}` : 'een uur voor de start',
    statuslink: `${location.origin}/status?t=${encodeURIComponent(b.statusToken)}`,
  } : { naam: (b.name ?? '').split(' ')[0] };
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
        h('span', {}, `${fmtDateTime(c.createdAt)} · `, who(c.actor))),
      c.subject && h('div', { class: 'msg-subject' }, c.subject),
      body);
  }));
}

// Send an email, or log a WhatsApp message, call or email received elsewhere.
function composer({ booking, contact, onSubmit, emailConfigured, invoicing }) {
  let mode = 'email';
  const subject = h('input', { name: 'subject', maxlength: 200, placeholder: 'Onderwerp' });
  const body = h('textarea', { name: 'body', required: true, rows: 7, placeholder: 'Typ je bericht… (je ondertekening wordt bij e-mails automatisch toegevoegd)' });
  const direction = h('select', { name: 'direction' }, h('option', { value: 'in' }, 'Ontvangen van klant'), h('option', { value: 'out' }, 'Verstuurd aan klant'));
  const channel = h('select', { name: 'channel' }, ['whatsapp', 'phone', 'email', 'in_person', 'other'].map((c) => h('option', { value: c }, CHANNELS[c])));
  // Templates fill the message for email and WhatsApp alike.
  // Templates that send an invoice along need the bookkeeping to be connected.
  const templates = booking ? TEMPLATES.filter((t) => !t.invoice || invoicing) : contact ? CONTACT_TEMPLATES : [];
  const groups = [...new Set(templates.map((t) => t.group))];
  const templateSelect = templates.length > 0 && h('select', {
    'aria-label': 'Sjabloon',
    onchange: (e) => {
      const t = templates[Number(e.target.value)];
      if (t && (!body.value.trim() || confirm('Je getypte bericht vervangen door dit sjabloon?'))) {
        subject.value = fillTemplate(t.subject, booking ?? contact);
        body.value = fillTemplate(t.body, booking ?? contact);
        // Only ever forwards, and not for finished or cancelled bookings.
        const ahead = booking && t.status && STAGES.indexOf(booking.status) >= 0 && STAGES.indexOf(t.status) > STAGES.indexOf(booking.status);
        moveBox.hidden = !ahead;
        moveCheck.checked = Boolean(ahead);
        moveCheck.value = ahead ? t.status : '';
        const INVOICE = { deposit: 'aanbetaling', final: 'restbedrag' };
        const has = t.invoice && booking.invoices.find((i) => i.kind === t.invoice);
        invoiceBox.hidden = !t.invoice;
        invoiceCheck.checked = Boolean(t.invoice);
        invoiceCheck.value = t.invoice ?? '';
        invoiceLabel.textContent = t.invoice
          ? ` Factuur ${INVOICE[t.invoice]} als pdf meesturen (${has ? `factuur ${has.number}` : 'wordt nu aangemaakt in e-Boekhouden'})`
          : '';
        moveLabel.textContent = ahead ? ` Na versturen de boeking op "${STATUS_LABELS[t.status]}" zetten (ook zichtbaar voor de klant)` : '';
      }
      e.target.value = '';
    },
  }, h('option', { value: '' }, 'Kies een sjabloon…'),
    groups.map((g) => h('optgroup', { label: g }, templates.map((t, i) => t.group === g && h('option', { value: i }, t.label)))));
  // Sending some templates moves the booking to the next stage, so the admin and the customer's page stay in step.
  const moveCheck = h('input', { type: 'checkbox' });
  const moveLabel = h('span', {});
  const moveBox = h('label', { class: 'check', hidden: true, style: 'margin:8px 0' }, moveCheck, moveLabel);
  const invoiceCheck = h('input', { type: 'checkbox' });
  const invoiceLabel = h('span', {});
  const invoiceBox = h('label', { class: 'check', hidden: true, style: 'margin:8px 0' }, invoiceCheck, invoiceLabel);
  const attachInvoice = () => (!invoiceBox.hidden && invoiceCheck.checked ? invoiceCheck.value : undefined);
  const moveTo = () => (!moveBox.hidden && moveCheck.checked ? moveCheck.value : undefined);
  const templateRow = templateSelect && h('div', { class: 'field template-row' }, h('label', {}, 'Sjabloon'), templateSelect);

  const emailFields = h('div', { class: 'field', style: 'margin-bottom:8px' }, subject);
  const logFields = h('div', { class: 'row', hidden: true }, field('Richting', direction), field('Kanaal', channel));
  const submit = h('button', { class: 'btn primary', type: 'submit' }, 'E-mail versturen');
  // Opens WhatsApp with the typed message ready to send, and keeps a copy in the log.
  const digits = (booking?.phone ?? '').replace(/\D/g, '').replace(/^00/, '').replace(/^0/, '31');
  const whatsapp = digits.length >= 9 && h('button', {
    type: 'button', class: 'btn',
    onclick: (e) => {
      if (!body.value.trim()) return flash('error', 'Typ eerst je bericht.');
      window.open(`https://wa.me/${digits}?text=${encodeURIComponent(body.value.trim())}`, '_blank', 'noopener');
      action(() => onSubmit({ direction: 'out', channel: 'whatsapp', body: body.value, send: false }, moveTo()))(e);
    },
  }, 'Via WhatsApp sturen');
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
      ? { direction: 'out', channel: 'email', subject: subject.value, body: body.value, send: true, attachInvoice: attachInvoice() }
      : { direction: direction.value, channel: channel.value, body: body.value, send: false }, mode === 'email' ? moveTo() : undefined)),
  },
    h('div', { class: 'tabs' }, tabButtons), templateRow, emailFields, logFields, h('div', { class: 'field' }, body), invoiceBox, moveBox,
    !emailConfigured && h('p', { class: 'muted small' }, 'Let op: e-mail (SMTP) is nog niet ingesteld. Berichten worden gelogd maar niet echt verstuurd.'),
    h('div', { class: 'inline' }, submit, whatsapp));
}

// Invoices in e-Boekhouden: one for the deposit and one for the rest.
function invoicesBox(b, me) {
  const box = h('div', {}, h('h3', { style: 'margin-top:16px' }, 'Facturen (e-Boekhouden)'));
  if (!me.bookkeepingConfigured) {
    box.append(h('p', { class: 'muted small' }, 'De koppeling met e-Boekhouden is nog niet ingesteld.'));
    return box;
  }
  const KINDS = { deposit: 'Aanbetaling', final: 'Restbedrag' };
  for (const [kind, label] of Object.entries(KINDS)) {
    const invoice = b.invoices.find((i) => i.kind === kind);
    box.append(h('div', { class: 'inline', style: 'margin-bottom:6px' },
      invoice
        ? [h('span', {}, `${label}: factuur `, h('strong', {}, invoice.number), ` · ${fmtEuro(invoice.amountCents)} · ${fmtDateTime(invoice.createdAt)} `),
           invoice.paidCents >= invoice.amountCents ? badge('Betaald', 'success') : invoice.paidCents > 0 ? badge(`${fmtEuro(invoice.paidCents)} ontvangen`, 'warning') : badge('Open', ''),
           invoice.pdfUrl && h('a', { class: 'btn small', href: invoice.pdfUrl, target: '_blank', rel: 'noopener' }, 'PDF openen'),
           h('button', { class: 'btn small ghost', title: 'Haalt de factuur alleen hier weg, niet uit e-Boekhouden', onclick: action(
             () => confirm(`Factuur ${invoice.number} loskoppelen?\n\nHij verdwijnt alleen uit de admin, zodat je hem opnieuw kunt maken. In e-Boekhouden verandert niets.`) ? del(`/bookings/${b.id}/invoices/${kind}`) : false,
             'Factuur losgekoppeld.') }, 'Loskoppelen')]
        : [h('span', { class: 'muted' }, `${label}: nog geen factuur`),
           h('button', { class: 'btn small', onclick: action(
             () => confirm(`Factuur voor ${label.toLowerCase()} aanmaken in e-Boekhouden?\n\nDit maakt een echte factuur met een factuurnummer in je boekhouding.`) ? post(`/bookings/${b.id}/invoices`, { kind }) : false,
             'Factuur gemaakt in e-Boekhouden.') }, 'Factuur maken'),
           h('button', { class: 'btn small ghost', onclick: (e) => linkExistingInvoice(b, kind, label, e.currentTarget.parentElement) }, 'Bestaande koppelen')]));
  }
  if (b.invoices.some((i) => i.paidCents < i.amountCents)) {
    box.append(h('button', { class: 'btn small', onclick: action(async () => {
      const { registered } = await post(`/bookings/${b.id}/invoices/sync`);
      flash('ok', registered ? 'Betaling gevonden en genoteerd.' : 'Nog geen nieuwe betaling in e-Boekhouden.');
    }) }, '↻ Betaling controleren'));
  }
  box.append(h('p', { class: 'muted small' }, 'De site vraagt elke tien minuten bij e-Boekhouden na of een factuur is betaald. De factuur voor het restbedrag bevat alle prijsregels en trekt de gefactureerde aanbetaling eraf.'));
  return box;
}

// Pick an invoice that already exists in e-Boekhouden and link it to this booking.
async function linkExistingInvoice(b, kind, label, row) {
  let invoices;
  try {
    invoices = await api('/invoices/unlinked');
  } catch (err) {
    return flash('error', err.message);
  }
  const form = h('form', { class: 'inline link-invoice', onsubmit: action(() => {
    const amount = String(form.elements.amount.value).trim().replace(',', '.');
    if (amount && !(Number(amount) > 0)) throw new Error('Vul een bedrag in, bijvoorbeeld 100,00.');
    return post(`/bookings/${b.id}/invoices/link`, { kind, number: form.elements.number.value, amountCents: amount ? Math.round(Number(amount) * 100) : null });
  }, 'Factuur gekoppeld.') },
    field(`Bestaande factuur voor ${label.toLowerCase()}`, invoices.length
      ? h('select', { name: 'number', required: true }, invoices.map((i) =>
          h('option', { value: i.number }, [i.number, i.date && fmtDate(i.date), i.customer].filter(Boolean).join(' · '))))
      : h('input', { name: 'number', required: true, placeholder: 'bijv. F00013-1' })),
    field('Bedrag (€)', h('input', { name: 'amount', inputmode: 'decimal', placeholder: 'uit de boekhouding', style: 'width:140px' }),
      'Leeg laten neemt het bedrag van de factuur over.'),
    h('button', { class: 'btn small primary', type: 'submit' }, 'Koppelen'),
    h('button', { class: 'btn small', type: 'button', onclick: () => render() }, 'Annuleren'));
  row.replaceChildren(form);
}

// Mollie: payment links for the customer and the status of online payments.
function onlinePayments(b, me) {
  const box = h('div', { class: 'online-pay' }, h('h3', { style: 'margin-top:16px' }, 'Online betalen (Mollie)'));
  if (!me.onlinePayments) {
    box.append(h('p', { class: 'muted small' }, 'Zet je Mollie API-key in MOLLIE_API_KEY (.env) om klanten online te laten betalen met iDEAL.'));
    return box;
  }
  const link = (kind, label) => {
    const amount = b.onlineDue?.[kind];
    if (!amount) return null;
    return h('div', { class: 'inline', style: 'margin-bottom:6px' },
      h('span', {}, `${label}: `, h('strong', {}, fmtEuro(amount))),
      h('button', { class: 'btn small primary', onclick: action(() => post(`/bookings/${b.id}/payment-link`, { kind, send: true }), 'Betaallink gemaild.') }, 'Betaallink mailen'),
      h('button', { class: 'btn small', onclick: async () => {
        try {
          const { url } = await post(`/bookings/${b.id}/payment-link`, { kind });
          try { await navigator.clipboard.writeText(url); flash('ok', 'Betaallink gekopieerd, plak hem in WhatsApp.'); }
          catch { prompt('Betaallink:', url); }
        } catch (err) { flash('error', err.message); }
      } }, 'Link kopiëren'),
      h('button', { class: 'btn small', onclick: async () => {
        try {
          showPayQr(b, label, await post(`/bookings/${b.id}/payment-link`, { kind, qr: true }));
        } catch (err) { flash('error', err.message); }
      } }, 'QR laten scannen'));
  };
  const links = [link('deposit', 'Aanbetaling'), link('payment', 'Restbedrag')].filter(Boolean);
  box.append(...(links.length ? links : [h('p', { class: 'muted small' },
    b.status === 'new' || b.status === 'contacted'
      ? 'De aanbetaling kan online betaald worden zodra de boeking op "Bevestigd" staat.'
      : 'Er staat nu niets open om online te betalen.')]));
  if (b.molliePayments.length) {
    box.append(h('ul', { class: 'list-plain' }, b.molliePayments.map((m) => h('li', {},
      h('span', {}, `${m.kind === 'deposit' ? 'Aanbetaling' : 'Restbedrag'} ${fmtEuro(m.amountCents)} · ${fmtDateTime(m.createdAt)} `, h('span', { class: 'muted small' }, m.id)),
      badge(...(MOLLIE_STATUS[m.status] ?? [m.status, '']))))));
    if (b.molliePayments.some((m) => ['open', 'pending', 'authorized'].includes(m.status))) {
      box.append(h('button', { class: 'btn small', onclick: action(() => post(`/bookings/${b.id}/mollie-sync`), 'Status bij Mollie gecontroleerd.') }, 'Status bij Mollie controleren'));
    }
  }
  return box;
}

// Full-screen QR code of a payment link: hold your phone out and the customer scans and pays.
function showPayQr(b, label, { url, amountCents, qrSvg }) {
  const code = h('div', { class: 'qr-code' });
  // The image is made by our own server from the payment link.
  code.innerHTML = qrSvg;
  const overlay = h('div', { class: 'qr-overlay', role: 'dialog', 'aria-label': 'Betalen met QR-code' },
    h('div', { class: 'qr-panel' },
      h('h2', {}, `${label}: ${fmtEuro(amountCents)}`),
      h('p', { class: 'muted' }, `${displayName(b)} · ${b.reference}`),
      code,
      h('p', {}, 'Scan met de camera van je telefoon en betaal met iDEAL.'),
      h('div', { class: 'inline', style: 'justify-content:center' },
        h('button', { class: 'btn primary', onclick: async () => {
          try {
            await post(`/bookings/${b.id}/mollie-sync`);
            const fresh = await api(`/bookings/${b.id}`);
            if (fresh.paidCents > b.paidCents) { overlay.remove(); flash('ok', 'Betaling ontvangen! 🎉'); await render(); }
            else flash('ok', 'Nog niet betaald. Probeer het zo nog eens.');
          } catch (err) { flash('error', err.message); }
        } }, 'Is het betaald?'),
        h('button', { class: 'btn', onclick: () => overlay.remove() }, 'Sluiten'))));
  document.body.append(overlay);
}

// Which tab of which booking is open, so it stays open after saving something.
let detailTab = { id: null, tab: 'overview' };

async function bookingDetailView(id) {
  const [b, me, packages] = await Promise.all([api(`/bookings/${id}`), api('/me'), api('/packages')]);
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
      : h('button', { class: 'btn', onclick: action(() => moveBooking(id, 'new')) }, 'Heropenen'),
    // For a double entry or a test. A real party that falls through is cancelled, so its history stays.
    me.role === 'owner' && h('button', { class: 'btn danger', onclick: async () => {
      const kept = [b.payments?.length && `${b.payments.length} betaling(en)`, b.invoices?.length && `${b.invoices.length} gekoppelde factuur/facturen`, b.communications?.length && `${b.communications.length} bericht(en)`].filter(Boolean);
      const warning = kept.length ? `\n\nOok dit verdwijnt: ${kept.join(', ')}. Facturen blijven wel in e-Boekhouden staan.` : '';
      if (!confirm(`Boeking ${b.reference} van ${displayName(b)} definitief verwijderen? Dit kan niet ongedaan worden.${warning}\n\nGaat een echt feest niet door, kies dan Annuleren: dan blijft de geschiedenis bewaard.`)) return;
      try {
        await del(`/bookings/${id}`);
        flash('ok', `Boeking ${b.reference} verwijderd.`);
        location.hash = '#/list';
      } catch (err) {
        flash('error', err.message);
      }
    } }, 'Verwijderen'));

  // Phase, whose turn, payment state.
  const turn = h('div', { class: 'segmented', title: 'Wie is er aan zet?' },
    Object.entries(WAITING).map(([k, w]) => h('button', {
      type: 'button', class: b.waitingOn === k ? 'on' : '', onclick: patch({ waitingOn: k }, `Gezet op "${w.label}".`),
    }, w.label)));
  const head = h('div', { class: 'detail-head' }, statusBadge(b.status), turn, dueBadge(b), paymentBadges(b));

  const stepper = h('ol', { class: 'stepper' },
    STAGES.map((s, i) => h('li', { class: b.status === 'cancelled' ? 'todo' : i < current ? 'done' : i === current ? 'current' : 'todo' },
      h('button', { type: 'button', disabled: s === b.status, 'aria-label': STATUS_LABELS[s], title: STATUS_LABELS[s], onclick: action(() => moveBooking(id, s)) },
        h('span', { class: 'dot' }, i < current && b.status !== 'cancelled' ? '✓' : i + 1), h('span', {}, STATUS_LABELS[s])))));

  // Customer and party.
  const planForm = h('form', { class: 'inline', onsubmit: action(() => {
    const f = planForm.elements;
    return patchJson(`/bookings/${id}`, {
      partyDate: f.partyDate.value, timeSlot: f.timeSlot.value, startTime: f.startTime.value || null, endTime: f.endTime.value || null,
      packageId: Number(f.packageId.value),
      travelMinutes: f.travelMinutes.value === '' ? null : Number(f.travelMinutes.value),
    });
  }, 'Planning opgeslagen.') },
    // The package can still change, e.g. from Standaard to Ultimate; the price follows.
    field('Pakket', h('select', { name: 'packageId' }, packages.filter((p) => p.active !== false || p.id === b.packageId).map((p) => h('option', { value: p.id, selected: p.id === b.packageId }, `${p.name} (${euro.format(p.priceCents / 100)})`)))),
    field('Datum', h('input', { type: 'date', name: 'partyDate', value: b.partyDate, required: true })),
    field('Dagdeel', h('select', { name: 'timeSlot' }, Object.entries(SLOT_LABELS).map(([k, l]) => h('option', { value: k, selected: k === b.timeSlot }, l)))),
    field('Starttijd', h('input', { type: 'time', name: 'startTime', value: b.startTime ?? '' })),
    // The explanation sits in the label, so the fields stay on one line.
    field(b.packageHours ? `Eindtijd (leeg = ${String(b.packageHours).replace('.', ',')} uur)` : 'Eindtijd', h('input', { type: 'time', name: 'endTime', value: b.endTime ?? '', title: 'Leeg laten: dan geldt de duur van het pakket' })),
    field('Reistijd enkele reis (min)', h('input', { type: 'number', name: 'travelMinutes', min: 0, max: 600, value: b.travelMinutes ?? '', style: 'width:110px' })),
    h('button', { class: 'btn', type: 'submit' }, 'Opslaan'));
  const phoneDigits = b.phone.replace(/\D/g, '').replace(/^0/, '31');
  const phoneLinks = (number) => [h('a', { href: `tel:${number.replace(/[^\d+]/g, '')}` }, number), ' · ',
    h('a', { href: `https://wa.me/${number.replace(/\D/g, '').replace(/^0/, '31')}`, target: '_blank', rel: 'noopener' }, 'WhatsApp')];
  const address = [b.street, [b.postalCode, b.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  // The customer's own address, when the party is somewhere else.
  const billing = [b.billingStreet, [b.billingPostalCode, b.billingCity].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  // Name, contact details and address can be corrected or completed here.
  const contactForm = () => {
    const input = (name, attrs = {}) => h('input', { name, value: b[name] ?? '', ...attrs });
    const grid = 'grid-template-columns:repeat(auto-fit,minmax(200px,1fr))';
    const hasBilling = Boolean(b.billingStreet || b.billingPostalCode || b.billingCity);
    const billingFields = h('div', { hidden: !hasBilling },
      h('p', { class: 'muted small' }, 'Het eigen adres van de klant, voor de factuur.'),
      h('div', { class: 'row', style: grid },
        field('Straat en huisnummer', input('billingStreet', { maxlength: 200 })),
        field('Postcode', input('billingPostalCode', { placeholder: '1234 AB' })),
        field('Plaats', input('billingCity', { maxlength: 100 }))));
    const sameAddress = h('input', { type: 'checkbox', checked: !hasBilling, onchange: () => {
      billingFields.hidden = sameAddress.checked;
      if (sameAddress.checked) for (const el of billingFields.querySelectorAll('input')) el.value = '';
    } });
    const form = h('form', { class: 'contact-edit', onsubmit: action(async () => {
      const data = Object.fromEntries(new FormData(form));
      for (const key of ['childAge', 'guestCount']) data[key] = data[key] ? Number(data[key]) : null;
      await patchJson(`/bookings/${id}/contact`, data);
      contactEditing = false;
    }, 'Gegevens opgeslagen.') },
      h('h3', {}, 'Klant'),
      h('div', { class: 'row', style: grid },
        field('Naam ouder of contactpersoon', input('parentName', { required: true, maxlength: 100 })),
        field('E-mail', input('email', { type: 'email' })),
        field('Telefoon', input('phone', { type: 'tel' })),
        field('Tweede e-mail', input('email2', { type: 'email' }), 'Bijvoorbeeld van de andere ouder.'),
        field('Tweede telefoon', input('phone2', { type: 'tel' }))),
      h('h3', {}, 'Locatie van het feest'),
      h('div', { class: 'row', style: grid },
        field('Naam locatie', input('locationName', { maxlength: 100, placeholder: 'Bijv. Zaal Villa Festa' }), 'Leeg laten bij een feest thuis.'),
        field('Straat en huisnummer', input('street', { maxlength: 200 })),
        field('Postcode', input('postalCode', { placeholder: '1234 AB' })),
        field('Plaats', input('city', { required: true }))),
      h('p', { class: 'muted small' }, 'Hier rijden we naartoe: bij een andere postcode of plaats worden de afstand en de reiskosten opnieuw berekend.'),
      h('h3', {}, 'Factuuradres'),
      // Ticked: the invoice goes to the address above and there is nothing to type.
      h('label', { class: 'check' }, sameAddress, ' Factuuradres is gelijk aan de locatie van het feest'),
      billingFields,
      h('h3', {}, 'Feest'),
      h('div', { class: 'row', style: grid },
        field('Naam jarige', input('childName', { maxlength: 50 })),
        field('Leeftijd', input('childAge', { type: 'number', min: 1, max: 18 })),
        field('Aantal kinderen', input('guestCount', { type: 'number', min: 1, max: 40 })),
        field('Parkeren', h('select', { name: 'parking' }, Object.entries({ '': 'Onbekend', free: 'Gratis', paid: 'Betaald', unknown: 'Weet de klant niet' }).map(([v, l]) => h('option', { value: v, selected: v === b.parking }, l))))),
      field('Details van de klant', h('textarea', { name: 'notes', rows: 3, maxlength: 2000 }, b.notes)),
      h('div', { class: 'inline' },
        h('button', { class: 'btn primary', type: 'submit' }, 'Opslaan'),
        h('button', { class: 'btn', type: 'button', onclick: () => { contactEditing = false; render(); } }, 'Annuleren')));
    return form;
  };
  if (contactEditingFor !== id) { contactEditing = false; contactEditingFor = id; }
  const customer = card(cardHead('Klant en feest', me.role === 'owner' && !contactEditing && h('button', { class: 'btn small', type: 'button', onclick: () => { contactEditing = true; render(); } }, 'Wijzigen')),
    contactEditing ? contactForm() : null,
    h('dl', { class: 'details', hidden: contactEditing },
      h('dt', {}, 'Klant'), h('dd', {}, b.parentName),
      h('dt', {}, 'E-mail'), h('dd', {}, b.email ? h('a', { href: `mailto:${b.email}` }, b.email) : '– (nog toevoegen via Wijzigen)'),
      b.email2 && h('dt', {}, 'Tweede e-mail'), b.email2 && h('dd', {}, h('a', { href: `mailto:${b.email2}` }, b.email2)),
      h('dt', {}, 'Telefoon'), h('dd', {}, b.phone ? phoneLinks(b.phone) : '–'),
      b.phone2 && h('dt', {}, 'Tweede telefoon'), b.phone2 && h('dd', {}, phoneLinks(b.phone2)),
      h('dt', {}, 'Locatie'), h('dd', {}, b.locationName && [h('strong', {}, b.locationName), h('br')],
        h('a', { href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([b.locationName, address].filter(Boolean).join(', '))}`, target: '_blank', rel: 'noopener' }, address)),
      billing && h('dt', {}, 'Factuuradres'), billing && h('dd', {}, billing),
      h('dt', {}, 'Wanneer'), h('dd', {}, `${fmtLongDate(b.partyDate)}, ${SLOT_LABELS[b.timeSlot].toLowerCase()}${b.startTime ? ` ${b.endTime ? `van ${b.startTime} tot ${b.endTime}` : `om ${b.startTime}`}` : ''}`),
      h('dt', {}, 'Pakket'), h('dd', {}, `${b.packageName}${b.extraStations ? ` + ${b.extraStations} extra station(s)` : ''}`),
      h('dt', {}, 'Jarige'), h('dd', {}, b.childName ? `${b.childName}${b.childAge ? `, wordt ${b.childAge}` : ''}` : '–'),
      h('dt', {}, 'Kinderen'), h('dd', {}, b.guestCount ?? '–'),
      h('dt', {}, 'Parkeren'), h('dd', {}, { free: 'Gratis parkeren', paid: 'Betaald parkeren: parkeerkosten boven €10 doorberekenen', unknown: 'Weet de klant niet: navragen' }[b.parking] ?? 'Niet opgegeven'),
      h('dt', {}, 'Details'), h('dd', {}, b.notes || '–'),
      h('dt', {}, 'Aangevraagd'), h('dd', {}, fmtDateTime(b.createdAt))),
    h('h3', { style: 'margin-top:16px' }, 'Dagplanning'),
    h('ol', { class: 'day-plan' },
      h('li', {}, h('strong', {}, b.schedule.leave), ` vertrek${b.schedule.travelKnown ? ` (${b.travelMinutes} min rijden)` : ' (reistijd nog niet bekend)'}`),
      h('li', {}, h('strong', {}, b.schedule.setupStart), ' opbouwen'),
      h('li', { class: 'party' }, h('strong', {}, `${b.schedule.start}–${b.schedule.end}`), ` feest${b.schedule.startAssumed ? ' (starttijd nog niet afgestemd)' : ''}`),
      h('li', {}, h('strong', {}, b.schedule.teardownEnd), ' afgebouwd'),
      h('li', {}, h('strong', {}, b.schedule.home), ' weer thuis')),
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
      h('button', { type: 'button', class: 'btn small', onclick: () => addExtraRow({ label: 'Parkeerkosten', amountCents: 0 }) }, '+ Parkeerkosten'),
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
    field('Hoe', h('select', { name: 'method' }, Object.entries(PAYMENT_METHODS).filter(([k]) => k !== 'mollie').map(([k, l]) => h('option', { value: k }, l)))),
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
    b.depositPaid && ['new', 'contacted', 'confirmed'].includes(b.status) &&
      h('p', {}, h('button', { class: 'btn success', onclick: action(() => moveBooking(id, 'deposit_paid')) }, 'Aanbetaling is binnen → zet op "Aanbetaling ontvangen"')),
    me.bookkeepingConfigured && invoicesBox(b, me),
    // With invoices as the way to pay, the site's own payment links only show when they are switched on.
    (me.onlinePayments || !me.bookkeepingConfigured) && onlinePayments(b, me),
    h('details', { class: 'collapsible', style: 'margin-top:14px', open: !me.bookkeepingConfigured },
      h('summary', {}, 'Betaling met de hand noteren'),
      h('div', { style: 'margin-top:10px' }, payForm)));

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
      invoicing: me.bookkeepingConfigured,
      emailConfigured: me.emailConfigured,
      onSubmit: async (msg, status) => {
        await post(`/bookings/${id}/messages`, msg);
        // Your own message is the notification, so no second automatic email.
        if (status) await patchJson(`/bookings/${id}`, { status, notifyCustomer: false });
        flash('ok', `${msg.send ? 'E-mail verstuurd.' : 'Bericht opgeslagen.'}${status ? ` Boeking staat nu op "${STATUS_LABELS[status]}".` : ''}`);
      },
    }),
    messageThread(b.communications));

  // Checklist.
  const tasksByStage = STAGES.map((s) => ({ stage: s, tasks: b.tasks.filter((t) => t.stage === s) })).filter((g) => g.tasks.length);
  const newTask = h('form', { class: 'inline', style: 'margin-top:10px', onsubmit: action(() => post(`/bookings/${id}/tasks`, Object.fromEntries(new FormData(newTask))), 'Taak toegevoegd.') },
    h('select', { name: 'stage', style: 'width:auto' }, STAGES.map((s) => h('option', { value: s, selected: s === b.status }, STATUS_LABELS[s]))),
    h('input', { name: 'label', required: true, maxlength: 200, placeholder: 'Nieuwe taak…', style: 'flex:1;width:auto' }),
    h('button', { class: 'btn', type: 'submit' }, 'Toevoegen'));
  if (taskGroups.id !== id) taskGroups = { id, open: {} };
  // A sheet for on paper: the party's details and every task with a box to tick.
  const printChecklist = () => {
    const line = (label, value) => value && h('div', {}, h('span', {}, label), h('strong', {}, value));
    const sheet = h('div', { class: 'print-sheet' },
      h('h1', {}, `Checklist ${b.parentName}`, h('small', {}, ` ${b.reference}`)),
      h('div', { class: 'print-facts' },
        line('Datum', `${fmtDate(b.partyDate)}${b.startTime ? `, ${b.startTime}${b.endTime ? `–${b.endTime}` : ''} uur` : ''}`),
        line('Pakket', `${b.packageName}${b.extraStations ? ` + ${b.extraStations} extra station(s)` : ''}`),
        line('Locatie', [b.locationName, b.street, [b.postalCode, b.city].filter(Boolean).join(' ')].filter(Boolean).join(', ')),
        line('Telefoon', b.phone),
        line('Jarige', [b.childName, b.childAge && `${b.childAge} jaar`].filter(Boolean).join(', ')),
        line('Kinderen', b.guestCount && String(b.guestCount)),
        line('Parkeren', b.parking),
        line('Opmerking klant', b.notes),
        line('Eigen notitie', b.adminNotes)),
      tasksByStage.map((g) => h('section', {},
        h('h2', {}, STATUS_LABELS[g.stage]),
        g.tasks.map((t) => h('div', { class: 'print-task' }, h('span', { class: `print-box ${t.done ? 'done' : ''}` }, t.done ? '✓' : ''), h('span', {}, t.label))))),
      h('section', {}, h('h2', {}, 'Notities'), h('div', { class: 'print-lines' })));
    document.body.append(sheet);
    window.addEventListener('afterprint', () => sheet.remove(), { once: true });
    window.print();
  };
  const checklist = card(cardHead('Checklist', h('span', { class: 'muted' }, `${b.tasksDone}/${b.tasksTotal}`), h('button', { class: 'btn small', type: 'button', onclick: printChecklist }, 'Afdrukken')),
    progressBar(b.tasksDone, b.tasksTotal),
    tasksByStage.map((g) => {
      const done = g.tasks.filter((t) => t.done).length;
      // The stage the booking is in stays open; the others fold away.
      // ... until one is opened or closed by hand: that choice stays while working in this booking.
      const group = h('details', { class: `task-group ${g.stage === b.status ? 'active' : ''}`, open: taskGroups.open[g.stage] ?? g.stage === b.status,
        ontoggle: () => { taskGroups.open[g.stage] = group.open; } },
        h('summary', {}, STATUS_LABELS[g.stage], h('span', { class: 'muted small' }, ` ${done}/${g.tasks.length}`)),
        g.tasks.map((t) => h('label', { class: `task ${t.done ? 'is-done' : ''}` },
          h('input', { type: 'checkbox', checked: t.done, onchange: action(() => patchJson(`/bookings/${id}/tasks/${t.id}`, { done: !t.done })) }),
          h('span', {}, t.label),
          t.doneAt && h('small', {}, fmtDateTime(t.doneAt)))));
      return group;
    }),
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
        h('div', {}, h('div', { class: 'pre' }, eventText(e)), h('div', { class: 'muted small' }, `${fmtDateTime(e.createdAt)} · `, who(e.actor)))))));

  // Gear that goes along to this party (owners only; shown once the inventory has stations or gear).
  const gear = me.role === 'owner' ? await api(`/bookings/${id}/inventory`) : [];
  const gearForm = h('form', { onsubmit: action(() => put(`/bookings/${id}/inventory`, {
    itemIds: [...gearForm.querySelectorAll('input[type=checkbox]:checked')].map((el) => Number(el.value)),
  }), 'Materiaal opgeslagen.') },
    h('div', { class: 'gear-list' }, gear.map((g) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', value: g.id, checked: g.assigned }),
      h('span', {}, g.name, g.status === 'spare' ? h('span', { class: 'muted small' }, ' (reserve)') : null,
        g.alsoAt ? h('span', { class: 'badge warning', style: 'margin-left:6px' }, `ook bij ${g.alsoAt}`) : null)))),
    h('div', { class: 'inline', style: 'margin-top:10px' },
      h('button', { class: 'btn primary', type: 'submit' }, 'Opslaan'),
      h('button', { class: 'btn', type: 'button', onclick: () => { for (const el of gearForm.querySelectorAll('input[type=checkbox]')) el.checked = true; } }, 'Alles aanvinken')));
  const gearCard = me.role !== 'owner' ? null : card('Materiaal voor dit feest',
    gear.length
      ? [h('p', { class: 'muted small' }, 'Vink aan wat er meegaat. Zo weet je achteraf waar elk station is geweest.'), gearForm]
      : h('p', { class: 'muted' }, 'Nog geen stations of materiaal in de ', h('a', { href: '#/inventory' }, 'inventaris'), '.'));

  // One page per subject instead of everything underneath each other.
  const TABS = [
    ['overview', 'Overzicht', [customer, agreementsCard]],
    ['messages', 'Berichten', [commCard, reviewCard]],
    ['money', 'Geld', [priceCard, paymentsCard]],
    ['progress', 'Checklist en tijdlijn', [checklist, gearCard, timeline].filter(Boolean)],
  ];
  if (detailTab.id !== id) detailTab = { id, tab: 'overview' };
  const panels = TABS.map(([key, , blocks]) => h('div', { class: 'stack', hidden: key !== detailTab.tab }, blocks));
  const tabButtons = TABS.map(([key, label]) => h('button', { type: 'button', class: key === detailTab.tab ? 'on' : '', onclick: () => showTab(key) }, label,
    key === 'messages' && isOpen(b) && b.waitingOn === 'me' ? h('span', { class: 'dot' }) : null));
  function showTab(key) {
    detailTab.tab = key;
    TABS.forEach(([k], i) => {
      panels[i].hidden = k !== key;
      tabButtons[i].classList.toggle('on', k === key);
    });
    tabButtons[TABS.findIndex(([k]) => k === key)]?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  // What to do next, depending on the stage.
  const depositInvoice = b.invoices.find((i) => i.kind === 'deposit');
  const go = (label, tab) => h('button', { class: 'btn primary', onclick: () => showTab(tab) }, label);
  const move = (status) => h('button', { class: 'btn primary', onclick: action(() => moveBooking(id, status)) }, `→ ${STATUS_LABELS[status]}`);
  const NEXT = {
    new: ['Nieuwe aanvraag: laat de klant weten of de datum vrij is.', go('Beantwoorden', 'messages')],
    contacted: b.waitingOn === 'me'
      ? ['De klant wacht op jou. Is alles duidelijk, bevestig dan de datum.', go('Bevestigen', 'messages')]
      : ['Je hebt gereageerd; je wacht op de klant. Is alles rond, bevestig dan de datum.', go('Bevestigen', 'messages')],
    confirmed: b.depositPaid
      ? ['De aanbetaling is binnen.', move('deposit_paid')]
      : depositInvoice
        ? [`Wacht op de aanbetaling: factuur ${depositInvoice.number} staat open.`, go('Naar geld', 'money')]
        : ['Bevestigd, maar er is nog geen factuur voor de aanbetaling.', go('Factuur maken', 'money')],
    deposit_paid: ['Het feest staat vast. Stem de starttijd en de games af en plan het in.', move('scheduled')],
    scheduled: [`Ingepland voor ${fmtLongDate(b.partyDate)}. Zet het daarna op "Feest geweest".`, move('party_held')],
    party_held: [b.outstandingCents ? `Feest geweest. Er staat nog ${fmtEuro(b.outstandingCents)} open.` : 'Feest geweest en alles is betaald. Vraag om een review en rond af.',
      b.outstandingCents ? go('Naar geld', 'money') : move('completed')],
  };
  const next = NEXT[b.status] && me.role === 'owner'
    ? h('div', { class: 'next-step' }, h('div', {}, h('strong', {}, 'Volgende stap: '), NEXT[b.status][0]), NEXT[b.status][1])
    : null;

  view.replaceChildren(
    head,
    card(null, stepper, h('p', { class: 'stepper-caption' }, b.status === 'cancelled' ? 'Geannuleerd' : `Stap ${current + 1} van ${STAGES.length}: `, b.status !== 'cancelled' && h('strong', {}, STATUS_LABELS[b.status]), h('span', { class: 'muted' }, ' · tik op een stap om te verplaatsen'))),
    ...(next ? [next] : []),
    h('div', { class: 'tabs page-tabs' }, tabButtons),
    ...panels,
  );
}

async function messagesView(selectedId) {
  const [messages, me, selected] = await Promise.all([
    api('/messages'), api('/me'), selectedId ? api(`/messages/${selectedId}`) : null,
  ]);
  setPage('Berichten', me.mailImportConfigured && h('button', {
    class: 'btn',
    onclick: async () => {
      try {
        const r = await post('/mail-import');
        flash('ok', r.imported ? `${r.imported} nieuwe e-mail(s) geïmporteerd.` : 'Geen nieuwe e-mails.');
        await render();
      } catch (err) { flash('error', err.message); }
    },
  }, '↻ E-mail ophalen'));

  const list = h('div', { class: 'card inbox-list' },
    messages.length
      ? messages.map((m) => h('a', { class: `inbox-item ${m.id === selected?.id ? 'active' : ''} ${m.handled ? 'handled' : ''}`, href: `#/messages/${m.id}` },
          h('div', { class: 'top' }, h('strong', {}, m.name), h('span', { class: 'muted small' }, fmtDateTime(m.lastMessageAt ?? m.createdAt))),
          h('div', { class: 'preview' }, m.message),
          h('div', { class: 'badges', style: 'margin-top:4px' }, m.handled ? badge('Afgehandeld', 'success') : waitingBadge(m.waitingOn))))
      : h('p', { class: 'empty' }, 'Nog geen berichten.'));

  const detail = selected
    ? card(h('div', { class: 'card-head' },
        h('div', {}, h('h2', {}, selected.name), h('div', { class: 'muted small' },
          h('a', { href: `mailto:${selected.email}` }, selected.email), selected.phone ? ` · ${selected.phone}` : '')),
        h('div', { class: 'inline' },
          !selected.handled && waitingBadge(selected.waitingOn),
          h('button', { class: 'btn small', onclick: action(() => patchJson(`/messages/${selected.id}`, { handled: !selected.handled }), selected.handled ? 'Weer geopend.' : 'Afgehandeld.') },
            selected.handled ? 'Heropenen' : '✓ Afgehandeld'))),
        composer({
          contact: selected,
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
  const month = new URLSearchParams(location.hash.split('?')[1] || '').get('month') ?? todayIso().slice(0, 7);
  const [av, blocked, overrides, cal] = await Promise.all([
    api('/availability'), api('/blocked-dates'), api('/availability/overrides'), api(`/calendar?month=${month}`),
  ]);
  setPage('Beschikbaarheid', h('a', { class: 'btn', href: '#/calendar' }, 'Agenda bekijken'));
  const shiftMonth = (n) => {
    const d = new Date(`${month}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + n);
    return d.toISOString().slice(0, 7);
  };
  const monthTitle = new Intl.DateTimeFormat('nl-NL', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`));
  const calendarCard = card(
    h('div', { class: 'card-head' }, h('h2', {}, 'Kalender'),
      h('div', { class: 'cal-nav' },
        h('a', { class: 'btn small', href: `#/availability?month=${shiftMonth(-1)}`, 'aria-label': 'Vorige maand' }, '‹'),
        h('strong', {}, monthTitle),
        h('a', { class: 'btn small', href: `#/availability?month=${shiftMonth(1)}`, 'aria-label': 'Volgende maand' }, '›'))),
    h('p', { class: 'muted' }, 'Kies per dag wanneer je beschikbaar bent. Wat je hier aanklikt gaat vóór het weekrooster hieronder.'),
    calendarGrid(cal));
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
    calendarCard,
    card('Weekrooster', h('p', { class: 'muted' }, 'Het standaardrooster: vink aan op welke dagdelen je normaal gesproken feestjes doet. Losse dagen pas je aan in de kalender hierboven.'), scheduleForm),
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
  setPage('Agenda',
    h('div', { class: 'cal-nav' },
      h('a', { class: 'btn small', href: `#/calendar?month=${shift(-1)}`, 'aria-label': 'Vorige maand' }, '‹'),
      h('strong', {}, title),
      h('a', { class: 'btn small', href: `#/calendar?month=${shift(1)}`, 'aria-label': 'Volgende maand' }, '›'),
      h('a', { class: 'btn small', href: '#/calendar' }, 'Vandaag')),
    h('a', { class: 'btn', href: '#/availability' }, 'Beschikbaarheid'));

  view.replaceChildren(calendarGrid(cal));
}

// Month grid used by the Agenda and the availability page. Click a time slot to open or
// close it for that day, or the button next to the date to block or free the whole day.
function calendarGrid(cal) {
  const today = todayIso();
  const setSlot = (d, s, open) => action(
    () => api(`/availability/overrides/${d.date}/${s.key}`, { method: 'PUT', body: JSON.stringify({ open }) }),
    `${fmtDate(d.date)}, ${SLOT_LABELS[s.key].toLowerCase()}: ${open ? 'open' : 'gesloten'}.`);
  const dayCell = (d) => {
    const past = d.date < today;
    return h('div', { class: `cal-cell ${d.blocked ? 'blocked' : ''} ${d.date === today ? 'today' : ''} ${past ? 'past' : ''}` },
      h('div', { class: 'cal-date' },
        h('span', {}, Number(d.date.slice(8)), d.blocked && h('span', { class: 'muted small' }, ` ${d.reason || 'geblokkeerd'}`)),
        !past && h('button', {
          type: 'button', class: 'cal-day-toggle',
          title: d.blocked ? 'Deze dag weer vrijgeven' : 'Deze hele dag blokkeren',
          'aria-label': `${fmtDate(d.date)}: ${d.blocked ? 'vrijgeven' : 'hele dag blokkeren'}`,
          onclick: action(() => d.blocked ? del(`/blocked-dates/${d.date}`) : api(`/blocked-dates/${d.date}`, { method: 'PUT', body: JSON.stringify({ reason: '' }) }),
            `${fmtDate(d.date)} ${d.blocked ? 'vrijgegeven' : 'geblokkeerd'}.`),
        }, d.blocked ? '↺' : '⊘')),
      d.slots.map((s) => {
        const bookings = d.bookings.filter((b) => b.timeSlot === s.key);
        const short = SLOT_LABELS[s.key].slice(0, 3);
        if (bookings.length) {
          return bookings.map((b) => h('a', {
            class: `cal-chip booked st-${b.status}`, href: `#/bookings/${b.id}`,
            title: `${STATUS_LABELS[b.status]} · ${b.packageName} · weg ${b.schedule.leave}, feest ${b.schedule.start}–${b.schedule.end}, thuis ${b.schedule.home}${b.schedule.travelKnown ? '' : ' (zonder reistijd)'}`,
          },
            `${b.startTime ?? short} ${b.childName || b.parentName} · ${b.city}`,
            // The whole block of the day, including the drive there and back.
            h('span', { class: 'cal-block' }, `${b.schedule.leave}–${b.schedule.home}${b.schedule.travelKnown ? '' : ' *'}`)));
        }
        if (d.blocked || past) return h('span', { class: 'cal-chip closed' }, `${short} –`);
        if (!s.open) return h('button', { type: 'button', class: 'cal-chip closed', title: 'Klik om dit dagdeel open te zetten', onclick: setSlot(d, s, true) }, `${short} –`);
        return h('button', { type: 'button', class: `cal-chip ${s.available ? 'free' : 'full'}`, title: 'Klik om dit dagdeel te sluiten', onclick: setSlot(d, s, false) },
          `${short} ${s.available ? 'vrij' : 'vol'}`);
      }));
  };
  const offset = (new Date(`${cal.month}-01T00:00:00Z`).getUTCDay() + 6) % 7;
  return h('div', {},
    h('div', { class: 'admin-cal' },
      ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'].map((w) => h('div', { class: 'cal-wd' }, w)),
      Array.from({ length: offset }, () => h('div', { class: 'cal-pad' })),
      cal.days.map(dayCell)),
    h('p', { class: 'muted small', style: 'margin-top:10px' },
      'Klik op een dagdeel om het open of dicht te zetten; ⊘ blokkeert de hele dag. Onder elk feest staat het hele blok van vertrek tot thuiskomst (* = reistijd nog niet bekend). ',
      badge('vrij', 'success'), ' te boeken · ', badge('geboekt', 'violet'), ' klik voor details · ', badge('aanvraag', 'warning'), ' nog niet bevestigd · grijs = gesloten'));
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

async function usersView() {
  const users = await api('/users');
  setPage('Gebruikers');
  const ROLES = { owner: 'Eigenaar', assistant: 'Assistent' };
  const newPassword = (u) => async () => {
    const password = prompt(`Nieuw wachtwoord voor ${u.email} (minimaal 12 tekens):`);
    if (!password) return false;
    await patchJson(`/users/${u.id}`, { password });
  };
  const table = card('Wie kan inloggen',
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Naam'), h('th', {}, 'E-mail'), h('th', {}, 'Rol'), h('th', {}, ''))),
      h('tbody', {}, users.map((u) => h('tr', {},
        h('td', {}, u.name || '–'),
        h('td', {}, u.email, u.id === me.id ? h('span', { class: 'muted small' }, ' (jij)') : null),
        h('td', {}, h('select', {
          'aria-label': 'Rol',
          disabled: u.id === me.id,
          onchange: action((e) => patchJson(`/users/${u.id}`, { role: e.target.value }), 'Rol gewijzigd.'),
        }, Object.entries(ROLES).map(([key, label]) => h('option', { value: key, selected: key === u.role }, label)))),
        h('td', { class: 'inline' },
          u.twoFactor ? badge('2 stappen', 'success') : badge('alleen wachtwoord', 'warning'),
          h('button', { class: 'btn small', onclick: action(newPassword(u), 'Wachtwoord gewijzigd. De gebruiker moet opnieuw inloggen.') }, 'Nieuw wachtwoord'),
          u.twoFactor && u.id !== me.id && h('button', { class: 'btn small', onclick: action(() => confirm(`Tweestapsverificatie van ${u.email} uitzetten? Doe dit alleen als die persoon de telefoon kwijt is.`) ? post(`/users/${u.id}/2fa-reset`) : false, 'Tweestapsverificatie uitgezet.') }, '2 stappen resetten'),
          u.id !== me.id && h('button', { class: 'btn small danger', onclick: action(() => confirm(`${u.email} verwijderen?`) ? del(`/users/${u.id}`) : false, 'Gebruiker verwijderd.') }, 'Verwijderen'))))))));
  const form = h('form', { class: 'card', onsubmit: action(() => post('/users', Object.fromEntries(new FormData(form))), 'Gebruiker toegevoegd.') },
    h('h2', {}, 'Gebruiker toevoegen'),
    h('div', { class: 'row' },
      field('Naam', h('input', { name: 'name', maxlength: 100 })),
      field('E-mail', h('input', { name: 'email', type: 'email', required: true })),
      field('Rol', h('select', { name: 'role' }, h('option', { value: 'assistant' }, 'Assistent'), h('option', { value: 'owner' }, 'Eigenaar')))),
    field('Wachtwoord (minimaal 12 tekens)', h('input', { name: 'password', type: 'password', required: true, minlength: 12, autocomplete: 'new-password' })),
    h('p', { class: 'muted small' }, 'Geef het wachtwoord persoonlijk door. De gebruiker kan het daarna zelf wijzigen via het e-mailadres linksonder.'),
    h('button', { class: 'btn primary', type: 'submit' }, 'Toevoegen'));
  view.replaceChildren(
    h('p', { class: 'muted' }, 'Een assistent kan boekingen en de agenda bekijken en de beschikbaarheid aanpassen. Berichten, prijzen, betalingen, pakketten en gebruikers zijn alleen voor eigenaren.'),
    table, form);
}

// Inventory: game stations, games and other gear. Passwords stay out of it.
const INV_KINDS = { station: 'Gamestations', game: 'Games', other: 'Overig materiaal', subscription: 'Abonnementen' };
const SUB_PERIOD = { '': '–', month: 'Per maand', year: 'Per jaar', once: 'Eenmalig' };
// How soon something runs out, as a badge.
function expiryBadge(date) {
  if (!date) return null;
  const days = Math.round((new Date(`${date}T00:00:00Z`) - new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)) / 864e5);
  if (days < 0) return badge(`Verlopen op ${fmtDate(date)}`, 'danger');
  if (days <= 14) return badge(days === 0 ? 'Verloopt vandaag' : `Nog ${days} ${days === 1 ? 'dag' : 'dagen'}`, 'warning');
  return h('span', {}, fmtDate(date));
}
const INV_STATUS = { in_use: ['In gebruik', 'success'], spare: ['Reserve', 'info'], broken: ['Defect', 'danger'], gone: ['Weg', ''] };
const GAME_SOURCE = { '': '–', free: 'Gratis', gamepass: 'Game Pass', bought: 'Gekocht', gamepass_or_bought: 'Game Pass of gekocht' };
// Per kind: the extra fields as [key, label, type].
const INV_FIELDS = {
  station: [['consoleSerial', 'Serienummer console'], ['controllerSerial', 'Serienummer controller'], ['accountEmail', 'Account (e-mail)'],
    ['gamertag', 'Xbox-gamertag'], ['epicName', 'Epic-naam'], ['otherAccounts', 'Andere accounts'], ['homeConsole', 'Thuis-Xbox van'],
    ['gamePass', 'Game Pass', 'check'], ['gamePassNote', 'Game Pass sinds / tot']],
  game: [['source', 'Herkomst', GAME_SOURCE]],
  other: [['category', 'Soort'], ['serial', 'Serienummer']],
  subscription: [['provider', 'Bij wie'], ['period', 'Betaling', SUB_PERIOD], ['autoRenew', 'Verlengt automatisch', 'check']],
};
// Whether the customer's details are being edited, and for which booking.
let contactEditing = false;
let contactEditingFor = null;
// Which checklist groups were opened or closed by hand, for the booking being looked at.
let taskGroups = { id: null, open: {} };
let invState = { kind: 'station', editing: null, selected: new Set() };

async function inventoryView() {
  const items = await api('/inventory');
  const kind = invState.kind;
  const list = items.filter((i) => i.kind === kind);
  const editing = invState.editing === 'new' ? { kind, name: '', quantity: 1, status: 'in_use', priceCents: null, details: {}, notes: '' }
    : items.find((i) => i.id === invState.editing) ?? null;
  // What runs out within two weeks, across all lists.
  const soon = items.filter((i) => i.expiresOn && i.status !== 'gone' && (new Date(`${i.expiresOn}T00:00:00Z`) - Date.now()) / 864e5 <= 14);

  // Reads the file here, in the browser: the file itself does not go to the server, and columns
  // with passwords are not read at all.
  const importInput = h('input', { type: 'file', accept: '.xlsx,.csv,.json', hidden: true, onchange: async () => {
    const file = importInput.files[0];
    importInput.value = '';
    if (!file) return;
    try {
      const { readInventoryFile, matchExisting } = await import('/admin/inventory-file.js');
      const found = await readInventoryFile(file);
      if (!found.items?.length) throw new Error('In dit bestand heb ik geen inventaris gevonden. Gebruik de kolommen uit "Exporteren", of je eigen lijst met een rij per station.');
      const list = matchExisting(found.items, items);
      const count = (k) => list.filter((i) => i.kind === k).length;
      const parts = Object.entries(INV_KINDS).filter(([k]) => count(k)).map(([k, label]) => `${count(k)} ${label.toLowerCase()}`);
      const note = found.skipped ? `\n\n${found.skipped} kolom(men) met wachtwoorden sla ik over; die horen in een wachtwoordmanager.` : '';
      if (!confirm(`Gevonden in ${file.name}: ${parts.join(', ')}.${note}\n\nWat al bestaat wordt bijgewerkt, de rest wordt toegevoegd. Doorgaan?`)) return;
      const r = await post('/inventory/import', { items: list });
      flash('ok', `${r.added} toegevoegd, ${r.updated} bijgewerkt.`);
      await render();
    } catch (err) {
      flash('error', err instanceof SyntaxError ? 'Dit bestand kan ik niet lezen.' : err.message);
    }
  } });
  const exportList = async () => {
    const { inventoryCsv } = await import('/admin/inventory-file.js');
    const link = h('a', { href: URL.createObjectURL(new Blob([inventoryCsv(items)], { type: 'text/csv' })), download: 'inventaris.csv' });
    link.click();
    URL.revokeObjectURL(link.href);
  };
  setPage('Inventaris',
    h('button', { class: 'btn', onclick: exportList }, 'Exporteren'),
    h('button', { class: 'btn', onclick: () => importInput.click() }, 'Importeren'),
    h('button', { class: 'btn primary', onclick: () => { invState.editing = 'new'; render(); } }, '+ Toevoegen'));

  const tabs = h('div', { class: 'tabs page-tabs' }, Object.entries(INV_KINDS).map(([k, label]) =>
    h('button', { type: 'button', class: k === kind ? 'on' : '', onclick: () => { invState = { kind: k, editing: null, selected: new Set() }; render(); } },
      `${label} (${items.filter((i) => i.kind === k).length})`)));

  const total = kind === 'subscription'
    ? list.reduce((sum, i) => sum + (i.priceCents ?? 0) * ({ month: 12, year: 1 }[i.details.period] ?? 0), 0)
    : list.reduce((sum, i) => sum + (i.priceCents ?? 0) * (kind === 'game' ? 1 : i.quantity), 0);
  const headers = ['', ...{ station: ['Station', 'Console', 'Controller', 'Account', 'Gamertag', 'Game Pass', 'Status', ''],
    game: ['Game', 'Herkomst', 'Aankoopprijs', 'Notitie', ''], other: ['Wat', 'Soort', 'Aantal', 'Aankoopprijs', 'Status', ''],
    subscription: ['Abonnement', 'Bij wie', 'Kosten', 'Loopt tot', 'Verlengt', ''] }[kind]];

  // Tick several rows to change them in one go.
  const selected = invState.selected;
  for (const id of [...selected]) if (!list.some((i) => i.id === id)) selected.delete(id);
  const boxes = new Map();
  const pick = (i) => {
    const box = h('input', { type: 'checkbox', checked: selected.has(i.id), 'aria-label': `${i.name} selecteren`, onchange: () => {
      if (box.checked) selected.add(i.id); else selected.delete(i.id);
      box.closest('tr').classList.toggle('picked', box.checked);
      refreshBulk();
    } });
    boxes.set(i.id, box);
    return h('td', { class: 'pick' }, h('label', {}, box));
  };
  const bulkBar = h('div', { class: 'bulk-bar' });
  const travels = kind === 'station' || kind === 'other';
  const bulkActions = [
    kind !== 'game' && kind !== 'subscription' && ['status', 'Status wijzigen'],
    kind === 'station' && ['gamepass-on', 'Game Pass verlengd'],
    kind === 'station' && ['gamepass-off', 'Game Pass gestopt'],
    kind === 'subscription' && ['expires', 'Einddatum zetten'],
    travels && ['party', 'Meegeweest naar een feest'],
    ['delete', 'Verwijderen'],
  ].filter(Boolean);
  let bulkAction = bulkActions[0][0];
  let partyOptions = null;
  function refreshBulk() {
    const all = list.length > 0 && selected.size === list.length;
    const toggleAll = h('button', { class: 'btn small', type: 'button', onclick: () => {
      for (const i of list) { if (all) selected.delete(i.id); else selected.add(i.id); }
      for (const [id, box] of boxes) { box.checked = selected.has(id); box.closest('tr').classList.toggle('picked', box.checked); }
      refreshBulk();
    } }, all ? 'Niets selecteren' : 'Alles selecteren');
    if (!selected.size) {
      bulkBar.replaceChildren(h('span', { class: 'muted small' }, 'Vink regels aan om er meerdere tegelijk te wijzigen.'), toggleAll);
      return;
    }
    const choice = h('select', { 'aria-label': 'Wat wil je doen?', onchange: () => { bulkAction = choice.value; refreshBulk(); } },
      bulkActions.map(([value, label]) => h('option', { value, selected: value === bulkAction }, label)));
    const status = h('select', { 'aria-label': 'Nieuwe status' }, Object.entries(INV_STATUS).map(([value, [label]]) => h('option', { value }, label)));
    const until = h('input', { type: 'date', 'aria-label': 'Loopt tot' });
    const party = h('select', { 'aria-label': 'Welk feest' }, h('option', { value: '' }, 'Feesten laden…'));
    const extra = { status: [status], 'gamepass-on': [h('span', { class: 'muted small' }, 'loopt tot'), until], expires: [until], party: [party] }[bulkAction] ?? [];
    if (bulkAction === 'party') {
      (partyOptions ??= api('/bookings').then((all) => all.filter((b) => b.status !== 'cancelled').sort((a, b) => b.partyDate.localeCompare(a.partyDate)))).then((bookings) => {
        party.replaceChildren(h('option', { value: '' }, bookings.length ? 'Kies het feest…' : 'Nog geen boekingen'),
          ...bookings.map((b) => h('option', { value: b.id }, `${fmtDate(b.partyDate)} · ${b.parentName} · ${b.city}`)));
      });
    }
    const apply = h('button', { class: bulkAction === 'delete' ? 'btn danger' : 'btn primary', type: 'button', onclick: action(async () => {
      const ids = [...selected];
      const n = `${ids.length} ${ids.length === 1 ? 'regel' : 'regels'}`;
      let body;
      if (bulkAction === 'status') body = { action: 'status', status: status.value };
      else if (bulkAction === 'gamepass-on') body = { action: 'gamepass', gamePass: true, expiresOn: until.value, note: until.value ? '' : `Verlengd op ${fmtDate(new Date().toISOString().slice(0, 10))}` };
      else if (bulkAction === 'gamepass-off') body = { action: 'gamepass', gamePass: false, expiresOn: '' };
      else if (bulkAction === 'expires') body = { action: 'expires', expiresOn: until.value };
      else if (bulkAction === 'party') {
        if (!party.value) throw new Error('Kies eerst het feest.');
        body = { action: 'party', bookingId: party.value };
      } else {
        if (!confirm(`${n} uit de inventaris verwijderen? Dit kan niet ongedaan worden.`)) return false;
        body = { action: 'delete' };
      }
      await post('/inventory/bulk', { ...body, ids });
      selected.clear();
    }, 'Bijgewerkt.') }, bulkAction === 'delete' ? 'Verwijderen' : 'Toepassen');
    bulkBar.replaceChildren(h('strong', {}, `${selected.size} geselecteerd`), choice, ...extra, apply, toggleAll);
  }
  refreshBulk();
  const statusCell = (i) => h('td', {}, badge(INV_STATUS[i.status][0], INV_STATUS[i.status][1]));
  const actions = (i) => h('td', { class: 'inline' },
    (kind === 'station' || kind === 'other') && h('button', { class: 'btn small', onclick: () => showHistory(i) }, 'Waar geweest'),
    h('button', { class: 'btn small', onclick: () => { invState.editing = i.id; render(); } }, 'Wijzigen'));
  const price = (i) => (i.priceCents === null ? '–' : euro.format(i.priceCents / 100));
  const cells = {
    station: (i) => [h('td', {}, h('strong', {}, i.name), i.notes && h('div', { class: 'muted small' }, i.notes)), h('td', {}, i.details.consoleSerial || '–'),
      h('td', {}, i.details.controllerSerial || '–'), h('td', {}, i.details.accountEmail || '–'), h('td', {}, i.details.gamertag || '–'),
      h('td', {}, i.details.gamePass ? (i.expiresOn ? expiryBadge(i.expiresOn) : badge(i.details.gamePassNote ? `Ja · ${i.details.gamePassNote}` : 'Ja', 'success')) : 'Nee'), statusCell(i), actions(i)],
    game: (i) => [h('td', {}, h('strong', {}, i.name)), h('td', {}, GAME_SOURCE[i.details.source ?? '']), h('td', {}, price(i)), h('td', {}, i.notes || '–'), actions(i)],
    other: (i) => [h('td', {}, h('strong', {}, i.name), i.notes && h('div', { class: 'muted small' }, i.notes)), h('td', {}, i.details.category || '–'),
      h('td', {}, String(i.quantity)), h('td', {}, price(i)), statusCell(i), actions(i)],
    subscription: (i) => [h('td', {}, h('strong', {}, i.name), i.notes && h('div', { class: 'muted small' }, i.notes)), h('td', {}, i.details.provider || '–'),
      h('td', {}, i.priceCents === null ? '–' : `${price(i)}${{ month: ' p/m', year: ' p/j' }[i.details.period] ?? ''}`),
      h('td', {}, expiryBadge(i.expiresOn) ?? '–'), h('td', {}, i.details.autoRenew ? 'Automatisch' : 'Handmatig'), actions(i)],
  }[kind];

  const history = h('div', {});
  async function showHistory(i) {
    const rows = await api(`/inventory/${i.id}/history`);
    history.replaceChildren(card(`Waar is ${i.name} geweest?`,
      rows.length
        ? table(['Datum', 'Klant', 'Plaats', 'Fase'], rows.map((r) => h('tr', { class: 'clickable', onclick: () => (location.hash = `#/bookings/${r.id}`) },
            h('td', {}, fmtDate(r.partyDate)), h('td', {}, `${r.parentName} · ${r.reference}`), h('td', {}, r.city), h('td', {}, statusBadge(r.status)))))
        : h('p', { class: 'muted' }, 'Nog bij geen enkel feest aangevinkt. Dat doe je in een boeking, onder "Checklist en tijdlijn".')));
    history.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  let form = null;
  if (editing) {
    const control = ([key, label, type]) => {
      const value = editing.details?.[key];
      if (type === 'check') return h('label', { class: 'check', style: 'align-self:end' }, h('input', { type: 'checkbox', name: `d.${key}`, checked: Boolean(value) }), ` ${label}`);
      if (type && typeof type === 'object') return field(label, h('select', { name: `d.${key}` }, Object.entries(type).map(([v, l]) => h('option', { value: v, selected: (value ?? '') === v }, l))));
      return field(label, h('input', { name: `d.${key}`, value: value ?? '', maxlength: 200 }));
    };
    form = h('form', { class: 'card', onsubmit: action(async () => {
      const data = new FormData(form);
      const details = {};
      for (const [key, , type] of INV_FIELDS[kind]) details[key] = type === 'check' ? form.elements[`d.${key}`].checked : data.get(`d.${key}`) ?? '';
      const priceText = String(data.get('price') ?? '').trim().replace(',', '.');
      const body = { kind, name: data.get('name'), quantity: Number(data.get('quantity') ?? 1) || 0, status: data.get('status') ?? 'in_use',
        priceCents: priceText === '' ? null : Math.round(Number(priceText) * 100), details, notes: data.get('notes') ?? '', expiresOn: data.get('expiresOn') || null };
      if (Number.isNaN(body.priceCents)) throw new Error('Vul bij de prijs een bedrag in, bijvoorbeeld 19,95.');
      if (editing.id) await patchJson(`/inventory/${editing.id}`, body);
      else await post('/inventory', body);
      invState.editing = null;
    }, 'Opgeslagen.') },
      h('h2', {}, editing.id ? `${editing.name} wijzigen` : `Toevoegen aan ${INV_KINDS[kind].toLowerCase()}`),
      h('div', { class: 'row', style: 'grid-template-columns:repeat(auto-fit,minmax(200px,1fr))' },
        field(kind === 'station' ? 'Naam of nummer' : 'Naam', h('input', { name: 'name', required: true, maxlength: 200, value: editing.name })),
        (kind === 'station' || kind === 'other') && field('Aantal', h('input', { name: 'quantity', type: 'number', min: 0, value: editing.quantity })),
        kind !== 'game' && field('Status', h('select', { name: 'status' }, Object.entries(INV_STATUS).map(([v, [l]]) => h('option', { value: v, selected: editing.status === v }, l)))),
        (kind === 'subscription' || kind === 'station') && field(kind === 'station' ? 'Game Pass loopt tot' : 'Loopt tot', h('input', { name: 'expiresOn', type: 'date', value: editing.expiresOn ?? '' }),
          'Je krijgt 14 en 3 dagen vooraf een melding.'),
        field(kind === 'subscription' ? 'Kosten (€)' : 'Aankoopprijs (€)', h('input', { name: 'price', inputmode: 'decimal', placeholder: 'bijv. 19,95', value: editing.priceCents === null ? '' : euroInput(editing.priceCents) })),
        ...INV_FIELDS[kind].map(control)),
      field('Notitie', h('textarea', { name: 'notes', rows: 2, maxlength: 2000 }, editing.notes)),
      h('p', { class: 'muted small' }, 'Zet hier geen wachtwoorden in. Die horen in een wachtwoordmanager.'),
      h('div', { class: 'inline' },
        h('button', { class: 'btn primary', type: 'submit' }, 'Opslaan'),
        h('button', { class: 'btn', type: 'button', onclick: () => { invState.editing = null; render(); } }, 'Annuleren'),
        editing.id && h('button', { class: 'btn danger', type: 'button', style: 'margin-left:auto', onclick: action(async () => {
          if (!confirm(`${editing.name} uit de inventaris verwijderen?`)) return false;
          await del(`/inventory/${editing.id}`);
          invState.editing = null;
        }, 'Verwijderd.') }, 'Verwijderen')));
  }

  const soonCard = soon.length ? card('Verloopt binnenkort', soon.map((i) => h('div', { class: 'status-row' },
    h('div', {}, h('strong', {}, i.kind === 'station' ? `Game Pass van ${i.name}` : i.name)), expiryBadge(i.expiresOn)))) : null;
  view.replaceChildren(...[
    importInput, soonCard, tabs, form,
    card(null, list.length > 0 && bulkBar, table(headers, list.map((i) => h('tr', { class: selected.has(i.id) ? 'picked' : '' }, pick(i), cells(i))), 'Nog niets in deze lijst. Voeg iets toe of importeer een Excel- of CSV-bestand.'),
      total > 0 && h('p', { class: 'muted small', style: 'margin-top:10px' },
        kind === 'subscription' ? `Vaste kosten per jaar: ${euro.format(total / 100)}` : `Aankoopwaarde in deze lijst: ${euro.format(total / 100)}`)),
    history,
  ].filter(Boolean));
}

async function systemView(fresh) {
  const status = await api(fresh ? '/status?fresh=1' : '/status');
  setPage('Systeem', h('button', { class: 'btn', onclick: async () => { flash('ok', 'Bezig met controleren…'); await systemView(true); updateCounts(); } }, '↻ Opnieuw controleren'));
  const TONE = { ok: ['Werkt', 'success'], warn: ['Let op', 'warning'], error: ['Storing', 'danger'], off: ['Niet ingesteld', ''] };
  // A real test: does a mail arrive, and a notification on the phones?
  const testResult = h('div', {});
  const testButton = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
    testButton.disabled = true;
    try {
      const r = await post('/system/test');
      const lines = [
        r.mailed.length ? `E-mail verstuurd naar ${r.mailed.join(', ')}. Kijk of hij aankomt (ook in spam).` : 'Er is geen e-mail verstuurd.',
        r.failed.length && `E-mail mislukt naar ${r.failed.join(', ')}. Kijk hierboven bij "Verbindingen" of e-mail werkt.`,
        r.devices
          ? `Melding verstuurd naar ${r.pushed} van de ${r.devices} aangemelde ${r.devices === 1 ? 'apparaat' : 'apparaten'}.${r.pushed < r.devices ? ' Een apparaat dat niets kreeg is afgemeld; zet meldingen daar opnieuw aan.' : ''}`
          : 'Geen melding verstuurd: er is nog geen apparaat aangemeld. Zet meldingen aan onder "Meldingen en account".',
      ].filter(Boolean);
      testResult.replaceChildren(...lines.map((line) => h('p', { class: 'muted', style: 'margin:8px 0 0' }, line)));
    } catch (err) {
      flash('error', err.message);
    }
    testButton.disabled = false;
  } }, 'Testbericht en testmelding sturen');
  const testCard = me.role === 'owner' && card('Testen',
    h('p', { class: 'muted' }, 'Stuurt een testmail naar iedereen die kan inloggen en een testmelding naar alle apparaten van eigenaren waar meldingen aan staan.'),
    testButton, testResult);
  view.replaceChildren(
    h('p', { class: 'muted' }, `Laatst gecontroleerd: ${fmtDateTime(status.checkedAt)}. De controle draait elke tien minuten vanzelf.`),
    card('Verbindingen', status.checks.map((c) => h('div', { class: 'status-row' },
      h('div', {}, h('strong', {}, c.label), h('div', { class: 'muted small' }, c.detail)),
      badge(TONE[c.state][0], TONE[c.state][1])))),
    testCard);
}

// Notifications on this device ---------------------------------------------------

const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const pushRegistration = () => navigator.serviceWorker.register('/admin/sw.js', { scope: '/admin/' });
const keyBytes = (base64) => Uint8Array.from(atob(base64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function enablePush() {
  if ((await Notification.requestPermission()) !== 'granted') {
    throw new Error('Meldingen zijn geblokkeerd voor deze site. Sta ze toe in de instellingen van je browser.');
  }
  const registration = await pushRegistration();
  await navigator.serviceWorker.ready;
  const { publicKey } = await api('/push/key');
  const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  const { endpoint, keys } = subscription.toJSON();
  await post('/push/subscribe', { endpoint, keys, device: navigator.userAgent.slice(0, 200) });
}

async function disablePush() {
  const subscription = await (await pushRegistration()).pushManager.getSubscription();
  if (!subscription) return;
  await post('/push/unsubscribe', { endpoint: subscription.endpoint });
  await subscription.unsubscribe();
}

async function pushCard() {
  const box = h('section', { class: 'card', style: 'max-width:480px' }, h('h2', {}, 'Meldingen op dit apparaat'));
  if (!pushSupported) {
    box.append(h('p', { class: 'muted' }, 'Deze browser ondersteunt geen meldingen. Op een iPhone of iPad: open de admin in Safari, kies Deel > "Zet op beginscherm" en open de admin daarna vanaf het beginscherm.'));
    return box;
  }
  const subscription = await (await pushRegistration()).pushManager.getSubscription().catch(() => null);
  box.append(
    h('p', { class: 'muted' }, me.role === 'owner'
      ? 'Krijg een melding bij een nieuwe aanvraag, een bericht of e-mail van een klant en een online betaling. Je stelt dit per apparaat in.'
      : 'Meldingen over aanvragen, berichten en betalingen gaan naar eigenaren. Je kunt hier wel testen of meldingen op dit apparaat werken.'),
    subscription
      ? h('div', { class: 'inline' },
          badge('Aan op dit apparaat', 'success'),
          h('button', { class: 'btn', onclick: action(async () => { const r = await post('/push/test'); if (!r.sent) throw new Error('Er kon geen testmelding worden verstuurd.'); }, 'Testmelding verstuurd.') }, 'Testmelding'),
          h('button', { class: 'btn', onclick: action(disablePush, 'Meldingen uitgezet op dit apparaat.') }, 'Uitzetten'))
      : h('button', { class: 'btn primary', onclick: action(enablePush, 'Meldingen staan aan op dit apparaat.') }, 'Meldingen aanzetten'));
  return box;
}

// Devices that skip the second step for 30 days.
function devicesCard() {
  if (!me.trustedDevices) return null;
  return h('section', { class: 'card', style: 'max-width:480px' },
    h('h2', {}, 'Onthouden apparaten'),
    h('p', {}, me.trustedDevices === 1
      ? 'Op 1 apparaat hoef je 30 dagen geen tweede stap te doen.'
      : `Op ${me.trustedDevices} apparaten hoef je 30 dagen geen tweede stap te doen.`),
    h('p', { class: 'muted small' }, 'Telefoon of laptop kwijt? Laat alle apparaten vergeten; bij de volgende login is de tweede stap weer nodig.'),
    h('button', { class: 'btn', onclick: action(async () => {
      await post('/me/devices/forget');
      try { localStorage.removeItem(DEVICE_KEY); } catch {}
    }, 'Alle apparaten zijn vergeten.') }, 'Alle apparaten vergeten'));
}

// Two-step login: set up, show backup codes once, or switch off.
function twoFactorCard() {
  const box = h('section', { class: 'card', style: 'max-width:480px' }, h('h2', {}, 'Tweestapsverificatie'));
  if (me.twoFactor) {
    const off = h('form', { class: 'inline', onsubmit: action(() => post('/me/2fa/disable', { password: off.elements.password.value }), 'Tweestapsverificatie uitgezet.') },
      field('Je wachtwoord', h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password' })),
      h('button', { class: 'btn danger', type: 'submit' }, 'Uitzetten'));
    box.append(h('p', {}, badge('Aan', 'success'), ' Bij het inloggen vraagt de admin om een code uit je authenticator-app.'),
      h('details', { class: 'collapsible' }, h('summary', {}, 'Uitzetten'), h('div', { style: 'margin-top:10px' }, off)));
    return box;
  }
  const start = h('button', { class: 'btn primary', onclick: async () => {
    try {
      const { secret, qrSvg } = await post('/me/2fa/setup');
      const qr = h('div', { class: 'qr-code', style: 'background:#fff;padding:8px;border-radius:8px;max-width:240px' });
      qr.innerHTML = qrSvg;
      const confirmForm = h('form', { class: 'inline', onsubmit: async (e) => {
        e.preventDefault();
        try {
          const { recoveryCodes } = await post('/me/2fa/enable', { code: confirmForm.elements.code.value });
          box.replaceChildren(h('h2', {}, 'Tweestapsverificatie staat aan'),
            h('p', {}, h('strong', {}, 'Bewaar deze back-upcodes nu.'), ' Je ziet ze maar één keer. Met elke code kun je één keer inloggen als je je telefoon niet bij de hand hebt.'),
            h('pre', { class: 'codes' }, recoveryCodes.join('\n')),
            h('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(recoveryCodes.join('\n')); flash('ok', 'Back-upcodes gekopieerd.'); } catch { flash('error', 'Kopiëren lukte niet; schrijf ze over.'); } } }, 'Kopiëren'),
            h('button', { class: 'btn primary', style: 'margin-left:8px', onclick: () => render() }, 'Ik heb ze bewaard'));
        } catch (err) { flash('error', err.message); }
      } },
        field('Code uit de app', h('input', { name: 'code', required: true, inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 10, style: 'width:120px' })),
        h('button', { class: 'btn primary', type: 'submit' }, 'Aanzetten'));
      box.replaceChildren(h('h2', {}, 'Tweestapsverificatie instellen'),
        h('ol', {},
          h('li', {}, 'Open een authenticator-app op je telefoon, bijvoorbeeld Google Authenticator of Microsoft Authenticator.'),
          h('li', {}, 'Scan deze QR-code met de app.'),
          h('li', {}, 'Vul hieronder de code van 6 cijfers in die de app toont.')),
        qr,
        h('p', { class: 'muted small' }, 'Lukt scannen niet? Typ deze sleutel in de app: ', h('code', {}, secret)),
        confirmForm);
    } catch (err) { flash('error', err.message); }
  } }, 'Instellen');
  box.append(me.emailConfigured
      ? h('p', {}, badge('Via e-mail', 'info'), ' Na je wachtwoord sturen we nu een inloglink en code naar je e-mailadres.')
      : h('p', {}, badge('Uit', 'warn'), ' Inloggen gaat nu met alleen je wachtwoord.'),
    h('p', { class: 'muted' }, 'Sterker en sneller is een authenticator-app: dan vraagt de admin om een code van je telefoon en hoef je niet op een mail te wachten.'), start);
  return box;
}

// Mailing ----------------------------------------------------------------------

// Names and addresses out of pasted text or the rows of a file: one person per line, as
// "Naam <adres>", "Naam; adres", "adres; Naam" or just an address.
function contactsFrom(lines) {
  const found = [];
  for (const line of lines) {
    const cells = (Array.isArray(line) ? line : String(line).split(/[;,\t<>]/)).map((c) => String(c ?? '').trim()).filter(Boolean);
    const email = cells.find((c) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c));
    if (!email) continue;
    found.push({ email, name: cells.filter((c) => c !== email && !c.includes('@')).join(' ').slice(0, 100) });
  }
  return found;
}

let mailingDraft = {
  subject: 'Bedankt voor 2026, en een cadeautje voor 2027 🎮',
  body: 'Hoi {voornaam},\n\nDit jaar mocht ik bij jullie een gamefeestje verzorgen. Dank je wel daarvoor; het was een mooi jaar, mede dankzij jullie.\n\nAls bedankje krijg je 10% korting op een gamefeestje in 2027. Noem bij het reserveren de code NIEUWJAAR10.\n\nFijne feestdagen en een goed nieuwjaar!\n\nGroetjes, Ronald – Gamer Xperience',
};

async function mailingView() {
  const [contacts, mailings] = await Promise.all([api('/mailing/contacts'), api('/mailings')]);
  setPage('Mailing');
  const active = contacts.filter((c) => !c.unsubscribedAt);
  const running = mailings.find((m) => !m.finishedAt);

  const added = (r) => `${r.added} toegevoegd${r.known ? `, ${r.known} stonden er al` : ''}${r.invalid?.length ? `. Niet herkend als adres: ${r.invalid.slice(0, 5).join(', ')}` : ''}.`;
  const addContacts = async (list) => {
    if (!list.length) throw new Error('Ik vind hier geen e-mailadressen in.');
    flash('ok', added(await post('/mailing/contacts', { contacts: list })));
  };
  const paste = h('textarea', { rows: 4, placeholder: 'Eén per regel, bijvoorbeeld:\nJan Jansen <jan@voorbeeld.nl>\nPiet de Vries; piet@voorbeeld.nl' });
  const fileInput = h('input', { type: 'file', accept: '.xlsx,.csv,.txt', hidden: true, onchange: action(async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return false;
    const { readRows } = await import('/admin/inventory-file.js');
    await addContacts(contactsFrom(await readRows(file)));
  }) });
  const year = new Date().getFullYear();
  const listCard = card(cardHead('Wie krijgt de mailing', h('span', { class: 'muted' }, `${active.length} ${active.length === 1 ? 'adres' : 'adressen'}`)),
    h('p', { class: 'muted' }, 'Voeg hier iedereen toe die je wilt bedanken, ook klanten zonder boeking of factuur in de admin. Een adres komt er maar één keer in.'),
    field('Namen en adressen plakken', paste),
    h('div', { class: 'inline', style: 'margin-bottom:14px' },
      h('button', { class: 'btn primary', type: 'button', onclick: action(() => addContacts(contactsFrom(paste.value.split(/\n/)))) }, 'Toevoegen'),
      fileInput,
      h('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, 'Excel of CSV inladen'),
      h('button', { class: 'btn', type: 'button', onclick: action(async () => { flash('ok', added(await post('/mailing/contacts/from-bookings', { year }))); }) }, `Klanten uit boekingen van ${year}`)),
    table(['Naam', 'E-mail', 'Herkomst', 'Status', ''], contacts.map((c) => h('tr', {},
      h('td', {}, c.name || h('span', { class: 'muted' }, 'geen naam')),
      h('td', {}, c.email),
      h('td', {}, c.note || (c.bookings ? `${c.bookings} boeking(en)` : 'Zelf toegevoegd')),
      h('td', {}, c.unsubscribedAt ? badge('Afgemeld', 'danger') : badge('Krijgt mail', 'success')),
      h('td', { class: 'inline' },
        h('button', { class: 'btn small', onclick: action(async () => {
          const name = prompt(`Naam voor ${c.email}:`, c.name);
          if (name === null) return false;
          await patchJson(`/mailing/contacts/${c.id}`, { name });
        }) }, 'Naam'),
        h('button', { class: 'btn small', onclick: action(() => patchJson(`/mailing/contacts/${c.id}`, { subscribed: Boolean(c.unsubscribedAt) })) }, c.unsubscribedAt ? 'Weer aanmelden' : 'Afmelden'),
        h('button', { class: 'btn small danger', onclick: action(() => (confirm(`${c.email} van de lijst halen?`) ? del(`/mailing/contacts/${c.id}`) : false)) }, '✕')))),
      'Nog niemand op de lijst.'));

  const form = h('form', { class: 'card', onsubmit: (e) => e.preventDefault() },
    h('h2', {}, 'Bericht'),
    field('Onderwerp', h('input', { name: 'subject', required: true, maxlength: 200, value: mailingDraft.subject })),
    field('Tekst', h('textarea', { name: 'body', rows: 12, required: true }, mailingDraft.body),
      '{voornaam} wordt per klant ingevuld. Onder elke mail komt vanzelf een afmeldlink.'),
    h('div', { class: 'inline' },
      h('button', { class: 'btn', type: 'button', onclick: action(async () => {
        keep();
        const r = await post('/mailings/test', mailingDraft);
        flash('ok', `Testmail verstuurd naar ${r.to}. Kijk hoe hij eruitziet voordat je verstuurt.`);
        return false;
      }) }, 'Testmail naar mezelf'),
      h('button', { class: 'btn primary', type: 'button', disabled: Boolean(running) || !active.length, onclick: action(async () => {
        keep();
        if (!confirm(`Deze mail versturen naar ${active.length} ${active.length === 1 ? 'adres' : 'adressen'}?\n\nOnderwerp: ${mailingDraft.subject}\n\nDit kan niet worden teruggedraaid.`)) return false;
        const r = await post('/mailings', mailingDraft);
        flash('ok', `De mailing gaat de deur uit naar ${r.recipients} adressen. Dat duurt een paar minuten.`);
      }) }, running ? 'Er wordt al verstuurd…' : `Versturen naar ${active.length} ${active.length === 1 ? 'adres' : 'adressen'}`)));
  const keep = () => { mailingDraft = { subject: form.elements.subject.value, body: form.elements.body.value }; };
  form.addEventListener('input', keep);

  const history = mailings.length > 0 && card('Verstuurd',
    table(['Wanneer', 'Onderwerp', 'Verstuurd', 'Mislukt', 'Status'], mailings.map((m) => h('tr', {},
      h('td', { class: 'nowrap' }, fmtDateTime(m.createdAt)), h('td', {}, m.subject), h('td', {}, String(m.sent)), h('td', {}, String(m.failed)),
      h('td', {}, m.finishedAt ? badge('Klaar', 'success') : badge(`Bezig, nog ${m.queued}`, 'warning'))))));

  view.replaceChildren(...[listCard, form, history].filter(Boolean));
  // While a mailing is going out, show the progress.
  if (running) setTimeout(() => { if (location.hash.startsWith('#/mailing')) render(); }, 5000);
}

// Name and photo: shown instead of the e-mail address wherever it says who did something.
function profileCard() {
  let avatar; // undefined = unchanged, '' = removed, else the new picture
  const preview = h('img', { class: 'profile-photo', src: me.avatar || '', alt: '', hidden: !me.avatar });
  const file = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: async () => {
    const picked = file.files[0];
    file.value = '';
    if (!picked) return;
    try {
      // Cut to a square and made small here, so only a tiny picture is stored.
      const image = await createImageBitmap(picked);
      const side = Math.min(image.width, image.height);
      const canvas = Object.assign(document.createElement('canvas'), { width: 128, height: 128 });
      canvas.getContext('2d').drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, 128, 128);
      avatar = canvas.toDataURL('image/jpeg', 0.85);
      preview.src = avatar;
      preview.hidden = false;
      remove.hidden = false;
    } catch {
      flash('error', 'Deze foto kan ik niet lezen. Kies een jpg of png.');
    }
  } });
  const remove = h('button', { class: 'btn', type: 'button', hidden: !me.avatar, onclick: () => { avatar = ''; preview.hidden = true; remove.hidden = true; } }, 'Foto weghalen');
  const form = h('form', { class: 'card', style: 'max-width:480px', onsubmit: action(async () => {
    await post('/me/profile', { name: form.elements.name.value, ...(avatar === undefined ? {} : { avatar }) });
    await loadStaff();
  }, 'Profiel opgeslagen.') },
    h('h2', {}, 'Profiel'),
    h('p', { class: 'muted' }, 'Je naam en foto staan bij wat je in de admin doet, bijvoorbeeld op de tijdlijn van een boeking.'),
    field('Naam', h('input', { name: 'name', maxlength: 100, value: me.name ?? '', placeholder: 'Bijv. Ronald', autocomplete: 'name' })),
    h('div', { class: 'inline', style: 'margin-bottom:14px' }, preview, file,
      h('button', { class: 'btn', type: 'button', onclick: () => file.click() }, 'Foto kiezen'), remove),
    h('button', { class: 'btn primary', type: 'submit' }, 'Opslaan'));
  return form;
}

async function accountView() {
  setPage('Mijn account');
  const form = h('form', { class: 'card', style: 'max-width:480px', onsubmit: action(async () => {
    const d = Object.fromEntries(new FormData(form));
    if (d.password !== d.repeat) throw new Error('De twee nieuwe wachtwoorden zijn niet gelijk.');
    await post('/me/password', { current: d.current, password: d.password });
  }, 'Wachtwoord gewijzigd.') },
    h('h2', {}, 'Wachtwoord wijzigen'),
    h('p', { class: 'muted' }, `Ingelogd als ${me.email}.`),
    field('Huidig wachtwoord', h('input', { name: 'current', type: 'password', required: true, autocomplete: 'current-password' })),
    field('Nieuw wachtwoord (minimaal 12 tekens)', h('input', { name: 'password', type: 'password', required: true, minlength: 12, autocomplete: 'new-password' })),
    field('Herhaal nieuw wachtwoord', h('input', { name: 'repeat', type: 'password', required: true, minlength: 12, autocomplete: 'new-password' })),
    h('button', { class: 'btn primary', type: 'submit' }, 'Opslaan'));
  view.replaceChildren(...[profileCard(), twoFactorCard(), devicesCard(), await pushCard(), form].filter(Boolean));
}

// Assistants can look at bookings but not change them: switch the controls off.
function lockView() {
  // The tabs stay usable: looking around is allowed.
  for (const el of [...view.querySelectorAll('button:not(.page-tabs button), input, select, textarea'), ...topbarActions.querySelectorAll('button')]) el.disabled = true;
  view.prepend(h('p', { class: 'muted' }, 'Je kunt boekingen bekijken. Wijzigen kan alleen een eigenaar.'));
}

// Router -------------------------------------------------------------------------

// The logged-in user: { id, email, name, role, ... }.
let me = null;
// Everyone who works here, by e-mail address: what someone did is stored by address and shown by name.
let staff = new Map();
async function loadStaff() {
  staff = new Map((await api('/staff')).map((s) => [s.email, s]));
}
function who(actor) {
  const person = staff.get(actor);
  if (!person) return actor;
  return h('span', { class: 'who', title: actor }, person.avatar && h('img', { src: person.avatar, alt: '' }), person.name || actor);
}

async function updateCounts() {
  try {
    const o = await api('/overview');
    const set = (id, n) => {
      const el = document.getElementById(id);
      el.textContent = n;
      el.hidden = !n;
    };
    set('count-messages', o.messagesWaiting);
    set('count-reviews', o.reviewsToRequest);
    set('count-system', o.systemProblems);
  } catch {}
}

async function render() {
  const linkToken = location.hash.startsWith('#/inloggen') ? new URLSearchParams(location.hash.split('?')[1] || '').get('t') : null;
  if (linkToken && !getToken()) return loginFromLink(linkToken);
  if (!getToken()) return loginView();
  sidebar.hidden = false;
  topbar.hidden = false;
  sidebar.classList.remove('open');
  try {
    me = await api('/me');
  } catch (err) {
    return flash('error', err.message);
  }
  const assistant = me.role === 'assistant';
  document.getElementById('me').textContent = me.name || me.email;
  const photo = document.getElementById('me-photo');
  photo.hidden = !me.avatar;
  if (me.avatar) photo.src = me.avatar;
  if (!staff.size) await loadStaff().catch(() => {});
  for (const el of document.querySelectorAll('[data-owner]')) el.hidden = assistant;
  const [path] = location.hash.slice(1).split('?');
  const parts = (path || '/board').split('/').filter(Boolean);
  const ownerOnly = ['messages', 'reviews', 'packages', 'users', 'system'];
  if (assistant && ownerOnly.includes(parts[0])) parts[0] = 'board';
  for (const a of document.querySelectorAll('.side-nav a')) {
    a.classList.toggle('active', a.dataset.route === parts[0] || (a.dataset.route === 'list' && parts[0] === 'bookings'));
  }
  updateCounts();
  try {
    if (parts[0] === 'bookings' && parts[1] === 'new') await newBookingView();
    else if (parts[0] === 'bookings' && parts[1]) await bookingDetailView(parts[1]);
    else if (parts[0] === 'list') await listView();
    else if (parts[0] === 'calendar') await calendarView();
    else if (parts[0] === 'messages') await messagesView(parts[1] ? Number(parts[1]) : null);
    else if (parts[0] === 'reviews') await reviewsView();
    else if (parts[0] === 'availability') await availabilityView();
    else if (parts[0] === 'packages') await packagesView();
    else if (parts[0] === 'inventory') await inventoryView();
    else if (parts[0] === 'mailing') await mailingView();
    else if (parts[0] === 'users') await usersView();
    else if (parts[0] === 'system') await systemView();
    else if (parts[0] === 'account') await accountView();
    else await boardView();
    if (assistant && !['list', 'calendar', 'availability', 'account'].includes(parts[0])) lockView();
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
// The account menu closes after a choice, and when moving to another page.
const brandMenu = document.getElementById('brand-menu');
brandMenu.addEventListener('click', (event) => { if (event.target.closest('.brand-items a, #logout')) brandMenu.open = false; });
window.addEventListener('hashchange', () => { brandMenu.open = false; });

document.getElementById('menu-btn').addEventListener('click', () => sidebar.classList.toggle('open'));
document.getElementById('logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' }).catch(() => {});
  setToken(null);
  render();
});
window.addEventListener('hashchange', render);
render();
