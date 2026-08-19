/**
 * Saying which screen the app has just opened.
 *
 * The acceptance boundary is the second describe: a swap is announced and an
 * arrival is not. Home draws every screen it opens by re-rendering itself, so a
 * screen reader is told nothing by the platform - and a first mount is already
 * about to be read from the top, so announcing it would talk over the screen it
 * names.
 */

import { act, render, screen } from "@testing-library/react-native";
import { Text } from "react-native";
import {
  type ScreenChange,
  type ScreenReader,
  screenChangeText,
  useScreenChangeAnnouncement,
} from "../src/ui/screen-change.ts";
import { fakeScreenReader } from "./support/fake-screen-reader.ts";

function Probe({ where, reader }: { where: ScreenChange; reader: ScreenReader }) {
  useScreenChangeAnnouncement(where, reader);
  return <Text>{where.name}</Text>;
}

/** The user arriving somewhere else, without the component being rebuilt. */
async function moveTo(where: ScreenChange, reader: ScreenReader) {
  await act(async () => {
    screen.rerender(<Probe where={where} reader={reader} />);
  });
}

const HOME: ScreenChange = { name: "Home", overHome: false };
const TASK: ScreenChange = { name: "Today's walk", overHome: true };

describe("screenChangeText", () => {
  it("names the screen", () => {
    expect(screenChangeText(HOME)).toBe("Home.");
  });

  it("names the way back out of a screen sitting over home", () => {
    // The reader has just lost its place, and the control it most likely wants
    // next is the one every such screen puts at the top.
    expect(screenChangeText(TASK)).toBe("Today's walk. Back to home is at the top of the screen.");
  });

  it("gives home no way back, because it is the bottom of the app", () => {
    expect(screenChangeText(HOME)).not.toMatch(/Back to home/);
  });
});

describe("useScreenChangeAnnouncement", () => {
  it("says nothing on arrival", async () => {
    const reader = fakeScreenReader();
    await render(<Probe where={HOME} reader={reader} />);

    expect(reader.said()).toEqual([]);
  });

  it("says where the user has gone when the screen changes", async () => {
    const reader = fakeScreenReader();
    await render(<Probe where={HOME} reader={reader} />);

    await moveTo(TASK, reader);

    expect(reader.said()).toEqual(["Today's walk. Back to home is at the top of the screen."]);
  });

  it("says nothing twice for one screen", async () => {
    const reader = fakeScreenReader();
    await render(<Probe where={HOME} reader={reader} />);

    await moveTo(TASK, reader);
    // A re-render of the screen the user is already on - a step arriving, a
    // countdown ticking - is not an arrival.
    await moveTo({ ...TASK }, reader);

    expect(reader.said()).toHaveLength(1);
  });

  it("names home again on the way back", async () => {
    const reader = fakeScreenReader();
    await render(<Probe where={HOME} reader={reader} />);

    await moveTo(TASK, reader);
    await moveTo(HOME, reader);

    expect(reader.said()[1]).toBe("Home.");
  });
});
