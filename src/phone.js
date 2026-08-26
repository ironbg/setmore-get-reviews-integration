'use strict';

/**
 * Нормализация на телефонни номера до E.164 формат.
 *
 * Setmore пази номерата така, както ги е въвел клиентът или служителят:
 * "0888 12 34 56", "+359-888-123456", "00359888123456", "(0888) 123456".
 * WhatsApp и Viber линковете обаче искат чист международен номер,
 * затова всичко минава оттук преди да влезе в линк.
 */

/** Държави, чиито национални номера започват с водеща 0, която се маха. */
const TRUNK_PREFIX = '0';

/**
 * @param {string} raw суров номер, както идва от Setmore
 * @param {string} defaultCountryCode код на държавата без "+", напр. "359"
 * @returns {{raw: string, e164: string|null, digits: string|null, valid: boolean, reason: string|null}}
 */
function normalizePhone(raw, defaultCountryCode = '359') {
  const empty = { raw: raw == null ? '' : String(raw), e164: null, digits: null, valid: false };

  if (raw == null || String(raw).trim() === '') {
    return { ...empty, reason: 'липсва номер' };
  }

  const input = String(raw).trim();
  const cc = String(defaultCountryCode).replace(/\D/g, '');

  // Пазим само цифри; "+" има значение единствено ако е първият символ.
  const hadPlus = input.startsWith('+');
  let digits = input.replace(/\D/g, '');

  if (digits === '') {
    return { ...empty, reason: 'няма цифри в номера' };
  }

  if (!hadPlus) {
    if (digits.startsWith('00')) {
      // 00359888123456 -> 359888123456
      digits = digits.slice(2);
    } else if (digits.startsWith(TRUNK_PREFIX)) {
      // 0888123456 -> 359888123456
      digits = cc + digits.replace(/^0+/, '');
    } else if (cc && !digits.startsWith(cc)) {
      // 888123456 -> 359888123456
      digits = cc + digits;
    }
  }

  // E.164 позволява най-много 15 цифри, а под 8 няма как да е истински номер.
  if (digits.length < 8 || digits.length > 15) {
    return { ...empty, raw: input, reason: 'номерът изглежда непълен или сгрешен' };
  }

  return { raw: input, e164: '+' + digits, digits, valid: true, reason: null };
}

/** Скрива средата на номера за логове и екрани: +359888***456 */
function maskPhone(e164) {
  if (!e164 || e164.length < 8) return e164 || '';
  return e164.slice(0, 7) + '***' + e164.slice(-3);
}

module.exports = { normalizePhone, maskPhone };
