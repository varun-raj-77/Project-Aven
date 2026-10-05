import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const repoRoot = new URL('../../', import.meta.url);
const manifestSchema = z.object({
  name: z.string(),
  scripts: z.record(z.string(), z.string()).default({}),
});
type Manifest = z.infer<typeof manifestSchema>;

const readManifest = (relativePath: string): Manifest =>
  manifestSchema.parse(
    JSON.parse(
      readFileSync(new URL(relativePath, repoRoot), 'utf8'),
    ) as unknown,
  );

const workspaceManifests = (): Array<{ dir: string; manifest: Manifest }> =>
  ['apps', 'packages'].flatMap((group) =>
    readdirSync(new URL(`${group}/`, repoRoot), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const dir = `${group}/${entry.name}`;
        try {
          return [{ dir, manifest: readManifest(`${dir}/package.json`) }];
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
          throw error;
        }
      }),
  );

const root = readManifest('package.json');
const rootScript = (name: string): string => {
  const script = root.scripts[name];
  if (script === undefined) throw new Error(`missing root script ${name}`);
  return script;
};

const sha256 = (relativePath: string): string =>
  createHash('sha256')
    .update(readFileSync(new URL(relativePath, repoRoot)))
    .digest('hex')
    .toUpperCase();

describe('MAINT-001 repository maintenance (tooling discipline, not runtime security)', () => {
  it('never invokes a package-manager executable from a package script', () => {
    const nested = /(^|[\s;&|(])(pnpm|npm|npx|yarn|corepack)(\s|$)/;
    const offenders = [
      { dir: '.', manifest: root },
      ...workspaceManifests(),
    ].flatMap(({ dir, manifest }) =>
      Object.entries(manifest.scripts)
        .filter(([, script]) => nested.test(script))
        .map(([name]) => `${dir}:${name}`),
    );
    expect(offenders).toEqual([]);
  });

  it('keeps check as exactly format:check, typecheck, experiment:check and test', () => {
    expect(rootScript('check')).toBe(
      ['format:check', 'typecheck', 'experiment:check', 'test']
        .map(rootScript)
        .join(' && '),
    );
  });

  it('typechecks the root and every workspace package that declares typecheck', () => {
    const packageDirs = workspaceManifests()
      .filter(({ manifest }) => manifest.scripts['typecheck'] !== undefined)
      .map(({ dir, manifest }) => {
        expect(manifest.scripts['typecheck']).toBe(
          'tsc --project tsconfig.json --noEmit',
        );
        return dir;
      });
    expect(packageDirs).toEqual(
      expect.arrayContaining([
        'packages/contracts',
        'packages/storage',
        'packages/ledger',
      ]),
    );
    const [first, ...rest] = rootScript('typecheck').split(' && ');
    expect(first).toBe('tsc --project tsconfig.json --noEmit');
    expect([...rest].sort()).toEqual(
      packageDirs
        .map((dir) => `tsc --project ${dir}/tsconfig.json --noEmit`)
        .sort(),
    );
  });

  it('runs the same storage migrate and test targets as the storage package', () => {
    const storage = readManifest('packages/storage/package.json');
    expect(storage.scripts['migrate']).toBe('node src/migrate-cli.ts');
    expect(rootScript('db:migrate')).toBe(
      'node packages/storage/src/migrate-cli.ts',
    );
    expect(storage.scripts['test']).toBe(
      'vitest run --configLoader native --root ../.. --config vitest.config.ts packages/storage/test',
    );
    expect(rootScript('db:test')).toBe(
      'vitest run --configLoader native packages/storage/test',
    );
  });

  it('preserves authoritative source artifacts byte-for-byte', () => {
    // SHA-256 values recorded in docs/REPOSITORY_INSPECTION.md (AVEN-001).
    expect(sha256('docs/sources/AVEN — IMPLEMENTATION INSTRUCTIONS.txt')).toBe(
      '3D8CAD37688476E0F9C0501D9A597A8B2EC038E490F8C9219C5B385BDE159EC4',
    );
    expect(
      sha256('docs/sources/AVEN_MASTER_PROJECT_DESCRIPTION_2026-10-03.pdf'),
    ).toBe('D76E014F1A0A10364BBE1BBFDFE74CD4188810B3EB45A66F74AEEB2A932AE446');
  });
});
