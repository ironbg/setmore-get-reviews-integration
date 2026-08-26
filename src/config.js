'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = process.env.SETMORE_REVIEW_CONFIG || path.join(ROOT, 'config.json');
const EXAMPLE_PATH = path.join(ROOT, 'config.example.json');

const DEFAULTS = {
  studioName: 'Моето студио',
  googleReviewLink: '',
  defaultCountryCode: '359',
  timezone: 'Europe/Sofia',
  port: 4321,
  setmore: {
    // По избор: попълва се само ако имаш платен Setmore Pro с достъп до API.
    refreshToken: '',
    baseUrl: 'https://developer.setmore.com/api/v1',
    tokenPath: '/o/oauth2/token',
    appointmentsPath: '/bookingapi/appointments',
  },
  // Първият шаблон е този по подразбиране; останалите се избират от падащо меню.
  templates: [
    {
      id: 'topalo',
      name: 'Топло и лично',
      text: 'Здравейте, {име}! 🌿 Благодарим Ви, че ни се доверихте днес в {студио}. Ако сте останали доволни, ще се радваме много на кратък отзив в Google — отнема по-малко от минута и помага на други хора да ни намерят: {линк}\n\nБлагодарим Ви и до нови срещи!',
    },
    {
      id: 'kratko',
      name: 'Кратко',
      text: 'Здравейте, {име}! Беше ни приятно да Ви посрещнем в {студио}. Ще ни зарадвате с отзив в Google: {линк} 🙏',
    },
    {
      id: 'oficialno',
      name: 'Официално',
      text: 'Здравейте, {име},\n\nБлагодарим Ви за посещението в {студио}. Вашето мнение е важно за нас — ако отделите минута за отзив в Google, ще ни помогнете много: {линк}\n\nПоздрави,\n{студио}',
    },
  ],
};

/** Прост дълбок merge — потребителският config допълва, а не заменя изцяло. */
function merge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = merge(base ? base[key] : undefined, value);
  }
  return out;
}

let cached = null;

function loadConfig({ reload = false } = {}) {
  if (cached && !reload) return cached;

  let fromFile = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      throw new Error(`Файлът ${CONFIG_PATH} не е валиден JSON: ${err.message}`);
    }
  }

  const config = merge(DEFAULTS, fromFile);

  // Променливите на средата бият файла — удобно при хостинг.
  if (process.env.SETMORE_REFRESH_TOKEN) config.setmore.refreshToken = process.env.SETMORE_REFRESH_TOKEN;
  if (process.env.GOOGLE_REVIEW_LINK) config.googleReviewLink = process.env.GOOGLE_REVIEW_LINK;
  if (process.env.STUDIO_NAME) config.studioName = process.env.STUDIO_NAME;
  if (process.env.PORT) config.port = Number(process.env.PORT);

  // Платеното Setmore API е по избор — основният път е импорт на експорт.
  config.hasApi = Boolean(config.setmore.refreshToken);
  config.configPath = CONFIG_PATH;
  config.examplePath = EXAMPLE_PATH;

  cached = config;
  return config;
}

/** Само това, което е безопасно да стигне до браузъра — без токени. */
function publicConfig(config) {
  return {
    studioName: config.studioName,
    googleReviewLink: config.googleReviewLink,
    defaultCountryCode: config.defaultCountryCode,
    timezone: config.timezone,
    templates: config.templates,
    hasApi: config.hasApi,
  };
}

module.exports = { loadConfig, publicConfig, DEFAULTS, CONFIG_PATH };
