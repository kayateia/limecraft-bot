// HTTP bridge over the Mineflayer bot.
//
// Lets an external agent (e.g. Lime Pi) drive the bot:
//   GET  /state            -> position, health, food, time, nearby entities, inventory
//   GET  /blocks?dx=..     -> block summaries in a radius around the bot (default 4)
//   POST /chat             { message }
//   POST /goto             { x, y, z }        (pathfinder,async)
//   POST /dig              { x, y, z }
//   POST /place            { x, y, z }        (places held block against reference block)
//   POST /look             { x, y, z }
//   POST /equip            { item }           (item name or id; searches inventory)
//   POST /stop             {}
//
// Auth: if BRIDGE_TOKEN is set, requests must send "Authorization: Bearer <token>".
// Binds 0.0.0.0:BRIDGE_PORT (default 3000) so a sibling container on mcnet can reach it.

const http = require("http");

function startBridge(bot) {
  const PORT = parseInt(process.env.BRIDGE_PORT || "3000", 10);
  const TOKEN = process.env.BRIDGE_TOKEN || "";

  function ok(res, body) { json(res, 200, body ?? { ok: true }); }
  function json(res, code, body) {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }
  function fail(res, code, msg) { json(res, code, { ok: false, error: msg }); }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
      req.on("end", () => {
        if (!data) return resolve({});
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("bad json")); }
      });
      req.on("error", reject);
    });
  }

  function requireAuth(req, res) {
    if (!TOKEN) return true;
    const auth = req.headers["authorization"] || "";
    if (auth === `Bearer ${TOKEN}`) return true;
    fail(res, 401, "unauthorized");
    return false;
  }

  function posOf(b) {
    const p = b.entity.position;
    return { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) };
  }

  function state() {
    const entities = Object.values(bot.entities)
      .filter((e) => e.entityType && e.position &&
        e.entity.position.distanceTo(bot.entity.position) < 32 &&
        e.entity.uuid !== bot.entity.uuid)
      .slice(0, 50)
      .map((e) => ({
        id: e.id,
        type: e.name ?? e.type,
        username: e.username,
        position: {
          x: +e.position.x.toFixed(2),
          y: +e.position.y.toFixed(2),
          z: +e.position.z.toFixed(2),
        },
      }));
    return {
      username: bot.username,
      position: posOf(bot),
      health: bot.health,
      food: bot.food,
      heldItem: bot.heldItem ? bot.heldItem.name : null,
      inventory: bot.inventory.items().map((i) => ({ name: i.name, count: i.count })),
      gameMode: bot.game?.gameMode,
      dimension: bot.game?.dimension,
      time: bot.time?.timeOfDay,
      entities,
    };
  }

  // Block summaries in a small radius: cheap structured "vision".
  function blockSummary(radius) {
    const out = [];
    const p = bot.entity.position.floored();
    for (let dx = -radius; dx <= radius; dx++)
      for (let dy = -2; dy <= 2; dy++)
        for (let dz = -radius; dz <= radius; dz++) {
          const b = bot.blockAt(p.offset(dx, dy, dz));
          if (!b || b.name === "air") continue;
          out.push({
            x: b.position.x, y: b.position.y, z: b.position.z,
            name: b.name,
            solid: b.boundingBox !== "empty",
          });
        }
    return out;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (!requireAuth(req, res)) return;

      if (req.method === "GET" && url.pathname === "/state") {
        return ok(res, state());
      }

      if (req.method === "GET" && url.pathname === "/blocks") {
        const r = Math.min(parseInt(url.searchParams.get("radius") || "4", 10), 8);
        return ok(res, { blocks: blockSummary(r) });
      }

      if (req.method === "POST") {
        const body = await readBody(req);
        switch (url.pathname) {
          case "/chat": {
            if (typeof body.message !== "string") return fail(res, 400, "message required");
            bot.chat(body.message.slice(0, 256));
            return ok(res);
          }
          case "/look": {
            const { x, y, z } = body;
            if ([x, y, z].some((v) => typeof v !== "number")) return fail(res, 400, "x,y,z required");
            await bot.lookAt(new (require("vec3").Vec3)(x, y, z), true);
            return ok(res);
          }
          case "/equip": {
            if (typeof body.item !== "string") return fail(res, 400, "item required");
            const item = bot.inventory.items().find((i) => i.name === body.item || i.name.startsWith(body.item));
            if (!item) return fail(res, 404, `no item matching '${body.item}'`);
            await bot.equip(item, "hand");
            return ok(res, { equipped: item.name });
          }
          case "/dig": {
            const { x, y, z } = body;
            if ([x, y, z].some((v) => typeof v !== "number")) return fail(res, 400, "x,y,z required");
            const b = bot.blockAt(new (require("vec3").Vec3)(x, y, z));
            if (!b || b.name === "air") return fail(res, 404, "no block there");
            await bot.dig(b);
            return ok(res, { dug: b.name });
          }
          case "/place": {
            const { x, y, z } = body;
            if ([x, y, z].some((v) => typeof v !== "number")) return fail(res, 400, "x,y,z required");
            const ref = bot.blockAt(new (require("vec3").Vec3)(x, y, z));
            if (!ref) return fail(res, 404, "no reference block");
            await bot.placeBlock(ref, body.face ?? { x: 0, y: 1, z: 0 });
            return ok(res);
          }
          case "/goto": {
            const { x, y, z } = body;
            if ([x, y, z].some((v) => typeof v !== "number")) return fail(res, 400, "x,y,z required");
            const { goals, Movements } = require("mineflayer-pathfinder");
            const movements = new Movements(bot);
            bot.pathfinder.setMovements(movements);
            bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, body.range ?? 1));
            return ok(res, { pathing: true });
          }
          case "/stop": {
            bot.pathfinder?.setGoal(null);
            bot.clearControlStates();
            return ok(res);
          }
          default:
            return fail(res, 404, `unknown path ${url.pathname}`);
        }
      }

      fail(res, 405, "method not allowed");
    } catch (e) {
      fail(res, 500, e.message);
    }
  });

  server.listen(PORT, "0.0.0.0", () =>
    console.log(`[bridge] listening on 0.0.0.0:${PORT}${TOKEN ? " (auth required)" : ""}`));
}

module.exports = { startBridge };
