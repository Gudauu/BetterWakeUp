/**
 * The press that answers a permission the app cannot grant itself.
 *
 * What matters here is that the press reaches the operating system exactly
 * once, that the button can say it is working, and that a platform which
 * refuses is reported rather than swallowed - a press that silently did
 * nothing is the worst of the three outcomes, because the user is already
 * stuck.
 */

import { act, render, screen, userEvent } from "@testing-library/react-native";
import { Text } from "react-native";
import {
  SETTINGS_UNAVAILABLE_TEXT,
  type SettingsLauncher,
  useOpenSettings,
} from "../src/device/settings.ts";
import { TextButton } from "../src/ui/components.tsx";
import { fakeSettings } from "./support/fake-settings.ts";

/** A screen with the press on it, reading its own state back out. */
function Probe({ launcher }: { launcher: SettingsLauncher }) {
  const settings = useOpenSettings(launcher);
  return (
    <>
      <TextButton testID="open" label="Open Settings" onPress={settings.open} />
      <Text testID="opening">{settings.opening ? "opening" : "idle"}</Text>
      <Text testID="failed">{settings.failed ? SETTINGS_UNAVAILABLE_TEXT : "no failure"}</Text>
    </>
  );
}

describe("useOpenSettings", () => {
  it("asks the device for its settings page once per press", async () => {
    const launcher = fakeSettings();
    await render(<Probe launcher={launcher} />);

    await userEvent.setup().press(screen.getByTestId("open"));

    expect(launcher.opened).toBe(1);
    expect(screen.getByTestId("failed")).toHaveTextContent("no failure");
  });

  it("reports the request while it is in flight", async () => {
    // The press leaves the app, and on a slow device that takes a moment; a
    // button that looked untouched would be pressed again.
    let release: (() => void) | null = null;
    const launcher: SettingsLauncher = {
      open: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    };
    await render(<Probe launcher={launcher} />);

    await userEvent.setup().press(screen.getByTestId("open"));
    expect(screen.getByTestId("opening")).toHaveTextContent("opening");

    await act(async () => {
      release?.();
    });
    expect(screen.getByTestId("opening")).toHaveTextContent("idle");
  });

  it("says so when the platform will not open its settings", async () => {
    const launcher = fakeSettings({ refuses: true });
    await render(<Probe launcher={launcher} />);

    await userEvent.setup().press(screen.getByTestId("open"));

    expect(screen.getByTestId("failed")).toHaveTextContent(
      /Open the Settings app, find BetterWakeUp/,
    );
    expect(screen.getByTestId("opening")).toHaveTextContent("idle");
  });
});
