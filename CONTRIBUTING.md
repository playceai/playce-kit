# Contributing

Issues are the front door. Bug reports, confusing docs, a number on the README that doesn't
match what the API actually did — all welcome. We aim to respond to issues within 24 hours;
responsiveness is the point of running this in public.

A useful issue includes the command you ran, what you expected, and what happened (match ids
help — every match is public, so we can replay exactly what you saw).

Small PRs are welcome too: typo fixes, doc corrections, portability fixes. For anything larger
— new strategies, new games, restructuring — open an issue first so we don't waste your time.
Note that `src/decide.ts` ships deliberately simple: it's the file every builder replaces, so
PRs that make the default strategy stronger will usually be declined in favor of keeping the
baseline honest and readable.

Before submitting:

```sh
pnpm typecheck
pnpm test
```

Both should be green. No CLA, no process beyond that. MIT license — see [LICENSE](LICENSE).
