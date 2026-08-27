'use strict';

const FIELDS = ['studioName', 'googleReviewLink', 'defaultCountryCode', 'template'];

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

  await chrome.storage.sync.set(values);

  const saved = document.getElementById('saved');
  saved.hidden = false;
  setTimeout(() => { saved.hidden = true; }, 2000);
});

restore();

/* ------------------------- резервно копие ------------------------- */

const backupMsg = document.getElementById('backupMsg');

function say(text) {
  backupMsg.hidden = false;
  backupMsg.textContent = text;
}

async function showStats() {
  setCountryCode((await loadSettings()).defaultCountryCode);
  const invites = await loadInvites();
  const clients = Object.keys(await loadClients()).length;

  document.getElementById('stats').textContent =
    `${invites.size} ${invites.size === 1 ? 'изпратена покана' : 'изпратени покани'} · ` +
    `${clients} ${clients === 1 ? 'запомнен клиент' : 'запомнени клиенти'}`;
}

document.getElementById('export').addEventListener('click', async () => {
  const backup = await exportBackup();
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = `pokani-za-revyu-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();

  // Пуснатият URL остава в паметта, докато не бъде освободен.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  say(`Свалени ${Object.keys(backup.invites).length} покани.`);
});

document.getElementById('importFile').addEventListener('change', async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  try {
    const result = await importBackup(JSON.parse(await file.text()));
    say(`Възстановени ${result.added} нови покани от ${result.total} в копието.`);
    await showStats();
  } catch (error) {
    say(`Не се получи: ${error.message}`);
  } finally {
    event.target.value = '';
  }
});

showStats();
