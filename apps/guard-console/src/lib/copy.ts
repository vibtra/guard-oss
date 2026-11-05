import { toast, toastError } from "@vibtra/ui/react";

export function copyToClipboard(text: string, what: string): void {
  const clip = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (clip === undefined) {
    toastError(`${what} was not copied`, "This browser does not allow copying from the page. Select it and copy it by hand.");
    return;
  }
  clip.writeText(text).then(
    () => toast.success(`${what} copied`),
    () => toastError(`${what} was not copied`, "This browser refused the clipboard. Select it and copy it by hand."),
  );
}
