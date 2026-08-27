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

/**
 * Точките, за които се хващаме в Setmore.
 *
 * Setmore бележи своите елементи с data-testid. Тези атрибути се менят
 * несравнимо по-рядко от класовете, защото класовете са генерирани от
 * Tailwind (`px-2 lg:px-1.5 bg-positive-secondary …`) и се пренаписват при
 * всяка промяна по оформлението. Затова тук стоят testid-та, а гадаенето по
 * съдържание остава само като резерва, ако Setmore ги смени.
 */
const SETMORE = {
  // Футърът на прозореца с часа — там влизат бутоните.
  footer: '#appointment-footer, [data-testid="app-widget-footer"]',
  // Името на клиента.
  name:
    '[data-testid="app-widget-guest-added-name"], ' +
    '[data-testid*="guest"][data-testid*="name"], ' +
    '[data-testid*="customer-name"], [data-testid*="client-name"]',
};

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

/**
 * Елементи, появили се наскоро. Прозорецът с часа се появява веднага след
 * натискането — това е най-силният признак кой слой е той. Без него левият
 * панел, който стои там през цялото време, лесно печели.
 */
const recentRoots = [];
const RECENT_MS = 8000;

/**
 * Поканите се четат от chrome.storage асинхронно, а лентата се рисува
 * синхронно при всяка промяна по страницата. Затова се държат в паметта и
 * се обновяват при запис — иначе всяко пречертаване би чакало хранилището.
 */
let invites = new Map();

async function refreshInvites() {
  try {
    invites = await loadInvites();
  } catch (error) {
    console.warn('[Покани за ревю] Не успях да прочета историята:', error);
  }
}

function inviteFor(phone) {
  return invites.get(phoneKey(phone)) || null;
}

/** Записва поканата и обновява кеша, за да си личи веднага. */
async function markInvited(phone, name, channel) {
  const record = await recordInvite(phone, channel);
  if (record) invites.set(phoneKey(phone), record);
  scheduleScan();
  return record;
}

function noteAdded(nodes) {
  const now = Date.now();
  for (const node of nodes) {
    if (node && node.nodeType === 1 && !node.hasAttribute(MARK)) {
      recentRoots.push({ element: node, at: now });
    }
  }
  // Пазим списъка къс — иначе расте през целия сеанс.
  while (recentRoots.length && now - recentRoots[0].at > RECENT_MS) recentRoots.shift();
}

function appearedRecently(element) {
  const now = Date.now();
  return recentRoots.some(
    (entry) =>
      now - entry.at <= RECENT_MS &&
      (entry.element === element || entry.element.contains(element) || element.contains(entry.element))
  );
}

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

const NAV_SELECTOR =
  'nav, header, footer, [role="navigation"], [role="menu"], [role="menubar"], [role="banner"], ' +
  '[class*="sidebar"], [class*="side-nav"], [class*="sidenav"], [class*="navbar"], [class*="nav-"], ' +
  '[id*="sidebar"], [id*="menu"]';

/**
 * Менюта и заглавни ленти често съдържат телефона на самото студио.
 * Освен по роля ги познаваме и по гъстота на връзките: меню е предимно
 * линкове, а прозорец с час — предимно текст.
 */
function isNavigational(element) {
  if (element.closest(NAV_SELECTOR)) return true;

  const links = element.querySelectorAll('a[href]').length;
  const textLength = (element.textContent || '').trim().length;
  return links >= 4 && textLength < 800;
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
        pushLine(node.value);
      }
      return;
    }

    if (tag === 'A' && node.getAttribute('href') && node.getAttribute('href').startsWith('tel:')) {
      pushLine(decodeURIComponent(node.getAttribute('href').slice(4)));
    }

    for (const attribute of ['aria-label', 'title']) {
      const value = node.getAttribute && node.getAttribute(attribute);
      if (value) extras.push(value);
    }

    // Взимаме само собствените текстови възли на елемента. „Листа без деца“
    // не върши работа: <div>тел. 02 987 65 43<br>мобилен: …</div> има деца
    // (<br>) и целият му текст се губеше. Така и родителят не повтаря текста
    // на децата си.
    const own = [];
    for (const child of node.childNodes) {
      if (child.nodeType === 3) own.push(child.nodeValue);
    }
    pushLine(own.join(' '));
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

/**
 * Колко даден слой прилича на прозореца с часа.
 *
 * „Най-малкият слой с телефон“ не е достатъчно — лявото меню може да е
 * по-малко от прозореца и да спечели. Затова тежат признаци, които менюто
 * няма: че е диалог, че току-що се е появил и че номерът в него стои до
 * етикет „Телефон“.
 */
function scoreOf(element, ranked) {
  if (isNavigational(element)) return -Infinity;

  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  let score = 0;

  if (element.matches('[role="dialog"], [aria-modal="true"]')) score += 100;
  if (appearedRecently(element)) score += 70;
  if (style.position === 'fixed' || style.position === 'absolute') score += 25;
  if (Number(style.zIndex) > 0) score += 15;
  if (ranked.labeled) score += 40;

  // При равни други признаци по-малкият слой е по-вероятно самият прозорец.
  score -= (rect.width * rect.height) / 200000;

  return score;
}

function scoreCandidates(candidates) {
  const scored = [];

  for (const candidate of candidates) {
    const harvested = harvest(candidate);
    const ranked = rankPhones(harvested.lines, settings.defaultCountryCode);
    if (!ranked.phones.length) continue;

    const score = scoreOf(candidate, ranked);
    if (score === -Infinity) continue;

    scored.push({ element: candidate, phones: ranked.phones, lines: harvested.lines, score });
  }

  return scored.sort((a, b) => b.score - a.score)[0] || null;
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
    if (isNavigational(dialog)) continue;
    const harvested = harvest(dialog);
    if (rankPhones(harvested.lines, settings.defaultCountryCode).phones.length) continue;
    if (pickName(harvested.lines)) {
      return { element: dialog, phones: [], lines: harvested.lines };
    }
  }

  return null;
}

/**
 * Разпознаване по познатите котви на Setmore. Това е основният път —
 * никакво гадаене: футърът казва къде да влязат бутоните, а testid-то на
 * името казва кой е клиентът.
 */
function findByKnownAnchors() {
  const footer = document.querySelector(SETMORE.footer);
  if (!footer || !isVisible(footer)) return null;

  // Прозорецът е най-близкият родител, който съдържа и името на клиента.
  let panel = footer.parentElement;
  while (panel && panel !== document.body && !panel.querySelector(SETMORE.name)) {
    panel = panel.parentElement;
  }
  if (!panel || panel === document.body) panel = footer.parentElement;

  const harvested = harvest(panel);
  const ranked = rankPhones(harvested.lines, settings.defaultCountryCode);
  const nameNode = panel.querySelector(SETMORE.name);

  return {
    element: panel,
    anchor: footer,
    phones: ranked.phones,
    lines: harvested.lines,
    name: nameNode ? nameNode.textContent.trim() : pickName(harvested.lines),
  };
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

/**
 * Viber отваря чата с правилния човек, но не приема готов текст — това е
 * ограничение на самия Viber, не на разширението. Затова съобщението се
 * копира преди чатът да се отвори.
 */
async function openViber(phone, message, notify) {
  const copied = await copyToClipboard(message);
  notify(
    copied
      ? 'Текстът е копиран. Във Viber натисни в полето за писане и залепи (Ctrl+V).'
      : 'Копирането не се получи — натисни „Копирай“ и залепи текста във Viber.'
  );
  window.location.href = viberLink(phone);
}

/* --------------------- бутонът вътре в прозореца --------------------- */

function buildInlineBar(found) {
  const name = found.name || pickName(found.lines);
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

  const invited = phone ? inviteFor(phone) : null;

  const whatsapp = document.createElement('button');
  whatsapp.type = 'button';
  whatsapp.className = 'gr-bar-btn gr-wa';
  whatsapp.textContent = 'WhatsApp';
  whatsapp.disabled = !phone;
  whatsapp.addEventListener('click', (event) => {
    event.stopPropagation();
    event.preventDefault();
    openWhatsApp(phone, buildMessage(name));
    markInvited(phone, name, 'whatsapp');
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
    markInvited(phone, name, 'viber');
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

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'gr-bar-btn gr-copy-inline';
  copy.textContent = 'Копирай';
  copy.title = 'Копира съобщението, за да го залепиш където поискаш';
  copy.addEventListener('click', async (event) => {
    event.stopPropagation();
    event.preventDefault();
    const copied = await copyToClipboard(buildMessage(name));
    notify(copied ? 'Съобщението е копирано.' : 'Копирането не се получи — виж „Провери“.');
  });

  bar.append(label, whatsapp, viber, copy, edit, status);

  if (invited) {
    notify(`Този клиент вече е канен на ${formatDay(invited.day)}.`);
  } else if (!phone) {
    notify('Не намерих телефон в този прозорец — натисни „Провери“, за да го въведеш.');
  } else if (!settings.googleReviewLink) {
    notify('Липсва линк към Google — виж настройките.');
  }

  return bar;
}

/**
 * Собствен ред под футъра на прозореца.
 *
 * Първо бутоните влизаха в самия футър, но той е `flex justify-end` с
 * непроменлива височина и не пренася на нов ред — при по-тесен прозорец
 * лентата излизаше извън картата. Затова сега е отделен ред: цялата ширина,
 * подравнен вляво, и има място бутоните да са плътни и добре видими.
 */
function buildRow(found) {
  const name = found.name || pickName(found.lines);
  const phone = found.phones[0] || null;
  const invited = phone ? inviteFor(phone) : null;

  const bar = document.createElement('div');
  bar.setAttribute(MARK, '1');
  bar.className = 'gr-row';
  bar.dataset.grFor = `${phone}|${name}${invited ? `|${invited.day}` : ''}`;

  const pill = (label, className, title, onClick) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `gr-pill ${className}`;
    button.textContent = label;
    button.title = title;
    // „Провери“ работи и без номер — тъкмо оттам се въвежда на ръка.
    button.disabled = !phone && !className.includes('gr-pill-ghost');
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      event.preventDefault();
      onClick();
    });
    return button;
  };

  const blocked = isBlocked(invited);

  bar.append(
    pill('WhatsApp', 'gr-pill-wa', 'Отваря WhatsApp с готова покана за ревю', () => {
      openWhatsApp(phone, buildMessage(name));
      markInvited(phone, name, 'whatsapp');
      rememberClient({ phone, name });
    }),
    pill('Viber', 'gr-pill-vb', 'Отваря Viber с покана за ревю', () => {
      openViber(phone, buildMessage(name), toast);
      markInvited(phone, name, 'viber');
      rememberClient({ phone, name });
    }),
    pill('⋯', 'gr-pill-ghost', 'Провери, отмени отметка или спри съобщенията към този клиент', () => {
      openPanel({ name, phones: found.phones });
    })
  );

  // На собствен ред има място състоянието да се изпише с думи.
  const note = document.createElement('span');
  note.className = 'gr-row-note';

  if (blocked) {
    // Молбата да не се пише е по-силна от всичко останало — бутоните спират.
    note.textContent = '⛔ не изпращай на този клиент';
    note.title = 'Отбелязан е като „не изпращай“. Върни го от ⋯, ако е по грешка.';
    note.classList.add('gr-row-note-warn');
    bar.classList.add('gr-blocked');
    bar.querySelectorAll('.gr-pill-wa, .gr-pill-vb').forEach((button) => { button.disabled = true; });
  } else if (invited) {
    note.textContent = `✓ канен(а) ${formatDay(invited.day)}`;
    note.title = `Изпратено през ${CHANNEL_NAMES[invited.channel] || 'ръчно'}. Бутоните пак работят, ако искаш да пратиш повторно.`;
    note.classList.add('gr-row-note-done');
    bar.classList.add('gr-already-invited');
  } else if (!phone) {
    note.textContent = 'няма телефон — виж ⋯';
    note.classList.add('gr-row-note-warn');
  }

  bar.append(note);
  return bar;
}

function injectInto(found) {
  // Списъкът с клиенти се пълни от само себе си — от часовете, които отваряш.
  if (found.phones && found.phones.length) {
    rememberClient({ phone: found.phones[0], name: found.name || pickName(found.lines) });
  }

  const ownRow = Boolean(found.anchor);
  const bar = ownRow ? buildRow(found) : buildInlineBar(found);

  // Търсим в целия прозорец: редът стои до футъра, а не вътре в него.
  const existing = found.element.querySelector(ownRow ? '.gr-row' : '.gr-bar');

  if (existing) {
    if (existing.dataset.grFor === bar.dataset.grFor) return; // нищо не се е променило
    existing.replaceWith(bar);
    return;
  }

  // Собствен ред веднага след футъра — така нищо не се блъска в бутоните на
  // Setmore и лентата не може да излезе извън прозореца.
  if (ownRow) found.anchor.after(bar);
  else found.element.append(bar);
}

/* ------------------------- панелът на ръка ------------------------- */

let toastTimer = null;

/** Кратко съобщение долу на екрана — във футъра няма място за статус. */
function toast(text) {
  let node = document.getElementById('gr-toast');
  if (!node) {
    node = document.createElement('div');
    node.id = 'gr-toast';
    node.setAttribute(MARK, '1');
    document.body.append(node);
  }

  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 4000);
}

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
    <div id="gr-status-actions">
      <button id="gr-undo" type="button" class="gr-link" hidden>Отбележи като неизпратено</button>
      <button id="gr-block" type="button" class="gr-link"></button>
    </div>
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
    updateStatusActions(value('#gr-phone') || null);
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

  /* Отметката се слага при натискане на бутона, а не при реално изпращане —
     ако си се отказал или си натиснал по погрешка, оттук се маха. */
  node.querySelector('#gr-undo').addEventListener('click', async () => {
    const phone = currentPhone();
    if (!phone) return;

    await forgetInvite(phone);
    invites.delete(phoneKey(phone));
    setHint('Отметката е махната — клиентът пак ще излиза като непоканен.');
    updateStatusActions(phone);
    scheduleScan();
  });

  node.querySelector('#gr-block').addEventListener('click', async () => {
    const phone = currentPhone();
    if (!phone) return;

    const nowBlocked = !isBlocked(invites.get(phoneKey(phone)));
    await setDoNotContact(phone, nowBlocked);
    await refreshInvites();

    setHint(
      nowBlocked
        ? 'Записано. На този клиент няма да се изпращат покани.'
        : 'Клиентът е върнат — пак може да получава покани.'
    );
    updateStatusActions(phone);
    scheduleScan();
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

  /** Показва двата бутона според това какво знаем за клиента. */
  function updateStatusActions(phone) {
    const record = phone ? invites.get(phoneKey(phone)) : null;
    const blocked = isBlocked(record);

    node.querySelector('#gr-undo').hidden = !record || blocked;
    node.querySelector('#gr-block').textContent = blocked
      ? 'Върни клиента — пак може да получава покани'
      : 'Не изпращай на този клиент';

    // Блокиран клиент не бива да се праща и оттук.
    node.querySelector('#gr-wa').disabled = blocked || node.querySelector('#gr-wa').disabled;
    node.querySelector('#gr-vb').disabled = blocked || node.querySelector('#gr-vb').disabled;
  }

  node.refresh = { setHint, updateButtons, refreshMessage, updateStatusActions };
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
    : rankPhones(selection.split('\n'), settings.defaultCountryCode).phones;

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
  panel.refresh.updateStatusActions(select.value || null);

  const record = select.value ? invites.get(phoneKey(select.value)) : null;

  if (isBlocked(record)) {
    panel.refresh.setHint('Този клиент е отбелязан като „не изпращай“.', true);
  } else if (!settings.googleReviewLink) {
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
    const ranked = rankPhones(harvested.lines, settings.defaultCountryCode);
    const rect = element.getBoundingClientRect();

    report.push(
      `— слой ${index + 1}: <${element.tagName.toLowerCase()} class="${String(element.className).slice(0, 80)}">`,
      `  размер: ${Math.round(rect.width)}×${Math.round(rect.height)}, номера: ${ranked.phones.length}` +
        `, навигация: ${isNavigational(element) ? 'да' : 'не'}` +
        `, наскоро появил се: ${appearedRecently(element) ? 'да' : 'не'}` +
        `, оценка: ${Math.round(scoreOf(element, ranked))}`,
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

  const found = findByKnownAnchors() || findAppointmentPanel() || findPhonelessDialog();
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
    setCountryCode(settings.defaultCountryCode);

    const found = findByKnownAnchors() || findAppointmentPanel();
    openPanel(found ? { name: found.name || pickName(found.lines), phones: found.phones } : null);
  });

  document.body.append(button);
}

async function init() {
  settings = await loadSettings();
  setCountryCode(settings.defaultCountryCode);
  await refreshInvites();

  // Историята се синхронизира през акаунта в Chrome — ако се промени на
  // друг компютър, кешът тук трябва да я догони.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && Object.keys(changes).some((key) => key.startsWith('gr_inv_'))) {
      refreshInvites().then(scheduleScan);
    }
  });

  // Плаващият бутон има смисъл само в основната рамка — вградените рамки
  // само вкарват бутона в прозореца с часа.
  if (window.top === window) createLauncher();

  new MutationObserver((mutations) => {
    for (const mutation of mutations) noteAdded(mutation.addedNodes);
    scheduleScan();
  }).observe(document.documentElement, { childList: true, subtree: true });

  // Прозорецът се отваря при натискане на час — сканираме и тогава, защото
  // част от промените идват без нови възли в DOM.
  document.addEventListener('click', scheduleScan, true);

  scheduleScan();
}

init();
