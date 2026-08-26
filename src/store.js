'use strict';

/**
 * Кой клиент вече е получил покана за ревю.
 *
 * Нарочно е обикновен JSON файл, а не база данни: обемът е няколко записа на
 * ден, а така всичко се архивира с едно копиране на папката.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.SETMORE_REVIEW_DATA || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'sent.json');

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    // Повреден файл не бива да събаря приложението — правим копие и започваме начисто.
    const backup = `${FILE}.broken-${Date.now()}`;
    try {
      fs.renameSync(FILE, backup);
      console.warn(`[store] ${FILE} беше повреден и е преместен в ${backup}`);
    } catch {
      /* ако и това не стане, продължаваме с празен запис */
    }
    return {};
  }
}

function writeAll(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Пишем през временен файл, за да не остане половин JSON при спиране на процеса.
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

/** @returns {Record<string, {channel: string, at: string, note?: string}>} */
function getSentMap() {
  return readAll();
}

function markSent(appointmentId, channel, note) {
  if (!appointmentId) throw new Error('Липсва id на часа.');
  const data = readAll();
  data[appointmentId] = {
    channel: channel || 'unknown',
    at: new Date().toISOString(),
    ...(note ? { note } : {}),
  };
  writeAll(data);
  return data[appointmentId];
}

function unmarkSent(appointmentId) {
  const data = readAll();
  delete data[appointmentId];
  writeAll(data);
}

module.exports = { getSentMap, markSent, unmarkSent, FILE };
