// Menu on a phone.
const burger = document.querySelector('.burger');
const menu = document.getElementById('mobile-menu');
if (burger && menu) {
  burger.addEventListener('click', () => {
    const open = menu.hidden;
    menu.hidden = !open;
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Menu sluiten' : 'Menu openen');
    document.body.classList.toggle('menu-open', open);
  });
}

// "What others say": the arrows move one quote at a time.
for (const box of document.querySelectorAll('[data-reviews]')) {
  const track = box.querySelector('.reviews-track');
  const prev = box.querySelector('[data-prev]');
  const next = box.querySelector('[data-next]');
  const step = () => track.firstElementChild.getBoundingClientRect().width + parseFloat(getComputedStyle(track).columnGap || 0);
  const update = () => {
    prev.disabled = track.scrollLeft < 4;
    next.disabled = track.scrollLeft + track.clientWidth > track.scrollWidth - 4;
  };
  prev.addEventListener('click', () => track.scrollBy({ left: -step() }));
  next.addEventListener('click', () => track.scrollBy({ left: step() }));
  track.addEventListener('scroll', update, { passive: true });
  update();
}

// The form for a printed copy opens in a small window.
for (const button of document.querySelectorAll('[data-open]')) {
  const dialog = document.getElementById(button.dataset.open);
  button.addEventListener('click', () => dialog.showModal());
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
}

// Forms go to the site's own address; when that fails the visitor is told to mail instead.
for (const form of document.querySelectorAll('form[data-form]')) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const note = form.querySelector('.form-note');
    const button = form.querySelector('button[type=submit]');
    const fields = Object.fromEntries(new FormData(form));
    button.disabled = true;
    let ok = false;
    try {
      const res = await fetch('/api/form', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ form: form.dataset.form, fields }),
      });
      ok = res.ok;
    } catch {
      ok = false;
    }
    button.disabled = false;
    note.hidden = false;
    if (!ok) {
      note.innerHTML = 'Het versturen is niet gelukt. Mail gerust naar <a href="mailto:info@gatra.nl">info@gatra.nl</a>.';
      return;
    }
    note.textContent = form.dataset.thanks;
    if (form.dataset.download) {
      const link = document.createElement('a');
      link.href = form.dataset.download;
      link.textContent = 'Download het inclusieve spelalfabet (pdf)';
      link.setAttribute('download', '');
      note.append(document.createElement('br'), link);
    }
    for (const el of form.querySelectorAll('label, button[type=submit]')) el.hidden = true;
  });
}
