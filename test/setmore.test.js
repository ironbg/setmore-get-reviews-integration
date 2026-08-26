'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAppointment, findAppointmentArray, toSetmoreDate } = require('../src/setmore');

test('датата се превежда във формата на Setmore', () => {
  assert.equal(toSetmoreDate('2026-08-26'), '26/08/2026');
  assert.equal(toSetmoreDate('2026-01-05'), '05/01/2026');
});

test('масивът с часове се намира и при вложена структура', () => {
  const payload = {
    response: true,
    data: { appointments: [{ key: 'a1', start_time: '2026-08-26T10:00:00Z' }] },
  };
  assert.equal(findAppointmentArray(payload).length, 1);
});

test('масивът се намира и когато Setmore смени обвивката', () => {
  const payload = { result: { data: { bookings: [{ appointment_key: 'x', startTime: '2026-08-26T10:00:00Z' }] } } };
  assert.equal(findAppointmentArray(payload)[0].appointment_key, 'x');
});

test('липсващ масив връща null, вместо да гръмне', () => {
  assert.equal(findAppointmentArray({ response: false, msg: 'no data' }), null);
  assert.equal(findAppointmentArray(null), null);
});

test('записът се нормализира до формата на интерфейса', () => {
  const appointment = normalizeAppointment(
    {
      key: 'appt-1',
      start_time: '2026-08-26T10:00:00Z',
      end_time: '2026-08-26T11:00:00Z',
      customer: { first_name: 'Мария', last_name: 'Петрова', cell_phone: '0888123456', email_id: 'm@x.bg' },
      service: { service_name: 'Класически масаж' },
      staff: { first_name: 'Анна' },
    },
    '359'
  );

  assert.equal(appointment.id, 'appt-1');
  assert.equal(appointment.customerName, 'Мария Петрова');
  assert.equal(appointment.phone, '+359888123456');
  assert.equal(appointment.phoneValid, true);
  assert.equal(appointment.service, 'Класически масаж');
  assert.equal(appointment.staff, 'Анна');
  assert.equal(appointment.email, 'm@x.bg');
});

test('алтернативните имена на полета също се разпознават', () => {
  const appointment = normalizeAppointment(
    {
      appointmentKey: 'appt-2',
      startTime: '2026-08-26T12:00:00Z',
      customer: { name: 'Иван Георгиев', phone_number: '+359899554433' },
      service: { name: 'Спортен масаж' },
    },
    '359'
  );

  assert.equal(appointment.id, 'appt-2');
  assert.equal(appointment.customerName, 'Иван Георгиев');
  assert.equal(appointment.phone, '+359899554433');
  assert.equal(appointment.service, 'Спортен масаж');
});

test('час без телефон се маркира, но не се губи', () => {
  const appointment = normalizeAppointment(
    { key: 'appt-3', start_time: '2026-08-26T13:00:00Z', customer: { first_name: 'Елена' } },
    '359'
  );

  assert.equal(appointment.customerName, 'Елена');
  assert.equal(appointment.phoneValid, false);
  assert.ok(appointment.phoneProblem);
});

test('час без никакви данни за клиента получава име по подразбиране', () => {
  const appointment = normalizeAppointment({ key: 'appt-4', start_time: '2026-08-26T14:00:00Z' }, '359');
  assert.equal(appointment.customerName, 'Без име');
  assert.equal(appointment.phoneValid, false);
});
