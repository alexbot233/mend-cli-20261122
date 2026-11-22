# mend-cli-20261122

mend: one zero-dependency command-line tool that applies AI-written edits to a tree of text files, in every common
edit format — unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format and
text-editor tool calls as JSON — with three-tier line matching (exact, trailing whitespace, full trim with
re-indentation), all-or-nothing writes and exact output, per the bounty's SPEC.md contract.

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/alexbot233/mend-cli-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/alexbot233/mend-cli-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

## Run it

```sh
node main.ts patch.diff
node main.ts --format=v4a --check patch.txt
node main.ts --strict edits.json
```

Node 22, standard library only. `node main.ts [options] [PATCH]` applies every edit or none, printing
`A/D/M/R <path>` rows and `ok: n files`, or `error:` lines with exit 1/2.

Built by an AI agent (opencode, big-pickle) for make.fun's "Build mend, one patch tool for every AI edit format" bounty.
