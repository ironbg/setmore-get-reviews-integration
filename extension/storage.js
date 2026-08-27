/**
 * Памет на разширението: кой вече е канен и кои клиенти сме виждали.
 *
 * Две различни хранилища, защото имат различни изисквания:
 *
 *   chrome.storage.sync  — поканите. Chrome ги синхронизира през акаунта, с
 *                          който си влязъл в браузъра, така че преживяват
 *                          преинсталация на Windows и се виждат на друг
 *                          компютър. Има цена: 100 KB общо, 8 KB на запис.
 *   chrome.storage.local — видените клиенти. По-обемни са и не са критични;
 *                          ако се загубят, губиш удобство, не история.
 *
 * Заради лимита от 8 KB на запис поканите се пазят разпределени в няколко
 * записа, а форматът е нарочно стиснат: ключ е телефонът само с цифри, а
 * стойността е [ден, канал]. Денят е брой дни от 1970 — с цяло число вместо
 * дата един запис излиза около 30 байта и в лимита се събират хиляди покани.
 */

const INVITE_PREFIX = 'gr_inv_';
const INVITE_SHARDS = 16;
const CLIENTS_KEY = 'gr_clients';

/*
 * Записът за клиент отговаря на един въпрос: да пращам ли на този човек?
 * Затова „не изпращай“ живее в същия списък като поканите, само с друг код на
 * канала — така се синхронизира по същия начин и не иска второ хранилище.
 */
const DO_NOT_CONTACT = 'x';
const CHANNEL_CODES = { whatsapp: 'w', viber: 'v', manual: 'm', blocked: DO_NOT_CONTACT };
const CHANNEL_NAMES = { w: 'WhatsApp', v: 'Viber', m: 'ръчно', [DO_NOT_CONTACT]: 'не изпращай' };

/** Клиент, който е помолил да не получава съобщения. */
function isBlocked(record) {
  return Boolean(record && record.channel === DO_NOT_CONTACT);
}

/*
 * Кодът на държавата, с който се допълват националните номера. Идва от
 * настройките — content.js и options.js го подават след като ги заредят.
 */
let countryCode = '359';

function setCountryCode(code) {
  if (code) countryCode = String(code).replace(/\D/g, '') || countryCode;
}

/**
 * Ключ на клиента.
 *
 * Само махането на нецифрите не стига: „0888123456“ и „+359888123456“ са един
 * и същ човек, но дават различни низове и клиентът би минал за двама. Затова
 * номерът минава през същата нормализация като навсякъде другаде.
 */
function phoneKey(phone) {
  const raw = String(phone || '');

  if (typeof normalizePhone === 'function') {
    const e164 = normalizePhone(raw, countryCode);
    if (e164) return e164.replace(/\D/g, '');
  }

  return raw.replace(/\D/g, '');
}

function shardFor(key) {
  let sum = 0;
  for (let i = 0; i < key.length; i += 1) sum += key.charCodeAt(i);
  return `${INVITE_PREFIX}${sum % INVITE_SHARDS}`;
}

function today() {
  return Math.floor(Date.now() / 86400000);
}

/** Ден-число обратно в дата, за показване. */
function dayToDate(day) {
  return new Date(day * 86400000);
}

/** Годината се показва само когато не е текущата — във футъра мястото е малко. */
function formatDay(day) {
  const date = dayToDate(day);
  const sameYear = date.getFullYear() === new Date().getFullYear();

  return date.toLocaleDateString('bg-BG', {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

const allShardKeys = () =>
  Array.from({ length: INVITE_SHARDS }, (unused, index) => `${INVITE_PREFIX}${index}`);

/* ------------------------------ покани ------------------------------ */

/**
 * Всички покани наведнъж.
 * @returns {Promise<Map<string, {day: number, channel: string}>>}
 */
async function loadInvites() {
  const stored = await chrome.storage.sync.get(allShardKeys());
  const invites = new Map();

  for (const shard of Object.values(stored)) {
    if (!shard || typeof shard !== 'object') continue;
    for (const [key, value] of Object.entries(shard)) {
      const [day, channel] = Array.isArray(value) ? value : [value, 'm'];
      invites.set(key, { day, channel });
    }
  }

  return invites;
}

async function recordInvite(phone, channelName) {
  const key = phoneKey(phone);
  if (!key) return null;

  const shardKey = shardFor(key);
  const stored = await chrome.storage.sync.get(shardKey);
  const shard = stored[shardKey] || {};
  const record = [today(), CHANNEL_CODES[channelName] || 'm'];

  shard[key] = record;

  try {
    await chrome.storage.sync.set({ [shardKey]: shard });
  } catch (error) {
    // Препълнен запис не бива да проваля изпращането — казваме го и
    // продължаваме, вместо да губим самото съобщение.
    console.warn('[Покани за ревю] Не успях да запазя поканата:', error);
    return null;
  }

  return { day: record[0], channel: record[1] };
}

/**
 * Отбелязва клиента като „не изпращай“ или го връща обратно.
 * Връщането трие записа изцяло — тогава клиентът е като всеки друг.
 */
async function setDoNotContact(phone, on) {
  return on ? recordInvite(phone, 'blocked') : forgetInvite(phone);
}

async function forgetInvite(phone) {
  const key = phoneKey(phone);
  const shardKey = shardFor(key);
  const stored = await chrome.storage.sync.get(shardKey);
  const shard = stored[shardKey] || {};

  delete shard[key];
  await chrome.storage.sync.set({ [shardKey]: shard });
}

/* ------------------------- видени клиенти ------------------------- */

async function loadClients() {
  const stored = await chrome.storage.local.get(CLIENTS_KEY);
  return stored[CLIENTS_KEY] || {};
}

/**
 * Записва клиент, когото сме видели в отворен час.
 * Така списъкът се пълни от само себе си, без експорт от Setmore.
 */
async function rememberClient({ phone, name, service }) {
  const key = phoneKey(phone);
  if (!key) return;

  const clients = await loadClients();
  const existing = clients[key] || {};

  clients[key] = {
    name: name || existing.name || '',
    service: service || existing.service || '',
    // Пазим първата и последната среща — така се вижда кой е редовен клиент.
    firstSeen: existing.firstSeen || today(),
    lastSeen: today(),
  };

  await chrome.storage.local.set({ [CLIENTS_KEY]: clients });
}

/* --------------------------- резервно копие --------------------------- */

async function exportBackup() {
  const invites = await loadInvites();

  return {
    format: 'setmore-review-invites',
    version: 1,
    exportedAt: new Date().toISOString(),
    invites: Object.fromEntries(
      [...invites].map(([key, value]) => [key, { date: dayToDate(value.day).toISOString().slice(0, 10), channel: CHANNEL_NAMES[value.channel] || 'ръчно' }])
    ),
    clients: await loadClients(),
  };
}

/**
 * Влива резервно копие върху текущите данни.
 * Нищо не се трие — при засичане остава по-скорошната покана.
 */
async function importBackup(data) {
  if (!data || data.format !== 'setmore-review-invites') {
    throw new Error('Това не е резервно копие на разширението.');
  }

  const existing = await loadInvites();
  const shards = {};
  let added = 0;

  const put = (key, day, channel) => {
    const shardKey = shardFor(key);
    shards[shardKey] = shards[shardKey] || {};
    shards[shardKey][key] = [day, channel];
  };

  for (const [key, value] of existing) put(key, value.day, value.channel);

  for (const [rawKey, value] of Object.entries(data.invites || {})) {
    const key = phoneKey(rawKey);
    if (!key) continue;

    const day = Math.floor(new Date(value.date || value).getTime() / 86400000);
    if (!Number.isFinite(day)) continue;

    const current = existing.get(key);
    if (current && current.day >= day) continue;

    const channelName = String(value.channel || '').toLowerCase();
    const code = channelName.startsWith('what')
      ? 'w'
      : channelName.startsWith('vib')
        ? 'v'
        : channelName.startsWith('не изпращай')
          ? DO_NOT_CONTACT
          : 'm';

    put(key, day, code);
    added += 1;
  }

  await chrome.storage.sync.set(shards);

  if (data.clients && typeof data.clients === 'object') {
    const clients = await loadClients();
    await chrome.storage.local.set({ [CLIENTS_KEY]: { ...data.clients, ...clients } });
  }

  return { added, total: Object.keys(data.invites || {}).length };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    phoneKey, setCountryCode, shardFor, loadInvites, recordInvite, forgetInvite,
    setDoNotContact, isBlocked, DO_NOT_CONTACT,
    loadClients, rememberClient, exportBackup, importBackup,
    formatDay, today, CHANNEL_NAMES, INVITE_SHARDS,
  };
}
