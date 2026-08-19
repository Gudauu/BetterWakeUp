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
  type CountSpec,
  DAYS_TO_COMPLETE,
  NO_REGRET_MINUTES,
  readCount,
  STEP_TARGET,
} from "../challenges/counts.ts";
import {
  projectChallenge,
  type StartChallengeOutcome,
  startChallenge,
} from "../challenges/create-challenge.ts";
import {
  type ChallengeDraft,
  createDraft,
  DEPOSIT_CURRENCY,
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
import { readWakeTime } from "../challenges/wake-time.ts";
import {
  createConfiguredSettingsLauncher,
  type OpenSettingsState,
  type SettingsLauncher,
  useOpenSettings,
} from "../device/settings.ts";
import {
  ALLOW_MOVEMENT_LABEL,
  canStartChallengeOn,
  createConfiguredMovementDevice,
  MOVEMENT_READINESS_NOTICE,
  type MovementDevice,
  type MovementReadinessState,
  RECHECK_MOVEMENT_LABEL,
  useMovementReadiness,
} from "../movement/device-readiness.ts";
import {
  createConfiguredPaymentSheet,
  type PaymentSheet,
  type PaymentSheetResult,
} from "../payments/payment-sheet.ts";
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
import { formatDay, formatWallClock } from "../ui/format.ts";
import { useTheme } from "../ui/theme.ts";
import { OpenSettingsAction } from "./open-settings-action.tsx";

const WEEKDAY_LABELS: Readonly<Record<Weekday, string>> = {
  monday: "Mon",
  tuesday: "Tue",
  wednesday: "Wed",
  thursday: "Thu",
  friday: "Fri",
  saturday: "Sat",
  sunday: "Sun",
};

/**
 * What the user is told after backing out of the payment sheet. It says the
 * money part explicitly, because "nothing happened" is the one thing somebody
 * who has just closed a card screen wants confirmed.
 */
const CANCELLED_NOTICE =
  "Your deposit was not confirmed, so no challenge was started. Nothing was charged.";

/** After the deposit was dropped for them, so the button below has changed. */
const NO_DEPOSIT_NOTICE =
  "The deposit is off. You can start this challenge now - it runs the same way, with nothing but the habit at stake.";

/** A sheet that could not even be opened, which is not the card's fault. */
const SHEET_FAILED_MESSAGE = "Your card could not be confirmed. Nothing was charged.";

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
  /**
   * How a card is asked for. Substituted in tests so a deposit can be walked
   * without a provider's SDK; a build passes nothing and the configured sheet
   * is used.
   */
  readonly paymentSheet?: PaymentSheet;
  /**
   * The step counter this phone has, asked about before the money rather than
   * on the first morning. Substituted in tests so no suite reaches for a
   * sensor; a build passes nothing and the configured one is used.
   */
  readonly movementDevice?: MovementDevice;
  /**
   * How the device's settings page is opened, which is the only way to undo a
   * refused motion permission.
   */
  readonly settings?: SettingsLauncher;
}

export function CreateChallengeScreen({
  initialDraft,
  onSignOut,
  onCreated,
  onCancel,
  paymentSheet,
  movementDevice,
  settings,
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
  // What the payment sheet came back with. Null while it is still up.
  const [card, setCard] = useState<PaymentSheetResult | null>(null);
  // What happened to an attempt the user has already left behind, said beside
  // the action that would try it again.
  const [notice, setNotice] = useState<string | null>(null);
  // The weekdays whose deadline field currently holds text that is not a time.
  // The draft keeps the last accepted deadline for those days, so this is what
  // stops a challenge being started against a time the user is mid-way through
  // replacing - without it the form would look wrong and start anyway.
  const [unreadableDeadlines, setUnreadableDeadlines] = useState<readonly Weekday[]>([]);
  // The same rule for the three numeric fields, keyed by the field's testID: the
  // draft holds the last number that read as one, so an emptied or half-typed
  // box is remembered here rather than being written down as a zero.
  const [unreadableCounts, setUnreadableCounts] = useState<readonly string[]>([]);
  // Built once for as long as the screen lives, so the effect that presents it
  // is not re-run by a new object on every render.
  const [sheet] = useState<PaymentSheet>(() => paymentSheet ?? createConfiguredPaymentSheet());
  // Built once, so the read of the device is not restarted by a new object on
  // every keystroke in the form.
  const [device] = useState<MovementDevice>(
    () => movementDevice ?? createConfiguredMovementDevice(),
  );
  const [settingsLauncher] = useState<SettingsLauncher>(
    () => settings ?? createConfiguredSettingsLauncher(),
  );
  const movement = useMovementReadiness(device);
  const openSettings = useOpenSettings(settingsLauncher);
  const phoneCanWalk = canStartChallengeOn(movement.readiness);

  const readiness = readinessOf(draft);
  // A weekday turned off takes its unreadable text with it, so a half-typed
  // Saturday cannot go on blocking the form from a field that is no longer
  // drawn.
  const deadlinesReadable = !unreadableDeadlines.some((weekday) =>
    draft.schedule.some((day) => day.weekday === weekday),
  );
  const countsReadable = unreadableCounts.length === 0;
  const rememberCount = (field: string, count: number | null) => {
    setUnreadableCounts((current) =>
      count === null
        ? current.includes(field)
          ? current
          : [...current, field]
        : current.filter((other) => other !== field),
    );
  };
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

  // The card is asked for as soon as the intent exists, because the intent is
  // only useful at a sheet: the client secret is what the provider's sheet
  // completes the authorization with. A user who never sees a sheet has never
  // paid, however long the app waits afterwards.
  const clientSecret =
    outcome?.status === "fundingRequired" ? outcome.intent.providerClientSecret : null;
  const deposit = draft.depositMinorUnits;

  const askForCard = useCallback(
    (secret: string) => {
      setCard(null);
      void sheet
        .present({ clientSecret: secret, amountMinorUnits: deposit, currency: DEPOSIT_CURRENCY })
        .then(
          (result) => {
            setCard(result);
            if (result.status === "cancelled") {
              // Back to the form rather than to a screen about a hold that was
              // never taken. Nothing exists at the server but an intent, which
              // costs nothing and expires on its own.
              setOutcome(null);
              setNotice(CANCELLED_NOTICE);
            }
          },
          () => setCard({ status: "failed", message: SHEET_FAILED_MESSAGE }),
        );
    },
    [sheet, deposit],
  );

  useEffect(() => {
    if (clientSecret === null) {
      return;
    }
    askForCard(clientSecret);
  }, [clientSecret, askForCard]);

  // The hold is authorized and the challenge does not exist yet: the provider
  // confirms it out of band, so the app watches for the challenge to appear
  // rather than leaving the user on a screen that never changes.
  const waitingForFunding = card?.status === "authorized";
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
    setNotice(null);
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

        {/* The sheet is the provider's own, over this screen. What is under it
            says which step the user is on, so backing out of it lands on a
            screen that makes sense rather than on a bare spinner. */}
        {card === null ? (
          <View style={styles.waiting} testID="funding-card">
            <FundingSpinner label="Confirming your card" />
            <AppText variant="small" tone="muted" center>
              Confirm the hold with your card. Nothing is charged unless you miss a day.
            </AppText>
          </View>
        ) : null}

        {card?.status === "unavailable" ? (
          <Banner tone="warning">
            <AppText
              variant="small"
              tone="warning"
              testID="funding-unavailable"
              accessibilityRole="alert"
            >
              {card.message}
            </AppText>
            <Button
              testID="funding-without-deposit"
              label="Set it up without a deposit"
              onPress={() => {
                dispatch({ type: "setDeposit", minorUnits: 0 });
                setCard(null);
                setOutcome(null);
                setNotice(NO_DEPOSIT_NOTICE);
              }}
            />
          </Banner>
        ) : null}

        {card?.status === "failed" ? (
          <Banner tone="danger">
            <AppText
              variant="small"
              tone="danger"
              testID="funding-card-error"
              accessibilityRole="alert"
            >
              {card.message}
            </AppText>
            <Button
              testID="funding-card-retry"
              label="Try your card again"
              onPress={() => askForCard(outcome.intent.providerClientSecret)}
            />
          </Banner>
        ) : null}

        {card?.status === "authorized" && funding === null ? (
          <View style={styles.waiting} testID="funding-waiting">
            <FundingSpinner label="Waiting for your bank" />
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
        <CountField
          label="Days to complete"
          hint="How many active days you have to finish before the challenge is done."
          testID="field-required-task-count"
          spec={DAYS_TO_COMPLETE}
          count={draft.requiredTaskCount}
          onChange={(count) => {
            rememberCount("field-required-task-count", count);
            if (count !== null) {
              dispatch({ type: "setRequiredTaskCount", count });
            }
          }}
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
              The time each morning's walk has to be finished by. Type it however you say it.
            </AppText>
            {draft.schedule.map((day) => (
              <DeadlineField
                key={day.weekday}
                label={`${WEEKDAY_LABELS[day.weekday]} deadline`}
                testID={`deadline-${day.weekday}`}
                deadline={day.deadline}
                onChange={(deadline) => {
                  setUnreadableDeadlines((current) =>
                    deadline === null
                      ? current.includes(day.weekday)
                        ? current
                        : [...current, day.weekday]
                      : current.filter((weekday) => weekday !== day.weekday),
                  );
                  if (deadline !== null) {
                    dispatch({ type: "setDeadline", weekday: day.weekday, deadline });
                  }
                }}
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
        <CountField
          label="Step target"
          hint="The steps you have to take before the deadline for the day to count."
          testID="field-step-target"
          suffix="steps"
          spec={STEP_TARGET}
          count={draft.stepTarget}
          onChange={(steps) => {
            rememberCount("field-step-target", steps);
            if (steps !== null) {
              dispatch({ type: "setStepTarget", steps });
            }
          }}
        />
        <CountField
          label="No Regret Time"
          hint="How long you have to stay up once you are awake."
          testID="field-no-regret-minutes"
          suffix="minutes"
          spec={NO_REGRET_MINUTES}
          count={draft.noRegretMinutes}
          reading={describeMinutes}
          onChange={(minutes) => {
            rememberCount("field-no-regret-minutes", minutes);
            if (minutes !== null) {
              dispatch({ type: "setNoRegretMinutes", minutes });
            }
          }}
        />
        <Divider />
        {/* The phone is part of the walk's terms: it is what settles every
            morning, and asking about it here is what keeps the answer ahead of
            the deposit rather than behind it. */}
        <AppText variant="small" style={styles.label}>
          This phone
        </AppText>
        <WalkOnThisPhone movement={movement} settings={openSettings} />
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

      {notice === null ? null : (
        <Banner tone="info">
          <AppText variant="small" testID="funding-notice">
            {notice}
          </AppText>
        </Banner>
      )}

      {outcome?.status === "failed" ? (
        <Banner tone="danger">
          <AppText variant="small" tone="danger" testID="start-error" accessibilityRole="alert">
            {outcome.message}
          </AppText>
        </Banner>
      ) : null}

      {readiness.ready && withinDuration && phoneCanWalk && deadlinesReadable && countsReadable ? (
        <Button
          testID={funded ? "deposit-and-start" : "start-challenge"}
          label={funded ? `Deposit ${formatMoney(draft.depositMinorUnits)} and start` : "Start"}
          busy={busy}
          onPress={() => void onStart()}
        />
      ) : (
        <Banner tone="info">
          <AppText variant="small" testID="not-ready">
            {nextStep(readiness, withinDuration, phoneCanWalk, deadlinesReadable, countsReadable)}
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
 * One morning's deadline, asked for in the time the user says out loud.
 *
 * The draft holds the contract's strict `HH:MM`, and this field is what stands
 * between that and a person typing `7am` at bedtime. The typed text lives here
 * so a half-written `7:` survives the keystroke, and the draft is told only
 * about text that reads as a time - which is also why an unreadable field is
 * reported upward rather than written down, since the challenge must not start
 * against a deadline the user is halfway through replacing.
 */
function DeadlineField({
  label,
  testID,
  deadline,
  onChange,
}: {
  label: string;
  testID: string;
  deadline: string;
  onChange: (wallClock: string | null) => void;
}) {
  // Seeded from the draft's own value rather than from what it reads as, so a
  // field the user has not touched shows the canonical form it will be sent in.
  const [text, setText] = useState(deadline);
  const reading = readWakeTime(text);
  return (
    <Field
      compact
      label={label}
      testID={testID}
      value={text}
      {...(reading.problem === null
        ? { reading: `That is ${formatWallClock(reading.wallClock ?? deadline)}.` }
        : { problem: reading.problem })}
      onChangeText={(next) => {
        setText(next);
        onChange(readWakeTime(next).wallClock);
      }}
    />
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

/**
 * One of the challenge's whole numbers, held as the text it was typed as.
 *
 * The draft keeps the last value that read as a number, which is what lets the
 * box be emptied: a field that wrote its own reading back on every keystroke
 * answered a cleared box with `0` under the cursor, so a `30` could only be
 * replaced by selecting it first. An unreadable box is reported upward instead,
 * because a challenge must not be started against a number the user is midway
 * through replacing.
 */
function CountField({
  label,
  hint,
  testID,
  suffix,
  spec,
  count,
  reading,
  onChange,
}: {
  label: string;
  hint: string;
  testID: string;
  suffix?: string;
  spec: CountSpec;
  count: number;
  reading?: (count: number) => string;
  onChange: (count: number | null) => void;
}) {
  const [text, setText] = useState(() => String(count));
  const read = readCount(text, spec);
  return (
    <Field
      label={label}
      hint={hint}
      testID={testID}
      keyboardType="number-pad"
      value={text}
      {...(suffix === undefined ? {} : { suffix })}
      {...(read.problem !== null
        ? { problem: read.problem }
        : reading === undefined || read.count === null
          ? {}
          : { reading: reading(read.count) })}
      onChangeText={(next) => {
        setText(next);
        onChange(readCount(next, spec).count);
      }}
    />
  );
}

/** `480` reads as `That is 8 hours`, so the unit on screen is not the only one. */
function describeMinutes(minutes: number): string {
  if (minutes < 60) {
    return `That is under an hour.`;
  }
  const hours = minutes / 60;
  const rounded = Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
  return `That is ${rounded} hours.`;
}

/**
 * The one thing standing in the way, in the order the user meets them. The
 * maximum duration is deliberately absent: it has its own alert beside the end
 * date, and repeating it here would say the same thing twice.
 */
function nextStep(
  readiness: DraftReadiness,
  withinDuration: boolean,
  phoneCanWalk: boolean,
  deadlinesReadable: boolean,
  countsReadable: boolean,
): string {
  // First, because nothing else about the draft matters on a phone that could
  // never complete a day of it.
  if (!phoneCanWalk) {
    return "A challenge cannot be started on a phone with no step counter.";
  }
  // Before the configuration, because the draft still holds the last accepted
  // deadline and so has no complaint of its own to make about this.
  if (!deadlinesReadable) {
    return "One of your deadlines is not a time yet. Fix it to continue.";
  }
  // For the same reason: the draft still holds the last number that read as one.
  if (!countsReadable) {
    return "One of your numbers is not filled in yet. Fix it to continue.";
  }
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

/**
 * What this phone says about counting a walk, and the one press that changes
 * it. Drawn even when the answer is good: a user about to stake money on a
 * sensor deserves to be told the sensor is there.
 */
function WalkOnThisPhone({
  movement,
  settings,
}: {
  movement: MovementReadinessState;
  settings: OpenSettingsState;
}): ReactNode {
  if (movement.readiness === "checking") {
    return (
      <AppText variant="small" tone="muted" testID="device-checking">
        Checking whether this phone can count your walk.
      </AppText>
    );
  }

  const notice = MOVEMENT_READINESS_NOTICE[movement.readiness];
  return (
    <Banner tone={notice.tone} testID={`device-${movement.readiness}`}>
      <AppText
        variant="small"
        testID="device-readiness"
        {...(notice.tone === "info"
          ? {}
          : { tone: notice.tone, accessibilityRole: "alert" as const })}
      >
        {notice.text}
      </AppText>

      {movement.readiness === "askable" ? (
        <Button
          testID="device-allow-motion"
          label={ALLOW_MOVEMENT_LABEL}
          variant="secondary"
          busy={movement.asking}
          onPress={movement.ask}
        />
      ) : null}

      {/* A refused permission is changed on a page the app is not in front of,
          so the way back and the way to re-read the answer sit together. */}
      {movement.readiness === "refused" ? (
        <>
          <OpenSettingsAction testID="device-refused-settings" settings={settings} tone="muted" />
          <Button
            testID="device-recheck"
            label={RECHECK_MOVEMENT_LABEL}
            variant="secondary"
            onPress={movement.recheck}
          />
        </>
      ) : null}

      {movement.readiness === "unknown" ? (
        <Button
          testID="device-recheck"
          label={RECHECK_MOVEMENT_LABEL}
          variant="secondary"
          onPress={movement.recheck}
        />
      ) : null}
    </Banner>
  );
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

/** A wait on somebody else - the card, then the bank - in the theme's accent. */
function FundingSpinner({ label }: { label: string }): ReactNode {
  const theme = useTheme();
  return <ActivityIndicator accessibilityLabel={label} color={theme.colors.accent} />;
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
