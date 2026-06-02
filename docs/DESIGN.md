# Design

The async host-call bridge for PHP-on-WebAssembly: what it is, the interface,
the approach, and the rationale.

---

## The problem

PHP executes synchronously. When PHP wants data, it makes a blocking call and
expects the value to be available when the call returns. Many host
environments — particularly serverless edge runtimes — expose their data
stores and I/O only through asynchronous, Promise-returning APIs.

The current workaround is to load all required data eagerly before PHP runs
and flush results afterward. This fails whenever the data PHP needs is not
known until PHP executes — for example, a query whose terms are computed at
runtime. The result is that genuinely dynamic PHP applications cannot run
faithfully on async-only hosts.

## The capability

This project provides a single, generic primitive:

> PHP calls a host function, the host returns a Promise, PHP suspends until
> the Promise resolves, and PHP resumes with the resolved value as the return
> value of the call.

From PHP's point of view the call is ordinary and synchronous. The
suspension and resumption happen at the boundary between WebAssembly and the
host, invisible to the PHP program.

### Deliberately generic

The primitive does **not** assume any particular data store, protocol, or
host. It is a general "await a host Promise" facility. Specific data stores,
key-value stores, object stores, network calls, or other async host
capabilities are **consumers** of the primitive, layered on top — not
assumptions baked into it. This keeps the runtime reusable across downstream
projects and avoids coupling the interface to any one platform.

## The interface

A single host-call entry point, illustrated here by its intent rather than
its implementation:

- **PHP side:** a callable, e.g. `fp_async_call($payload)`, that returns the
  resolved value.
- **Host side:** a registered JavaScript function that receives the payload
  and returns a Promise.
- **Runtime:** suspends the WebAssembly execution when the host function is
  invoked and resumes it when the returned Promise settles, propagating a
  resolved value as the return and a rejection as a PHP-visible error.

The payload and return are kept simple and serializable so the bridge stays
transport-agnostic. Higher-level consumers define their own conventions on
top of this single call.

### Proof-of-concept shape

The smallest program that demonstrates the capability (no data store, no
application framework):

```php
<?php
echo "before:\n";
$r = fp_async_call(41);     // suspends here; host resolves a Promise to 42
echo "after: " . $r . "\n"; // must print 42
```

Success requires that the value `42` come from a Promise that had **not**
resolved at the moment `fp_async_call` was invoked, with host-side logging
confirming that control returned to the host, the event loop turned, the
Promise resolved, and only then PHP resumed. See `DECISIONS.md` ADR-0005.

## Approach

Adding a new async host import is not possible purely from the host side: the
set of functions across which the runtime may suspend is fixed when PHP is
compiled to WebAssembly. Therefore the runtime must be **recompiled** to add
the new import to the suspendable set. This is true regardless of the
underlying suspension mechanism.

Two mechanisms exist:

**Asyncify** transforms the WebAssembly so that listed functions can unwind
their stack into a buffer and later rewind it. It is proven in the target
runtime and requires no host feature flag. Its costs are a larger binary and
runtime overhead, and it fails at runtime if the list of suspendable
functions is not exhaustive — a missing function surfaces as a crash whose
stack trace identifies the omission.

**JSPI** (JavaScript Promise Integration) moves suspension into the virtual
machine via native stack switching. It avoids the binary growth and the
instrumentation overhead. Its costs are that its availability in the target
serverless runtime is observed-in-practice rather than documented as a stable
feature, and that it constrains which frames may suspend.

**Chosen approach:** prove the primitive on Asyncify, then port to JSPI as a
size and performance optimization once JSPI availability is confirmed in the
target runtime's compatibility configuration. Rationale and alternatives are
recorded in `DECISIONS.md` ADR-0002.

## Runtime integration constraints

- **No runtime compilation of WebAssembly.** The target serverless runtime
  blocks compiling WebAssembly from bytes at request time. The binary must be
  statically bundled at deploy time and instantiated through the loader's
  instantiation hook.
- **Output via host callback.** Program output is delivered through a host
  stdout callback rather than the toolchain's default print path.

These constraints shape the loader, which is written specifically for the
target runtime rather than reusing a Node- or browser-oriented loader.

## References

- WebAssembly JavaScript Promise Integration proposal —
  https://github.com/WebAssembly/js-promise-integration
- Emscripten asynchronous code (Asyncify and JSPI) —
  https://emscripten.org/docs/porting/asyncify.html
- Prior art: `seanmorris/php-wasm` (Apache-2.0) and WordPress Playground's
  PHP-WASM build pipeline.
