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

The connection check contacts [ipify](https://www.ipify.org/) through the same local proxy gateway Chrome uses. It verifies the route to that endpoint. Proxied profiles block launch if the check fails, and are launched with a fixed gateway and no direct fallback for proxied web requests. This setting applies to browser web requests and does not serve as an operating-system VPN or firewall.

## Development

    npm test
    npm run package

Run packaging on the target OS and architecture. This produces an unpacked app in dist. Public macOS distribution requires signing and notarization.

## Design credits

[Tabler UI](https://github.com/tabler/tabler) (MIT), [Tabler Icons](https://github.com/tabler/tabler-icons) (MIT), and [Inter](https://github.com/rsms/inter) (SIL Open Font License) are used in the desktop interface. The workspace layout and colors are customized for Profile Desk. See the [third-party notices](THIRD_PARTY_NOTICES.md).
