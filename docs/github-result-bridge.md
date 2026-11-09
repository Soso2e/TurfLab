# GitHub Official Result Bridge (experimental)

The Windows GitHub Worker scans a private, append-only `results/YYYY-MM-DD/<core-race-key>-official-vN.json` file. It sends JSON to authenticated local API `/api/github-bridge/official-result` and calls existing `saveResult` and `settle` in a single staged operation.

## Input (complete official result only)

```json
{
  "bridge_version": "1",
  "source_verification": "official_page_checked",
  "source_checked_at": "2026-11-04T00:00:00Z",
  "race_date_jst": "YYYY-MM-DD",
  "payouts_complete": true,
  "published_at_basis": "official",
  "result": {
    "result_id": "unique-official-result-version-id",
    "race_id": "existing Core race_id from immutable pack",
    "revision": 1,
    "official_status": "official",
    "published_at": "UTC timestamp",
    "source_url": "https://www.keiba.go.jp/actual-official-result",
    "retrieved_at": "same UTC timestamp as source_checked_at",
    "finish_order_json": [[1], [2], [3]],
    "entry_status_json": { "1": "finished", "2": "finished", "3": "finished" },
    "supersedes_result_id": null
  },
  "payouts": [{
    "payout_id": "unique-payout-version-id",
    "ticket_type": "win",
    "selections_json": [1],
    "payout_per_100_yen": 300,
    "refund_rule_json": null
  }]
}
```

This is **illustrative schema only, not a real race**. The real file must contain every registered runner and **all** official payouts/returns, including revisions and refunds, with legitimate source evidence. A racing result with just the first three placings cannot be imported. Obtain actual IDs from Core, never invent them. Result revisions use `-official-v2.json` and link `supersedes_result_id`; do not overwrite v1.

**Publication time.** Official result pages often show no publication time. Then set `published_at_basis` to `"retrieved_upper_bound"` and `result.published_at` to `null`: Core stores `source_checked_at` as `published_at` (the result was published no later than it was read), sets `is_estimated: true` and records `evidence_json.published_at_basis`. This can only make a result look later than it really was, so it never lets a result leak into an earlier prediction. Never fill `published_at` with a guessed time. `published_at_basis` defaults to `"official"`, which still requires an observed `published_at`.

The intake checks the event date, original Core race ID, sequential revision, official URL hostname for JRA/NAR, HTTPS, actual result-publication/verification times, all statuses, tied finish order, ticket types and payout validity. An accepted result is saved and already-confirmed **virtual** owner bets are settled; no actual wagers or new owner bets. The result and settlements can be revised by the preexisting Core logic.

**Trust boundary:** the official URL and `source_verification` text are provided by the connected ChatGPT/GitHub writer. Core validates structure and consistency, but does **not independently fetch the official webpage** or prove completeness of the payout feed. Producers MUST inspect the official document at the claimed time, and missing or partial data must be kept as reference review rather than exported to `results/`. This is not permission to scrape or redistribute official CSVs.

The current 09:00 ChatGPT daily report's `previous_day_review` has only top placings and partial ticket payouts, so it is **not** an accepted result file. The official full-results producer and its unattended acceptance remain unproven.

For a new result the producer may omit `result.result_id` and each payout's `payout_id`: the authenticated Core intake derives stable deterministic internal IDs. Revision corrections still need the actual `supersedes_result_id` read from existing Core state, and the file path uses the stable Core race ID from a verified pack.
