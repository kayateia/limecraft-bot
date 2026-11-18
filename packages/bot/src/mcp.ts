/**
 * limecraft-bot
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Bot } from "mineflayer";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { EventLog } from "./events.ts";
import type { Vision } from "./vision.ts";
import {
  digAt,
  equipByName,
  findBlocks,
  findEntity,
  getBlocks,
  getState,
  gotoNear,
  lookAtPosition,
  placeAt,
  sendChat,
  stopAll,
} from "./tools.ts";

/** Everything the tools need to operate. */
export interface ToolContext {
  bot: Bot;
  events: EventLog;
  vision: Vision;
}

/** Render a JSON payload as a text result. */
function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** Render an error as an isError result (the tool layer never throws to MCP). */
function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Wrap a tool body with uniform error handling. */
async function guard(body: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> {
  try {
    return await body();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`[mcp] tool error: ${message}`);
    return errorResult(message);
  }
}

/** Register every tool on a fresh server instance. */
function registerTools(server: McpServer, ctx: ToolContext): void {
  const { bot } = ctx;

  server.registerTool(
    "get_state",
    {
      description:
        "Get the bot's position, yaw/pitch, health, food, held item, inventory, gamemode, dimension, time, and nearby entities (within 32 blocks).",
    },
    () => guard(() => json(getState(bot))),
  );

  server.registerTool(
    "get_blocks",
    {
      description: "Survey non-air blocks in a cube around the bot (radius 1-8). Cheap structured 'vision'.",
      inputSchema: { radius: z.number().optional().describe("radius in blocks, default 3, max 8") },
    },
    ({ radius }) => guard(() => json(getBlocks(bot, radius ?? 3))),
  );

  server.registerTool(
    "find_blocks",
    {
      description: "Find nearby blocks of a given type (e.g. 'oak_log', 'diamond_ore'), nearest first.",
      inputSchema: {
        blockType: z.string().describe("block name, e.g. 'stone'"),
        maxDistance: z.number().optional().describe("search radius, default 32"),
        limit: z.number().optional().describe("max results, default 10"),
      },
    },
    ({ blockType, maxDistance, limit }) =>
      guard(() => json(findBlocks(bot, blockType, maxDistance ?? 32, limit ?? 10))),
  );

  server.registerTool(
    "find_entity",
    {
      description:
        "Find the nearest entity within a radius, optionally filtered by type or player name (e.g. 'zombie', 'cow', 'Avynaria').",
      inputSchema: {
        type: z.string().optional().describe("entity type or username; omit for any"),
        maxDistance: z.number().optional().describe("search radius, default 32"),
      },
    },
    ({ type, maxDistance }) => guard(() => json(findEntity(bot, type, maxDistance ?? 32))),
  );

  server.registerTool(
    "chat",
    {
      description: "Send a chat message in-game (max 256 chars).",
      inputSchema: { message: z.string() },
    },
    ({ message }) =>
      guard(() => {
        sendChat(bot, message);
        return json({ sent: message });
      }),
  );

  server.registerTool(
    "read_events",
    {
      description:
        "Read inbound chat/system messages newer than a cursor. Response includes `head`; pass it as `after` next time to only get new messages.",
      inputSchema: { after: z.number().optional().describe("cursor from a previous call, default 0") },
    },
    ({ after }) => guard(() => json(ctx.events.since(after ?? 0))),
  );

  server.registerTool(
    "look",
    {
      description: "Look at an absolute world position.",
      inputSchema: { x: z.number(), y: z.number(), z: z.number() },
    },
    ({ x, y, z }) =>
      guard(async () => {
        await lookAtPosition(bot, x, y, z);
        return json({ lookingAt: { x, y, z } });
      }),
  );

  server.registerTool(
    "goto",
    {
      description:
        "Walk to within `range` blocks of an absolute position using pathfinding. Resolves when arrived (or throws on no path).",
      inputSchema: {
        x: z.number(),
        y: z.number(),
        z: z.number(),
        range: z.number().optional().describe("arrival distance, default 1, max 8"),
      },
    },
    ({ x, y, z, range }) =>
      guard(async () => {
        await gotoNear(bot, x, y, z, range ?? 1);
        const state = getState(bot);
        return json({ arrivedAt: state.position, target: { x, y, z } });
      }),
  );

  server.registerTool(
    "dig",
    {
      description: "Dig the block at an absolute position, approaching it first if out of reach.",
      inputSchema: { x: z.number(), y: z.number(), z: z.number() },
    },
    ({ x, y, z }) =>
      guard(async () => {
        const dug = await digAt(bot, x, y, z);
        return json({ dug, at: { x, y, z } });
      }),
  );

  server.registerTool(
    "place",
    {
      description:
        "Place a block at an absolute position using the first usable neighbour as the reference face. Optionally equip `item` (block name) first; equip results are verified.",
      inputSchema: {
        x: z.number(),
        y: z.number(),
        z: z.number(),
        face: z.string().optional().describe("preferred reference face: up|down|north|south|east|west"),
        item: z.string().optional().describe("block to equip before placing, e.g. 'sandstone'"),
      },
    },
    ({ x, y, z, face, item }) =>
      guard(async () => {
        const result = await placeAt(bot, x, y, z, face, item);
        return json({ ...result, at: { x, y, z } });
      }),
  );

  server.registerTool(
    "equip",
    {
      description: "Equip an inventory item to the hand by name, verifying the hand state afterwards.",
      inputSchema: { item: z.string() },
    },
    ({ item }) =>
      guard(async () => {
        const equipped = await equipByName(bot, item);
        return json({ equipped });
      }),
  );

  server.registerTool(
    "stop",
    { description: "Abort pathfinding and clear movement inputs." },
    () =>
      guard(() => {
        stopAll(bot);
        return json({ stopped: true });
      }),
  );

  server.registerTool(
    "snapshot",
    {
      description:
        "Capture a PNG of the world from the bot's perspective (third-person drone offset). Optionally walk to a location first; `refresh: true` forces a camera re-center.",
      inputSchema: {
        dx: z.number().optional().describe("walk toward this X first (absolute)"),
        dy: z.number().optional(),
        dz: z.number().optional(),
        refresh: z.boolean().optional(),
      },
    },
    ({ dx, dy, dz, refresh }) =>
      guard(async () => {
        const moveTo =
          dx !== undefined && dy !== undefined && dz !== undefined ? { x: dx, y: dy, z: dz } : undefined;
        const png = await ctx.vision.snapshot({ moveTo, refresh });
        return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
      }),
  );
}

/**
 * Handle one MCP request (stateless mode).
 *
 * A fresh server + transport pair is created per request with no session id:
 * this bot exposes tools only (no server-initiated notifications), so session
 * state would be pure overhead.
 */
export async function handleMcpRequest(
  ctx: ToolContext,
  req: IncomingMessage,
  res: ServerResponse,
  parsedBody?: unknown,
): Promise<void> {
  const server = new McpServer({ name: "limecraft-bot", version: "0.3.0" });
  registerTools(server, ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
}
