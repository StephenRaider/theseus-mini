import { buildServer } from "./server.ts";

const port = Number(process.env.KAVERI_PORT ?? 4100);
const app = buildServer();
await app.listen({ port, host: "127.0.0.1" });
console.log(`Kaveri Infra mock company running at http://localhost:${port}`);
console.log(`  Mail      http://localhost:${port}/mail`);
console.log(`  Vendors   http://localhost:${port}/erp/vendors`);
console.log(`  Payments  http://localhost:${port}/erp/payments/PB-2026-W41`);
console.log(`  Admin     http://localhost:${port}/admin   (reset, faults, planted traps)`);
