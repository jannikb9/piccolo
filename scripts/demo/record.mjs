#!/usr/bin/env node
// Records the README demo: `pnpm demo` → docs/demo.mp4.
//
// The browser build's demo mode (src/demo) stands in for the agents; this script plays the
// reviewer with a real mouse and keyboard, captures the page at 2x, then adds captions and
// fast-forwards the routine parts. The whole window stays in view: highlights point things out. Edit the scenes below to change the story's pacing, and
// src/demo/story.ts to change its code and comments.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createServer } from "vite";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT_FILE = path.join(ROOT, "docs/demo.mp4");
/**
 * The page, in CSS pixels; it's captured at twice that. Small, so the app is large enough in the
 * video to read at the README's width; src/demo narrows its panels so the toolbar keeps its labels.
 */
const VIEW = { width: 1280, height: 800 };
const SCALE = 2;
/** The video. Same aspect ratio as the page. */
const OUT = { width: 1920, height: 1200, fps: 30 };

/** A point on the page, as fractions of its size. */
const at = (fx, fy) => ({ x: VIEW.width * fx, y: VIEW.height * fy });
/** Beside the diff, out of the way of what happens in it. */
const aside = () => ({ x: VIEW.width - 90, y: VIEW.height * 0.78 });

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
// The reviewer copies a prompt in the app and pastes it into the demo's terminal.
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://localhost:1431" });
const page = await context.newPage();
page.on("pageerror", (error) => console.error("Page error:", error.message));
await page.goto("http://localhost:1431/?demo");
await page.waitForFunction(() => window.demo && document.querySelector("[data-file-path]"));
await page.evaluate(() => document.fonts.ready);
let mouse = at(0.54, 0.57);
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

/** Captions, timed like the frames. */
const captions = [];

/** How fast the video plays from here on: marketing time, fast-forwarding the routine parts. */
const paces = [];

const caption = (text) => captions.push({ t: now(), text });
const pace = (rate) => paces.push({ t: now(), rate });

async function box(target) {
  const b = await target.boundingBox();
  if (!b) throw new Error(`Not on screen: ${target}`);
  return b;
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

/**
 * Outlines `target` (a locator or a box) for `ms`, so the viewer sees what's about to change.
 */
async function highlight(target, ms = 1300) {
  const b = typeof target.boundingBox === "function" ? await box(target) : target;
  await page.evaluate(({ b, ms }) => window.demoHighlight(b, ms), { b, ms });
}

/** A click the viewer should notice: at normal speed, after a beat of hovering, outlined if `outline`. */
async function press(target, { outline = false } = {}) {
  const rate = paces.at(-1)?.rate ?? 1;
  pace(1);
  if (outline) await highlight(target);
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

/** The box of the first `word` in `line`'s text (CSS pixels). */
function wordBox(line, word) {
  return line.evaluate((el, word) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent.search(new RegExp(`\\b${word}\\b`));
      if (at === -1) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + word.length);
      const { x, y, width, height } = range.getBoundingClientRect();
      return { x, y, width, height };
    }
    throw new Error(`No ${word} in the line`);
  }, word);
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
  const knight = "src/moves/knight.ts";
  const test = "test/knight.test.ts";

  const pane = await box(diff);

  pace(1);
  caption("Review your agents' work like a pull request");
  await sleep(1300);
  pace(1.6);

  // 1. Claude has added knight moves in a worktree of its own.
  caption("Claude adds knight moves to a chess engine");
  await moveTo(at(0.65, 0.59));
  await sleep(1300);

  // 2. ⌘-click a name to see where it's defined, outside the diff, then come back.
  caption("⌘-click to jump to a definition");
  await moveTo(at(0.68, 0.67), { ms: 300 });
  const name = await wordBox(fileDiff(knight).locator('[data-line="14"]'), "square");
  const onName = { x: name.x + name.width / 2, y: name.y + name.height * 0.6 };
  await moveTo(onName);
  await sleep(250);
  pace(1);
  await page.keyboard.down("Meta");
  await sleep(350);
  await click(onName);
  await page.keyboard.up("Meta");
  const definition = page.getByRole("dialog", { name: /Where square is defined/ }).locator("[data-hit]").first();
  await definition.waitFor();
  pace(1.6);
  await sleep(300);
  await press(definition);
  await page.locator("[data-line]", { hasText: "square(file: number, rank: number)" }).first().waitFor();
  await moveTo({ x: pane.x + pane.width - 60, y: pane.y + pane.height - 120 }, { ms: 250 });
  await sleep(1100);
  await click(page.getByRole("button", { name: "Back (⌘[)" }));

  // 3. Only Claude is on the branch, so Review offers a prompt to copy for any agent.
  caption("Copy a review prompt for any agent");
  await press(review, { outline: true });
  await press(page.getByRole("menuitem", { name: /Copy prompt/ }));
  await sleep(300);

  // 4. Paste it into Codex, running in a terminal.
  caption("Paste it into Codex");
  await agent("openTerminal");
  const terminal = page.locator(".demo-terminal");
  await sleep(500);
  await click(terminal.locator(".demo-codex-composer"));
  await sleep(250);
  pace(1.2);
  await page.keyboard.press("Meta+V");
  await sleep(1100);
  await page.keyboard.press("Enter");
  await sleep(600);
  await agent("codexSteps", 1);
  await agent("codexJoins");
  await sleep(700);
  await agent("codexSteps", 1);
  await sleep(900);
  pace(1.6);

  // 5. Back in Piccolo, Codex is on the branch, and its comments land on the lines.
  caption("Codex joins and comments on the lines");
  // On the sidebar, beside the terminal.
  await click(at(0.1, 0.6));
  await highlight(agents, 1500);
  await moveTo(aside(), { ms: 300 });
  await sleep(900);
  await agent("codexSteps", 1);
  await agent("codexComments", "own");
  await sleep(700);
  await agent("codexSteps", 1);
  await agent("codexComments", "test");
  await sleep(500);
  await agent("codexFinishes");
  await sleep(500);

  // 6. Agree with one of Codex's comments, and add a comment of your own.
  caption("Give it a thumbs up");
  const own = card("own pieces");
  pace(1.2);
  await sleep(1300);
  pace(1.6);
  await press(own.getByRole("button", { name: "Thumbs up" }));
  await sleep(300);
  caption("Add your own comments");
  const jumps = fileDiff(knight).locator('[data-column-number="4"]').first();
  await moveTo(jumps);
  await click(fileDiff(knight).locator("[data-utility-button]"));
  await type("Let's call this `KNIGHT_JUMPS`, so it reads well next to the other pieces' moves.");
  await sleep(250);
  await press(page.getByRole("button", { name: "Comment", exact: true }));

  // 7. Send every comment to Claude.
  caption("Request changes from Claude");
  await sleep(400);
  const requestChanges = header.getByRole("button", { name: /^Request changes/ });
  await press(requestChanges, { outline: true });
  await agent("claudeWorks");
  await sleep(700);

  // 8. Claude makes the changes and answers each comment.
  caption("Claude makes the changes and replies");
  // Out of the way of the replies, beside the diff.
  await moveTo(aside(), { ms: 300 });
  await agent("claudeFixes");
  await scrollDiff(-2000, 400);
  await agent("claudeReplies", "reviewer");
  await sleep(500);
  await agent("claudeReplies", "own");
  await sleep(1000);
  const newTest = fileDiff(test).locator('[data-column-number="10"]').first();
  await scrollTo(newTest, VIEW.height * 0.5, 700);
  await sleep(300);
  await agent("claudeReplies", "test");
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

/** What to draw at `t`: the latest frame captured by then, and the caption. */
function sceneAt(t) {
  const index = Math.max(0, frames.findLastIndex((f) => f.t <= t));
  return { src: `/${path.basename(frames[index].file)}`, caption: captionAt(t) };
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


/** The page that draws each video frame: a captured frame, then the caption. */
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
  async function draw(target, { src, caption }) {
    const c = target.getContext("2d");
    c.imageSmoothingQuality = "high";
    c.drawImage(await image(src), 0, 0, target.width, target.height);
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
