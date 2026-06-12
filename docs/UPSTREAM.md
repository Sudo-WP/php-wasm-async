# Upstream tracking

A standing log of findings that should flow back to upstream projects, so they
are not lost inside our patch files. One entry per item. Filing PRs/issues is a
deliberate, scheduled act involving the project's public GitHub identity — the
maintainer's call, never an automatic session task. Future sessions: add an
entry here whenever an upstream-worthy finding lands.

**Status legend:** TO FILE · FILED (+link) · MERGED · DECLINED

---

## 1. seanmorris/php-wasm — mbstring static-mode configure flags are pre-PHP-8.x (PR candidate)

**Status:** TO FILE

**What & why.** `packages/mbstring/static.mak` passes `--with-mbstring` and
`--with-onig` in static mode. Neither exists in PHP 8.x configure; autoconf
*silently ignores* unknown options, so the build links `libonig.a` into the
binary (size grows) while `ext/mbstring` is never compiled —
`extension_loaded('mbstring')` is false. Found in our Session 13 batch 1
(binary +672 KB with no mbstring).

**Fix (validated on PHP 8.2.11 + 8.4.1, Emscripten sm-updates 3.1.68):**
`--enable-mbstring`; drop `--with-onig` entirely — PHP 8.x finds oniguruma via
`PKG_CHECK_MODULES` and the pipeline already sets `PKG_CONFIG_PATH` with
`lib/lib/pkgconfig/oniguruma.pc` in place.

**Diagnostic tell for the PR description:**
`configure: WARNING: unrecognized options: --with-mbstring, --with-onig`
in the main PHP configure output.

**Lives in our tree:** `patches/session13-extension-floor.patch` (the
`packages/mbstring/static.mak` hunk). Background: `docs/RESULTS.md` Session 13.

---

## 2. seanmorris/php-wasm — gd static-mode bogus `--enable-png` flag (PR candidate; bundle with #1)

**Status:** TO FILE

**What & why.** `packages/gd/static.mak` passes `--enable-png`, which is not a
PHP 8 configure option (libpng is detected via pkg-config). Same
silently-ignored class as #1 — harmless today, but the warning noise masks real
problems of exactly this kind (it nearly masked #1 for us).

**Fix:** remove the flag. **Lives in our tree:**
`patches/session13-extension-floor.patch` (the `packages/gd/static.mak` hunk).

---

## 3. seanmorris/php-wasm — companion extensions cloned from unpinned `master` at build time (issue, not PR)

**Status:** TO FILE

**What & why.** The pipeline git-clones vrzno, pdo-cfd1, and pdo-pglite during
the build from unpinned `master` (`packages/{vrzno,pdo-cfd1,pdo-pglite}/*.mak`)
— builds are not reproducible and the supply chain is open-ended. Compounded
by those repos carrying no license file (GitHub `license: null`), which makes
the legal status of any given cloned commit ambiguous for downstream users.
Details with file/line cites: `docs/RESEARCH-networking.md` §1–§2.

**Suggested shape:** an issue proposing commit pinning (e.g. a pinned SHA or
tag per release, like the rest of the pipeline's third_party pins), mentioning
the missing licenses in the same breath as a hygiene observation. Note: we are
NOT requesting licenses for our own use — ADR-0021 made that moot (we built our
own driver); this is a report for the benefit of the upstream ecosystem.

---

## 4. WordPress/sqlite-database-integration — named-placeholder reuse breaks native-positional PDO drivers (issue/PR candidate)

**Status:** TO FILE

**What & why.** The data-types-cache upsert (classic translator, v2.2.x line)
reuses a named placeholder in one statement:
`VALUES (:table, :column, :datatype) ... DO UPDATE SET mysql_type = :datatype`.
On PDO drivers without native named-parameter support (native-positional +
PDO's rewriter — e.g. mysqlnd in native-prepare mode, or any custom driver),
PDO documentedly does not bind a reused named marker, producing "wrong number
of parameter bindings". pdo_sqlite's native named support masks this. The fix
is also better SQLite: `DO UPDATE SET mysql_type = excluded.mysql_type` (no
reuse, standard upsert form). Found live in our Session 15 harness against
Cloudflare D1 via our pdo_d1 driver.

**Lives in our tree:** `wp-shims/sqlite/class-wp-sqlite-translator.php`
(D1-DIVERGENCE marker at the upsert). Note when filing: upstream's new
AST-based driver (current main) should be checked for the same pattern.
