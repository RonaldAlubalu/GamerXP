import { api, formData, showNotice } from './site.js';

const form = document.getElementById('contact-form');
const notice = document.getElementById('contact-notice');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!form.reportValidity()) return;
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    await api('/contact', { method: 'POST', body: JSON.stringify(formData(form)) });
    form.reset();
    showNotice(notice, 'ok', 'Bedankt voor je bericht! We reageren meestal binnen een paar uur.');
  } catch (err) {
    showNotice(notice, 'error', err.message);
  } finally {
    button.disabled = false;
  }
});
