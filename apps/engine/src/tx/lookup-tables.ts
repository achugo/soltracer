import type { AccountRef } from "@soltracer/shared/simulation";
import { getAddressDecoder, type Address } from "@solana/kit";
import type { DecodedTransaction } from "./decode.ts";

/** Address lookup table accounts: 56-byte metadata header, then 32-byte addresses. */
export const LOOKUP_TABLE_META_SIZE = 56;

export class LookupTableError extends Error {
  override name = "LookupTableError";
}

const addressDecoder = getAddressDecoder();

export function parseLookupTable(data: Uint8Array): Address[] {
  if (data.length < LOOKUP_TABLE_META_SIZE || (data.length - LOOKUP_TABLE_META_SIZE) % 32 !== 0) {
    throw new LookupTableError(`Not a lookup table account (${data.length} bytes)`);
  }
  const addresses: Address[] = [];
  for (let offset = LOOKUP_TABLE_META_SIZE; offset < data.length; offset += 32) {
    addresses.push(addressDecoder.decode(data.subarray(offset, offset + 32)));
  }
  return addresses;
}

/**
 * The full account list in runtime order: static keys, then every table's writable entries,
 * then every table's readonly entries. Writable means requested writable by the message.
 */
export function resolveAccounts(tx: DecodedTransaction, tables: ReadonlyMap<Address, readonly Address[]>): AccountRef[] {
  const { numSignerAccounts: s, numReadonlySignerAccounts: rs, numReadonlyNonSignerAccounts: rn } = tx.header;
  const n = tx.staticAccounts.length;
  const accounts: AccountRef[] = tx.staticAccounts.map((address, i) => ({
    address,
    signer: i < s,
    writable: i < s ? i < s - rs : i < n - rn,
    source: { kind: "static" },
  }));

  const fromTables = (writable: boolean) => {
    for (const lookup of tx.lookups) {
      const entries = tables.get(lookup.table);
      if (!entries) throw new LookupTableError(`Lookup table ${lookup.table} was not loaded`);
      for (const index of writable ? lookup.writableIndexes : lookup.readonlyIndexes) {
        const address = entries[index];
        if (address === undefined) {
          throw new LookupTableError(
            `Lookup index ${index} is out of range: table ${lookup.table} has ${entries.length} entries`,
          );
        }
        accounts.push({ address, signer: false, writable, source: { kind: "lookup", table: lookup.table, index } });
      }
    }
  };
  fromTables(true);
  fromTables(false);
  return accounts;
}
