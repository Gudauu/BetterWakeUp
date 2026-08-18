# Mobile application

The Expo React Native app: Expo Router, TypeScript, and the shared contract
package as the only description of what the API accepts and returns.

```sh
pnpm --filter @betterwakeup/app run start    # Metro, against a development build
pnpm --filter @betterwakeup/app run test     # Jest
pnpm --filter @betterwakeup/app run bundle   # export the iOS and Android bundles
```

The app uses jest-expo rather than Vitest, because Expo's transform pipeline
expects Jest. See "Toolchain" in `docs/architecture.md`.

## Layout

- `app/` file-based routes. `index.tsx` is the welcome screen.
- `src/api/` the client built from the contract's endpoint registry, and the
  one error type it raises.
- `src/auth/` the two native sign-in providers behind one interface, and the
  sign-in flow that exchanges a credential for a session.
- `src/challenges/` the in-memory draft a challenge is configured in, the
  command that creates a challenge or authorizes a deposit (acknowledging the
  contract's disclosures), how a pause is presented, and the pause, resume,
  recovery, and deletion commands with their confirmation gates.
- `src/completions/` the SQLite store holding completions until the server
  acknowledges them, the pass that sends them, and the four-state view of
  today's task the screen renders.
- `src/movement/` the pedometer behind one port, the normalization every
  reading passes through, and the foreground-only capture.
- `src/reporting/` the crash and synchronization reporting port, the scrubbing
  every payload passes through, what a sync failure reports, and the one module
  that imports Sentry.
- `src/session/` secure storage for session material, and the React context the
  screens read it from.
- `src/screens/` screen components, kept out of `app/` so a test renders one
  without the router, including the two-step control every irreversible action
  is taken through.

## Development builds

Expo Go is not used: a Sign in with Apple token issued inside it carries Expo's
own bundle identifier, which the API's audience check rejects. `eas.json` holds
the `development` profile that produces the build to run against instead. It
needs an Expo account and platform credentials, which is recorded under "Handed
back" in `docs/work-log.md`.

## Build configuration

`app.json` holds everything static, including the Google client IDs, which are
public identifiers rather than secrets. `app.config.ts` adds what depends on
the build, which today is Google's config plugin, included only when a reversed
iOS client ID is available. That scheme is derived from `extra.googleIosClientId`
rather than written out again, so there is one copy of the identifier and no
hand-flipped second one to drift; `EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME` still
overrides it for a build pointed at another Google project.

The server has to accept the same client IDs as audiences. Those live in
`infra/src/audiences.ts`, and `infra/test/audiences.test.ts` reads `app.json`
and fails if the two lists ever disagree.

| Variable | Effect when absent |
| --- | --- |
| `EXPO_PUBLIC_API_BASE_URL` | falls back to `extra.apiBaseUrl` in `app.json` |
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | falls back to `extra.googleWebClientId` in `app.json` |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` | falls back to `extra.googleIosClientId` in `app.json` |
| `EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME` | derived from `extra.googleIosClientId`; the plugin is left out only if that is absent too |
| `EXPO_PUBLIC_SENTRY_DSN` | crash and synchronization reporting is inactive and the SDK is never initialized |

Working rules for this package are under "The mobile app" in
`CONTRIBUTING.md`.
