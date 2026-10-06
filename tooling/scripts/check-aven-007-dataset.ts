import { readFile } from 'node:fs/promises';
import {
  AVEN_007_DATASET_VERSION,
  validateAven007Dataset,
} from './aven-007-dataset.ts';

/**
 * Validates the AVEN-007 dataset v2 (counts, splits, families, oracle
 * contract, B-mechanics exposure controls, construction/diagnostics files,
 * baseline configuration, file hashes) and the byte-identical archive of the
 * reviewed v1 candidate. Runs no model and no experiment. Research-discipline
 * check, not a security control.
 */
try {
  const dir = new URL('../../evals/aven-007/', import.meta.url);
  const text = (name: string) => readFile(new URL(name, dir), 'utf8');
  const bytes = (name: string) => readFile(new URL(name, dir));
  const [
    casesText,
    oracleText,
    controlsText,
    constructionText,
    diagnosticsText,
    manifestText,
    archiveCases,
    archiveOracle,
    archiveManifest,
  ] = await Promise.all([
    text('cases.jsonl'),
    text('oracle.jsonl'),
    text('b-mechanics-controls.json'),
    text('construction.json'),
    text('diagnostics.json'),
    text('manifest.json'),
    bytes('reviewed-v1/cases.jsonl'),
    bytes('reviewed-v1/oracle.jsonl'),
    bytes('reviewed-v1/manifest.json'),
  ]);
  const problems = validateAven007Dataset({
    casesText,
    oracleText,
    controlsText,
    constructionText,
    diagnosticsText,
    manifest: JSON.parse(manifestText) as unknown,
    archive: {
      cases: archiveCases,
      oracle: archiveOracle,
      manifest: archiveManifest,
    },
  });
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(
      `AVEN-007-DATASET-001 v${AVEN_007_DATASET_VERSION}: valid synthetic dataset; 64 cases (48 development, 16 held-out), 32 families; reviewed v1 archive byte-identical; execution=not_run; results absent.`,
    );
  }
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
