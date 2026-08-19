/**
 * Setting up a challenge: one sitting, nothing saved until it is created.
 *
 * The screen holds the draft in `useReducer` and asks the server for a
 * projection whenever the configuration changes, so the end date the user
 * reads is the server's own arithmetic rather than a second implementation of
 * the schedule engine.
 *
 * The action that commits is rendered only when `readinessOf` says the draft
 * is ready, and `startChallenge` refuses independently, so an unacknowledged
 * disclosure blocks the deposit in two places rather than one.
 *
 * It is a form, so it is ordered as a set of decisions rather than as a set of
 * fields: how many days, which mornings, what counts as done, what is at stake,
 * and only then what the whole thing comes to. Every number carries the
 * sentence saying what it is for, because a user setting up a challenge at
 * bedtime should not have to infer what "No Regret Time" means from its name.
 */

import {
  type ChallengeView,
  type CreateProjectionResponse,
  disclosuresFor,
  type Weekday,
} from "@betterwakeup/contract";
import { type ReactNode, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import {
  projectChallenge,
  type StartChallengeOutcome,
  startChallenge,
} from "../challenges/create-challenge.ts";
import {
  type ChallengeDraft,
  createDraft,
  type DraftReadiness,
  draftReducer,
  formatMoney,
  readinessOf,
  WEEKDAY_ORDER,
} from "../challenges/draft.ts";
import {
  awaitFundedChallenge,
  type FundedChallengeOutcome,
} from "../challenges/funded-challenge.ts";
import { useSession } from "../session/session-context.tsx";
import {
  AppText,
  Banner,
  Button,
  Card,
  Chip,
  DetailRow,
  Divider,
  Field,
  Screen,
  TextButton,
  Toggle,
} from "../ui/components.tsx";
import { formatDay } from "../ui/format.ts";
import { useTheme } from "../ui/theme.ts";

const WEEKDAY_LABELS: Readonly<Record<Weekday, string>> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

export interface CreateChallengeScreenProps {
  /** Injected in tests so the zone is not the machine running them. */
  readonly initialDraft?: ChallengeDraft;
  readonly onSignOut?: () => void;
  /**
   * Called once the server has created the challenge, so a caller that owns a
   * view of the account can read it back. Absent when this screen is the whole
   * app, in which case it reports the outcome itself.
   */
  readonly onCreated?: (challenge: ChallengeView) => void;
  /**
   * Called when the user leaves without a challenge on screen. `accountChanged`
   * says whether the server may hold something new anyway: leaving the form is
   * a no-op, but leaving a hold that has been authorized is not, and a caller
   * that reads the account has to ask again in that case.
   */
  readonly onCancel?: (accountChanged: boolean) => void;
}

export function CreateChallengeScreen({
  initialDraft,
  onSignOut,
  onCreated,
  onCancel,
}: CreateChallengeScreenProps) {
  const { api } = useSession();
  const [draft, dispatch] = useReducer(draftReducer, initialDraft ?? null, (given) =>
    given === null ? createDraft() : given,
  );
  const [projection, setProjection] = useState<CreateProjectionResponse | null>(null);
  const [outcome, setOutcome] = useState<StartChallengeOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  // What the wait for the bank has come to. Null while it is still watching.
  const [funding, setFunding] = useState<FundedChallengeOutcome | null>(null);

  const readiness = readinessOf(draft);
  const funded = draft.depositMinorUnits > 0;
  // The maximum duration is the server's answer, not the app's, so the action
  // waits for a projection before it is offered on a funded challenge.
  const withinDuration = !funded || projection?.withinMaximumDuration === true;
  const applicable = disclosuresFor(draft.depositMinorUnits);

  // The projection is asked for again whenever the configuration changes, and
  // only then: acknowledging a disclosure or confirming the time zone changes
  // the draft without changing the plan the server would project.
  const configurationKey = readiness.configuration.ok
    ? JSON.stringify(readiness.configuration.configuration)
    : null;
  // Read rather than depended on, so the key alone decides when to ask.
  const current = useRef(draft);
  current.current = draft;

  useEffect(() => {
    let active = true;
    // The old projection describes a plan that is no longer on screen, so it
    // goes now rather than when its replacement lands.
    setProjection(null);
    if (configurationKey === null) {
      return;
    }
    void projectChallenge(api, current.current).then((result) => {
      if (active) {
        setProjection(result);
      }
    });
    return () => {
      active = false;
    };
  }, [api, configurationKey]);

  // The hold is authorized and the challenge does not exist yet: the provider
  // confirms it out of band, so the app watches for the challenge to appear
  // rather than leaving the user on a screen that never changes.
  const waitingForFunding = outcome?.status === "fundingRequired";
  const created = useRef(onCreated);
  created.current = onCreated;
  // The wait in flight, so that pressing "check again" replaces it rather than
  // running a second one beside it, and so leaving the screen ends it.
  const watching = useRef<AbortController | null>(null);

  const watchForFunding = useCallback(() => {
    watching.current?.abort();
    const controller = new AbortController();
    watching.current = controller;
    setFunding(null);
    void awaitFundedChallenge(api, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) {
        return;
      }
      setFunding(result);
      if (result.status === "created") {
        setOutcome({ status: "created", challenge: result.challenge });
        created.current?.(result.challenge);
      }
    });
  }, [api]);

  useEffect(() => {
    if (!waitingForFunding) {
      return;
    }
    watchForFunding();
    return () => {
      watching.current?.abort();
    };
  }, [waitingForFunding, watchForFunding]);

  const onStart = useCallback(async () => {
    setBusy(true);
    try {
      const result = await startChallenge({ api, draft, projection });
      setOutcome(result);
      if (result.status === "created") {
        onCreated?.(result.challenge);
      }
    } finally {
      setBusy(false);
    }
  }, [api, draft, projection, onCreated]);

  if (outcome?.status === "created") {
    return (
      <Screen centered testID="challenge-created">
        <AppText variant="caption" tone="success">
          YOU'RE IN
        </AppText>
        <AppText variant="display" center accessibilityRole="header">
          Your challenge is running
        </AppText>
        <AppText variant="body" tone="muted" center>
          {outcome.challenge.progress.requiredTaskCount} days, ending{" "}
          {formatDay(outcome.challenge.projectedEndDate)} if you never pause.
        </AppText>
        <Banner tone="info">
          <AppText variant="small">
            Open the app on every active day and keep it open until both checks appear.
          </AppText>
        </Banner>
      </Screen>
    );
  }

  if (outcome?.status === "fundingRequired") {
    return (
      <Screen centered testID="challenge-funding">
        <AppText variant="caption" tone="accent">
          ONE LAST STEP
        </AppText>
        <AppText variant="display" center accessibilityRole="header">
          Confirm your deposit
        </AppText>
        <AppText variant="body" tone="muted" center>
          {formatMoney(draft.depositMinorUnits)} is held against your card. The challenge starts the
          moment your bank confirms the hold.
        </AppText>

        {funding === null ? (
          <View style={styles.waiting} testID="funding-waiting">
            <FundingSpinner />
            <AppText variant="small" tone="muted" center>
              Waiting for your bank. This usually takes a few seconds.
            </AppText>
          </View>
        ) : null}

        {funding?.status === "pending" ? (
          <Banner tone="info">
            <AppText variant="small" testID="funding-slow">
              Your bank has not confirmed the hold yet. Nothing is lost - it can take a minute.
              Check again, or come back to it from home.
            </AppText>
          </Banner>
        ) : null}

        {funding?.status === "failed" ? (
          <Banner tone="danger">
            <AppText variant="small" tone="danger" testID="funding-error" accessibilityRole="alert">
              {funding.message}
            </AppText>
          </Banner>
        ) : null}

        {funding === null ? null : (
          <Button testID="funding-check-again" label="Check again" onPress={watchForFunding} />
        )}

        {/* Without this the screen is a dead end: the challenge is out of the
            user's hands, and there is nothing else here to press. Leaving is
            reported as a change, because the hold may be confirmed a moment
            after the user gives up on watching for it. */}
        {onCancel === undefined ? null : (
          <TextButton testID="funding-done" label="Back to home" onPress={() => onCancel(true)} />
        )}
      </Screen>
    );
  }

  const active = draft.schedule.length;

  return (
    <Screen testID="create-challenge">
      <View style={styles.header}>
        <AppText variant="caption" tone="accent">
          NEW CHALLENGE
        </AppText>
        <AppText variant="display" accessibilityRole="header">
          Set your terms
        </AppText>
        <AppText variant="small" tone="muted">
          Pick the mornings, the walk, and what you are putting behind it. Nothing is saved until
          you start.
        </AppText>
      </View>

      <Card>
        <SectionTitle title="The mornings" step={1} />
        <Field
          label="Days to complete"
          hint="How many active days you have to finish before the challenge is done."
          testID="field-required-task-count"
          keyboardType="number-pad"
          value={String(draft.requiredTaskCount)}
          // An empty field is zero rather than NaN: the contract refuses zero
          // where zero is illegal, and the reason is already on screen.
          onChangeText={(text) =>
            dispatch({ type: "setRequiredTaskCount", count: wholeNumber(text) })
          }
        />

        <View style={styles.group}>
          <AppText variant="small" style={styles.label}>
            Active weekdays
          </AppText>
          <AppText variant="caption" tone="muted" testID="weekday-summary">
            {active === 0
              ? "Pick at least one morning."
              : `${active} ${active === 1 ? "morning" : "mornings"} a week.`}
          </AppText>
          <View style={styles.chips}>
            {WEEKDAY_ORDER.map((weekday) => (
              <Chip
                key={weekday}
                testID={`weekday-${weekday}`}
                label={WEEKDAY_LABELS[weekday]}
                selected={draft.schedule.some((day) => day.weekday === weekday)}
                onPress={() => dispatch({ type: "toggleWeekday", weekday })}
              />
            ))}
          </View>
        </View>

        {draft.schedule.length === 0 ? null : (
          <View style={styles.group}>
            <AppText variant="small" style={styles.label}>
              Deadlines
            </AppText>
            <AppText variant="caption" tone="muted">
              The time each morning's walk has to be finished by, as HH:MM.
            </AppText>
            {draft.schedule.map((day) => (
              <Field
                key={day.weekday}
                compact
                label={`${WEEKDAY_LABELS[day.weekday]} deadline`}
                testID={`deadline-${day.weekday}`}
                value={day.deadline}
                onChangeText={(deadline) =>
                  dispatch({ type: "setDeadline", weekday: day.weekday, deadline })
                }
              />
            ))}
          </View>
        )}

        <Divider />

        <Toggle
          testID="confirm-time-zone"
          label="Confirm time zone"
          value={draft.timeZoneConfirmed}
          onValueChange={(confirmed) => dispatch({ type: "setTimeZoneConfirmed", confirmed })}
        >
          <AppText variant="small" testID="time-zone">
            Deadlines are read in {draft.timeZone}.
          </AppText>
          <AppText variant="caption" tone="muted">
            A deadline in the wrong zone is a missed day, so confirm this is where you wake up.
          </AppText>
        </Toggle>
      </Card>

      <Card>
        <SectionTitle title="The walk" step={2} />
        <Field
          label="Step target"
          hint="The steps you have to take before the deadline for the day to count."
          testID="field-step-target"
          keyboardType="number-pad"
          suffix="steps"
          value={String(draft.stepTarget)}
          onChangeText={(text) => dispatch({ type: "setStepTarget", steps: wholeNumber(text) })}
        />
        <Field
          label="No Regret Time"
          hint={`How long you have to stay up once you are awake. ${describeMinutes(draft.noRegretMinutes)}.`}
          testID="field-no-regret-minutes"
          keyboardType="number-pad"
          suffix="minutes"
          value={String(draft.noRegretMinutes)}
          onChangeText={(text) =>
            dispatch({ type: "setNoRegretMinutes", minutes: wholeNumber(text) })
          }
        />
      </Card>

      <Card>
        <SectionTitle title="What's at stake" step={3} />
        <DepositField
          minorUnits={draft.depositMinorUnits}
          onChange={(minorUnits) => dispatch({ type: "setDeposit", minorUnits })}
        />
        {readiness.configuration.ok ? null : (
          <Banner tone="warning" testID="configuration-problems">
            {readiness.configuration.problems.map((problem) => (
              <AppText key={problem} variant="small" tone="warning">
                {problem}
              </AppText>
            ))}
          </Banner>
        )}
      </Card>

      <Card testID="plan-summary">
        <SectionTitle title="What this comes to" />
        {projection === null ? (
          <AppText variant="small" tone="muted" testID="projection-pending">
            Working out the end date.
          </AppText>
        ) : (
          <View testID="projection" style={styles.group}>
            <DetailRow label="First morning" value={formatDay(projection.firstTaskDate)} />
            <DetailRow label="Projected end" value={formatDay(projection.projectedEndDate)} />
            <DetailRow
              label="At stake"
              value={funded ? formatMoney(draft.depositMinorUnits) : "Nothing but the habit"}
            />
          </View>
        )}
        {funded && projection !== null && !projection.withinMaximumDuration ? (
          <Banner tone="danger" testID="maximum-duration">
            <AppText variant="small" tone="danger" accessibilityRole="alert">
              A challenge with a deposit has to finish within a year of funding. Shorten it, add
              active days, or run it with no deposit.
            </AppText>
          </Banner>
        ) : null}
      </Card>

      <Card>
        <SectionTitle title="Before you start" />
        <AppText variant="small" tone="muted">
          Turn each one on to say you understand it.
        </AppText>
        {applicable.map((item, index) => (
          <View key={item.id} style={styles.group}>
            {index === 0 ? null : <Divider />}
            <Toggle
              testID={`disclosure-${item.id}`}
              label={item.statement}
              value={draft.acknowledgedDisclosures.includes(item.id)}
              onValueChange={(next) =>
                dispatch(
                  next
                    ? { type: "acknowledgeDisclosure", id: item.id }
                    : { type: "withdrawDisclosure", id: item.id },
                )
              }
            >
              <AppText variant="small">{item.statement}</AppText>
            </Toggle>
          </View>
        ))}
      </Card>

      {outcome?.status === "failed" ? (
        <Banner tone="danger">
          <AppText variant="small" tone="danger" testID="start-error" accessibilityRole="alert">
            {outcome.message}
          </AppText>
        </Banner>
      ) : null}

      {readiness.ready && withinDuration ? (
        <Button
          testID={funded ? "deposit-and-start" : "start-challenge"}
          label={funded ? `Deposit ${formatMoney(draft.depositMinorUnits)} and start` : "Start"}
          busy={busy}
          onPress={() => void onStart()}
        />
      ) : (
        <Banner tone="info">
          <AppText variant="small" testID="not-ready">
            {nextStep(readiness, withinDuration)}
          </AppText>
        </Banner>
      )}

      <View style={styles.footer}>
        {onCancel === undefined ? null : (
          <TextButton testID="cancel-create" label="Not now" onPress={() => onCancel(false)} />
        )}
        {onSignOut === undefined ? null : (
          <TextButton testID="create-sign-out" label="Sign out" onPress={onSignOut} />
        )}
      </View>
    </Screen>
  );
}

/**
 * The deposit, asked for in the money the user thinks in.
 *
 * The draft stores minor units, but a form that asks for cents invites a user
 * meaning twenty dollars to type `20` and stake twenty cents. The typed text is
 * held here so a half-written `12.` survives the keystroke that would otherwise
 * round it away, and the draft only ever sees whole minor units.
 */
function DepositField({
  minorUnits,
  onChange,
}: {
  minorUnits: number;
  onChange: (minorUnits: number) => void;
}) {
  const [text, setText] = useState(() => (minorUnits === 0 ? "" : (minorUnits / 100).toFixed(2)));
  return (
    <Field
      label="Deposit"
      hint="Held against your card until you finish. Leave it empty to run the challenge for nothing but the habit."
      testID="field-deposit"
      keyboardType="decimal-pad"
      prefix="$"
      value={text}
      onChangeText={(next) => {
        const cleaned = money(next);
        setText(cleaned);
        onChange(Math.round((Number.parseFloat(cleaned) || 0) * 100));
      }}
    />
  );
}

/** Digits and at most one decimal point, at most two places after it. */
function money(text: string): string {
  const [whole = "", ...rest] = text.replace(/[^0-9.]/g, "").split(".");
  return rest.length === 0 ? whole : `${whole}.${rest.join("").slice(0, 2)}`;
}

function wholeNumber(text: string): number {
  return Number.parseInt(text.replace(/[^0-9]/g, ""), 10) || 0;
}

/** `480` reads as `That is 8 hours`, so the unit on screen is not the only one. */
function describeMinutes(minutes: number): string {
  if (minutes < 60) {
    return `That is under an hour`;
  }
  const hours = minutes / 60;
  const rounded = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  return `That is ${rounded} hours`;
}

/**
 * The one thing standing in the way, in the order the user meets them. The
 * maximum duration is deliberately absent: it has its own alert beside the end
 * date, and repeating it here would say the same thing twice.
 */
function nextStep(readiness: DraftReadiness, withinDuration: boolean): string {
  if (!readiness.configuration.ok) {
    return "Check the days, deadlines, and deposit above.";
  }
  if (!readiness.timeZoneConfirmed) {
    return "Confirm your time zone to continue.";
  }
  if (readiness.outstandingDisclosureIds.length > 0) {
    return "Acknowledge each statement above to continue.";
  }
  return withinDuration ? "Working out the end date." : "";
}

/** A card's heading, numbered while the user is still working through them. */
function SectionTitle({ title, step }: { title: string; step?: number }): ReactNode {
  return (
    <View style={styles.sectionTitle}>
      {step === undefined ? null : (
        <AppText variant="caption" tone="accent">
          STEP {step}
        </AppText>
      )}
      <AppText variant="headline">{title}</AppText>
    </View>
  );
}

/** The wait for the bank, drawn in the theme's own accent. */
function FundingSpinner(): ReactNode {
  const theme = useTheme();
  return (
    <ActivityIndicator accessibilityLabel="Waiting for your bank" color={theme.colors.accent} />
  );
}

const styles = StyleSheet.create({
  header: { gap: 4 },
  waiting: { gap: 8, alignItems: "center" },
  sectionTitle: { gap: 2 },
  group: { gap: 8 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  label: { fontWeight: "600" },
  footer: { gap: 4 },
});
