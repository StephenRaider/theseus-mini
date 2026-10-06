export interface DemoLine {
  id: string;
  vendorId: string;
  vendorName: string;
  bill: string;
  description: string;
  gross: number;
  tdsRate: number;
  net: number;
  account: string;
  ifsc: string;
  acceptedOn: string;
}

export interface DemoData {
  today: string;
  batch: { id: string; title: string; lines: DemoLine[] };
  bidders: { key: "A" | "B" | "C"; name: string }[];
}
