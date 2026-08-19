/**
 * The one place the app's visual decisions are made.
 *
 * Every screen used to carry its own hex codes and its own idea of what a
 * button, a card or a muted line looks like, which meant a change to any of
 * them was a change to nine files and a guess about which ones were missed.
 * A screen now asks this module for a theme and reads values off it.
 *
 * The two themes are the same shape on purpose: a screen renders from names,
 * never from a colour scheme test, so nothing has to know which one is in
 * force. `useTheme` picks between them from the device's own setting, and a
 * device that has not said falls back to the light one.
 */

import { useColorScheme } from "react-native";

/**
 * The colour names a screen is allowed to use. Roles rather than shades - a
 * screen asks for `textMuted`, not for a grey - so that the dark theme can
 * answer with something lighter without any screen knowing.
 */
export interface ThemeColors {
  /** Behind the whole screen. */
  readonly background: string;
  /** A card or panel raised off the background. */
  readonly surface: string;
  /** A panel that wants slightly more weight than the surface, such as a stat block. */
  readonly surfaceMuted: string;
  /** The hairline around a surface. */
  readonly border: string;
  /** Body and heading text. */
  readonly text: string;
  /** Secondary text: labels, notes, anything the eye should reach second. */
  readonly textMuted: string;
  /** The brand colour, used for the primary action and for progress. */
  readonly accent: string;
  /** Text drawn on top of `accent`. */
  readonly onAccent: string;
  /** A soft wash of the accent, for banners that inform rather than warn. */
  readonly accentSoft: string;
  /** Something that needs attention but is not an error. */
  readonly warning: string;
  /** The wash behind warning text. */
  readonly warningSoft: string;
  /** A failure, and the colour of destructive actions. */
  readonly danger: string;
  /** The wash behind danger text. */
  readonly dangerSoft: string;
  /** A finished thing. */
  readonly success: string;
  /** The wash behind success text. */
  readonly successSoft: string;
  /** The unfilled part of a progress bar. */
  readonly track: string;
}

export interface Theme {
  readonly name: "light" | "dark";
  readonly colors: ThemeColors;
  /** The spacing scale. Every gap and pad in the app is one of these. */
  readonly space: Readonly<Record<"xs" | "sm" | "md" | "lg" | "xl" | "xxl", number>>;
  readonly radius: Readonly<Record<"sm" | "md" | "lg" | "pill", number>>;
  readonly type: Readonly<
    Record<"display" | "title" | "headline" | "body" | "small" | "caption", TypeStyle>
  >;
}

export interface TypeStyle {
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly fontWeight: "400" | "500" | "600" | "700";
}

const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

const RADIUS = { sm: 8, md: 12, lg: 20, pill: 999 } as const;

/**
 * One type scale for both themes. The sizes are deliberately few: a screen
 * that needs a size not on this list is usually a screen inventing a hierarchy
 * the rest of the app does not have.
 */
const TYPE = {
  display: { fontSize: 30, lineHeight: 36, fontWeight: "700" },
  title: { fontSize: 22, lineHeight: 28, fontWeight: "700" },
  headline: { fontSize: 18, lineHeight: 24, fontWeight: "600" },
  body: { fontSize: 16, lineHeight: 23, fontWeight: "400" },
  small: { fontSize: 14, lineHeight: 20, fontWeight: "400" },
  caption: { fontSize: 13, lineHeight: 18, fontWeight: "500" },
} as const satisfies Theme["type"];

/**
 * Sunrise: the product is about getting up, so the accent is the colour of
 * early light rather than the default blue of everything else on the phone.
 */
export const lightTheme: Theme = {
  name: "light",
  colors: {
    background: "#fdfaf5",
    surface: "#ffffff",
    surfaceMuted: "#f6f1e8",
    border: "#e6ded0",
    text: "#1b1713",
    textMuted: "#6b6257",
    accent: "#c2410c",
    onAccent: "#ffffff",
    accentSoft: "#fdece1",
    warning: "#8a5300",
    warningSoft: "#fbf0d9",
    danger: "#b00020",
    dangerSoft: "#fdeaed",
    success: "#166534",
    successSoft: "#e6f4ea",
    track: "#ece5d9",
  },
  space: SPACE,
  radius: RADIUS,
  type: TYPE,
};

export const darkTheme: Theme = {
  name: "dark",
  colors: {
    background: "#14120f",
    surface: "#1e1b17",
    surfaceMuted: "#262218",
    border: "#332e26",
    text: "#f7f3ec",
    textMuted: "#a9a196",
    accent: "#fb923c",
    onAccent: "#231202",
    accentSoft: "#33200f",
    warning: "#f0b45a",
    warningSoft: "#332714",
    danger: "#ff7a8a",
    dangerSoft: "#3a1b21",
    success: "#6ee7a0",
    successSoft: "#12301f",
    track: "#332e26",
  },
  space: SPACE,
  radius: RADIUS,
  type: TYPE,
};

/**
 * The theme for a colour scheme. Anything that is not the string "dark" - an
 * unset preference, or the "unspecified" a device without the setting reports -
 * is the light one, because guessing dark on a device that has not asked for it
 * is the more surprising answer.
 */
export function themeFor(scheme: string | null | undefined): Theme {
  return scheme === "dark" ? darkTheme : lightTheme;
}

/** The theme this device is asking for, re-read when the device setting changes. */
export function useTheme(): Theme {
  return themeFor(useColorScheme());
}
