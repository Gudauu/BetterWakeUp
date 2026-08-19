/**
 * The screen the app draws when one of its own screens throws.
 *
 * Without this, a render error anywhere below the router leaves a React Native
 * build showing a blank window with no text and no press - the app looks as
 * though it died holding whatever the user was doing, which on this app means
 * a walk, a deadline and a deposit. What is actually true is much better than
 * that, and this screen's job is to say so: the challenge is the server's, the
 * walk already saved is on the phone, and the alarms are the operating
 * system's. None of the three depends on this process surviving.
 *
 * The error itself is never shown. A stack trace names a module and a line,
 * which tells the person reading it nothing they can act on; it goes to the
 * crash reporter instead, through the same port every other report uses.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { type CrashReporter, noopReporter } from "../reporting/reporter.ts";
import { AppText, Banner, Button, Screen } from "./components.tsx";

/**
 * What a user is told when the app breaks under them. Every sentence here is
 * something the app can promise without reading anything: the three places the
 * user's work actually lives all outlive this process.
 */
export const CRASH_NOTICE = {
  title: "BetterWakeUp hit a problem",
  body: "Something went wrong drawing this screen. It was not caused by anything you did, and nothing you have done was thrown away.",
  challenge:
    "Your challenge is held by BetterWakeUp, not by this phone. It carries on, and its deadlines keep counting.",
  walks:
    "A walk already saved on this phone is still saved, and will be sent as soon as the app can reach the server.",
  alarms: "Any wake-up reminder already set on this phone will still sound.",
  retry: "Try again",
  /**
   * Shown once a retry has already failed. At that point the app cannot fix
   * itself from inside, so the honest next step is the one the user can take.
   */
  persisted:
    "That did not work. Close BetterWakeUp completely and open it again - your challenge is not affected by this.",
} as const;

export interface AppErrorBoundaryProps {
  /**
   * Where the failure is reported. A build passes the app's reporter; a test
   * passes a recorder, which is how the payload is asserted. The default is
   * the no-op, so a screen rendered on its own needs no wiring.
   */
  readonly reporter?: CrashReporter;
  readonly children: ReactNode;
}

interface AppErrorBoundaryState {
  readonly failed: boolean;
  /** How many times the user has asked for the screen back. */
  readonly retries: number;
}

/**
 * A class component because catching a render error is the one thing hooks
 * cannot do.
 */
export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  override state: AppErrorBoundaryState = { failed: false, retries: 0 };

  static getDerivedStateFromError(): Partial<AppErrorBoundaryState> {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo) {
    // The component stack is deliberately left off: it names view names and
    // props, which is exactly where a step count or a typed amount would ride
    // out of the device on a payload the scrubber never sees.
    (this.props.reporter ?? noopReporter).captureException(error, {
      name: "app.render_failed",
      severity: "error",
      fields: { operation: "appRender" },
    });
  }

  private readonly retry = () => {
    // Clearing `failed` unmounts the fallback and mounts the children again
    // from scratch, so a screen that failed on a value it had half-read gets a
    // fresh read rather than the state that broke it.
    this.setState((previous) => ({ failed: false, retries: previous.retries + 1 }));
  };

  override render() {
    if (!this.state.failed) {
      return this.props.children;
    }
    return <CrashScreen onRetry={this.retry} retried={this.state.retries > 0} />;
  }
}

function CrashScreen({
  onRetry,
  retried,
}: {
  readonly onRetry: () => void;
  readonly retried: boolean;
}) {
  return (
    <Screen centered testID="app-crashed">
      <Banner tone="danger">
        <AppText variant="headline" accessibilityRole="alert">
          {CRASH_NOTICE.title}
        </AppText>
        <AppText variant="small">{CRASH_NOTICE.body}</AppText>
      </Banner>

      <AppText variant="small" tone="muted" testID="app-crashed-challenge">
        {CRASH_NOTICE.challenge}
      </AppText>
      <AppText variant="small" tone="muted" testID="app-crashed-walks">
        {CRASH_NOTICE.walks}
      </AppText>
      <AppText variant="small" tone="muted" testID="app-crashed-alarms">
        {CRASH_NOTICE.alarms}
      </AppText>

      <Button testID="app-crashed-retry" label={CRASH_NOTICE.retry} onPress={onRetry} />

      {retried ? (
        <AppText variant="small" tone="warning" center testID="app-crashed-persisted">
          {CRASH_NOTICE.persisted}
        </AppText>
      ) : null}
    </Screen>
  );
}
