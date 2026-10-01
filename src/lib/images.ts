/** Screenshots pasted into comments. They're scaled down and saved as PNG files by the backend. */

export type DraftImage = { id: string; width: number; height: number; dataUrl: string };

/** What the backend takes: a base64 PNG without the data-URL prefix. */
export type ImageUpload = { width: number; height: number; data: string };

/** Retina screenshots are twice the size they look; this keeps files small enough for an agent to read. */
const MAX_SIDE = 2000;

/**
 * Images on the clipboard, if pasting should attach them. When text came along too (copied cells,
 * or an image copied from a web page), the text wins, as it would in any other field.
 */
export function clipboardImages(data: DataTransfer): File[] {
  if (data.getData("text/plain")) return [];
  return [...data.items].flatMap((item) => {
    const file = item.kind === "file" && item.type.startsWith("image/") ? item.getAsFile() : null;
    return file ? [file] : [];
  });
}

export async function prepareImage(file: File): Promise<DraftImage> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Couldn't read the image");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return { id: crypto.randomUUID(), width: canvas.width, height: canvas.height, dataUrl: canvas.toDataURL("image/png") };
  } finally {
    bitmap.close();
  }
}

export const toUpload = ({ width, height, dataUrl }: DraftImage): ImageUpload => ({
  width,
  height,
  data: dataUrl.slice(dataUrl.indexOf(",") + 1),
});
