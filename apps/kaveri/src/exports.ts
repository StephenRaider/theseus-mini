import ExcelJS from "exceljs";
import type { Kaveri } from "./store.ts";

/**
 * ERP "Export to Excel" for a payment batch: a real .xlsx (opens in Excel)
 * that the employee then annotates with check results.
 */
export async function batchToXlsx(kaveri: Kaveri, batchId: string): Promise<Buffer> {
  const batch = kaveri.getBatch(batchId);
  const wb = new ExcelJS.Workbook();
  wb.creator = "Kaveri ERP";
  wb.created = new Date(`${kaveri.state.today}T09:00:00+05:30`);
  const ws = wb.addWorksheet(batch.id, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = [
    { header: "Line", key: "id", width: 8 },
    { header: "Vendor ID", key: "vendorId", width: 10 },
    { header: "Vendor", key: "vendor", width: 36 },
    { header: "Vendor PAN", key: "pan", width: 13 },
    { header: "Bill no.", key: "bill", width: 18 },
    { header: "Work order", key: "wo", width: 13 },
    { header: "Description", key: "desc", width: 44 },
    { header: "Accepted on", key: "accepted", width: 12 },
    { header: "Gross (₹)", key: "gross", width: 13 },
    { header: "TDS rate", key: "rate", width: 9 },
    { header: "TDS (₹)", key: "tds", width: 11 },
    { header: "Net (₹)", key: "net", width: 13 },
    { header: "Pay-to account", key: "acct", width: 18 },
    { header: "Pay-to IFSC", key: "ifsc", width: 13 },
    { header: "ERP status", key: "status", width: 11 },
  ];
  for (const l of batch.lines) {
    const v = kaveri.state.vendors.find((x) => x.id === l.vendorId);
    ws.addRow({
      id: l.id, vendorId: l.vendorId, vendor: v?.legalName ?? "", pan: v?.pan ?? "", bill: l.billNumber, wo: l.workOrder,
      desc: l.description, accepted: l.acceptedOn, gross: l.gross, rate: l.tdsRate, tds: l.tds, net: l.net,
      acct: l.payTo.accountNumber, ifsc: l.payTo.ifsc, status: l.status,
    });
  }
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8EEF5" } };
  for (const k of ["gross", "tds", "net"]) ws.getColumn(k).numFmt = "#,##,##0";
  ws.getColumn("rate").numFmt = "0.0%";
  ws.getColumn("acct").numFmt = "@";
  ws.autoFilter = { from: "A1", to: "O1" };
  return Buffer.from(await wb.xlsx.writeBuffer());
}
