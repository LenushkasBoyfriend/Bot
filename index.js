'use strict';

const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const { plugin: collectBlock } = require('mineflayer-collectblock');
const { plugin: pvp } = require('mineflayer-pvp');
const { autoVersionForge } = require('minecraft-protocol-forge');
const wander = require('./modules/wander');
const tasks = require('./modules/tasks');
const survival = require('./modules/survival');
const config = require('./settings.json');
const express = require('express');
const http = require('http');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 5000;

let bot = null;
let activeIntervals = [];
let reconnectTimeoutId = null;
let connectionTimeoutId = null;
let isReconnecting = false;
let protocolFallbackIndex = 0;
let protocolFallbackCooldownUntil = 0;

let botState = {
  connected: false,
  lastActivity: Date.now(),
  reconnectAttempts: 0,
  startTime: Date.now(),
  errors: [],
  wasThrottled: false
};

function pushError(entry) {
  botState.errors.push(entry);
  if (botState.errors.length > 100) botState.errors = botState.errors.slice(-50);
}

// ---------------------------------------------------------------------------
// Protocol fallback (lets the bot try a couple of client versions in case the
// server hides its real version behind a queue/lobby).
// ---------------------------------------------------------------------------
function getProtocolCandidates() {
  const pf = config.server?.['protocol-fallback'];
  if (!pf?.enabled) return [config.server?.version || ''];
  const versions = Array.isArray(pf.versions) ? pf.versions.filter(Boolean) : [];
  return versions.length ? versions : [config.server?.version || ''];
}

function getCurrentProtocolVersion() {
  const candidates = getProtocolCandidates();
  return candidates[Math.min(protocolFallbackIndex, candidates.length - 1)] || '';
}

function isProtocolFailure(reason) {
  const text = String(reason || '').toLowerCase();
  const markers = config.server?.['protocol-fallback']?.['switch-on-errors'];
  if (!Array.isArray(markers) || markers.length === 0) {
    return text.includes('serverbound/minecraft:hello') || text.includes('decoderexception') || text.includes('failed to decode packet');
  }
  return markers.some(marker => text.includes(String(marker).toLowerCase()));
}

function maybeRotateProtocol(reason) {
  if (config.server?.forge?.enabled) return false; // forge modunda sürüm zaten otomatik
  const candidates = getProtocolCandidates();
  if (candidates.length < 2 || !isProtocolFailure(reason)) return false;
  const now = Date.now();
  if (now < protocolFallbackCooldownUntil) return false;
  const old = getCurrentProtocolVersion();
  protocolFallbackIndex = (protocolFallbackIndex + 1) % candidates.length;
  const next = getCurrentProtocolVersion();
  protocolFallbackCooldownUntil = now + (config.server?.['protocol-fallback']?.['cooldown-ms'] || 15000);
  console.log(`[Protocol] Compatibility fallback: ${old || 'auto'} -> ${next || 'auto'}`);
  console.log(`[Protocol] Reason: ${String(reason).slice(0, 300)}`);
  return true;
}

// ---------------------------------------------------------------------------
// Minimal keep-alive dashboard (needed for free hosts like Railway/Render).
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>${config.name}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>body{font-family:sans-serif;background:#0f172a;color:#f8fafc;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
  .card{background:#1f2937;padding:2rem;border-radius:1rem;text-align:center}</style></head>
  <body><div class="card"><h1>${config.name}</h1>
  <p id="s">...</p><p id="c"></p></div>
  <script>
  async function u(){try{const r=await fetch('/health');const d=await r.json();
  document.getElementById('s').innerText=d.status+' | uptime '+d.uptime+'s';
  document.getElementById('c').innerText=d.coords?('x:'+Math.floor(d.coords.x)+' y:'+Math.floor(d.coords.y)+' z:'+Math.floor(d.coords.z)):'...';}catch(e){}}
  setInterval(u,5000);u();
  </script></body></html>`);
});

app.get('/health', (req, res) => {
  res.json({
    status: botState.connected ? 'connected' : 'disconnected',
    uptime: Math.floor((Date.now() - botState.startTime) / 1000),
    coords: (bot && bot.entity) ? bot.entity.position : null,
    lastActivity: botState.lastActivity,
    reconnectAttempts: botState.reconnectAttempts
  });
});

app.get('/ping', (req, res) => res.send('pong'));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Server] HTTP server started on port ${server.address().port}`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const fallbackPort = PORT + 1;
    app.listen(fallbackPort, '0.0.0.0', () => console.log(`[Server] HTTP server started on fallback port ${fallbackPort}`));
  } else {
    console.log(`[Server] HTTP server error: ${err.message}`);
  }
});

const SELF_PING_INTERVAL = 10 * 60 * 1000;
function startSelfPing() {
  const hostUrl = process.env.RENDER_EXTERNAL_URL || process.env.RAILWAY_STATIC_URL;
  if (!hostUrl) { console.log('[KeepAlive] No host URL env var set - self-ping disabled'); return; }
  setInterval(() => {
    const protocol = hostUrl.startsWith('https') ? https : http;
    protocol.get(`${hostUrl}/ping`, (res) => res.resume()).on('error', (err) => console.log(`[KeepAlive] Self-ping failed: ${err.message}`));
  }, SELF_PING_INTERVAL);
  console.log('[KeepAlive] Self-ping started (every 10 min)');
}
startSelfPing();

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------
function clearBotTimeouts() {
  if (reconnectTimeoutId) { clearTimeout(reconnectTimeoutId); reconnectTimeoutId = null; }
  if (connectionTimeoutId) { clearTimeout(connectionTimeoutId); connectionTimeoutId = null; }
}

function clearAllIntervals() {
  activeIntervals.forEach(id => clearInterval(id));
  activeIntervals = [];
}

function addInterval(callback, delay) {
  const id = setInterval(callback, delay);
  activeIntervals.push(id);
  return id;
}

function getReconnectDelay() {
  if (botState.wasThrottled) {
    botState.wasThrottled = false;
    const throttleDelay = 60000 + Math.floor(Math.random() * 60000);
    console.log(`[Bot] Throttle detected - extended delay: ${throttleDelay / 1000}s`);
    return throttleDelay;
  }
  const baseDelay = config.utils['auto-reconnect-delay'] || 3000;
  const maxDelay = config.utils['max-reconnect-delay'] || 30000;
  const delay = Math.min(baseDelay * Math.pow(2, botState.reconnectAttempts), maxDelay);
  return delay + Math.floor(Math.random() * 2000);
}

function scheduleReconnect() {
  clearBotTimeouts();
  if (isReconnecting) return;
  isReconnecting = true;
  botState.reconnectAttempts++;
  const delay = getReconnectDelay();
  console.log(`[Bot] Reconnecting in ${delay / 1000}s (attempt #${botState.reconnectAttempts})`);
  reconnectTimeoutId = setTimeout(() => {
    reconnectTimeoutId = null;
    isReconnecting = false;
    createBot();
  }, delay);
}

function createBot() {
  if (isReconnecting) return;
  console.log(`[Bot] Connecting to ${config.server.ip}:${config.server.port}`);

  try {
    const forgeEnabled = !!config.server?.forge?.enabled;
    const selectedVersion = getCurrentProtocolVersion();
    // Forge (FML) el sıkışması sunucudan mod listesini otomatik alıp kendi
    // versiyonunu kendi belirliyor - bu yüzden forge açıkken sürüm hep
    // "false" (otomatik) bırakılmalı, elle sabitlenmemeli.
    const botVersion = forgeEnabled
      ? false
      : (selectedVersion && selectedVersion.trim() !== '' && selectedVersion !== 'auto' ? selectedVersion : false);
    const botUsername = process.env.BOT_USERNAME || config['bot-account'].username;
    const botPassword = process.env.BOT_PASSWORD || config['bot-account'].password || undefined;
    const authPassword = process.env.BOT_AUTH_PASSWORD || config.utils['auto-auth']?.password;

    if (forgeEnabled) {
      console.log(`[Protocol] Forge modu aktif (beklenen: ${config.server.forge.forgeVersion || 'bilinmiyor'}) - sürüm sunucudan otomatik alınacak.`);
    } else {
      console.log(`[Protocol] client version: ${botVersion || 'auto'} | fallback: ${getProtocolCandidates().join(' -> ')}`);
    }

    bot = mineflayer.createBot({
      username: botUsername,
      password: botPassword,
      auth: config['bot-account'].type,
      host: config.server.ip,
      port: config.server.port,
      version: botVersion,
      hideErrors: false,
      checkTimeoutInterval: 600000
    });

    // Forge sunucusuysa FML el sıkışmasını (mod listesi alışverişi) devreye sok.
    // Bu, bot._client üzerinde çalışır ve mineflayer'ın normal login akışından
    // önce/yanında yürür; sunucu Forge/FML değilse hiçbir şey yapmaz.
    if (forgeEnabled) {
      try {
        autoVersionForge(bot._client);
      } catch (e) {
        console.log('[Protocol] Forge handshake kurulum hatası:', e.message);
      }
    }

    bot.loadPlugin(pathfinder);
    bot.loadPlugin(collectBlock);
    bot.loadPlugin(pvp);

    // Paylaşılan durum: survival.js (savaş/kaçış) veya tasks.js (odun/craft/maden)
    // kontrolü ele aldığında "owner" alanına kendi adını yazar; wander.js sadece
    // "busy" true olduğunda duraklar, diğer modüller ise sadece KENDİ sahip
    // oldukları kontrolü bırakır - böylece birbirlerinin işini yarıda kesmezler.
    const activity = { busy: false, owner: null };

    clearBotTimeouts();
    connectionTimeoutId = setTimeout(() => {
      if (!botState.connected) {
        console.log('[Bot] Connection timeout - no spawn received');
        try { bot.removeAllListeners(); bot.end(); } catch (e) {}
        bot = null;
        scheduleReconnect();
      }
    }, 150000);

    let spawnHandled = false;
    bot.once('spawn', () => {
      if (spawnHandled) return;
      spawnHandled = true;
      clearBotTimeouts();
      botState.connected = true;
      botState.lastActivity = Date.now();
      botState.reconnectAttempts = 0;
      isReconnecting = false;
      console.log(`[Bot] Spawned on server (version: ${bot.version})`);

      if (config.discord?.events?.connect) sendDiscordWebhook(`Connected to \`${config.server.ip}\``, 0x4ade80);

      const mcData = require('minecraft-data')(bot.version);

      // auto-auth (register/login) - most servers need this before anything else works
      if (config.utils['auto-auth']?.enabled && authPassword) {
        let authHandled = false;
        const tryAuth = (type) => {
          if (authHandled || !bot || !botState.connected) return;
          authHandled = true;
          bot.chat(type === 'register' ? `/register ${authPassword} ${authPassword}` : `/login ${authPassword}`);
          console.log(`[Auth] Sent /${type}`);
        };
        bot.on('messagestr', (message) => {
          if (authHandled) return;
          const msg = message.toLowerCase();
          if (msg.includes('/register') || msg.includes('register ')) tryAuth('register');
          else if (msg.includes('/login') || msg.includes('login ')) tryAuth('login');
        });
        setTimeout(() => {
          if (!authHandled && bot && botState.connected) { bot.chat(`/login ${authPassword}`); authHandled = true; }
        }, 10000);
      }

      // Rastgele dolaşma: yürüme, koşma, zıplama.
      if (config.wander?.enabled !== false) {
        try {
          wander.start(bot, mcData, config, addInterval, activity);
        } catch (e) {
          console.log('[Wander] Başlatma hatası:', e.message);
        }
      }

      // Basit hayatta kalma görevleri: odun kırma, tahta/çubuk crafting,
      // crafting table yerleştirme, tahta kazma yapma, taş madenciliği.
      if (config.tasks?.enabled !== false) {
        try {
          tasks.start(bot, mcData, config, addInterval, activity);
        } catch (e) {
          console.log('[Tasks] Başlatma hatası:', e.message);
        }
      }

      // Savunma: basit düşman moblara (zombi, iskelet, örümcek vb.) saldırır,
      // can azalınca (ya da ani bir can kaybında) her şeyi bırakıp kaçar.
      // Bu modül wander/tasks'ten önceliklidir.
      if (config.survival?.enabled !== false) {
        try {
          survival.start(bot, mcData, config, addInterval, activity);
        } catch (e) {
          console.log('[Survival] Başlatma hatası:', e.message);
        }
      }

      if (config.utils['chat-log']) {
        bot.on('chat', (username, message) => {
          if (username !== bot.username) console.log(`[Chat] <${username}> ${message}`);
        });
      }
    });

    bot.on('kicked', (reason) => {
      const kickReason = typeof reason === 'object' ? JSON.stringify(reason) : reason;
      console.log(`[Bot] Kicked: ${kickReason}`);
      botState.connected = false;
      pushError({ type: 'kicked', reason: kickReason, time: Date.now() });
      clearAllIntervals();
      maybeRotateProtocol(kickReason);
      const reasonStr = String(kickReason).toLowerCase();
      if (reasonStr.includes('throttl') || reasonStr.includes('wait before reconnect') || reasonStr.includes('too fast')) {
        botState.wasThrottled = true;
      }
      if (config.discord?.events?.disconnect) sendDiscordWebhook(`Kicked: ${kickReason}`, 0xff0000);
    });

    bot.on('end', (reason) => {
      console.log(`[Bot] Disconnected: ${reason || 'Unknown'}`);
      botState.connected = false;
      clearAllIntervals();
      spawnHandled = false;
      maybeRotateProtocol(reason);
      if (config.discord?.events?.disconnect) sendDiscordWebhook(`Disconnected: ${reason || 'Unknown'}`, 0xf87171);
      scheduleReconnect();
    });

    bot.on('error', (err) => {
      console.log(`[Bot] Error: ${err.message}`);
      pushError({ type: 'error', message: err.message, time: Date.now() });
      maybeRotateProtocol(err.message);
    });

  } catch (err) {
    console.log(`[Bot] Failed to create bot: ${err.message}`);
    scheduleReconnect();
  }
}

let lastDiscordSend = 0;
const DISCORD_RATE_LIMIT_MS = 5000;
function sendDiscordWebhook(content, color = 0x0099ff) {
  if (!config.discord?.enabled || !config.discord?.webhookUrl || config.discord.webhookUrl.includes('YOUR_DISCORD')) return;
  const now = Date.now();
  if (now - lastDiscordSend < DISCORD_RATE_LIMIT_MS) return;
  lastDiscordSend = now;
  const protocol = config.discord.webhookUrl.startsWith('https') ? https : http;
  const urlParts = new URL(config.discord.webhookUrl);
  const payload = JSON.stringify({ username: config.name, embeds: [{ description: content, color, timestamp: new Date().toISOString(), footer: { text: config.name } }] });
  const options = { hostname: urlParts.hostname, port: 443, path: urlParts.pathname + urlParts.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload, 'utf8') } };
  const req = protocol.request(options, (res) => res.resume());
  req.on('error', (e) => console.log(`[Discord] Webhook error: ${e.message}`));
  req.write(payload);
  req.end();
}

process.on('uncaughtException', (err) => {
  const msg = err.message || 'Unknown';
  console.log(`[FATAL] Uncaught Exception: ${msg}`);
  pushError({ type: 'uncaught', message: msg, time: Date.now() });
  const isNetworkError = /PartialReadError|ECONNRESET|EPIPE|ETIMEDOUT|timed out|write after end|socket has been ended/.test(msg);
  clearAllIntervals();
  botState.connected = false;
  if (isReconnecting) { isReconnecting = false; if (reconnectTimeoutId) { clearTimeout(reconnectTimeoutId); reconnectTimeoutId = null; } }
  setTimeout(() => scheduleReconnect(), isNetworkError ? 5000 : 10000);
});
process.on('unhandledRejection', (reason) => console.log(`[FATAL] Unhandled Rejection: ${reason}`));
process.on('SIGTERM', () => console.log('[System] SIGTERM received - staying alive.'));
process.on('SIGINT', () => console.log('[System] SIGINT received - staying alive.'));

console.log('='.repeat(50));
console.log('  Minecraft Wander Bot (stripped down)');
console.log('='.repeat(50));
console.log(`Server: ${config.server.ip}:${config.server.port}`);
console.log(`Bot Username: ${process.env.BOT_USERNAME || config['bot-account'].username}`);
console.log('='.repeat(50));

createBot();
