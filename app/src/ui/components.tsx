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
  readonly style?: StyleProp<ViewStyle>;
  readonly children: ReactNode;
}

/**
 * The frame: the background colour, the safe area, and the horizontal gutter.
 * Scrolls by default, because any screen can overflow once the device is set
 * to a large text size even if it fits at the default one.
 */
export function Screen({ testID, centered = false, style, children }: ScreenProps) {
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
    >
      {children}
    </ScrollView>
  );
}

/** A raised block of related things. The app's only container with an edge. */
export function Card({
  testID,
  children,
  style,
}: {
  readonly testID?: string;
  readonly children: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={[
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderRadius: theme.radius.lg,
          borderWidth: 1,
          gap: theme.space.md,
          padding: theme.space.xl,
        },
        style,
      ]}
    >
      {children}
    </View>
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

export type DayMarkTone = "success" | "danger" | "warning" | "accent" | "muted";

export interface DayMark {
  /** What this day is, in the same names statuses are read in elsewhere. */
  readonly tone: DayMarkTone;
  /** Drawn as a ring rather than a block: the day being asked for right now. */
  readonly outlined?: boolean;
}

/**
 * A challenge's days as a row of marks.
 *
 * A progress bar says how far along a month is; it cannot say which morning was
 * missed or how many are still ahead. The row can, in the space of two lines,
 * which is why it sits beside the bar rather than instead of it.
 *
 * The row is one accessible element carrying the sentence its caller wrote, not
 * thirty unlabelled squares: a screen reader read mark by mark would be thirty
 * announcements of nothing.
 */
export function DayStrip({
  days,
  accessibilityLabel,
  testID,
}: {
  readonly days: readonly DayMark[];
  readonly accessibilityLabel: string;
  readonly testID?: string;
}) {
  const theme = useTheme();
  const colors: Readonly<Record<DayMarkTone, string>> = {
    success: theme.colors.success,
    danger: theme.colors.danger,
    warning: theme.colors.warning,
    accent: theme.colors.accent,
    muted: theme.colors.track,
  };
  return (
    <View
      testID={testID}
      accessible
      accessibilityLabel={accessibilityLabel}
      style={styles.dayStrip}
    >
      {days.map((day, index) => (
        <View
          // The row is a calendar: position is the identity, and two days can
          // be the same mark without being the same day.
          // biome-ignore lint/suspicious/noArrayIndexKey: position is the day
          key={index}
          style={[
            styles.dayMark,
            { borderRadius: theme.radius.sm },
            day.outlined === true
              ? { borderColor: colors[day.tone], borderWidth: 2 }
              : { backgroundColor: colors[day.tone] },
          ]}
        />
      ))}
    </View>
  );
}

export interface FieldProps {
  readonly label: string;
  readonly testID: string;
  readonly value: string;
  readonly onChangeText: (text: string) => void;
  /** The sentence under the label saying what the number is for. */
  readonly hint?: string;
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
  suffix,
  prefix,
  keyboardType,
  compact = false,
}: FieldProps) {
  const theme = useTheme();
  const box = (
    <View
      style={[
        styles.fieldBox,
        compact ? styles.fieldBoxCompact : styles.fieldBoxWide,
        {
          backgroundColor: theme.colors.background,
          borderColor: theme.colors.border,
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
      <View style={[styles.row, { gap: theme.space.md }]}>
        <AppText variant="small" style={styles.shrink}>
          {label}
        </AppText>
        {box}
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
  // Wrapping rather than scrolling: a month has to be readable as a shape in
  // one glance, and a row the user has to swipe hides the days behind the edge.
  dayStrip: { flexDirection: "row", flexWrap: "wrap", gap: 5 },
  dayMark: { height: 14, width: 14 },
});
