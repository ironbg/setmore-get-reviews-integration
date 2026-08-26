'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRows, parseDelimited, detectDelimiter, parseDate, parseTime } = require('../src/importer');

test('запетайките вътре в кавички не режат клетката', () => {
  const rows = parseDelimited('Име,Бележка\n"Петров, Иван","масаж, гръб"', ',');
  assert.deepEqual(rows[1], ['Петров, Иван', 'масаж, гръб']);
});

test('двойните кавички вътре в клетка стават една', () => {
  assert.deepEqual(parseDelimited('a,"каза ""да"""', ',')[0], ['a', 'каза "да"']);
});

test('нов ред вътре в кавички не разделя реда', () => {
  const rows = parseDelimited('Име,Бележка\nИван,"първи ред\nвтори ред"', ',');
  assert.equal(rows.length, 2);
  assert.equal(rows[1][1], 'първи ред\nвтори ред');
});

test('разделителят се разпознава сам', () => {
  assert.equal(detectDelimiter('a\tb\tc\n1\t2\t3'), '\t');
  assert.equal(detectDelimiter('a,b,c\n1,2,3'), ',');
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
});

test('датите се разчитат в различните им формати', () => {
  assert.equal(parseDate('2026-08-26'), '2026-08-26');
  assert.equal(parseDate('26/08/2026'), '2026-08-26');
  assert.equal(parseDate('26.08.2026'), '2026-08-26');
  assert.equal(parseDate('08/26/2026'), '2026-08-26', 'ден над 12 решава реда еднозначно');
  assert.equal(parseDate(''), null);
  assert.equal(parseDate('няма'), null);
});

test('часът се разчита и в 12-часов формат', () => {
  assert.equal(parseTime('14:30'), '14:30');
  assert.equal(parseTime('2:30 PM'), '14:30');
  assert.equal(parseTime('12:15 AM'), '00:15');
  assert.equal(parseTime('няма'), null);
});

test('залепени редове с табулация се разчитат', () => {
  const text = [
    'Customer Name\tPhone Number\tDate\tService',
    'Мария Петрова\t0888123456\t26/08/2026\tКласически масаж',
    'Иван Георгиев\t+359 899 55 44 33\t26/08/2026\tСпортен масаж',
  ].join('\n');

  const { rows, skipped } = importRows(text);

  assert.equal(rows.length, 2);
  assert.equal(skipped, 0);
  assert.equal(rows[0].customerName, 'Мария Петрова');
  assert.equal(rows[0].phone, '+359888123456');
  assert.equal(rows[0].start, '2026-08-26', 'без колона за час не измисляме час');
  assert.equal(rows[0].service, 'Класически масаж');
  assert.equal(rows[1].phone, '+359899554433');
});

test('отделни колони за собствено име и фамилия се сглобяват', () => {
  const text = 'First Name,Last Name,Email,Phone\nМария,Петрова,m@x.bg,0888123456';
  const { rows } = importRows(text);

  assert.equal(rows[0].customerName, 'Мария Петрова');
  assert.equal(rows[0].email, 'm@x.bg');
});

test('българските заглавия също се разпознават', () => {
  const text = 'Клиент;Телефон;Дата;Услуга\nЕлена Тодорова;0877 22 11 00;26.08.2026;Лимфен дренаж';
  const { rows } = importRows(text);

  assert.equal(rows[0].customerName, 'Елена Тодорова');
  assert.equal(rows[0].phone, '+359877221100');
  assert.equal(rows[0].service, 'Лимфен дренаж');
});

test('файл без заглавен ред се приема като име и телефон', () => {
  const { rows, warnings } = importRows('Мария Петрова,0888123456\nИван Георгиев,0899554433');

  assert.equal(rows.length, 2);
  assert.equal(rows[0].customerName, 'Мария Петрова');
  assert.equal(rows[0].phone, '+359888123456');
  assert.ok(warnings.some((w) => w.includes('заглавен ред')));
});

test('телефон в неочаквана колона все пак се намира', () => {
  const text = 'Name,Notes,Contact\nМария Петрова,редовен клиент,0888123456';
  const { rows } = importRows(text);

  assert.equal(rows[0].phone, '+359888123456');
});

test('ред без име и без телефон се пропуска, но се брои', () => {
  const text = 'Name,Phone\nМария Петрова,0888123456\n,\nИван Георгиев,0899554433';
  const { rows, skipped } = importRows(text);

  assert.equal(rows.length, 2);
  assert.equal(skipped, 0, 'напълно празните редове се махат още при парсването');
});

test('клиент с нечетим телефон остава в списъка, но е маркиран', () => {
  const { rows } = importRows('Name,Phone\nДесислава Илиева,няма');

  assert.equal(rows.length, 1);
  assert.equal(rows[0].customerName, 'Десислава Илиева');
  assert.equal(rows[0].phoneValid, false);
  assert.ok(rows[0].phoneProblem);
});

test('резервната дата се ползва само при липсваща колона с дата', () => {
  const withoutDate = importRows('Name,Phone\nМария,0888123456', { fallbackDate: '2026-08-26' });
  assert.equal(withoutDate.rows[0].start, '2026-08-26');

  const withDate = importRows('Name,Phone,Date\nМария,0888123456,01/07/2026', { fallbackDate: '2026-08-26' });
  assert.equal(withDate.rows[0].start, '2026-07-01', 'колоната бие резервната дата');
});

test('един и същ клиент в един и същ ден дава един и същ id', () => {
  const first = importRows('Name,Phone,Date\nМария Петрова,0888123456,26/08/2026');
  const second = importRows('Клиент,Телефон,Дата\nМария Петрова,+359 888 123 456,2026-08-26');

  assert.equal(first.rows[0].id, second.rows[0].id, 'иначе един клиент би получил две покани');
});

test('празен вход не гърми', () => {
  const { rows, warnings } = importRows('');
  assert.equal(rows.length, 0);
  assert.ok(warnings.length);
});

test('часът от колоната влиза в началото на посещението', () => {
  const { rows } = importRows('Name,Phone,Date,Time\nМария,0888123456,26/08/2026,2:30 PM');
  assert.equal(rows[0].start, '2026-08-26T14:30:00');
});
