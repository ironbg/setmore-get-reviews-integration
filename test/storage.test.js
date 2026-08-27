'use strict';

/**
 * Хранилището на разширението работи върху chrome.storage, който го няма в
 * Node. Тук се подава негово подобие, за да се провери и това, което на
 * практика е трудно да се хване в браузър: разпределението по записи заради
 * лимита от 8 KB и сливането при възстановяване от копие.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const QUOTA_BYTES_PER_ITEM = 8192;

function fakeArea(bag, { enforceQuota = false, failWrites = false } = {}) {
  return {
    get: async (keys) => {
      const list = keys == null ? Object.keys(bag) : Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of list) {
        if (key in bag) out[key] = JSON.parse(JSON.stringify(bag[key]));
      }
      return out;
    },
    set: async (items) => {
      if (failWrites) throw new Error('QUOTA_BYTES quota exceeded');

      for (const [key, value] of Object.entries(items)) {
        if (enforceQuota && JSON.stringify(value).length > QUOTA_BYTES_PER_ITEM) {
          throw new Error(`QUOTA_BYTES_PER_ITEM quota exceeded for ${key}`);
        }
        bag[key] = JSON.parse(JSON.stringify(value));
      }
    },
  };
}

function loadStorage({ enforceQuota = false, failWrites = false } = {}) {
  const sync = {};
  const local = {};
  const sandbox = {
    chrome: { storage: { sync: fakeArea(sync, { enforceQuota, failWrites }), local: fakeArea(local) } },
    console: { warn: () => {} },
    Date,
    JSON,
    Math,
    Number,
    Array,
    Object,
    String,
    Error,
    module: { exports: {} },
  };
  vm.createContext(sandbox);
  // shared.js носи normalizePhone, от която зависи ключът на клиента.
  for (const file of ['shared.js', 'storage.js']) {
    vm.runInContext(
      fs.readFileSync(path.join(__dirname, '..', 'extension', file), 'utf8'),
      sandbox,
      { filename: `extension/${file}` }
    );
  }

  const grab = (name) => vm.runInContext(name, sandbox);
  return {
    sync,
    local,
    phoneKey: grab('phoneKey'),
    shardFor: grab('shardFor'),
    loadInvites: grab('loadInvites'),
    recordInvite: grab('recordInvite'),
    forgetInvite: grab('forgetInvite'),
    loadClients: grab('loadClients'),
    rememberClient: grab('rememberClient'),
    exportBackup: grab('exportBackup'),
    importBackup: grab('importBackup'),
    setDoNotContact: grab('setDoNotContact'),
    isBlocked: grab('isBlocked'),
    today: grab('today'),
    INVITE_SHARDS: grab('INVITE_SHARDS'),
  };
}

test('един и същ номер в различен запис дава един ключ', () => {
  const store = loadStorage();
  const keys = ['+359888123456', '0888123456', '359 888 123 456'].map(store.phoneKey);
  assert.equal(new Set(keys.map((key) => key.slice(-9))).size, 1);
});

test('поканата се записва и се намира обратно', async () => {
  const store = loadStorage();

  await store.recordInvite('+359888123456', 'viber');
  const invites = await store.loadInvites();

  const record = invites.get(store.phoneKey('+359888123456'));
  assert.ok(record, 'поканата трябва да се намира');
  assert.equal(record.channel, 'v');
  assert.equal(record.day, store.today());
});

test('различните клиенти се пазят поотделно', async () => {
  const store = loadStorage();

  await store.recordInvite('0888123456', 'whatsapp');
  const invites = await store.loadInvites();

  assert.equal(invites.size, 1);
  assert.equal(invites.has(store.phoneKey('0899554433')), false);
});

test('повторна покана презаписва, вместо да трупа', async () => {
  const store = loadStorage();

  await store.recordInvite('0888123456', 'viber');
  await store.recordInvite('0888123456', 'whatsapp');

  const invites = await store.loadInvites();
  assert.equal(invites.size, 1);
  assert.equal(invites.get(store.phoneKey('0888123456')).channel, 'w');
});

test('поканата може да се забрави', async () => {
  const store = loadStorage();

  await store.recordInvite('0888123456', 'viber');
  await store.forgetInvite('0888123456');

  assert.equal((await store.loadInvites()).size, 0);
});

test('номер без цифри не се записва', async () => {
  const store = loadStorage();

  assert.equal(await store.recordInvite('', 'viber'), null);
  assert.equal((await store.loadInvites()).size, 0);
});

test('поканите се разпределят между записите, а не се трупат в един', async () => {
  const store = loadStorage();

  for (let i = 0; i < 200; i += 1) {
    await store.recordInvite(`+35988${String(i).padStart(7, '0')}`, 'viber');
  }

  const used = Object.keys(store.sync).length;
  assert.ok(used > 1, 'при 200 покани трябва да са заети няколко записа');
  assert.ok(used <= store.INVITE_SHARDS, 'не бива да се създават повече записи от предвиденото');
  assert.equal((await store.loadInvites()).size, 200);
});

test('никой запис не надхвърля лимита на Chrome при много покани', async () => {
  const store = loadStorage({ enforceQuota: true });

  for (let i = 0; i < 1500; i += 1) {
    await store.recordInvite(`+35988${String(i).padStart(7, '0')}`, 'viber');
  }

  for (const [key, value] of Object.entries(store.sync)) {
    const size = JSON.stringify(value).length;
    assert.ok(size <= QUOTA_BYTES_PER_ITEM, `${key} е ${size} байта, над лимита`);
  }

  assert.equal((await store.loadInvites()).size, 1500);
});

test('изчерпана квота не проваля изпращането', async () => {
  // Съобщението към клиента е по-важно от отметката: ако хранилището откаже,
  // recordInvite връща null, вместо да хвърли и да спре бутона.
  const store = loadStorage({ failWrites: true });

  const result = await store.recordInvite('+359888123456', 'viber');

  assert.equal(result, null, 'отказът се съобщава със стойност, не с изключение');
  assert.equal((await store.loadInvites()).size, 0);
});

test('клиентът се запомня и се обновява при следващо посещение', async () => {
  const store = loadStorage();

  await store.rememberClient({ phone: '+359888123456', name: 'Мария Янкова' });
  await store.rememberClient({ phone: '0888123456', name: 'Мария Янкова', service: 'Класически масаж' });

  const clients = await store.loadClients();
  const keys = Object.keys(clients);

  assert.equal(keys.length, 1, 'един и същ телефон е един клиент');
  assert.equal(clients[keys[0]].name, 'Мария Янкова');
  assert.equal(clients[keys[0]].service, 'Класически масаж');
  assert.equal(clients[keys[0]].firstSeen, store.today());
});

test('копието съдържа поканите в четим вид', async () => {
  const store = loadStorage();

  await store.recordInvite('+359888123456', 'whatsapp');
  const backup = await store.exportBackup();

  assert.equal(backup.format, 'setmore-review-invites');
  const entry = backup.invites[store.phoneKey('+359888123456')];
  assert.match(entry.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(entry.channel, 'WhatsApp');
});

test('възстановяването добавя, без да трие съществуващото', async () => {
  const store = loadStorage();
  await store.recordInvite('+359888123456', 'viber');

  const result = await store.importBackup({
    format: 'setmore-review-invites',
    invites: { '359899554433': { date: '2026-01-15', channel: 'WhatsApp' } },
  });

  const invites = await store.loadInvites();
  assert.equal(result.added, 1);
  assert.equal(invites.size, 2, 'старата покана трябва да остане');
  assert.ok(invites.has(store.phoneKey('0899554433')));
});

test('при засичане остава по-скорошната покана', async () => {
  const store = loadStorage();
  await store.recordInvite('+359888123456', 'viber');
  const before = (await store.loadInvites()).get(store.phoneKey('+359888123456')).day;

  await store.importBackup({
    format: 'setmore-review-invites',
    invites: { '359888123456': { date: '2020-01-01', channel: 'WhatsApp' } },
  });

  const after = (await store.loadInvites()).get(store.phoneKey('+359888123456'));
  assert.equal(after.day, before, 'по-старият запис не бива да замести по-новия');
  assert.equal(after.channel, 'v');
});

test('чужд файл се отхвърля с разбираемо съобщение', async () => {
  const store = loadStorage();

  await assert.rejects(() => store.importBackup({ some: 'other file' }), /резервно копие/);
  await assert.rejects(() => store.importBackup(null), /резервно копие/);
});

test('повредени записи в копието се прескачат, вместо да провалят целия внос', async () => {
  const store = loadStorage();

  const result = await store.importBackup({
    format: 'setmore-review-invites',
    invites: {
      '359888123456': { date: '2026-02-01', channel: 'Viber' },
      'без-цифри': { date: '2026-02-01' },
      '359899554433': { date: 'не е дата' },
    },
  });

  assert.equal(result.added, 1);
  assert.equal((await store.loadInvites()).size, 1);
});

/* --------------------- „не изпращай на този клиент“ --------------------- */

test('клиент може да се отбележи като "не изпращай"', async () => {
  const store = loadStorage();

  await store.setDoNotContact('+359888123456', true);
  const record = (await store.loadInvites()).get(store.phoneKey('+359888123456'));

  assert.ok(store.isBlocked(record), 'записът трябва да е разпознат като блокиран');
});

test('обикновена покана не се брои за "не изпращай"', async () => {
  const store = loadStorage();

  await store.recordInvite('+359888123456', 'viber');
  const record = (await store.loadInvites()).get(store.phoneKey('+359888123456'));

  assert.equal(store.isBlocked(record), false);
});

test('връщането на клиента трие записа изцяло', async () => {
  const store = loadStorage();

  await store.setDoNotContact('+359888123456', true);
  await store.setDoNotContact('+359888123456', false);

  assert.equal((await store.loadInvites()).size, 0, 'клиентът трябва да е като всеки друг');
});

test('блокирането важи и когато клиентът вече е бил канен', async () => {
  const store = loadStorage();

  await store.recordInvite('+359888123456', 'whatsapp');
  await store.setDoNotContact('+359888123456', true);

  const record = (await store.loadInvites()).get(store.phoneKey('+359888123456'));
  assert.ok(store.isBlocked(record), 'блокирането трябва да замести поканата');
});

test('отмяната на отметка връща клиента като непоканен', async () => {
  const store = loadStorage();

  await store.recordInvite('+359888123456', 'whatsapp');
  await store.forgetInvite('+359888123456');

  assert.equal((await store.loadInvites()).get(store.phoneKey('+359888123456')), undefined);
});

test('"не изпращай" се пази в резервното копие и се връща от него', async () => {
  const store = loadStorage();
  await store.setDoNotContact('+359888123456', true);

  const backup = await store.exportBackup();
  assert.equal(backup.invites[store.phoneKey('+359888123456')].channel, 'не изпращай');

  const restored = loadStorage();
  await restored.importBackup(backup);

  const record = (await restored.loadInvites()).get(restored.phoneKey('+359888123456'));
  assert.ok(restored.isBlocked(record), 'блокирането трябва да преживее копието');
});
