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

// Booking bar that stays in view on phones. On the home page it takes over from the green
// button under the first text at the moment that button scrolls out of view; elsewhere it
// appears once the visitor scrolls past the first screen.
const stickyCta = document.querySelector('.sticky-cta');
if (stickyCta && !/^\/(reserveer|status|betalen)/.test(location.pathname)) {
  const showCta = (visible) => {
    stickyCta.classList.toggle('show', visible);
    stickyCta.tabIndex = visible ? 0 : -1;
    document.body.classList.toggle('cta-visible', visible);
  };
  stickyCta.hidden = false;
  showCta(false);
  const firstButton = document.querySelector('.intro-action .btn');
  if (firstButton && 'IntersectionObserver' in window) {
    // The top margin stands for the header the button slides under.
    new IntersectionObserver(([entry]) => showCta(!entry.isIntersecting && entry.boundingClientRect.top < 100), { rootMargin: '-76px 0px 0px 0px' })
      .observe(firstButton);
  } else {
    const toggleCta = () => showCta(scrollY >= 220);
    addEventListener('scroll', toggleCta, { passive: true });
    toggleCta();
  }
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

// Cookie choice. The site itself needs no consent; YouTube videos do, because YouTube places
// cookies when a video plays. The choice is kept in this browser.
const CONSENT_KEY = 'gxp_consent';
const getConsent = () => {
  try { return localStorage.getItem(CONSENT_KEY); } catch { return null; }
};
const setConsent = (value) => {
  try { localStorage.setItem(CONSENT_KEY, value); } catch {}
};
const cookieBanner = document.getElementById('cookie-banner');
if (cookieBanner) {
  const show = (visible) => {
    cookieBanner.hidden = !visible;
    document.body.classList.toggle('cookie-open', visible);
  };
  show(!getConsent());
  for (const button of cookieBanner.querySelectorAll('[data-cookie-choice]')) {
    button.addEventListener('click', () => {
      setConsent(button.dataset.cookieChoice);
      show(false);
    });
  }
  for (const link of document.querySelectorAll('[data-cookie-settings]')) link.addEventListener('click', () => show(true));
}

// YouTube videos load only on a click, and only with consent for YouTube's cookies.
for (const video of document.querySelectorAll('[data-youtube]')) {
  const play = () => {
    const frame = document.createElement('iframe');
    frame.src = `https://www.youtube-nocookie.com/embed/${video.dataset.youtube}?autoplay=1&rel=0&playsinline=1`;
    frame.title = video.dataset.title || 'Video';
    frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    frame.allowFullscreen = true;
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    video.replaceChildren(frame);
  };
  const note = video.querySelector('.video-note');
  video.querySelector('.video-play')?.addEventListener('click', () => {
    if (getConsent() === 'all') return play();
    note.hidden = false;
    note.querySelector('button').focus();
  });
  video.querySelector('[data-video-accept]')?.addEventListener('click', () => {
    setConsent('all');
    if (cookieBanner) { cookieBanner.hidden = true; document.body.classList.remove('cookie-open'); }
    play();
  });
}
