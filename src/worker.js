// calorie-bot — Cloudflare Worker: Telegram-бот + статистика открытий калькулятора (D1)
// Пути: POST /telegram (webhook бота), POST /track (отметка открытия из мини-приложения)

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};
const MSK = 3 * 3600; // время в статистике — по Москве
const now = () => Math.floor(Date.now() / 1000);
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmt = (n) => Number(n || 0).toLocaleString('ru-RU');
const isOwner = (env, u) => String(u?.id) === String(env.OWNER_ID);

const WELCOME = (name) =>
  `👋 Привет, ${esc(name)}!\n\n` +
  `Это калькулятор калорийности блюд. Добавьте продукты и их вес — ` +
  `я посчитаю калорийность всего блюда и на 100 г.\n\n` +
  `🍲 Нажмите «Калькулятор», чтобы начать.\n` +
  `Если бот оказался полезным, можно отблагодарить автора ❤️`;

const tg = (env, method, body) =>
  fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const send = (env, chat_id, text, reply_markup) =>
  tg(env, 'sendMessage', {
    chat_id, text, parse_mode: 'HTML', reply_markup,
    link_preview_options: { is_disabled: true },
  });

// Кнопки калькулятора и благодарности — web_app, чтобы страница открывалась внутри Telegram
function keyboard(env, owner) {
  const thanks = { text: '❤️ Отблагодарить' };
  if (env.SUPPORT_WEBAPP === '1') thanks.web_app = { url: env.SUPPORT_URL };
  else thanks.url = env.SUPPORT_URL;
  const rows = [[{ text: '🍲 Калькулятор', web_app: { url: env.WEBAPP_URL } }], [thanks]];
  if (owner) rows.push([{ text: '📊 Статистика', callback_data: 'stats' }]);
  return { inline_keyboard: rows };
}

// ---------- D1 ----------
async function saveUser(env, u, started) {
  await env.DB.prepare(
    `INSERT INTO users (id, username, first_name, first_seen, last_seen, started)
     VALUES (?1, ?2, ?3, ?4, ?4, ?5)
     ON CONFLICT(id) DO UPDATE SET username=?2, first_name=?3, last_seen=?4,
       started = MAX(started, ?5)`
  ).bind(u.id, u.username ?? null, u.first_name ?? null, now(), started ? 1 : 0).run();
}

async function statsText(env) {
  const t = now();
  const today = Math.floor((t + MSK) / 86400) * 86400 - MSK;
  const week = today - 6 * 86400;
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a);
  const [s, all, rep, d, w] = await env.DB.batch([
    q(`SELECT COUNT(*) c FROM users WHERE started=1`),
    q(`SELECT COUNT(DISTINCT user_id) u, COUNT(*) n FROM launches`),
    q(`SELECT COUNT(*) c FROM (SELECT 1 FROM launches GROUP BY user_id HAVING COUNT(*)>1)`),
    q(`SELECT COUNT(DISTINCT user_id) u, COUNT(*) n FROM launches WHERE ts>=?`, today),
    q(`SELECT COUNT(DISTINCT user_id) u, COUNT(*) n FROM launches WHERE ts>=?`, week),
  ]);
  const r = (x) => x.results[0] || {};
  const stamp = new Date((t + MSK) * 1000).toISOString().slice(0, 16).replace('T', ' ');
  return (
    `📊 <b>Статистика</b> (МСК, ${stamp})\n\n` +
    `🤖 Запустили бота: <b>${fmt(r(s).c)}</b>\n` +
    `🍲 Открыли калькулятор: <b>${fmt(r(all).u)}</b> чел., ${fmt(r(all).n)} открытий\n` +
    `🔁 Открывали повторно: <b>${fmt(r(rep).c)}</b> чел.\n\n` +
    `Сегодня: ${fmt(r(d).n)} открытий, ${fmt(r(d).u)} чел.\n` +
    `За 7 дней: ${fmt(r(w).n)} открытий, ${fmt(r(w).u)} чел.\n\n` +
    `<i>Ваши собственные входы не учитываются.</i>`
  );
}

// ---------- проверка подписи initData мини-приложения ----------
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
async function verifyInitData(initData, token) {
  try {
    const p = new URLSearchParams(initData);
    const hash = p.get('hash');
    if (!hash) return null;
    p.delete('hash');
    const str = [...p.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const enc = new TextEncoder();
    const secret = await hmac(enc.encode('WebAppData'), enc.encode(token));
    const sig = await hmac(secret, enc.encode(str));
    const hex = [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (hex !== hash) return null;
    return JSON.parse(p.get('user'));
  } catch {
    return null;
  }
}

// ---------- обработчики ----------
async function track(req, env) {
  const user = await verifyInitData(await req.text(), env.BOT_TOKEN);
  if (user && !isOwner(env, user)) {
    await saveUser(env, user, false);
    const t = now();
    // не считаем повторную отметку чаще раза в минуту (перезагрузка страницы)
    await env.DB.prepare(
      `INSERT INTO launches (user_id, ts)
       SELECT ?1, ?2 WHERE NOT EXISTS (SELECT 1 FROM launches WHERE user_id=?1 AND ts>?3)`
    ).bind(user.id, t, t - 60).run();
  }
  return new Response('ok', { headers: CORS });
}

async function handle(up, env) {
  if (up.callback_query) {
    const cq = up.callback_query;
    await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
    if (cq.data === 'stats' && isOwner(env, cq.from)) {
      await send(env, cq.from.id, await statsText(env));
    }
    return;
  }
  const m = up.message;
  if (!m || !m.from || m.chat.type !== 'private') return;
  const owner = isOwner(env, m.from);
  const cmd = (m.text || '').trim().split(/[\s@]/)[0].toLowerCase();

  if (cmd === '/id') return send(env, m.chat.id, `Ваш Telegram ID: <code>${m.from.id}</code>`);
  if (cmd === '/stats') {
    if (owner) await send(env, m.chat.id, await statsText(env));
    return;
  }
  if (!owner) await saveUser(env, m.from, true);
  if (cmd === '/start') return send(env, m.chat.id, WELCOME(m.from.first_name), keyboard(env, owner));
  return send(env, m.chat.id, 'Нажмите «Калькулятор» 👇', keyboard(env, owner));
}

async function telegram(req, env) {
  if (env.WEBHOOK_SECRET && req.headers.get('x-telegram-bot-api-secret-token') !== env.WEBHOOK_SECRET) {
    return new Response('forbidden', { status: 403 });
  }
  try {
    await handle(await req.json(), env);
  } catch (e) {
    console.error(e);
  }
  return new Response('ok');
}

export default {
  async fetch(req, env) {
    const { pathname } = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (req.method === 'POST' && pathname === '/track') return track(req, env);
    if (req.method === 'POST' && pathname === '/telegram') return telegram(req, env);
    return new Response('calorie-bot ok');
  },
};
