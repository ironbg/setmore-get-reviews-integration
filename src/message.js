'use strict';

/**
 * Съставяне на текста на поканата за Google ревю.
 *
 * Шаблоните живеят в config.json, за да може текстът да се сменя без промяна
 * по кода. Поддържат се и български, и английски имена на променливите,
 * защото шаблоните най-често се пишат на български.
 */

/** Взима само собственото име: "Мария Петрова" -> "Мария". */
function firstName(fullName) {
  const clean = String(fullName || '').trim().replace(/\s+/g, ' ');
  if (!clean) return '';
  return clean.split(' ')[0];
}

/**
 * Заменя {име}, {линк} и т.н. в шаблона.
 *
 * @param {string} template текст с плейсхолдъри
 * @param {object} vars стойности: name, firstName, studio, link, service, date, time
 * @returns {string}
 */
function renderTemplate(template, vars = {}) {
  const values = {
    // български
    'име': vars.firstName != null ? vars.firstName : firstName(vars.name),
    'пълно име': vars.name || '',
    'студио': vars.studio || '',
    'линк': vars.link || '',
    'услуга': vars.service || '',
    'дата': vars.date || '',
    'час': vars.time || '',
    // английски синоними
    'name': vars.firstName != null ? vars.firstName : firstName(vars.name),
    'fullname': vars.name || '',
    'studio': vars.studio || '',
    'link': vars.link || '',
    'service': vars.service || '',
    'date': vars.date || '',
    'time': vars.time || '',
  };

  return String(template || '').replace(/\{([^{}]+)\}/g, (match, key) => {
    const normalized = key.trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(values, normalized) ? values[normalized] : match;
  });
}

/**
 * WhatsApp клик-към-чат линк. Работи и в браузър, и в мобилното приложение.
 * Номерът е без "+" — така го иска wa.me.
 */
function whatsappLink(e164, text) {
  const digits = String(e164 || '').replace(/\D/g, '');
  return `https://wa.me/${digits}?text=${encodeURIComponent(text || '')}`;
}

/**
 * Viber дълбок линк към чат с конкретен номер.
 *
 * Внимание: Viber отваря чата, но НЕ попълва текста предварително —
 * протоколът не поддържа text параметър за chat. Затова интерфейсът
 * копира съобщението в клипборда преди да отвори Viber.
 */
function viberLink(e164) {
  return `viber://chat?number=${encodeURIComponent(String(e164 || ''))}`;
}

/**
 * Алтернативен Viber линк: отваря "препрати" екран с готов текст,
 * където получателят се избира на ръка. Полезен на десктоп.
 */
function viberForwardLink(text) {
  return `viber://forward?text=${encodeURIComponent(text || '')}`;
}

/** SMS резервен вариант, ако клиентът няма Viber/WhatsApp. */
function smsLink(e164, text) {
  return `sms:${e164}?body=${encodeURIComponent(text || '')}`;
}

module.exports = {
  firstName,
  renderTemplate,
  whatsappLink,
  viberLink,
  viberForwardLink,
  smsLink,
};
