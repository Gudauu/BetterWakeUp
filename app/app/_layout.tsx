import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { createNativeProviders } from "../src/auth/native-providers.ts";
import { loadAppConfig } from "../src/config.ts";
import { createSentryReporter } from "../src/reporting/native-reporting.ts";
import { SessionProvider } from "../src/session/session-context.tsx";

// Built once, outside the component: configuring a native SDK is not something
// to redo on a re-render.
const providers = createNativeProviders();

// Reporting is installed before anything else runs, because a crash during
// startup is exactly the one this exists to see. With no DSN configured this
// is the no-op reporter and the SDK is never initialized.
const config = loadAppConfig();
createSentryReporter({
  dsn: config.sentryDsn,
  appVersion: config.appVersion,
  environment: __DEV__ ? "development" : "production",
});

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider providers={providers}>
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerShown: false }} />
      </SessionProvider>
    </SafeAreaProvider>
  );
}
