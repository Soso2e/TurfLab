#!/usr/bin/env python3
"""Deterministic financial ledger calculator for TurfLab.

Computes capital, pending stakes, settled payouts/refunds, and total assets
strictly in Python from saved bet plan files, official result files, and
optional manual virtual bets/settlements. Never delegates math to AI.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ORDERED_TICKET_TYPES = {"exacta", "trifecta"}
DEFAULT_INITIAL_CAPITAL_YEN = 100_000


def _normalize_ticket_type(ticket_type: Any) -> str:
    t = str(ticket_type or "")
    return "wide" if t == "quinella_place" else t


def _canonical_selection(ticket_type: str, selections: Any) -> tuple[int, ...]:
    nums = [int(x) for x in (selections or [])]
    if ticket_type in ORDERED_TICKET_TYPES:
        return tuple(nums)
    return tuple(sorted(nums))


def _financial_outcome(
    pick: dict[str, Any],
    result_doc: dict[str, Any],
) -> tuple[int, int]:
    """Compute (refund, payout) in yen for a single ticket pick."""
    amount = int(pick.get("amount_yen") or 0)
    if amount <= 0:
        return (0, 0)

    result = result_doc.get("result") or {}
    payouts = result_doc.get("payouts") or []
    ticket_type = _normalize_ticket_type(pick.get("ticket_type"))
    raw_sel = pick.get("selections_json") or pick.get("selections") or []
    selection = [int(x) for x in raw_sel]
    entry_status = result.get("entry_status_json") or {}

    if result.get("official_status") == "cancelled" or any(
        str(entry_status.get(str(n))) in ("scratched", "cancelled")
        for n in selection
    ):
        return (amount, 0)

    target_key = _canonical_selection(ticket_type, selection)

    # Check refund rules when not already cancelled/scratched
    refund = 0
    matching_rules = []
    for p in payouts:
        if _normalize_ticket_type(p.get("ticket_type")) != ticket_type:
            continue
        rule = p.get("refund_rule_json")
        if rule is None:
            continue
        scope = rule.get("scope") if isinstance(rule, dict) else None
        if scope == "ticket_type" or _canonical_selection(ticket_type, p.get("selections_json")) == target_key:
            matching_rules.append(rule)

    if len(matching_rules) == 1 and isinstance(matching_rules[0], dict):
        per_100 = int(matching_rules[0].get("refund_per_100_yen") or 0)
        refund = (per_100 * amount) // 100

    if refund > 0:
        return (refund, 0)

    payout = 0
    for p in payouts:
        if _normalize_ticket_type(p.get("ticket_type")) != ticket_type:
            continue
        if p.get("refund_rule_json") is not None:
            continue
        if _canonical_selection(ticket_type, p.get("selections_json")) == target_key:
            per_100 = int(p.get("payout_per_100_yen") or 0)
            payout += (per_100 * amount) // 100

    return (0, payout)


def _load_results(exchange_dir: Path) -> dict[str, dict[str, Any]]:
    """Load latest revision official/cancelled results keyed by race_id."""
    results_dir = exchange_dir / "results"
    by_race: dict[str, dict[str, Any]] = {}
    if not results_dir.is_dir():
        return by_race

    for path in sorted(results_dir.rglob("*.json")):
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        res = doc.get("result")
        if not isinstance(res, dict):
            continue
        race_id = str(res.get("race_id") or "")
        if not race_id:
            continue
        rev = int(res.get("revision") or 0)
        prev = by_race.get(race_id)
        if prev is None or rev >= int((prev.get("result") or {}).get("revision") or 0):
            by_race[race_id] = doc
    return by_race


FUNDED_LANES = ("hit", "ev", "selective", "ai")


def _load_plans(exchange_dir: Path) -> list[dict[str, Any]]:
    """Load funded bet plans from the exchange."""
    plans_dir = exchange_dir / "plans"
    items: list[dict[str, Any]] = []
    if not plans_dir.is_dir():
        return items

    for path in sorted(plans_dir.rglob("*.json")):
        name = path.name
        if name.endswith("-evm.json"):
            continue
        if name.endswith("-hit.json"):
            lane = "hit"
        elif name.endswith("-selective.json"):
            lane = "selective"
        elif name.endswith("-ai.json"):
            lane = "ai"
        else:
            lane = "ev"
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(doc, dict):
            continue
        # Date folder is exchange/plans/YYYY-MM-DD/file.json
        date_str = path.parent.name
        doc_lane = str(doc.get("plan_lane") or lane)
        if doc_lane == "evm":
            continue
        items.append({
            "date": date_str,
            "lane": doc_lane if doc_lane in FUNDED_LANES else lane,
            "doc": doc,
        })
    return items


def compute_ledger(payload: dict[str, Any]) -> dict[str, Any]:
    exchange_dir = Path(str(payload.get("exchange_dir") or ""))
    initial_capital = int(
        payload.get("initial_capital_yen")
        or os.environ.get("TURFLAB_INITIAL_CAPITAL_YEN")
        or DEFAULT_INITIAL_CAPITAL_YEN
    )
    target_date = str(payload.get("target_date") or "")

    results_by_race = _load_results(exchange_dir) if exchange_dir else {}
    plan_items = _load_plans(exchange_dir) if exchange_dir else []

    total_stake = 0
    total_return = 0
    settled_stake = 0
    settled_return = 0
    pending_stake = 0
    settled_races: set[str] = set()
    pending_races: set[str] = set()

    by_lane = {
        lane: {"stake_yen": 0, "return_yen": 0, "settled_stake_yen": 0, "pending_stake_yen": 0, "races": 0}
        for lane in FUNDED_LANES
    }
    by_lane["selective"]["skipped_races"] = 0
    empty_day = {
        "stake_yen": 0, "return_yen": 0, "settled_stake_yen": 0, "pending_stake_yen": 0,
        **{f"{lane}_{metric}_yen": 0 for lane in FUNDED_LANES for metric in ("stake", "return")},
    }
    by_date_map: dict[str, dict[str, int]] = {}

    for item in plan_items:
        date_str = item["date"]
        lane = item["lane"]
        doc = item["doc"]
        race_id = str(doc.get("race_id") or "")
        picks = doc.get("picks") or []
        if not isinstance(picks, list) or len(picks) == 0:
            if lane == "selective":
                by_lane["selective"]["skipped_races"] += 1
            continue

        stake = sum(int(p.get("amount_yen") or 0) for p in picks if isinstance(p, dict))
        if stake <= 0:
            continue

        res_doc = results_by_race.get(race_id)
        official_status = str((res_doc or {}).get("result", {}).get("official_status") or "")
        is_settled = official_status in ("official", "cancelled")

        returned = 0
        if is_settled and res_doc is not None:
            for p in picks:
                if isinstance(p, dict):
                    refund, payout = _financial_outcome(p, res_doc)
                    returned += refund + payout

        lane_bucket = by_lane[lane]
        lane_bucket["stake_yen"] += stake
        lane_bucket["return_yen"] += returned
        lane_bucket["races"] += 1
        if is_settled:
            lane_bucket["settled_stake_yen"] += stake
        else:
            lane_bucket["pending_stake_yen"] += stake

        total_stake += stake
        total_return += returned

        day_bucket = by_date_map.setdefault(date_str, empty_day.copy())
        day_bucket["stake_yen"] += stake
        day_bucket["return_yen"] += returned
        day_bucket[f"{lane}_stake_yen"] += stake
        day_bucket[f"{lane}_return_yen"] += returned

        if is_settled:
            settled_stake += stake
            settled_return += returned
            day_bucket["settled_stake_yen"] += stake
            if race_id:
                settled_races.add(race_id)
        else:
            pending_stake += stake
            day_bucket["pending_stake_yen"] += stake
            if race_id:
                pending_races.add(race_id)

    settled_net = settled_return - settled_stake
    cash_balance = initial_capital - total_stake + total_return
    total_assets = initial_capital + settled_net  # == cash_balance + pending_stake
    return_rate = round(settled_return / settled_stake, 4) if settled_stake > 0 else None

    today_raw = by_date_map.get(target_date, empty_day)
    today = {
        "date": target_date,
        **today_raw,
        "net_yen": today_raw["return_yen"] - today_raw["settled_stake_yen"],
    }

    by_date = [
        {
            "date": d,
            **vals,
            "net_yen": vals["return_yen"] - vals["settled_stake_yen"],
        }
        for d, vals in sorted(by_date_map.items(), reverse=True)
    ]

    return {
        "version": "python-ledger-v1",
        "calculated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "initial_capital_yen": initial_capital,
        "cash_balance_yen": cash_balance,
        "total_assets_yen": total_assets,
        "pending_stake_yen": pending_stake,
        "settled_stake_yen": settled_stake,
        "settled_return_yen": settled_return,
        "settled_net_yen": settled_net,
        "total_stake_yen": total_stake,
        "total_return_yen": total_return,
        "return_rate": return_rate,
        "settled_races": len(settled_races),
        "pending_races": len(pending_races),
        "today": today,
        "by_lane": by_lane,
        "by_date": by_date,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--exchange-dir", default="")
    parser.add_argument("--target-date", default="")
    parser.add_argument("--initial-capital", type=int, default=0)
    parser.add_argument("--input", default="")
    args = parser.parse_args()

    payload: dict[str, Any] = {}
    if args.input == "-":
        raw = sys.stdin.read().strip()
        if raw:
            payload = json.loads(raw)
    elif args.input and args.input != "-":
        payload = json.loads(Path(args.input).read_text(encoding="utf-8"))

    if args.exchange_dir:
        payload["exchange_dir"] = args.exchange_dir
    if args.target_date:
        payload["target_date"] = args.target_date
    if args.initial_capital > 0:
        payload["initial_capital_yen"] = args.initial_capital

    result = compute_ledger(payload)
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
