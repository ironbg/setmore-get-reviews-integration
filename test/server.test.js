'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Хранилището чете пътя си при първото зареждане, затова средата се готви преди require.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'setmore-review-test-'));
process.env.SETMORE_REVIEW_DATA = TMP;

const { createServer } = require('../src/server');
const { loadConfig } = require('../src/config');

const config = loadConfig();
const server = createServer(config);

test.before(() => new Promise((resolve) => server.listen(0, resolve)));
test.after(() => {
  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${server.address().port}`;

test('/api/config не издава токени', async () => {
  const res = await fetch(`${base()}/api/config`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.ok(Array.isArray(body.templates));
  assert.match(body.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal('setmore' in body, false, 'настройките на Setmore не бива да излизат навън');
  assert.equal(JSON.stringify(body).includes('refreshToken'), false);
});

test('/api/appointments връща часове и предупреждава за демо режим', async () => {
  const res = await fetch(`${base()}/api/appointments?from=2026-08-26&to=2026-08-26`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.from, '2026-08-26');
  assert.ok(body.count > 0);
  assert.ok(body.warning, 'без токен трябва да има предупреждение за демо данни');
  assert.ok(body.appointments.every((a) => 'phone' in a && 'sent' in a));
});

test('невалидна дата се подменя с днешната, вместо да чупи заявката', async () => {
  const res = await fetch(`${base()}/api/appointments?from=утре`);
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.match(body.from, /^\d{4}-\d{2}-\d{2}$/);
});

test('отбелязването като изпратено се запазва и се отменя', async () => {
  const id = 'demo-2026-08-26-0';

  const marked = await fetch(`${base()}/api/sent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, channel: 'viber' }),
  }).then((r) => r.json());
  assert.equal(marked.sent.channel, 'viber');

  const listed = await fetch(`${base()}/api/appointments?from=2026-08-26`).then((r) => r.json());
  assert.equal(listed.appointments.find((a) => a.id === id).sent.channel, 'viber');

  await fetch(`${base()}/api/sent`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });

  const after = await fetch(`${base()}/api/appointments?from=2026-08-26`).then((r) => r.json());
  assert.equal(after.appointments.find((a) => a.id === id).sent, null);
});

test('отбелязване без id връща грешка, а не срив', async () => {
  const res = await fetch(`${base()}/api/sent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'viber' }),
  });
  assert.equal(res.status, 500);
  assert.ok((await res.json()).error);
});

test('таблото се сервира', async () => {
  const res = await fetch(`${base()}/`);
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('Покани за Google ревю'));
});

test('файлове извън public/ не се сервират', async () => {
  const res = await fetch(`${base()}/../src/config.js`);
  assert.ok(res.status === 403 || res.status === 404, `неочакван статус ${res.status}`);
  assert.equal((await res.text()).includes('refreshToken'), false);
});

test('непознат endpoint връща 404 в JSON', async () => {
  const res = await fetch(`${base()}/api/няма-такова`);
  assert.equal(res.status, 404);
  assert.ok((await res.json()).error);
});
