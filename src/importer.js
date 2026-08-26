'use strict';

/**
 * Чете списък с клиенти от експорт на Setmore.
 *
 * Setmore API се плаща, затова основният път е безплатният експорт:
 *   • Клиенти → менюто с трите чертички → Export customers (изпраща .csv на имейла)
 *   • Settings → Booking Page → Reports → Export as .XLS (история на часовете)
 *
 * Файлът от Reports е .xls, а не CSV, затова се поддържа и залепване:
 * отваряш го в Excel или Google Sheets, маркираш, копираш и залепваш в таблото.
 * Копирането от таблица дава редове, разделени с табулация — оттам и
 * автоматичното разпознаване на разделителя.
 */

const { normalizePhone } = require('./phone');

/**
 * Пълноценен CSV парсер: кавичките пазят запетайки и нови редове вътре в клетка,
 * а "" вътре в кавички означава един знак кавичка.
 */
function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const input = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  // Последната клетка няма след себе си нов ред.
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((cells) => cells.some((cell) => String(cell).trim() !== ''));
}

/** Кой разделител се среща най-често извън кавичките — той е истинският. */
function detectDelimiter(text) {
  const sample = String(text).split('\n').slice(0, 5).join('\n');
  const counts = { '\t': 0, ',': 0, ';': 0 };
  let inQuotes = false;

  for (const char of sample) {
    if (char === '"') inQuotes = !inQuotes;
    else if (!inQuotes && char in counts) counts[char] += 1;
  }

  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0
    ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
    : ',';
}

/**
 * Кои колони за какво служат. Setmore сменя заглавията между отделните
 * експорти и езиците, затова се търсят ключови думи, а не точни съвпадения.
 */
const COLUMN_HINTS = {
  firstName: ['first name', 'firstname', 'собствено име', 'име на клиента', 'first'],
  lastName: ['last name', 'lastname', 'surname', 'фамилия', 'фамилно име'],
  fullName: ['customer name', 'customer', 'client name', 'client', 'name', 'клиент', 'име'],
  phone: ['phone', 'mobile', 'cell', 'contact number', 'телефон', 'мобилен', 'номер'],
  email: ['email', 'e-mail', 'имейл', 'мейл'],
  date: ['date', 'appointment date', 'start date', 'дата'],
  time: ['time', 'start time', 'час на започване', 'начало'],
  service: ['service', 'appointment', 'услуга', 'процедура'],
  staff: ['staff', 'provider', 'служител', 'специалист'],
};

/** Заглавие "Phone Number" пасва на hint "phone"; по-дългото съвпадение печели. */
function matchColumn(header, hints) {
  const normalized = String(header || '').trim().toLowerCase();
  if (!normalized) return 0;

  let best = 0;
  for (const hint of hints) {
    if (normalized === hint) return hint.length + 100;
    if (normalized.includes(hint)) best = Math.max(best, hint.length);
  }
  return best;
}

function mapColumns(headerRow) {
  const mapping = {};

  for (const [field, hints] of Object.entries(COLUMN_HINTS)) {
    let bestIndex = -1;
    let bestScore = 0;

    headerRow.forEach((header, index) => {
      const score = matchColumn(header, hints);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });

    if (bestIndex >= 0) mapping[field] = bestIndex;
  }

  // "Name" пасва и на fullName, и на firstName. Ако сочат едно и също място,
  // и има отделна фамилия, значи колоната е собствено име.
  if (mapping.fullName != null && mapping.fullName === mapping.firstName && mapping.lastName != null) {
    delete mapping.fullName;
  }

  return mapping;
}

/**
 * Разпознава заглавен ред.
 *
 * Само "има букви" не стига: "Мария Петрова,0888123456" също има букви.
 * Затова първо търсим неща, които в заглавие нямат работа — телефон или
 * дата. Има ли такова, редът е с данни, независимо как изглежда останалото.
 */
function looksLikeHeader(row) {
  const filled = row.filter((cell) => String(cell).trim() !== '');
  if (filled.length < 2) return false;

  const hasData = filled.some((cell) => {
    const text = String(cell).trim();
    return /\d{6}/.test(text.replace(/\D/g, '')) || /\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}/.test(text);
  });
  if (hasData) return false;

  const words = filled.filter((cell) => /[a-zA-Zа-яА-Я]/.test(cell));
  return words.length >= Math.ceil(filled.length / 2);
}

/**
 * Датите в експортите идват в най-различен вид: 26/08/2026, 08/26/2026,
 * 2026-08-26, "Aug 26, 2026". Разпознава се това, което е недвусмислено;
 * при съмнение денят се приема за първи, както е прието в Европа.
 */
function parseDate(value) {
  const text = String(value || '').trim();
  if (!text) return null;

  const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const slashed = text.match(/(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})/);
  if (slashed) {
    let [, first, second, year] = slashed;
    if (year.length === 2) year = `20${year}`;
    // Стойност над 12 може да е само ден — това решава реда еднозначно.
    const [day, month] = Number(first) > 12 ? [first, second] : Number(second) > 12 ? [second, first] : [first, second];
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  const parsed = new Date(text);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  return null;
}

function parseTime(value) {
  const text = String(value || '').trim();
  const match = text.match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;

  let hour = Number(match[1]);
  if (/p\.?m\.?/i.test(text) && hour < 12) hour += 12;
  if (/a\.?m\.?/i.test(text) && hour === 12) hour = 0;

  return `${String(hour).padStart(2, '0')}:${match[2]}`;
}

function cell(row, index) {
  if (index == null || index < 0) return '';
  return String(row[index] == null ? '' : row[index]).trim();
}

/**
 * Превръща залепен или качен текст в списък от часове.
 *
 * @param {string} text съдържанието на CSV файла или залепените редове
 * @param {object} options { defaultCountryCode, fallbackDate }
 * @returns {{rows: Array, skipped: number, columns: object, warnings: string[]}}
 */
function importRows(text, options = {}) {
  const defaultCountryCode = options.defaultCountryCode || '359';
  const fallbackDate = options.fallbackDate || null;

  const delimiter = detectDelimiter(text);
  const table = parseDelimited(text, delimiter);
  const warnings = [];

  if (!table.length) {
    return { rows: [], skipped: 0, columns: {}, warnings: ['Файлът е празен.'] };
  }

  const hasHeader = looksLikeHeader(table[0]);
  const columns = hasHeader ? mapColumns(table[0]) : {};
  const body = hasHeader ? table.slice(1) : table;

  if (!hasHeader) {
    warnings.push('Не разпознах заглавен ред — приемам, че първата колона е име, а втората телефон.');
    columns.fullName = 0;
    columns.phone = 1;
  } else if (columns.phone == null) {
    warnings.push('Не намерих колона с телефон. Провери дали експортът я съдържа.');
  }

  const rows = [];
  let skipped = 0;

  body.forEach((row, index) => {
    const nameParts = [cell(row, columns.firstName), cell(row, columns.lastName)].filter(Boolean);
    const name = nameParts.join(' ') || cell(row, columns.fullName);

    let rawPhone = cell(row, columns.phone);
    // Ако разпознатата колона е празна, търсим телефон където и да е в реда —
    // по-добре това, отколкото да изгубим клиента.
    if (!rawPhone) {
      const candidate = row.find((value) => /\d{6}/.test(String(value)) && !/^\d{4}-\d{2}-\d{2}$/.test(String(value).trim()));
      if (candidate) rawPhone = String(candidate).trim();
    }

    const phone = normalizePhone(rawPhone, defaultCountryCode);
    const date = parseDate(cell(row, columns.date)) || fallbackDate;
    const time = parseTime(cell(row, columns.time));

    if (!name && !phone.valid) {
      skipped += 1;
      return;
    }

    rows.push({
      id: phone.valid ? `imp-${phone.digits}-${date || 'без-дата'}` : `imp-ред-${index + 1}`,
      // Без колона за час записваме само датата — иначе всеки клиент би
      // изглеждал записан за полунощ.
      start: date ? (time ? `${date}T${time}:00` : date) : null,
      end: null,
      customerName: name || 'Без име',
      customerKey: null,
      email: cell(row, columns.email) || null,
      phoneRaw: phone.raw,
      phone: phone.e164,
      phoneValid: phone.valid,
      phoneProblem: phone.reason,
      service: cell(row, columns.service),
      staff: cell(row, columns.staff),
      label: '',
      comment: '',
    });
  });

  if (rows.length && rows.every((item) => !item.start)) {
    warnings.push('Няма разпозната дата — всички редове се показват без филтър по период.');
  }

  return { rows, skipped, columns, warnings };
}

module.exports = { importRows, parseDelimited, detectDelimiter, mapColumns, parseDate, parseTime };
