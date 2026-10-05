import { startWorld } from "./sites/index.ts";

const { urls, workspaceDir } = await startWorld();
console.log("\nKaveri Infra world is running (simulation; fictional data)\n");
console.log(`  Control Room   ${urls.control}   (reset · faults · ground truth; hidden from agents)`);
console.log(`  Kaveri Mail    ${urls.mail}`);
console.log(`  Kaveri ERP     ${urls.erp}`);
console.log(`  Bharat Bank    ${urls.bank}`);
console.log(`  GST Portal     ${urls.gst}`);
console.log(`  Udyam Portal   ${urls.udyam}`);
console.log(`  eProcure       ${urls.eproc}`);
console.log(`\n  Workspace      ${workspaceDir}\n`);
console.log("Stop with Ctrl+C.");
