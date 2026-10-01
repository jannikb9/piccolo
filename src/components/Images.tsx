import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useAttachment } from "../lib/queries";
import { useStore } from "../store";
import type { DraftImage } from "../lib/images";
import type { Attachment } from "../types";
import { Skeleton } from "./ui";

const NONE: DraftImage[] = [];

/** Screenshots pasted into a draft, by draft key. */
export const useDraftImages = (key: string) => useStore((s) => s.draftImages[key]) ?? NONE;

/** A picture that opens full size when clicked. */
function Viewable({ src, width, height, className }: { src: string; width: number; height: number; className: string }) {
  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>
        <button type="button" aria-label="View image" className="block cursor-zoom-in rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent">
          <img src={src} width={width} height={height} alt="" className={className} />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/70" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2 outline-none"
        >
          <Dialog.Title className="sr-only">Image</Dialog.Title>
          <img
            src={src}
            alt=""
            className="max-h-[88vh] max-w-[92vw] rounded-lg border border-border bg-bg-raised shadow-2xl shadow-black/50"
          />
          <Dialog.Close
            aria-label="Close"
            className="absolute -top-3 -right-3 grid size-7 place-items-center rounded-full border border-border bg-bg-raised text-fg-muted shadow-lg hover:text-fg"
          >
            <X className="size-4" />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const thumbnail = "max-h-32 max-w-full rounded-md border border-border-subtle bg-bg object-contain";

/** Thumbnails under a comment field, each removable until the comment is posted. */
export function DraftImages({ imageKey }: { imageKey: string }) {
  const images = useDraftImages(imageKey);
  const remove = useStore((s) => s.removeDraftImage);
  if (images.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-3 pb-2.5">
      {images.map((image) => (
        <div key={image.id} className="group/image relative">
          <Viewable src={image.dataUrl} width={image.width} height={image.height} className={thumbnail} />
          <button
            type="button"
            aria-label="Remove image"
            onClick={() => remove(imageKey, image.id)}
            className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full border border-border bg-bg-raised text-fg-muted opacity-0 shadow group-focus-within/image:opacity-100 group-hover/image:opacity-100 hover:text-fg"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Images in a posted message. */
export function MessageImages({ attachments }: { attachments: Attachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2 pl-7">
      {attachments.map((attachment) => (
        <MessageImage key={attachment.id} attachment={attachment} />
      ))}
    </div>
  );
}

function MessageImage({ attachment }: { attachment: Attachment }) {
  const { width, height } = attachment;
  const image = useAttachment(attachment.id);
  if (!image.data) {
    // Keeps the image's shape while it loads, so the diff below doesn't jump.
    const h = Math.min(128, height);
    return image.isError ? (
      <p className="text-[12px] text-fg-subtle">This image isn't available.</p>
    ) : (
      <Skeleton className="max-w-full" style={{ height: h, width: (h * width) / height }} />
    );
  }
  return <Viewable src={image.data} width={width} height={height} className={thumbnail} />;
}
