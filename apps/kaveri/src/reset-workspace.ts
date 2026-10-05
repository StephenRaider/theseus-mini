import { initialState } from "./seed/scenario.ts";
import { generateWorkspace } from "./workspace.ts";

// `pnpm world:reset`: regenerate the local workspace folder without starting the sites.
const dir = await generateWorkspace(initialState());
console.log(`Workspace regenerated at ${dir}`);
