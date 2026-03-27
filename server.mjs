import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import webPush from 'web-push';

const port = 8000;
const root = process.cwd();
const vapidPath = join(root, 'vapid.json');
const subscriptionsPath = join(root, 'subscriptions.json');
const settingsPath = join(root, 'push-settings.json');
const defaultSettings = {
  enabled: false,
  intervalMinutes: 60,
  lastSentAt: null,
};

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

let vapidKeys = null;
let subscriptions = [];
let settings = { ...defaultSettings };

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function loadJson(filePath, fallback) {
  try {
    const text = await readFile(filePath, 'utf8');
    return safeJsonParse(text, fallback);
  } catch {
    return fallback;
  }
}

async function saveJson(filePath, value) {
  await writeFile(filePath, JSON.stringify(value, null, 2));
}

async function ensureVapidKeys() {
  if (vapidKeys) {
    return vapidKeys;
  }

  if (existsSync(vapidPath)) {
    vapidKeys = await loadJson(vapidPath, null);
  }

  if (!vapidKeys || !vapidKeys.publicKey || !vapidKeys.privateKey) {
    vapidKeys = webPush.generateVAPIDKeys();
    await saveJson(vapidPath, vapidKeys);
  }

  webPush.setVapidDetails('mailto:zoey@example.com', vapidKeys.publicKey, vapidKeys.privateKey);
  return vapidKeys;
}

async function loadPersistentData() {
  subscriptions = await loadJson(subscriptionsPath, []);
  settings = { ...defaultSettings, ...(await loadJson(settingsPath, {})) };
  await ensureVapidKeys();
}

async function saveSubscriptions() {
  await saveJson(subscriptionsPath, subscriptions);
}

async function saveSettings() {
  await saveJson(settingsPath, settings);
}

async function sendPayloadToSubscriptions(payload) {
  if (!subscriptions.length) {
    return;
  }

  const validSubscriptions = [];

  await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await webPush.sendNotification(subscription, payload);
      validSubscriptions.push(subscription);
    } catch (error) {
      const statusCode = error?.statusCode;
      if (statusCode !== 404 && statusCode !== 410) {
        validSubscriptions.push(subscription);
      }
    }
  }));

  subscriptions = validSubscriptions;
  await saveSubscriptions();
}

async function schedulePush(payload, delayMs = 0) {
  setTimeout(() => {
    sendPayloadToSubscriptions(payload).catch((error) => {
      console.error('Failed to send push notification:', error);
    });
  }, Math.max(0, delayMs));
}

async function maybeSendReminder() {
  if (!settings.enabled || !subscriptions.length) {
    return;
  }

  const intervalMs = settings.intervalMinutes * 60 * 1000;
  const lastSentAt = settings.lastSentAt ? new Date(settings.lastSentAt).getTime() : 0;
  const elapsed = Date.now() - lastSentAt;

  if (lastSentAt && elapsed < intervalMs) {
    return;
  }

  const reminders = [
    { title: 'Time to hydrate, Zoey! 💧', body: "Don't forget your water, beautiful 🌸" },
    { title: 'Hey Zoey! 🌊', body: 'Your body is thirsty, take a sip!' },
    { title: 'Hydration check! 💙', body: 'Take a quick sip and keep going.' },
    { title: 'Water break time! 🥤', body: 'Stay refreshed, Zoey!' },
  ];
  const pick = reminders[Math.floor(Math.random() * reminders.length)];
  const payload = JSON.stringify({
    title: pick.title,
    body: pick.body,
    icon: '/logo.png',
  });

  settings.lastSentAt = new Date().toISOString();
  await saveSettings();
  await sendPayloadToSubscriptions(payload);
}

await loadPersistentData();
setInterval(() => {
  maybeSendReminder().catch((error) => {
    console.error('Reminder scheduler error:', error);
  });
}, 60 * 1000);

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/vapid-public-key') {
      const { publicKey } = await ensureVapidKeys();
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ publicKey }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/subscribe') {
      const body = await readRequestBody(req);
      const subscription = safeJsonParse(body, null);
      if (!subscription || !subscription.endpoint) {
        res.writeHead(400, { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Invalid subscription' }));
        return;
      }

      subscriptions = subscriptions.filter((item) => item.endpoint !== subscription.endpoint);
      subscriptions.push(subscription);
      await saveSubscriptions();

      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const body = safeJsonParse(await readRequestBody(req), {});
      const nextInterval = Number.isFinite(body.intervalMinutes) ? Math.max(1, body.intervalMinutes) : settings.intervalMinutes;
      const nextEnabled = Boolean(body.enabled);
      const intervalChanged = nextInterval !== settings.intervalMinutes;

      settings.intervalMinutes = nextInterval;
      settings.enabled = nextEnabled;
      if (nextEnabled && (intervalChanged || !settings.lastSentAt)) {
        settings.lastSentAt = new Date().toISOString();
      }
      if (!nextEnabled) {
        settings.lastSentAt = settings.lastSentAt || null;
      }

      await saveSettings();
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/send-test') {
      const body = safeJsonParse(await readRequestBody(req), {});
      const delayMs = Number.isFinite(body.delayMs) ? body.delayMs : 0;
      const payload = JSON.stringify({
        title: body.title || 'Test push sent 💧',
        body: body.body || 'Lock the phone now to check if it arrives.',
        icon: body.icon || '/logo.png',
      });

      await schedulePush(payload, delayMs);
      res.writeHead(202, { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, scheduledInMs: delayMs }));
      return;
    }

    if (req.method === 'GET') {
      const requestPath = url.pathname === '/' ? '/index.html' : url.pathname;
      const safePath = normalize(requestPath).replace(/^([.]{2}[\\/])+/, '');
      const filePath = join(root, safePath);
      const data = await readFile(filePath);
      const type = contentTypes[extname(filePath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type });
      res.end(data);
      return;
    }

    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
  } catch (error) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}).listen(port, () => {
  console.log(`Zoey's Hydration is running at http://localhost:${port}`);
});

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}