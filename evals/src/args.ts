/**
 * Command-line helpers. PowerShell turns `a,b,c` into an array and hands a native program the items
 * as SEPARATE arguments (or one space-joined string), so a list must be read in every shape:
 *   --cases a,b,c      --cases "a,b,c"      --cases a b c      --cases "a b c"
 */
export function listOption(args: string[], name: string): string[] | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const items: string[] = [];
  for (let j = i + 1; j < args.length && !args[j]!.startsWith("--"); j++) items.push(...args[j]!.split(/[,\s]+/).filter(Boolean));
  return items.length ? items : undefined;
}
