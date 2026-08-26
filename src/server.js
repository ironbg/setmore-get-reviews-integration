'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const { loadConfig, publicConfig } = require('./config');
const { SetmoreClient } = require('./setmore');
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

function readBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('Заявката е твърде голяма.'));
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

/** Валидира "2026-08-26" и връща днешната дата, ако липсва. */
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

function createServer(config = loadConfig()) {
  const client = new SetmoreClient(config);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const { pathname } = url;

    try {
      if (pathname === '/api/config' && req.method === 'GET') {
        return sendJson(res, 200, { ...publicConfig(config), today: todayISO(config.timezone) });
      }

      if (pathname === '/api/appointments' && req.method === 'GET') {
        const today = todayISO(config.timezone);
        const from = parseDate(url.searchParams.get('from'), today);
        const to = parseDate(url.searchParams.get('to'), from);

        let appointments;
        let warning = null;

        if (config.demoMode) {
          appointments = demoAppointments(from, config.defaultCountryCode);
          warning = 'Демо режим: това са примерни данни. Добави refreshToken в config.json за истинските си часове.';
        } else {
          appointments = await client.getAppointments(from, to);
        }

        const sent = store.getSentMap();
        const withStatus = appointments
          .map((appointment) => ({ ...appointment, sent: sent[appointment.id] || null }))
          .sort((a, b) => String(a.start).localeCompare(String(b.start)));

        return sendJson(res, 200, { from, to, count: withStatus.length, warning, appointments: withStatus });
      }

      if (pathname === '/api/sent' && req.method === 'POST') {
        const body = await readBody(req);
        const record = store.markSent(body.id, body.channel, body.note);
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
    console.log('');
    console.log(`  ✅  Таблото е пуснато: http://localhost:${config.port}`);
    if (config.demoMode) {
      console.log('  ⚠️   Демо режим — липсва Setmore refreshToken в config.json.');
    }
    if (!config.googleReviewLink) {
      console.log('  ⚠️   Липсва googleReviewLink в config.json — съобщенията ще са без линк.');
    }
    console.log('');
  });
}

module.exports = { createServer, todayISO, parseDate };
