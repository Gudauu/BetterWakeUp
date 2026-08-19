/**
 * A two-step control for an action that cannot be undone.
 *
 * The first press opens the consequence and the second one takes the action,
 * so a single mistaken tap never spends a recovery, skips a task, or deletes
 * an account. Cancelling is always offered beside the confirmation and is the
 * wider target of the two.
 *
 * The opened state is drawn as a warning panel rather than as a plain box: the
 * step that acts should not look like the step that only opened, or the second
 * press reads as a repeat of the first.
 */

import { useCallback, useState } from "react";
import { AppText, Banner, Button, type ButtonVariant, TextButton } from "../ui/components.tsx";

export interface ConfirmActionProps {
  readonly testID: string;
  /** The label of the control before anything is opened. */
  readonly label: string;
  /** What will happen, in the user's terms. Shown only once opened. */
  readonly consequence: string;
  /** The label of the press that actually acts. */
  readonly confirmLabel: string;
  /**
   * How the acting press is painted. `danger` for the presses that destroy
   * something the user cannot get back; the default for the rest.
   */
  readonly variant?: ButtonVariant;
  /**
   * The label of the press that backs out. The default speaks for a setting
   * being left alone, which is wrong for an action taken in the middle of
   * something - a walk is kept by carrying on with it, not by keeping things
   * as they are.
   */
  readonly cancelLabel?: string;
  /**
   * Draws the unopened control as a quiet link rather than as a button. For a
   * press that already lives among the account-level controls: raising it to a
   * full button to add a confirmation would make it look like the thing to do
   * next, which is the opposite of what a confirmation is for.
   */
  readonly quiet?: boolean;
  readonly busy?: boolean;
  readonly onConfirm: () => Promise<void> | void;
}

export function ConfirmAction(props: ConfirmActionProps) {
  const [open, setOpen] = useState(false);
  const busy = props.busy ?? false;
  const variant = props.variant ?? "primary";

  const onConfirm = useCallback(async () => {
    await props.onConfirm();
    setOpen(false);
  }, [props.onConfirm]);

  if (!open) {
    if (props.quiet === true) {
      return (
        <TextButton
          testID={props.testID}
          label={props.label}
          {...(variant === "danger" ? { tone: "danger" as const } : {})}
          disabled={busy}
          onPress={() => setOpen(true)}
        />
      );
    }
    return (
      <Button
        testID={props.testID}
        label={props.label}
        variant={variant}
        disabled={busy}
        onPress={() => setOpen(true)}
      />
    );
  }

  return (
    <Banner
      tone={variant === "danger" ? "danger" : "warning"}
      testID={`${props.testID}-confirmation`}
    >
      <AppText
        variant="small"
        tone={variant === "danger" ? "danger" : "warning"}
        testID={`${props.testID}-consequence`}
      >
        {props.consequence}
      </AppText>
      <Button
        testID={`${props.testID}-confirm`}
        label={props.confirmLabel}
        variant={variant}
        busy={busy}
        onPress={() => void onConfirm()}
      />
      <TextButton
        testID={`${props.testID}-cancel`}
        label={props.cancelLabel ?? "Keep things as they are"}
        onPress={() => setOpen(false)}
      />
    </Banner>
  );
}
