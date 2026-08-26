'use strict';

/**
 * Слага плаващ бутон в интерфейса на Setmore.
 *
 * Setmore е приложение, чиито класове и структура се менят без предупреждение,
 * затова не се закачаме за конкретни селектори. Вместо това търсим телефонен
 * номер и име в това, което в момента се вижда на екрана, и винаги оставяме
 * полетата редактируеми — така бутонът работи дори интерфейсът да се промени.
 */

const PHONE_PATTERN = /(?:\+|00)?\d[\d\s().-]{7,17}\d/g;

let settings = null;
let panel = null;

/* --------------------------- разчитане на екрана --------------------------- */

/** Най-горният видим диалог/панел, ако има такъв — иначе цялата страница. */
function activeScope() {
  const candidates = [...document.querySelectorAll('[role="dialog"], .modal, .popup, aside, [class*="detail"]')]
    .filter((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 200 && rect.height > 120 && style.visibility !== 'hidden' && style.display !== 'none';
    });

  if (!candidates.length) return document.body;
  // Най-малкият подходящ елемент е обикновено най-конкретният (детайлът на часа).
  return candidates.sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    return ra.width * ra.height - rb.width * rb.height;
  })[0];
}

function visibleText(scope) {
  return (scope.innerText || '').replace(/ /g, ' ');
}

function detectPhones(scope) {
  const found = new Set();

  // 1. Най-надеждният източник: tel: линкове.
  scope.querySelectorAll('a[href^="tel:"]').forEach((link) => {
    const phone = normalizePhone(decodeURIComponent(link.getAttribute('href').slice(4)), settings.defaultCountryCode);
    if (phone) found.add(phone);
  });

  // 2. Полета за въвеждане, които вече имат стойност.
  scope.querySelectorAll('input').forEach((input) => {
    if (!input.value || input.type === 'password') return;
    const phone = normalizePhone(input.value, settings.defaultCountryCode);
    if (phone && /\d{6}/.test(input.value)) found.add(phone);
  });

  // 3. Последна възможност: текстът на екрана.
  const matches = visibleText(scope).match(PHONE_PATTERN) || [];
  matches.forEach((match) => {
    const phone = normalizePhone(match, settings.defaultCountryCode);
    if (phone) found.add(phone);
  });

  return [...found];
}

function detectName(scope) {
  // Имената в Setmore се показват като заглавие на панела с часа.
  const headings = scope.querySelectorAll('h1, h2, h3, h4, [class*="name"], [class*="title"]');
  for (const node of headings) {
    const text = (node.textContent || '').trim().replace(/\s+/g, ' ');
    // Две-три думи с главни букви, без цифри — прилича на име на човек.
    if (/^[^\d@]{2,60}$/.test(text) && /^\p{Lu}/u.test(text) && text.split(' ').length <= 3) {
      return text;
    }
  }
  return '';
}

/* ------------------------------- интерфейс ------------------------------- */

function buildMessage() {
  return renderTemplate(settings.template, {
    name: panel.querySelector('#gr-name').value,
    studio: settings.studioName,
    link: settings.googleReviewLink,
  });
}

function refreshMessage() {
  panel.querySelector('#gr-msg').value = buildMessage();
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

function setHint(text, isWarning = false) {
  const hint = panel.querySelector('#gr-hint');
  hint.textContent = text;
  hint.classList.toggle('gr-warn', isWarning);
}

function fillFromPage() {
  const scope = activeScope();
  const phones = detectPhones(scope);
  const select = panel.querySelector('#gr-phone');

  select.innerHTML = '';
  phones.forEach((phone) => {
    const option = document.createElement('option');
    option.value = phone;
    option.textContent = phone;
    select.append(option);
  });

  const manual = document.createElement('option');
  manual.value = '';
  manual.textContent = phones.length ? '— друг номер —' : '— въведи номер —';
  select.append(manual);

  const name = detectName(scope);
  if (name) panel.querySelector('#gr-name').value = name;

  togglePhoneInput();
  refreshMessage();

  setHint(
    phones.length
      ? `Намерени ${phones.length} ${phones.length === 1 ? 'номер' : 'номера'} на екрана. Провери дали е правилният.`
      : 'Не намерих телефон на екрана. Отвори часа на клиента или въведи номера на ръка.',
    phones.length === 0
  );
}

function togglePhoneInput() {
  const select = panel.querySelector('#gr-phone');
  const manualInput = panel.querySelector('#gr-phone-manual');
  manualInput.hidden = Boolean(select.value);
  updateButtons();
}

function currentPhone() {
  const select = panel.querySelector('#gr-phone');
  if (select.value) return select.value;
  return normalizePhone(panel.querySelector('#gr-phone-manual').value, settings.defaultCountryCode);
}

function updateButtons() {
  const usable = Boolean(currentPhone());
  panel.querySelector('#gr-wa').disabled = !usable;
  panel.querySelector('#gr-vb').disabled = !usable;
}

function createPanel() {
  const node = document.createElement('div');
  node.id = 'gr-panel';
  node.hidden = true;
  node.innerHTML = `
    <h2>Покана за Google ревю</h2>
    <label for="gr-name">Име на клиента</label>
    <input id="gr-name" type="text" placeholder="Мария">
    <label for="gr-phone">Телефон</label>
    <select id="gr-phone"></select>
    <input id="gr-phone-manual" type="tel" placeholder="0888 123 456" hidden>
    <label for="gr-msg">Съобщение</label>
    <textarea id="gr-msg" rows="6"></textarea>
    <div id="gr-actions">
      <button id="gr-wa" type="button">WhatsApp</button>
      <button id="gr-vb" type="button">Viber</button>
      <button id="gr-copy" type="button">Копирай</button>
    </div>
    <p id="gr-hint"></p>
  `;
  document.body.append(node);
  panel = node;

  node.querySelector('#gr-name').addEventListener('input', refreshMessage);
  node.querySelector('#gr-phone').addEventListener('change', togglePhoneInput);
  node.querySelector('#gr-phone-manual').addEventListener('input', updateButtons);

  node.querySelector('#gr-wa').addEventListener('click', () => {
    const phone = currentPhone();
    if (!phone) return;
    window.open(whatsappLink(phone, node.querySelector('#gr-msg').value), '_blank', 'noopener');
  });

  node.querySelector('#gr-vb').addEventListener('click', async () => {
    const phone = currentPhone();
    if (!phone) return;
    // Viber не приема готов текст при отваряне на чат — затова първо го копираме.
    const copied = await copyToClipboard(node.querySelector('#gr-msg').value);
    setHint(copied ? 'Текстът е копиран — залепи го във Viber.' : 'Копирай текста на ръка и го залепи във Viber.', !copied);
    window.location.href = viberLink(phone);
  });

  node.querySelector('#gr-copy').addEventListener('click', async () => {
    const copied = await copyToClipboard(node.querySelector('#gr-msg').value);
    setHint(copied ? 'Съобщението е копирано.' : 'Копирането не се получи — маркирай текста на ръка.', !copied);
  });

  return node;
}

function createLauncher() {
  const button = document.createElement('button');
  button.id = 'gr-launcher';
  button.type = 'button';
  button.textContent = '⭐';
  button.title = 'Покани клиента за отзив в Google';

  button.addEventListener('click', async () => {
    if (!panel) createPanel();

    if (!panel.hidden) {
      panel.hidden = true;
      return;
    }

    // Настройките се презареждат при всяко отваряне — може да са сменени
    // в друг таб, без страницата да е презареждана.
    settings = await loadSettings();
    fillFromPage();
    if (!settings.googleReviewLink) {
      setHint('Липсва линк към Google профила. Отвори настройките на разширението и го добави.', true);
    }
    panel.hidden = false;
  });

  document.body.append(button);
}

async function init() {
  settings = await loadSettings();
  createLauncher();
}

init();
