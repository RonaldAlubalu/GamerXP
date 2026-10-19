import { api, formData, formatDate, formatPrice, showNotice } from './site.js';

const notice = document.getElementById('status-notice');
const lookupForm = document.getElementById('lookup-form');
const statusView = document.getElementById('status-view');

const SLOTS = { ochtend: 'ochtend', middag: 'middag', avond: 'avond' };
const fmtDay = (d) => new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'short' }).format(new Date(d));

function render(s) {
  document.getElementById('st-label').textContent = s.statusLabel.toUpperCase();
  document.getElementById('st-title').textContent = s.childName ? `Het feest van ${s.childName}` : 'Jouw Gamer Xperience feest';
  document.getElementById('st-text').textContent = s.statusText;

  document.getElementById('st-steps').replaceChildren(
    ...s.steps.map((step, i) => {
      const li = document.createElement('li');
      li.className = step.state;
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.textContent = step.state === 'done' ? '✓' : i + 1;
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = step.label;
      li.append(dot, label);
      if (step.at) {
        const at = document.createElement('small');
        at.textContent = fmtDay(step.at);
        li.append(at);
      }
      return li;
    }),
  );

  const outstanding = Math.max(s.priceCents - s.paidCents, 0);
  const rows = [
    ['Referentie', s.reference],
    ['Datum', s.startTime ? `${formatDate(s.partyDate)} om ${s.startTime}` : `${formatDate(s.partyDate)} (${SLOTS[s.timeSlot] ?? s.timeSlot})`],
    ['Pakket', s.packageName + (s.extraStations ? ` + ${s.extraStations} extra gamestation${s.extraStations > 1 ? 's' : ''}` : '')],
    ...(s.guestCount ? [['Aantal kinderen', s.guestCount]] : []),
    ['Prijs', formatPrice(s.priceCents)],
    ...(s.depositCents ? [['Aanbetaling', formatPrice(s.depositCents)]] : []),
    ...(s.status !== 'cancelled' ? [['Nog te betalen', outstanding ? formatPrice(outstanding) : 'Niets, alles is betaald ✓']] : []),
  ];
  document.getElementById('st-summary').replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      return [dt, dd];
    }),
  );
  lookupForm.hidden = true;
  statusView.hidden = false;
}

async function load(token) {
  try {
    render(await api(`/status/${encodeURIComponent(token)}`));
  } catch (err) {
    showNotice(notice, 'error', err.message);
    lookupForm.hidden = false;
  }
}

lookupForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!lookupForm.reportValidity()) return;
  try {
    const { token } = await api('/status/lookup', { method: 'POST', body: JSON.stringify(formData(lookupForm)) });
    history.replaceState(null, '', `/status?t=${encodeURIComponent(token)}`);
    notice.hidden = true;
    await load(token);
  } catch (err) {
    showNotice(notice, 'error', err.message);
  }
});

const token = new URLSearchParams(location.search).get('t');
if (token) load(token);
else lookupForm.hidden = false;
