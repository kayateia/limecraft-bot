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

/** Idle time after which the whole browser is torn down (frees its RAM). */
const BROWSER_IDLE_MS = 5 * 60 * 1000;
/** Time between idle-watchdog checks. */
const IDLE_CHECK_MS = 60 * 1000;

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

/**
 * Headless-Chromium screenshot pipeline over the prismarine-viewer web UI.
 *
 * CPU discipline matters here: the viewer page runs a requestAnimationFrame
 * WebGL loop, and WebGL under swiftshader is *software* rendering on the CPU.
 * A page left open would peg cores forever even when nothing changes (this
 * actually happened: an overnight 100% CPU burn). So the viewer page lives
 * only for the duration of one snapshot and is destroyed the moment the PNG
 * is captured. Between snapshots there are zero open tabs; the bare browser
 * is torn down by an idle watchdog a few minutes after its last use.
 */
export class Vision {
  private bot: Bot;
  private browser: Browser | null = null;
  private lastBrowserUse = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  /** Serializes snapshots; concurrent requests share one capture. */
  private inFlight: Promise<Buffer> | null = null;

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
    console.log(`[vision] viewer web server on :${config.viewPort} (pages load per-snapshot only)`);
  }

  /** Launch the browser if needed and arm the idle watchdog. */
  private async ensureBrowser(): Promise<Browser> {
    if (!this.browser) {
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
      console.log("[vision] chromium launched");
    }
    this.lastBrowserUse = Date.now();
    if (!this.idleTimer) {
      this.idleTimer = setInterval(() => void this.reapIdleBrowser(), IDLE_CHECK_MS);
      this.idleTimer.unref();
    }
    return this.browser;
  }

  /** Close the browser when it has been unused for BROWSER_IDLE_MS. */
  private async reapIdleBrowser(): Promise<void> {
    if (!this.browser || this.inFlight) return;
    if (Date.now() - this.lastBrowserUse < BROWSER_IDLE_MS) return;
    console.log("[vision] chromium idle, closing");
    await this.close();
  }

  /**
   * Load a fresh viewer page. The page is created per snapshot and closed in
   * the caller's `finally`, so the WebGL render loop never outlives a capture.
   */
  private async loadViewerPage(browser: Browser): Promise<Page> {
    const page = await browser.newPage();
    try {
      const { x, y, z } = config.cameraOffset;
      await page.evaluateOnNewDocument(`window.__COX=${x};window.__COY=${y};window.__COZ=${z};`);
      await page.goto(`http://localhost:${config.viewPort}/`, { waitUntil: "networkidle2", timeout: 60_000 });
      // Allow chunks to stream in and meshes to build before the first frame.
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      return page;
    } catch (error) {
      // Never leak a half-loaded viewer page: it would keep rendering.
      await page.close().catch(() => {});
      throw error;
    }
  }

  /**
   * Capture a PNG of the world. When `moveTo` is given the bot walks there
   * first (so the camera ends up framing that area). Overlapping calls wait
   * for and reuse the running capture.
   */
  async snapshot(options: { moveTo?: { x: number; y: number; z: number }; refresh?: boolean } = {}): Promise<Buffer> {
    if (!this.bot.entity) throw new Error("bot has not spawned yet");
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.capture(options);
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  /** One full capture cycle: move, render, shoot, tear the page down. */
  private async capture(options: { moveTo?: { x: number; y: number; z: number }; refresh?: boolean }): Promise<Buffer> {
    if (options.moveTo) {
      const { x, y, z } = options.moveTo;
      await gotoNear(this.bot, x, y, z, 3);
    }

    const browser = await this.ensureBrowser();
    const page = await this.loadViewerPage(browser);
    try {
      // Let the camera settle after any movement before capturing.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      const shot = await withTimeout(page.screenshot({ type: "png" }), 30_000, "screenshot");
      this.lastBrowserUse = Date.now();
      return Buffer.isBuffer(shot) ? shot : Buffer.from(shot);
    } finally {
      // Destroy the render loop immediately; never wait on this failing.
      await page.close().catch(() => {});
      console.log("[vision] viewer page closed (render loop stopped)");
    }
  }

  /** Close the browser and stop the watchdog (used on shutdown and reaping). */
  async close(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    await this.browser?.close().catch(() => {});
    this.browser = null;
  }
}

/** Reject if a promise takes longer than `ms`, so a hung page can't wedge the bot. */
async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
