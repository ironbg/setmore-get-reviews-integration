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

/** Празен низ, ако в източника няма час — по-добре нищо, отколкото фалшиво 00:00. */
function formatTime(start) {
  if (!start || !String(start).includes('T')) return '';
  const date = new Date(start);
  if (Number.isNaN(date.getTime())) return String(start).slice(11, 16);
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
  const params = new URLSearchParams();
  if (el('fromDate').value) params.set('from', el('fromDate').value);
  if (el('toDate').value) params.set('to', el('toDate').value);

  el('statusLine').textContent = 'Зареждане…';
  el('list').innerHTML = '';

  try {
    const data = await api(`/api/appointments?${params}`);
    state.appointments = data.appointments;
    state.source = data.source;

    const badge = el('sourceBadge');
    badge.hidden = data.source === 'import';
    badge.textContent = data.source === 'demo' ? 'демо данни' : data.source === 'api' ? 'от Setmore API' : '';

    el('statusLine').textContent = data.warning
      ? `${data.count} ${data.count === 1 ? 'клиент' : 'клиента'} · ${data.warning}`
      : `${data.count} ${data.count === 1 ? 'клиент' : 'клиента'} в избрания период`;
    render();
  } catch (err) {
    el('statusLine').textContent = `Не успях да заредя списъка: ${err.message}`;
  }
}

/* ------------------------------ импорт ------------------------------ */

async function sendImport(text, source) {
  const message = el('importMsg');
  message.hidden = false;
  message.textContent = 'Обработвам…';

  try {
    const data = await api('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, source, fallbackDate: el('fallbackDate').value || null }),
    });

    const parts = [`Заредени ${data.count} ${data.count === 1 ? 'клиент' : 'клиента'}.`];
    if (data.skipped) parts.push(`${data.skipped} реда бяха пропуснати (без име и телефон).`);
    if (data.warnings && data.warnings.length) parts.push(...data.warnings);
    message.textContent = parts.join(' ');

    await refreshImportState();
    setRange('all');
  } catch (err) {
    message.textContent = `Не се получи: ${err.message}`;
  }
}

async function refreshImportState() {
  state.config = await api('/api/config');

  const hasImport = state.config.hasImport;
  el('importState').hidden = !hasImport;
  el('importForm').hidden = hasImport;

  if (hasImport) {
    const when = new Date(state.config.importedAt).toLocaleString('bg-BG', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
    el('importSummary').textContent = `Списъкът е зареден на ${when}.`;
  }
}

async function setSent(appointment, channel) {
  try {
    const data = await api('/api/sent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: appointment.id,
        channel,
        phone: appointment.phone,
        name: appointment.customerName,
      }),
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
  item.className = 'card' + (appointment.sent || appointment.lastInvite ? ' is-sent' : '');

  const head = document.createElement('div');
  head.className = 'card-head';

  const name = document.createElement('span');
  name.className = 'card-name';
  name.textContent = appointment.customerName;

  const time = formatTime(appointment.start);
  if (time) {
    const timeNode = document.createElement('span');
    timeNode.className = 'card-time';
    timeNode.textContent = time;
    head.append(timeNode);
  }
  head.append(name);

  // Показваме и покана, пратена по друг повод на същия телефон — един клиент
  // не бива да получава втора молба за отзив.
  const invite = appointment.sent || appointment.lastInvite;
  if (invite) {
    const note = document.createElement('span');
    note.className = 'sent-note';
    const when = new Date(invite.at).toLocaleDateString('bg-BG', { day: 'numeric', month: 'short', year: 'numeric' });
    note.textContent = appointment.sent ? `✓ поканен(а) на ${when}` : `вече е канен(а) на ${when}`;
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
  const visible = state.appointments.filter((a) => !(hideSent && (a.sent || a.lastInvite)));

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
    all: ['', ''],
    today: [today, today],
    yesterday: [shiftDays(today, -1), shiftDays(today, -1)],
    week: [shiftDays(today, -6), today],
  };
  const [from, to] = ranges[range] || ranges.all;
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

  el('importBtn').addEventListener('click', () => {
    const text = el('pasteArea').value.trim();
    if (!text) {
      el('importMsg').hidden = false;
      el('importMsg').textContent = 'Залепи редовете или избери файл.';
      return;
    }
    sendImport(text, 'paste');
  });

  el('fileInput').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => sendImport(String(reader.result), file.name);
    reader.onerror = () => {
      el('importMsg').hidden = false;
      el('importMsg').textContent = 'Файлът не можа да бъде прочетен.';
    };
    reader.readAsText(file, 'utf-8');
  });

  el('clearImportBtn').addEventListener('click', async () => {
    await api('/api/import', { method: 'DELETE' });
    el('pasteArea').value = '';
    el('fileInput').value = '';
    el('importMsg').hidden = true;
    await refreshImportState();
    loadAppointments();
  });

  applyTemplate(0);
  await refreshImportState();
  setRange('all');
}

init().catch((err) => {
  el('statusLine').textContent = `Приложението не стартира: ${err.message}`;
});
