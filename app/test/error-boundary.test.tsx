/**
 * What the app does when one of its own screens throws.
 *
 * The promise being checked is that a render error becomes a screen with a
 * press on it rather than a blank window: the user is told the three things
 * that survive a crash, the failure reaches the reporter without the stack
 * reaching the user, and asking for the screen back actually re-mounts it.
 */

import { render, screen, userEvent } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  createRecordingReporter,
  type RecordingReporter,
  type Report,
} from "../src/reporting/reporter.ts";
import { AppText } from "../src/ui/components.tsx";
import { AppErrorBoundary, CRASH_NOTICE } from "../src/ui/error-boundary.tsx";

const METRICS = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

const BOOM = "Cannot read properties of undefined (reading 'deadline')";

/** A screen that throws while it renders, exactly as a real defect would. */
function Broken({ throws }: { readonly throws: boolean }): React.ReactElement {
  if (throws) {
    throw new Error(BOOM);
  }
  return <AppText testID="broken-recovered">Today's walk</AppText>;
}

/**
 * React logs a caught render error through console.error. That is the harness
 * working, not the test failing, so it is silenced for the file rather than
 * left to bury the assertions.
 */
let consoleError: jest.SpyInstance;

beforeAll(() => {
  consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(() => {
  consoleError.mockRestore();
});

async function draw(element: React.ReactElement, reporter?: RecordingReporter) {
  await render(
    <SafeAreaProvider initialMetrics={METRICS}>
      <AppErrorBoundary {...(reporter === undefined ? {} : { reporter })}>
        {element}
      </AppErrorBoundary>
    </SafeAreaProvider>,
  );
}

describe("a screen that renders", () => {
  it("is left alone by the boundary", async () => {
    await draw(<Broken throws={false} />);

    expect(screen.getByTestId("broken-recovered")).toBeOnTheScreen();
    expect(screen.queryByTestId("app-crashed")).toBeNull();
  });
});

describe("a screen that throws", () => {
  it("becomes a screen naming what survived the failure", async () => {
    await draw(<Broken throws={true} />);

    expect(screen.getByTestId("app-crashed")).toBeOnTheScreen();
    expect(screen.getByTestId("app-crashed-challenge")).toHaveTextContent(/carries on/);
    expect(screen.getByTestId("app-crashed-walks")).toHaveTextContent(/still saved/);
    expect(screen.getByTestId("app-crashed-alarms")).toHaveTextContent(/will still sound/);
  });

  it("shows the user nothing of the error itself", async () => {
    await draw(<Broken throws={true} />);

    // A stack trace names a module and a line, which is for whoever fixes it.
    expect(screen.queryByText(BOOM)).toBeNull();
    expect(JSON.stringify(screen.toJSON())).not.toContain("Cannot read properties");
  });

  it("reports the exception through the crash reporter", async () => {
    const reporter = createRecordingReporter();

    await draw(<Broken throws={true} />, reporter);

    expect(reporter.reports).toHaveLength(1);
    const { report, error } = reporter.reports[0] as { report: Report; error?: unknown };
    expect(report).toEqual({
      name: "app.render_failed",
      severity: "error",
      fields: { operation: "appRender" },
    });
    expect((error as Error).message).toBe(BOOM);
  });

  it("offers no press that only fails again silently", async () => {
    await draw(<Broken throws={true} />);

    expect(screen.getByTestId("app-crashed-retry")).toHaveTextContent(CRASH_NOTICE.retry);
    // The close-the-app instruction is for a retry that has already failed;
    // saying it first would be telling someone to give up before trying.
    expect(screen.queryByTestId("app-crashed-persisted")).toBeNull();
  });
});

describe("asking for the screen back", () => {
  it("mounts it again, so a failure the app can recover from is recovered from", async () => {
    // A screen that threw on a value it had half-read renders on the retry,
    // which is the whole reason the press exists. The flag lives outside the
    // tree because the boundary unmounts the children it caught, so anything
    // the screen itself held is gone by the time the press lands.
    const control = { failing: true };
    function Flaky() {
      if (control.failing) {
        throw new Error(BOOM);
      }
      return <AppText testID="broken-recovered">Today's walk</AppText>;
    }

    await draw(<Flaky />);
    expect(screen.getByTestId("app-crashed")).toBeOnTheScreen();

    control.failing = false;
    await userEvent.press(screen.getByTestId("app-crashed-retry"));

    expect(screen.getByTestId("broken-recovered")).toBeOnTheScreen();
    expect(screen.queryByTestId("app-crashed")).toBeNull();
  });

  it("names the way out once the retry has failed too", async () => {
    await draw(<Broken throws={true} />);

    await userEvent.press(screen.getByTestId("app-crashed-retry"));

    expect(screen.getByTestId("app-crashed")).toBeOnTheScreen();
    expect(screen.getByTestId("app-crashed-persisted")).toHaveTextContent(/Close BetterWakeUp/);
  });
});
