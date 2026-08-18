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
 */

import {
  type ChallengeView,
  type CreateProjectionResponse,
  disclosuresFor,
  type Weekday,
} from "@betterwakeup/contract";
import { type ReactNode, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
import { useSession } from "../session/session-context.tsx";

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
  /** Called when the user leaves the form without creating anything. */
  readonly onCancel?: () => void;
}

export function CreateChallengeScreen({
  initialDraft,
  onSignOut,
  onCreated,
  onCancel,
}: CreateChallengeScreenProps) {
  const { api } = useSession();
  const insets = useSafeAreaInsets();
  const [draft, dispatch] = useReducer(draftReducer, initialDraft ?? null, (given) =>
    given === null ? createDraft() : given,
  );
  const [projection, setProjection] = useState<CreateProjectionResponse | null>(null);
  const [outcome, setOutcome] = useState<StartChallengeOutcome | null>(null);
  const [busy, setBusy] = useState(false);

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
      <View style={[styles.container, { paddingTop: insets.top }]} testID="challenge-created">
        <Text style={styles.title}>Your challenge is running</Text>
        <Text style={styles.body}>
          {outcome.challenge.progress.requiredTaskCount} days, ending{" "}
          {outcome.challenge.projectedEndDate} if you never pause.
        </Text>
        <Text style={styles.note}>
          Open the app on every active day and keep it open until both checks appear.
        </Text>
      </View>
    );
  }

  if (outcome?.status === "fundingRequired") {
    return (
      <View style={[styles.container, { paddingTop: insets.top }]} testID="challenge-funding">
        <Text style={styles.title}>Confirm your deposit</Text>
        <Text style={styles.body}>
          {formatMoney(draft.depositMinorUnits)} is ready to be held against your card. The
          challenge starts once your bank confirms the hold.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      testID="create-challenge"
      contentContainerStyle={[styles.container, { paddingTop: insets.top }]}
    >
      <Text style={styles.title}>New challenge</Text>

      <Section title="Days">
        <NumberField
          label="Days to complete"
          testID="field-required-task-count"
          value={draft.requiredTaskCount}
          onChange={(count) => dispatch({ type: "setRequiredTaskCount", count })}
        />
        <Text style={styles.label}>Active weekdays</Text>
        <View style={styles.row}>
          {WEEKDAY_ORDER.map((weekday) => {
            const active = draft.schedule.some((day) => day.weekday === weekday);
            return (
              <Pressable
                key={weekday}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                testID={`weekday-${weekday}`}
                style={[styles.chip, active && styles.chipActive]}
                onPress={() => dispatch({ type: "toggleWeekday", weekday })}
              >
                <Text style={active ? styles.chipLabelActive : styles.chipLabel}>
                  {WEEKDAY_LABELS[weekday]}
                </Text>
              </Pressable>
            );
          })}
        </View>
        {draft.schedule.map((day) => (
          <View key={day.weekday} style={styles.row}>
            <Text style={styles.label}>{WEEKDAY_LABELS[day.weekday]} deadline</Text>
            <TextInput
              testID={`deadline-${day.weekday}`}
              accessibilityLabel={`${WEEKDAY_LABELS[day.weekday]} deadline`}
              style={styles.input}
              value={day.deadline}
              onChangeText={(deadline) =>
                dispatch({ type: "setDeadline", weekday: day.weekday, deadline })
              }
            />
          </View>
        ))}
      </Section>

      <Section title="Time zone">
        <Text style={styles.body} testID="time-zone">
          Deadlines are read in {draft.timeZone}.
        </Text>
        <View style={styles.row}>
          <Text style={styles.label}>This is my time zone</Text>
          <Switch
            testID="confirm-time-zone"
            accessibilityLabel="Confirm time zone"
            value={draft.timeZoneConfirmed}
            onValueChange={(confirmed) => dispatch({ type: "setTimeZoneConfirmed", confirmed })}
          />
        </View>
      </Section>

      <Section title="The rest">
        <NumberField
          label="Step target"
          testID="field-step-target"
          value={draft.stepTarget}
          onChange={(steps) => dispatch({ type: "setStepTarget", steps })}
        />
        <NumberField
          label="No Regret Time (minutes)"
          testID="field-no-regret-minutes"
          value={draft.noRegretMinutes}
          onChange={(minutes) => dispatch({ type: "setNoRegretMinutes", minutes })}
        />
        <NumberField
          label="Deposit (cents, or 0 for none)"
          testID="field-deposit"
          value={draft.depositMinorUnits}
          onChange={(minorUnits) => dispatch({ type: "setDeposit", minorUnits })}
        />
      </Section>

      <Section title="What this comes to">
        {projection === null ? (
          <Text style={styles.note} testID="projection-pending">
            Working out the end date.
          </Text>
        ) : (
          <View testID="projection">
            <Text style={styles.body}>First day: {projection.firstTaskDate}</Text>
            <Text style={styles.body}>Projected end: {projection.projectedEndDate}</Text>
          </View>
        )}
        {funded && projection !== null && !projection.withinMaximumDuration ? (
          <Text style={styles.error} testID="maximum-duration" accessibilityRole="alert">
            A challenge with a deposit has to finish within a year of funding. Shorten it, add
            active days, or run it with no deposit.
          </Text>
        ) : null}
      </Section>

      <Section title="Before you start">
        {applicable.map((item) => {
          const acknowledged = draft.acknowledgedDisclosures.includes(item.id);
          return (
            <View key={item.id} style={styles.disclosure}>
              <Text style={styles.body}>{item.statement}</Text>
              <Switch
                testID={`disclosure-${item.id}`}
                accessibilityLabel={item.statement}
                value={acknowledged}
                onValueChange={(next) =>
                  dispatch(
                    next
                      ? { type: "acknowledgeDisclosure", id: item.id }
                      : { type: "withdrawDisclosure", id: item.id },
                  )
                }
              />
            </View>
          );
        })}
      </Section>

      {readiness.ready && withinDuration ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy, busy }}
          testID={funded ? "deposit-and-start" : "start-challenge"}
          disabled={busy}
          style={[styles.button, busy && styles.buttonDisabled]}
          onPress={() => void onStart()}
        >
          <Text style={styles.buttonLabel}>
            {funded ? `Deposit ${formatMoney(draft.depositMinorUnits)} and start` : "Start"}
          </Text>
        </Pressable>
      ) : (
        <Text style={styles.note} testID="not-ready">
          {nextStep(readiness, withinDuration)}
        </Text>
      )}

      {outcome?.status === "failed" ? (
        <Text style={styles.error} testID="start-error" accessibilityRole="alert">
          {outcome.message}
        </Text>
      ) : null}

      {onCancel === undefined ? null : (
        <Pressable
          accessibilityRole="button"
          testID="cancel-create"
          style={styles.secondary}
          onPress={onCancel}
        >
          <Text style={styles.secondaryLabel}>Not now</Text>
        </Pressable>
      )}

      {onSignOut === undefined ? null : (
        <Pressable accessibilityRole="button" style={styles.secondary} onPress={onSignOut}>
          <Text style={styles.secondaryLabel}>Sign out</Text>
        </Pressable>
      )}
    </ScrollView>
  );
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function NumberField(props: {
  label: string;
  testID: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{props.label}</Text>
      <TextInput
        testID={props.testID}
        accessibilityLabel={props.label}
        style={styles.input}
        keyboardType="number-pad"
        value={String(props.value)}
        // An empty field is zero rather than NaN: the contract refuses zero
        // where zero is illegal, and the reason is already on screen.
        onChangeText={(text) => props.onChange(Number.parseInt(text, 10) || 0)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 20, paddingHorizontal: 24, paddingBottom: 48 },
  section: { gap: 10 },
  sectionTitle: { fontSize: 18, fontWeight: "600" },
  title: { fontSize: 28, fontWeight: "600" },
  body: { fontSize: 15, lineHeight: 21, flexShrink: 1 },
  label: { fontSize: 15, flexShrink: 1 },
  note: { fontSize: 13, opacity: 0.6, lineHeight: 18 },
  error: { fontSize: 14, color: "#b00020", lineHeight: 20 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  disclosure: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
  },
  input: {
    borderColor: "#cccccc",
    borderRadius: 8,
    borderWidth: 1,
    fontSize: 15,
    minWidth: 96,
    paddingHorizontal: 12,
    paddingVertical: 8,
    textAlign: "right",
  },
  chip: {
    borderColor: "#cccccc",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chipActive: { backgroundColor: "#111111", borderColor: "#111111" },
  chipLabel: { fontSize: 13 },
  chipLabelActive: { color: "#ffffff", fontSize: 13 },
  button: {
    alignItems: "center",
    backgroundColor: "#111111",
    borderRadius: 12,
    paddingHorizontal: 24,
    paddingVertical: 14,
  },
  buttonDisabled: { opacity: 0.4 },
  buttonLabel: { color: "#ffffff", fontSize: 16, fontWeight: "600" },
  secondary: { alignItems: "center", paddingVertical: 12 },
  secondaryLabel: { fontSize: 15, opacity: 0.7 },
});
