/**
 * The pieces every screen is built out of.
 *
 * These exist so a screen describes what it is showing - a card, a primary
 * action, a warning banner - rather than how it is drawn. The drawing lives
 * here and reads its values from `useTheme`, which is what makes the whole app
 * follow the device between light and dark without a screen mentioning either.
 *
 * A component here owns appearance and touch feedback only. None of them holds
 * state or knows a rule; every one takes what it renders as a prop.
 */

import type { ReactNode } from "react";
import {
  ActivityIndicator,
  type KeyboardTypeOptions,
  Pressable,
  type PressableStateCallbackType,
  RefreshControl,
  ScrollView,
  type StyleProp,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  type TextStyle,
  View,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { type Theme, useTheme } from "./theme.ts";

type TextVariant = "display" | "title" | "headline" | "body" | "small" | "caption";
type TextTone = "default" | "muted" | "accent" | "warning" | "danger" | "success" | "onAccent";

const TONE_COLOR: Readonly<Record<TextTone, (theme: Theme) => string>> = {
  default: (theme) => theme.colors.text,
  muted: (theme) => theme.colors.textMuted,
  accent: (theme) => theme.colors.accent,
  warning: (theme) => theme.colors.warning,
  danger: (theme) => theme.colors.danger,
  success: (theme) => theme.colors.success,
  onAccent: (theme) => theme.colors.onAccent,
};

export interface AppTextProps {
  readonly variant?: TextVariant;
  readonly tone?: TextTone;
  readonly center?: boolean;
  readonly style?: StyleProp<TextStyle>;
  readonly testID?: string;
  readonly accessibilityRole?: "alert" | "header";
  readonly children: ReactNode;
}

/** Every string the user reads goes through here, so the type scale is the only one. */
export function AppText({
  variant = "body",
  tone = "default",
  center = false,
  style,
  testID,
  accessibilityRole,
  children,
}: AppTextProps) {
  const theme = useTheme();
  return (
    <Text
      testID={testID}
      accessibilityRole={accessibilityRole}
      style={[
        theme.type[variant],
        { color: TONE_COLOR[tone](theme) },
        center && { textAlign: "center" },
        style,
      ]}
    >
      {children}
    </Text>
  );
}

export interface ScreenProps {
  readonly testID?: string;
  /**
   * Centres the content in the middle of the screen and stops it scrolling.
   * For the short screens - a spinner, an error, a sign-in prompt - where a
   * top-aligned column would leave the content stranded under the notch.
   */
  readonly centered?: boolean;
  /**
   * What a pull down the screen asks for. A screen made of wall-clock facts is
   * one a user will reach for this gesture on, and a button under a divider at
   * the bottom of a scrolling page is not where they will look for it.
   *
   * Absent on a `centered` screen, which does not scroll and so has nothing to
   * pull; those screens carry an explicit button instead.
   */
  readonly onRefresh?: () => void;
  /** Whether that request is still in flight, which is what holds the spinner. */
  readonly refreshing?: boolean;
  readonly style?: StyleProp<ViewStyle>;
  readonly children: ReactNode;
}

/**
 * The frame: the background colour, the safe area, and the horizontal gutter.
 * Scrolls by default, because any screen can overflow once the device is set
 * to a large text size even if it fits at the default one.
 */
export function Screen({
  testID,
  centered = false,
  onRefresh,
  refreshing = false,
  style,
  children,
}: ScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const padding = {
    paddingTop: insets.top + theme.space.lg,
    paddingBottom: insets.bottom + theme.space.xxl,
    paddingHorizontal: theme.space.xl,
  };

  if (centered) {
    return (
      <View
        testID={testID}
        style={[
          styles.fill,
          styles.center,
          { backgroundColor: theme.colors.background, gap: theme.space.lg },
          padding,
          style,
        ]}
      >
        {children}
      </View>
    );
  }

  return (
    <ScrollView
      testID={testID}
      style={{ backgroundColor: theme.colors.background }}
      contentContainerStyle={[{ gap: theme.space.lg }, padding, style]}
      keyboardShouldPersistTaps="handled"
      // The keyboard is part of the screen's height, not something drawn over
      // it: without this the software keyboard covers the lower half of the
      // setup form, so the field the user is typing into - and the complaint
      // under it - are behind the keys. iOS-only, and ignored on Android,
      // where the window is resized for the keyboard instead.
      automaticallyAdjustKeyboardInsets
      // The way out. Every numeric field in the app asks for a keypad, and an
      // iOS number pad has no return key at all, so a dragged-down keyboard is
      // the only dismissal a user has besides tapping a gap in the layout.
      keyboardDismissMode="interactive"
      refreshControl={
        onRefresh === undefined ? undefined : (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            // Both platforms' spinners default to a colour chosen against a
            // white page, so the accent is named for each rather than left to
            // vanish on a dark background.
            tintColor={theme.colors.accent}
            colors={[theme.colors.accent]}
            progressBackgroundColor={theme.colors.surface}
          />
        )
      }
    >
      {children}
    </ScrollView>
  );
}

/**
 * A raised block of related things. The app's only container with an edge.
 *
 * With `onPress` the whole card is a tap target, for a card that leads to more
 * of what it summarises. It is not one element to a screen reader: the card may
 * hold buttons of its own, which a grouped element would hide, so a pressable
 * card must also hold a control that does the same thing as the tap.
 */
export function Card({
  testID,
  children,
  style,
  onPress,
}: {
  readonly testID?: string;
  readonly children: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
  readonly onPress?: () => void;
}) {
  const theme = useTheme();
  const frame: StyleProp<ViewStyle> = [
    {
      backgroundColor: theme.colors.surface,
      borderColor: theme.colors.border,
      borderRadius: theme.radius.lg,
      borderWidth: 1,
      gap: theme.space.md,
      padding: theme.space.xl,
    },
    style,
  ];
  if (onPress === undefined) {
    return (
      <View testID={testID} style={frame}>
        {children}
      </View>
    );
  }
  return (
    <Pressable
      testID={testID}
      accessible={false}
      onPress={onPress}
      style={({ pressed }) => [frame, pressed && styles.pressed]}
    >
      {children}
    </Pressable>
  );
}

export type ButtonVariant = "primary" | "secondary" | "danger";

export interface ButtonProps {
  readonly testID: string;
  readonly label: string;
  readonly onPress: () => void;
  readonly variant?: ButtonVariant;
  readonly disabled?: boolean;
  /** Draws a spinner in place of the label and reports the button as busy. */
  readonly busy?: boolean;
  readonly style?: StyleProp<ViewStyle>;
}

/**
 * The filled action. `primary` is the one thing the screen wants next, so a
 * screen should show at most one; `secondary` is the reversible alternative
 * and `danger` is the one that destroys something.
 */
export function Button({
  testID,
  label,
  onPress,
  variant = "primary",
  disabled = false,
  busy = false,
  style,
}: ButtonProps) {
  const theme = useTheme();
  const filled = variant !== "secondary";
  const background = variant === "danger" ? theme.colors.danger : theme.colors.accent;
  const labelColor = filled
    ? variant === "danger"
      ? "#ffffff"
      : theme.colors.onAccent
    : theme.colors.text;
  const inactive = disabled || busy;

  const pressedStyle = ({ pressed }: PressableStateCallbackType): StyleProp<ViewStyle> => [
    styles.button,
    {
      backgroundColor: filled ? background : "transparent",
      borderColor: filled ? "transparent" : theme.colors.border,
      borderRadius: theme.radius.md,
      borderWidth: filled ? 0 : 1,
      paddingHorizontal: theme.space.xl,
    },
    // Touch feedback the user can see without a ripple: the whole control
    // dims, which reads the same on both platforms and in both themes.
    pressed && !inactive && styles.pressed,
    inactive && styles.inactive,
    style,
  ];

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy }}
      testID={testID}
      disabled={inactive}
      onPress={onPress}
      style={pressedStyle}
    >
      {busy ? (
        <ActivityIndicator accessibilityLabel={label} color={labelColor} />
      ) : (
        <Text style={[theme.type.headline, { color: labelColor }]}>{label}</Text>
      )}
    </Pressable>
  );
}

export interface TextButtonProps {
  readonly testID: string;
  readonly label: string;
  readonly onPress: () => void;
  readonly tone?: "muted" | "accent" | "danger";
  readonly disabled?: boolean;
}

/**
 * A tappable line of text, for the actions that should stay reachable without
 * competing with the screen's real one. It still carries the full touch target
 * a finger needs; only the paint is quiet.
 */
export function TextButton({
  testID,
  label,
  onPress,
  tone = "muted",
  disabled = false,
}: TextButtonProps) {
  const theme = useTheme();
  const color =
    tone === "danger"
      ? theme.colors.danger
      : tone === "accent"
        ? theme.colors.accent
        : theme.colors.textMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.textButton,
        pressed && !disabled && styles.pressed,
        disabled && styles.inactive,
      ]}
    >
      <Text style={[theme.type.small, { color, fontWeight: "600", textAlign: "center" }]}>
        {label}
      </Text>
    </Pressable>
  );
}

export type BannerTone = "info" | "warning" | "danger" | "success";

/**
 * A short piece of news about the user's situation - a missed day, a card that
 * no longer works, a challenge finished. The wash is what separates it from
 * the body text around it; the tone is what says how worried to be.
 */
export function Banner({
  tone,
  testID,
  children,
}: {
  readonly tone: BannerTone;
  readonly testID?: string;
  readonly children: ReactNode;
}) {
  const theme = useTheme();
  const wash = {
    info: theme.colors.accentSoft,
    warning: theme.colors.warningSoft,
    danger: theme.colors.dangerSoft,
    success: theme.colors.successSoft,
  }[tone];
  const edge = {
    info: theme.colors.accent,
    warning: theme.colors.warning,
    danger: theme.colors.danger,
    success: theme.colors.success,
  }[tone];
  return (
    <View
      testID={testID}
      style={{
        backgroundColor: wash,
        borderLeftColor: edge,
        borderLeftWidth: 3,
        borderRadius: theme.radius.sm,
        gap: theme.space.md,
        padding: theme.space.lg,
      }}
    >
      {children}
    </View>
  );
}

export type StatusTone = "accent" | "success" | "danger" | "warning";

/**
 * One word for the state a thing is in, carried by a coloured dot.
 *
 * It exists so a status is read at a glance rather than out of a sentence, and
 * so the same state is the same colour wherever it appears; the dot is what
 * carries the state for a reader who cannot separate the four hues.
 */
export function StatusPill({
  label,
  tone,
  testID,
}: {
  readonly label: string;
  readonly tone: StatusTone;
  readonly testID?: string;
}) {
  const theme = useTheme();
  const color = theme.colors[tone];
  const wash = {
    accent: theme.colors.accentSoft,
    success: theme.colors.successSoft,
    danger: theme.colors.dangerSoft,
    warning: theme.colors.warningSoft,
  }[tone];
  return (
    <View
      style={[
        styles.pill,
        {
          backgroundColor: wash,
          borderRadius: theme.radius.pill,
          paddingHorizontal: theme.space.md,
        },
      ]}
    >
      <View style={[styles.dot, { backgroundColor: color }]} />
      {/* Spread rather than passed: under exactOptionalPropertyTypes an
          explicit `undefined` is not the same as an absent testID. */}
      <AppText variant="caption" tone={tone} {...(testID === undefined ? {} : { testID })}>
        {label}
      </AppText>
    </View>
  );
}

/** How far through a challenge, or a day's steps, the user is. */
export function ProgressBar({
  done,
  total,
  testID,
}: {
  readonly done: number;
  readonly total: number;
  readonly testID?: string;
}) {
  const theme = useTheme();
  const fraction = total === 0 ? 0 : Math.min(1, Math.max(0, done / total));
  return (
    <View
      testID={testID}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: total, now: done }}
      style={{
        backgroundColor: theme.colors.track,
        borderRadius: theme.radius.pill,
        flexDirection: "row",
        height: 10,
        overflow: "hidden",
      }}
    >
      <View style={{ flex: fraction, backgroundColor: theme.colors.accent }} />
      <View style={{ flex: 1 - fraction }} />
    </View>
  );
}

export type DayMarkTone = "success" | "danger" | "warning" | "accent" | "muted" | "rest";

export interface DayMark {
  /**
   * What this day is, in the same names statuses are read in elsewhere.
   * `rest` is a date that holds no walk, drawn as an empty square.
   */
  readonly tone: DayMarkTone;
  /** Drawn as a ring rather than a block: the day being asked for right now. */
  readonly outlined?: boolean;
}

/** One square of a calendar: its day of the month, or null for padding. */
export interface CalendarCell {
  readonly label: string;
  readonly mark: DayMark | null;
}

export interface CalendarMonthView {
  readonly title: string;
  /** Monday-first weeks of seven cells each. */
  readonly weeks: readonly (readonly CalendarCell[])[];
}

const WEEKDAYS = [
  { key: "mon", initial: "M" },
  { key: "tue", initial: "T" },
  { key: "wed", initial: "W" },
  { key: "thu", initial: "T" },
  { key: "fri", initial: "F" },
  { key: "sat", initial: "S" },
  { key: "sun", initial: "S" },
] as const;

/**
 * A challenge's days as a wall calendar.
 *
 * A progress count says how far along a challenge is; it cannot say which
 * morning was missed, or that the gap after a Friday is a weekend. A calendar
 * can, because every date sits in its weekday's column.
 *
 * The calendar is one accessible element carrying the sentence its caller
 * wrote, not a square at a time: a screen reader read date by date would be
 * forty announcements of nothing.
 */
export function DayCalendar({
  months,
  accessibilityLabel,
  testID,
}: {
  readonly months: readonly CalendarMonthView[];
  readonly accessibilityLabel: string;
  readonly testID?: string;
}) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={accessibilityLabel}
      style={{ gap: theme.space.sm }}
    >
      {months.map((month) => (
        <View key={month.title} style={{ gap: theme.space.xs }}>
          <AppText variant="caption" tone="muted">
            {month.title}
          </AppText>
          <View style={styles.calendarWeek}>
            {WEEKDAYS.map((weekday) => (
              <AppText
                key={weekday.key}
                variant="caption"
                tone="muted"
                center
                style={styles.calendarCell}
              >
                {weekday.initial}
              </AppText>
            ))}
          </View>
          {month.weeks.map((week, weekIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: position is the week
            <View key={weekIndex} style={styles.calendarWeek}>
              {week.map((cell, dayIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: position is the weekday
                <View key={dayIndex} style={styles.calendarCell}>
                  {cell.mark === null ? null : (
                    <View style={dayMarkStyle(theme, cell.mark, styles.calendarDay)}>
                      <Text
                        style={[theme.type.caption, { color: dayLabelColor(theme, cell.mark) }]}
                      >
                        {cell.label}
                      </Text>
                    </View>
                  )}
                </View>
              ))}
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}

/**
 * The number on a square. A filled square takes the surface colour so the
 * number reads against any tone in either theme; a ring takes its own tone, and
 * a rest day is quiet because nothing happens on it.
 */
function dayLabelColor(theme: Theme, mark: DayMark): string {
  if (mark.tone === "rest") {
    return theme.colors.textMuted;
  }
  if (mark.outlined === true) {
    return markColor(theme, mark.tone);
  }
  return mark.tone === "muted" ? theme.colors.text : theme.colors.surface;
}

/**
 * What each mark in the calendar means, spelled out.
 *
 * Without it the calendar is colour and nothing else, which is a fact withheld from
 * anyone who cannot separate the green of a kept morning from the red of a
 * missed one - and a guess for everyone else, since no screen ever said which
 * was which.
 *
 * It is hidden from a screen reader on purpose: `DayCalendar` already carries the
 * counts as a sentence, and a legend explaining colours to someone who is not
 * looking at them is six announcements that help nobody.
 */
export function DayLegend({
  items,
  testID,
}: {
  readonly items: readonly { readonly mark: DayMark; readonly label: string }[];
  readonly testID?: string;
}) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.dayLegend}
    >
      {items.map(({ mark, label }) => (
        <View key={label} style={styles.dayLegendItem}>
          <View style={dayMarkStyle(theme, mark)} />
          <AppText variant="caption" tone="muted">
            {label}
          </AppText>
        </View>
      ))}
    </View>
  );
}

/**
 * One mark, drawn the same way wherever it appears. The legend is a lie the
 * moment it draws a swatch the row would not draw, so both go through here.
 */
function dayMarkStyle(theme: Theme, mark: DayMark, size: ViewStyle = styles.dayMark) {
  return [
    size,
    mark.tone === "rest"
      ? { borderColor: theme.colors.border, borderWidth: 1 }
      : mark.outlined === true
        ? { borderColor: markColor(theme, mark.tone), borderWidth: 2 }
        : { backgroundColor: markColor(theme, mark.tone) },
  ];
}

function markColor(theme: Theme, tone: DayMarkTone): string {
  const colors: Readonly<Record<DayMarkTone, string>> = {
    success: theme.colors.success,
    danger: theme.colors.danger,
    warning: theme.colors.warning,
    accent: theme.colors.accent,
    muted: theme.colors.track,
    rest: theme.colors.border,
  };
  return colors[tone];
}

export interface FieldProps {
  readonly label: string;
  readonly testID: string;
  readonly value: string;
  readonly onChangeText: (text: string) => void;
  /** The sentence under the label saying what the number is for. */
  readonly hint?: string;
  /**
   * What is wrong with what has been typed, drawn under the box in the danger
   * tone and read out as an alert. It belongs to the field rather than to a
   * summary elsewhere on the screen, because a user fixing a value should not
   * have to find the complaint about it.
   */
  readonly problem?: string;
  /**
   * What the typed value comes to, drawn under the box once it is understood -
   * `7:00 AM` under a typed `7`. Suppressed while there is a problem, since the
   * reading of an unaccepted value is nothing to state.
   */
  readonly reading?: string;
  /**
   * A reading worth a second look, drawn in the warning tone where the plain
   * one would be. For a value the field accepts and would rather the user
   * confirmed - a deposit large enough that a slipped keystroke costs real
   * money. Suppressed by a problem, and never drawn beside a plain reading.
   */
  readonly caution?: string;
  /** Drawn inside the box after the value, for a unit the user should not type. */
  readonly suffix?: string;
  /** Drawn inside the box before the value, for a currency symbol. */
  readonly prefix?: string;
  readonly keyboardType?: KeyboardTypeOptions;
  /**
   * Puts the label and the box on one line. For the short repeated fields - a
   * deadline per weekday - where a stacked label would make a wall of text.
   */
  readonly compact?: boolean;
}

/**
 * A value the user types, with the words that explain it.
 *
 * The label is a real label rather than a placeholder, so it survives the user
 * typing, and the hint is a separate line so a screen never has to explain a
 * number inside its own field name.
 */
export function Field({
  label,
  testID,
  value,
  onChangeText,
  hint,
  problem,
  reading,
  caution,
  suffix,
  prefix,
  keyboardType,
  compact = false,
}: FieldProps) {
  const theme = useTheme();
  const footnote =
    problem !== undefined ? (
      <AppText
        variant="caption"
        tone="danger"
        accessibilityRole="alert"
        testID={`${testID}-problem`}
      >
        {problem}
      </AppText>
    ) : caution !== undefined ? (
      <AppText
        variant="caption"
        tone="warning"
        accessibilityRole="alert"
        testID={`${testID}-caution`}
      >
        {caution}
      </AppText>
    ) : reading !== undefined ? (
      <AppText variant="caption" tone="muted" testID={`${testID}-reading`}>
        {reading}
      </AppText>
    ) : null;
  const box = (
    <View
      style={[
        styles.fieldBox,
        compact ? styles.fieldBoxCompact : styles.fieldBoxWide,
        {
          backgroundColor: theme.colors.background,
          // The box itself carries the complaint too: the sentence under it is
          // easy to miss on a form of eight fields.
          borderColor: problem === undefined ? theme.colors.border : theme.colors.danger,
          borderRadius: theme.radius.sm,
          gap: theme.space.xs,
          paddingHorizontal: theme.space.md,
        },
      ]}
    >
      {prefix === undefined ? null : (
        <AppText variant="body" tone="muted">
          {prefix}
        </AppText>
      )}
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        keyboardType={keyboardType}
        value={value}
        onChangeText={onChangeText}
        // Nothing this app asks for is prose: a wake-up time, a step target, a
        // number of days, an amount of money. Autocorrect on `7am` and a
        // capitalised first letter are both the keyboard guessing at English
        // where the answer is a value.
        autoCapitalize="none"
        autoCorrect={false}
        // Done rather than Return, and the keyboard goes away when it is
        // pressed: there is nothing to submit from a field, and every form here
        // is finished by a button further down the screen.
        returnKeyType="done"
        submitBehavior="blurAndSubmit"
        style={[theme.type.body, styles.fieldInput, { color: theme.colors.text }]}
      />
      {suffix === undefined ? null : (
        <AppText variant="small" tone="muted">
          {suffix}
        </AppText>
      )}
    </View>
  );

  if (compact) {
    return (
      <View style={{ gap: theme.space.xs }}>
        <View style={[styles.row, { gap: theme.space.md }]}>
          <AppText variant="small" style={styles.shrink}>
            {label}
          </AppText>
          {box}
        </View>
        {footnote}
      </View>
    );
  }

  return (
    <View style={{ gap: theme.space.xs }}>
      <AppText variant="small" style={styles.label}>
        {label}
      </AppText>
      {hint === undefined ? null : (
        <AppText variant="caption" tone="muted">
          {hint}
        </AppText>
      )}
      {box}
      {footnote}
    </View>
  );
}

/** A small on/off pill, for picking several things out of a fixed set. */
export function Chip({
  label,
  testID,
  selected,
  onPress,
}: {
  readonly label: string;
  readonly testID: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: selected ? theme.colors.accent : "transparent",
          borderColor: selected ? theme.colors.accent : theme.colors.border,
          borderRadius: theme.radius.pill,
        },
        pressed && styles.pressed,
      ]}
    >
      <Text
        style={[
          theme.type.caption,
          { color: selected ? theme.colors.onAccent : theme.colors.text },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * A statement the user turns on. The whole row is the switch's label, so a
 * screen reader reads the sentence rather than the word "switch".
 */
export function Toggle({
  testID,
  label,
  value,
  onValueChange,
  children,
}: {
  readonly testID: string;
  /** What a screen reader announces; the visible wording is `children`. */
  readonly label: string;
  readonly value: boolean;
  readonly onValueChange: (next: boolean) => void;
  readonly children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={[styles.row, styles.toggle, { gap: theme.space.lg }]}>
      <View style={styles.shrink}>{children}</View>
      <Switch
        testID={testID}
        accessibilityLabel={label}
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: theme.colors.track, true: theme.colors.accent }}
      />
    </View>
  );
}

/** A labelled fact, read left to right. */
export function DetailRow({
  label,
  value,
  testID,
}: {
  readonly label: string;
  readonly value: string;
  readonly testID?: string;
}) {
  const theme = useTheme();
  return (
    <View testID={testID} style={[styles.row, { gap: theme.space.md }]}>
      <AppText variant="small" tone="muted" style={styles.shrink}>
        {label}
      </AppText>
      <AppText variant="small" style={styles.value}>
        {value}
      </AppText>
    </View>
  );
}

/** The hairline that separates two groups inside one card. */
export function Divider() {
  const theme = useTheme();
  return (
    <View style={{ backgroundColor: theme.colors.border, height: StyleSheet.hairlineWidth }} />
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: "center", justifyContent: "center" },
  button: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 50,
    paddingVertical: 14,
  },
  // Every tap target clears the 44pt minimum, including the quiet ones.
  textButton: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 44,
    paddingVertical: 10,
  },
  pressed: { opacity: 0.65 },
  inactive: { opacity: 0.4 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  shrink: { flexShrink: 1 },
  value: { fontWeight: "600" },
  label: { fontWeight: "600" },
  // A typed value clears the same 44pt minimum as a tap target: a short box is
  // as hard to hit as a short button.
  fieldBox: { alignItems: "center", borderWidth: 1, flexDirection: "row", minHeight: 44 },
  fieldBoxWide: { alignSelf: "stretch" },
  fieldBoxCompact: { minWidth: 104 },
  fieldInput: { flex: 1, paddingVertical: 10 },
  chip: {
    alignItems: "center",
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 44,
    minWidth: 48,
    paddingHorizontal: 12,
  },
  toggle: { minHeight: 44 },
  pill: { alignItems: "center", flexDirection: "row", gap: 8, paddingVertical: 6 },
  dot: { borderRadius: 999, height: 8, width: 8 },
  calendarWeek: { flexDirection: "row", gap: 4 },
  calendarCell: { flex: 1 },
  // A calendar square fills its column, where a legend swatch is a fixed size.
  calendarDay: {
    alignItems: "center",
    aspectRatio: 1,
    borderRadius: 8,
    justifyContent: "center",
    width: "100%",
  },
  // Square like the calendar's own squares, at swatch size.
  dayMark: { borderRadius: 4, height: 14, width: 14 },
  dayLegend: { flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 6 },
  dayLegendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
});
