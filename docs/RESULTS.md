# Results

Benchmarks and findings — what works, what does not, with evidence.
Negative results are first-class and are recorded here, not glossed over.

> **Status: no results yet.** No build has run. This document records the
> baseline to preserve and the measurement methodology so that results, when
> they arrive, are comparable and honest.

---

## Methodology

- **Where timing is measured: Node V8.** Sub-second timing cannot be measured
  inside the target serverless runtime, where the clock clamps to one-second
  precision. Node V8 is used as the faithful timing proxy for all latency
  numbers.
- **What the PoC measures: correctness and ordering, not latency.** The
  proof-of-concept passes or fails on whether PHP resumes with the correct
  value from a Promise that had not yet resolved at call time, with host-side
  logging confirming the suspend/resume ordering. See `DECISIONS.md`
  ADR-0005.
- **Latency is recorded for cost tracking**, to see what the added async
  import costs relative to the baseline below.

## Baseline to preserve

Carried from prior prototype work, for comparison once the rebuilt runtime
runs. These are targets to preserve or beat, measured in Node V8:

| Metric              | Baseline    |
|---------------------|-------------|
| Cold start (full)   | ~157 ms     |
| Warm start          | ~20 ms      |
| PHP execution       | ~2–31 ms    |

The Asyncify path is expected to add binary size and some overhead; the JSPI
path is expected to reduce both. Both deltas will be recorded here once
measured.

## Proof-of-concept result

*Pending Session 3.* To be recorded:

- Pass/fail against the success criteria.
- The exact PHP program run and the stdout produced.
- Confirmation of suspend/resume ordering from host-side logs.
- If failed: the exact stack trace and the failing function, so the negative
  result is reproducible and informative.

## Asyncify vs JSPI comparison

*Pending Session 5.* To be recorded:

- Binary size, each path.
- Cold/warm/execution latency, each path, against the baseline.
- Whether JSPI works in the target runtime's compatibility configuration.
- Any frames that could not be suspended under JSPI.

## Negative results and surprises

*None recorded yet.* This section will capture anything that did not work,
with enough detail to reproduce — including dead ends, because knowing what
fails cheaply is part of the project's value.
