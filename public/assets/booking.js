import { api, formData, formatDate, formatPrice, showNotice } from './site.js';

const form = document.getElementById('booking-form');
const notice = document.getElementById('booking-notice');
const choices = document.getElementById('package-choices');
const grid = document.getElementById('cal-grid');
const title = document.getElementById('cal-title');
const slotPicker = document.getElementById('slot-picker');
const slotButtons = document.getElementById('slot-buttons');
const EXTRA_STATION_CENTS = 2500;
const DECORATION_CENTS = 2500;
const monthName = new Intl.DateTimeFormat('nl-NL', { month: 'long', year: 'numeric', timeZone: 'UTC' });

let packages = [];
let availability = { days: {}, slots: [], minDate: '', maxDate: '' };
let month = ''; // 'YYYY-MM' shown in the calendar
let travel = null; // { km, travelCents } for the entered address

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
  // Decoration is an extra only where the package doesn't include it.
  const decorationOption = document.getElementById('decoration-option');
  decorationOption.hidden = selected.slug === 'ultimate';
  if (decorationOption.hidden) form.elements.decoration.checked = false;
  const decoration = form.elements.decoration.checked ? DECORATION_CENTS : 0;
  const evening = form.elements.timeSlot?.value === 'avond' ? 5000 : 0;
  const total = selected.priceCents + Number(form.elements.extraStations.value) * EXTRA_STATION_CENTS + decoration + evening + (travel?.travelCents ?? 0);
  document.getElementById('price-total').textContent = formatPrice(total);
  document.getElementById('price-travel').textContent = travel?.km
    ? `Inclusief reiskosten ${formatPrice(travel.travelCents)} (${(travel.km * 2).toLocaleString('nl-NL', { maximumFractionDigits: 1 })} km retour)${evening ? ' en avondtoeslag €50' : ''}.`
    : `Excl. reiskosten: vul je adres in en je ziet ze direct${evening ? ' (incl. avondtoeslag €50)' : ''}.`;
  if (form.elements.parking.value === 'paid') document.getElementById('price-travel').textContent += ' Excl. eventuele parkeerkosten.';
  box.hidden = false;
}

// Estimate travel costs once postcode and city are filled in.
async function updateTravel() {
  const postalCode = form.elements.postalCode.value.trim();
  const city = form.elements.city.value.trim();
  if (postalCode.length < 4 || city.length < 2) return;
  try {
    const quote = await api(`/quote?${new URLSearchParams({ postalCode, city })}`);
    travel = quote.km === null ? null : quote;
  } catch {
    travel = null;
  }
  updatePrice();
}
// A party somewhere else: show the fields for the location's name and the customer's own address.
const elsewhere = document.getElementById('b-elsewhere');
const elsewhereFields = document.getElementById('b-elsewhere-fields');
elsewhere.addEventListener('change', () => {
  elsewhereFields.hidden = !elsewhere.checked;
  for (const input of elsewhereFields.querySelectorAll('input')) {
    if (!elsewhere.checked) input.value = '';
    // With the box ticked, the invoice address is needed.
    if (input.name !== 'locationName') input.required = elsewhere.checked;
  }
});
form.elements.postalCode.addEventListener('change', updateTravel);
form.elements.city.addEventListener('change', updateTravel);

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
  const open = availability.slots.filter((s) => free.includes(s.key));
  // Keep the chosen time slot when it is free on this day too, else take the first free one.
  const chosen = free.includes(previous) ? previous : open[0]?.key;
  slotButtons.replaceChildren(
    ...open
      .map((s) => {
        const label = document.createElement('label');
        const input = document.createElement('input');
        Object.assign(input, { type: 'radio', name: 'timeSlot', value: s.key, required: true, checked: s.key === chosen });
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
  updatePrice();
}

// A line above the calendar that follows the real availability.
function renderAvailabilityNote() {
  const note = document.getElementById('availability-note');
  const free = Object.keys(availability.days).sort();
  if (!free.length) {
    note.textContent = 'Op dit moment zijn alle data volgeboekt. Stuur ons een berichtje via WhatsApp, dan denken we met je mee.';
    note.hidden = false;
    return;
  }
  const until = new Date(`${availability.minDate}T00:00:00Z`);
  until.setUTCDate(until.getUTCDate() + 56);
  const weekendDays = free.filter((d) => d <= iso(until) && [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())).length;
  // Only mention it when weekends are getting scarce.
  note.hidden = weekendDays > 6;
  note.textContent = weekendDays
    ? `🎮 Weekenden gaan hard: nog ${weekendDays} vrije weekenddag${weekendDays === 1 ? '' : 'en'} in de komende 8 weken.`
    : '🎮 De weekenden van de komende 8 weken zijn volgeboekt. Kijk verder vooruit of kies een doordeweekse dag.';
}

async function loadAvailability() {
  availability = await api('/availability');
  if (!month) {
    const firstFree = Object.keys(availability.days).sort()[0];
    month = (firstFree ?? availability.minDate).slice(0, 7);
  }
  renderCalendar();
  renderAvailabilityNote();
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

// Steps -------------------------------------------------------------------------

const steps = [...form.querySelectorAll('.step')];
const backButton = document.getElementById('step-back');
const nextButton = document.getElementById('step-next');
const submitButton = document.getElementById('step-submit');
let step = 0;

function showStep(n, scroll = true) {
  step = n;
  steps.forEach((el, i) => (el.hidden = i !== n));
  [...document.getElementById('steps-bar').children].forEach((li, i) => {
    li.className = i < n ? 'done' : i === n ? 'current' : '';
  });
  backButton.hidden = n === 0;
  nextButton.hidden = n === steps.length - 1;
  submitButton.hidden = !nextButton.hidden;
  notice.hidden = true;
  if (scroll) document.getElementById('steps-bar').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const calendarChosen = () => Boolean(form.elements.partyDate.value && form.elements.timeSlot?.value && form.elements.packageId?.value);
const stepHasProblem = (n) => (n === 0 && !calendarChosen()) || Boolean(steps[n].querySelector(':invalid'));

// Checks the fields of the step on screen and points at the first problem.
function stepIsValid(n) {
  if (n === 0 && !calendarChosen()) {
    showNotice(notice, 'error', form.elements.packageId?.value ? 'Kies eerst een datum en een tijdslot in de kalender.' : 'Kies een pakket.');
    return false;
  }
  const invalid = steps[n].querySelector(':invalid');
  invalid?.reportValidity();
  return !invalid;
}

nextButton.addEventListener('click', () => stepIsValid(step) && showStep(step + 1));
backButton.addEventListener('click', () => showStep(step - 1));

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const problem = steps.findIndex((_, n) => stepHasProblem(n));
  if (problem >= 0) {
    if (problem !== step) showStep(problem, false);
    stepIsValid(problem);
    return;
  }
  submitButton.disabled = true;
  try {
    const { reference, statusUrl } = await api('/bookings', { method: 'POST', body: JSON.stringify(formData(form)) });
    form.hidden = true;
    document.getElementById('booking-done').hidden = false;
    document.getElementById('booking-reference').textContent = reference;
    const url = new URL(statusUrl);
    document.getElementById('booking-status-link').href = url.pathname + url.search;
    // Show the confirmation itself, not the top of the page.
    document.getElementById('booking-done').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (err) {
    // Go to the step with the field the server rejected, or the calendar when the slot was just taken.
    const field = form.elements[err.body?.issues?.[0]?.path];
    const target = err.status === 409 ? 0 : steps.findIndex((el) => field instanceof Element && el.contains(field));
    if (target >= 0 && target !== step) showStep(target, false);
    showNotice(notice, 'error', err.message);
    if (err.status === 409) await loadAvailability().catch(() => {});
  } finally {
    submitButton.disabled = false;
  }
});

init();
