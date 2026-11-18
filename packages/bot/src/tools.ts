/**
 * limecraft-bot
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import { Vec3 } from "vec3";
import { createRequire } from "node:module";
import type * as PathfinderModule from "mineflayer-pathfinder";

const require = createRequire(import.meta.url);
// mineflayer-pathfinder is CommonJS with an object export; resolve it through
// createRequire so named properties survive ESM interop reliably.
const { goals, Movements } = require("mineflayer-pathfinder") as {
  goals: typeof PathfinderModule.goals;
  Movements: typeof PathfinderModule.Movements;
};

/** Position of an entity, in world coordinates. */
export interface PositionJson {
  x: number;
  y: number;
  z: number;
}

/** A nearby entity as reported by {@link getState}. */
export interface EntityJson {
  id: number;
  type: string;
  username?: string;
  position: PositionJson;
}

/** Full bot/game state snapshot. */
export interface StateJson {
  username: string;
  position: PositionJson;
  yaw: number;
  pitch: number;
  health: number;
  food: number;
  heldItem: string | null;
  inventory: { name: string; count: number }[];
  gameMode: string | undefined;
  dimension: string | undefined;
  time: number | undefined;
  entities: EntityJson[];
}

/** One non-air block in a radius survey. */
export interface BlockJson {
  x: number;
  y: number;
  z: number;
  name: string;
  solid: boolean;
  distance?: number;
}

/** Throw a readable error when the bot has not spawned yet. */
function requireSpawned(bot: Bot): void {
  if (!bot.entity) throw new Error("bot has not spawned yet");
}

/** Round to two decimals for compact JSON. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Convert a Vec3-ish value to a rounded plain object. */
function positionOf(vec: { x: number; y: number; z: number }): PositionJson {
  return { x: round(vec.x), y: round(vec.y), z: round(vec.z) };
}

/** Collect the full state snapshot, including nearby entities. */
export function getState(bot: Bot): StateJson {
  requireSpawned(bot);
  const self = bot.entity!;
  const nearby: EntityJson[] = Object.values(bot.entities)
    .filter((entity) => entity.position && entity.uuid !== self.uuid)
    .filter((entity) => entity.position.distanceTo(self.position) < 32)
    .slice(0, 50)
    .map((entity) => ({
      id: entity.id,
      type: entity.name ?? entity.type,
      username: entity.username,
      position: positionOf(entity.position),
    }));

  return {
    username: bot.username,
    position: positionOf(self.position),
    yaw: round(self.yaw),
    pitch: round(self.pitch),
    health: bot.health,
    food: bot.food,
    heldItem: bot.heldItem?.name ?? null,
    inventory: bot.inventory.items().map((item) => ({ name: item.name, count: item.count })),
    gameMode: bot.game?.gameMode,
    dimension: bot.game?.dimension,
    time: bot.time?.timeOfDay,
    entities: nearby,
  };
}

/**
 * Survey non-air blocks in a cube around the bot. Cheap structured "vision":
 * enough to know what is nearby without rendering anything.
 */
export function getBlocks(bot: Bot, radius: number): BlockJson[] {
  requireSpawned(bot);
  const clamped = Math.max(1, Math.min(radius, 8));
  const origin = bot.entity!.position.floored();
  const blocks: BlockJson[] = [];
  for (let dx = -clamped; dx <= clamped; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dz = -clamped; dz <= clamped; dz++) {
        const block: Block | null = bot.blockAt(origin.offset(dx, dy, dz));
        if (!block || block.name === "air" || block.name === "cave_air") continue;
        blocks.push({
          x: block.position.x,
          y: block.position.y,
          z: block.position.z,
          name: block.name,
          solid: block.boundingBox !== "empty",
        });
      }
    }
  }
  return blocks;
}

/** Send a chat message (truncated to a sane length). */
export function sendChat(bot: Bot, message: string): void {
  bot.chat(message.slice(0, 256));
}

/** Look at an absolute world position. */
export async function lookAtPosition(bot: Bot, x: number, y: number, z: number): Promise<void> {
  await bot.lookAt(new Vec3(x, y, z), true);
}

/**
 * Equip an item by (partial) name, verifying the result.
 *
 * `bot.equip` can silently fail to move the correct item into the hand, which
 * in the past produced "successful" placements of the previously held block.
 * Verify `heldItem` after equipping and throw when it does not match.
 */
export async function equipByName(bot: Bot, itemName: string): Promise<string> {
  const item = bot.inventory
    .items()
    .find((candidate) => candidate.name === itemName || candidate.name.startsWith(itemName));
  if (!item) throw new Error(`no inventory item matching '${itemName}'`);
  await bot.equip(item, "hand");
  const held = bot.heldItem?.name;
  if (held !== item.name) {
    throw new Error(`equip failed: wanted '${item.name}', hand holds '${held ?? "nothing"}'`);
  }
  return item.name;
}

/** Dig the block at an absolute position, approaching it first if needed. */
export async function digAt(bot: Bot, x: number, y: number, z: number): Promise<string> {
  requireSpawned(bot);
  const target = bot.blockAt(new Vec3(x, y, z));
  if (!target || target.name === "air") throw new Error(`no block at (${x}, ${y}, ${z})`);

  if (!bot.canDigBlock(target) || !bot.canSeeBlock(target)) {
    const movement = new Movements(bot);
    bot.pathfinder.setMovements(movement);
    await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 2));
  }
  await bot.dig(target);

  // Vanilla silently rejects edits inside spawn protection, and the client
  // predicts the change locally before the server rejects it. Re-read after a
  // short delay and report the truth instead of a phantom success.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const remaining = bot.blockAt(new Vec3(x, y, z));
  if (remaining && remaining.name === target.name) {
    throw new Error(
      `server rejected the dig: ${target.name} at (${x}, ${y}, ${z}) is still there ` +
        "(spawn protection? not op in a protected area?)",
    );
  }
  return target.name;
}

/**
 * Place the held block at an absolute position, using the first visible
 * neighbour as the reference face. Optionally equips `itemName` first.
 */
export async function placeAt(
  bot: Bot,
  x: number,
  y: number,
  z: number,
  faceDirection?: string,
  itemName?: string,
): Promise<{ placed: string; reference: string }> {
  requireSpawned(bot);
  const target = new Vec3(x, y, z);
  const existing = bot.blockAt(target);
  if (existing && existing.name !== "air" && existing.name !== "cave_air") {
    throw new Error(`there is already a ${existing.name} at (${x}, ${y}, ${z})`);
  }

  if (itemName) await equipByName(bot, itemName);
  const heldItem = bot.heldItem?.name;
  if (!heldItem) throw new Error("nothing is held; equip a block first");

  // Faces in a sensible preference order; a caller-provided direction is tried first.
  const faces: { name: string; vector: Vec3 }[] = [
    { name: "down", vector: new Vec3(0, -1, 0) },
    { name: "north", vector: new Vec3(0, 0, -1) },
    { name: "south", vector: new Vec3(0, 0, 1) },
    { name: "east", vector: new Vec3(1, 0, 0) },
    { name: "west", vector: new Vec3(-1, 0, 0) },
    { name: "up", vector: new Vec3(0, 1, 0) },
  ];
  if (faceDirection && faceDirection !== "down") {
    const index = faces.findIndex((face) => face.name === faceDirection);
    const preferred = index > 0 ? faces[index] : undefined;
    if (preferred) {
      faces.splice(index, 1);
      faces.unshift(preferred);
    }
  }

  let lastError: string | undefined;
  for (const face of faces) {
    const reference = bot.blockAt(target.plus(face.vector));
    if (!reference || reference.name === "air" || reference.name === "cave_air") continue;

    if (!bot.canSeeBlock(reference)) {
      const movement = new Movements(bot);
      bot.pathfinder.setMovements(movement);
      await bot.pathfinder.goto(new goals.GoalNear(reference.position.x, reference.position.y, reference.position.z, 2));
    }

    await bot.lookAt(target, true);
    try {
      await bot.placeBlock(reference, face.vector.scaled(-1));
      // Same optimism trap as digging: verify the block actually appeared.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const placedBlock = bot.blockAt(target);
      if (!placedBlock || placedBlock.name === "air" || placedBlock.name === "cave_air") {
        throw new Error("server rejected the placement");
      }
      return { placed: heldItem, reference: `${face.name}:${reference.name}` };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      // Try the next face.
    }
  }

  throw new Error(
    `could not place ${heldItem} at (${x}, ${y}, ${z}): ${lastError ?? "no usable reference face"}`,
  );
}

/** Walk to within `range` blocks of a position. Resolves when the goal is reached. */
export async function gotoNear(bot: Bot, x: number, y: number, z: number, range: number): Promise<void> {
  requireSpawned(bot);
  const movement = new Movements(bot);
  bot.pathfinder.setMovements(movement);
  await bot.pathfinder.goto(new goals.GoalNear(x, y, z, Math.max(0, Math.min(range, 8))));
}

/** Abort any active pathfinding and clear held movement keys. */
export function stopAll(bot: Bot): void {
  bot.pathfinder.setGoal(null);
  bot.clearControlStates();
}

/** Find nearby blocks of a given type, nearest first. */
export function findBlocks(bot: Bot, blockType: string, maxDistance: number, limit: number): BlockJson[] {
  requireSpawned(bot);
  const origin = bot.entity!.position;
  const found = bot.findBlocks({
    matching: (block: Block) => block.name === blockType,
    maxDistance,
    count: limit,
  });
  return found
    .map((vec) => bot.blockAt(vec))
    .filter((block): block is Block => block !== null)
    .map((block) => ({
      x: block.position.x,
      y: block.position.y,
      z: block.position.z,
      name: block.name,
      solid: block.boundingBox !== "empty",
      distance: round(block.position.distanceTo(origin)),
    }))
    .sort((a, b) => a.distance - b.distance);
}

/** Find the nearest entity, optionally filtered by type name. */
export function findEntity(bot: Bot, type: string | undefined, maxDistance: number): EntityJson | null {
  requireSpawned(bot);
  const origin = bot.entity!.position;
  let best: { entity: EntityJson; distance: number } | null = null;
  for (const entity of Object.values(bot.entities)) {
    if (!entity.position || entity.uuid === bot.entity!.uuid) continue;
    const name = entity.name ?? entity.type;
    if (type && name !== type && entity.type !== type && entity.username !== type) continue;
    const distance = entity.position.distanceTo(origin);
    if (distance > maxDistance) continue;
    if (!best || distance < best.distance) {
      best = {
        distance,
        entity: { id: entity.id, type: name, username: entity.username, position: positionOf(entity.position) },
      };
    }
  }
  return best?.entity ?? null;
}
