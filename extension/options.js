'use strict';

const FIELDS = ['studioName', 'googleReviewLink', 'defaultCountryCode', 'viberMode', 'template'];

async function restore() {
  const settings = await loadSettings();
  FIELDS.forEach((field) => {
    document.getElementById(field).value = settings[field] || '';
  });
}

document.getElementById('save').addEventListener('click', async () => {
  const values = {};
  FIELDS.forEach((field) => {
    values[field] = document.getElementById(field).value.trim();
  });
  // Празен код на държава би счупил номерата — връщаме стойността по подразбиране.
  if (!values.defaultCountryCode) values.defaultCountryCode = DEFAULT_SETTINGS.defaultCountryCode;
  if (!values.template) values.template = DEFAULT_SETTINGS.template;
  if (!values.viberMode) values.viberMode = DEFAULT_SETTINGS.viberMode;

  await chrome.storage.sync.set(values);

  const saved = document.getElementById('saved');
  saved.hidden = false;
  setTimeout(() => { saved.hidden = true; }, 2000);
});

restore();
