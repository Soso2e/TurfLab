import {
  columns,
  DomainError,
  idOf,
  requireCondition,
  tables,
  validateRow,
  type Row,
  type Table,
  type Json,
} from "../../../packages/shared/src/domain";
import type { Repository } from "../../../packages/shared/src/repository";
export interface GoogleCredentials {
  SHEETS_ID: string;
  GOOGLE_CLIENT_EMAIL: string;
  GOOGLE_PRIVATE_KEY: string;
}
const b64 = (value: Uint8Array) =>
  btoa(String.fromCharCode(...value))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
export class GoogleSheetsClient {
  private token?: { value: string; expires: number };
  constructor(
    private credentials: GoogleCredentials,
    private fetcher: typeof fetch = fetch,
  ) {}
  async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60000)
      return this.token.value;
    const c = this.credentials;
    requireCondition(
      c.GOOGLE_PRIVATE_KEY && c.GOOGLE_CLIENT_EMAIL,
      "Sheets接続設定がありません",
      503,
    );
    const pem = c.GOOGLE_PRIVATE_KEY.replace(/\\n/g, "\n")
      .replace(/-----[^-]+-----/g, "")
      .replace(/\s/g, "");
    const key = await crypto.subtle.importKey(
      "pkcs8",
      Uint8Array.from(atob(pem), (x) => x.charCodeAt(0)),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const encode = (v: unknown) =>
      b64(new TextEncoder().encode(JSON.stringify(v)));
    const now = Math.floor(Date.now() / 1000);
    const unsigned =
      encode({ alg: "RS256", typ: "JWT" }) +
      "." +
      encode({
        iss: c.GOOGLE_CLIENT_EMAIL,
        scope: "https://www.googleapis.com/auth/spreadsheets",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      });
    const assertion =
      unsigned +
      "." +
      b64(
        new Uint8Array(
          await crypto.subtle.sign(
            "RSASSA-PKCS1-v1_5",
            key,
            new TextEncoder().encode(unsigned),
          ),
        ),
      );
    const response = await this.fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
    });
    if (!response.ok)
      throw new DomainError(
        `Google認証に失敗しました (${response.status})`,
        response.status,
      );
    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.token = {
      value: data.access_token,
      expires: Date.now() + data.expires_in * 1000,
    };
    return data.access_token;
  }
  async request(
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetcher(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(this.credentials.SHEETS_ID)}${path}`,
      {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${await this.accessToken()}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      throw new DomainError(
        `Sheets ${body ? "write" : "read"} (${response.status}): ${data.error?.message ?? "接続失敗"}`,
        response.status,
      );
    }
    return response.json() as Promise<Record<string, unknown>>;
  }
  async batchRead(
    ranges: string[],
  ): Promise<{ range: string; values: Json[][] }[]> {
    const data = await this.request(
      "/values:batchGet?" +
        ranges.map((r) => "ranges=" + encodeURIComponent(r)).join("&") +
        "&valueRenderOption=UNFORMATTED_VALUE",
    );
    return (data.valueRanges ?? []) as { range: string; values: Json[][] }[];
  }
  async batchWrite(data: { range: string; values: Json[][] }[]): Promise<void> {
    await this.request("/values:batchUpdate", {
      valueInputOption: "RAW",
      data,
    });
  }
}
export const sheetName = (t: Table) => `TL_${t}`;
export class SheetsRepository implements Repository {
  private cache = new Map<
    Table,
    { headers: string[]; rows: Row[]; physical: number[] }
  >();
  constructor(public client: GoogleSheetsClient) {}
  refresh() {
    this.cache.clear();
  }
  private async read(
    table: Table,
  ): Promise<{ headers: string[]; rows: Row[]; physical: number[] }> {
    const cached = this.cache.get(table);
    if (cached) return cached;
    const headers =
      (
        await this.client.batchRead([`'${sheetName(table)}'!A1:AZ1`])
      )[0]?.values?.[0]?.map(String) ?? [];
    requireCondition(
      columns(table).every((c) => headers.includes(c)) &&
        new Set(headers).size === headers.length,
      `${sheetName(table)}: 列が不足または重複しています`,
      503,
    );
    const result: Row[] = [];
    const physical: number[] = [];
    for (let start = 2; ; start += 500) {
      const values =
        (
          await this.client.batchRead([
            `'${sheetName(table)}'!A${start}:AZ${start + 499}`,
          ])
        )[0]?.values ?? [];
      for (let i = 0; i < values.length; i++) {
        const cells = values[i];
        if (!cells[headers.indexOf(columns(table)[0])]) continue;
        const row: Row = {};
        headers.forEach((key, j) => {
          if (!columns(table).includes(key)) return;
          const value = cells[j] === "" ? null : (cells[j] ?? null);
          row[key] =
            key.endsWith("_json") && typeof value === "string" && value !== ""
              ? JSON.parse(value)
              : value;
        });
        validateRow(table, row);
        result.push(row);
        physical.push(start + i);
      }
      if (values.length < 500) break;
      requireCondition(start < 100000, "Sheetsの読み取り上限を超えました", 503);
    }
    requireCondition(
      new Set(result.map((r) => idOf(table, r))).size === result.length,
      "SheetsにID重複があります",
      409,
    );
    const data = { headers, rows: result, physical };
    this.cache.set(table, data);
    return data;
  }
  async list(table: Table) {
    return (await this.read(table)).rows;
  }
  async get(table: Table, id: string) {
    return (await this.list(table)).find((r) => idOf(table, r) === id);
  }
  async put(table: Table, row: Row) {
    await this.putBatch(table, [row]);
  }
  async putBatch(table: Table, records: Row[]) {
    if (!records.length) return;
    records.forEach((row) => validateRow(table, row));
    this.refresh();
    const data = await this.read(table);
    let next = Math.max(1, ...data.physical) + 1;
    const writes = records.flatMap((row) => {
      const index = data.rows.findIndex(
        (r) => idOf(table, r) === idOf(table, row),
      );
      const rowNumber = index < 0 ? next++ : data.physical[index];
      return data.headers.flatMap((key, i) => {
        if (!columns(table).includes(key)) return [];
        const value = row[key] ?? null;
        return [
          {
            range: `'${sheetName(table)}'!${columnLetter(i + 1)}${rowNumber}`,
            values: [
              [
                value === null
                  ? ""
                  : key.endsWith("_json")
                    ? JSON.stringify(value)
                    : value,
              ],
            ],
          },
        ];
      });
    });
    await this.client.batchWrite(writes);
    this.refresh();
  }
  async inspect(): Promise<Record<string, unknown>> {
    return this.client.request(
      "?fields=spreadsheetId,properties(timeZone),sheets(properties)",
    );
  }
  async provision(): Promise<void> {
    const metadata = await this.inspect();
    const sheets = metadata.sheets as { properties: { title: string } }[];
    const missing = tables.filter(
      (t) => !sheets.some((s) => s.properties.title === sheetName(t)),
    );
    if (missing.length)
      await this.client.request(":batchUpdate", {
        requests: missing.map((t) => ({
          addSheet: {
            properties: {
              title: sheetName(t),
              gridProperties: {
                rowCount: 1000,
                columnCount: 52,
                frozenRowCount: 1,
              },
            },
          },
        })),
      });
    for (const t of tables) {
      const header =
        (await this.client.batchRead([`'${sheetName(t)}'!A1:AZ1`]))[0]
          ?.values?.[0] ?? [];
      if (!header.length)
        await this.client.batchWrite([
          { range: `'${sheetName(t)}'!A1`, values: [columns(t)] },
        ]);
      else
        requireCondition(
          columns(t).every((c) => header.includes(c)),
          `${sheetName(t)}: 既存列を移行してから接続してください`,
          409,
        );
    }
  }
  async legacy(): Promise<Record<string, unknown>> {
    const metadata = await this.inspect();
    const names = (metadata.sheets as { properties: { title: string } }[]).map(
      (s) => s.properties.title,
    );
    const target = [
      "Race",
      "Prediction",
      "Bet",
      "Results",
      "DailySummary",
      "HorseStats",
      "JockeyStats",
      "ModelStats",
      "Meta",
    ].filter((n) => names.includes(n));
    const read = await this.client.batchRead(
      target.map((n) => `'${n}'!A1:AD501`),
    );
    return {
      tables: read.map((r, i) => ({
        name: target[i],
        headers: r.values?.[0] ?? [],
        rows: (r.values ?? []).slice(1),
        truncated: (r.values?.length ?? 0) >= 501,
      })),
      policy:
        "legacy-read-only; 概算スコアを確率へ変換しない。Betを本人購入として自動移行しない。",
    };
  }
}
export function columnLetter(n: number): string {
  let s = "";
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}
