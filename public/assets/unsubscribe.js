// The link at the bottom of a mailing: one visit is enough to be taken off the list.
const text = document.getElementById('unsub-text');
const token = new URLSearchParams(location.search).get('t');
if (!token) {
  text.textContent = 'Deze link is niet compleet. Stuur een mailtje naar contact@gamerxp.nl, dan halen we je van de lijst.';
} else {
  fetch('/api/unsubscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) })
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
      text.textContent = res.ok
        ? `Je bent afgemeld (${data.email}). Je krijgt geen mailings meer van ons. Mails over een eigen boeking krijg je nog wel.`
        : 'Deze afmeldlink kennen we niet (meer). Stuur een mailtje naar contact@gamerxp.nl, dan halen we je van de lijst.';
    })
    .catch(() => { text.textContent = 'Afmelden lukte nu niet. Probeer het later opnieuw of mail naar contact@gamerxp.nl.'; });
}
