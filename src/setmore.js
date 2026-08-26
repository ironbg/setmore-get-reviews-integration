'use strict';

/**
 * Тънък клиент за Setmore Booking API.
 *
 * Setmore дава дълготраен refresh token от Settings → Integrations → API.
 * С него се взима краткотраен access token, който се слага в Authorization
 * хедъра на всички останали заявки.
 *
 * Структурата на отговорите на Setmore се е променяла във времето, затова
 * четенето е нарочно защитено: търсим масива с часове където и да е в JSON-а,
 * вместо да разчитаме на един-единствен път.
 */

const { normalizePhone } = require('./phone');

/** Кеш за access token-а в паметта — иначе всяка заявка би искала нов. */
let tokenCache = { value: null, expiresAt: 0 };

function resetTokenCache() {
  tokenCache = { value: null, expiresAt: 0 };
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const body = await res.text();

  let json = null;
  try {
    json = body ? JSON.parse(body) : null;
  } catch {
    // Оставяме json = null и отдолу вдигаме грешка с оригиналния текст.
  }

  if (!res.ok) {
    const detail = (json && (json.msg || json.message || json.error)) || body.slice(0, 300);
    const error = new Error(`Setmore върна ${res.status}: ${detail || 'без описание'}`);
    error.status = res.status;
    throw error;
  }

  if (json === null) {
    throw new Error(`Setmore върна отговор, който не е JSON: ${body.slice(0, 200)}`);
  }

  return json;
}

/** Обхожда JSON дърво и връща първия масив, чиито елементи приличат на часове. */
function findAppointmentArray(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;

  if (Array.isArray(node)) {
    const looksRight = node.some(
      (item) =>
        item &&
        typeof item === 'object' &&
        ('start_time' in item || 'startTime' in item || 'appointment_key' in item || 'key' in item)
    );
    return looksRight ? node : null;
  }

  // Явните имена се проверяват първи, за да не хванем случайно друг масив.
  for (const key of ['appointments', 'appointment', 'data', 'result']) {
    if (key in node) {
      const found = findAppointmentArray(node[key], depth + 1);
      if (found) return found;
    }
  }

  for (const value of Object.values(node)) {
    const found = findAppointmentArray(value, depth + 1);
    if (found) return found;
  }

  return null;
}

function pick(obj, ...keys) {
  for (const key of keys) {
    if (obj && obj[key] != null && obj[key] !== '') return obj[key];
  }
  return null;
}

/** Превръща записа на Setmore в еднообразна форма, каквато очаква интерфейсът. */
function normalizeAppointment(raw, defaultCountryCode) {
  const customer = raw.customer || raw.customer_details || raw.customerDetails || {};
  const service = raw.service || raw.service_details || {};
  const staff = raw.staff || raw.staff_details || {};

  const nameParts = [
    pick(customer, 'first_name', 'firstName', 'fname'),
    pick(customer, 'last_name', 'lastName', 'lname'),
  ].filter(Boolean);

  const name =
    nameParts.join(' ').trim() ||
    pick(customer, 'name', 'full_name', 'customer_name') ||
    pick(raw, 'customer_name', 'customerName') ||
    'Без име';

  const rawPhone =
    pick(customer, 'cell_phone', 'cellPhone', 'phone', 'phone_number', 'mobile', 'contact_number') ||
    pick(raw, 'customer_phone', 'phone') ||
    '';

  const phone = normalizePhone(rawPhone, defaultCountryCode);
  const start = pick(raw, 'start_time', 'startTime', 'start', 'appointment_start') || null;

  return {
    id: String(
      pick(raw, 'key', 'appointment_key', 'appointmentKey', 'id') ||
        `${start}-${name}`.replace(/\s+/g, '-')
    ),
    start,
    end: pick(raw, 'end_time', 'endTime', 'end') || null,
    customerName: name,
    customerKey: pick(customer, 'key', 'customer_key') || pick(raw, 'customer_key') || null,
    email: pick(customer, 'email_id', 'email') || null,
    phoneRaw: phone.raw,
    phone: phone.e164,
    phoneValid: phone.valid,
    phoneProblem: phone.reason,
    service: pick(service, 'service_name', 'serviceName', 'name') || pick(raw, 'service_name') || '',
    staff: pick(staff, 'first_name', 'staff_name', 'name') || pick(raw, 'staff_name') || '',
    label: pick(raw, 'label', 'status') || '',
    comment: pick(raw, 'comment', 'note') || '',
  };
}

/** dd/MM/yyyy — форматът, който Setmore очаква за диапазон от дати. */
function toSetmoreDate(isoDate) {
  const [year, month, day] = String(isoDate).split('-');
  return `${day}/${month}/${year}`;
}

class SetmoreClient {
  constructor(config) {
    this.config = config;
    this.setmore = config.setmore;
  }

  async getAccessToken() {
    const now = Date.now();
    if (tokenCache.value && tokenCache.expiresAt > now) {
      return tokenCache.value;
    }

    const { baseUrl, tokenPath, refreshToken } = this.setmore;
    if (!refreshToken) {
      throw new Error('Липсва refreshToken в config.json — виж README за къде се взима.');
    }

    const url = `${baseUrl}${tokenPath}?refreshToken=${encodeURIComponent(refreshToken)}`;
    const json = await fetchJson(url, { headers: { Accept: 'application/json' } });

    const token =
      json?.data?.token?.access_token ||
      json?.data?.access_token ||
      json?.access_token ||
      null;

    if (!token) {
      throw new Error(
        'Setmore не върна access token. Провери дали refreshToken е още валиден ' +
          '(в Setmore: Settings → Integrations → API, бутон Regenerate).'
      );
    }

    const expiresIn = Number(
      json?.data?.token?.expires_in || json?.data?.expires_in || json?.expires_in || 3600
    );
    // Подновяваме минута по-рано, за да не улучим ръба на изтичането.
    tokenCache = { value: token, expiresAt: now + Math.max(expiresIn - 60, 60) * 1000 };

    return token;
  }

  /**
   * Часове в даден период.
   * @param {string} startDate ISO дата "2026-08-26"
   * @param {string} endDate ISO дата "2026-08-26"
   */
  async getAppointments(startDate, endDate) {
    const token = await this.getAccessToken();
    const { baseUrl, appointmentsPath } = this.setmore;

    const params = new URLSearchParams({
      startDate: toSetmoreDate(startDate),
      endDate: toSetmoreDate(endDate),
      customerDetails: 'true',
    });

    let json;
    try {
      json = await fetchJson(`${baseUrl}${appointmentsPath}?${params}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
    } catch (err) {
      // Изтекъл токен: чистим кеша, за да не залепне грешката за следващите заявки.
      if (err.status === 401 || err.status === 403) resetTokenCache();
      throw err;
    }

    const list = findAppointmentArray(json) || [];
    return list.map((item) => normalizeAppointment(item, this.config.defaultCountryCode));
  }
}

module.exports = {
  SetmoreClient,
  normalizeAppointment,
  findAppointmentArray,
  toSetmoreDate,
  resetTokenCache,
};
