/**
 * limecraft-bot
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import { config } from "./config.ts";
import { EventLog } from "./events.ts";
import { handleMcpRequest } from "./mcp.ts";
import { Vision } from "./vision.ts";
import {
  digAt,
  equipByName,
  getBlocks,
  getState,
  gotoNear,
  lookAtPosition,
  placeAt,
  sendChat,
  stopAll,
} from "./tools.ts";

const require = createRequire(import.meta.url);
const mineflayer = require("mineflayer") as typeof import("mineflayer");
const { pathfinder } = require("mineflayer-pathfinder") as {
  pathfinder: (bot: Bot) => void;
};

/** Ring buffer of inbound messages for the `read_events` tool and `/events`. */
const events = new EventLog();

/** The Mineflayer bot. One login does everything: act, see, chat. */
const bot = mineflayer.createBot({
  host: config.mcHost,
  port: config.mcPort,
  username: config.mcUsername,
  version: config.mcVersion,
});

bot.loadPlugin(pathfinder);

/** Lazily-started rendering/snapshot pipeline (needs a spawned bot). */
const vision = new Vision(bot);
const toolContext = { bot, events, vision };

// ---------------------------------------------------------------------------
// Bot event wiring
// ---------------------------------------------------------------------------

bot.once("login", () => console.log(`[bot] logged in as ${bot.username}`));

bot.once("spawn", () => {
  const position = bot.entity.position;
  console.log(`[bot] spawned at ${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}`);
  vision.start();
});

// Capture every inbound message as an event so agents can poll chat history.
bot.on("messagestr", (text: string) => {
  events.record(text);
  console.log(`[chat] ${text}`);
});

bot.on("death", () => console.log("[bot] died"));
bot.on("kicked", (reason: string) => console.log(`[bot] kicked: ${reason}`));
bot.on("error", (error: Error) => console.log(`[bot] error: ${error.message}`));
bot.on("end", async (reason: string) => {
  console.log(`[bot] disconnected: ${reason}`);
  await vision.close();
  // Let docker's restart policy bring us back; a fresh process is the cleanest
  // way to recover from protocol-level desync.
  process.exit(1);
});

// ---------------------------------------------------------------------------
// HTTP: REST endpoints for debugging + MCP over Streamable HTTP
// ---------------------------------------------------------------------------

/** Read and parse a JSON request body (1 MB cap). */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString();
      if (data.length > 1_000_000) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data) as Record<string, unknown>);
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/** Write a JSON response. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

/** Read a numeric query parameter. */
function queryNumber(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Require an object field of numeric type. */
function requireNumber(body: Record<string, unknown>, name: string): number {
  const value = body[name];
  if (typeof value !== "number") throw new Error(`field '${name}' (number) is required`);
  return value;
}

/** Route REST requests. These mirror the MCP tools for curl-based debugging. */
async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? "GET";

  if (method === "GET" && url.pathname === "/state") return sendJson(res, 200, getState(bot));
  if (method === "GET" && url.pathname === "/blocks") {
    return sendJson(res, 200, { blocks: getBlocks(bot, queryNumber(url, "radius") ?? 3) });
  }
  if (method === "GET" && url.pathname === "/events") {
    return sendJson(res, 200, events.since(queryNumber(url, "after") ?? 0));
  }
  if (method === "GET" && url.pathname === "/snapshot") {
    const dx = queryNumber(url, "dx");
    const dy = queryNumber(url, "dy");
    const dz = queryNumber(url, "dz");
    const moveTo = dx !== undefined && dy !== undefined && dz !== undefined ? { x: dx, y: dy, z: dz } : undefined;
    const png = await vision.snapshot({ moveTo, refresh: url.searchParams.has("refresh") });
    res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length });
    return void res.end(png);
  }

  if (method === "POST") {
    const body = await readJsonBody(req);
    switch (url.pathname) {
      case "/chat":
        sendChat(bot, String(body.message ?? ""));
        return sendJson(res, 200, { ok: true });
      case "/look":
        await lookAtPosition(bot, requireNumber(body, "x"), requireNumber(body, "y"), requireNumber(body, "z"));
        return sendJson(res, 200, { ok: true });
      case "/goto":
        await gotoNear(bot, requireNumber(body, "x"), requireNumber(body, "y"), requireNumber(body, "z"), Number(body.range ?? 1));
        return sendJson(res, 200, { ok: true, position: getState(bot).position });
      case "/dig":
        return sendJson(res, 200, { dug: await digAt(bot, requireNumber(body, "x"), requireNumber(body, "y"), requireNumber(body, "z")) });
      case "/place": {
        const item = typeof body.item === "string" ? body.item : undefined;
        const face = typeof body.face === "string" ? body.face : undefined;
        const placed = await placeAt(bot, requireNumber(body, "x"), requireNumber(body, "y"), requireNumber(body, "z"), face, item);
        return sendJson(res, 200, placed);
      }
      case "/equip":
        return sendJson(res, 200, { equipped: await equipByName(bot, String(body.item ?? "")) });
      case "/stop":
        stopAll(bot);
        return sendJson(res, 200, { ok: true });
      default:
        return sendJson(res, 404, { error: `unknown path ${url.pathname}` });
    }
  }

  sendJson(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/mcp") {
    const method = req.method ?? "GET";
    if (method === "POST") {
      readJsonBody(req)
        .then((body) => handleMcpRequest(toolContext, req, res, body))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.log(`[mcp] request error: ${message}`);
          if (!res.headersSent) sendJson(res, 400, { error: message });
        });
      return;
    }
    // GET (SSE stream) and DELETE (session teardown) are handled by the transport.
    handleMcpRequest(toolContext, req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`[mcp] transport error: ${message}`);
      if (!res.headersSent) sendJson(res, 500, { error: message });
    });
    return;
  }

  handleRest(req, res, url).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[http] error on ${url.pathname}: ${message}`);
    if (!res.headersSent) sendJson(res, 500, { error: message });
  });
});

server.listen(config.httpPort, "0.0.0.0", () => {
  console.log(`[http] REST + MCP on :${config.httpPort} (MCP path /mcp)`);
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[bot] ${signal} received, shutting down`);
    void vision.close().finally(() => {
      bot.quit();
      server.close();
      process.exit(0);
    });
  });
}
