import { api, formData, formatDate, formatPrice, showNotice } from './site.js';

const form = document.getElementById('booking-form');
const notice = document.getElementById('booking-notice');
const choices = document.getElementById('package-choices');
const grid = document.getElementById('cal-grid');
const title = document.getElementById('cal-title');
const slotPicker = document.getElementById('slot-picker');
const slotButtons = document.getElementById('slot-buttons');
const EXTRA_STATION_CENTS = 2500;
const monthName = new Intl.DateTimeFormat('nl-NL', { month: 'long', year: 'numeric', timeZone: 'UTC' });

let packages = [];
let availability = { days: {}, slots: [], minDate: '', maxDate: '' };
let month = ''; // 'YYYY-MM' shown in the calendar

// Packages ----------------------------------------------------------------------

function renderPackages(preselect) {
  choices.replaceChildren(
    ...packages.map((p) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      Object.assign(input, { type: 'radio', name: 'packageId', value: p.id, required: true, checked: p.slug === preselect });
      const text = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = `${p.name} (${formatPrice(p.priceCents)})`;
      const desc = document.createElement('span');
      desc.textContent = `${p.maxPlayers} stations · ${String(p.durationHours).replace('.', ',')} uur speeltijd`;
      text.append(name, desc);
      label.append(input, text);
      return label;
    }),
  );
}

function updatePrice() {
  const selected = packages.find((p) => String(p.id) === form.elements.packageId?.value);
  const box = document.getElementById('price-summary');
  if (!selected) {
    box.hidden = true;
    return;
  }
  const total = selected.priceCents + Number(form.elements.extraStations.value) * EXTRA_STATION_CENTS;
  document.getElementById('price-total').textContent = formatPrice(total);
  box.hidden = false;
}

// Calendar ----------------------------------------------------------------------

const iso = (d) => d.toISOString().slice(0, 10);
const shiftMonth = (m, n) => {
  const d = new Date(`${m}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return iso(d).slice(0, 7);
};

function renderCalendar() {
  const first = new Date(`${month}-01T00:00:00Z`);
  title.textContent = monthName.format(first);
  document.getElementById('cal-prev').disabled = month <= availability.minDate.slice(0, 7);
  document.getElementById('cal-next').disabled = month >= availability.maxDate.slice(0, 7);

  const cells = [];
  const offset = (first.getUTCDay() + 6) % 7; // Monday first
  for (let i = 0; i < offset; i++) cells.push(document.createElement('span'));
  for (let d = new Date(first); iso(d).startsWith(month); d.setUTCDate(d.getUTCDate() + 1)) {
    const date = iso(d);
    const free = availability.days[date];
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = String(d.getUTCDate());
    button.className = 'cal-day';
    if (free) {
      button.classList.add('free');
      button.setAttribute('aria-label', `${formatDate(date)}: ${free.length} ${free.length === 1 ? 'tijdslot' : 'tijdslots'} vrij`);
      button.addEventListener('click', () => selectDate(date));
    } else {
      button.disabled = true;
      button.setAttribute('aria-label', `${formatDate(date)}: niet beschikbaar`);
    }
    if (date === form.elements.partyDate.value) button.classList.add('selected');
    cells.push(button);
  }
  grid.replaceChildren(...cells);
}

function selectDate(date) {
  form.elements.partyDate.value = date;
  document.getElementById('slot-date').textContent = formatDate(date);
  const previous = form.elements.timeSlot?.value;
  const free = availability.days[date] ?? [];
  slotButtons.replaceChildren(
    ...availability.slots
      .filter((s) => free.includes(s.key))
      .map((s) => {
        const label = document.createElement('label');
        const input = document.createElement('input');
        Object.assign(input, { type: 'radio', name: 'timeSlot', value: s.key, required: true, checked: s.key === previous || free.length === 1 });
        const text = document.createElement('span');
        const name = document.createElement('strong');
        name.textContent = s.label + (s.key === 'avond' ? ' (evt. toeslag)' : '');
        const hours = document.createElement('span');
        hours.textContent = `${s.start} – ${s.end}`;
        text.append(name, hours);
        label.append(input, text);
        return label;
      }),
  );
  slotPicker.hidden = false;
  renderCalendar();
}

async function loadAvailability() {
  availability = await api('/availability');
  if (!month) {
    const firstFree = Object.keys(availability.days).sort()[0];
    month = (firstFree ?? availability.minDate).slice(0, 7);
  }
  renderCalendar();
  const chosen = form.elements.partyDate.value;
  if (chosen && availability.days[chosen]) selectDate(chosen);
  else {
    form.elements.partyDate.value = '';
    slotPicker.hidden = true;
  }
}

document.getElementById('cal-prev').addEventListener('click', () => {
  month = shiftMonth(month, -1);
  renderCalendar();
});
document.getElementById('cal-next').addEventListener('click', () => {
  month = shiftMonth(month, 1);
  renderCalendar();
});

// Form --------------------------------------------------------------------------

async function init() {
  const preselect = new URLSearchParams(location.search).get('pakket') ?? 'ultimate';
  try {
    packages = await api('/packages');
    renderPackages(preselect);
    updatePrice();
    await loadAvailability();
  } catch {
    showNotice(notice, 'error', 'Het formulier kon niet worden geladen. Probeer het later opnieuw of stuur ons een berichtje via WhatsApp.');
  }
}

form.addEventListener('change', updatePrice);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!form.elements.partyDate.value || !form.elements.timeSlot?.value) {
    showNotice(notice, 'error', 'Kies een datum en een tijdslot in de kalender.');
    return;
  }
  if (!form.reportValidity()) return;
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const { reference, statusUrl } = await api('/bookings', { method: 'POST', body: JSON.stringify(formData(form)) });
    form.hidden = true;
    notice.hidden = true;
    document.getElementById('booking-done').hidden = false;
    document.getElementById('booking-reference').textContent = reference;
    const url = new URL(statusUrl);
    document.getElementById('booking-status-link').href = url.pathname + url.search;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    showNotice(notice, 'error', err.message);
    // Someone else may have just taken this slot: refresh the calendar.
    if (err.status === 409) await loadAvailability().catch(() => {});
  } finally {
    button.disabled = false;
  }
});

init();
