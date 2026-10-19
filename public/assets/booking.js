import { api, formData, formatDate, showNotice } from './site.js';

const form = document.getElementById('booking-form');
const notice = document.getElementById('booking-notice');
const dateInput = form.elements.partyDate;
const dateHint = document.getElementById('date-hint');
const packageSelect = form.elements.packageId;
let unavailable = new Set();

async function init() {
  const preselect = new URLSearchParams(location.search).get('pakket');
  try {
    const [packages, availability] = await Promise.all([api('/packages'), api('/availability')]);
    for (const p of packages) {
      const option = new Option(`${p.name} (max. ${p.maxPlayers} kinderen)`, p.id);
      option.dataset.slug = p.slug;
      option.selected = p.slug === preselect;
      packageSelect.add(option);
    }
    dateInput.min = availability.minDate;
    dateInput.max = availability.maxDate;
    unavailable = new Set(availability.unavailable);
  } catch {
    showNotice(notice, 'error', 'Het boekingsformulier kon niet worden geladen. Probeer het later opnieuw.');
  }
}

function checkDate() {
  const value = dateInput.value;
  if (!value) {
    dateHint.textContent = '';
    return true;
  }
  if (unavailable.has(value)) {
    dateHint.textContent = `${formatDate(value)} is helaas al bezet. Kies een andere datum.`;
    dateInput.setCustomValidity('Deze datum is niet beschikbaar.');
    return false;
  }
  dateHint.textContent = `${formatDate(value)} is nog beschikbaar! 🎮`;
  dateInput.setCustomValidity('');
  return true;
}

dateInput.addEventListener('change', checkDate);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!checkDate() || !form.reportValidity()) return;
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const { reference, statusUrl } = await api('/bookings', { method: 'POST', body: JSON.stringify(formData(form)) });
    form.hidden = true;
    document.getElementById('booking-done').hidden = false;
    document.getElementById('booking-reference').textContent = reference;
    document.getElementById('booking-status-link').href = new URL(statusUrl).pathname + new URL(statusUrl).search;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    if (err.body?.code === 'date_unavailable') unavailable.add(dateInput.value);
    showNotice(notice, 'error', err.message);
  } finally {
    button.disabled = false;
  }
});

init();
