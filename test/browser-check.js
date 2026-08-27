'use strict';

/**
 * Проверка на разширението в истински браузър.
 *
 * Не влиза в `npm test`, защото иска Playwright, а проектът нарочно няма
 * зависимости. Пуска се на ръка при промяна по разширението:
 *
 *   npm install --no-save playwright
 *   node test/browser-check.js
 *
 * Скриптът зарежда файловете на разширението в страниците от test/fixtures/,
 * подменя chrome.storage с негово подобие и проверява какво се случва —
 * там ли влиза лентата, кой клиент разчита, помни ли поканите.
 */

const fs = require('node:fs');
const path = require('node:path');

const EXTENSION_DIR = path.join(__dirname, '..', 'extension');
const FIXTURES = path.join(__dirname, 'fixtures');
const SCRIPTS = ['shared.js', 'storage.js', 'detect.js', 'content.js'];

const SETTINGS = {
  studioName: 'Студио Релакс',
  googleReviewLink: 'https://g.page/r/TEST/review',
  defaultCountryCode: '359',
};

/**
 * Подобие на chrome.storage, което помни в самата страница.
 *
 * Имената са с представка __gr, защото тук stub-ът дели глобалния обхват със
 * скриптовете на разширението. В Chrome това не е проблем — content script-овете
 * работят в отделен свят и не виждат променливите на страницата.
 */
const storageStub = `
window.__sync = window.__sync || {};
window.__local = window.__local || {};
const __grSettings = ${JSON.stringify(SETTINGS)};

const read = (bag) => async (keys) => {
  if (keys && !Array.isArray(keys) && typeof keys === 'object') return { ...keys, ...__grSettings };
  const list = keys == null ? Object.keys(bag) : Array.isArray(keys) ? keys : [keys];
  const out = {};
  for (const key of list) if (key in bag) out[key] = JSON.parse(JSON.stringify(bag[key]));
  return out;
};
const write = (bag) => async (items) => { Object.assign(bag, JSON.parse(JSON.stringify(items))); };

window.chrome = {
  storage: {
    sync: { get: read(window.__sync), set: write(window.__sync) },
    local: { get: read(window.__local), set: write(window.__local) },
    onChanged: { addListener: () => {} },
  },
};

// Бутоните отварят чат — в проверка това само би отворило празни раздели.
window.open = () => null;
`;

async function openFixture(browser, fixture, { restore = null } = {}) {
  const page = await browser.newPage({ viewport: { width: 1150, height: 700 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });

  await page.goto(`file://${path.join(FIXTURES, fixture)}`);

  if (restore) {
    await page.addScriptTag({
      content: `window.__sync = ${JSON.stringify(restore.sync)}; window.__local = ${JSON.stringify(restore.local)};`,
    });
  }

  await page.addScriptTag({ content: storageStub });
  await page.addStyleTag({ content: fs.readFileSync(path.join(EXTENSION_DIR, 'content.css'), 'utf8') });
  for (const file of SCRIPTS) {
    await page.addScriptTag({ content: fs.readFileSync(path.join(EXTENSION_DIR, file), 'utf8') });
  }

  await page.waitForTimeout(400);
  page.grErrors = errors;
  if (errors.length && process.env.GR_DEBUG) console.error('  [грешки]', errors);
  return page;
}

/** Отваря час, без да се блъска в прозореца, който го покрива. */
async function openAppointment(page, selector) {
  await page.locator(selector).dispatchEvent('click');
  await page.waitForTimeout(700);
}

const results = [];

function check(name, actual, expected) {
  const ok = String(actual) === String(expected);
  results.push({ ok, name, actual, expected });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : `  →  очаквах ${expected}, получих ${actual}`}`);
}

async function run() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.error('Липсва Playwright. Пусни: npm install --no-save playwright');
    process.exit(1);
  }

  const executablePath = process.env.CHROMIUM_PATH;
  const browser = await chromium.launch(executablePath ? { executablePath } : {});

  console.log('\nИстинската структура на Setmore (data-testid)');
  {
    const page = await openFixture(browser, 'fake-setmore-real.html');
    await openAppointment(page, '.slot[data-open="1"]');

    check('лентата е под футъра, в прозореца', await page.locator('.gr-row').count(), 1);
    check('нищо не влиза в лявото меню', await page.locator('.sc-pane .gr-row').count(), 0);
    check(
      'разчита правилния клиент',
      await page.evaluate(() => document.querySelector('.gr-row').dataset.grFor),
      '+359888123456|Мария Янкова'
    );

    await openAppointment(page, '.slot[data-open="2"]');
    check(
      'при друг час лентата се обновява',
      await page.evaluate(() => document.querySelector('.gr-row').dataset.grFor),
      '+359899554433|Петър Колев'
    );
    check('лентата не се дублира', await page.locator('.gr-row').count(), 1);

    // Прозорецът на Setmore е тесен. Първоначално лентата стоеше във футъра,
    // който не пренася на нов ред, и излизаше извън картата — оттук проверката.
    const overflow = await page.evaluate(() => {
      const card = document.querySelector('.widget').getBoundingClientRect();
      const row = document.querySelector('.gr-row').getBoundingClientRect();
      return {
        наляво: Math.round(card.left - row.left),
        надясно: Math.round(row.right - card.right),
        надолу: Math.round(row.bottom - card.bottom),
      };
    });
    check('не излиза наляво от прозореца', overflow.наляво <= 0, true);
    check('не излиза надясно от прозореца', overflow.надясно <= 0, true);
    check('не излиза под прозореца', overflow.надолу <= 0, true);

    check('без грешки в конзолата', page.grErrors.length, 0);
    await page.close();
  }

  console.log('\nПамет за изпратените покани');
  let saved;
  {
    const page = await openFixture(browser, 'fake-setmore-real.html');
    await openAppointment(page, '.slot[data-open="1"]');

    check('преди изпращане няма отметка', await page.locator('.gr-row-note-done').count(), 0);
    await page.click('.gr-pill-wa');
    await page.waitForTimeout(700);
    check('след изпращане се появява отметка', await page.locator('.gr-row-note-done').count(), 1);
    check(
      'клиентът е запомнен',
      await page.evaluate(() => Object.keys(window.__local.gr_clients || {}).length),
      1
    );

    saved = await page.evaluate(() => ({ sync: window.__sync, local: window.__local }));
    await page.close();
  }
  {
    // Нов браузър със същите синхронизирани данни — както след преинсталация.
    const page = await openFixture(browser, 'fake-setmore-real.html', { restore: saved });
    await openAppointment(page, '.slot[data-open="1"]');
    check('поканата преживява нов сеанс', await page.locator('.gr-row-note-done').count(), 1);

    await openAppointment(page, '.slot[data-open="2"]');
    check('друг клиент не е отбелязан', await page.locator('.gr-row-note-done').count(), 0);
    await page.close();
  }

  console.log('\nОтмяна на отметка и „не изпращай“');
  {
    const page = await openFixture(browser, 'fake-setmore-real.html');
    await openAppointment(page, '.slot[data-open="1"]');

    // Отметката се слага при натискане, а не при реално изпращане — затова
    // трябва да може да се махне.
    await page.click('.gr-pill-wa');
    await page.waitForTimeout(600);
    check('отметката се появява', await page.locator('.gr-row-note-done').count(), 1);

    await page.click('.gr-pill-ghost');
    await page.waitForTimeout(300);
    await page.click('#gr-undo');
    await page.waitForTimeout(600);
    check('отметката може да се махне', await page.locator('.gr-row-note-done').count(), 0);

    // „Не изпращай“ спира бутоните.
    await page.click('#gr-block');
    await page.waitForTimeout(600);
    check('появява се знак „не изпращай“', await page.locator('.gr-row.gr-blocked').count(), 1);
    check('WhatsApp е спрян', await page.locator('.gr-row .gr-pill-wa').isDisabled(), true);
    check('Viber е спрян', await page.locator('.gr-row .gr-pill-vb').isDisabled(), true);

    const kept = await page.evaluate(() => ({ sync: window.__sync, local: window.__local }));
    await page.close();

    const again = await openFixture(browser, 'fake-setmore-real.html', { restore: kept });
    await openAppointment(again, '.slot[data-open="1"]');
    check('„не изпращай“ преживява нов сеанс', await again.locator('.gr-row.gr-blocked').count(), 1);

    await again.click('.gr-pill-ghost');
    await again.waitForTimeout(300);
    await again.click('#gr-block');
    await again.waitForTimeout(600);
    check('клиентът може да се върне обратно', await again.locator('.gr-row.gr-blocked').count(), 0);
    await again.close();
  }

  console.log('\nРезервен път: без data-testid, с ляво меню');
  {
    const page = await openFixture(browser, 'fake-setmore-hard.html');
    await openAppointment(page, '#slot');

    check('лентата е в прозореца', await page.locator('.sc-xyz .gr-bar').count(), 1);
    check('нищо не влиза в менюто', await page.locator('.sc-pane .gr-bar').count(), 0);
    check(
      'взет е телефонът на клиента, не на студиото',
      await page.evaluate(() => document.querySelector('.gr-bar').dataset.grFor),
      '+359877221100|Десислава Илиева'
    );
    await page.close();
  }

  console.log('\nРезервен път: вградена рамка (iframe)');
  {
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.goto(`file://${path.join(FIXTURES, 'fake-setmore-iframe.html')}`);

    for (const frame of page.frames()) {
      await frame.addScriptTag({ content: storageStub });
      await frame.addStyleTag({ content: fs.readFileSync(path.join(EXTENSION_DIR, 'content.css'), 'utf8') });
      for (const file of SCRIPTS) {
        await frame.addScriptTag({ content: fs.readFileSync(path.join(EXTENSION_DIR, file), 'utf8') });
      }
    }
    await page.waitForTimeout(400);

    const inner = page.frames().find((frame) => frame !== page.mainFrame());
    await inner.locator('.slot[data-open="1"]').dispatchEvent('click');
    await page.waitForTimeout(700);

    check('лентата влиза и вътре в рамката', await inner.locator('.gr-bar, .gr-row').count(), 1);
    check('плаващият бутон е само в основната рамка', await inner.locator('#gr-launcher').count(), 0);
    await page.close();
  }

  await browser.close();

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length} от ${results.length} проверки минаха.\n`);
  process.exit(failed.length ? 1 : 0);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
