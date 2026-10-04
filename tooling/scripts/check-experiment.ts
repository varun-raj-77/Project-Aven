import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import { experimentManifestSchema } from './experiment-schema.ts';

try {
  const manifestUrl = new URL(
    '../../experiments/EXP-001/manifest.yaml',
    import.meta.url,
  );
  const document = parseDocument(await readFile(manifestUrl, 'utf8'), {
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(document.errors.map((error) => error.message).join('\n'));
  }
  const manifest = experimentManifestSchema.parse(document.toJS() as unknown);
  console.log(
    `${manifest.id}: valid ${manifest.status} metadata; execution=${manifest.execution}; results absent.`,
  );
  if (manifest.status === 'draft') {
    console.log(
      'Freeze prerequisites remain unset. This check runs no experiment and enforces no runtime policy.',
    );
  }
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
