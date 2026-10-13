# Docker regtest integration

Run `deno task test:integration` from the repository root. Requires Docker Compose v2, a running
Docker engine, Deno, internet access for the initial build, and enough disk/RAM for Rust builds (8
GiB RAM recommended). Both Linux amd64 CI and macOS arm64 Docker are supported.

The runner builds and starts six services:

- Bitcoin Core 29.0 (official binaries, pinned SHA-256 per architecture).
- Bitcoin Knots 29.4.1.knots20260508 (official binaries, pinned SHA-256), activating BLAKE2b at
  regtest height 110 with an isolated test headline and active reduced-data rules.
- Two electrs instances, pinned to jasonsopko/electrs commit
  `3c812c618230d967f32b3358f6e0615ff123a9aa`, which understands 164-byte BLAKE headers.
- Two real mempool API backends, pinned to Retropex/mempool commit
  `4878106c1df7975f9fa14e6d3dd5db956b49e4fb`. These provide the Esplora-compatible wallet endpoints
  and mempool acceptance endpoint using node RPC and electrs. Database, pricing and Lightning
  services are disabled. A browser explorer frontend is not needed by these tests.

Standard transaction policy is enabled on both regtest nodes (`acceptnonstdtxn=0`). Ancestor,
transaction weight and script policy limits are not raised for BPUB. The test miner uses
`-blockmaxweight=800000`, matching the reduced-data consensus budget, instead of Knots' default 300
KB raw block template. A 500-input reveal fits relay weight policy but exceeds that smaller raw
mining template. Both nodes use a fixed mock clock so the scheduled reduced-data expiry cannot
silently change test coverage. Core mines a common prefix; the test imports those exact blocks into
Knots before both nodes independently mine height 110. There is no connection to mainnet and no
existing wallet or node data is mounted.

The application remains mainnet-only. The test's `RegtestClient` translates address strings from
`bc1` to `bcrt1` for explorer lookups while preserving the identical output scripts. An injected
`ChainVerifier` checks each real regtest fork hash at height 110. Production defaults still require
the mainnet checkpoints; neither test configuration is exposed through wallet settings or RPC. All
transaction construction, signatures, Esplora response validation, coin policy, wallet sync,
publication state and file persistence use production code.

The suite checks receiving, BLAKE splitting and Core replay rejection, then a full 500-input BPUB
publication. It verifies rejection with unconfirmed funding under the default ancestor limit,
saving/reloading before reveal, acceptance after funding confirmation, mined reveal discovery, exact
content recovery, and the ownership reserve. No real funds are used.

Every run uses fresh volumes, a random Compose project and dynamically assigned loopback ports. The
runner always collects `artifacts/integration/compose.log` and tears down its project. If the
process is forcibly killed, use `docker compose ls` to find its `bcashjr-it-*` project and clean up
only that project with `docker compose -p <project> -f tests/integration/compose.yml down -v`. The
runner does not stop or prune unrelated Docker services.

CI runs this suite on PRs and `master`, and the Release workflow calls it as a required predecessor
to release preparation. Node/explorer logs are uploaded even on failures. To upgrade dependencies,
update the pinned revisions/checksums and rerun the complete suite; do not disable relay policy to
make an acceptance failure pass.
