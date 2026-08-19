/**
 * What the design system promises every screen, checked once here so that no
 * screen has to check it again: the two themes answer to the same names, the
 * quiet controls are still big enough to hit, and a busy action stops taking
 * presses.
 */

import { render, screen, userEvent } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  AppText,
  Button,
  Chip,
  DayStrip,
  Field,
  Screen,
  TextButton,
  Toggle,
} from "../src/ui/components.tsx";
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

describe("the form controls", () => {
  it("give a typed field the same 44pt a tap target gets", async () => {
    // A box is as hard to hit as a button when it is short, and a field is the
    // control most likely to be sized by its font alone.
    await draw(
      <Field label="Step target" testID="steps" value="250" onChangeText={() => {}} compact />,
    );

    const box = screen.getByTestId("steps").parent;
    expect(StyleSheet.flatten(box?.props.style).minHeight).toBeGreaterThanOrEqual(44);
  });

  it("report a chip as selected rather than only painting it", async () => {
    const pressed = jest.fn();
    await draw(<Chip testID="mon" label="Mon" selected onPress={pressed} />);

    expect(screen.getByTestId("mon").props.accessibilityState).toMatchObject({ selected: true });
    expect(flatStyle("mon")).toMatchObject({ backgroundColor: lightTheme.colors.accent });

    await userEvent.press(screen.getByTestId("mon"));
    expect(pressed).toHaveBeenCalled();
  });

  it("announce a toggle by the statement it is agreeing to", async () => {
    // The visible wording sits beside the switch, so without this a screen
    // reader would reach an unnamed control.
    await draw(
      <Toggle
        testID="agree"
        label="I understand the deposit"
        value={false}
        onValueChange={() => {}}
      >
        <AppText>I understand the deposit</AppText>
      </Toggle>,
    );

    expect(screen.getByLabelText("I understand the deposit")).toBeOnTheScreen();
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

describe("the row of days", () => {
  it("is one thing to a screen reader rather than a mark at a time", async () => {
    // Colour is the whole of what the row says visually. Thirty unlabelled
    // squares would be thirty announcements of nothing, so the row carries the
    // sentence and the marks carry none.
    await draw(
      <DayStrip
        testID="days"
        accessibilityLabel="Your days: 2 kept, 1 still to come."
        days={[{ tone: "success" }, { tone: "success" }, { tone: "accent", outlined: true }]}
      />,
    );

    expect(screen.getByLabelText("Your days: 2 kept, 1 still to come.")).toBeOnTheScreen();
    const marks = screen.getByTestId("days").children;
    expect(marks).toHaveLength(3);
  });

  it("draws the day being asked for as a ring, so it is not read as done", async () => {
    await draw(
      <DayStrip
        testID="days"
        accessibilityLabel="Your days: 1 kept, 1 still to come."
        days={[{ tone: "success" }, { tone: "accent", outlined: true }]}
      />,
    );

    const [kept, due] = screen.getByTestId("days").children as unknown as {
      props: { style: unknown };
    }[];
    expect(StyleSheet.flatten(kept?.props.style)).toMatchObject({
      backgroundColor: lightTheme.colors.success,
    });
    expect(StyleSheet.flatten(due?.props.style)).toMatchObject({
      borderColor: lightTheme.colors.accent,
      borderWidth: 2,
    });
  });
});
