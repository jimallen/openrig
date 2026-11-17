import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * workspaces-o9o.116: the theme's custom font sizes (tailwind.config `theme.extend.fontSize`). tailwind-merge does not read
 * the Tailwind config, so without this list it took `text-label-sm` for an unknown text class and, in the same cn() call as
 * a text colour, kept only the later of the two: the size was dropped (the install stepper rendered at ~16px) or the colour
 * was (every table header lost its muted grey). A test keeps this list equal to the config's keys.
 */
export const CUSTOM_FONT_SIZES = [
  "display-lg",
  "headline-lg",
  "headline-md",
  "body-lg",
  "body-md",
  "body-sm",
  "label-lg",
  "label-md",
  "label-sm",
] as const;

const twMerge = extendTailwindMerge({ extend: { theme: { text: [...CUSTOM_FONT_SIZES] } } });

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
