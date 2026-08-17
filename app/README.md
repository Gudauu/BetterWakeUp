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
- `src/session/` secure storage for session material, and the React context the
  screens read it from.
- `src/screens/` screen components, kept out of `app/` so a test renders one
  without the router.

## Development builds

Expo Go is not used: a Sign in with Apple token issued inside it carries Expo's
own bundle identifier, which the API's audience check rejects. `eas.json` holds
the `development` profile that produces the build to run against instead. It
needs an Expo account and platform credentials, which is recorded under "Handed
back" in `docs/work-log.md`.

Working rules for this package are under "The mobile app" in
`CONTRIBUTING.md`.
