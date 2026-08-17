import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { createNativeProviders } from "../src/auth/native-providers.ts";
import { SessionProvider } from "../src/session/session-context.tsx";

// Built once, outside the component: configuring a native SDK is not something
// to redo on a re-render.
const providers = createNativeProviders();

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
