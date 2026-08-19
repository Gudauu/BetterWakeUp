/**
 * The press that takes a user to the permission they have to change.
 *
 * Three places in the app end in the same sentence - motion access is off,
 * motion access was turned off mid-walk, notifications are off - and all three
 * are fixed on one page the app can open. The press looks and reads the same in
 * each, so it lives here rather than being written out three times.
 *
 * The refusal case is drawn here too, because it is the same everywhere: a
 * platform with no settings page leaves the prose instruction as the only route
 * left, and that has to appear under the button that just failed rather than
 * being the sentence the button replaced.
 */

import type { ReactNode } from "react";
import {
  OPEN_SETTINGS_LABEL,
  type OpenSettingsState,
  SETTINGS_UNAVAILABLE_TEXT,
} from "../device/settings.ts";
import { AppText, Button } from "../ui/components.tsx";

export interface OpenSettingsActionProps {
  readonly testID: string;
  readonly settings: OpenSettingsState;
  /** The tone of the line drawn if the platform refuses, matching its banner. */
  readonly tone?: "danger" | "muted";
}

export function OpenSettingsAction({
  testID,
  settings,
  tone = "danger",
}: OpenSettingsActionProps): ReactNode {
  return (
    <>
      <Button
        testID={testID}
        label={OPEN_SETTINGS_LABEL}
        variant="secondary"
        busy={settings.opening}
        onPress={settings.open}
      />
      {settings.failed ? (
        <AppText variant="small" tone={tone} testID={`${testID}-unavailable`}>
          {SETTINGS_UNAVAILABLE_TEXT}
        </AppText>
      ) : null}
    </>
  );
}
