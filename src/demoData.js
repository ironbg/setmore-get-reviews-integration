'use strict';

/**
 * Примерни часове за режим "демо" — когато още няма Setmore токен.
 * Така интерфейсът може да се пробва веднага, без да се чака достъп до API.
 */

const { normalizePhone } = require('./phone');

const PEOPLE = [
  { name: 'Мария Петрова', phone: '0888123456', service: 'Класически масаж 60 мин' },
  { name: 'Иван Георгиев', phone: '+359 899 55 44 33', service: 'Спортен масаж 90 мин' },
  { name: 'Елена Тодорова', phone: '0877 22 11 00', service: 'Релаксиращ масаж 60 мин' },
  { name: 'Николай Стоянов', phone: '0898765432', service: 'Масаж на гръб 30 мин' },
  { name: 'Десислава Илиева', phone: '', service: 'Лимфен дренаж 60 мин' },
];

function demoAppointments(dateISO, defaultCountryCode = '359') {
  return PEOPLE.map((person, index) => {
    const hour = String(9 + index * 2).padStart(2, '0');
    const phone = normalizePhone(person.phone, defaultCountryCode);
    return {
      id: `demo-${dateISO}-${index}`,
      start: `${dateISO}T${hour}:00:00`,
      end: `${dateISO}T${String(Number(hour) + 1).padStart(2, '0')}:00:00`,
      customerName: person.name,
      customerKey: `demo-cust-${index}`,
      email: null,
      phoneRaw: person.phone,
      phone: phone.e164,
      phoneValid: phone.valid,
      phoneProblem: phone.reason,
      service: person.service,
      staff: 'Демо',
      label: '',
      comment: '',
    };
  });
}

module.exports = { demoAppointments };
