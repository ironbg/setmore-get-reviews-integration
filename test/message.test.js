'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { firstName, renderTemplate, whatsappLink, viberLink, smsLink } = require('../src/message');

test('firstName взима само първата дума', () => {
  assert.equal(firstName('Мария Петрова Иванова'), 'Мария');
  assert.equal(firstName('  Иван   Георгиев '), 'Иван');
  assert.equal(firstName(''), '');
});

test('шаблонът замества българските плейсхолдъри', () => {
  const text = renderTemplate('Здравей, {име}! Ела в {студио}: {линк}', {
    name: 'Мария Петрова',
    studio: 'Студио Релакс',
    link: 'https://g.page/r/abc',
  });
  assert.equal(text, 'Здравей, Мария! Ела в Студио Релакс: https://g.page/r/abc');
});

test('английските синоними работят еднакво', () => {
  assert.equal(renderTemplate('{name} @ {studio}', { name: 'Иван Г.', studio: 'X' }), 'Иван @ X');
});

test('непознат плейсхолдър остава непокътнат, вместо да стане празен', () => {
  assert.equal(renderTemplate('Здравей {непознато}', {}), 'Здравей {непознато}');
});

test('липсваща стойност дава празен низ, а не "undefined"', () => {
  assert.equal(renderTemplate('Линк: {линк}', { name: 'Иван' }), 'Линк: ');
});

test('WhatsApp линкът е без плюс и с кодиран текст', () => {
  const link = whatsappLink('+359888123456', 'Здравей & добре дошъл');
  assert.ok(link.startsWith('https://wa.me/359888123456?text='));
  assert.ok(link.includes('%26'), 'амперсандът трябва да е кодиран');
});

test('Viber линкът пази плюса кодиран', () => {
  assert.equal(viberLink('+359888123456'), 'viber://chat?number=%2B359888123456');
});

test('SMS линкът носи текста в body', () => {
  assert.ok(smsLink('+359888123456', 'Здравей').startsWith('sms:+359888123456?body='));
});
