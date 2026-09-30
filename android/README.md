# FamilyHub for Android

The FamilyHub app puts your family's FamilyHub on your phone:

- **Your server, full screen:** it opens your own FamilyHub full screen and stays signed in.
- **Native notifications:**
  - Chores waiting for approval, with **Approve / Not yet** buttons right on the notification.
  - The **doorbell**: tapping the alert opens that camera.
- **Android conveniences:**
  - the back button works
  - pull down to refresh
  - an app icon and splash screen
- **Always up to date:** every new FamilyHub feature appears in the app automatically, because the screens come from your server.

The first time you open it, enter the address you use in a browser, e.g. `https://family.example.com`. The phone must be able to reach it: on your home Wi-Fi, or over your VPN.

## Install

- **From GitHub:**
  1. Download `FamilyHub-x.y.z.apk` from the repository's **Releases** page, or from the latest **Android app** run in the **Actions** tab.
  2. Open it on your phone. Android asks to allow installing apps from your browser or file manager once.
- **From Google Play:** once published (see below).

## Turn on notifications (Firebase)

Instant notifications use Google's free **Firebase Cloud Messaging**. A head of household sets it up once:

1. At [console.firebase.google.com](https://console.firebase.google.com), **create a project**. Google Analytics isn't needed.
2. **Add app → Android**:
   - Package name: `io.github.hardynetworks.familyhub`
   - Skip the "download google-services.json" and "add Firebase SDK" steps, because the app gets its settings from your FamilyHub server.
3. In **Project settings → General**, copy:
   - the **Web API key**
   - under **Your apps**, the Android **App ID** (looks like `1:1234567890:android:abc123…`)
4. In **Project settings → Service accounts**, click **Generate new private key** and keep the downloaded `.json` file private.
5. In FamilyHub, open **Settings → App settings → Notifications → Android app notifications (Firebase)**:
   - Paste the App ID and API key.
   - Paste the whole contents of the `.json` file into **Service account key**.
   - Save.
6. Open the app on your phone, sign in, and allow notifications when asked. Back in Settings, **Send a test**.

Each parent who signs in to the app gets chore approvals. Everyone who has **doorbell pop-up** turned on gets doorbell alerts.

## Known limitations

**Connecting Google Calendar** has to be done in a browser. Google blocks its sign-in page inside apps, so the app opens it in your browser instead. Connect your Google account from a computer or your phone's browser once; the app then shows your synced events as usual.

## Building

The **Android app** workflow in GitHub Actions builds the app on every change under `android/`. It can also be run by hand from the Actions tab.

- **Without signing secrets:** it builds a **debug APK** for testing.
- **With these four repository secrets:** it builds a signed **release APK** and a Play Store **.aab**. Add them under **Settings → Secrets and variables → Actions**:

  | Secret | Value |
  |---|---|
  | `ANDROID_KEYSTORE_BASE64` | your upload keystore (`.jks`), base64-encoded |
  | `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
  | `ANDROID_KEY_ALIAS` | the key alias |
  | `ANDROID_KEY_PASSWORD` | the key password |

- **To make a GitHub release** with the APK attached, push a tag like `app-v1.0.0`.

To create a keystore yourself:

```bash
keytool -genkeypair -v -keystore familyhub-upload.jks -alias familyhub -keyalg RSA -keysize 4096 -validity 10000
base64 -w0 familyhub-upload.jks > ANDROID_KEYSTORE_BASE64.txt
```

Keep the keystore and its password backed up and **out of the repository**. Every update must be signed with the same key.

## Publishing on Google Play

1. Create a [Google Play Console](https://play.google.com/console) developer account ($25 one-time). New personal accounts must verify their identity.
2. **Create app:** name **FamilyHub**, type **App**, **Free**.
3. **Upload the bundle:** under **Test and release → Testing → Internal testing**, create a release and upload `FamilyHub-x.y.z.aab` from the Actions run.
   - Accept **Play App Signing**. Google keeps the final signing key, and your keystore becomes the "upload key".
   - Add yourself as a tester and install the app from the opt-in link.
4. **Store listing:**
   - Icon: `android/store/icon-512.png`
   - Feature graphic: `android/store/feature-graphic-1024x500.png`
   - Screenshots: `docs/screenshots/mobile-*.png`
   - A short and full description
5. **App content** section:
   - **Privacy policy:** link to [`android/PRIVACY.md`](PRIVACY.md) on GitHub.
   - **Data safety:**
     - The developer collects no data. Everything goes to the family's own server.
     - Firebase receives a device token for notifications.
     - Data is encrypted in transit when your server uses HTTPS.
   - **Target audience:** 18+. Parents install and manage it; children use the family's own screens.
   - **Ads:** none.
   - **Content rating questionnaire:** fill it in.
6. **Before production:**
   - New personal developer accounts must run a **closed test with at least 12 testers for 14 days** before they can publish to production.
   - Then promote the release to **Production**.

Google Play reviews apps that mostly show a website. FamilyHub's native notifications, notification actions and server setup screen are what make it an app. Mention them in the description and review notes.
