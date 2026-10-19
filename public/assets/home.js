import { api, formData, formatPrice, showNotice } from './site.js';

async function loadPackages() {
  const container = document.getElementById('packages');
  try {
    const packages = await api('/packages');
    container.replaceChildren(
      ...packages.map((p) => {
        const card = document.createElement('article');
        card.className = 'card package';
        card.innerHTML = `
          <h3></h3>
          <div class="price"></div>
          <p class="desc"></p>
          <ul>
            <li>Tot <strong class="players"></strong> kinderen tegelijk</li>
            <li><strong class="hours"></strong> uur gamen</li>
            <li>Opbouwen en opruimen inbegrepen</li>
          </ul>
          <a class="btn">Kies dit pakket</a>`;
        card.querySelector('h3').textContent = p.name;
        card.querySelector('.price').textContent = formatPrice(p.priceCents);
        card.querySelector('.desc').textContent = p.description;
        card.querySelector('.players').textContent = p.maxPlayers;
        card.querySelector('.hours').textContent = String(p.durationHours).replace('.', ',');
        card.querySelector('a').href = `/boeken?pakket=${encodeURIComponent(p.slug)}`;
        return card;
      }),
    );
    if (!packages.length) container.textContent = 'Binnenkort vind je hier onze pakketten.';
  } catch {
    container.textContent = 'De pakketten konden niet worden geladen. Probeer het later opnieuw.';
  }
}

const contactForm = document.getElementById('contact-form');
const contactNotice = document.getElementById('contact-notice');
contactForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = contactForm.querySelector('button');
  button.disabled = true;
  try {
    await api('/contact', { method: 'POST', body: JSON.stringify(formData(contactForm)) });
    contactForm.reset();
    showNotice(contactNotice, 'ok', 'Bedankt voor je bericht! We nemen zo snel mogelijk contact met je op.');
  } catch (err) {
    showNotice(contactNotice, 'error', err.message);
  } finally {
    button.disabled = false;
  }
});

loadPackages();
