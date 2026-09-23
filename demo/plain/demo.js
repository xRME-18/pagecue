// A public demo never sends registration details anywhere.
const form = document.getElementById('registration');
form?.addEventListener('submit', (event) => {
  event.preventDefault();
  const status = document.getElementById('demo-status');
  if (status) status.textContent = 'Demo only — nothing was sent.';
});
