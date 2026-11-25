// The link at the bottom of a mailing: one visit is enough to be taken off the list. Only after
// that, the visitor may say why, if they want to.
const text = document.getElementById('unsub-text');
const why = document.getElementById('unsub-why');
const token = new URLSearchParams(location.search).get('t');
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

if (!token) {
  text.textContent = 'Deze link is niet compleet. Stuur een mailtje naar contact@gamerxp.nl, dan halen we je van de lijst.';
} else {
  post('/api/unsubscribe', { token })
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
      text.textContent = res.ok
        ? `Je bent afgemeld (${data.email}). Je krijgt geen mailings meer van ons. Mails over een eigen boeking krijg je nog wel.`
        : 'Deze afmeldlink kennen we niet (meer). Stuur een mailtje naar contact@gamerxp.nl, dan halen we je van de lijst.';
      why.hidden = !res.ok;
    })
    .catch(() => { text.textContent = 'Afmelden lukte nu niet. Probeer het later opnieuw of mail naar contact@gamerxp.nl.'; });
}

async function sendReason(reason) {
  if (!reason) return;
  await post('/api/unsubscribe/reason', { token, reason }).catch(() => {});
  why.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'Dank je wel, dat helpt ons.' }));
}
for (const button of why.querySelectorAll('[data-reason]')) button.addEventListener('click', () => sendReason(button.dataset.reason));
why.addEventListener('submit', (event) => { event.preventDefault(); sendReason(document.getElementById('unsub-other').value.trim()); });
