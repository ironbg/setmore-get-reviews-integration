'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const { loadConfig, publicConfig } = require('./config');
const { SetmoreClient } = require('./setmore');
const { importRows } = require('./importer');
const { demoAppointments } = require('./demoData');
const store = require('./store');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limitBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('Файлът е твърде голям (над 8 MB).'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Тялото на заявката не е валиден JSON.'));
      }
    });

    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, relative);

  // Защита срещу "../" — файлът трябва да е вътре в public/.
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403).end('Забранено');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Няма такава страница');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/** Валидира "2026-08-26" и връща подадената резервна стойност, ако липсва. */
function parseDate(value, fallback) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return value;
  return fallback;
}

function todayISO(timezone) {
  // sv-SE дава точно YYYY-MM-DD, а timeZone гарантира, че "днес" е денят в студиото.
  try {
    return new Date().toLocaleDateString('sv-SE', { timeZone: timezone });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** Добавя към всеки ред дали вече е канен — и по този час, и по телефон изобщо. */
function withInviteStatus(appointments) {
  const sent = store.getSentMap();

  return appointments
    .map((appointment) => ({
      ...appointment,
      sent: sent[appointment.id] || null,
      lastInvite: store.lastInviteForPhone(appointment.phone),
    }))
    .sort((a, b) => String(a.start || '').localeCompare(String(b.start || '')));
}

function filterByPeriod(rows, from, to) {
  if (!from && !to) return rows;

  return rows.filter((row) => {
    // Ред без дата не се крие — иначе би изчезнал безшумно.
    if (!row.start) return true;
    const day = String(row.start).slice(0, 10);
    return (!from || day >= from) && (!to || day <= to);
  });
}

function createServer(config = loadConfig()) {
  const client = new SetmoreClient(config);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;

    try {
      if (pathname === '/api/config' && req.method === 'GET') {
        const imported = store.getImported();
        return sendJson(res, 200, {
          ...publicConfig(config),
          today: todayISO(config.timezone),
          hasImport: Boolean(imported && imported.rows && imported.rows.length),
          importedAt: imported ? imported.importedAt : null,
        });
      }

      /* Импорт на експортиран от Setmore списък — основният път без платено API. */
      if (pathname === '/api/import' && req.method === 'POST') {
        const body = await readBody(req);
        const text = String(body.text || '');

        if (!text.trim()) {
          return sendJson(res, 400, { error: 'Няма съдържание за импортиране.' });
        }

        const result = importRows(text, {
          defaultCountryCode: config.defaultCountryCode,
          fallbackDate: parseDate(body.fallbackDate, null),
        });

        if (!result.rows.length) {
          return sendJson(res, 400, {
            error: 'Не разпознах нито един клиент в този файл.',
            warnings: result.warnings,
          });
        }

        store.saveImported(result.rows, {
          source: body.source || 'paste',
          skipped: result.skipped,
          warnings: result.warnings,
        });

        return sendJson(res, 200, {
          count: result.rows.length,
          skipped: result.skipped,
          warnings: result.warnings,
          columns: result.columns,
        });
      }

      if (pathname === '/api/import' && req.method === 'DELETE') {
        store.clearImported();
        return sendJson(res, 200, { cleared: true });
      }

      if (pathname === '/api/appointments' && req.method === 'GET') {
        const from = parseDate(url.searchParams.get('from'), null);
        const to = parseDate(url.searchParams.get('to'), from);

        const imported = store.getImported();
        let appointments;
        let source;
        let warning = null;

        if (imported && imported.rows && imported.rows.length) {
          source = 'import';
          appointments = filterByPeriod(imported.rows, from, to);
          if (imported.skipped) {
            warning = `${imported.skipped} реда бяха пропуснати — нямаха нито име, нито телефон.`;
          }
        } else if (config.setmore.refreshToken) {
          source = 'api';
          const today = todayISO(config.timezone);
          appointments = await client.getAppointments(from || today, to || from || today);
        } else {
          source = 'demo';
          appointments = demoAppointments(from || todayISO(config.timezone), config.defaultCountryCode);
          warning = 'Демо режим с примерни данни. Импортирай списък от Setmore, за да видиш истинските си клиенти.';
        }

        const rows = withInviteStatus(appointments);
        return sendJson(res, 200, { from, to, source, count: rows.length, warning, appointments: rows });
      }

      if (pathname === '/api/sent' && req.method === 'POST') {
        const body = await readBody(req);
        const record = store.markSent(body.id, body.channel, { phone: body.phone, name: body.name });
        return sendJson(res, 200, { id: body.id, sent: record });
      }

      if (pathname === '/api/sent' && req.method === 'DELETE') {
        const body = await readBody(req);
        store.unmarkSent(body.id);
        return sendJson(res, 200, { id: body.id, sent: null });
      }

      if (pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'Няма такъв endpoint.' });
      }

      return serveStatic(req, res, pathname);
    } catch (err) {
      console.error('[server]', err);
      return sendJson(res, err.status === 401 || err.status === 403 ? 401 : 500, {
        error: err.message || 'Неочаквана грешка.',
      });
    }
  });
}

if (require.main === module) {
  const config = loadConfig();
  const server = createServer(config);

  server.listen(config.port, () => {
    const imported = store.getImported();
    console.log('');
    console.log(`  ✅  Таблото е пуснато: http://localhost:${config.port}`);
    if (imported && imported.rows) {
      console.log(`  📋  Зареден списък с ${imported.rows.length} клиента.`);
    } else {
      console.log('  📋  Още няма импортиран списък — качи го от самото табло.');
    }
    if (!config.googleReviewLink) {
      console.log('  ⚠️   Липсва googleReviewLink в config.json — съобщенията ще са без линк.');
    }
    console.log('');
  });
}

module.exports = { createServer, todayISO, parseDate, filterByPeriod };
