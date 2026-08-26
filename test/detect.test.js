'use strict';

/**
 * Разчитането на прозореца в Setmore не може да гадае по CSS класове —
 * те се менят. Затова логиката работи върху текст и се тества тук.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadExtension() {
  const sandbox = { chrome: { storage: { sync: { get: async (d) => d } } }, console, module: { exports: {} } };
  vm.createContext(sandbox);

  for (const file of ['shared.js', 'detect.js']) {
    const code = fs.readFileSync(path.join(__dirname, '..', 'extension', file), 'utf8');
    vm.runInContext(code, sandbox, { filename: `extension/${file}` });
  }

  // `const`/`function` на най-горно ниво не се закачат еднакво за глобалния
  // обект, затова имената се вадят с отделен израз.
  const grab = (name) => vm.runInContext(name, sandbox);
  const findPhones = grab('findPhones');

  return {
    // Масивът се връща от другия realm и има собствен прототип — копираме го,
    // за да може deepEqual да го сравни с обикновен масив.
    findPhones: (text, cc) => [...findPhones(text, cc)],
    pickName: grab('pickName'),
    couldBeName: grab('couldBeName'),
    maskDigits: grab('maskDigits'),
  };
}

const ext = loadExtension();

test('телефонът се намира в текста на прозореца', () => {
  const text = ['Мария Петрова', 'Класически масаж 60 мин', '0888 123 456', '26 Aug 2026, 09:00'].join('\n');
  assert.deepEqual(ext.findPhones(text, '359'), ['+359888123456']);
});

test('различните формати дават един и същ номер, без повторения', () => {
  const text = ['+359 888 123 456', '0888123456', '00359888123456'].join('\n');
  assert.deepEqual(ext.findPhones(text, '359'), ['+359888123456']);
});

test('няколко различни номера се връщат в реда на срещане', () => {
  const text = 'Мобилен: 0888123456\nДомашен: 029876543';
  assert.deepEqual(ext.findPhones(text, '359'), ['+359888123456', '+35929876543']);
});

test('дати и часове не минават за телефон', () => {
  for (const text of ['26/08/2026', '09:00 - 10:00', '2026-08-26', '60 мин']) {
    assert.deepEqual(ext.findPhones(text, '359'), [], `${text} не е телефон`);
  }
});

test('текст без номер не дава нищо', () => {
  assert.deepEqual(ext.findPhones('Мария Петрова\nКласически масаж', '359'), []);
});

test('името е първият ред, който прилича на човешко име', () => {
  const lines = ['Appointment', 'Мария Петрова', 'Класически масаж 60 мин', '0888 123 456'];
  assert.equal(ext.pickName(lines), 'Мария Петрова');
});

test('етикет "Клиент" сочи еднозначно кой е редът с името', () => {
  const lines = ['Анна Иванова', 'Клиент', 'Мария Петрова', '0888123456'];
  assert.equal(ext.pickName(lines), 'Мария Петрова', 'етикетът бие първия подходящ ред');
});

test('"Customer: Име" на един ред също се разчита', () => {
  assert.equal(ext.pickName(['Booking details', 'Customer: Иван Георгиев']), 'Иван Георгиев');
});

test('бутони и етикети от интерфейса не минават за име', () => {
  for (const word of ['Edit', 'Delete', 'Reschedule', 'Клиент', 'Услуга', 'Телефон', 'Save']) {
    assert.equal(ext.couldBeName(word), false, `${word} не е име`);
  }
});

test('месеци и дни от календара не минават за име', () => {
  for (const word of ['August', 'Monday', 'Август', 'Понеделник']) {
    assert.equal(ext.couldBeName(word), false, `${word} не е име`);
  }
});

test('имена на услуги и редове с цифри отпадат', () => {
  assert.equal(ext.couldBeName('Класически масаж 60 мин'), false);
  assert.equal(ext.couldBeName('09:00 - 10:00'), false);
  assert.equal(ext.couldBeName('мария петрова'), false, 'име започва с главна буква');
  assert.equal(ext.couldBeName('Дълбокотъканен масаж на цяло тяло с ароматни масла'), false);
});

test('истински имена минават', () => {
  for (const name of ['Мария', 'Мария Петрова', 'Иван Георгиев Стоянов', 'Anna Smith']) {
    assert.equal(ext.couldBeName(name), true, `${name} е име`);
  }
});

test('прозорец без разпознато име не гърми', () => {
  assert.equal(ext.pickName([]), '');
  assert.equal(ext.pickName(['0888123456', '09:00']), '');
});

test('диагностиката скрива цифрите, за да може да се сподели', () => {
  const masked = ext.maskDigits('Мария Петрова | +359888123456 | 26/08/2026');
  assert.equal(masked.includes('888123'), false, 'номерът не бива да се вижда');
  assert.ok(masked.includes('***'));
  assert.ok(masked.includes('Мария Петрова'), 'останалият текст се запазва');
});

test('името на служителя не се бърка с това на клиента', () => {
  const lines = ['Служител', 'Анна', 'Клиент', 'Мария Петрова', '0888123456'];
  assert.equal(ext.pickName(lines), 'Мария Петрова');
});

test('служител преди клиента се прескача и без етикет "Клиент"', () => {
  const lines = ['Appointment', 'Staff', 'Анна', 'Мария Петрова', '0888 123 456'];
  assert.equal(ext.pickName(lines), 'Мария Петрова');
});
