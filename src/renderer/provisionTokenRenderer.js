'use strict';

const tokenInput = document.getElementById('token');
const errorEl = document.getElementById('error');
const submitButton = document.getElementById('submit');
const cancelButton = document.getElementById('cancel');

function submit() {
  const value = tokenInput.value.trim();
  if (!value) {
    errorEl.textContent = 'Enter a token first.';
    return;
  }
  window.provisionTokenAPI.submit(value);
}

submitButton.addEventListener('click', submit);
cancelButton.addEventListener('click', () => window.provisionTokenAPI.cancel());
tokenInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') submit();
});
