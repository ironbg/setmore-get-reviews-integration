'use strict';

/**
 * Разширението не може да ползва модулите на сървъра (то работи в браузъра),
 * затова носи собствени копия на normalizePhone и renderTemplate.
 * Този тест пази двете реализации да не се разминат във времето.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const server = {
  phone: require('../src/phone'),
  message: require('../src/message'),
};

function loadExtensionShared() {
  const code = fs.readFileSync(path.join(__dirname, '..', 'extension', 'shared.js'), 'utf8');
  const sandbox = { chrome: { storage: { sync: { get: async (d) => d } } }, console };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'extension/shared.js' });

  // `const` на най-горно ниво не се закача за глобалния обект, затова
  // лексикалните имена се вадят с отделен израз.
  return new Proxy(sandbox, {
    has: (target, name) => {
      if (name in target) return true;
      try {
        vm.runInContext(String(name), sandbox);
        return true;
      } catch {
        return false;
      }
    },
    get: (target, name) => {
      if (name in target) return target[name];
      try {
        return vm.runInContext(String(name), sandbox);
      } catch {
        return undefined;
      }
    },
  });
}

const ext = loadExtensionShared();

test('разширението изнася очакваните функции', () => {
  for (const name of ['normalizePhone', 'renderTemplate', 'whatsappLink', 'viberLink', 'DEFAULT_SETTINGS']) {
    assert.ok(name in ext, `липсва ${name} в extension/shared.js`);
  }
});

test('нормализацията на телефони съвпада със сървърната', () => {
  const cases = [
    '0888123456',
    '+359 888 123 456',
    '00359888123456',
    '(0888) 12-34-56',
    '888123456',
    '+44 7700 900123',
    '',
    'няма',
    '12',
  ];

  for (const value of cases) {
    assert.equal(
      ext.normalizePhone(value, '359'),
      server.phone.normalizePhone(value, '359').e164,
      `разминаване за ${JSON.stringify(value)}`
    );
  }
});

test('шаблонът се попълва еднакво от двете страни', () => {
  const template = 'Здравейте, {име}! Благодарим за посещението в {студио}. Отзив: {линк} ({непознато})';
  const vars = { name: 'Мария Петрова', studio: 'Студио Релакс', link: 'https://g.page/r/abc' };

  assert.equal(ext.renderTemplate(template, vars), server.message.renderTemplate(template, vars));
});

test('линковете съвпадат със сървърните', () => {
  const text = 'Здравей & добре дошъл';
  assert.equal(ext.whatsappLink('+359888123456', text), server.message.whatsappLink('+359888123456', text));
  assert.equal(ext.viberLink('+359888123456'), server.message.viberLink('+359888123456'));
});

test('шаблонът по подразбиране на разширението съдържа всички плейсхолдъри', () => {
  for (const placeholder of ['{име}', '{студио}', '{линк}']) {
    assert.ok(ext.DEFAULT_SETTINGS.template.includes(placeholder), `липсва ${placeholder}`);
  }
});
