/**
 * What the design system promises every screen, checked once here so that no
 * screen has to check it again: the two themes answer to the same names, the
 * quiet controls are still big enough to hit, and a busy action stops taking
 * presses.
 */

import { act, render, screen, userEvent } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  AppText,
  Button,
  Chip,
  DayLegend,
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

  it("makes room for the software keyboard rather than letting it cover a field", async () => {
    // The setup form is taller than a phone, so its lower fields - the step
    // target, the deposit - sit exactly where the keyboard opens. Without this
    // the box being typed into, and the complaint drawn under it, are behind
    // the keys with no way to scroll them out.
    await draw(
      <Screen testID="frame">
        <AppText>Hello</AppText>
      </Screen>,
    );

    expect(screen.getByTestId("frame").props.automaticallyAdjustKeyboardInsets).toBe(true);
  });

  it("lets the keyboard be dragged away, which a number pad has no key for", async () => {
    await draw(
      <Screen testID="frame">
        <AppText>Hello</AppText>
      </Screen>,
    );

    expect(screen.getByTestId("frame").props.keyboardDismissMode).toBe("interactive");
  });

  it("carries no pull-to-refresh for a screen that did not ask for one", async () => {
    await draw(
      <Screen testID="frame">
        <AppText>Hello</AppText>
      </Screen>,
    );

    expect(screen.getByTestId("frame").props.refreshControl).toBeUndefined();
  });

  it("answers a pull down with the refresh its caller asked for", async () => {
    const asked = jest.fn();
    await draw(
      <Screen testID="frame" onRefresh={asked}>
        <AppText>Hello</AppText>
      </Screen>,
    );

    const control = screen.getByTestId("frame").props.refreshControl;
    expect(control.props.refreshing).toBe(false);
    await act(async () => {
      control.props.onRefresh();
    });

    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("holds the spinner while the refresh is in flight, in a colour that shows on either theme", async () => {
    // Both platforms' defaults are picked against a white page, so an unnamed
    // spinner is invisible on the dark theme's background.
    await draw(
      <Screen testID="frame" onRefresh={() => {}} refreshing>
        <AppText>Hello</AppText>
      </Screen>,
    );

    const control = screen.getByTestId("frame").props.refreshControl;
    expect(control.props.refreshing).toBe(true);
    expect(control.props.tintColor).toBe(lightTheme.colors.accent);
    expect(control.props.colors).toEqual([lightTheme.colors.accent]);
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

  it("asks the keyboard for a value rather than for English", async () => {
    // Every field in the app holds a time, a count or an amount. Autocorrect
    // rewrites `7am` and sentence case capitalises it, neither of which the
    // reader of that text would accept.
    await draw(<Field label="Wake up at" testID="deadline" value="7am" onChangeText={() => {}} />);

    const input = screen.getByTestId("deadline");
    expect(input.props.autoCorrect).toBe(false);
    expect(input.props.autoCapitalize).toBe("none");
  });

  it("gives a field a key that puts the keyboard away", async () => {
    // There is nothing to submit from a field - every form here is finished by
    // a button - so the return key's only useful job is to stop typing.
    await draw(<Field label="Deposit" testID="deposit" value="20" onChangeText={() => {}} />);

    const input = screen.getByTestId("deposit");
    expect(input.props.returnKeyType).toBe("done");
    expect(input.props.submitBehavior).toBe("blurAndSubmit");
  });

  it("draws one footnote under a field, ranked complaint before caution before reading", async () => {
    // A field has room for one sentence. A complaint about what was typed
    // outranks a caution about what it comes to, and both outrank the plain
    // read-back, whose value is the least urgent of the three.
    await draw(
      <Field
        label="Deposit"
        testID="deposit"
        value="200"
        onChangeText={() => {}}
        problem="Type an amount."
        caution="That is $200.00."
        reading="That is $200.00."
      />,
    );

    expect(screen.getByTestId("deposit-problem")).toBeOnTheScreen();
    expect(screen.queryByTestId("deposit-caution")).toBeNull();
    expect(screen.queryByTestId("deposit-reading")).toBeNull();
  });

  it("says a caution out loud and paints it as a warning rather than as a complaint", async () => {
    await draw(
      <Field
        label="Deposit"
        testID="deposit"
        value="200"
        onChangeText={() => {}}
        caution="That is $200.00. Check that is the amount you meant."
        reading="That is $200.00."
      />,
    );

    const caution = screen.getByTestId("deposit-caution");
    expect(caution.props.accessibilityRole).toBe("alert");
    expect(flatStyle("deposit-caution")).toMatchObject({ color: lightTheme.colors.warning });
    expect(screen.queryByTestId("deposit-reading")).toBeNull();
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

describe("the key to the row of days", () => {
  it("draws each swatch exactly as the row draws that day", async () => {
    // A legend whose green is not the row's green explains nothing.
    await draw(
      <DayLegend
        testID="legend"
        items={[
          { mark: { tone: "success" }, label: "Walked" },
          { mark: { tone: "accent", outlined: true }, label: "Due now" },
        ]}
      />,
    );

    // Queried through hidden elements on purpose: the legend is deliberately
    // out of the accessibility tree, which is also what takes it out of the
    // default query set.
    const [walked, due] = screen.getByTestId("legend", { includeHiddenElements: true })
      .children as unknown as {
      props: { children: { props: { style: unknown } }[] };
    }[];
    expect(StyleSheet.flatten(walked?.props.children[0]?.props.style)).toMatchObject({
      backgroundColor: lightTheme.colors.success,
    });
    expect(StyleSheet.flatten(due?.props.children[0]?.props.style)).toMatchObject({
      borderColor: lightTheme.colors.accent,
      borderWidth: 2,
    });
  });

  it("is not read out, because the row already says the counts in words", async () => {
    await draw(
      <DayLegend testID="legend" items={[{ mark: { tone: "success" }, label: "Walked" }]} />,
    );

    const legend = screen.getByTestId("legend", { includeHiddenElements: true });
    expect(legend).toHaveProp("accessibilityElementsHidden", true);
    expect(legend).toHaveProp("importantForAccessibility", "no-hide-descendants");
  });
});
