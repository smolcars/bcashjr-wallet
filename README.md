# BcashJr Wallet

BcashJr Wallet is a BIP86 Taproot wallet for Bitcoin and the live BLAKE2b Bitcoin fork. It displays
coins on both chains, splits shared coins with `SIGHASH_UNIFIED` replay protection, and lets each
side be spent independently.

![BcashJr Wallet interface](./bcashjr-wallet.png)

Bitcoin transactions use standard Taproot `SIGHASH_DEFAULT` signatures. BLAKE transactions use
`SIGHASH_ALL | SIGHASH_UNIFIED` (`0x21`).

## Features

- Create a new 12-word BIP39 recovery phrase or restore a BcashJr wallet. Reusing a phrase from
  another wallet is supported but not recommended.
- BIP86 receive addresses derived from `m/86'/0'/0'/0/i`.
- Local password protection using scrypt and XChaCha20-Poly1305.
- Independent Bitcoin and BLAKE Esplora backends, balances, fee settings, and UTXO selection.
- Separate BTC and BLAKE confirmation targets (both default to 1) and address gap. The BLAKE target
  also determines when a split counts as confirmed replay protection.
- BTC (default), sats, or [BIP177](https://github.com/bitcoin/bips/blob/master/bip-0177.mediawiki)
  display units.
- Sweep-only Taproot transactions with RBF and chain-tip locktime. Every selected UTXO is consumed
  in full; after fees, everything goes to one destination with no change output.
- P2PKH, P2TR, P2WPKH, and P2WSH destinations.
- BLAKE splitting with `SIGHASH_UNIFIED`. Send shared coins to yourself or another destination to
  move only their BLAKE copies while leaving the Bitcoin outpoints in place.
- Bitcoin-first spending with an explicit warning whenever replay protection is not guaranteed.
- Replay of a Bitcoin funding transaction from the replay panel when its wallet output has not
  appeared on BLAKE.
- Durable recovery for locally signed transactions whose broadcast or confirmation is uncertain.
- A Deno Desktop application and a local-browser fallback.

## Transaction safety

The wallet keeps current observations from both chains, permanent shared-coin provenance, and a
record of every locally signed transaction. Balances and selectable coins are derived from those
facts rather than stored as separate state.

Before broadcasting, the complete signed transaction is saved to disk. A network or backend error is
treated as an unknown broadcast result, never as proof that the transaction failed. The wallet
retains the transaction and reserves its inputs until it can be verified, rebroadcast, or safely
abandoned.

Final confirmation refreshes the selected coins on both chains, checks relevant pending
transactions, rebuilds the transaction, signs locally, verifies every signature, and broadcasts only
through the selected chain's backend. Both backends must pass their expected fork checkpoint before
their chain identity is trusted.

The `SIGHASH_UNIFIED` implementation is pinned to Bitcoin branch commit
[`54d757f269d21e784c771497e0a26b35ab7d0c5a`](https://github.com/privkeyio/bitcoin/commit/54d757f269d21e784c771497e0a26b35ab7d0c5a).
All 166 vectors from that commit's `src/test/data/unified_sighash.json` are vendored and tested.

## Run locally

Install [Deno 2.9 or newer](https://docs.deno.com/runtime/desktop/) and then:

```bash
deno install
deno task dev
```

When using the browser fallback, open the private `http://127.0.0.1:<port>/#rpc=...` URL printed by
the process. Browser mode uses a fresh OS-assigned port by default; set `PORT` only when a fixed
port is required. The random fragment authenticates that browser tab to the loopback wallet RPC.

Wallet files are stored in `%APPDATA%\bcashjr-wallet` on Windows, `$XDG_DATA_HOME/bcashjr-wallet`
when configured, `~/.local/share/bcashjr-wallet` on Linux, and
`~/Library/Application Support/bcashjr-wallet` on macOS. Set `BCASHJR_DATA_DIR` to override the
location. Only one wallet process can use a data directory at a time.

Build the native desktop package:

```bash
deno task desktop
```

On macOS this creates `dist/macos/BcashJr Wallet.app` and `dist/macos/BcashJr Wallet.dmg`. Local
builds use ad-hoc signing, so contributors do not need an Apple Developer account. The app includes
the runtime and camera entitlements in both signing modes. For an official release, provide your
Developer ID identity:

```bash
MACOS_CODESIGN_IDENTITY="Developer ID Application: Company Name (TEAMID)" deno task desktop
```

That signs both the app and DMG with Developer ID; the DMG is the artifact intended for
distribution. On Windows the task creates `dist/windows/BcashJr Wallet`, and on Linux it creates
`dist/linux/bcashjr-wallet.AppImage`.

The Linux WebView build uses the system's GTK 3 and WebKitGTK 4.1 libraries; on Debian or Ubuntu
these are provided by `libgtk-3-0` and `libwebkit2gtk-4.1-0`. An AppImage downloaded from the web
may need to be made executable before launching. Building the AppImage locally also requires
`squashfs-tools`, which applies the Linux compatibility launcher after Deno creates the package.

### Linux: blank or black window

The AppImage automatically selects GTK's X11 backend through XWayland when launched from a Wayland
session, including sessions that export `GDK_BACKEND=wayland` globally. This avoids a WebKitGTK
native-Wayland failure that can produce a black window and unbounded renderer memory use. It does
not change the desktop session or global settings.

To test native Wayland explicitly, override the packaged default for one launch:

```bash
BCASHJR_NATIVE_WAYLAND=1 GDK_BACKEND=wayland ./bcashjr-wallet.AppImage
```

Replace the filename with your downloaded AppImage's name. Native Wayland may still show the black
window on affected WebKitGTK versions. When XWayland is unavailable, the launcher leaves GTK's
backend selection unchanged rather than forcing an unreachable X11 display.

## Publishing a release

The **Release** workflow is started manually from GitHub Actions. It validates the project, bumps
the selected patch, minor, or major version, and builds these artifacts in parallel:

- A Developer ID-signed and notarized macOS arm64 DMG.
- An unsigned Windows x64 portable ZIP.
- A Linux x64 AppImage.

A dry run performs the complete build and notarization without committing the version, creating a
tag, or publishing a GitHub Release. Its files are available as workflow artifacts. A non-dry run
commits both version manifests to `master`, creates a `v<version>` tag, and publishes the files and
SHA-256 checksums to a GitHub Release. If publication is interrupted after the tag is pushed,
rerunning the failed job resumes the matching tag and draft release instead of incrementing again.

Configure these GitHub Actions repository secrets before running the workflow:

- `MACOS_CERTIFICATE_BASE64`: the Developer ID Application certificate and private key exported as a
  password-protected `.p12`, then Base64 encoded.
- `MACOS_CERTIFICATE_PASSWORD`: the `.p12` export password.
- `APPLE_ID`: the Apple Developer account email used for notarization.
- `APPLE_APP_SPECIFIC_PASSWORD`: an app-specific password for that Apple ID.
- `APPLE_TEAM_ID`: the Apple Developer Team ID.

The repository's workflow token also needs read and write access to repository contents so it can
push the release commit and tag. Windows code signing is separate from Apple signing and is not yet
configured; consequently, Windows may show a SmartScreen warning.

## Verification

```powershell
deno task check
deno task lint
deno task test
deno task ui:build
```

The test suite covers the pinned unified-sighash vectors, BIP39/BIP86 derivation, encrypted secret
storage, coin policy, Bitcoin and BLAKE signing, supported destinations, multi-input transactions,
dual-chain synchronization, replay handling, and reorganization recovery.

## Important safety notes

- Start with a small test amount and confirm the complete split and spend flow before depositing
  meaningful funds.
- An address can be recognized by both chains, but a transaction appearing on Bitcoin does not
  guarantee that it also exists on BLAKE.
- Split shared coins by spending the BLAKE copy first. `SIGHASH_UNIFIED` prevents that transaction
  from being replayed on Bitcoin and leaves the Bitcoin copy untouched.
- Spending Bitcoin first can expose the same transaction on BLAKE. When protection is not
  guaranteed, the wallet explains the risk and requires explicit acknowledgement before signing.
- Replaying a funding transaction broadcasts the complete original Bitcoin transaction unchanged,
  including every input and output. BLAKE may reject it if any input is unavailable or invalid
  there.
- Each configured Esplora backend is trusted as the source of current state for its chain. Backend
  URLs require HTTPS, except for explicit loopback hosts such as `localhost` and `127.0.0.1`.
- `wallet.json` contains public addresses and chain state. Seed material is encrypted in
  `secret.json` and is never sent to either backend.
- Restoration scans only the BIP86 path. Reusing a seed from another wallet is supported but not
  recommended, and the same seed should not be operated concurrently in multiple wallets.
- OS keychain integration is not included in this version.

## Backend access

There is no automatic polling. Backend requests occur only when the user syncs, confirms a
transaction, inspects or replays funding, or starts a full rescan. Recovery processes at most 25 new
addresses per Sync and saves its progress. Final transaction confirmation performs fresh safety
checks even when the dashboard was recently synchronized.

Requests are not retried automatically, including after HTTP 429. Wait for the backend's
`Retry-After` period when provided, then use Sync or retry the action.

This wallet is new software. Start with small amounts and do not use it with irreplaceable funds.
