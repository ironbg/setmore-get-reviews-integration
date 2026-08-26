'use strict';

/**
 * Вкарва бутон „Покани за Google ревю“ директно в прозореца, който Setmore
 * отваря при натискане на запазен час.
 *
 * Setmore е приложение, чиито класове се менят без предупреждение, затова
 * не се закачаме за конкретни селектори. Вместо това следим за появил се
 * изскачащ прозорец и разпознаваме кой е той по съдържанието му: този, в
 * който има телефонен номер, е прозорецът с часа.
 *
 * Ако разпознаването се обърка, плаващият бутон долу вдясно винаги отваря
 * панел с полета на ръка и с диагностика, която показва какво е видяно.
 */

const MARK = 'data-gr-injected';
const SCAN_DELAY_MS = 250;

/*
 * Клонове, които не са видим текст. Пропускането им е задължително:
 * вграденият JavaScript на страницата съдържа дълги поредици от цифри и
 * телефонни номера от примери, които иначе минават за номер на клиента.
 */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'HEAD', 'LINK', 'META']);

let settings = null;
let panel = null;
let scanTimer = null;
let lastDiagnostics = null;

/* --------------------------- четене на екрана --------------------------- */

/**
 * Обхожда и отворените shadow root-ове — иначе част от интерфейса остава
 * невидима.
 *
 * Редът е важен: разпознаването на име разчита редовете да идват така, както
 * се четат на екрана. Затова децата се слагат в стека обърнати — при pop()
 * излизат в правилния ред.
 */
function walk(root, visit) {
  const stack = [root];

  while (stack.length) {
    const node = stack.pop();
    if (!node || node.nodeType !== 1) continue;
    if (SKIP_TAGS.has(node.tagName)) continue;
    if (node.hasAttribute && node.hasAttribute(MARK)) continue; // нашият собствен бутон

    visit(node);

    const children = [];
    if (node.shadowRoot) children.push(...node.shadowRoot.children);
    children.push(...node.children);

    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
  }
}

/** Коренните елементи съдържат всичко и никога не са изскачащият прозорец. */
function isPanelLike(element) {
  return element !== document.body && element !== document.documentElement;
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  if (rect.width < 8 || rect.height < 8) return false;

  const style = getComputedStyle(element);
  return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
}

/**
 * Събира всичко четимо от даден клон: видим текст, стойности на полета,
 * tel: линкове и подсказки. Само innerText не стига — в Setmore телефонът
 * често е стойност на input, която innerText не връща.
 */
function harvest(scope) {
  const lines = [];
  const extras = [];

  const pushLine = (value) => {
    const text = String(value || '').replace(/ /g, ' ').trim();
    if (text) lines.push(text);
  };

  walk(scope, (node) => {
    const tag = node.tagName;

    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      // offsetParent е null при display:none — скрит прозорец не бива да
      // подава телефон, докато на екрана не се вижда нищо.
      if (node.type !== 'password' && node.value && node.offsetParent !== null) {
        extras.push(node.value);
      }
      return;
    }

    if (tag === 'A' && node.getAttribute('href') && node.getAttribute('href').startsWith('tel:')) {
      extras.push(decodeURIComponent(node.getAttribute('href').slice(4)));
    }

    for (const attribute of ['aria-label', 'title']) {
      const value = node.getAttribute && node.getAttribute(attribute);
      if (value) extras.push(value);
    }

    // Само листата носят собствен текст; иначе всеки родител го повтаря.
    if (!node.children.length) pushLine(node.textContent);
  });

  return { lines, text: [...lines, ...extras].join('\n') };
}

/**
 * Кои елементи изобщо могат да са изскачащият прозорец.
 * Първо търсим обичайните роли и имена на класове, после — плаващи слоеве.
 */
function panelCandidates() {
  const hinted = document.querySelectorAll(
    '[role="dialog"], [aria-modal="true"], [class*="modal"], [class*="popup"], [class*="dialog"], ' +
      '[class*="drawer"], [class*="detail"], [class*="slide"], [class*="panel"], [class*="overlay"], [class*="card"]'
  );

  const candidates = [...hinted];

  // Плаващ слой без говорещо име на клас — например обикновен div с position:fixed.
  document.querySelectorAll('body > div, body > div > div').forEach((node) => {
    const position = getComputedStyle(node).position;
    if (position === 'fixed' || position === 'absolute') candidates.push(node);
  });

  return candidates.filter((node) => {
    if (node.hasAttribute(MARK) || !isPanelLike(node)) return false;
    const rect = node.getBoundingClientRect();
    // Цял екран е фонът на приложението, а няколко пиксела не е прозорец.
    if (rect.width < 180 || rect.height < 90) return false;
    if (rect.width > window.innerWidth * 0.98 && rect.height > window.innerHeight * 0.98) return false;
    return isVisible(node);
  });
}

/**
 * Резервно търсене, което влиза в сила само ако бързото не е намерило нищо.
 * Обхожда цялото дърво заедно с отворените shadow root-ове — там
 * querySelectorAll не стига.
 */
function deepCandidates() {
  const found = [];

  walk(document.documentElement, (node) => {
    if (!isPanelLike(node)) return;
    const rect = node.getBoundingClientRect();
    if (rect.width < 180 || rect.height < 90) return;
    if (rect.width > window.innerWidth * 0.98 && rect.height > window.innerHeight * 0.98) return;
    if (isVisible(node)) found.push(node);
  });

  return found;
}

function scoreCandidates(candidates) {
  const scored = [];

  for (const candidate of candidates) {
    const harvested = harvest(candidate);
    const phones = findPhones(harvested.text, settings.defaultCountryCode);
    if (!phones.length) continue;

    const rect = candidate.getBoundingClientRect();
    scored.push({ element: candidate, phones, lines: harvested.lines, area: rect.width * rect.height });
  }

  // Най-малкият, защото по-големите слоеве съдържат номера само защото го обгръщат.
  return scored.sort((a, b) => a.area - b.area)[0] || null;
}

/**
 * Прозорец, който изглежда като диалог, но в него няма телефон.
 * Пак слагаме лентата — бутонът „Провери“ дава начин номерът да се въведе,
 * вместо потребителят да остане с празни ръце.
 */
function findPhonelessDialog() {
  const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(
    (node) => !node.hasAttribute(MARK) && isVisible(node)
  );

  for (const dialog of dialogs) {
    const harvested = harvest(dialog);
    if (findPhones(harvested.text, settings.defaultCountryCode).length) continue;
    if (pickName(harvested.lines)) {
      return { element: dialog, phones: [], lines: harvested.lines };
    }
  }

  return null;
}

/** Прозорецът с часа е най-малкият видим слой, в който има телефонен номер. */
function findAppointmentPanel() {
  return scoreCandidates(panelCandidates()) || scoreCandidates(deepCandidates());
}

/* ------------------------------ съобщение ------------------------------ */

function buildMessage(name) {
  return renderTemplate(settings.template, {
    name,
    studio: settings.studioName,
    link: settings.googleReviewLink,
  });
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

function openWhatsApp(phone, message) {
  window.open(whatsappLink(phone, message), '_blank', 'noopener');
}

async function openViber(phone, message, notify) {
  // Viber не приема готов текст при отваряне на чат — затова първо го копираме.
  const copied = await copyToClipboard(message);
  notify(copied ? 'Текстът е копиран — залепи го във Viber.' : 'Копирай текста на ръка и го залепи във Viber.');
  window.location.href = viberLink(phone);
}

/* --------------------- бутонът вътре в прозореца --------------------- */

function buildInlineBar(found) {
  const name = pickName(found.lines);
  const phone = found.phones[0] || null;

  const bar = document.createElement('div');
  bar.setAttribute(MARK, '1');
  bar.className = 'gr-bar';
  // Записваме за кого е лентата — прозорецът се преизползва при отваряне на
  // друг час и иначе бутонът би пратил съобщение на предишния клиент.
  bar.dataset.grFor = `${phone}|${name}`;

  const label = document.createElement('span');
  label.className = 'gr-bar-label';
  label.textContent = '⭐ Покани за ревю';

  const status = document.createElement('span');
  status.className = 'gr-bar-status';

  const notify = (text) => {
    status.textContent = text;
  };

  const whatsapp = document.createElement('button');
  whatsapp.type = 'button';
  whatsapp.className = 'gr-bar-btn gr-wa';
  whatsapp.textContent = 'WhatsApp';
  whatsapp.disabled = !phone;
  whatsapp.addEventListener('click', (event) => {
    event.stopPropagation();
    event.preventDefault();
    openWhatsApp(phone, buildMessage(name));
    notify('Отворено.');
  });

  const viber = document.createElement('button');
  viber.type = 'button';
  viber.className = 'gr-bar-btn gr-vb';
  viber.textContent = 'Viber';
  viber.disabled = !phone;
  viber.addEventListener('click', (event) => {
    event.stopPropagation();
    event.preventDefault();
    openViber(phone, buildMessage(name), notify);
  });

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'gr-bar-btn gr-edit';
  edit.textContent = 'Провери';
  edit.title = 'Отваря панела с името, номера и текста, за да ги провериш преди изпращане';
  edit.addEventListener('click', (event) => {
    event.stopPropagation();
    event.preventDefault();
    openPanel({ name, phones: found.phones });
  });

  bar.append(label, whatsapp, viber, edit, status);

  if (!phone) {
    notify('Не намерих телефон в този прозорец — натисни „Провери“, за да го въведеш.');
  } else if (!settings.googleReviewLink) {
    notify('Липсва линк към Google — виж настройките.');
  }

  return bar;
}

function injectInto(found) {
  const bar = buildInlineBar(found);
  const existing = found.element.querySelector('.gr-bar');

  if (existing) {
    if (existing.dataset.grFor === bar.dataset.grFor) return; // нищо не се е променило
    existing.replaceWith(bar);
    return;
  }

  found.element.append(bar);
}

/* ------------------------- панелът на ръка ------------------------- */

function createPanel() {
  const node = document.createElement('div');
  node.id = 'gr-panel';
  node.setAttribute(MARK, '1');
  node.hidden = true;
  node.innerHTML = `
    <div class="gr-panel-head">
      <h2>Покана за Google ревю</h2>
      <button id="gr-close" type="button" title="Затвори">×</button>
    </div>
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
    <button id="gr-diag" type="button" class="gr-link">Не разпознава клиента? Копирай диагностика</button>
  `;
  document.body.append(node);
  panel = node;

  const value = (id) => node.querySelector(id).value;
  const setHint = (text, isWarning = false) => {
    const hint = node.querySelector('#gr-hint');
    hint.textContent = text;
    hint.classList.toggle('gr-warn', isWarning);
  };

  const currentPhone = () => {
    const select = node.querySelector('#gr-phone');
    if (select.value) return select.value;
    return normalizePhone(value('#gr-phone-manual'), settings.defaultCountryCode);
  };

  const updateButtons = () => {
    const usable = Boolean(currentPhone());
    node.querySelector('#gr-wa').disabled = !usable;
    node.querySelector('#gr-vb').disabled = !usable;
  };

  const refreshMessage = () => {
    node.querySelector('#gr-msg').value = buildMessage(value('#gr-name'));
  };

  node.querySelector('#gr-close').addEventListener('click', () => { node.hidden = true; });
  node.querySelector('#gr-name').addEventListener('input', refreshMessage);
  node.querySelector('#gr-phone').addEventListener('change', () => {
    node.querySelector('#gr-phone-manual').hidden = Boolean(value('#gr-phone'));
    updateButtons();
  });
  node.querySelector('#gr-phone-manual').addEventListener('input', updateButtons);

  node.querySelector('#gr-wa').addEventListener('click', () => {
    const phone = currentPhone();
    if (phone) openWhatsApp(phone, value('#gr-msg'));
  });

  node.querySelector('#gr-vb').addEventListener('click', () => {
    const phone = currentPhone();
    if (phone) openViber(phone, value('#gr-msg'), (text) => setHint(text));
  });

  node.querySelector('#gr-copy').addEventListener('click', async () => {
    const copied = await copyToClipboard(value('#gr-msg'));
    setHint(copied ? 'Съобщението е копирано.' : 'Копирането не се получи — маркирай текста на ръка.', !copied);
  });

  node.querySelector('#gr-diag').addEventListener('click', async () => {
    const copied = await copyToClipboard(buildDiagnostics());
    setHint(
      copied
        ? 'Диагностиката е копирана. Залепи я в съобщение — номерата в нея са скрити.'
        : 'Копирането не се получи.',
      !copied
    );
  });

  node.refresh = { setHint, updateButtons, refreshMessage };
  return node;
}

/**
 * Отваря панела, попълнен с каквото е намерено.
 * Ако нищо не е намерено, взима маркирания на екрана текст — така клиентът
 * може да се подаде и на ръка, като се маркира номерът.
 */
function openPanel(prefill) {
  if (!panel) createPanel();

  const select = panel.querySelector('#gr-phone');
  const selection = String(window.getSelection ? window.getSelection().toString() : '');
  const phones = (prefill && prefill.phones && prefill.phones.length)
    ? prefill.phones
    : findPhones(selection, settings.defaultCountryCode);

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

  panel.querySelector('#gr-phone-manual').hidden = Boolean(select.value);
  panel.querySelector('#gr-name').value = (prefill && prefill.name) || '';

  panel.refresh.refreshMessage();
  panel.refresh.updateButtons();

  if (!settings.googleReviewLink) {
    panel.refresh.setHint('Липсва линк към Google профила. Отвори настройките на разширението.', true);
  } else if (!phones.length) {
    panel.refresh.setHint(
      'Не намерих телефон. Отвори часа в Setmore, маркирай номера на екрана и натисни бутона отново — или го въведи тук.',
      true
    );
  } else {
    panel.refresh.setHint(`Намерени ${phones.length} ${phones.length === 1 ? 'номер' : 'номера'}. Провери кой е верният.`);
  }

  panel.hidden = false;
}

/**
 * Кратък отчет какво вижда разширението — за случаите, когато не разпознава.
 * Цифрите се скриват, за да може отчетът да се сподели спокойно.
 */
function buildDiagnostics() {
  const candidates = panelCandidates();
  const report = [
    'Диагностика на разширението',
    `Адрес: ${location.hostname}${location.pathname}`,
    `Рамка: ${window.top === window ? 'основна' : 'вградена (iframe)'}`,
    `Възможни прозорци: ${candidates.length}`,
    '',
  ];

  candidates.slice(0, 6).forEach((element, index) => {
    const harvested = harvest(element);
    const phones = findPhones(harvested.text, settings.defaultCountryCode);
    const rect = element.getBoundingClientRect();

    report.push(
      `— слой ${index + 1}: <${element.tagName.toLowerCase()} class="${String(element.className).slice(0, 80)}">`,
      `  размер: ${Math.round(rect.width)}×${Math.round(rect.height)}, намерени номера: ${phones.length}`,
      `  редове: ${maskDigits(harvested.lines.slice(0, 12).join(' | ')).slice(0, 400)}`,
      ''
    );
  });

  if (!candidates.length) {
    report.push('Не намерих нито един слой — вероятно прозорецът е в друга рамка (iframe).');
  }

  lastDiagnostics = report.join('\n');
  return lastDiagnostics;
}

/* ------------------------------ следене ------------------------------ */

function scan() {
  if (!settings) return;

  const found = findAppointmentPanel() || findPhonelessDialog();
  if (found) injectInto(found);
}

function scheduleScan() {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scan, SCAN_DELAY_MS);
}

function createLauncher() {
  const button = document.createElement('button');
  button.id = 'gr-launcher';
  button.setAttribute(MARK, '1');
  button.type = 'button';
  button.textContent = '⭐';
  button.title = 'Покани клиента за отзив в Google';

  button.addEventListener('click', async () => {
    if (panel && !panel.hidden) {
      panel.hidden = true;
      return;
    }

    // Настройките се презареждат при всяко отваряне — може да са сменени
    // в друг таб, без страницата да е презареждана.
    settings = await loadSettings();

    const found = findAppointmentPanel();
    openPanel(found ? { name: pickName(found.lines), phones: found.phones } : null);
  });

  document.body.append(button);
}

async function init() {
  settings = await loadSettings();

  // Плаващият бутон има смисъл само в основната рамка — вградените рамки
  // само вкарват бутона в прозореца с часа.
  if (window.top === window) createLauncher();

  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // Прозорецът се отваря при натискане на час — сканираме и тогава, защото
  // част от промените идват без нови възли в DOM.
  document.addEventListener('click', scheduleScan, true);

  scheduleScan();
}

init();
