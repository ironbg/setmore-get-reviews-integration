'use strict';

/**
 * Какво е запазено локално:
 *   sent.json     — кой клиент вече е получил покана
 *   imported.json — последният импортиран списък, за да преживее презареждане
 *
 * Нарочно са обикновени JSON файлове, а не база данни: обемът е няколко
 * записа на ден, а така всичко се архивира с едно копиране на папката.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.SETMORE_REVIEW_DATA || path.join(__dirname, '..', 'data');
const SENT_FILE = path.join(DATA_DIR, 'sent.json');
const IMPORT_FILE = path.join(DATA_DIR, 'imported.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    // Повреден файл не бива да събаря приложението — правим копие и започваме начисто.
    const backup = `${file}.broken-${Date.now()}`;
    try {
      fs.renameSync(file, backup);
      console.warn(`[store] ${file} беше повреден и е преместен в ${backup}`);
    } catch {
      /* ако и това не стане, продължаваме с празна стойност */
    }
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Пишем през временен файл, за да не остане половин JSON при спиране на процеса.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/* ------------------------------ покани ------------------------------ */

/** @returns {Record<string, {channel: string, at: string, phone?: string, name?: string}>} */
function getSentMap() {
  return readJson(SENT_FILE, {});
}

function markSent(appointmentId, channel, extra = {}) {
  if (!appointmentId) throw new Error('Липсва id на часа.');

  const data = getSentMap();
  data[appointmentId] = {
    channel: channel || 'unknown',
    at: new Date().toISOString(),
    ...(extra.phone ? { phone: extra.phone } : {}),
    ...(extra.name ? { name: extra.name } : {}),
  };
  writeJson(SENT_FILE, data);
  return data[appointmentId];
}

function unmarkSent(appointmentId) {
  const data = getSentMap();
  delete data[appointmentId];
  writeJson(SENT_FILE, data);
}

/**
 * Кога този телефон е получавал покана — независимо от кой час.
 * Така един и същ клиент не получава втора покана след месеци.
 *
 * @returns {{at: string, channel: string}|null} най-скорошната покана
 */
function lastInviteForPhone(phone) {
  if (!phone) return null;

  const invites = Object.values(getSentMap()).filter((record) => record.phone === phone);
  if (!invites.length) return null;

  return invites.sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
}

/**
 * Влива поканите от резервното копие на разширението.
 *
 * Разширението пази своята история в Chrome, а таблото — в sent.json. Това
 * ги събира, за да не се окаже клиент „непоканен“ тук само защото поканата е
 * тръгнала от разширението.
 *
 * @param {Record<string, {date: string, channel: string}>} invites
 */
function mergeInvites(invites) {
  const data = getSentMap();
  let added = 0;

  for (const [rawPhone, value] of Object.entries(invites || {})) {
    const digits = String(rawPhone).replace(/\D/g, '');
    if (digits.length < 8) continue;

    const phone = `+${digits}`;
    const at = new Date(value && value.date ? value.date : value);
    if (Number.isNaN(at.getTime())) continue;

    const id = `ext-${digits}`;
    const existing = data[id];
    if (existing && new Date(existing.at) >= at) continue;

    data[id] = {
      channel: (value && value.channel) || 'разширение',
      at: at.toISOString(),
      phone,
    };
    added += 1;
  }

  writeJson(SENT_FILE, data);
  return { added };
}

/* ------------------------------ импорт ------------------------------ */

function saveImported(rows, meta = {}) {
  const payload = { importedAt: new Date().toISOString(), ...meta, rows };
  writeJson(IMPORT_FILE, payload);
  return payload;
}

function getImported() {
  return readJson(IMPORT_FILE, null);
}

function clearImported() {
  try {
    fs.unlinkSync(IMPORT_FILE);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

module.exports = {
  getSentMap,
  markSent,
  unmarkSent,
  lastInviteForPhone,
  mergeInvites,
  saveImported,
  getImported,
  clearImported,
  SENT_FILE,
  IMPORT_FILE,
};
