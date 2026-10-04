import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "./api";

/** Opens a comment's link in the default browser. */
export function openLink(href: string) {
  if (!/^(https?:|mailto:)/i.test(href)) return;
  if (isTauri) openUrl(href).catch(() => {});
  else window.open(href, "_blank", "noopener");
}

/**
 * A comment's text without its Markdown syntax, on one line, for previews in lists and folded
 * threads: "**Note**: use `foo`" reads "Note: use foo".
 */
export function markdownPreview(body: string): string {
  return body
    .split("\n")
    .filter((line) => !/^\s*(```|~~~|\|?\s*:?-{3,})/.test(line))
    .map((line) =>
      line
        .replace(/^\s*(#{1,6}\s+|(>\s?)+|([-*+]\s+)+(\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/(\*\*|__|~~|`)(.+?)\1/g, "$2")
        .replace(/(^|\W)[*_](\S(?:.*?\S)?)[*_](?=\W|$)/g, "$1$2")
        .replace(/^\s*\||\|\s*$/g, "")
        .replace(/\s*\|\s*/g, " · ")
        .trim(),
    )
    .filter(Boolean)
    .join(" ");
}
