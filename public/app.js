'use strict';

/**
 * Табло: избираш период, избираш текст, натискаш WhatsApp или Viber
 * до конкретния клиент. Изпращането става в самото приложение —
 * тук само подготвяме готово съобщение и отваряме чата.
 */

const state = {
  config: null,
  appointments: [],
  template: '',
};

const el = (id) => document.getElementById(id);

/* ------------------------------ помощни ------------------------------ */

function isoDate(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function shiftDays(isoString, days) {
  const date = new Date(isoString + 'T12:00:00');
  date.setDate(date.getDate() + days);
  return isoDate(date);
}

function formatTime(start) {
  if (!start) return '--:--';
  const date = new Date(start);
  if (Number.isNaN(date.getTime())) return String(start).slice(11, 16) || '--:--';
  return date.toLocaleTimeString('bg-BG', { hour: '2-digit', minute: '2-digit' });
}

function formatDay(start) {
  if (!start) return '';
  const date = new Date(start);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('bg-BG', { day: 'numeric', month: 'short' });
}

function firstName(fullName) {
  const clean = String(fullName || '').trim().replace(/\s+/g, ' ');
  return clean ? clean.split(' ')[0] : '';
}

/** Същите плейсхолдъри като в src/message.js, но от страна на браузъра. */
function renderTemplate(template, vars) {
  const values = {
    'име': firstName(vars.name),
    'пълно име': vars.name || '',
    'студио': vars.studio || '',
    'линк': vars.link || '',
    'услуга': vars.service || '',
    'дата': vars.date || '',
    'час': vars.time || '',
    name: firstName(vars.name),
    fullname: vars.name || '',
    studio: vars.studio || '',
    link: vars.link || '',
    service: vars.service || '',
    date: vars.date || '',
    time: vars.time || '',
  };
  return String(template || '').replace(/\{([^{}]+)\}/g, (match, key) => {
    const normalized = key.trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(values, normalized) ? values[normalized] : match;
  });
}

function messageFor(appointment) {
  return renderTemplate(state.template, {
    name: appointment.customerName,
    studio: state.config.studioName,
    link: state.config.googleReviewLink,
    service: appointment.service,
    date: formatDay(appointment.start),
    time: formatTime(appointment.start),
  });
}

let toastTimer = null;
function toast(text) {
  const node = el('toast');
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // clipboard API иска HTTPS или localhost; старият път работи навсякъде.
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  }
}

/* ------------------------------ данни ------------------------------ */

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Грешка ${res.status}`);
  return data;
}

async function loadAppointments() {
  const from = el('fromDate').value;
  const to = el('toDate').value || from;
  el('statusLine').textContent = 'Зареждане…';
  el('list').innerHTML = '';

  try {
    const data = await api(`/api/appointments?from=${from}&to=${to}`);
    state.appointments = data.appointments;
    el('statusLine').textContent = data.warning
      ? `${data.count} часа · ${data.warning}`
      : `${data.count} ${data.count === 1 ? 'час' : 'часа'} в избрания период`;
    render();
  } catch (err) {
    el('statusLine').textContent = `Не успях да заредя часовете: ${err.message}`;
  }
}

async function setSent(appointment, channel) {
  try {
    const data = await api('/api/sent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: appointment.id, channel }),
    });
    appointment.sent = data.sent;
  } catch (err) {
    toast(`Не можах да отбележа: ${err.message}`);
  }
  render();
}

async function clearSent(appointment) {
  try {
    await api('/api/sent', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: appointment.id }),
    });
    appointment.sent = null;
  } catch (err) {
    toast(`Не можах да отменя: ${err.message}`);
  }
  render();
}

/* ------------------------------ изпращане ------------------------------ */

function openWhatsApp(appointment) {
  const digits = String(appointment.phone || '').replace(/\D/g, '');
  const url = `https://wa.me/${digits}?text=${encodeURIComponent(messageFor(appointment))}`;
  window.open(url, '_blank', 'noopener');
  setSent(appointment, 'whatsapp');
}

async function openViber(appointment) {
  // Viber не приема готов текст при отваряне на чат, затова първо копираме.
  const copied = await copyText(messageFor(appointment));
  window.location.href = `viber://chat?number=${encodeURIComponent(appointment.phone)}`;
  toast(copied
    ? 'Текстът е копиран — залепи го във Viber и натисни изпрати.'
    : 'Viber се отваря. Копирай текста с бутона „Копирай“.');
  setSent(appointment, 'viber');
}

/* ------------------------------ рисуване ------------------------------ */

function appointmentCard(appointment) {
  const item = document.createElement('li');
  item.className = 'card' + (appointment.sent ? ' is-sent' : '');

  const head = document.createElement('div');
  head.className = 'card-head';

  const time = document.createElement('span');
  time.className = 'card-time';
  time.textContent = formatTime(appointment.start);

  const name = document.createElement('span');
  name.className = 'card-name';
  name.textContent = appointment.customerName;

  head.append(time, name);

  if (appointment.sent) {
    const note = document.createElement('span');
    note.className = 'sent-note';
    const when = new Date(appointment.sent.at).toLocaleDateString('bg-BG', { day: 'numeric', month: 'short' });
    note.textContent = `✓ поканен(а) на ${when}`;
    head.append(note);
  }

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  meta.textContent = [formatDay(appointment.start), appointment.service, appointment.phone || appointment.phoneRaw]
    .filter(Boolean)
    .join(' · ');

  item.append(head, meta);

  if (!appointment.phoneValid) {
    const problem = document.createElement('p');
    problem.className = 'no-phone';
    problem.textContent = `Няма използваем телефон (${appointment.phoneProblem || 'непознат формат'}). Добави го в Setmore и презареди.`;
    item.append(problem);
    return item;
  }

  const actions = document.createElement('div');
  actions.className = 'actions';

  const whatsapp = document.createElement('button');
  whatsapp.type = 'button';
  whatsapp.className = 'btn btn-whatsapp';
  whatsapp.textContent = 'WhatsApp';
  whatsapp.addEventListener('click', () => openWhatsApp(appointment));

  const viber = document.createElement('button');
  viber.type = 'button';
  viber.className = 'btn btn-viber';
  viber.textContent = 'Viber';
  viber.addEventListener('click', () => openViber(appointment));

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn btn-ghost';
  copy.textContent = 'Копирай';
  copy.addEventListener('click', async () => {
    const ok = await copyText(messageFor(appointment));
    toast(ok ? 'Съобщението е копирано.' : 'Копирането не се получи — маркирай текста горе.');
  });

  actions.append(whatsapp, viber, copy);

  const undo = document.createElement('button');
  undo.type = 'button';
  undo.className = 'btn btn-ghost';
  if (appointment.sent) {
    undo.textContent = 'Отбележи като неизпратено';
    undo.addEventListener('click', () => clearSent(appointment));
  } else {
    undo.textContent = 'Отбележи като изпратено';
    undo.addEventListener('click', () => setSent(appointment, 'manual'));
  }
  actions.append(undo);

  item.append(actions);
  return item;
}

function render() {
  const list = el('list');
  list.innerHTML = '';

  const hideSent = el('hideSent').checked;
  const visible = state.appointments.filter((a) => !(hideSent && a.sent));

  if (visible.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = state.appointments.length
      ? 'Всички клиенти от този период вече са поканени.'
      : 'Няма часове в избрания период.';
    list.append(empty);
  } else {
    visible.forEach((appointment) => list.append(appointmentCard(appointment)));
  }

  const sample = state.appointments[0];
  el('previewText').textContent = messageFor(
    sample || { customerName: 'Мария Петрова', service: 'Класически масаж', start: new Date().toISOString() }
  );
}

/* ------------------------------ старт ------------------------------ */

function setRange(range) {
  const today = state.config.today;
  const ranges = {
    today: [today, today],
    yesterday: [shiftDays(today, -1), shiftDays(today, -1)],
    week: [shiftDays(today, -6), today],
  };
  const [from, to] = ranges[range] || ranges.today;
  el('fromDate').value = from;
  el('toDate').value = to;

  document.querySelectorAll('.chip').forEach((chip) => {
    chip.setAttribute('aria-pressed', String(chip.dataset.range === range));
  });

  loadAppointments();
}

async function init() {
  state.config = await api('/api/config');

  el('studioName').textContent = `Покани за Google ревю · ${state.config.studioName}`;
  el('demoBadge').hidden = !state.config.demoMode;
  el('linkWarning').hidden = Boolean(state.config.googleReviewLink);

  const select = el('templateSelect');
  state.config.templates.forEach((template, index) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = template.name;
    select.append(option);
  });

  const applyTemplate = (index) => {
    state.template = state.config.templates[index].text;
    el('templateText').value = state.template;
    render();
  };

  select.addEventListener('change', () => applyTemplate(Number(select.value)));
  el('templateText').addEventListener('input', (event) => {
    state.template = event.target.value;
    render();
  });
  el('hideSent').addEventListener('change', render);
  el('reloadBtn').addEventListener('click', loadAppointments);
  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => setRange(chip.dataset.range));
  });

  applyTemplate(0);
  setRange('today');
}

init().catch((err) => {
  el('statusLine').textContent = `Приложението не стартира: ${err.message}`;
});
