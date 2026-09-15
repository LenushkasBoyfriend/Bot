'use strict';
// Basit hayatta kalma / savunma davranışı:
// - Yakında bilinen "basit" bir düşman mob varsa (zombi, iskelet, örümcek vb.)
//   üzerine gidip saldırır (mineflayer-pvp ile).
// - Can belirli bir eşiğin altına düşerse (ya da hâlâ "kaçma" penceresi
//   içindeyse) her şeyi bırakıp en yakın tehditten uzağa koşar.
// - Bu modül wander.js ve tasks.js'ten HER ZAMAN önceliklidir: tehdit/kaçış
// anında activity.busy'yi kendi eline alır, tehlike geçince serbest bırakır.

const { goals } = require('mineflayer-pathfinder');
const { GoalXZ } = goals;

const DEFAULT_FIGHTABLE_MOBS = new Set([
  'zombie', 'husk', 'drowned', 'zombie_villager',
  'skeleton', 'stray',
  'spider', 'cave_spider',
  'silverfish'
]);

// Kılıç kademeleri - varsa en iyisini kuşanır, hiç yoksa çıplak elle vurur.
const SWORD_TIERS = { wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 };

function getBestSword(bot) {
  let best = null;
  let bestTier = 0;
  for (const item of bot.inventory.items()) {
    if (!item.name.endsWith('_sword')) continue;
    const tierName = item.name.replace('_sword', '');
    const tier = SWORD_TIERS[tierName] || 0;
    if (tier > bestTier) {
      bestTier = tier;
      best = item;
    }
  }
  return best;
}

async function equipBestWeapon(bot) {
  const sword = getBestSword(bot);
  if (!sword) return; // kılıç yoksa yumrukla vurur, sorun değil
  try {
    const held = bot.heldItem;
    if (!held || held.type !== sword.type) await bot.equip(sword, 'hand');
  } catch (_) {
    // yetişemedi / envanter değişti - önemli değil, bir sonraki tikte tekrar denenir
  }
}

function nearestFightable(bot, radius, fightSet) {
  let nearest = null;
  let nearestDist = Infinity;
  for (const id in bot.entities) {
    const e = bot.entities[id];
    if (!e || e === bot.entity || e.type !== 'mob') continue;
    if (!fightSet.has(e.name)) continue;
    const dist = e.position.distanceTo(bot.entity.position);
    if (dist <= radius && dist < nearestDist) {
      nearest = e;
      nearestDist = dist;
    }
  }
  return nearest;
}

// Kaçarken "neden" kaçtığımızı bilmemiz şart değil - en yakın mob'un
// (tanıdığımız ya da tanımadığımız, modlu ya da değil) tersi yönüne koşuyoruz.
function nearestMob(bot, radius) {
  let nearest = null;
  let nearestDist = Infinity;
  for (const id in bot.entities) {
    const e = bot.entities[id];
    if (!e || e === bot.entity || e.type !== 'mob') continue;
    const dist = e.position.distanceTo(bot.entity.position);
    if (dist <= radius && dist < nearestDist) {
      nearest = e;
      nearestDist = dist;
    }
  }
  return nearest;
}

function fleeFrom(bot, threat, fleeDistance) {
  const pos = bot.entity.position;
  let dx, dz;
  if (threat && threat.position) {
    dx = pos.x - threat.position.x;
    dz = pos.z - threat.position.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
  } else {
    const angle = Math.random() * Math.PI * 2;
    dx = Math.cos(angle);
    dz = Math.sin(angle);
  }
  const targetX = pos.x + dx * fleeDistance;
  const targetZ = pos.z + dz * fleeDistance;
  try {
    bot.pathfinder.setGoal(new GoalXZ(targetX, targetZ));
  } catch (_) {}
}

function start(bot, mcData, config, addInterval, activity) {
  const cfg = config.survival || {};
  if (cfg.enabled === false) {
    console.log('[Survival] Savunma sistemi devre dışı.');
    return;
  }

  const checkMs = Math.max(300, cfg.checkIntervalMs ?? 500);
  const engageRadius = cfg.engageRadius ?? 12;
  const fleeHealthThreshold = cfg.fleeHealthThreshold ?? 10; // 20 üzerinden can (10 = 5 kalp)
  const fleeDistance = cfg.fleeDistance ?? 20;
  const fleeDurationMs = cfg.fleeDurationMs ?? 6000;
  const fightSet = new Set(
    Array.isArray(cfg.fightableMobs) && cfg.fightableMobs.length
      ? cfg.fightableMobs
      : DEFAULT_FIGHTABLE_MOBS
  );

  let fleeingUntil = 0;
  let fighting = false;
  let lastHealth = bot.health ?? 20;

  addInterval(() => {
    if (!bot?.entity || !bot?.pvp) return;
    const now = Date.now();
    const health = bot.health ?? 20;

    // Ani bir can kaybı (bilinmeyen/modlu bir mob'un vurmuş olabileceği durum
    // dahil) tehdit eşiğinin üstünde bile olsa kısa bir kaçış tetikler.
    const suddenDrop = lastHealth - health >= 4;
    lastHealth = health;

    const mustFlee = health <= fleeHealthThreshold || now < fleeingUntil || suddenDrop;

    if (mustFlee) {
      if (fighting) {
        try { bot.pvp.stop(); } catch (_) {}
        fighting = false;
      }
      activity.busy = true;
      activity.owner = 'survival';
      fleeingUntil = now + fleeDurationMs;
      const threat = nearestMob(bot, engageRadius * 2);
      fleeFrom(bot, threat, fleeDistance);
      return;
    }

    // Savaşa devam - pvp eklentisi kendi saldırı döngüsünü yürütüyor,
    // sadece hedefin hâlâ geçerli olup olmadığını kontrol ediyoruz.
    if (fighting) {
      if (!bot.pvp.target) {
        fighting = false;
      } else {
        activity.busy = true;
        activity.owner = 'survival';
        return;
      }
    }

    const target = nearestFightable(bot, engageRadius, fightSet);
    if (target) {
      activity.busy = true;
      activity.owner = 'survival';
      equipBestWeapon(bot).finally(() => {
        try {
          bot.pvp.attack(target);
          fighting = true;
        } catch (_) {}
      });
      return;
    }

    // Ortalık sakin - sadece BİZİM elimizde tuttuğumuz kontrolü bırakıyoruz;
    // tasks.js bir görev yürütüyorsa onun kontrolüne dokunmuyoruz.
    if (!fighting && activity.owner === 'survival') {
      activity.busy = false;
      activity.owner = null;
    }
  }, checkMs);

  console.log('[Survival] Basit düşmanlara saldırı + can azalınca hızlı kaçış aktif.');
}

module.exports = { start };
