/* Обща логика за разширението: настройки, шаблон, телефони, линкове. */

const DEFAULT_SETTINGS = {
  studioName: 'Моето студио',
  googleReviewLink: '',
  defaultCountryCode: '359',
  // 'chat'    — отваря чата с клиента, текстът се копира за залепване
  // 'forward' — отваря Viber с готов текст, получателят се избира на ръка
  viberMode: 'chat',
  template:
    'Здравейте, {име}! 🌿 Благодарим Ви, че ни се доверихте днес в {студио}. ' +
    'Ако сте останали доволни, ще се радваме много на кратък отзив в Google — ' +
    'отнема по-малко от минута и помага на други хора да ни намерят: {линк}\n\nБлагодарим Ви и до нови срещи!',
};

async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...stored };
}

function firstName(fullName) {
  const clean = String(fullName || '').trim().replace(/\s+/g, ' ');
  return clean ? clean.split(' ')[0] : '';
}

function renderTemplate(template, vars) {
  const values = {
    'име': firstName(vars.name),
    'пълно име': vars.name || '',
    'студио': vars.studio || '',
    'линк': vars.link || '',
    name: firstName(vars.name),
    fullname: vars.name || '',
    studio: vars.studio || '',
    link: vars.link || '',
  };
  return String(template || '').replace(/\{([^{}]+)\}/g, (match, key) => {
    const normalized = key.trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(values, normalized) ? values[normalized] : match;
  });
}

/** Същите правила като в src/phone.js на сървъра. */
function normalizePhone(raw, defaultCountryCode = '359') {
  if (raw == null || String(raw).trim() === '') return null;
  const input = String(raw).trim();
  const cc = String(defaultCountryCode).replace(/\D/g, '');
  const hadPlus = input.startsWith('+');
  let digits = input.replace(/\D/g, '');
  if (!digits) return null;

  if (!hadPlus) {
    if (digits.startsWith('00')) digits = digits.slice(2);
    else if (digits.startsWith('0')) digits = cc + digits.replace(/^0+/, '');
    else if (cc && !digits.startsWith(cc)) digits = cc + digits;
  }

  if (digits.length < 8 || digits.length > 15) return null;
  return '+' + digits;
}

function whatsappLink(e164, text) {
  return `https://wa.me/${String(e164).replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
}

function viberLink(e164) {
  return `viber://chat?number=${encodeURIComponent(e164)}`;
}

/**
 * Отваря Viber с готов текст. Получателят се избира на ръка — това е
 * компромисът: viber://chat знае номера, но не приема текст, а
 * viber://forward приема текст, но не знае номера. Viber не предлага линк,
 * който да прави и двете.
 */
function viberForwardLink(text) {
  return `viber://forward?text=${encodeURIComponent(text || '')}`;
}
