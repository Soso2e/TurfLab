import {
  arr,
  canonical,
  hash,
  instant,
  jstDate,
  money,
  num,
  obj,
  requireCondition,
  rows,
  str,
  ticket,
  type Row,
} from "../../../packages/shared/src/domain";
import {
  get,
  immutablePut,
  type Repository,
} from "../../../packages/shared/src/repository";
import { StagedRepository } from "./storage";
export async function audit(
  repo: Repository,
  operationId: string,
  action: string,
  entity: string,
  now: string,
  before: Row | null,
  after: Row,
  entityId = operationId,
  evidence?: Row,
): Promise<void> {
  const existing = await repo.get("audit_events", `${action}:${operationId}`);
  if (existing) {
    requireCondition(
      existing.after_hash === (await hash(after)),
      "操作IDの監査内容が競合しています",
      409,
    );
    return;
  }
  await immutablePut(repo, "audit_events", {
    schema_version: "0.2",
    created_at: now,
    event_id: `${action}:${operationId}`,
    operation_id: operationId,
    actor: "owner",
    action,
    entity_type: entity,
    entity_id: entityId,
    before_hash: before ? await hash(before) : null,
    after_hash: await hash(after),
    event_at: now,
    ...(evidence ? { evidence_json: evidence } : {}),
  });
}
export async function confirmBet(
  repo: Repository,
  input: Row,
  now: string,
): Promise<Row> {
  const op = str(input, "operation_id");
  const prior = (await repo.list("virtual_bets")).find(
    (b) => b.operation_id === op,
  );
  const raceId = str(input, "race_id");
  const type = str(input, "ticket_type");
  const selection = ticket(type, input.selections);
  const amount = money(input.amount_yen);
  if (prior) {
    requireCondition(
      prior.race_id === raceId &&
        prior.prediction_id === input.prediction_id &&
        prior.ticket_type === type &&
        canonical(prior.selections_json) === canonical(selection) &&
        prior.amount_yen === amount &&
        prior.recommendation_id === (input.recommendation_id ?? null),
      "同operation_id・異内容です",
      409,
    );
    return prior;
  }
  const race = await get(repo, "races", raceId);
  requireCondition(
    race.status === "scheduled" &&
      instant(now) < instant(race.scheduled_start_at),
    "発走後・取消レースは購入できません",
  );
  const entries = (await repo.list("race_entries")).filter(
    (e) => e.race_id === raceId && e.status === "active",
  );
  ticket(
    type,
    selection,
    entries.map((e) => num(e, "horse_number")),
  );
  const prediction = await get(
    repo,
    "predictions",
    str(input, "prediction_id"),
  );
  requireCondition(
    prediction.status === "locked" && prediction.race_id === raceId,
    "発走前の確定予想を指定してください",
  );
  const adopted = (await repo.list("prediction_adoptions")).find(
    (a) => a.race_id === raceId,
  );
  requireCondition(
    adopted?.prediction_id === prediction.prediction_id,
    "採用版を固定してから購入してください",
  );
  if (input.recommendation_id != null) {
    const r = await get(
      repo,
      "recommendations",
      str(input, "recommendation_id"),
    );
    requireCondition(
      r.prediction_id === prediction.prediction_id &&
        r.ticket_type === type &&
        canonical(r.selections_json) === canonical(selection),
      "推奨買い目と一致しません",
    );
  }
  const date = jstDate(now);
  const bets = (await repo.list("virtual_bets")).filter(
    (b) => b.status === "confirmed",
  );
  requireCondition(
    bets
      .filter((b) => b.race_id === raceId)
      .reduce((s, b) => s + num(b, "amount_yen"), 0) +
      amount <=
      1000,
    "1レース1,000円の予算を超えます",
    409,
  );
  requireCondition(
    bets
      .filter((b) => b.budget_date_jst === date)
      .reduce((s, b) => s + num(b, "amount_yen"), 0) +
      amount <=
      5000,
    "JST1日5,000円の予算を超えます",
    409,
  );
  requireCondition(
    !bets.some(
      (b) =>
        b.race_id === raceId &&
        b.ticket_type === type &&
        canonical(b.selections_json) === canonical(selection),
    ),
    "同じ買い目は登録済みです。既存の仮想購入を変更してください",
    409,
  );
  const bet: Row = {
    schema_version: "0.2",
    created_at: now,
    bet_id: `bet:${op}`,
    race_id: raceId,
    prediction_id: prediction.prediction_id,
    recommendation_id: input.recommendation_id ?? null,
    ticket_type: type,
    selections_json: selection,
    amount_yen: amount,
    confirmed_at: now,
    budget_date_jst: date,
    status: "confirmed",
    operation_id: op,
  };
  await immutablePut(repo, "virtual_bets", bet);
  await audit(repo, op, "confirm-bet", "virtual_bets", now, null, bet);
  return bet;
}
// Validate the entire replacement in isolation before changing the caller's repository.
// The coordinator persists these changes through its existing durable journal.
export async function reviseBet(
  repo: Repository,
  id: string,
  input: Row,
  now: string,
): Promise<Row> {
  const op = str(input, "operation_id");
  const before = obj(input.expected_bet);
  requireCondition(before.bet_id === id, "変更元の購入IDが不一致です", 409);
  const prior = await repo.get("audit_events", `revise-bet:${op}`);
  const payload = {
    ...input,
    race_id: before.race_id,
    prediction_id: before.prediction_id,
    recommendation_id: null,
  };
  if (prior) {
    requireCondition(
      prior.entity_id === id && prior.before_hash === (await hash(before)),
      "変更操作IDが競合しています",
      409,
    );
    return confirmBet(repo, payload, now);
  }
  requireCondition(
    !(await repo.get("virtual_bets", `bet:${op}`)),
    "変更操作IDは使用済みです",
    409,
  );
  const current = await get(repo, "virtual_bets", id);
  requireCondition(
    canonical(current) === canonical(before) && current.status === "confirmed",
    "購入記録が更新されています。再読み込みしてください",
    409,
  );
  const staged = new StagedRepository(repo);
  await voidBet(staged, id, op, now);
  const after = await confirmBet(staged, payload, now);
  await audit(staged, op, "revise-bet", "virtual_bets", now, before, after, id);
  for (const change of staged.changes.values())
    await repo.put(change.table, change.after);
  return after;
}
export async function skipRace(
  repo: Repository,
  input: Row,
  now: string,
): Promise<Row> {
  const op = str(input, "operation_id");
  const prior = await repo.get("audit_events", `skip:${op}`);
  const after = {
    race_id: str(input, "race_id"),
    reason: str(input, "reason"),
  };
  if (prior) {
    requireCondition(
      prior.after_hash === (await hash(after)),
      "見送り操作IDの競合",
      409,
    );
    return prior;
  }
  const race = await get(repo, "races", str(input, "race_id"));
  requireCondition(
    instant(now) < instant(race.scheduled_start_at),
    "発走後の見送り変更は禁止です",
  );
  await audit(
    repo,
    op,
    "skip",
    "races",
    now,
    null,
    after,
    str(race, "race_id"),
    after,
  );
  return get(repo, "audit_events", `skip:${op}`);
}
export async function voidBet(
  repo: Repository,
  id: string,
  operationId: string,
  now: string,
): Promise<Row> {
  const bet = await get(repo, "virtual_bets", id);
  if (bet.status === "void") return bet;
  const race = await get(repo, "races", str(bet, "race_id"));
  requireCondition(
    race.status === "scheduled" &&
      instant(now) < instant(race.scheduled_start_at),
    "発走後・取消レースの任意取消は禁止です",
  );
  const changed = { ...bet, status: "void" };
  await repo.put("virtual_bets", changed);
  await audit(repo, operationId, "void-bet", "virtual_bets", now, bet, changed);
  return changed;
}
export async function saveResult(
  repo: Repository,
  input: Row,
  now: string,
): Promise<Row> {
  const result = obj(input.result);
  const payoutRows = rows(input.payouts);
  if (result.official_status === "official")
    requireCondition(
      input.payouts_complete === true,
      "公式払戻の全件確認が必要です",
    );
  requireCondition(
    ["provisional", "official", "cancelled"].includes(
      str(result, "official_status"),
    ),
    "結果状態が不正です",
  );
  const race = await get(repo, "races", str(result, "race_id"));
  requireCondition(
    instant(result.published_at) <= instant(now),
    "結果公表日時が未来です",
  );
  if (result.official_status !== "cancelled")
    requireCondition(
      instant(result.published_at) >= instant(race.scheduled_start_at),
      "発走前の結果です",
    );
  requireCondition(
    Number.isInteger(num(result, "revision")) && num(result, "revision") >= 1,
    "結果版は正の整数です",
  );
  const existing = await repo.get("race_results", str(result, "result_id"));
  const versions = (await repo.list("race_results"))
    .filter((r) => r.race_id === race.race_id)
    .sort((a, b) => num(b, "revision") - num(a, "revision"));
  const latest = versions[0];
  if (!existing) {
    requireCondition(
      num(result, "revision") === (latest ? num(latest, "revision") + 1 : 1),
      "結果版を連番で追加してください",
    );
    requireCondition(
      (result.supersedes_result_id ?? null) === (latest?.result_id ?? null),
      "訂正元の結果IDが不正です",
    );
  }
  const entries = (await repo.list("race_entries")).filter(
    (e) => e.race_id === race.race_id,
  );
  const numbers = entries.map((e) => num(e, "horse_number"));
  const order = arr(result, "finish_order_json");
  requireCondition(
    order.every(
      (g) =>
        Array.isArray(g) &&
        g.length > 0 &&
        g.every((n) => typeof n === "number" && numbers.includes(n)),
    ) && new Set(order.flat()).size === order.flat().length,
    "同着を含む着順配列が不正です",
  );
  const statuses = obj(result.entry_status_json);
  requireCondition(
    Object.entries(statuses).every(
      ([n, s]) =>
        numbers.includes(Number(n)) &&
        ["finished", "scratched", "cancelled", "dnf", "disqualified"].includes(
          String(s),
        ),
    ),
    "出走結果状態が不正です",
  );
  requireCondition(
    numbers.every((n) => statuses[String(n)] != null),
    "全出走馬の結果状態が必要です",
  );
  const finished = Object.entries(statuses)
    .filter(([, s]) => s === "finished")
    .map(([n]) => Number(n));
  requireCondition(
    canonical(finished.sort((a, b) => a - b)) ===
      canonical((order.flat() as number[]).sort((a, b) => a - b)),
    "完走馬と着順が一致しません",
  );
  requireCondition(
    result.source_url != null &&
      new URL(str(result, "source_url")).protocol === "https:",
    "公式結果のHTTPS出典が必要です",
  );
  const base = {
    schema_version: "0.2",
    created_at: existing?.created_at ?? now,
  };
  const record = {
    ...result,
    ...base,
    supersedes_result_id: result.supersedes_result_id ?? null,
  };
  const payoutKeys = new Set<string>();
  const normalized: Row[] = payoutRows.map((p) => {
    requireCondition(
      Number.isSafeInteger(num(p, "payout_per_100_yen")) &&
        num(p, "payout_per_100_yen") >= 0,
      "払戻は非負整数です",
    );
    if (p.refund_rule_json != null) {
      const rule = obj(p.refund_rule_json);
      requireCondition(
        rule.kind === "refund" &&
          ["selection", "ticket_type"].includes(str(rule, "scope")) &&
          Number.isInteger(num(rule, "refund_per_100_yen")) &&
          num(rule, "refund_per_100_yen") >= 0 &&
          num(rule, "refund_per_100_yen") <= 100,
        "公式返還規則が不正です",
      );
      requireCondition(
        num(p, "payout_per_100_yen") === 0,
        "払戻と返還を同じ行へ混在できません",
      );
    }
    const ns = ticket(str(p, "ticket_type"), p.selections_json, numbers);
    const key = canonical([p.ticket_type, ns]);
    requireCondition(!payoutKeys.has(key), "払戻買い目が重複しています");
    payoutKeys.add(key);
    return {
      ...p,
      schema_version: "0.2",
      created_at: existing?.created_at ?? now,
      result_id: result.result_id,
      selections_json: ns,
    };
  });
  if (existing) {
    requireCondition(
      canonical(existing) === canonical(record),
      "同結果ID・異内容です",
      409,
    );
    const stored = (await repo.list("payouts")).filter(
      (p) => p.result_id === result.result_id,
    );
    requireCondition(
      canonical(
        stored.sort((a, b) =>
          str(a, "payout_id").localeCompare(str(b, "payout_id")),
        ),
      ) ===
        canonical(
          normalized.sort((a, b) =>
            str(a, "payout_id").localeCompare(str(b, "payout_id")),
          ),
        ),
      "同結果IDの払戻が異なります",
      409,
    );
    return existing;
  }
  await immutablePut(repo, "race_results", record);
  for (const p of normalized) await immutablePut(repo, "payouts", p);
  return record;
}
export async function settle(
  repo: Repository,
  resultId: string,
  now: string,
): Promise<Row[]> {
  const result = await get(repo, "race_results", resultId);
  requireCondition(
    ["official", "cancelled"].includes(str(result, "official_status")),
    "未確定結果は精算できません",
  );
  const versions = (await repo.list("race_results"))
    .filter((r) => r.race_id === result.race_id)
    .sort((a, b) => num(b, "revision") - num(a, "revision"));
  requireCondition(
    versions[0].result_id === resultId,
    "最新の公式結果で精算してください",
  );
  const payouts = (await repo.list("payouts")).filter(
    (p) => p.result_id === resultId,
  );
  const bets = (await repo.list("virtual_bets")).filter(
    (b) => b.race_id === result.race_id && b.status === "confirmed",
  );
  const settlements = await repo.list("settlements");
  const output: Row[] = [];
  for (const bet of bets) {
    const id = `settle:${bet.bet_id}:${resultId}`;
    const exists = await repo.get("settlements", id);
    if (exists) {
      output.push(exists);
      continue;
    }
    const amount = num(bet, "amount_yen");
    const { refund, payout } = financialOutcome(bet, result, payouts);
    const previous = settlements
      .filter((s) => s.bet_id === bet.bet_id)
      .sort((a, b) => num(b, "revision") - num(a, "revision"))[0];
    const row: Row = {
      schema_version: "0.2",
      created_at: now,
      settlement_id: id,
      bet_id: bet.bet_id,
      result_id: resultId,
      revision: previous ? num(previous, "revision") + 1 : 1,
      stake_yen: amount,
      payout_yen: payout,
      refund_yen: refund,
      net_yen: payout + refund - amount,
      status: previous ? "revised" : "settled",
      settled_at: now,
      supersedes_settlement_id: previous?.settlement_id ?? null,
      evidence_json: {
        delta_yen:
          payout +
          refund -
          (previous
            ? num(previous, "payout_yen") + num(previous, "refund_yen")
            : 0),
      },
    };
    await immutablePut(repo, "settlements", row);
    await audit(repo, id, "settle", "settlements", now, previous ?? null, row);
    output.push(row);
  }
  return output;
}
export async function purchaseStats(repo: Repository): Promise<Row> {
  const bets = (await repo.list("virtual_bets")).filter(
    (b) => b.status === "confirmed",
  );
  const all = await repo.list("settlements");
  const results = await repo.list("race_results");
  const latest = (bet: Row) =>
    all
      .filter((s) => s.bet_id === bet.bet_id)
      .sort((a, b) => num(b, "revision") - num(a, "revision"))[0];
  const ready = bets.flatMap((b) => {
    const s = latest(b);
    const r = results
      .filter((r) => r.race_id === b.race_id)
      .sort((a, b) => num(b, "revision") - num(a, "revision"))[0];
    return s && s.result_id === r?.result_id ? [s] : [];
  });
  const sum = (key: string) => ready.reduce((s, r) => s + num(r, key), 0);
  const stake = sum("stake_yen");
  const payout = sum("payout_yen");
  const refund = sum("refund_yen");
  const denominator = ready.filter((s) => num(s, "refund_yen") === 0);
  const hits = denominator.filter((s) => num(s, "payout_yen") > 0).length;
  return {
    purchased_tickets: bets.length,
    settled_tickets: ready.length,
    pending_tickets: bets.length - ready.length,
    stake_yen: stake,
    payout_yen: payout,
    refund_yen: refund,
    net_yen: payout + refund - stake,
    return_rate: stake ? (payout + refund) / stake : null,
    hit_rate: denominator.length ? hits / denominator.length : null,
    hit_denominator: denominator.length,
    rule: "最新公式結果で精算済みの本人購入のみ。回収率は返還を含む。返還券は的中率の分母・的中から除外。未精算購入額は収支に含めない。",
  };
}

export function financialOutcome(
  bet: Row,
  result: Row,
  payouts: Row[],
): { refund: number; payout: number } {
  const amount = num(bet, "amount_yen"),
    selection = arr(bet, "selections_json"),
    status = obj(result.entry_status_json);
  let refund =
    result.official_status === "cancelled" ||
    selection.some((n) =>
      ["scratched", "cancelled"].includes(String(status[String(n)])),
    )
      ? amount
      : 0;
  const matching = payouts.filter(
    (p) =>
      p.ticket_type === bet.ticket_type &&
      canonical(p.selections_json) === canonical(selection),
  );
  if (!refund) {
    const rules = payouts
      .filter(
        (p) => p.ticket_type === bet.ticket_type && p.refund_rule_json != null,
      )
      .filter(
        (p) =>
          obj(p.refund_rule_json).scope === "ticket_type" ||
          canonical(p.selections_json) === canonical(selection),
      );
    requireCondition(rules.length <= 1, "返還規則が競合しています");
    if (rules.length)
      refund =
        (num(obj(rules[0].refund_rule_json), "refund_per_100_yen") * amount) /
        100;
  }
  const payout = refund
    ? 0
    : matching
        .filter((p) => p.refund_rule_json == null)
        .reduce((n, p) => n + (num(p, "payout_per_100_yen") * amount) / 100, 0);
  requireCondition(
    Number.isSafeInteger(refund) && Number.isSafeInteger(payout),
    "精算金額が整数範囲を超えました",
  );
  return { refund, payout };
}
export async function recommendationStats(
  repo: Repository,
  adoptedOnly = false,
): Promise<Row> {
  const referenceAdoptions = adoptedOnly
    ? await repo.list("reference_adoptions")
    : [];
  const predictions = (await repo.list("predictions")).filter(
    (p) =>
      p.status === "locked" &&
      p.kind !== "backtest" &&
      (!adoptedOnly ||
        referenceAdoptions.some((a) => a.prediction_id === p.prediction_id)),
  );
  const results = await repo.list("race_results"),
    payouts = await repo.list("payouts");
  const recommendations = await repo.list("recommendations");
  let stake = 0,
    payout = 0,
    refund = 0,
    pending = 0,
    count = 0;
  for (const rec of recommendations) {
    const p = predictions.find((p) => p.prediction_id === rec.prediction_id);
    if (!p || num(rec, "suggested_amount_yen") === 0) continue;
    const result = results
      .filter((r) => r.race_id === p.race_id)
      .sort((a, b) => num(b, "revision") - num(a, "revision"))[0];
    if (
      !result ||
      !["official", "cancelled"].includes(str(result, "official_status"))
    ) {
      pending++;
      continue;
    }
    const outcome = financialOutcome(
      {
        amount_yen: rec.suggested_amount_yen,
        ticket_type: rec.ticket_type,
        selections_json: rec.selections_json,
      },
      result,
      payouts.filter((r) => r.result_id === result.result_id),
    );
    stake += num(rec, "suggested_amount_yen");
    payout += outcome.payout;
    refund += outcome.refund;
    count++;
  }
  return {
    reference_tickets: count,
    pending_tickets: pending,
    stake_yen: stake,
    payout_yen: payout,
    refund_yen: refund,
    net_yen: payout + refund - stake,
    return_rate: stake ? (payout + refund) / stake : null,
    rule: adoptedOnly
      ? "Coreで確定・採用したMorning/Finalの1R1プランだけの参考収支。0円・未確定結果は除外。本人購入台帳とは独立。"
      : "全確定予想の推奨をsuggested_amount_yenで仮定購入した参考値。0円推奨・未確定結果は除外。Morning/Final等の各版を別件として含む。本人購入・当日の採用版だけの収支ではない。",
  };
}
