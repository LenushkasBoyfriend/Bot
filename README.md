# MyVeryOwnHostinBot v15.3

Movement and survival loop rewrite.

## v15.3.1 fixes (protocol + concurrency)

- **Version mismatch (most likely cause of "does nothing"):** `settings.json` pinned the server to Minecraft `1.21.11`, a version released Dec 9, 2025. The `mineflayer`/`minecraft-data` versions this project's checked-in `package-lock.json` had resolved predate full `1.21.11` protocol support (a hard-coded exact version like this can make mineflayer flat-out reject the connection, or leave `mcData` incomplete after spawn, which then makes almost every block/item/recipe lookup in every module silently fail). Fixed by:
  - Bumping `mineflayer`, `minecraft-data`, `mineflayer-pathfinder` to `latest` in `package.json`.
  - Deleting the stale `package-lock.json` so `npm install` re-resolves fresh versions instead of reusing old locked ones.
  - Putting `"auto"` first in `server.protocol-fallback.versions`, so the bot asks the server for its real protocol version instead of guessing a hard-coded one; the explicit versions remain as fallbacks.
  - **You must run a clean install after unzipping**: delete `node_modules` (and `package-lock.json` if your host recreated one) and run `npm install` again, or the fix won't take effect.
- **CombatAI vs SurvivalAI fighting over movement:** both modules could call `bot.pathfinder.setGoal(...)` in the same moment (e.g. gathering wood while a distant zombie wanders into detection range), which is a classic cause of a bot looking "fully stuck" - each module keeps cancelling the other's path. They now share a `bot.__autonomyBusy` flag: SurvivalAI won't start a new task while combat is actively resolving a *close* fight, and CombatAI won't yank the goal away from a mid-task SurvivalAI run for a *distant* threat (it still reacts instantly to anything within 6 blocks or if health is low).
- A couple of `Vec3(...)` calls used the module without `new`; normalized to `new Vec3(...)` everywhere for safety.

If the bot still doesn't move/act after this, please paste the full console log from connect onward (not just the "no prompt after 10s" auth line) - the exact error line is the fastest way to pin down anything version-fallback didn't cover.

- Pathfinder is the only normal movement owner.
- No random idle wandering.
- Jump assist only when a real 1-block obstacle is directly ahead and the next two spaces are clear.
- Stuck recovery uses a tiny local goal instead of forced forward/jump.
- Survival priorities are deterministic: wood -> tools -> food -> fuel/iron/mining.
- No OpenAI/API dependency.
- Chat spam disabled by default.
- Combat targets only hostile mobs.
