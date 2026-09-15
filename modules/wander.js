'use strict';
// Everything else has been removed. This is the ONLY behavior the bot has:
// walk, sprint, and jump - completely on its own, choosing random directions
// forever, and never getting permanently stuck (on the ground OR in the air).

const { Movements, goals } = require('mineflayer-pathfinder');
const { GoalXZ } = goals;

function install(bot, mcData) {
  const move = new Movements(bot, mcData);
  move.canDig = false;          // never mine - it's just walking around
  move.canPlace = false;        // never place blocks
  move.allowParkour = true;     // needed so it can hop gaps/ledges on its own
  move.allowSprinting = true;   // this is the "run" part
  move.allow1by1Towers = false;
  move.maxDropDown = 3;
  bot.pathfinder.setMovements(move);
  return move;
}

function start(bot, mcData, config, addInterval, activity) {
  install(bot, mcData);

  const cfg = config.wander || {};
  const minHop = cfg.minHopDistance ?? 40;
  const maxHop = cfg.maxHopDistance ?? 150;
  const checkIntervalMs = Math.max(400, cfg.checkIntervalMs ?? 800);
  const groundStuckMs = Math.max(4000, cfg.groundStuckMs ?? 8000);
  const airStuckMs = Math.max(1200, cfg.airStuckMs ?? 1800); // a normal jump apex is well under 1s

  let currentTarget = null;
  let lastProgressAt = Date.now();
  let lastDistance = Infinity;

  // --- airborne watchdog state ---
  let airborneSince = null;
  let lastY = bot.entity.position.y;
  let lastYChangeAt = Date.now();

  function clearMotion() {
    for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) {
      try { bot.setControlState(k, false); } catch (_) {}
    }
  }

  function pickNewTarget() {
    const pos = bot.entity.position;

    // 100% random heading, every single time. No center, no boundary,
    // no bias to come back - wherever its own "will" takes it.
    const angle = Math.random() * Math.PI * 2;
    const hop = minHop + Math.random() * (maxHop - minHop);
    const targetX = pos.x + Math.cos(angle) * hop;
    const targetZ = pos.z + Math.sin(angle) * hop;

    currentTarget = { x: targetX, z: targetZ };
    lastProgressAt = Date.now();
    lastDistance = Infinity;

    try {
      bot.pathfinder.setGoal(new GoalXZ(targetX, targetZ));
    } catch (e) {
      console.log('[Wander] setGoal hatası:', e.message);
    }
  }

  // Occasional playful hop while walking (not obstacle related, just liveliness).
  addInterval(() => {
    if (activity?.busy) return; // tasks.js bir görev yürütüyor (odun/craft/maden)
    if (!bot?.entity) return;
    if (!bot.entity.onGround) return;
    if (!bot.pathfinder?.goal) return;
    if (Math.random() < 0.15) {
      try {
        bot.setControlState('jump', true);
        setTimeout(() => { try { bot.setControlState('jump', false); } catch (_) {} }, 200);
      } catch (_) {}
    }
  }, 4000);

  addInterval(() => {
    if (activity?.busy) {
      currentTarget = null; // görev bitince taze bir hedefle devam etsin
      return;
    }
    if (!bot?.entity || !bot?.pathfinder) return;
    const now = Date.now();
    const pos = bot.entity.position;

    // ---- 1) airborne (mid-air stuck) watchdog ----
    if (bot.entity.onGround) {
      airborneSince = null;
    } else {
      if (airborneSince === null) airborneSince = now;
    }
    if (Math.abs(pos.y - lastY) > 0.05) {
      lastY = pos.y;
      lastYChangeAt = now;
    }
    const hangingInAir = airborneSince !== null &&
      (now - airborneSince > airStuckMs) &&
      (now - lastYChangeAt > airStuckMs); // not falling, not rising - actually hovering

    if (hangingInAir) {
      console.log('[Wander] Havada takılı kaldı, kurtarma yapılıyor.');
      clearMotion();
      try { bot.pathfinder.stop(); } catch (_) {}
      airborneSince = null;
      lastYChangeAt = now;
      // brief pause then re-issue the same/new goal so pathfinder recomputes fresh
      setTimeout(() => {
        if (!bot?.entity) return;
        pickNewTarget();
      }, 350);
      return;
    }

    // ---- 2) no target yet ----
    if (!currentTarget) {
      pickNewTarget();
      return;
    }

    // ---- 3) ground progress / stuck watchdog ----
    const dx = currentTarget.x - pos.x;
    const dz = currentTarget.z - pos.z;
    const dist = Math.hypot(dx, dz);

    if (dist < lastDistance - 0.15) {
      lastDistance = dist;
      lastProgressAt = now;
    }

    const reached = dist <= 2.5;
    const stuckOnGround = bot.entity.onGround && (now - lastProgressAt > groundStuckMs);

    if (reached || stuckOnGround) {
      if (stuckOnGround) console.log('[Wander] Yerde takıldı, yeni rastgele hedef seçiliyor.');
      pickNewTarget();
    }
  }, checkIntervalMs);

  console.log('[Wander] Aktif: sınırsız, tamamen rastgele yürüme + koşma + zıplama.');
}

module.exports = { install, start };
