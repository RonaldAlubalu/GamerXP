import { api, formData, showNotice } from './site.js';

// The request form for LAN parties, tournaments and events. It arrives in the admin under
// Berichten, like the contact form, with the details laid out at the top of the message.
const form = document.getElementById('event-form');
const notice = document.getElementById('event-notice');

// A button on one of the cards picks that kind in the form.
for (const link of document.querySelectorAll('a[data-kind]')) {
  link.addEventListener('click', () => (form.elements.kind.value = link.dataset.kind));
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!form.reportValidity()) return;
  const d = formData(form);
  const facts = [
    `Aanvraag: ${d.kind}`,
    d.date && `Datum: ${new Date(`${d.date}T00:00:00`).toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`,
    d.people && `Aantal deelnemers: ${d.people}`,
    d.place && `Plaats of locatie: ${d.place}`,
  ].filter(Boolean);
  const lines = [...facts, '', d.details];
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    await api('/contact', {
      method: 'POST',
      body: JSON.stringify({ name: d.name, email: d.email, phone: d.phone, message: lines.join('\n'), website: d.website }),
    });
    form.reset();
    showNotice(notice, 'ok', 'Bedankt voor je aanvraag! We streven ernaar binnen 24 uur te reageren met een voorstel.');
  } catch (err) {
    showNotice(notice, 'error', err.message);
  } finally {
    button.disabled = false;
  }
});
