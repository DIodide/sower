# Sower iOS

Native iPhone app (SwiftUI, iOS 17+) for viewing the Sower job-application pipeline. Read-only v1 — no third-party dependencies.

## Regenerate the project

The Xcode project is generated from `project.yml` (do not hand-edit `Sower.xcodeproj`):

```sh
cd ios
xcodegen generate
```

## Run on your iPhone

1. Open `ios/Sower.xcodeproj` in Xcode.
2. Select the **Sower** target → **Signing & Capabilities** → set your **Team** (personal Apple ID is fine). Xcode will manage the provisioning profile; change the bundle id if it collides.
3. Plug in your iPhone (or use a paired device over Wi-Fi), pick it as the run destination, and hit **Run**.
4. First run on a free provisioning profile: on the phone, trust the developer cert under Settings → General → VPN & Device Management.

## Configure the backend

In the app, go to the **Settings** tab:

- **Base URL** — the Cloud Run URL, e.g. `https://sower-api-487965588852.us-east1.run.app` (stored in UserDefaults).
- **API key** — paste the mobile API key here (stored in the iOS Keychain, never in UserDefaults).

Tap **Test connection** to verify — it hits `GET /mobile/overview` with the `x-api-key` header and reports success or the failure reason.

## Layout

- `project.yml` — xcodegen spec (iPhone-only, portrait, iOS 17.0 deployment target).
- `Sower/` — app sources: `APIClient` (typed errors), defensive `Decodable` models, `KeychainHelper`, `@Observable` view models, and views (`PipelineView`, `TaskDetailView`, `FollowupDetailView`, `SettingsView`).
