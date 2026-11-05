import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["display", "tag", "note", "nav", "title", "code", "axis", "md", "10", "11", "12", "13", "14", "16", "18", "20", "24"] }],
      "font-weight": [{ font: ["book", "strong"] }],
      "font-family": [{ font: ["ui", "brand"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
