/**
 * limecraft-bot
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runtime configuration, entirely from environment variables so the compose
 * file stays the single source of truth for deployment.
 */

/** Parse a float env var, falling back to a default when unset/invalid. */
function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Parse an integer env var, falling back to a default when unset/invalid. */
function int(name: string, fallback: number): number {
  const parsed = num(name, fallback);
  return Math.trunc(parsed);
}

export const config = {
  /** Minecraft server hostname (resolved on the docker network). */
  mcHost: process.env.MC_HOST ?? "minecraft-offline",
  /** Minecraft server port. */
  mcPort: int("MC_PORT", 25565),
  /** Bot login name. Must match the server whitelist entry. */
  mcUsername: process.env.MC_USERNAME ?? "Lime",
  /** Protocol version; must match the server's version. */
  mcVersion: process.env.MC_VERSION ?? "1.21.4",

  /** Port for the combined REST + MCP HTTP server. */
  httpPort: int("HTTP_PORT", 3000),

  /** Port the prismarine-viewer web UI listens on (internal). */
  viewPort: int("VIEW_PORT", 3007),
  /** Chunk radius the viewer renders around the bot. */
  viewDistance: int("VIEW_DISTANCE", 4),
  /** Chromium binary for headless snapshots. */
  chromiumPath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
  /** Camera offset from the bot, in blocks (drone-style third person). */
  cameraOffset: {
    x: num("CAM_OFF_X", 20),
    y: num("CAM_OFF_Y", 20),
    z: num("CAM_OFF_Z", 20),
  },
  /** Snapshot viewport size in pixels. Kept modest to limit Chromium memory. */
  snapshotWidth: int("SNAP_WIDTH", 1024),
  snapshotHeight: int("SNAP_HEIGHT", 768),
} as const;

export type Config = typeof config;
