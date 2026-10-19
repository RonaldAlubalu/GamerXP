// Small single-page admin app. Uses hash routes like #/bookings/<id>.
const TOKEN_KEY = 'gamerxp-admin-token';
const view = document.getElementById('view');
const notice = document.getElementById('notice');
const nav = document.getElementById('admin-nav');

// Pipeline stages in order; 'cancelled' sits outside the flow.
const STAGES = ['new', 'contacted', 'confirmed', 'deposit_paid', 'scheduled', 'party_held', 'completed'];
const STATUS_LABELS = {
  new: 'Nieuw',
  contacted: 'Contact opgenomen',
  confirmed: 'Bevestigd',
  deposit_paid: 'Aanbetaling ontvangen',
  scheduled: 'Ingepland',
  party_held: 'Feest geweest',
  completed: 'Afgerond',
  cancelled: 'Geannuleerd',
};
// Stages where the parent gets an email when the booking moves there.
const EMAIL_STAGES = new Set(['confirmed', 'deposit_paid', 'completed', 'cancelled']);
const EVENT_ICONS = { created: '✨', status: '➡️', note: '📝', task: '☑️', email: '✉️', update: '✏️' };

const euro = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
const fmtEuro = (cents) => euro.format(cents / 100);
const fmtDate = (d) =>
  new Intl.DateTimeFormat('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${d}T00:00:00Z`));
const fmtDateTime = (d) => new Intl.DateTimeFormat('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(d));
const todayIso = () => new Date().toLocaleDateString('en-CA');
const daysUntil = (d) => Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${todayIso()}T00:00:00Z`)) / 86400000);
const parseEuro = (v) => Math.round(Number(String(v).replace(/[^\d,.-]/g, '').replace(',', '.')) * 100) || 0;

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

function flash(type, message) {
  notice.className = `notice ${type}`;
  notice.textContent = message;
  notice.hidden = false;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => (notice.hidden = true), 5000);
}

// Tiny element helper: h('td', { class: 'x' }, 'text', childEl)
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat(Infinity).filter((c) => c != null && c !== false).map((c) => (c instanceof Node ? c : String(c))));
  return el;
}

const statusBadge = (s) => h('span', { class: `status ${s}` }, STATUS_LABELS[s] ?? s);
const progressBar = (done, total) =>
  h('div', { class: 'progress', title: `${done} van ${total} taken klaar` },
    h('div', { class: 'progress-fill', style: `width: ${total ? Math.round((done / total) * 100) : 0}%` }));
const table = (headers, rows) =>
  h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, headers.map((t) => h('th', {}, t)))), h('tbody', {}, rows)));

function dueLabel(b) {
  const days = daysUntil(b.partyDate);
  if (['completed', 'cancelled'].includes(b.status)) return null;
  if (days < 0 && b.status !== 'party_held') return h('span', { class: 'due late' }, `${-days} dagen geleden`);
  if (days === 0) return h('span', { class: 'due soon' }, 'Vandaag!');
  if (days > 0 && days <= 7) return h('span', { class: 'due soon' }, `over ${days} ${days === 1 ? 'dag' : 'dagen'}`);
  return null;
}

// Moves a booking to another stage, asking whether to email the parent where relevant.
async function moveBooking(id, status) {
  const notifyCustomer = EMAIL_STAGES.has(status)
    ? confirm(`Naar "${STATUS_LABELS[status]}": de ouder een e-mail sturen?\n\nOK = met e-mail, Annuleren = zonder e-mail`)
    : false;
  await api(`/bookings/${id}`, { method: 'PATCH', body: JSON.stringify({ status, notifyCustomer }) });
  flash('ok', `Verplaatst naar "${STATUS_LABELS[status]}".`);
}

// Views ------------------------------------------------------------------------

function loginView() {
  nav.hidden = true;
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
  const columns = await api('/pipeline');
  const open = columns.filter((c) => !['completed', 'cancelled'].includes(c.key)).reduce((n, c) => n + c.bookings.length, 0);

  const card = (b, column) => {
    const i = STAGES.indexOf(column.key);
    const next = i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1] : null;
    return h('article', { class: 'board-card' },
      h('a', { href: `#/bookings/${b.id}`, class: 'board-card-link' },
        h('strong', {}, `${b.childName} (${b.childAge})`),
        h('div', { class: 'muted' }, `${fmtDate(b.partyDate)} · ${b.startTime}`),
        h('div', { class: 'muted' }, `${b.city} · ${b.packageName}`),
        dueLabel(b),
        progressBar(b.tasksDone, b.tasksTotal)),
      next && h('button', {
        class: 'btn small secondary',
        onclick: async () => {
          try { await moveBooking(b.id, next); boardView(); } catch (err) { flash('error', err.message); }
        },
      }, `→ ${STATUS_LABELS[next]}`),
    );
  };

  view.replaceChildren(
    h('div', { class: 'page-head' },
      h('h1', {}, 'Pipeline'),
      h('span', { class: 'muted' }, `${open} open ${open === 1 ? 'boeking' : 'boekingen'}`)),
    h('div', { class: 'board' },
      columns.map((c) => h('section', { class: `board-col col-${c.key}` },
        h('header', {}, h('span', {}, c.label), h('span', { class: 'count' }, c.bookings.length)),
        c.bookings.length ? c.bookings.map((b) => card(b, c)) : h('p', { class: 'muted empty' }, '–')))),
    h('p', { class: 'muted' }, 'Afgeronde en geannuleerde boekingen worden 30 dagen getoond. Alle boekingen staan onder "Lijst".'),
  );
}

async function bookingsView() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const status = params.get('status') ?? '';
  const from = params.get('from') ?? '';
  const q = params.get('q') ?? '';
  const query = new URLSearchParams({ ...(status && { status }), ...(from && { from }), ...(q && { q }) });
  const bookings = await api(`/bookings?${query}`);

  const filter = (key, value) => {
    value ? params.set(key, value) : params.delete(key);
    location.hash = `#/list?${params}`;
  };
  view.replaceChildren(
    h('h1', {}, 'Alle boekingen'),
    h('div', { class: 'toolbar' },
      h('div', { class: 'field' }, h('label', {}, 'Zoeken'),
        h('input', { type: 'search', value: q, placeholder: 'Naam, referentie, plaats…', onchange: (e) => filter('q', e.target.value) })),
      h('div', { class: 'field' }, h('label', {}, 'Status'),
        h('select', { onchange: (e) => filter('status', e.target.value) },
          h('option', { value: '' }, 'Alle'),
          Object.entries(STATUS_LABELS).map(([v, l]) => h('option', { value: v, selected: v === status }, l)))),
      h('div', { class: 'field' }, h('label', {}, 'Vanaf datum'),
        h('input', { type: 'date', value: from, onchange: (e) => filter('from', e.target.value) })),
    ),
    bookings.length
      ? table(['Datum', 'Tijd', 'Jarige', 'Ouder', 'Plaats', 'Pakket', 'Voortgang', 'Status'],
          bookings.map((b) => h('tr', { class: 'clickable', onclick: () => (location.hash = `#/bookings/${b.id}`) },
            h('td', {}, fmtDate(b.partyDate)), h('td', {}, b.startTime), h('td', {}, `${b.childName} (${b.childAge})`),
            h('td', {}, b.parentName), h('td', {}, b.city), h('td', {}, b.packageName),
            h('td', {}, progressBar(b.tasksDone, b.tasksTotal)), h('td', {}, statusBadge(b.status)))))
      : h('p', { class: 'muted' }, 'Geen boekingen gevonden.'),
  );
}

async function bookingDetailView(id) {
  const b = await api(`/bookings/${id}`);
  const reload = () => bookingDetailView(id);
  const run = (fn, message) => async (e) => {
    e?.preventDefault?.();
    try {
      await fn();
      if (message) flash('ok', message);
      reload();
    } catch (err) {
      flash('error', err.message);
    }
  };
  const patch = (body) => api(`/bookings/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  const current = STAGES.indexOf(b.status);

  // Stage stepper: click a stage to move the booking there.
  const stepper = h('ol', { class: 'stepper' },
    STAGES.map((s, i) => h('li', {
      class: b.status === 'cancelled' ? 'todo' : i < current ? 'done' : i === current ? 'current' : 'todo',
    }, h('button', {
      type: 'button',
      disabled: s === b.status,
      onclick: run(() => moveBooking(id, s)),
    }, h('span', { class: 'dot' }, i < current && b.status !== 'cancelled' ? '✓' : i + 1), h('span', {}, STATUS_LABELS[s])))));

  // Checklist grouped per stage.
  const tasksByStage = STAGES.map((s) => ({ stage: s, tasks: b.tasks.filter((t) => t.stage === s) })).filter((g) => g.tasks.length);
  const newTask = h('form', { class: 'inline-form', onsubmit: run(async () => {
    const d = Object.fromEntries(new FormData(newTask));
    await api(`/bookings/${id}/tasks`, { method: 'POST', body: JSON.stringify(d) });
  }, 'Taak toegevoegd.') },
    h('select', { name: 'stage' }, STAGES.map((s) => h('option', { value: s, selected: s === b.status }, STATUS_LABELS[s]))),
    h('input', { name: 'label', required: true, maxlength: 200, placeholder: 'Nieuwe taak…' }),
    h('button', { class: 'btn small secondary', type: 'submit' }, 'Toevoegen'));

  const checklist = h('div', { class: 'card' },
    h('h2', {}, 'Checklist ', h('small', { class: 'muted' }, `${b.tasksDone}/${b.tasksTotal}`)),
    progressBar(b.tasksDone, b.tasksTotal),
    tasksByStage.map((g) => h('div', { class: `task-group ${g.stage === b.status ? 'active' : ''}` },
      h('h3', {}, STATUS_LABELS[g.stage]),
      g.tasks.map((t) => h('label', { class: `task ${t.done ? 'is-done' : ''}` },
        h('input', { type: 'checkbox', checked: t.done, onchange: run(() =>
          api(`/bookings/${id}/tasks/${t.id}`, { method: 'PATCH', body: JSON.stringify({ done: !t.done }) })) }),
        h('span', {}, t.label),
        t.doneAt && h('small', { class: 'muted' }, fmtDateTime(t.doneAt)))))),
    newTask);

  // Payments.
  const outstanding = Math.max(b.priceCents - b.paidCents, 0);
  const payForm = h('form', { onsubmit: run(async () => {
    const d = Object.fromEntries(new FormData(payForm));
    await patch({ priceCents: parseEuro(d.price), depositCents: parseEuro(d.deposit), paidCents: parseEuro(d.paid) });
  }, 'Bedragen opgeslagen.') },
    h('div', { class: 'row' },
      ...[['Prijs', 'price', b.priceCents], ['Aanbetaling', 'deposit', b.depositCents], ['Betaald', 'paid', b.paidCents]].map(([label, name, cents]) =>
        h('div', { class: 'field' }, h('label', {}, `${label} (€)`),
          h('input', { name, inputmode: 'decimal', value: (cents / 100).toFixed(2).replace('.', ',') })))),
    h('p', { class: outstanding ? 'muted' : 'paid-in-full' }, outstanding ? `Openstaand: ${fmtEuro(outstanding)}` : 'Volledig betaald ✓'),
    h('button', { class: 'btn small secondary', type: 'submit' }, 'Bedragen opslaan'));

  // Reschedule.
  const planForm = h('form', { onsubmit: run(async () => {
    const d = Object.fromEntries(new FormData(planForm));
    await patch({ partyDate: d.partyDate, startTime: d.startTime });
  }, 'Datum/tijd opgeslagen.') },
    h('div', { class: 'row' },
      h('div', { class: 'field' }, h('label', {}, 'Datum'), h('input', { type: 'date', name: 'partyDate', value: b.partyDate, required: true })),
      h('div', { class: 'field' }, h('label', {}, 'Starttijd'), h('input', { type: 'time', name: 'startTime', value: b.startTime, required: true }))),
    h('button', { class: 'btn small secondary', type: 'submit' }, 'Verzetten'));

  // Timeline with a note field.
  const noteForm = h('form', { onsubmit: run(async () => {
    await api(`/bookings/${id}/notes`, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(noteForm))) });
  }, 'Notitie toegevoegd.') },
    h('div', { class: 'field' }, h('textarea', { name: 'message', required: true, maxlength: 5000, placeholder: 'Notitie toevoegen, bijv. "Gebeld: feest in de garage, 3 stopcontacten"' })),
    h('button', { class: 'btn small secondary', type: 'submit' }, 'Notitie opslaan'));

  const eventText = (e) => {
    if (e.type === 'created') return 'Aanvraag ontvangen via de website';
    if (e.type === 'status') return `${STATUS_LABELS[e.fromStatus] ?? e.fromStatus} → ${STATUS_LABELS[e.toStatus] ?? e.toStatus}`;
    return e.message;
  };
  const timeline = h('div', { class: 'card' },
    h('h2', {}, 'Tijdlijn'),
    noteForm,
    h('ol', { class: 'timeline' },
      b.events.map((e) => h('li', { class: `ev-${e.type}` },
        h('span', { class: 'ev-icon' }, EVENT_ICONS[e.type] ?? '•'),
        h('div', {},
          h('div', { class: 'ev-text' }, eventText(e)),
          h('small', { class: 'muted' }, `${fmtDateTime(e.createdAt)} · ${e.actor}`))))));

  const statusLink = `${location.origin}/status?t=${encodeURIComponent(b.statusToken)}`;

  view.replaceChildren(
    h('p', {}, h('a', { href: '#/board' }, '← Pipeline')),
    h('div', { class: 'page-head' },
      h('h1', {}, `${b.childName} wordt ${b.childAge} `, statusBadge(b.status)),
      dueLabel(b)),
    h('div', { class: 'card' }, stepper,
      h('div', { class: 'actions-row' },
        b.status !== 'cancelled'
          ? h('button', { class: 'btn small danger', onclick: run(() => moveBooking(id, 'cancelled')) }, 'Annuleren')
          : h('button', { class: 'btn small secondary', onclick: run(() => moveBooking(id, 'new')) }, 'Heropenen'),
        h('button', { class: 'btn small secondary', onclick: async () => {
          try { await navigator.clipboard.writeText(statusLink); flash('ok', 'Statuslink gekopieerd.'); }
          catch { prompt('Statuslink voor de ouder:', statusLink); }
        } }, 'Kopieer statuslink voor ouder'))),
    h('div', { class: 'detail-grid' },
      h('div', {},
        h('div', { class: 'card' },
          h('h2', {}, 'Gegevens'),
          h('dl', { class: 'details' },
            h('dt', {}, 'Referentie'), h('dd', {}, b.reference),
            h('dt', {}, 'Datum'), h('dd', {}, `${fmtDate(b.partyDate)} om ${b.startTime}`),
            h('dt', {}, 'Pakket'), h('dd', {}, b.packageName),
            h('dt', {}, 'Aantal kinderen'), h('dd', {}, b.guestCount),
            h('dt', {}, 'Ouder'), h('dd', {}, b.parentName),
            h('dt', {}, 'E-mail'), h('dd', {}, h('a', { href: `mailto:${b.email}` }, b.email)),
            h('dt', {}, 'Telefoon'), h('dd', {}, h('a', { href: `tel:${b.phone.replace(/[^\d+]/g, '')}` }, b.phone)),
            h('dt', {}, 'Adres'), h('dd', {},
              h('a', { href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${b.street}, ${b.postalCode} ${b.city}`)}`, target: '_blank', rel: 'noopener' },
                `${b.street}\n${b.postalCode} ${b.city}`)),
            h('dt', {}, 'Opmerkingen'), h('dd', {}, b.notes || '–'),
            h('dt', {}, 'Aangevraagd'), h('dd', {}, fmtDateTime(b.createdAt)))),
        h('div', { class: 'card' }, h('h2', {}, 'Betaling'), payForm),
        h('div', { class: 'card' }, h('h2', {}, 'Datum verzetten'), planForm)),
      h('div', {}, checklist, timeline)),
  );
}

const WEEKDAYS = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag'];
const SLOT_LABELS = { ochtend: 'Ochtend', middag: 'Middag', avond: 'Avond' };

async function availabilityView() {
  const [av, blocked, overrides] = await Promise.all([api('/availability'), api('/blocked-dates'), api('/availability/overrides')]);
  const num = (name, value, min, max) => h('input', { type: 'number', name, value, min, max, required: true });

  const scheduleForm = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    const f = scheduleForm.elements;
    const weekly = Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [d, Object.fromEntries(
      av.slots.map((s) => [s.key, f[`w${d}-${s.key}`].checked]))]));
    const body = {
      settings: {
        slotCapacity: Number(f.slotCapacity.value), dailyCapacity: Number(f.dailyCapacity.value),
        minLeadDays: Number(f.minLeadDays.value), maxAdvanceDays: Number(f.maxAdvanceDays.value),
      },
      slots: av.slots.map((s) => ({ key: s.key, start: f[`start-${s.key}`].value, end: f[`end-${s.key}`].value })),
      weekly,
    };
    try {
      await api('/availability', { method: 'PUT', body: JSON.stringify(body) });
      flash('ok', 'Beschikbaarheid opgeslagen. De website toont dit direct.');
      availabilityView();
    } catch (err) { flash('error', err.message); }
  } },
    h('h2', {}, 'Weekrooster'),
    h('p', { class: 'muted' }, 'Vink aan op welke dagdelen je normaal gesproken feestjes doet.'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'schedule' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), av.slots.map((s) => h('th', {}, s.label)))),
      h('tbody', {}, WEEKDAYS.map((name, i) => h('tr', {},
        h('th', {}, name),
        av.slots.map((s) => h('td', {}, h('label', { class: 'switch' },
          h('input', { type: 'checkbox', name: `w${i + 1}-${s.key}`, checked: av.weekly[i + 1][s.key] }),
          h('span', {}, 'open'))))))))),
    h('h2', {}, 'Tijden per dagdeel'),
    h('div', { class: 'row' }, av.slots.map((s) => h('div', { class: 'field' },
      h('label', {}, s.label),
      h('div', { class: 'time-range' },
        h('input', { type: 'time', name: `start-${s.key}`, value: s.start, required: true }), ' – ',
        h('input', { type: 'time', name: `end-${s.key}`, value: s.end, required: true }))))),
    h('h2', {}, 'Capaciteit en boekingsperiode'),
    h('div', { class: 'row' },
      h('div', { class: 'field' }, h('label', {}, 'Feestjes per dagdeel'), num('slotCapacity', av.settings.slotCapacity, 1, 10),
        h('small', {}, 'Hoeveel sets je tegelijk kunt uitleveren.')),
      h('div', { class: 'field' }, h('label', {}, 'Feestjes per dag (totaal)'), num('dailyCapacity', av.settings.dailyCapacity, 1, 10)),
      h('div', { class: 'field' }, h('label', {}, 'Minimaal dagen vooruit'), num('minLeadDays', av.settings.minLeadDays, 0, 60)),
      h('div', { class: 'field' }, h('label', {}, 'Maximaal dagen vooruit'), num('maxAdvanceDays', av.settings.maxAdvanceDays, 7, 730))),
    h('button', { class: 'btn small', type: 'submit' }, 'Opslaan'));

  const blockForm = h('form', { class: 'toolbar', onsubmit: async (e) => {
    e.preventDefault();
    const { date, reason } = Object.fromEntries(new FormData(blockForm));
    try {
      await api(`/blocked-dates/${date}`, { method: 'PUT', body: JSON.stringify({ reason }) });
      flash('ok', `${fmtDate(date)} geblokkeerd.`);
      availabilityView();
    } catch (err) { flash('error', err.message); }
  } },
    h('div', { class: 'field' }, h('label', {}, 'Datum'), h('input', { type: 'date', name: 'date', required: true, min: todayIso() })),
    h('div', { class: 'field' }, h('label', {}, 'Reden (optioneel)'), h('input', { name: 'reason', maxlength: 200, placeholder: 'Bijv. vakantie' })),
    h('button', { class: 'btn small', type: 'submit' }, 'Hele dag blokkeren'));

  const overrideForm = h('form', { class: 'toolbar', onsubmit: async (e) => {
    e.preventDefault();
    const { date, slot, open, reason } = Object.fromEntries(new FormData(overrideForm));
    try {
      await api(`/availability/overrides/${date}/${slot}`, { method: 'PUT', body: JSON.stringify({ open: open === 'true', reason }) });
      flash('ok', 'Uitzondering opgeslagen.');
      availabilityView();
    } catch (err) { flash('error', err.message); }
  } },
    h('div', { class: 'field' }, h('label', {}, 'Datum'), h('input', { type: 'date', name: 'date', required: true, min: todayIso() })),
    h('div', { class: 'field' }, h('label', {}, 'Dagdeel'), h('select', { name: 'slot' }, av.slots.map((s) => h('option', { value: s.key }, s.label)))),
    h('div', { class: 'field' }, h('label', {}, 'Wordt'), h('select', { name: 'open' },
      h('option', { value: 'true' }, 'Extra open'), h('option', { value: 'false' }, 'Gesloten'))),
    h('div', { class: 'field' }, h('label', {}, 'Reden (optioneel)'), h('input', { name: 'reason', maxlength: 200 })),
    h('button', { class: 'btn small', type: 'submit' }, 'Toevoegen'));

  view.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'Beschikbaarheid'), h('a', { href: '#/calendar' }, 'Bekijk agenda →')),
    scheduleForm,
    h('div', { class: 'card' },
      h('h2', {}, 'Hele dagen blokkeren'),
      h('p', { class: 'muted' }, 'Op deze dagen kan niemand boeken, bijvoorbeeld tijdens vakantie.'),
      blockForm,
      blocked.length
        ? table(['Datum', 'Reden', ''], blocked.map((d) => h('tr', {},
            h('td', {}, fmtDate(d.date)), h('td', {}, d.reason || '–'),
            h('td', {}, h('button', { class: 'btn small secondary', onclick: async () => {
              await api(`/blocked-dates/${d.date}`, { method: 'DELETE' });
              availabilityView();
            } }, 'Vrijgeven')))))
        : h('p', { class: 'muted' }, 'Geen geblokkeerde dagen.')),
    h('div', { class: 'card' },
      h('h2', {}, 'Uitzonderingen per dagdeel'),
      h('p', { class: 'muted' }, 'Open een extra dagdeel dat normaal dicht is, of sluit er een dat normaal open is.'),
      overrideForm,
      overrides.length
        ? table(['Datum', 'Dagdeel', '', 'Reden', ''], overrides.map((o) => h('tr', {},
            h('td', {}, fmtDate(o.date)), h('td', {}, SLOT_LABELS[o.slot]),
            h('td', {}, h('span', { class: `status ${o.open ? 'confirmed' : 'cancelled'}` }, o.open ? 'Extra open' : 'Gesloten')),
            h('td', {}, o.reason || '–'),
            h('td', {}, h('button', { class: 'btn small secondary', onclick: async () => {
              await api(`/availability/overrides/${o.date}/${o.slot}`, { method: 'DELETE' });
              availabilityView();
            } }, 'Verwijderen')))))
        : h('p', { class: 'muted' }, 'Geen uitzonderingen.')),
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

  const dayCell = (d) => {
    const isToday = d.date === todayIso();
    return h('div', { class: `cal-cell ${d.blocked ? 'blocked' : ''} ${isToday ? 'today' : ''} ${d.date < todayIso() ? 'past' : ''}` },
      h('div', { class: 'cal-date' }, Number(d.date.slice(8)), d.blocked && h('span', { class: 'muted small' }, ` ${d.reason || 'geblokkeerd'}`)),
      d.slots.map((s) => {
        const bookings = d.bookings.filter((b) => b.timeSlot === s.key);
        if (bookings.length) {
          return bookings.map((b) => h('a', { class: `cal-chip booked st-${b.status}`, href: `#/bookings/${b.id}`, title: `${STATUS_LABELS[b.status]} · ${b.packageName}` },
            `${SLOT_LABELS[s.key].slice(0, 3)} ${b.startTime ?? ''} ${b.childName || b.parentName} · ${b.city}`));
        }
        if (d.blocked || !s.open) return h('span', { class: 'cal-chip closed' }, `${SLOT_LABELS[s.key].slice(0, 3)} –`);
        return h('span', { class: `cal-chip ${s.available ? 'free' : 'full'}` }, `${SLOT_LABELS[s.key].slice(0, 3)} ${s.available ? 'vrij' : 'vol'}`);
      }));
  };

  view.replaceChildren(
    h('div', { class: 'page-head' },
      h('h1', {}, 'Agenda'),
      h('a', { class: 'btn small secondary', href: `#/calendar?month=${shift(-1)}` }, '‹'),
      h('strong', { class: 'cal-title' }, title),
      h('a', { class: 'btn small secondary', href: `#/calendar?month=${shift(1)}` }, '›'),
      h('a', { href: '#/availability' }, 'Beschikbaarheid aanpassen →')),
    h('div', { class: 'admin-cal' },
      ['ma', 'di', 'wo', 'do', 'vr', 'za', 'zo'].map((w) => h('div', { class: 'cal-wd' }, w)),
      Array.from({ length: offset }, () => h('div', {})),
      cal.days.map(dayCell)),
    h('p', { class: 'muted small' }, 'Groen = vrij, oranje/paars = geboekt (klik voor details), grijs = gesloten.'),
  );
}

async function messagesView() {
  const messages = await api('/messages');
  view.replaceChildren(
    h('h1', {}, 'Berichten'),
    messages.length
      ? table(['Ontvangen', 'Van', 'Bericht', ''], messages.map((m) => h('tr', { class: m.handled ? 'handled' : '' },
          h('td', {}, fmtDateTime(m.createdAt)),
          h('td', {}, m.name, h('br'), h('a', { href: `mailto:${m.email}` }, m.email), m.phone ? [h('br'), m.phone] : null),
          h('td', { style: 'white-space: pre-wrap' }, m.message),
          h('td', {}, h('button', { class: 'btn small secondary', onclick: async () => {
            await api(`/messages/${m.id}`, { method: 'PATCH', body: JSON.stringify({ handled: !m.handled }) });
            messagesView();
          } }, m.handled ? 'Markeer open' : 'Afgehandeld')))))
      : h('p', { class: 'muted' }, 'Nog geen berichten.'),
  );
}

async function packagesView() {
  const packages = await api('/packages');
  const field = (label, name, { tag = 'input', text = '', ...attrs } = {}) =>
    h('div', { class: 'field' }, h('label', {}, label), h(tag, { name, ...attrs }, text));

  const editor = (p) => {
    const form = h('form', { class: 'card', onsubmit: async (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(form));
      const body = {
        slug: d.slug, name: d.name, description: d.description,
        maxPlayers: Number(d.maxPlayers), durationHours: Number(String(d.durationHours).replace(',', '.')),
        priceCents: parseEuro(d.price), sortOrder: Number(d.sortOrder), active: form.elements.active.checked,
      };
      try {
        await api(p ? `/packages/${p.id}` : '/packages', { method: p ? 'PATCH' : 'POST', body: JSON.stringify(body) });
        flash('ok', 'Pakket opgeslagen.');
        packagesView();
      } catch (err) { flash('error', err.message); }
    } },
      h('h3', {}, p ? p.name : 'Nieuw pakket'),
      h('div', { class: 'row' },
        field('Naam', 'name', { required: true, value: p?.name ?? '' }),
        field('Slug (in de URL)', 'slug', { required: true, pattern: '[a-z0-9-]+', value: p?.slug ?? '' }),
        field('Prijs (€)', 'price', { required: true, inputmode: 'decimal', value: p ? (p.priceCents / 100).toFixed(2).replace('.', ',') : '' })),
      h('div', { class: 'row' },
        field('Max. kinderen', 'maxPlayers', { type: 'number', min: 1, required: true, value: p?.maxPlayers ?? 8 }),
        field('Duur (uren)', 'durationHours', { required: true, inputmode: 'decimal', value: String(p?.durationHours ?? 3).replace('.', ',') }),
        field('Volgorde', 'sortOrder', { type: 'number', value: p?.sortOrder ?? 0 })),
      field('Omschrijving', 'description', { tag: 'textarea', text: p?.description ?? '' }),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'active', checked: p ? p.active : true }), ' Zichtbaar op de website'),
      h('button', { class: 'btn small', type: 'submit' }, 'Opslaan'),
    );
    return form;
  };

  view.replaceChildren(
    h('h1', {}, 'Pakketten'),
    h('p', { class: 'muted' }, 'Prijswijzigingen gelden voor nieuwe boekingen; bestaande boekingen houden hun prijs.'),
    h('div', { class: 'grid' }, packages.map(editor), editor(null)),
  );
}

// Router -----------------------------------------------------------------------

async function render() {
  if (!getToken()) return loginView();
  nav.hidden = false;
  const [path] = location.hash.slice(1).split('?');
  const parts = (path || '/board').split('/').filter(Boolean);
  for (const a of nav.querySelectorAll('a')) a.classList.toggle('active', a.getAttribute('href') === `#/${parts[0]}`);
  try {
    if (parts[0] === 'bookings' && parts[1]) await bookingDetailView(parts[1]);
    else if (parts[0] === 'list') await bookingsView();
    else if (parts[0] === 'availability') await availabilityView();
    else if (parts[0] === 'calendar') await calendarView();
    else if (parts[0] === 'messages') await messagesView();
    else if (parts[0] === 'packages') await packagesView();
    else await boardView();
  } catch (err) {
    flash('error', err.message);
  }
}

document.getElementById('logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' }).catch(() => {});
  setToken(null);
  render();
});
window.addEventListener('hashchange', render);
render();
