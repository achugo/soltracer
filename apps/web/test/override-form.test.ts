import { MAX_OVERRIDE_DATA_BYTES, MAX_OVERRIDES, simulateRequestSchema } from "@soltracer/shared/simulation";
import { describe, expect, it } from "vitest";
import {
  buildOverrides,
  dataSize,
  emptyRow,
  initialRowsState,
  rowsReducer,
  rowToOverride,
  visibleErrors,
  type OverrideRow,
} from "../lib/override-form.ts";
import { OTHER, PAYER, TOKEN_PROGRAM, USDC } from "./fixtures-simulation.ts";

const row = (patch: Partial<OverrideRow>, id = 1): OverrideRow => ({ ...emptyRow(id), ...patch });

describe("rowToOverride", () => {
  it("builds a SOL override in lamports", () => {
    expect(rowToOverride(row({ kind: "sol", address: ` ${PAYER} `, amount: "2.5" }))).toEqual({
      ok: true,
      override: { kind: "sol", address: PAYER, lamports: "2500000000" },
    });
  });

  it("builds a token override from whole tokens with decimals", () => {
    expect(rowToOverride(row({ kind: "token", owner: PAYER, mint: USDC, amount: "1000.25", decimals: "6" }))).toEqual({
      ok: true,
      override: { kind: "token", owner: PAYER, mint: USDC, amount: "1000250000" },
    });
  });

  it("builds a token override from raw units, ignoring decimals", () => {
    expect(
      rowToOverride(row({ kind: "token", owner: PAYER, mint: USDC, amount: "18446744073709551615", decimals: "x", rawUnits: true })),
    ).toEqual({ ok: true, override: { kind: "token", owner: PAYER, mint: USDC, amount: "18446744073709551615" } });
    expect(rowToOverride(row({ kind: "token", owner: PAYER, mint: USDC, amount: "1.5", rawUnits: true }))).toEqual({
      ok: false,
      errors: { amount: "Must be a whole number" },
    });
  });

  it("builds a data override, stripping whitespace and omitting an empty owner", () => {
    expect(rowToOverride(row({ kind: "data", address: PAYER, dataBase64: "AQID\nBA==" }))).toEqual({
      ok: true,
      override: { kind: "data", address: PAYER, dataBase64: "AQIDBA==" },
    });
    expect(rowToOverride(row({ kind: "data", address: PAYER, dataBase64: "", owner: TOKEN_PROGRAM }))).toEqual({
      ok: true,
      override: { kind: "data", address: PAYER, dataBase64: "", owner: TOKEN_PROGRAM },
    });
  });

  it("reports each invalid field with the shared schema's messages", () => {
    const sol = rowToOverride(row({ kind: "sol", address: "not-a-key", amount: "-1" }));
    expect(sol).toEqual({
      ok: false,
      errors: { address: "Must be a base58 public key (32 bytes)", amount: "Amount can't be negative" },
    });

    const token = rowToOverride(row({ kind: "token", owner: PAYER, mint: "", amount: "1", decimals: "300" }));
    expect(token.ok).toBe(false);
    if (!token.ok) {
      expect(token.errors.decimals).toMatch(/0 to 255/);
      expect(token.errors.mint).toBe("Must be a base58 public key (32 bytes)");
      expect(token.errors.amount).toBeUndefined();
    }

    const data = rowToOverride(row({ kind: "data", address: PAYER, dataBase64: "AQI", owner: "bad" }));
    expect(data).toEqual({
      ok: false,
      errors: { dataBase64: "Must be base64", owner: "Must be a base58 public key (32 bytes)" },
    });
  });

  it("validates only the fields the kind uses", () => {
    expect(rowToOverride(row({ kind: "sol", address: PAYER, amount: "1", mint: "junk", dataBase64: "!!" })).ok).toBe(true);
  });
});

describe("buildOverrides", () => {
  it("returns overrides in row order that the request schema accepts", () => {
    const rows = [
      row({ kind: "sol", address: PAYER, amount: "1" }, 1),
      row({ kind: "token", owner: OTHER, mint: USDC, amount: "5" }, 2),
    ];
    const built = buildOverrides(rows);
    expect(built).toEqual({
      ok: true,
      overrides: [
        { kind: "sol", address: PAYER, lamports: "1000000000" },
        { kind: "token", owner: OTHER, mint: USDC, amount: "5000000" },
      ],
    });
    if (built.ok) expect(simulateRequestSchema.safeParse({ tx: "AQID", overrides: built.overrides }).success).toBe(true);
  });

  it("returns an empty list for no rows", () => {
    expect(buildOverrides([])).toEqual({ ok: true, overrides: [] });
  });

  it("keys errors by row id", () => {
    const built = buildOverrides([row({ kind: "sol", address: PAYER, amount: "1" }, 1), row({ kind: "sol", address: PAYER }, 7)]);
    expect(built).toEqual({ ok: false, rowErrors: { 7: { amount: "Enter an amount" } }, listError: null });
  });

  it("refuses more than MAX_OVERRIDES rows", () => {
    const rows = Array.from({ length: MAX_OVERRIDES + 1 }, (_, i) => row({ kind: "sol", address: PAYER, amount: "1" }, i));
    expect(buildOverrides(rows)).toMatchObject({ ok: false, listError: `At most ${MAX_OVERRIDES} overrides` });
  });

  it("refuses data over 1 MiB in total", () => {
    const half = "A".repeat(Math.ceil(MAX_OVERRIDE_DATA_BYTES / 2 / 3) * 4);
    const rows = [row({ kind: "data", address: PAYER, dataBase64: half }, 1), row({ kind: "data", address: OTHER, dataBase64: half }, 2)];
    expect(buildOverrides(rows)).toMatchObject({ ok: false, listError: "Data overrides are limited to 1 MiB in total" });
  });
});

describe("dataSize", () => {
  it("counts decoded bytes of data rows only", () => {
    const rows = [
      row({ kind: "data", dataBase64: "AQID" }, 1), // 3 bytes
      row({ kind: "data", dataBase64: "AQIDBA==" }, 2), // 4 bytes
      row({ kind: "data", dataBase64: "AQIDBAU=" }, 3), // 5 bytes
      row({ kind: "sol", dataBase64: "AAAAAAAA" }, 4), // ignored: not a data row
    ];
    expect(dataSize(rows)).toEqual({ bytes: 12, limit: MAX_OVERRIDE_DATA_BYTES, level: "ok" });
  });

  it("warns from 90% and is over past 1 MiB", () => {
    const b64ForBytes = (n: number) => "A".repeat((n / 3) * 4);
    expect(dataSize([row({ kind: "data", dataBase64: b64ForBytes(3 * 300_000) })]).level).toBe("ok");
    expect(dataSize([row({ kind: "data", dataBase64: b64ForBytes(3 * 320_000) })]).level).toBe("warn");
    expect(dataSize([row({ kind: "data", dataBase64: b64ForBytes(3 * 349_525) })]).level).toBe("warn");
    expect(dataSize([row({ kind: "data", dataBase64: b64ForBytes(3 * 349_526) })]).level).toBe("over");
  });

  it("is zero for no rows", () => {
    expect(dataSize([])).toEqual({ bytes: 0, limit: MAX_OVERRIDE_DATA_BYTES, level: "ok" });
  });
});

describe("rowsReducer", () => {
  it("adds rows with fresh ids and removes by id", () => {
    let s = rowsReducer(initialRowsState, { type: "add" });
    s = rowsReducer(s, { type: "add" });
    expect(s.rows.map((r) => r.id)).toEqual([1, 2]);
    s = rowsReducer(s, { type: "remove", id: 1 });
    s = rowsReducer(s, { type: "add" });
    expect(s.rows.map((r) => r.id)).toEqual([2, 3]);
  });

  it("defaults new rows to SOL with 6 token decimals", () => {
    const s = rowsReducer(initialRowsState, { type: "add" });
    expect(s.rows[0]).toMatchObject({ kind: "sol", decimals: "6", rawUnits: false });
  });

  it("updates one row and keeps other fields when the kind changes", () => {
    let s = rowsReducer(initialRowsState, { type: "add" });
    s = rowsReducer(s, { type: "update", id: 1, patch: { address: PAYER } });
    s = rowsReducer(s, { type: "update", id: 1, patch: { kind: "data" } });
    expect(s.rows[0]).toMatchObject({ kind: "data", address: PAYER });
  });

  it("stops adding at MAX_OVERRIDES", () => {
    let s = initialRowsState;
    for (let i = 0; i < MAX_OVERRIDES + 5; i++) s = rowsReducer(s, { type: "add" });
    expect(s.rows).toHaveLength(MAX_OVERRIDES);
  });
});

describe("visibleErrors", () => {
  const rows = [row({ kind: "sol", address: "bad", amount: "" }, 1), row({ kind: "sol" }, 2)];
  const built = buildOverrides(rows);
  const errors = built.ok ? {} : built.rowErrors;

  it("shows only errors on typed fields before a submit", () => {
    expect(visibleErrors(rows, errors, false)).toEqual({ 1: { address: "Must be a base58 public key (32 bytes)" } });
  });

  it("shows every error after a submit", () => {
    expect(visibleErrors(rows, errors, true)).toEqual({
      1: { address: "Must be a base58 public key (32 bytes)", amount: "Enter an amount" },
      2: { address: "Must be a base58 public key (32 bytes)", amount: "Enter an amount" },
    });
  });
});
