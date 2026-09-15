'use strict';
// Basit "hayatta kalma" görevleri: ara sıra dolaşmayı bırakıp
// - en yakın ağacı bulup odun kırar
// - odunlardan tahta ve çubuk üretir
// - crafting table yapıp yere koyar (yoksa)
// - tahta kazma yapar
// - kazma ile etraftaki taş/kobblestone'u kazar
// Bittiğinde tekrar wander.js'e (rastgele dolaşmaya) devam eder.

const { Vec3 } = require('vec3');

const LOG_NAMES = new Set([
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log',
  'dark_oak_log', 'mangrove_log', 'cherry_log', 'pale_oak_log',
  'crimson_stem', 'warped_stem'
]);

const STONE_NAMES = new Set([
  'stone', 'cobblestone', 'andesite', 'diorite', 'granite',
  'deepslate', 'cobbled_deepslate', 'tuff'
]);

const DEFAULT_ORE_NAMES = new Set([
  'iron_ore', 'deepslate_iron_ore',
  'coal_ore', 'deepslate_coal_ore'
]);

// Vanilla kazma kademeleri: demir cevheri kırıp gerçekten düşürmek için
// en az taş kazma gerekiyor - tahta/altın kazma demiri kırar ama hiçbir şey
// düşürmez. Bu yüzden "hangi kazma neyi kazabilir" burada takip ediliyor.
const PICKAXE_TIERS = { wooden: 1, golden: 1, stone: 2, iron: 3, diamond: 4, netherite: 5 };
const STONE_TIER = 2;

function getBestPickaxe(bot) {
  let best = null;
  let bestTier = 0;
  for (const item of bot.inventory.items()) {
    if (!item.name.endsWith('_pickaxe')) continue;
    const tierName = item.name.replace('_pickaxe', '');
    const tier = PICKAXE_TIERS[tierName] || 0;
    if (tier > bestTier) {
      bestTier = tier;
      best = item;
    }
  }
  return { item: best, tier: bestTier };
}

function plankNameForLog(logName) {
  if (logName.endsWith('_log')) return logName.replace('_log', '_planks');
  if (logName.endsWith('_stem')) return logName.replace('_stem', '_planks');
  return null;
}

function countByPredicate(bot, predicate) {
  return bot.inventory.items().filter(predicate).reduce((sum, i) => sum + i.count, 0);
}

function countPlanks(bot) {
  return countByPredicate(bot, (i) => i.name.endsWith('_planks'));
}

function countSticks(bot) {
  return countByPredicate(bot, (i) => i.name === 'stick');
}

async function gatherWood(bot, count, radius, activity) {
  let collected = 0;
  for (let i = 0; i < count; i++) {
    if (activity.owner !== 'tasks') break; // survival (savaş/kaçış) kontrolü aldı
    const block = bot.findBlock({
      matching: (b) => LOG_NAMES.has(b.name),
      maxDistance: radius
    });
    if (!block) break;
    try {
      await bot.collectBlock.collect(block);
      collected++;
    } catch (e) {
      console.log('[Tasks] Kütük toplama hatası:', e.message);
      break;
    }
  }
  return collected;
}

async function craftItem(bot, mcData, itemName, times, craftingTableBlock) {
  const itemData = mcData.itemsByName[itemName];
  if (!itemData) return false;
  const recipes = bot.recipesFor(itemData.id, null, 1, craftingTableBlock || null);
  if (!recipes || recipes.length === 0) return false;
  try {
    await bot.craft(recipes[0], times, craftingTableBlock || null);
    return true;
  } catch (e) {
    console.log(`[Tasks] Craft hatası (${itemName}):`, e.message);
    return false;
  }
}

async function craftAllPlanks(bot, mcData) {
  const logs = bot.inventory.items().filter((i) => LOG_NAMES.has(i.name));
  const grouped = {};
  for (const item of logs) grouped[item.name] = (grouped[item.name] || 0) + item.count;
  for (const [logName, cnt] of Object.entries(grouped)) {
    const plankName = plankNameForLog(logName);
    if (!plankName) continue;
    await craftItem(bot, mcData, plankName, cnt);
  }
}

async function placeCraftingTable(bot) {
  const tableItem = bot.inventory.items().find((i) => i.name === 'crafting_table');
  if (!tableItem) return null;
  try {
    await bot.equip(tableItem, 'hand');
    const base = bot.entity.position.floored();
    const candidates = [
      base.offset(0, -1, 0),
      base.offset(1, -1, 0),
      base.offset(-1, -1, 0),
      base.offset(0, -1, 1),
      base.offset(0, -1, -1)
    ];
    for (const pos of candidates) {
      const refBlock = bot.blockAt(pos);
      if (!refBlock || refBlock.boundingBox !== 'block') continue;
      const above = bot.blockAt(pos.offset(0, 1, 0));
      if (above && above.boundingBox === 'block') continue;
      try {
        await bot.placeBlock(refBlock, new Vec3(0, 1, 0));
        return bot.findBlock({ matching: (b) => b.name === 'crafting_table', maxDistance: 4 });
      } catch (_) {
        continue;
      }
    }
  } catch (e) {
    console.log('[Tasks] Crafting table yerleştirme hatası:', e.message);
  }
  return null;
}

async function mineStone(bot, radius, count, oreNames, preferOres, activity) {
  let mined = 0;
  let minedOres = 0;
  for (let i = 0; i < count; i++) {
    if (activity.owner !== 'tasks') break; // survival (savaş/kaçış) kontrolü aldı
    let targetBlock = null;
    if (preferOres) {
      // Önce demir/kömür (veya ayarlanmış diğer cevherler) aranır.
      targetBlock = bot.findBlock({
        matching: (b) => oreNames.has(b.name),
        maxDistance: radius
      });
    }
    if (!targetBlock) {
      // Cevher yoksa/kalmadıysa sıradan taş/kobblestone'a devam edilir.
      targetBlock = bot.findBlock({
        matching: (b) => STONE_NAMES.has(b.name),
        maxDistance: radius
      });
    }
    if (!targetBlock) break;
    const wasOre = oreNames.has(targetBlock.name);
    try {
      await bot.collectBlock.collect(targetBlock);
      mined++;
      if (wasOre) minedOres++;
    } catch (e) {
      console.log('[Tasks] Taş/cevher kazma hatası:', e.message);
      break;
    }
  }
  return { mined, minedOres };
}

async function runCycle(bot, mcData, cfg, activity) {
  activity.busy = true;
  activity.owner = 'tasks';
  try { bot.pathfinder.stop(); } catch (_) {}

  console.log('[Tasks] Görev döngüsü başlıyor: odun aranıyor.');
  try {
    const logsWanted = cfg.logsPerCycle ?? 4;
    const searchRadius = cfg.searchRadius ?? 48;

    const got = await gatherWood(bot, logsWanted, searchRadius, activity);
    if (got === 0) {
      console.log('[Tasks] Yakında ağaç bulunamadı, bu döngü atlanıyor.');
      return;
    }
    console.log(`[Tasks] ${got} kütük toplandı.`);

    if (activity.owner !== 'tasks') return; // savunma devreye girdi, geri kalanı boşver

    await craftAllPlanks(bot, mcData);

    if (countPlanks(bot) >= 2 && countSticks(bot) < 2) {
      await craftItem(bot, mcData, 'stick', 1);
    }

    let table = bot.findBlock({ matching: (b) => b.name === 'crafting_table', maxDistance: 16 });
    if (!table && activity.owner === 'tasks') {
      const hasTableItem = bot.inventory.items().some((i) => i.name === 'crafting_table');
      if (!hasTableItem && countPlanks(bot) >= 4) {
        await craftItem(bot, mcData, 'crafting_table', 1);
      }
      if (bot.inventory.items().some((i) => i.name === 'crafting_table')) {
        table = await placeCraftingTable(bot);
        if (table) console.log('[Tasks] Crafting table yerleştirildi.');
      }
    }

    const hasPickaxe = bot.inventory.items().some((i) => i.name.endsWith('_pickaxe'));
    if (table && !hasPickaxe && countPlanks(bot) >= 3 && countSticks(bot) >= 2 && activity.owner === 'tasks') {
      const tableBlock = bot.blockAt(table.position);
      const ok = await craftItem(bot, mcData, 'wooden_pickaxe', 1, tableBlock);
      if (ok) console.log('[Tasks] Tahta kazma yapıldı.');
    }

    if (cfg.mineStone !== false && activity.owner === 'tasks') {
      const budget = cfg.stonePerCycle ?? 10;
      const configuredOres = Array.isArray(cfg.oreBlocks) && cfg.oreBlocks.length
        ? cfg.oreBlocks
        : Array.from(DEFAULT_ORE_NAMES);
      const preferOres = cfg.preferOres !== false;

      let { item: pickaxe, tier: pickaxeTier } = getBestPickaxe(bot);
      let totalMined = 0;
      let totalOres = 0;

      if (pickaxe) {
        await bot.equip(pickaxe, 'hand');
        const canMineIron = pickaxeTier >= STONE_TIER;
        // Demir cevherini kırabilecek kazmamız yoksa, ilk turda demiri hedeflerden
        // çıkarıyoruz (yoksa boşuna kırıp hiçbir şey alamayız) - sadece kömür +
        // sıradan taş/kobblestone toplanır.
        const firstPassOres = new Set(configuredOres.filter((name) => canMineIron || !name.includes('iron')));
        const firstBudget = canMineIron ? budget : Math.min(budget, Math.ceil(budget / 2) + 2);

        const firstResult = await mineStone(bot, searchRadius, firstBudget, firstPassOres, preferOres, activity);
        totalMined += firstResult.mined;
        totalOres += firstResult.minedOres;

        // Taş kazmamız yoksa ve yeterli kobblestone/çubuk toplandıysa, taş kazma
        // yap - böylece demir cevherini gerçekten kazabilir hale geliriz.
        if (!canMineIron && activity.owner === 'tasks') {
          const hasStonePickaxe = bot.inventory.items().some((i) => i.name === 'stone_pickaxe');
          const cobbleCount = countByPredicate(bot, (i) => i.name === 'cobblestone' || i.name === 'cobbled_deepslate');
          if (!hasStonePickaxe && table && cobbleCount >= 3 && countSticks(bot) >= 2) {
            const tableBlock = bot.blockAt(table.position);
            const ok = await craftItem(bot, mcData, 'stone_pickaxe', 1, tableBlock);
            if (ok) console.log('[Tasks] Taş kazma yapıldı, artık demir cevheri kazabilir.');
          }

          const upgraded = getBestPickaxe(bot);
          if (upgraded.tier >= STONE_TIER && upgraded.item && activity.owner === 'tasks') {
            await bot.equip(upgraded.item, 'hand');
            const remainingBudget = budget - totalMined;
            if (remainingBudget > 0) {
              const secondResult = await mineStone(bot, searchRadius, remainingBudget, new Set(configuredOres), preferOres, activity);
              totalMined += secondResult.mined;
              totalOres += secondResult.minedOres;
            }
          }
        }
      }

      if (totalMined > 0) {
        console.log(`[Tasks] ${totalMined} blok kazıldı (${totalOres} tanesi demir/kömür cevheri).`);
      }
    }
  } catch (e) {
    console.log('[Tasks] Görev döngüsü hatası:', e.message);
  } finally {
    if (activity.owner === 'tasks') {
      activity.busy = false;
      activity.owner = null;
    }
    console.log('[Tasks] Görev döngüsü bitti, tekrar dolaşmaya dönülüyor.');
  }
}

function start(bot, mcData, config, addInterval, activity) {
  const cfg = config.tasks || {};
  if (cfg.enabled === false) {
    console.log('[Tasks] Görev sistemi devre dışı (sadece dolaşma).');
    return;
  }

  const minDelay = cfg.minIntervalMs ?? 120000; // 2 dk
  const maxDelay = cfg.maxIntervalMs ?? 300000; // 5 dk
  const tickMs = 10000;

  let nextCycleAt = Date.now() + minDelay + Math.random() * (maxDelay - minDelay);

  addInterval(() => {
    if (activity.busy) return;
    if (Date.now() < nextCycleAt) return;
    nextCycleAt = Infinity; // döngü bitene kadar tekrar tetiklenmesin
    runCycle(bot, mcData, cfg, activity).finally(() => {
      nextCycleAt = Date.now() + minDelay + Math.random() * (maxDelay - minDelay);
    });
  }, tickMs);

  console.log('[Tasks] Görev sistemi aktif: odun -> tahta/çubuk -> crafting table -> kazma -> taş madenciliği.');
}

module.exports = { start };
