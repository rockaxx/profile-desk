# Profile Desk

Desktop pilot for manual browsing in separate Google Chrome profiles, with optional per-profile proxy routing. It uses installed Chrome Stable for browsing and Electron for the workspace UI.

## Install a release

Download a package from [GitHub Releases](https://github.com/rockaxx/profile-desk/releases). Install Google Chrome Stable before opening Profile Desk.

- **Windows x64** — extract the entire ZIP and open **Profile Desk.exe**.
- **Mac with Apple Silicon** — open the **macos-arm64.dmg** and drag **Profile Desk** to **Applications**.
- **Mac with Intel** — use the **macos-x64.dmg**.

Release packages include Electron. Windows builds have no publisher signature. Mac builds are signed ad hoc and lack Apple notarization. Your system may prompt for approval.

## Run from source

Install Node.js 22.12 or newer and Google Chrome Stable. On macOS, place Chrome in Applications.

    npm ci
    npm start

Create a profile, select Direct, HTTP, HTTPS or SOCKS5, and save it. Use **Test connection** to see the observed exit IP and round-trip check time. **Open** launches the actual Chrome window. Close that window to edit the profile or change its route. Profile Desk keeps the local proxy running while Chrome is open.

Proxy credentials are encrypted via Electron safeStorage (Windows DPAPI or macOS Keychain). Chrome data and workspace metadata are local to the device. Removing a profile from the workspace leaves its Chrome data on disk.

**Advanced** stores startup tabs, a note, window size, device scale, preferred web languages, WebRTC IP handling, default location permissions and graphics privacy settings per profile. Browser language preferences affect web languages. Chrome's UI language follows the platform. Graphics privacy can block WebGL, Canvas pixel readback or both.

Use the shield button to run **Network & Privacy Diagnostics**. IPv4 and IPv6 are checked separately through ipify. Browser values come from an isolated local Chrome sample. A private DevTools pipe applies the optional QA User-Agent, time zone and simulated location to the local sample page. The DNS check compares a reserved test hostname against Chrome NetLog and the local proxy gateway. The WebRTC check samples ICE candidates without a STUN server. These checks describe the sample and do not rule out other resolver or WebRTC paths.

## Android Emulator

On Windows x64 or macOS, open **Open in Android**, review and accept the Android SDK license in the dialog, then click **Install Android tools**. The installer runs in the background and streams its output into Profile Desk. It downloads verified command-line tools and Java if needed, then installs the emulator, Platform-Tools and an Android 35 Google Play system image. It creates **Profile_Desk_Pixel**. On Windows, the optional Hypervisor Platform setting can request UAC approval. Restart Windows if prompted.

You can also install **Android Emulator** and **Android SDK Platform-Tools** with Android Studio's SDK Manager. In **Device Manager**, create a virtual device. If Google Chrome is missing, install it from the Play Store on a device with a Google Play system image.

In Profile Desk, click the phone icon (**Open in Android**) on a profile. Pick an AVD and click **Open Chrome**. You can supply a local development URL or leave the field blank to open Chrome. The launcher maps the host's IPv4 loopback to the emulator's **10.0.2.2** alias. Use a local server listening on IPv4, for example **http://localhost:3000/**. The first local startup URL from the desktop profile is suggested when available.

New emulator sessions open in the Profile Desk viewer. Click or drag the image to tap or swipe, or use Back, Home and the text controls. **Stop Android** shuts down the selected virtual device. An emulator already opened externally may still have a separate window. Stop that session and open it again for the embedded view alone.

Android Chrome stores its browsing data in the selected AVD. Proxied profiles set an Android system HTTP proxy through an ADB tunnel to the profile's HTTP, HTTPS or SOCKS5 gateway. Chrome starts with a fresh IP check. Compare its result with the gateway IP shown above the viewer. This routes Chrome's web requests. Other Android apps may use their own network settings. **Stop Android** clears the managed proxy. Local QA URLs are available in Direct profiles. For isolated mobile sessions, use a different AVD for each session. Profile Desk looks for the SDK in its default location or via **ANDROID_HOME** and **ANDROID_SDK_ROOT**.

Use **Screen zoom** and **Expand viewer** to enlarge Android. **Phone-size Chrome** opens desktop Chrome in a small window with the profile's existing connection and browser data. It starts without an Android SDK or emulator.

The connection check contacts [ipify](https://www.ipify.org/) through the same local proxy gateway Chrome uses. It verifies the route to that endpoint. Proxied profiles block launch if the check fails, and are launched with a fixed gateway and no direct fallback for proxied web requests. This setting applies to browser web requests and does not serve as an operating-system VPN or firewall.

## Development

    npm test
    npm run package

Run packaging on the target OS and architecture. This produces an unpacked app in dist. Public macOS distribution requires signing and notarization.

## Design credits

[Tabler UI](https://github.com/tabler/tabler) (MIT), [Tabler Icons](https://github.com/tabler/tabler-icons) (MIT), and [Inter](https://github.com/rsms/inter) (SIL Open Font License) are used in the desktop interface. The workspace layout and colors are customized for Profile Desk. See the [third-party notices](THIRD_PARTY_NOTICES.md).
