/**
 * Разчитане на име и телефон от прозореца с часа.
 *
 * Логиката тук нарочно не пипа DOM — работи върху текст и редове. Така може
 * да се тества, а DOM частта в content.js остава тънка. Причината: интерфейсът
 * на Setmore се мени и всяко закачане за конкретни класове рано или късно
 * спира да работи.
 */

/*
 * Цели, които приличат на телефон: 8–17 цифри, евентуално с разделители.
 * Нарочно НЕ ползваме \s — той хваща и нов ред, а тогава номерът се слива
 * със следващия ред („0888 123 456\n26 Aug“ ставаше един дълъг номер).
 */
const PHONE_PATTERN = /(?:\+|00)?\d[\d \t().\u2010-\u2015-]{6,20}\d/g;

/** Думи от интерфейса, които не са име на човек. */
const NOT_A_NAME = [
  // английски
  'appointment', 'booking', 'edit', 'delete', 'cancel', 'save', 'close', 'reschedule',
  'customer', 'client', 'service', 'staff', 'provider', 'duration', 'notes', 'note',
  'comment', 'phone', 'email', 'address', 'payment', 'paid', 'unpaid', 'status',
  'details', 'today', 'tomorrow', 'yesterday', 'am', 'pm', 'no show', 'completed',
  'confirmed', 'pending', 'new', 'add', 'more', 'options', 'menu', 'back', 'done',
  'check in', 'checkout', 'label', 'repeat', 'recurring', 'video', 'meeting', 'link',
  // български
  'час', 'часове', 'запазване', 'запази', 'откажи', 'отказ', 'изтрий', 'редактирай',
  'затвори', 'клиент', 'услуга', 'служител', 'специалист', 'продължителност',
  'бележки', 'бележка', 'телефон', 'имейл', 'адрес', 'плащане', 'платено', 'статус',
  'детайли', 'днес', 'утре', 'вчера', 'добави', 'още', 'меню', 'назад', 'готово',
];

/** Месеци и дни — заглавия на календара, които иначе минават за имена. */
const CALENDAR_WORDS = [
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'януари', 'февруари', 'март', 'април', 'май', 'юни', 'юли', 'август',
  'септември', 'октомври', 'ноември', 'декември',
  'понеделник', 'вторник', 'сряда', 'четвъртък', 'петък', 'събота', 'неделя',
];

/**
 * Вади всички телефони от текст и ги нормализира.
 * Разчита на normalizePhone от shared.js.
 *
 * @returns {string[]} уникални номера в E.164, в реда на срещане
 */
function findPhones(text, defaultCountryCode) {
  const found = [];
  const seen = new Set();

  for (const match of String(text || '').match(PHONE_PATTERN) || []) {
    const digitsOnly = match.replace(/\D/g, '');

    // Дати (26082026) и часове лесно минават за номер — отсяваме очевидните.
    if (digitsOnly.length < 8 || digitsOnly.length > 15) continue;
    if (/^(19|20)\d{6}$/.test(digitsOnly)) continue;

    const phone = normalizePhone(match, defaultCountryCode);
    if (phone && !seen.has(phone)) {
      seen.add(phone);
      found.push(phone);
    }
  }

  return found;
}

/** Дали редът изобщо може да е име на човек. */
function couldBeName(line) {
  const text = String(line || '').trim().replace(/\s+/g, ' ');

  if (text.length < 2 || text.length > 40) return false;
  if (/\d/.test(text)) return false;
  if (/[@:/\\|]/.test(text)) return false;

  const lower = text.toLowerCase();
  if (NOT_A_NAME.includes(lower)) return false;
  if (CALENDAR_WORDS.some((word) => lower === word || lower.startsWith(word + ' '))) return false;

  // Име е една до три думи; по-дълго е описание на услуга или изречение.
  const words = text.split(' ');
  if (words.length > 3) return false;

  // Първата буква на първата дума е главна.
  return /^\p{Lu}/u.test(text);
}

/**
 * Избира най-вероятното име сред редовете на прозореца.
 *
 * Редът, който стои непосредствено след етикет „Клиент“/„Customer“, е най-
 * сигурен. Иначе се взима първият подходящ ред — в Setmore името на клиента
 * е заглавието на прозореца.
 *
 * @param {string[]} lines редове от прозореца, в реда на показване
 */
function pickName(lines) {
  const cleaned = (lines || []).map((line) => String(line).trim()).filter(Boolean);

  const labels = ['customer', 'client', 'клиент', 'име', 'name'];
  for (let i = 0; i < cleaned.length - 1; i += 1) {
    const label = cleaned[i].toLowerCase().replace(/[:：]\s*$/, '');
    if (labels.includes(label) && couldBeName(cleaned[i + 1])) {
      return cleaned[i + 1];
    }
  }

  // "Клиент: Мария Петрова" на един ред.
  for (const line of cleaned) {
    const match = line.match(/^(?:customer|client|клиент|име|name)\s*[:：]\s*(.+)$/i);
    if (match && couldBeName(match[1])) return match[1].trim();
  }

  // Името на служителя стои под подобен етикет и лесно минава за клиент.
  const staffLabels = ['staff', 'provider', 'team member', 'служител', 'специалист', 'масажист'];
  const afterStaffLabel = (index) => {
    if (index === 0) return false;
    const previous = cleaned[index - 1].toLowerCase().replace(/[:：]\s*$/, '');
    return staffLabels.includes(previous);
  };

  const index = cleaned.findIndex((line, position) => couldBeName(line) && !afterStaffLabel(position));
  return index >= 0 ? cleaned[index] : '';
}

/**
 * Скрива средата на номер, за да може дамп от диагностиката да се сподели.
 * +359888123456 -> +359***456
 */
function maskDigits(text) {
  return String(text || '').replace(/\d{4,}/g, (match) => match.slice(0, 0) + '***' + match.slice(-3));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { findPhones, pickName, couldBeName, maskDigits, PHONE_PATTERN };
}
