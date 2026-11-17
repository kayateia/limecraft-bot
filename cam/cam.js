// LimeCam: a spectator-ish bot that serves a 3D web view of the world and
// exposes GET /snapshot (PNG) for external agents (Lime) to "see".
//
// Requires chromium in the image (apt) + puppeteer-core.
// Endpoints:
//   GET /snapshot          -> PNG of the 3D view at the cam bot's current position
//   GET /snapshot?dx=&dy=&dz= -> first move near dx,dy,dz (absolute coords), then shoot
//   GET /state             -> cam position JSON

const http = require("http");
const mineflayer = require("mineflayer");
const viewerFactory = require("prismarine-viewer");
const puppeteer = require("puppeteer-core");

const HOST = process.env.MC_HOST || "minecraft-offline";
const PORT = parseInt(process.env.MC_PORT || "25565", 10);
const USERNAME = process.env.MC_USERNAME || "LimeCam";
const VERSION = process.env.MC_VERSION || "1.21.4";
const VIEW_PORT = parseInt(process.env.VIEW_PORT || "3007", 10);
const SNAP_PORT = parseInt(process.env.SNAP_PORT || "3008", 10);

const bot = mineflayer.createBot({ host: HOST, port: PORT, username: USERNAME, version: VERSION });
bot.loadPlugin(require("mineflayer-pathfinder").pathfinder);

let browser = null, page = null, pageReady = false;

async function ensurePage() {
  if (pageReady && page) return page;
  browser = await puppeteer.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    args: [
      "--no-sandbox", "--disable-gpu-sandbox", "--use-gl=angle", "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader", "--disable-dev-shm-usage", "--window-size=1024,768",
    ],
    defaultViewport: { width: 1024, height: 768 },
  });
  page = await browser.newPage();
  await page.goto(`http://localhost:${VIEW_PORT}/`, { waitUntil: "networkidle2", timeout: 60000 });
  await new Promise((r) => setTimeout(r, 5000)); // let chunks stream in
  pageReady = true;
  console.log("[cam] viewer page ready");
  return page;
}

function state() {
  const p = bot.entity.position;
  return { username: bot.username, position: { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1) }, yaw: bot.entity.yaw, pitch: bot.entity.pitch };
}

async function gotoNear(x, y, z) {
  const { goals, Movements } = require("mineflayer-pathfinder");
  const mv = new Movements(bot);
  bot.pathfinder.setMovements(mv);
  bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, 3));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("pathing timeout")), 30000);
    bot.once("goal_reached", () => { clearTimeout(t); resolve(); });
    bot.once("path_update", (r) => { if (r.status === "no_path") { clearTimeout(t); reject(new Error("no path")); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(state()));
    }
    if (url.pathname === "/snapshot") {
      if (!bot.entity) { res.writeHead(503); return res.end("bot not spawned"); }
      const q = url.searchParams;
      if (q.has("dx")) {
        const { dx, dy, dz } = Object.fromEntries(["dx", "dy", "dz"].map((k) => [k, parseFloat(q.get(k))]));
        if ([dx, dy, dz].some((v) => typeof v !== "number" || Number.isNaN(v))) { res.writeHead(400); return res.end("bad coords"); }
        await gotoNear(dx, dy, dz);
      }
      const pg = await ensurePage();
      // small delay so the camera settles after any move
      await new Promise((r) => setTimeout(r, 1500));
      const shot = await pg.screenshot({ type: "png" });
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": shot.length });
      return res.end(shot);
    }
    res.writeHead(404); res.end();
  } catch (e) {
    console.log("[cam] error:", e.message);
    res.writeHead(500); res.end(e.message);
  }
});

bot.once("spawn", () => {
  const p = bot.entity.position;
  console.log(`[cam] spawned at ${p.x.toFixed(0)},${p.y.toFixed(0)},${p.z.toFixed(0)}`);
  try {
    viewerFactory.mineflayer(bot, { port: VIEW_PORT, viewDistance: 4, firstPerson: false });
    server.listen(SNAP_PORT, "0.0.0.0", () => console.log(`[cam] snapshot API on :${SNAP_PORT}`));
  } catch (e) {
    console.log("[cam] viewer startup failed:", e.message);
  }
});
bot.on("kicked", (r) => console.log("[cam] kicked:", r));
bot.on("error", (e) => console.log("[cam] error:", e.message));
