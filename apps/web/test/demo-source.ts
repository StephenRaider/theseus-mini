import { BIDDERS, TODAY, initialState } from "@theseus/kaveri";
import type { DemoData } from "../src/replay/types.ts";

/** The slice of the Kaveri seed the replay needs. */
export function demoDataFromSeed(): DemoData {
  const s = initialState();
  const vendors = new Map(s.vendors.map((v) => [v.id, v]));
  const batch = s.batches[0]!;
  return {
    today: TODAY,
    batch: {
      id: batch.id,
      title: batch.title,
      lines: batch.lines.map((l) => ({
        id: l.id,
        vendorId: l.vendorId,
        vendorName: vendors.get(l.vendorId)?.legalName ?? l.vendorId,
        bill: l.billNumber,
        description: l.description,
        gross: l.gross,
        tdsRate: l.tdsRate,
        net: l.net,
        account: l.payTo.accountNumber,
        ifsc: l.payTo.ifsc,
        acceptedOn: l.acceptedOn,
      })),
    },
    bidders: (["A", "B", "C"] as const).map((k) => ({ key: k, name: BIDDERS[k].legalName })),
  };
}
