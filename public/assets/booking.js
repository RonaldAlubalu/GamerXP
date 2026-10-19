import { api, formData, formatDate, formatPrice, showNotice } from './site.js';

const form = document.getElementById('booking-form');
const notice = document.getElementById('booking-notice');
const dateInput = form.elements.partyDate;
const dateHint = document.getElementById('date-hint');
const choices = document.getElementById('package-choices');
const EXTRA_STATION_CENTS = 2500;
let packages = [];
let unavailable = new Set();

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

async function init() {
  const preselect = new URLSearchParams(location.search).get('pakket') ?? 'ultimate';
  try {
    const [pkgs, availability] = await Promise.all([api('/packages'), api('/availability')]);
    packages = pkgs;
    renderPackages(preselect);
    dateInput.min = availability.minDate;
    dateInput.max = availability.maxDate;
    unavailable = new Set(availability.unavailable);
    updatePrice();
  } catch {
    showNotice(notice, 'error', 'Het formulier kon niet worden geladen. Probeer het later opnieuw of stuur ons een berichtje via WhatsApp.');
  }
}

function checkDate() {
  const value = dateInput.value;
  if (!value) {
    dateHint.textContent = '';
    dateInput.setCustomValidity('');
    return true;
  }
  if (unavailable.has(value)) {
    dateHint.textContent = `${formatDate(value)} is helaas al volgeboekt. Kies een andere datum.`;
    dateInput.setCustomValidity('Deze datum is niet beschikbaar.');
    return false;
  }
  dateHint.textContent = `${formatDate(value)} lijkt nog vrij! 🎮`;
  dateInput.setCustomValidity('');
  return true;
}

dateInput.addEventListener('change', checkDate);
form.addEventListener('change', updatePrice);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!checkDate() || !form.reportValidity()) return;
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
    if (err.body?.code === 'date_unavailable') unavailable.add(dateInput.value);
    showNotice(notice, 'error', err.message);
  } finally {
    button.disabled = false;
  }
});

init();
