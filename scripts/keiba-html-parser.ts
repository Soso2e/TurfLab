export interface ParsedOfficialResult {
  finish_order_json: number[][];
  entry_status_json: Record<string, string>;
  payouts: Array<{
    ticket_type: string;
    selections_json: number[];
    payout_per_100_yen: number;
    refund_rule_json: null;
  }>;
  pace_observation: {
    laps_s: number[];
    corners: string[];
  };
}

const TICKET_TYPE_MAP: Record<string, string> = {
  単勝: "win",
  複勝: "place",
  枠複: "bracket_quinella",
  枠連: "bracket_quinella",
  枠連複: "bracket_quinella",
  枠単: "bracket_exacta",
  枠連単: "bracket_exacta",
  馬複: "quinella",
  馬連: "quinella",
  普通馬複: "quinella",
  馬連複: "quinella",
  馬連単: "exacta",
  三連複: "trio",
  三連単: "trifecta",
  ワイド: "wide",
  拡大馬複: "wide",
  "3連複": "trio",
  "３連複": "trio",
  "3連単": "trifecta",
  "３連単": "trifecta",
};

export function parseKeibaMarkTable(
  html: string,
  registeredNumbers?: number[],
): ParsedOfficialResult {
  const entry_status_json: Record<string, string> = {};
  const finishMap = new Map<number, number[]>(); // finish position -> horse numbers

  // Parse finish orders
  const rowRegex = /<tr class="tBorder">([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const posMatch = /<td class="a">([\s\S]*?)<\/td>/i.exec(rowHtml);
    const numMatch = /<td class="c">([\s\S]*?)<\/td>/i.exec(rowHtml);
    if (!posMatch || !numMatch) continue;

    const posStr = posMatch[1].replace(/<[^>]+>/g, "").trim();
    const horseNum = parseInt(numMatch[1].replace(/<[^>]+>/g, "").trim(), 10);
    if (!Number.isFinite(horseNum)) continue;

    const posNum = parseInt(posStr, 10);
    if (Number.isFinite(posNum) && posNum > 0) {
      entry_status_json[String(horseNum)] = "finished";
      const group = finishMap.get(posNum) ?? [];
      group.push(horseNum);
      finishMap.set(posNum, group);
    } else if (posStr.includes("取消")) {
      entry_status_json[String(horseNum)] = "scratched";
    } else if (posStr.includes("除外")) {
      entry_status_json[String(horseNum)] = "scratched";
    } else if (posStr.includes("中止")) {
      entry_status_json[String(horseNum)] = "dnf";
    } else if (posStr.includes("失格")) {
      entry_status_json[String(horseNum)] = "disqualified";
    }
  }

  // Ensure all registered numbers have a status
  if (registeredNumbers) {
    for (const n of registeredNumbers) {
      if (!entry_status_json[String(n)]) {
        entry_status_json[String(n)] = "finished";
      }
    }
  }

  // Build sorted finish_order_json
  const sortedPositions = Array.from(finishMap.keys()).sort((a, b) => a - b);
  const finish_order_json: number[][] = sortedPositions.map(
    (pos) => finishMap.get(pos)!,
  );

  // Parse payouts across all tables
  const payouts: ParsedOfficialResult["payouts"] = [];
  const payoutKeys = new Set<string>();

  const trRegex = /<tr>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  let currentTicket = "";

  while ((trMatch = trRegex.exec(html)) !== null) {
    const tr = trMatch[1];
    const titleMatch = /<td class="title"[^>]*>([\s\S]*?)<\/td>/i.exec(tr);
    if (titleMatch) {
      currentTicket = titleMatch[1].replace(/<[^>]+>/g, "").trim();
    }
    const ticketType = TICKET_TYPE_MAP[currentTicket];
    if (!ticketType) continue;

    const numCol = /<td class="[abd]"[^>]*>([\s\S]*?)<\/td>/i.exec(tr);
    const moneyCol = /<td class="refundMoney"[^>]*>([\s\S]*?)<\/td>/i.exec(tr);
    if (!numCol || !moneyCol) continue;

    const numRaw = numCol[1].replace(/<[^>]+>/g, "").trim();
    const moneyRaw = moneyCol[1]
      .replace(/<[^>]+>/g, "")
      .replace(/[^0-9]/g, "")
      .trim();
    const money = parseInt(moneyRaw, 10);
    if (!Number.isFinite(money) || money <= 0) continue;

    // Parse selections: "7", "1 - 13", "1 - 7 - 13", "13 → 1"
    const selections = numRaw
      .split(/[-–—→\s]+/)
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 0);

    if (selections.length > 0) {
      if (
        ["quinella", "bracket_quinella", "wide", "trio"].includes(ticketType)
      ) {
        selections.sort((a, b) => a - b);
      }
      const key = `${ticketType}:${selections.join("-")}`;
      if (!payoutKeys.has(key)) {
        payoutKeys.add(key);
        payouts.push({
          ticket_type: ticketType,
          selections_json: selections,
          payout_per_100_yen: money,
          refund_rule_json: null,
        });
      }
    }
  }

  // Parse pace / corners
  const corners: string[] = [];
  const laps_s: number[] = [];

  const cornerTable = /<table class="cornerTable">([\s\S]*?)<\/table>/i.exec(
    html,
  );
  if (cornerTable) {
    const tdMatches = cornerTable[1].matchAll(
      /<tr>\s*<th>([^<]+)<\/th>\s*<td>([^<]+)<\/td>/gi,
    );
    for (const m of tdMatches) {
      corners.push(`${m[1].trim()} ${m[2].trim()}`);
    }
  }

  return {
    finish_order_json,
    entry_status_json,
    payouts,
    pace_observation: {
      laps_s,
      corners,
    },
  };
}
