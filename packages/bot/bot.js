// Mineflayer bot + HTTP bridge. Connects as a player, logs world state,
// echoes chat, and exposes a small JSON API so an external agent can drive it.

const mineflayer = require("mineflayer");
const { startBridge } = require("./bridge");

const bot = mineflayer.createBot({
  host: process.env.MC_HOST || "minecraft-offline",
  port: parseInt(process.env.MC_PORT || "25565", 10),
  username: process.env.MC_USERNAME || "Lime",
  version: process.env.MC_VERSION || "1.21.4",
  // auth: "microsoft", // enable + MC_PASSWORD for online-mode later
});

const { pathfinder } = require("mineflayer-pathfinder");
bot.loadPlugin(pathfinder);

bot.once("login", () => {
  console.log(`[bot] logged in as ${bot.username}`);
});

bot.once("spawn", () => {
  const p = bot.entity.position;
  console.log(`[bot] spawned at ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`);
  console.log(`[bot] world: ${bot.game?.dimension ?? "unknown"}`);
  startBridge(bot);
});

// Chat log + simple echo guard (so it can't get stuck echoing itself)
bot.on("chat", (username, message) => {
  if (username === bot.username) return;
  console.log(`[chat] <${username}> ${message}`);
  // TODO: route to pi bridge; for now a canned hello
  if (message.toLowerCase().includes("hello lime")) {
    bot.chat("hello! (Minecraft chat has no lemon glyph, I checked)");
  }
});

// Health / death tracking (first brick of the reflex layer)
bot.on("health", () => {
  if (bot.health <= 6) {
    console.log(`[reflex] low health! hp=${bot.health}, food=${bot.food}`);
    // TODO: flee-to-safety reflex here
  }
});

bot.on("death", () => {
  console.log("[bot] died. embarrassing but educational.");
});

bot.on("kicked", (reason) => console.log(`[bot] kicked: ${reason}`));
bot.on("error", (err) => console.log(`[bot] error: ${err.message}`));
