'use strict';

/**
 * Общата логика на разширението: телефони, шаблони, линкове.
 *
 * Файлът е писан за браузър, затова се зарежда в отделен контекст с подобие
 * на chrome. Дотук тези правила се проверяваха през копие в сървърната част;
 * след премахването на таблото се тестват директно тук.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadShared() {
  const sandbox = { chrome: { storage: { sync: { get: async (d) => d } } }, console, module: { exports: {} } };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, '..', 'extension', 'shared.js'), 'utf8'),
    sandbox,
    { filename: 'extension/shared.js' }
  );

  const grab = (name) => vm.runInContext(name, sandbox);
  return {
    normalizePhone: grab('normalizePhone'),
    firstName: grab('firstName'),
    renderTemplate: grab('renderTemplate'),
    whatsappLink: grab('whatsappLink'),
    viberLink: grab('viberLink'),
    DEFAULT_SETTINGS: grab('DEFAULT_SETTINGS'),
  };
}

const ext = loadShared();

/* ------------------------------ телефони ------------------------------ */

test('български номер с водеща нула получава код на държавата', () => {
  assert.equal(ext.normalizePhone('0888123456', '359'), '+359888123456');
});

test('интервалите, тиретата и скобите се игнорират', () => {
  assert.equal(ext.normalizePhone('(0888) 12-34 56', '359'), '+359888123456');
  assert.equal(ext.normalizePhone('+359 888 123 456', '359'), '+359888123456');
});

test('00 се приема за международен префикс', () => {
  assert.equal(ext.normalizePhone('00359888123456', '359'), '+359888123456');
});

test('номер без нула и без код се допълва с кода по подразбиране', () => {
  assert.equal(ext.normalizePhone('888123456', '359'), '+359888123456');
});

test('чужд номер с + се запазва както е', () => {
  assert.equal(ext.normalizePhone('+44 7700 900123', '359'), '+447700900123');
});

test('друг код на държавата се спазва', () => {
  assert.equal(ext.normalizePhone('0612345678', '31'), '+31612345678');
});

test('празна и невалидна стойност дават null, вместо да хвърлят', () => {
  for (const value of ['', null, undefined, '   ', 'няма', '12']) {
    assert.equal(ext.normalizePhone(value, '359'), null, `очаквах null за ${JSON.stringify(value)}`);
  }
});

/* ------------------------------ шаблони ------------------------------ */

test('firstName взима само първата дума', () => {
  assert.equal(ext.firstName('Мария Петрова Иванова'), 'Мария');
  assert.equal(ext.firstName('  Иван   Георгиев '), 'Иван');
  assert.equal(ext.firstName(''), '');
});

test('шаблонът замества българските плейсхолдъри', () => {
  const text = ext.renderTemplate('Здравей, {име}! Ела в {студио}: {линк}', {
    name: 'Мария Петрова',
    studio: 'Студио Релакс',
    link: 'https://g.page/r/abc',
  });
  assert.equal(text, 'Здравей, Мария! Ела в Студио Релакс: https://g.page/r/abc');
});

test('английските синоними работят еднакво', () => {
  assert.equal(ext.renderTemplate('{name} @ {studio}', { name: 'Иван Г.', studio: 'X' }), 'Иван @ X');
});

test('непознат плейсхолдър остава непокътнат, вместо да стане празен', () => {
  assert.equal(ext.renderTemplate('Здравей {непознато}', {}), 'Здравей {непознато}');
});

test('липсваща стойност дава празен низ, а не "undefined"', () => {
  assert.equal(ext.renderTemplate('Линк: {линк}', { name: 'Иван' }), 'Линк: ');
});

test('шаблонът по подразбиране съдържа всички плейсхолдъри', () => {
  for (const placeholder of ['{име}', '{студио}', '{линк}']) {
    assert.ok(ext.DEFAULT_SETTINGS.template.includes(placeholder), `липсва ${placeholder}`);
  }
});

/* ------------------------------- линкове ------------------------------- */

test('WhatsApp линкът е без плюс и с кодиран текст', () => {
  const link = ext.whatsappLink('+359888123456', 'Здравей & добре дошъл');
  assert.ok(link.startsWith('https://wa.me/359888123456?text='));
  assert.ok(link.includes('%26'), 'амперсандът трябва да е кодиран');
});

test('Viber линкът пази плюса кодиран', () => {
  assert.equal(ext.viberLink('+359888123456'), 'viber://chat?number=%2B359888123456');
});
