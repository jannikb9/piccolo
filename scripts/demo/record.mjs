#!/usr/bin/env node
// Records the README demo: `pnpm demo` → docs/demo.mp4.
//
// The browser build's demo mode (src/demo) stands in for the agents; this script plays the
// reviewer with a real mouse and keyboard, captures the page at 2x, then frames the capture with
// camera moves and captions. Edit the scenes below to change the story's pacing, and
// src/demo/story.ts to change its code and comments.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT_FILE = path.join(ROOT, "docs/demo.mp4");
/** The page, in CSS pixels; it's captured at twice that. Wide enough for the toolbar's labels. */
const VIEW = { width: 1680, height: 1050 };
const SCALE = 2;
/** The video. Same aspect ratio as the page. */
const OUT = { width: 1920, height: 1200, fps: 30 };
const WIDE = { x: 0, y: 0, w: VIEW.width, h: VIEW.height };

const now = () => Date.now() / 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);

// Typing rhythm varies, but the same way on every run.
let seed = 7;
const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

// --- Recording ------------------------------------------------------------------------------

const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), "piccolo-demo-"));
const server = await createServer({ root: ROOT, logLevel: "error", server: { port: 1431, strictPort: true } });
await server.listen();

// Headless Chromium captures at 1x unless the device scale is forced.
const browser = await chromium.launch({ args: [`--force-device-scale-factor=${SCALE}`] });
const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: SCALE, colorScheme: "dark" });
const page = await context.newPage();
page.on("pageerror", (error) => console.error("Page error:", error.message));
await page.goto("http://localhost:1431/?demo");
await page.waitForFunction(() => window.demo && document.querySelector("[data-file-path]"));
await page.evaluate(() => document.fonts.ready);
let mouse = { x: 900, y: 600 };
await page.mouse.move(mouse.x, mouse.y);
await sleep(800);

const frames = [];
const writes = [];
const cdp = await context.newCDPSession(page);
cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
  const file = path.join(frameDir, `${frames.length}.jpg`);
  frames.push({ t: metadata.timestamp, file });
  writes.push(fs.promises.writeFile(file, Buffer.from(data, "base64")));
  cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 95, maxWidth: VIEW.width * SCALE, maxHeight: VIEW.height * SCALE });

/** Camera moves and captions, timed like the frames. */
const shots = [];
const captions = [];

/** How fast the video plays from here on: marketing time, fast-forwarding the routine parts. */
const paces = [];

const camera = (rect, ms = 650) => shots.push({ t: now(), rect, ms });
const caption = (text) => captions.push({ t: now(), text });
const pace = (rate) => paces.push({ t: now(), rate });

/** A camera rectangle around `box` (CSS pixels) at `zoom`, kept inside the page. */
function around(box, zoom, { dx = 0, dy = 0 } = {}) {
  const w = VIEW.width / zoom;
  const h = VIEW.height / zoom;
  const cx = box.x + box.width / 2 + dx;
  const cy = box.y + box.height / 2 + dy;
  return { x: clamp(cx - w / 2, 0, VIEW.width - w), y: clamp(cy - h / 2, 0, VIEW.height - h), w, h };
}

async function box(target) {
  const b = await target.boundingBox();
  if (!b) throw new Error(`Not on screen: ${target}`);
  return b;
}

/** Points the camera at `target` (a locator or a box). */
async function look(target, zoom, options = {}) {
  const b = typeof target.boundingBox === "function" ? await box(target) : target;
  camera(around(b, zoom, options), options.ms);
}

/** Glides the pointer to `target` (a locator or a point) along an eased path. */
async function moveTo(target, { ms, offset = { x: 0.5, y: 0.5 } } = {}) {
  let to = target;
  if (typeof target.boundingBox === "function") {
    const b = await box(target);
    to = { x: b.x + b.width * offset.x, y: b.y + b.height * offset.y };
  }
  const from = mouse;
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const duration = ms ?? clamp(200 + distance * 0.3, 220, 500);
  // A slight arc, like a hand moving a mouse.
  const bend = { x: -(to.y - from.y) * 0.08, y: (to.x - from.x) * 0.08 };
  const start = performance.now();
  for (;;) {
    const p = clamp((performance.now() - start) / duration, 0, 1);
    const e = ease(p);
    const arc = Math.sin(Math.PI * e);
    await page.mouse.move(from.x + (to.x - from.x) * e + bend.x * arc, from.y + (to.y - from.y) * e + bend.y * arc);
    if (p === 1) break;
    await sleep(8);
  }
  mouse = to;
}

async function click(target, options) {
  await moveTo(target, options);
  await sleep(70);
  await page.mouse.down();
  await sleep(60);
  await page.mouse.up();
  await sleep(60);
}

/** A click the viewer should notice: at normal speed, after a beat of hovering. */
async function press(target) {
  const rate = paces.at(-1)?.rate ?? 1;
  pace(1);
  await moveTo(target);
  await sleep(300);
  await click(target);
  await sleep(350);
  pace(rate);
}

async function type(text) {
  for (const char of text) {
    await page.keyboard.type(char);
    // Fast-forwarded, like the rest.
    await sleep(char === " " ? 18 + random() * 14 : 8 + random() * 12);
  }
}

/** Scrolls the diff by `dy` pixels, smoothly; the pointer has to be over it. */
async function scrollDiff(dy, ms = 700) {
  const steps = Math.max(1, Math.round(ms / 16));
  let done = 0;
  for (let i = 1; i <= steps; i++) {
    const target = Math.round(dy * ease(i / steps));
    await page.mouse.wheel(0, target - done);
    done = target;
    await sleep(16);
  }
  await sleep(60);
}

/** Scrolls the diff until `target` sits `y` pixels from the top of the page. */
async function scrollTo(target, y, ms) {
  // The diff only renders what's near the screen: scroll down until the target exists.
  for (let i = 0; i < 20 && (await target.count()) === 0; i++) await scrollDiff(500, 150);
  const b = await box(target);
  await scrollDiff(b.y - y, ms);
}

/** Has an agent do something (see `demo` in src/demo/index.ts). */
const agent = (action, ...args) => page.evaluate(([action, args]) => window.demo[action](...args), [action, args]);

const fileHeader = (file) => page.locator(`[data-file-path="${file}"]`);
const fileDiff = (file) => page.locator("diffs-container", { has: fileHeader(file) });
const card = (text) => page.locator("div.group", { hasText: text }).first();

// --- The story ------------------------------------------------------------------------------

const start = now();
try {
  const diff = page.locator("main");
  const header = page.locator("main header");
  const agents = header.getByRole("button", { name: "Agents on this branch" });
  const review = header.getByRole("button", { name: "Review", exact: true });

  pace(1);
  caption("Review your agents' work like a pull request");
  await sleep(1300);
  pace(1.6);

  // 1. Claude has added knight moves in a worktree of its own, and is still connected to it.
  caption("Claude adds knight moves to a chess engine");
  await moveTo({ x: 1100, y: 620 });
  await look(diff, 1.45, { dy: -20 });
  await sleep(700);
  caption("Claude and Codex are connected to it");
  await look(agents, 2.8, { dx: -220, dy: 110 });
  await moveTo(agents);
  await sleep(1100);

  // 2. Ask Codex for a review: it reviewed before, so Review goes straight to it.
  caption("Ask Codex for a review");
  await press(review);
  await agent("codexStarts");
  await sleep(600);

  // 3. Codex's comments land on the lines they're about.
  caption("Codex comments on the lines");
  await moveTo({ x: 1150, y: 700 }, { ms: 300 });
  await look(diff, 1.45, { dy: -20 });
  await agent("codexComments", "board");
  await sleep(700);
  await agent("codexComments", "own");
  await sleep(500);
  await agent("codexFinishes");
  const offBoard = card("aren't skipped");
  await look(offBoard, 2, { dy: 40 });
  pace(1.2);
  await sleep(1500);
  pace(1.6);

  // 4. The reviewer adds a comment of their own.
  caption("Add your own comments");
  const lastLine = fileDiff("test/knight.test.ts").locator('[data-column-number="8"]').first();
  await scrollTo(lastLine, 430, 600);
  await look(lastLine, 2, { dx: 380, dy: 80 });
  await moveTo(lastLine);
  await click(fileDiff("test/knight.test.ts").locator("[data-utility-button]"));
  await type("Add a test for a knight in the corner.");
  await sleep(250);
  await press(page.getByRole("button", { name: "Comment", exact: true }));

  // 5. Send the comments back to Claude.
  caption("Send them to Claude");
  const address = header.getByRole("button", { name: /^Address/ });
  await look(address, 2.8, { dx: -200, dy: 110 });
  await press(address);
  await agent("claudeWorks");
  await sleep(700);

  // 6. Claude makes the changes and answers each comment, the reviewer's last.
  caption("Claude makes the changes and replies");
  // Out of the way of the replies, beside the diff.
  await moveTo({ x: 1590, y: 820 }, { ms: 300 });
  camera(WIDE, 600);
  await agent("claudeFixes");
  await scrollDiff(-2000, 400);
  await look(diff, 1.45, { dy: -20 });
  await agent("claudeReplies", "board");
  await sleep(500);
  await agent("claudeReplies", "own");
  await sleep(500);
  const newTest = fileDiff("test/knight.test.ts").locator('[data-column-number="10"]').first();
  await scrollTo(newTest, 300, 700);
  await look(newTest, 1.8, { dx: 380, dy: 160 });
  await sleep(300);
  await agent("claudeReplies", "reviewer");
  await agent("claudeDone");
  pace(1);
  await sleep(2800);
} catch (error) {
  // Shows where the story got stuck.
  await page.screenshot({ path: path.join(os.tmpdir(), "piccolo-demo-error.png") });
  console.error(`Stuck; see ${path.join(os.tmpdir(), "piccolo-demo-error.png")}`);
  await browser.close();
  await server.close();
  throw error;
}
const end = now();

await cdp.send("Page.stopScreencast");
await Promise.all(writes);
await browser.close();
await server.close();
console.log(`Recorded ${frames.length} frames over ${(end - start).toFixed(1)}s`);

// --- Framing --------------------------------------------------------------------------------

const lerp = (a, b, p) => a + (b - a) * p;
/** Zooms change size exponentially, so they feel even. */
function mix(a, b, p) {
  const w = a.w * (b.w / a.w) ** p;
  const h = (w * VIEW.height) / VIEW.width;
  const cx = lerp(a.x + a.w / 2, b.x + b.w / 2, p);
  const cy = lerp(a.y + a.h / 2, b.y + b.h / 2, p);
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}
/** Where the camera is at `t`, considering the first `upto` moves. */
function cameraAt(t, upto = shots.length) {
  let rect = WIDE;
  for (let i = 0; i < upto && shots[i].t <= t; i++) {
    rect = mix(shots[i].from, shots[i].rect, ease(clamp((t - shots[i].t) / (shots[i].ms / 1000), 0, 1)));
  }
  return rect;
}
// A move starts from wherever the camera was, which may be partway through the one before.
for (let i = 0; i < shots.length; i++) shots[i].from = cameraAt(shots[i].t, i);

/** The caption at `t`, and how visible it is: it fades in, and out before the next one. */
function captionAt(t) {
  const i = captions.findLastIndex((c) => c.t <= t);
  if (i === -1 || !captions[i].text) return null;
  const next = captions[i + 1]?.t ?? end + 10;
  const alpha = Math.min(clamp((t - captions[i].t) / 0.3, 0, 1), clamp((next - t) / 0.25, 0, 1));
  return { text: captions[i].text, alpha };
}

const compositor = await chromium.launch();
const canvasPage = await compositor.newPage();
const fontFile = path.join(ROOT, "node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2");
await canvasPage.route("http://demo.local/**", (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: compositorPage() });
  if (url.pathname === "/inter.woff2") return route.fulfill({ contentType: "font/woff2", body: fs.readFileSync(fontFile) });
  return route.fulfill({ contentType: "image/jpeg", body: fs.readFileSync(path.join(frameDir, path.basename(url.pathname))) });
});
await canvasPage.goto("http://demo.local/");
await canvasPage.evaluate(() => document.fonts.load("600 34px Inter"));

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
const ffmpeg = spawn(
  "ffmpeg",
  ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(OUT.fps), "-c:v", "mjpeg", "-i", "-",
    "-c:v", "libx264", "-preset", "slow", "-crf", "27", "-pix_fmt", "yuv420p", "-movflags", "+faststart", OUT_FILE],
  { stdio: ["pipe", "inherit", "inherit"] },
);
const finished = new Promise((resolve, reject) => ffmpeg.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`)))));

/** What to draw at `t`: the latest frame captured by then, where the camera is, the caption. */
function sceneAt(t) {
  const index = Math.max(0, frames.findLastIndex((f) => f.t <= t));
  const cam = cameraAt(t);
  return {
    src: `/${path.basename(frames[index].file)}`,
    crop: { x: cam.x * SCALE, y: cam.y * SCALE, w: cam.w * SCALE, h: cam.h * SCALE },
    caption: captionAt(t),
  };
}

// The moment each video frame shows, sped up as `pace` says.
const times = [];
for (let t = start; t < end; t += (paces.findLast((p) => p.t <= t)?.rate ?? 1) / OUT.fps) times.push(t);
const total = times.length;
for (let i = 0; i < total; i++) {
  const t = times[i];
  const jpeg = await canvasPage.evaluate((scene) => window.render(scene), sceneAt(t));
  if (!ffmpeg.stdin.write(Buffer.from(jpeg, "base64"))) await new Promise((resolve) => ffmpeg.stdin.once("drain", resolve));
  if (i % OUT.fps === 0) process.stdout.write(`\rFraming ${Math.round((i / total) * 100)}%`);
}
ffmpeg.stdin.end();
await finished;
await compositor.close();
fs.rmSync(frameDir, { recursive: true, force: true });
console.log(`\rWrote ${path.relative(ROOT, OUT_FILE)}: ${(total / OUT.fps).toFixed(1)}s, ${(fs.statSync(OUT_FILE).size / 1e6).toFixed(1)} MB`);


/** The page that draws each video frame: a crop of a captured frame, then the caption. */
function compositorPage() {
  return /* html */ `<!doctype html>
<style>@font-face { font-family: Inter; src: url(/inter.woff2); font-weight: 100 900; }</style>
<canvas width="${OUT.width}" height="${OUT.height}"></canvas>
<script>
  const canvas = document.querySelector("canvas");
  let loaded = { src: null, img: null };
  async function image(src) {
    if (loaded.src !== src) {
      const img = new Image();
      img.src = src;
      await img.decode();
      loaded = { src, img };
    }
    return loaded.img;
  }
  async function draw(target, { src, crop, caption }) {
    const c = target.getContext("2d");
    c.imageSmoothingQuality = "high";
    c.drawImage(await image(src), crop.x, crop.y, crop.w, crop.h, 0, 0, target.width, target.height);
    if (!caption) return;
    c.save();
    c.globalAlpha = caption.alpha;
    c.font = "600 34px Inter";
    const width = c.measureText(caption.text).width + 64;
    const height = 70;
    const x = (target.width - width) / 2;
    const y = target.height - height - 46 + (1 - caption.alpha) * 10;
    c.fillStyle = "rgba(13, 17, 23, 0.88)";
    c.strokeStyle = "rgba(255, 255, 255, 0.14)";
    c.lineWidth = 2;
    c.beginPath();
    c.roundRect(x, y, width, height, height / 2);
    c.fill();
    c.stroke();
    c.fillStyle = "#f0f6fc";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(caption.text, target.width / 2, y + height / 2 + 1);
    c.restore();
  }
  window.render = async (scene) => {
    await draw(canvas, scene);
    return canvas.toDataURL("image/jpeg", 0.96).slice("data:image/jpeg;base64,".length);
  };
</script>`;
}
