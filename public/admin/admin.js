// Small single-page admin app. Uses hash routes like #/bookings/<id>.
const TOKEN_KEY = 'gamerxp-admin-token';
const view = document.getElementById('view');
const notice = document.getElementById('notice');
const nav = document.getElementById('admin-nav');

const STATUS_LABELS = { pending: 'Aanvraag', confirmed: 'Bevestigd', cancelled: 'Geannuleerd', completed: 'Afgerond' };
const euro = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });
const fmtDate = (d) =>
  new Intl.DateTimeFormat('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${d}T00:00:00Z`));
const fmtDateTime = (d) => new Intl.DateTimeFormat('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(d));
const todayIso = () => new Date().toLocaleDateString('en-CA');

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
  el.append(...children.flat().filter((c) => c != null).map((c) => (c instanceof Node ? c : String(c))));
  return el;
}

const statusBadge = (s) => h('span', { class: `status ${s}` }, STATUS_LABELS[s] ?? s);
const table = (headers, rows) =>
  h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, headers.map((t) => h('th', {}, t)))), h('tbody', {}, rows)));

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

async function bookingsView() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const status = params.get('status') ?? '';
  const from = params.get('from') ?? todayIso();
  const query = new URLSearchParams({ ...(status && { status }), ...(from && { from }) });
  const bookings = await api(`/bookings?${query}`);

  const filter = (key, value) => {
    params.set(key, value);
    location.hash = `#/bookings?${params}`;
  };
  view.replaceChildren(
    h('h1', {}, 'Boekingen'),
    h('div', { class: 'toolbar' },
      h('div', { class: 'field' }, h('label', {}, 'Status'),
        h('select', { onchange: (e) => filter('status', e.target.value) },
          h('option', { value: '' }, 'Alle'),
          Object.entries(STATUS_LABELS).map(([v, l]) => h('option', { value: v, selected: v === status }, l)))),
      h('div', { class: 'field' }, h('label', {}, 'Vanaf datum'),
        h('input', { type: 'date', value: from, onchange: (e) => filter('from', e.target.value) })),
    ),
    bookings.length
      ? table(['Datum', 'Tijd', 'Jarige', 'Ouder', 'Plaats', 'Pakket', 'Status'],
          bookings.map((b) => h('tr', { class: 'clickable', onclick: () => (location.hash = `#/bookings/${b.id}`) },
            h('td', {}, fmtDate(b.partyDate)), h('td', {}, b.startTime), h('td', {}, `${b.childName} (${b.childAge})`),
            h('td', {}, b.parentName), h('td', {}, b.city), h('td', {}, b.packageName), h('td', {}, statusBadge(b.status)))))
      : h('p', { class: 'muted' }, 'Geen boekingen gevonden.'),
  );
}

async function bookingDetailView(id) {
  const b = await api(`/bookings/${id}`);
  const notes = h('textarea', { name: 'adminNotes' }, b.adminNotes);
  const update = async (patch, message) => {
    try {
      await api(`/bookings/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      flash('ok', message);
      bookingDetailView(id);
    } catch (err) {
      flash('error', err.message);
    }
  };
  const statusButton = (status, label, cls = '') =>
    b.status === status ? null : h('button', {
      class: `btn small ${cls}`,
      onclick: () => {
        const mail = status === 'confirmed' || status === 'cancelled';
        const notify = mail && confirm(`${label}: de ouder een e-mail sturen?\n\nOK = met e-mail, Annuleren = zonder e-mail`);
        update({ status, notifyCustomer: notify }, `Status gewijzigd naar "${STATUS_LABELS[status]}".`);
      },
    }, label);

  view.replaceChildren(
    h('p', {}, h('a', { href: '#/bookings' }, '← Alle boekingen')),
    h('h1', {}, `${b.childName} wordt ${b.childAge} `, statusBadge(b.status)),
    h('div', { class: 'card' },
      h('dl', { class: 'details' },
        h('dt', {}, 'Referentie'), h('dd', {}, b.reference),
        h('dt', {}, 'Datum'), h('dd', {}, `${fmtDate(b.partyDate)} om ${b.startTime}`),
        h('dt', {}, 'Pakket'), h('dd', {}, b.packageName),
        h('dt', {}, 'Aantal kinderen'), h('dd', {}, b.guestCount),
        h('dt', {}, 'Ouder'), h('dd', {}, b.parentName),
        h('dt', {}, 'E-mail'), h('dd', {}, h('a', { href: `mailto:${b.email}` }, b.email)),
        h('dt', {}, 'Telefoon'), h('dd', {}, h('a', { href: `tel:${b.phone.replace(/[^\d+]/g, '')}` }, b.phone)),
        h('dt', {}, 'Adres'), h('dd', {}, `${b.street}\n${b.postalCode} ${b.city}`),
        h('dt', {}, 'Opmerkingen'), h('dd', {}, b.notes || '–'),
        h('dt', {}, 'Aangevraagd'), h('dd', {}, fmtDateTime(b.createdAt)),
      ),
      h('div', { class: 'field' }, h('label', {}, 'Interne notities'), notes),
      h('div', { class: 'actions-row' },
        h('button', { class: 'btn small secondary', onclick: () => update({ adminNotes: notes.value }, 'Notities opgeslagen.') }, 'Notities opslaan'),
        statusButton('confirmed', 'Bevestigen'),
        statusButton('completed', 'Afgerond'),
        statusButton('pending', 'Terug naar aanvraag', 'secondary'),
        statusButton('cancelled', 'Annuleren', 'danger'),
      ),
    ),
  );
}

async function datesView() {
  const dates = await api('/blocked-dates');
  const form = h('form', { class: 'toolbar', onsubmit: async (e) => {
    e.preventDefault();
    const { date, reason } = Object.fromEntries(new FormData(form));
    try {
      await api(`/blocked-dates/${date}`, { method: 'PUT', body: JSON.stringify({ reason }) });
      flash('ok', `${fmtDate(date)} geblokkeerd.`);
      datesView();
    } catch (err) { flash('error', err.message); }
  } },
    h('div', { class: 'field' }, h('label', {}, 'Datum'), h('input', { type: 'date', name: 'date', required: true, min: todayIso() })),
    h('div', { class: 'field' }, h('label', {}, 'Reden (optioneel)'), h('input', { name: 'reason', maxlength: 200 })),
    h('button', { class: 'btn small', type: 'submit' }, 'Blokkeren'),
  );
  view.replaceChildren(
    h('h1', {}, 'Geblokkeerde data'),
    h('p', { class: 'muted' }, 'Op deze dagen kan niemand boeken, bijvoorbeeld tijdens vakantie.'),
    form,
    dates.length
      ? table(['Datum', 'Reden', ''], dates.map((d) => h('tr', {},
          h('td', {}, fmtDate(d.date)), h('td', {}, d.reason || '–'),
          h('td', {}, h('button', { class: 'btn small secondary', onclick: async () => {
            await api(`/blocked-dates/${d.date}`, { method: 'DELETE' });
            datesView();
          } }, 'Vrijgeven')))))
      : h('p', { class: 'muted' }, 'Geen geblokkeerde data.'),
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
        priceCents: Math.round(Number(String(d.price).replace(',', '.')) * 100),
        sortOrder: Number(d.sortOrder), active: form.elements.active.checked,
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
    h('p', { class: 'muted' }, `Huidige prijzen: ${packages.map((p) => `${p.name} ${euro.format(p.priceCents / 100)}`).join(' · ') || '–'}`),
    h('div', { class: 'grid' }, packages.map(editor), editor(null)),
  );
}

// Router -----------------------------------------------------------------------

async function render() {
  if (!getToken()) return loginView();
  nav.hidden = false;
  const [path] = location.hash.slice(1).split('?');
  const parts = (path || '/bookings').split('/').filter(Boolean);
  try {
    if (parts[0] === 'bookings' && parts[1]) await bookingDetailView(parts[1]);
    else if (parts[0] === 'dates') await datesView();
    else if (parts[0] === 'messages') await messagesView();
    else if (parts[0] === 'packages') await packagesView();
    else await bookingsView();
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
