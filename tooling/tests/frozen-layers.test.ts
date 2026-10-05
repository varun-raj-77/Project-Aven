import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * AVEN-006 frozen-layer REGRESSION TRIPWIRE (tooling discipline, not security).
 *
 * SHA-256 of every source, migration and manifest file of the frozen AVEN-002
 * contracts, AVEN-003 storage and AVEN-004 Ledger packages, and of the EXP-001
 * protocol files, as of tag `aven-005` (f28994a). AVEN-006 adds a new runtime
 * package beside these layers and must not edit them. A later milestone that is
 * explicitly authorized to change a frozen layer updates this table in the same
 * reviewed change; a silent edit fails here. Files are compared byte-for-byte
 * (the repository checks text out with LF line endings).
 */
const repoRoot = new URL('../../', import.meta.url);
const FROZEN: Record<string, string> = {
  'experiments/EXP-001/hypothesis.md':
    '80ea119f25ff453660ce23df2ef6550e21f38371317ca0a8c1e311680c138d8a',
  'experiments/EXP-001/manifest.yaml':
    '88290cd8b41f8b5b2dd259137ab0d7ffdf7c24f26ee4e8e9d6d9e9aa3e85a235',
  'experiments/EXP-001/protocol.md':
    '79d268010cb2d29fc870b91c4b91d471d67ce43b5c9c64c8db2fc6bea9b3b491',
  'packages/contracts/package.json':
    '5441a79f29f4caf5e783e9f68d827aabefb71a8b01972b13767031831df16954',
  'packages/contracts/src/actions.ts':
    '6cea54922f52564ef51661eb7a4f21c6243b9d7ed6b464efd0542436aad8cb02',
  'packages/contracts/src/approvals.ts':
    '1e66834ee4015e77258f7325d169574998c9e6052bf7e7a78240ab12b545828c',
  'packages/contracts/src/common.ts':
    '89fd8f5c80b0512e836c115ff8a557590e4d77a7457491fe8b05ba32e160abdc',
  'packages/contracts/src/context.ts':
    '02b3fdd3281f3deef5af0dfe81f6c015576033e455677a0acfe0e695c48d4479',
  'packages/contracts/src/corrections.ts':
    '8bbf61957ae7ae5aaa1fe624b9a249f527e9633d5d421130778b7ee0ab451873',
  'packages/contracts/src/evaluation.ts':
    'f63fd6b28c5fd0ac4ef5824a4b3f2cb2793879d1f0bfdd13da1a9a5458ed6223',
  'packages/contracts/src/execution.ts':
    'e80236b238a7eb3a057ccfd774d26d4eaf45f71480f03fba52322587ed793562',
  'packages/contracts/src/experience.ts':
    '867283a1a9af1df95c970f2902449cf6d04160cf8cbf344533af07e63ec28a5b',
  'packages/contracts/src/ids.ts':
    'cfc01facddfdd86316dc994b96f4a9584f0e2bb9a463208b18d8559f34bd70a2',
  'packages/contracts/src/index.ts':
    '44bfd975e8f5c96a310e0ef45b06daf0e0b387de6a9a85f8f23519a07e1cb7ca',
  'packages/contracts/src/learning.ts':
    '48ec77877e50d98732cf69936a46c0650d13e62bd30cde9f9f82d842d76ed2d6',
  'packages/contracts/src/owner-state.ts':
    'ab83a2911f2af08f3b00b528e8d8149b805bb698bd2a202afdae8af0d0fc4ddf',
  'packages/contracts/src/policy.ts':
    '5d1f42d80da32350b4d71e5ba3c0a6bc8eb43c090427a7e90656c586f2789d96',
  'packages/contracts/src/provenance.ts':
    '56471d7245a9b65b9c5392802795f65da0408833f38423a3a6a6db52e2ef2443',
  'packages/contracts/src/runtime.ts':
    '11fca74cf583eb1841b0c13c3ff4a9a92acff0a8da1cb46c86e26ce7bc24d20c',
  'packages/contracts/src/scope.ts':
    '8552e4e18debb556c287d3e9dafbacaeeef4b232c7b05943d4ebeacfe7b3ab2d',
  'packages/contracts/src/transitions.ts':
    'fc06381ba359e7577f27d4bc842c38d973a29a670624a85f2b06368eae77fa08',
  'packages/contracts/src/verification.ts':
    '4f42de9dc189e8bf1e0ed46205ccc0aa1a49059524d0e48c9878e2262a428154',
  'packages/ledger/package.json':
    'ae2b77ff37e82537534c61ed77387058c188dd7f4be6b89d778fe8ce2ac0fe10',
  'packages/ledger/src/errors.ts':
    'd25d524a0182e98e69ab98ef711c8ddf8ebcecbddf3b67ba2e8eb1f3f4a4e75d',
  'packages/ledger/src/index.ts':
    '36158b1ca55faca798d5c866ab6b95ad819573435768976d1aec2bbe5d35be37',
  'packages/ledger/src/integrity.ts':
    'c87846f2d805af71aded472bda4163534e269b4f60bee5353dd005244eef89a6',
  'packages/ledger/src/ledger.ts':
    '4bf8d069b3c100c0abd9bba2524cfa2b3bfc1a6bfef37d2d0e43106069a5c96b',
  'packages/ledger/src/records.ts':
    'b87c435cb7d3ecaac9f2900c75206edf27ee14077fa7303459b305b44c769b0e',
  'packages/storage/migrations/0001_storage.sql':
    '2b3ee4452efcf63d3af5c400c096c49d48a4f430641f7186a2de003b2118fb37',
  'packages/storage/package.json':
    'fd7a6364f2e3780e80417ae8f97912219947bac32ef40fae0e3bf22caea23949',
  'packages/storage/src/connection.ts':
    '7634da8a5c0c0a94a7cbc0d2d77a3abf7d8dca0f43e6946b758d91e45ad04cfd',
  'packages/storage/src/index.ts':
    'af55d869f5aff4e6d47607505be9a9b64aa3cc9254d24f9e7a4ce2c0701786aa',
  'packages/storage/src/migrate-cli.ts':
    'e194014fb7c0f62b558428f6080c3b82b0fe354b8924b76dd0d910f96ce0b40e',
  'packages/storage/src/migrate.ts':
    'd617ac6fc1b472b5d5037fd25ec65bff253111a716bfe302bc221c60c8f9d4f7',
  'packages/storage/src/references.ts':
    '546c43d2e4d0a968a4a0732aaf293d048cbf83cd8d8125545b9e13731393784c',
  'packages/storage/src/schema.ts':
    '543569da7db1f5361785389d4333ca80e975f2b62d4da03020f1712f8ae79727',
  'packages/storage/src/serialization.ts':
    '35b6149461837f74e43f2da88a7ac34bb2154366288274c9f19d72f0ca95c2e1',
};
const FROZEN_DIRECTORIES = [
  'packages/contracts/src',
  'packages/storage/src',
  'packages/storage/migrations',
  'packages/ledger/src',
  'experiments/EXP-001',
];

const sha256 = (relativePath: string): string =>
  createHash('sha256')
    .update(readFileSync(new URL(relativePath, repoRoot)))
    .digest('hex');

describe('AVEN-006 frozen layers (tooling tripwire, not runtime security)', () => {
  it('keeps AVEN-002/003/004 sources, the migration and EXP-001 byte-identical to aven-005', () => {
    const changed = Object.entries(FROZEN)
      .filter(([file, digest]) => sha256(file) !== digest)
      .map(([file]) => file);
    expect(changed).toEqual([]);
  });

  it('adds no file to a frozen source, migration or protocol directory', () => {
    const present = FROZEN_DIRECTORIES.flatMap((dir) =>
      readdirSync(new URL(`${dir}/`, repoRoot)).map((f) => `${dir}/${f}`),
    );
    expect(present.filter((f) => !(f in FROZEN))).toEqual([]);
  });
});
