import { createAddressWithSeed, getProgramDerivedAddress, type Address } from "@solana/kit";

/**
 * Anchor stores a program's IDL at createWithSeed(base, "anchor:idl", program),
 * where base is the program's PDA with no seeds.
 */
export async function anchorIdlAddress(program: Address): Promise<Address> {
  const [base] = await getProgramDerivedAddress({ programAddress: program, seeds: [] });
  return createAddressWithSeed({ baseAddress: base, programAddress: program, seed: "anchor:idl" });
}
