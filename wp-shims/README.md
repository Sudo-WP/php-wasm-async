# wp-shims — WordPress-side adapters (GPL-2.0-or-later)

Everything under `wp-shims/` is licensed **GPL-2.0-or-later** (see `LICENSE` in
this directory), runs **inside WordPress** (drop-ins / mu-plugins), and is
licensed **separately** from the Apache-2.0 runtime in the rest of this
repository. The runtime does not include or link this code; interaction is at
arm's length only — the `d1:` PDO DSN and `fp_async_call()` function calls.
See `docs/DECISIONS.md` ADR-0025.

## Contents

- **`db.php`** — WordPress database drop-in: connects PDO to Cloudflare D1 via
  the runtime's `pdo_d1` driver (`new PDO('d1:main')`) and loads the adapted
  MySQL→SQLite translation layer. Transactions degrade gracefully (D1 has
  none); see the `D1-DIVERGENCE:` markers in the source and the full list in
  `docs/RESULTS.md` Session 15.
- **`sqlite/`** — the translation layer, adapted from
  **WordPress/sqlite-database-integration, tag v2.2.23, commit
  `f3ea1a43ba525be382c7a9c17735b6b4d4b11d49`** (GPL-2.0-or-later). Vendored as
  close to verbatim as possible; every deliberate change carries a
  `D1-DIVERGENCE:` comment. Attribution: © the SQLite Database Integration
  contributors / the WordPress project.
- **`requests-transport/`** — `FP_Async_Transport`, a Requests 2.x transport
  backed by `fp_async_call({action:"fetch",…})` (ours, GPL-2.0-or-later), plus
  the vendored `WpOrg\Requests\Transport` interface from
  **WordPress/Requests v2.0.15** (**ISC license**, © 2010-2012 Ryan McCue and
  contributors). Registration: `WpOrg\Requests\Requests::add_transport()`
  (`register-transport.php`) — the supported WP 6.x mechanism; the old
  `http_api_transports` filter is deprecated.
- **`harness/`** — the Session 15 micro-harness (10 checks) used to validate
  the shims against the live runtime without booting WordPress.

## Running the harness

```bash
wrangler dev --local --env php84 --port 8791
curl "http://localhost:8791/?harness=1"     # expect: SUMMARY: 10 PASS, 0 FAIL
```
