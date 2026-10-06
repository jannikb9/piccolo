#!/usr/bin/env node
// Records the README demo: `pnpm demo` → docs/demo.mp4, and docs/demo.gif from it for the README.
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
const GIF_FILE = path.join(ROOT, "docs/demo.gif");
/** The README's width on GitHub, and a frame rate that keeps the GIF near 10 MB. */
const GIF = { width: 880, fps: 12 };
/** The page, in CSS pixels; it's captured at twice that. Wide enough for the toolbar's labels. */
const VIEW = { width: 1680, height: 1050 };
const SCALE = 2;
/** The video. Same aspect ratio as the page. */
const OUT = { width: 1920, height: 1200, fps: 30 };
const WIDE = { x: 0, y: 0, w: VIEW.width, h: VIEW.height };
/** At the end the video fades back to its first frame, so it loops. */
const LOOP_FADE = 0.4;

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
  const sidebar = page.locator("aside");
  const diff = page.locator("main");
  const agents = page.getByRole("button", { name: "Agents on this branch" });
  const panel = page.locator("[data-radix-popper-content-wrapper]");

  pace(1);
  caption("Review your agents' work like a pull request");
  await sleep(1600);
  pace(1.75);

  // 1. Claude builds a feature in a worktree of its own.
  caption("Claude builds a feature in its own worktree");
  await look(sidebar, 2.2, { dy: -280, dx: 60 });
  await sleep(500);
  await agent("claudeStarts");
  await sleep(700);
  await agent("claudeCommits");
  await sleep(600);

  // 2. The reviewer opens it.
  caption("Open it to review the changes");
  await click(page.locator("aside button", { hasText: "feat/login-rate-limit" }));
  camera(WIDE);
  await moveTo({ x: 1100, y: 600 });
  await look(diff, 1.4, { dy: -40 });
  await sleep(500);
  await scrollDiff(420, 700);
  await sleep(200);
  await scrollDiff(-420, 450);

  // 3. Claude is on the branch; ask Codex for a review.
  caption("Ask Codex for a review");
  await look(agents, 2.3, { dx: -260, dy: 150 });
  await click(agents);
  await sleep(700);
  await click(panel.getByRole("button", { name: /Codex app/ }));
  await sleep(350);
  await agent("codexStarts");
  await sleep(600);
  await page.keyboard.press("Escape");

  // 4. Codex reviews: comments land on the lines they're about.
  caption("Codex reviews it line by line");
  await moveTo({ x: 1150, y: 640 }, { ms: 300 });
  await look(diff, 1.3, { dy: 30 });
  await agent("codexComments", "nit");
  await sleep(450);
  // Down to the route, where the next comments land, then back up for the summary.
  await scrollTo(fileHeader("src/routes/login.ts"), 300, 450);
  await agent("codexComments", "retry");
  await sleep(450);
  await agent("codexComments", "bug");
  await sleep(700);
  await scrollDiff(-2000, 450);
  await agent("codexFinishes");
  await sleep(600);

  // 5. The reviewer curates the review.
  caption("Delete what you don't need, upvote good catches");
  const nit = card("windowStart");
  await scrollTo(nit, 340, 400);
  await look(nit, 2, { ms: 600 });
  await moveTo(nit, { offset: { x: 0.6, y: 0.45 } });
  await click(nit.getByRole("button", { name: "Delete thread" }));
  await sleep(200);
  await click(nit.getByRole("button", { name: "Delete thread" }));
  await sleep(350);
  const retry = card("Retry-After");
  await scrollTo(retry, 300, 450);
  await look(retry, 1.8, { dy: 120 });
  await click(retry.getByRole("button", { name: "Thumbs up" }));
  await sleep(150);
  await click(card("successful logins count too").getByRole("button", { name: "Thumbs up" }));
  await sleep(450);

  // 6. The reviewer adds a comment of their own.
  caption("Add your own comments");
  const testLine = fileDiff("test/rate-limit.test.ts").locator('[data-column-number="7"]').first();
  await scrollTo(testLine, 420, 450);
  await look(testLine, 1.9, { dx: 360, dy: 70 });
  await moveTo(testLine);
  await click(fileDiff("test/rate-limit.test.ts").locator("[data-utility-button]"));
  await type("Also test that a successful login resets the count.");
  await sleep(250);
  await click(page.getByRole("button", { name: "Comment", exact: true }));
  await sleep(400);

  // 7. Send the review to Claude.
  caption("Send it all to Claude");
  const implement = page.locator("main header").getByRole("button", { name: /^Implement/ });
  await look(implement, 2.1, { dx: -240, dy: 150 });
  await click(implement);
  await sleep(500);
  await agent("claudeWorks");
  await sleep(500);

  // 8. Claude fixes the code and answers each comment.
  caption("Claude fixes the code and replies");
  await moveTo({ x: 1150, y: 640 }, { ms: 300 });
  camera(WIDE, 600);
  await agent("claudeFixes");
  await scrollTo(fileHeader("src/routes/login.ts"), 130, 500);
  await look(diff, 1.35, { dy: 40 });
  await agent("claudeReplies", "retry");
  await sleep(350);
  await agent("claudeReplies", "bug");
  await sleep(350);
  await agent("claudeReplies", "reviewer");
  await agent("claudeDone");
  const answer = card("Good catch");
  await scrollTo(answer, 520, 450);
  await look(answer, 1.9, { dy: -60, ms: 600 });
  await sleep(300);
  pace(1);
  await sleep(1300);
  pace(1.75);

  // 9. And around again.
  caption("Then go another round");
  await look(agents, 2.3, { dx: -260, dy: 150, ms: 600 });
  await click(agents);
  await sleep(400);
  await click(panel.getByRole("button", { name: "Review", exact: true }));
  await sleep(700);
  camera(WIDE, 700);
  await sleep(900);
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
await canvasPage.evaluate((scene) => window.keepAsFirst(scene), sceneAt(start));
for (let i = 0; i < total; i++) {
  const t = times[i];
  const fade = clamp((i - (total - LOOP_FADE * OUT.fps)) / (LOOP_FADE * OUT.fps), 0, 1);
  const jpeg = await canvasPage.evaluate(([scene, fade]) => window.render(scene, fade), [sceneAt(t), fade]);
  if (!ffmpeg.stdin.write(Buffer.from(jpeg, "base64"))) await new Promise((resolve) => ffmpeg.stdin.once("drain", resolve));
  if (i % OUT.fps === 0) process.stdout.write(`\rFraming ${Math.round((i / total) * 100)}%`);
}
ffmpeg.stdin.end();
await finished;
await compositor.close();
fs.rmSync(frameDir, { recursive: true, force: true });
console.log(`\rWrote ${path.relative(ROOT, OUT_FILE)}: ${(total / OUT.fps).toFixed(1)}s, ${(fs.statSync(OUT_FILE).size / 1e6).toFixed(1)} MB`);

// The GIF plays by itself in the README, where GitHub shows videos only once uploaded by hand.
const palette = "split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle";
await new Promise((resolve, reject) =>
  spawn("ffmpeg", ["-y", "-loglevel", "error", "-i", OUT_FILE, "-vf", `fps=${GIF.fps},scale=${GIF.width}:-1:flags=lanczos,${palette}`, GIF_FILE], { stdio: "inherit" })
    .on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`)))),
);
console.log(`Wrote ${path.relative(ROOT, GIF_FILE)}: ${(fs.statSync(GIF_FILE).size / 1e6).toFixed(1)} MB`);

/** The page that draws each video frame: a crop of a captured frame, then the caption. */
function compositorPage() {
  return /* html */ `<!doctype html>
<style>@font-face { font-family: Inter; src: url(/inter.woff2); font-weight: 100 900; }</style>
<canvas width="${OUT.width}" height="${OUT.height}"></canvas>
<script>
  const canvas = document.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  const first = document.createElement("canvas");
  first.width = canvas.width;
  first.height = canvas.height;
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
  window.keepAsFirst = (scene) => draw(first, scene);
  window.render = async (scene, fade) => {
    await draw(canvas, scene);
    if (fade > 0) {
      ctx.globalAlpha = fade;
      ctx.drawImage(first, 0, 0);
      ctx.globalAlpha = 1;
    }
    return canvas.toDataURL("image/jpeg", 0.96).slice("data:image/jpeg;base64,".length);
  };
</script>`;
}
