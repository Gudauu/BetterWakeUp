/**
 * What the design system promises every screen, checked once here so that no
 * screen has to check it again: the two themes answer to the same names, the
 * quiet controls are still big enough to hit, and a busy action stops taking
 * presses.
 */

import { render, screen, userEvent } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppText, Button, Screen, TextButton } from "../src/ui/components.tsx";
import { darkTheme, lightTheme, themeFor } from "../src/ui/theme.ts";

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

async function draw(element: React.ReactElement) {
  await render(<SafeAreaProvider initialMetrics={METRICS}>{element}</SafeAreaProvider>);
}

/** The style a component actually resolved to, with the arrays flattened out. */
function flatStyle(testID: string): Record<string, unknown> {
  return StyleSheet.flatten(screen.getByTestId(testID).props.style) as Record<string, unknown>;
}

describe("the themes", () => {
  it("answer to exactly the same names", () => {
    // A screen reads colours by role, so a name present in one theme and absent
    // from the other would render as undefined rather than as anything visible.
    expect(Object.keys(darkTheme.colors).sort()).toEqual(Object.keys(lightTheme.colors).sort());
    expect(Object.keys(darkTheme.type).sort()).toEqual(Object.keys(lightTheme.type).sort());
  });

  it("give the dark theme lighter text than its background, and the light theme the reverse", () => {
    expect(brightness(darkTheme.colors.text)).toBeGreaterThan(
      brightness(darkTheme.colors.background),
    );
    expect(brightness(lightTheme.colors.text)).toBeLessThan(
      brightness(lightTheme.colors.background),
    );
  });

  it("choose light for every scheme except the one that asks for dark", () => {
    expect(themeFor("dark")).toBe(darkTheme);
    expect(themeFor("light")).toBe(lightTheme);
    expect(themeFor(null)).toBe(lightTheme);
    expect(themeFor(undefined)).toBe(lightTheme);
    // Some devices report neither.
    expect(themeFor("unspecified")).toBe(lightTheme);
  });
});

describe("the screen frame", () => {
  it("paints the theme background and keeps the content out of the safe area", async () => {
    await draw(
      <Screen testID="frame">
        <AppText>Hello</AppText>
      </Screen>,
    );

    expect(flatStyle("frame")).toMatchObject({ backgroundColor: lightTheme.colors.background });
    expect(
      StyleSheet.flatten(screen.getByTestId("frame").props.contentContainerStyle),
    ).toMatchObject({ paddingTop: METRICS.insets.top + lightTheme.space.lg });
  });
});

describe("the actions", () => {
  it("give even the quiet ones a target a finger can hit", async () => {
    // 44pt is the platform minimum; a tappable line of text is the control most
    // likely to fall under it.
    await draw(<TextButton testID="quiet" label="Refresh" onPress={() => {}} />);

    expect(flatStyle("quiet").minHeight).toBeGreaterThanOrEqual(44);
  });

  it("stop taking presses while busy and say so to a screen reader", async () => {
    const pressed = jest.fn();
    await draw(<Button testID="action" label="Sign in with Apple" busy onPress={pressed} />);

    await userEvent.press(screen.getByTestId("action"));

    expect(pressed).not.toHaveBeenCalled();
    expect(screen.getByTestId("action").props.accessibilityState).toMatchObject({
      busy: true,
      disabled: true,
    });
    // The label is what the spinner is announced as, so the button does not go
    // anonymous the moment it starts working.
    expect(screen.getByLabelText("Sign in with Apple")).toBeOnTheScreen();
  });

  it("does not take presses when disabled", async () => {
    const pressed = jest.fn();
    await draw(<Button testID="action" label="Start a challenge" disabled onPress={pressed} />);

    await userEvent.press(screen.getByTestId("action"));

    expect(pressed).not.toHaveBeenCalled();
  });
});

/** Rough perceived lightness of a `#rrggbb`, enough to tell dark from light. */
function brightness(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}
