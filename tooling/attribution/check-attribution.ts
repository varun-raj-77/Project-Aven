import { fileURLToPath } from 'node:url';
import {
  checkAttribution,
  formatReport,
  FROZEN_BASELINE,
  type AttributionOptions,
} from './attribution.ts';

/**
 * `pnpm attribution:check`: checks every commit after the frozen AVEN-009
 * baseline in THIS repository (the one containing this script). It takes no
 * arguments, so the baseline and the required identities cannot be relaxed
 * from the command line. Exit code 0 only when every check passes.
 */
export function runAttributionCheck(
  options: AttributionOptions,
  write: (line: string) => void,
): boolean {
  const report = checkAttribution(options);
  for (const line of formatReport(report)) write(line);
  return report.ok;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const ok = runAttributionCheck(
      {
        repoDir: fileURLToPath(new URL('../../', import.meta.url)),
        baseline: FROZEN_BASELINE,
      },
      (line) => console.log(line),
    );
    if (!ok) process.exitCode = 1;
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
