// Shared helpers for the public pages.
const euro = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });

export function formatPrice(cents) {
  return euro.format(cents / 100);
}

export function formatDate(date) {
  return new Intl.DateTimeFormat('nl-NL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(`${date}T00:00:00Z`));
}

export async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) },
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.error || 'Er ging iets mis. Probeer het later opnieuw.');
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export function formData(form) {
  const data = Object.fromEntries(new FormData(form));
  for (const el of form.querySelectorAll('input[type=checkbox]')) data[el.name] = el.checked;
  return data;
}

export function showNotice(el, type, message) {
  el.className = `notice ${type}`;
  el.textContent = message;
  el.hidden = false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}


// Mobile menu.
const toggle = document.querySelector('.nav-toggle');
const nav = document.getElementById('site-nav');
if (toggle && nav) {
  toggle.addEventListener('click', () => {
    const open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
  });
}

// Mark the current page in the menu.
for (const a of document.querySelectorAll('.nav a:not(.btn)')) {
  const href = a.getAttribute('href');
  if (href !== '/' && (location.pathname === href || location.pathname.startsWith(`${href}/`))) {
    a.setAttribute('aria-current', 'page');
  }
}

// Review carousel arrows.
for (const button of document.querySelectorAll('[data-scroll]')) {
  button.addEventListener('click', () => {
    const track = button.closest('.section')?.querySelector('.reviews');
    if (track) track.scrollBy({ left: Number(button.dataset.scroll) * track.clientWidth * 0.9, behavior: 'smooth' });
  });
}

// The header lies transparent over the photo at the top of a page and turns solid once you scroll.
const header = document.querySelector('.site-header');
if (header) {
  const setScrolled = () => header.classList.toggle('scrolled', scrollY > 24);
  addEventListener('scroll', setScrolled, { passive: true });
  setScrolled();
}

// Booking button that stays in view on phones, once the visitor scrolls past the first screen.
const stickyCta = document.querySelector('.sticky-cta');
if (stickyCta && !/^\/(reserveer|status|betalen)/.test(location.pathname)) {
  const toggleCta = () => {
    stickyCta.hidden = scrollY < 220;
    // The WhatsApp button moves up to make room.
    document.body.classList.toggle('cta-visible', !stickyCta.hidden);
  };
  addEventListener('scroll', toggleCta, { passive: true });
  toggleCta();
}

// The Google score opens a panel with reviews. Without JavaScript the link goes to the reviews page.
const reviewsPanel = document.getElementById('reviews-panel');
if (reviewsPanel?.showModal) {
  for (const opener of document.querySelectorAll('[data-reviews-open]')) {
    opener.addEventListener('click', (event) => {
      event.preventDefault();
      reviewsPanel.showModal();
    });
  }
  reviewsPanel.addEventListener('click', (event) => {
    // A click on the dark area beside the panel, or on the close button, closes it.
    if (event.target === reviewsPanel || event.target.closest('[data-reviews-close]')) reviewsPanel.close();
  });
}
