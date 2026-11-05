# GuardBench v1 leaderboard

**GuardBench v1: rules catches 21.9% of violations at 0.9% false blocks**

| Rank | Engine | Split | Recall [95% CI] | False-block [95% CI] | Held-out industry recall | p50 / p95 ms | Span F1 (exact / overlap) | Rows scored | Missing | Errors | Incomplete | Dataset SHA256 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | rules | test | 21.9% [21.1-22.6] | 0.9% [0.7-1.4] | 20.4% [19.3-21.6] | 0.771 / 1.845 | n/a | 15000 | 0 | 0 | no | `33af2416c1d9` |

Ranking: complete results on the test split rank first. Among them, engines at or under 5% false-block rank first by recall (highest first), then the rest by recall. Incomplete results and results on other splits rank last, in the same order.
An incomplete result has missing predictions, prediction errors, or came from a partial run (`--limit`); its numbers cover only the rows scored.
Intervals are Wilson 95%. Recall is violation rows blocked; false-block is clean rows blocked.
