/**
 * limecraft-bot
 *
 * @license
 * Copyright 2026 Kayateia
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { Browser, Page } from "puppeteer-core";
import { config } from "./config.ts";
import { gotoNear } from "./tools.ts";

const require = createRequire(import.meta.url);
// These packages are CommonJS without default-export typings, so resolve them
// through createRequire and keep the interfaces narrow at the call sites.
const viewerFactory = require("prismarine-viewer") as {
  mineflayer: (bot: Bot, options: { port: number; viewDistance: number; firstPerson: boolean }) => void;
};
const puppeteer = require("puppeteer-core") as typeof import("puppeteer-core");

/**
 * Patch the prismarine-viewer web client bundle so the camera *follows* the bot.
 *
 * Upstream aims the camera at the bot exactly once (a first-shot flag) and
 * then freezes it, leaving the camera parked at `bot + (20, 20, 20)` forever
 * while the bot mesh walks away. We remove that flag and make the offset
 * configurable via `window.__CO*`, set from the CAM_OFF_* environment.
 *
 * The patch is idempotent and fails soft (warn only): if upstream ever changes
 * the bundle, the camera stays static but everything else keeps working.
 */
function patchViewerClient(): void {
  const bundlePath = require.resolve("prismarine-viewer/public/index.js");
  const source = fs.readFileSync(bundlePath, "utf8");
  const target =
    "t.y>0&&s&&(h.target.set(t.x,t.y,t.z),u.camera.position.set(t.x,t.y+20,t.z+20),h.update(),s=!1)";
  const replacement =
    "t.y>0&&(h.target.set(t.x,t.y,t.z),u.camera.position.set(t.x+(window.__COX??20),t.y+(window.__COY??20),t.z+(window.__COZ??20)),h.update())";

  if (source.includes(replacement)) {
    console.log("[vision] viewer client already patched");
    return;
  }
  if (!source.includes(target)) {
    console.warn("[vision] WARNING: viewer patch target not found; camera will stay static");
    return;
  }
  fs.writeFileSync(bundlePath, source.replace(target, replacement));
  console.log("[vision] viewer client patched: camera follows bot with configurable offset");
}

/** Headless-Chromium screenshot pipeline over the prismarine-viewer web UI. */
export class Vision {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private pageReady = false;
  private lastPagePosition: { x: number; y: number; z: number } | null = null;

  private readonly bot: Bot;

  constructor(bot: Bot) {
    this.bot = bot;
  }

  /** Start the viewer web server and patch the client bundle. Call after spawn. */
  start(): void {
    patchViewerClient();
    viewerFactory.mineflayer(this.bot, {
      port: config.viewPort,
      viewDistance: config.viewDistance,
      firstPerson: false,
    });
    console.log(`[vision] viewer web server on :${config.viewPort}`);
  }

  /**
   * Ensure a loaded screenshot page whose camera sits at the bot's current
   * position. The page is reloaded when the bot has moved more than two blocks
   * (or when `force` is set), because camera tracking on reload is what makes
   * `?dx/dy/dz` snapshots meaningful.
   */
  private async ensurePage(force = false): Promise<Page> {
    const position = this.bot.entity?.position ?? null;
    if (position && this.lastPagePosition) {
      const dx = position.x - this.lastPagePosition.x;
      const dy = position.y - this.lastPagePosition.y;
      const dz = position.z - this.lastPagePosition.z;
      const distance = Math.hypot(dx, dy, dz);
      console.log(`[vision] ensurePage: dist=${distance.toFixed(1)} force=${force}`);
      if (distance > 2 || force) this.pageReady = false;
    }
    if (this.pageReady && this.page) return this.page;

    this.lastPagePosition = position ? { x: position.x, y: position.y, z: position.z } : null;

    this.browser = await puppeteer.launch({
      executablePath: config.chromiumPath,
      args: [
        "--no-sandbox",
        "--disable-gpu-sandbox",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--disable-dev-shm-usage",
      ],
      defaultViewport: { width: config.snapshotWidth, height: config.snapshotHeight },
    });

    this.page = await this.browser.newPage();
    const { x, y, z } = config.cameraOffset;
    await this.page.evaluateOnNewDocument(`window.__COX=${x};window.__COY=${y};window.__COZ=${z};`);
    await this.page.goto(`http://localhost:${config.viewPort}/`, { waitUntil: "networkidle2", timeout: 60_000 });
    // Allow chunks to stream in and meshes to build before the first frame.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    this.pageReady = true;
    console.log("[vision] viewer page ready");
    return this.page;
  }

  /**
   * Capture a PNG of the world. When `moveTo` is given the bot walks there
   * first (so the camera ends up framing that area).
   */
  async snapshot(options: { moveTo?: { x: number; y: number; z: number }; refresh?: boolean } = {}): Promise<Buffer> {
    if (!this.bot.entity) throw new Error("bot has not spawned yet");
    if (options.moveTo) {
      const { x, y, z } = options.moveTo;
      await gotoNear(this.bot, x, y, z, 3);
    }
    const page = await this.ensurePage(options.refresh ?? false);
    // Let the camera settle after any movement before capturing.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const shot = await page.screenshot({ type: "png" });
    return Buffer.isBuffer(shot) ? shot : Buffer.from(shot);
  }

  /** Close the browser (used on shutdown). */
  async close(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
    this.page = null;
    this.pageReady = false;
  }
}
