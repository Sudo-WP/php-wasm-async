# php-wasm-async

Run **real PHP in WebAssembly** that can call **asynchronous host functions** —
await a Promise, suspend, and resume with the result — inside edge runtimes
like Cloudflare Workers.

## The problem

PHP is synchronous. Edge data stores — Cloudflare D1, KV, R2 — are async-only.
That mismatch means PHP running in a Worker can't `await` a database query
mid-execution. The usual workaround is to eagerly load all data before PHP
runs, which breaks down the moment a query's terms aren't known until runtime
(dynamic apps, real WordPress, WooCommerce).

## What this provides

A rebuilt PHP-WASM runtime where PHP can call a host-provided async function,
yield, and continue once the Promise resolves — making live, on-demand edge
database access from PHP possible for the first time.

Built on Emscripten + PHP source, based on the WordPress Playground php-wasm
build. Runtime-agnostic: the async primitive doesn't assume any specific data
store — D1 is simply the first consumer.

> ⚠️ **Status: experimental / pre-production.** This is active R&D into an
> unproven capability. Approaches, APIs, and results may change. Negative
> results are documented honestly alongside what works.
