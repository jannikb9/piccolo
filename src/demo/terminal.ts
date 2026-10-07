// A terminal window running Codex's CLI, over the app: the reviewer pastes the copied review
// prompt into it, and Codex prints its steps as it works (CODEX_STEPS in story.ts). Clicking
// outside it brings the app back to the front, as on macOS.
import { CODEX_STEPS, REPO } from "./story";

const html = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
/** Markup without the indentation between its tags, since the screen keeps whitespace. */
const markup = (source: string) => source.replace(/>\s+</g, "><").trim();

const terminal = document.createElement("div");
terminal.className = "demo-terminal";
terminal.tabIndex = -1;
terminal.innerHTML = markup(`
  <div class="demo-terminal-bar">
    <span class="demo-terminal-lights"><span></span><span></span><span></span></span>
    <span>codex — ${html(REPO)}</span>
  </div>
  <div class="demo-terminal-screen">
    <div class="demo-codex-banner">
      <div><b>&gt;_ OpenAI Codex</b>&nbsp;<span class="dim">(v0.142.0)</span></div>
      <div>&nbsp;</div>
      <div><span class="dim">model:    </span> gpt-6-astra high   <span class="cyan">/model</span><span class="dim"> to change</span></div>
      <div><span class="dim">directory:</span> ${html(REPO)}</div>
    </div>
    <div class="demo-codex-tips dim">
      <div>To get started, describe a task or try one of these commands:</div>
      <div>&nbsp;</div>
      <div><span class="fg">/init</span> - create an AGENTS.md file with instructions for Codex</div>
      <div><span class="fg">/status</span> - show current session configuration</div>
      <div><span class="fg">/model</span> - choose what model and reasoning effort to use</div>
    </div>
    <div class="demo-codex-history"></div>
    <div class="demo-codex-working" hidden><span class="demo-codex-shimmer">Working</span>&nbsp;<span class="dim">(<span data-seconds>0</span>s • esc to interrupt)</span></div>
    <div class="demo-codex-composer"><span class="cyan">›</span><span data-input></span></div>
    <div class="demo-codex-footer dim"><span>⏎ send   ⇧⏎ newline   ⌃T transcript   ⌃C quit</span><span>100% context left</span></div>
  </div>`);
document.body.append(terminal);

const $ = (selector: string) => terminal.querySelector<HTMLElement>(selector)!;
const input = $("[data-input]");
const history = $(".demo-codex-history");
const working = $(".demo-codex-working");
const PLACEHOLDER = '<span class="dim">Ask Codex to do anything</span>';
let text = "";
const showInput = () => {
  input.innerHTML = text ? html(text) : PLACEHOLDER;
};
showInput();

/** The terminal in front of the app, or behind it. */
function setFront(front: boolean) {
  terminal.classList.toggle("front", front);
  document.documentElement.toggleAttribute("data-demo-terminal-front", front);
  if (front) terminal.focus({ preventScroll: true });
}

/** Opens the terminal in front of the app, like switching to it with ⌘-Tab. */
export function openTerminal() {
  terminal.classList.add("open");
  setFront(true);
}

window.addEventListener(
  "mousedown",
  (e) => {
    if (!terminal.classList.contains("open")) return;
    setFront(terminal.contains(e.target as Node));
  },
  { capture: true },
);

// What the app last copied, for ⌘V: headless browsers don't always hand the clipboard back.
let copied: Promise<string> = Promise.resolve("");
const write = navigator.clipboard.write.bind(navigator.clipboard);
navigator.clipboard.write = (items) => {
  copied = items[0].getType("text/plain").then((blob) => blob.text());
  return write(items).catch(() => {});
};

terminal.addEventListener("keydown", (e) => {
  e.stopPropagation();
  e.preventDefault();
  if (e.metaKey && e.key.toLowerCase() === "v") {
    void copied.then((pasted) => {
      text += pasted;
      showInput();
    });
  } else if (e.key === "Enter" && text) {
    submit();
  }
});

function submit() {
  const message = document.createElement("div");
  message.className = "demo-codex-message";
  message.innerHTML = `<span class="dim">›</span><span>${html(text)}</span>`;
  history.append(message);
  text = "";
  showInput();
  working.hidden = false;
  const started = Date.now();
  setInterval(() => {
    $("[data-seconds]").textContent = String(Math.floor((Date.now() - started) / 1000));
  }, 250);
}

let printed = 0;

/** Prints Codex's next `count` steps. */
export function codexSteps(count = 1) {
  for (const step of CODEX_STEPS.slice(printed, printed + count)) {
    const line = document.createElement("div");
    line.className = "demo-codex-step";
    line.innerHTML = markup(`
      <div><span class="green">•</span>&nbsp;<b>${step.title}</b>&nbsp;${html(step.detail)}</div>
      <div class="dim">&nbsp;&nbsp;└ ${html(step.output)}</div>`);
    history.append(line);
  }
  printed += count;
}
