'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhone, maskPhone } = require('../src/phone');

test('български номер с водеща нула получава код на държавата', () => {
  assert.equal(normalizePhone('0888123456').e164, '+359888123456');
});

test('интервалите, тиретата и скобите се игнорират', () => {
  assert.equal(normalizePhone('(0888) 12-34 56').e164, '+359888123456');
  assert.equal(normalizePhone('+359 888 123 456').e164, '+359888123456');
});

test('00 се приема за международен префикс', () => {
  assert.equal(normalizePhone('00359888123456').e164, '+359888123456');
});

test('номер без нула и без код се допълва с кода по подразбиране', () => {
  assert.equal(normalizePhone('888123456').e164, '+359888123456');
});

test('чужд номер с + се запазва както е', () => {
  assert.equal(normalizePhone('+44 7700 900123').e164, '+447700900123');
});

test('друг код на държавата се спазва', () => {
  assert.equal(normalizePhone('0612345678', '31').e164, '+31612345678');
});

test('празна и невалидна стойност се маркират, а не хвърлят грешка', () => {
  for (const value of ['', null, undefined, '   ', 'няма', '12']) {
    const result = normalizePhone(value);
    assert.equal(result.valid, false, `очаквах невалиден резултат за ${JSON.stringify(value)}`);
    assert.equal(result.e164, null);
    assert.ok(result.reason, 'невалидният номер трябва да носи причина');
  }
});

test('maskPhone крие средата на номера', () => {
  assert.equal(maskPhone('+359888123456'), '+359888***456');
});
