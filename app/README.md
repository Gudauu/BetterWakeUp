# Mobile application

The Expo React Native app.

Nothing is scaffolded here yet. Issue 27 in `docs/phased-plan.markdown` creates
the Expo Router project, the generated contract client, secure session storage,
and the EAS development build profile, and adds `app` to the pnpm workspace.

The app uses jest-expo rather than Vitest, because Expo's transform pipeline
expects Jest. See "Toolchain" in `docs/architecture.md`.
