import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * AVEN-007 frozen-layer REGRESSION TRIPWIRE (tooling discipline, not security).
 *
 * Extends the AVEN-006 tripwire (`frozen-layers.test.ts`, left unchanged) to
 * the layers frozen at tag `aven-006` (8c8228d): the AVEN-006 runtime package,
 * the AVEN-005/006 API app, the test suites of every frozen package, the
 * pre-existing tooling, the earlier milestone reports and the principles.
 * SHA-256 values are of the files at `aven-006`. AVEN-007 adds a new package
 * and dataset beside these layers and must not edit them. A later milestone
 * explicitly authorized to change one of them updates this table in the same
 * reviewed change. Files are compared byte-for-byte (LF checkout).
 */
const repoRoot = new URL('../../', import.meta.url);
const FROZEN_AT_AVEN_006: Record<string, string> = {
  'apps/api/README.md':
    '12c90fff16a4ee8911419c645112892a6b5c2d63d6b8dec00f6ef142f3c09489',
  'apps/api/package.json':
    '209610f10ffda24bee85a14f219b30084f1953bb08b83d2e07a6a98cb30c3ad3',
  'apps/api/src/assistant-response.ts':
    '0df7f65805a1c81417303814d51091a986ae06b14317d3eb420f7cb4ac4c7382',
  'apps/api/src/cli.ts':
    '8687eee0662e5c6e279c5d4214519748597a46665a06325a37f958263dfcb290',
  'apps/api/src/errors.ts':
    '419da72a8114457f7d562daa1bf03c745c65a749136512833106fab2cb69cc1c',
  'apps/api/src/http.ts':
    '6b5007630a590fe1846c8c9ddba2aee75a45a5ee9aa885f0ac10d911856f56a5',
  'apps/api/src/identity-store.ts':
    '195580d10150bb8d6c6d1a988e9f72f406fe035b0e24466843d39332ad0237e4',
  'apps/api/src/index.ts':
    '88cb5a7316f5ac5575aef90faaa0f517462d1e3c08216477f68a6d066fe60363',
  'apps/api/src/schemas.ts':
    '78a90dd36dc438d448307c897acda8e522cb845793852d42a2c1ef2c523c3b8b',
  'apps/api/src/server.ts':
    '88665bb77f953734d0fa0ecacf01eb9756e4e2dc79973fea80ef87a30d3f9425',
  'apps/api/src/service.ts':
    '5267cbaa8623921beb0f75c833c515d3a7d4779bebbd14a1af049a8ef0d05ac2',
  'apps/api/test/assistant-response.test.ts':
    'a505833b472f5d69e726e983c51b2c01701c23611042ce2b3a913a207215811c',
  'apps/api/test/boundaries.test.ts':
    '62c1023f801fabb4d22094bf3ed28eeff4eb98b86821660bf99fbd567c2b8cec',
  'apps/api/test/fixtures.ts':
    'a09a8120d11770ee65926437dd20963473d72769fff326fd4d07d2f1fdba9fab',
  'apps/api/test/http.test.ts':
    '837b8ad02b6e1302e6b49fa2c6fa8827994707822b9ea7a7367ca1fd6daaeaac',
  'apps/api/test/server.test.ts':
    'a60587df8343553587366c0ce5f9f69c4d1dfaf2c95d3b5e8f35860767587192',
  'apps/api/test/service.test.ts':
    'f3e47ca682ba28365d295d0857ed47a3df9be3e40c90b6427a859d0848147f5f',
  'apps/api/tsconfig.json':
    '96877be49c836acb8e4fd2d3a1c0e35a156a9fdf386a86ab1bccc23fe1b4a42e',
  'docs/AVEN_002_REPORT.md':
    '773101f769c0ac277061cb7f308805bd202c984d3fadf01000512bf66d50fba6',
  'docs/AVEN_003_REPORT.md':
    'bce1d2bbbe82812befa8e4744fe684ea0b9e54b8b50eb2d5822a0473ce957243',
  'docs/AVEN_004_REPORT.md':
    'ddf5cdaa45a964a0546e90d3dfb5e9d53c53cac9158c4f4dc8880e7fe3375195',
  'docs/AVEN_005_REPORT.md':
    '7e673eafb5c29967c346e1ae761eff565181c0a2a41066ae8d4fa6fea9d33813',
  'docs/AVEN_006_REPORT.md':
    '7edb6225dc242b984f988f92b91cce8b08b7411133a39a2b6e02079a0de97f2c',
  'docs/AVEN_PRINCIPLES.md':
    '1ad29dd728564d3e1ee4e28d063194b4b96b5ca4e8ff75c35dc173b07419156c',
  'docs/MAINT_001_REPORT.md':
    '327ba4db6a9fb794b3c2649aac573768b48ee91a4478e030d2fc33aea25be6ae',
  'packages/contracts/test/authority.test.ts':
    '36130fac362cd22ba137c284dac4c4c69d99b7e846d1a69964c3da45b8dfd415',
  'packages/contracts/test/boundaries.test.ts':
    '5c9a4c36a9d77f951ec3f2232a388e247ad11b07084a4bd725a3eb3be3f59518',
  'packages/contracts/test/events.test.ts':
    '8e46fc550865905ff4c9cafbe716c61f1f098accb909dc52c35a1bf3d7b298de',
  'packages/contracts/test/fixtures.ts':
    '5ae656bd8bee8a478b5c97809060d7338938b1b9c157fbc859300f8dc107a213',
  'packages/contracts/test/learning.test.ts':
    '8c8ce5e493b86af49cb1082881c7ef4294d51b1bac1d23bf8f05d385a6296030',
  'packages/contracts/test/types.ts':
    '285c35cf8f63549033d0aa56b6ca1520dba42d01bdca789e62c2254a36f37052',
  'packages/ledger/test/fixtures.ts':
    'b70b9287695dab0bb488c3d322b3db148794f0f4eb7fec92e9c701ce84d3f5a1',
  'packages/ledger/test/integrity.test.ts':
    '9e600b3f13a17133445bf4845e1513fa7a4ac78f36e3e06768cefdd406d77062',
  'packages/ledger/test/ledger.test.ts':
    '168700fe638adf05ae1a65f4ef129010c1b13e4e47628c1858f11ff01a51d02c',
  'packages/ledger/test/types.ts':
    'd4ef710384b3b8ecbe5d44e98142722ef72ae781b005b94a96a65d8e3414e397',
  'packages/runtime/README.md':
    'd3409812b42d034d3a1be8743e2254c1304417f54bb1c80f62c019d42e5045f0',
  'packages/runtime/package.json':
    '2d75f506d03677da9e47564f45d45390ce52be44a6a0e7d304b5d68ea3603c56',
  'packages/runtime/src/errors.ts':
    '72094cb3707b7c1f7dc6505f5a330124fb3aecef691af5bb33b25ab8f3979068',
  'packages/runtime/src/index.ts':
    '841d07e46b82f4a5e1969086fd15811acae1620e495b5ff86883b9ff3e2db848',
  'packages/runtime/src/invoke.ts':
    'd2978796b23e70c3f0cd347b381fa6da5f58259f93834a8649449229ed840598',
  'packages/runtime/src/scripted.ts':
    'b5f0681463265f095a732bddbe39319cfb8556cd506c02fd59caa7fefd55d27c',
  'packages/runtime/src/types.ts':
    '380c1c2cb121e0a0b5704693c74c09f820088bebb2b036e2f96701ced6502f07',
  'packages/runtime/test/boundaries.test.ts':
    'b4638848a1f2b071529fc26692678e6b3f9f9c5db94c7a5545d86d67d7b035cd',
  'packages/runtime/test/fixtures.ts':
    '25b40c50864127667ff886f77bb6f9bef26b859708bd92559b2b6cb117ccad83',
  'packages/runtime/test/runtime.test.ts':
    '8863d1361df4487d0bfd394ff423173e03e67f07614c7099b58c932da2beb362',
  'packages/runtime/tsconfig.json':
    '96877be49c836acb8e4fd2d3a1c0e35a156a9fdf386a86ab1bccc23fe1b4a42e',
  'packages/storage/test/fixtures.ts':
    'c7f77f3be6a52975ee3dbfc62f60d3f5136da3661fde59aee48b07584fda4cd8',
  'packages/storage/test/migrations.test.ts':
    '6661cdd67d2a087ea659261f5d0a265d999b91771fe41ac1a89a4656777811b8',
  'packages/storage/test/schema.test.ts':
    '12c6eb17977a9e9c1c978c00bc8554703e933e8309dd088fe0926f5e7e3b1a35',
  'tooling/scripts/check-experiment.ts':
    'b19f384622d0d4e17df2079fc8ad353f313c3181c89777de31914460f45f7b40',
  'tooling/scripts/experiment-schema.ts':
    'b5ccd14aef3daf3d1993f8bd372620682be2d932598e37d6cd8ab21ab5de30b3',
  'tooling/tests/experiment-manifest.test.ts':
    'ab48ec28cfe77970b1c39af8d573e6b5e9d95b0238c06ebae1d6c3e186e236af',
  'tooling/tests/frozen-layers.test.ts':
    'c4d5d08b83e76092c4268c7183df121789c1fea9cd647a797ad7cb43f032e78b',
  'tooling/tests/repository-maintenance.test.ts':
    '3b872d1a2dad13930823394d2ce481d425e658907920681317506cc340eee1ab',
};
/** Directories whose file set is frozen: AVEN-007 adds nothing to them. */
const FROZEN_DIRECTORIES = [
  'packages/runtime/src',
  'packages/runtime/test',
  'apps/api/src',
  'apps/api/test',
  'packages/contracts/test',
  'packages/storage/test',
  'packages/ledger/test',
];

const sha256 = (relativePath: string): string =>
  createHash('sha256')
    .update(readFileSync(new URL(relativePath, repoRoot)))
    .digest('hex');

describe('AVEN-007 frozen layers (tooling tripwire, not runtime security)', () => {
  it('keeps AVEN-005/006 sources, frozen test suites, tooling, reports and principles byte-identical to aven-006', () => {
    const changed = Object.entries(FROZEN_AT_AVEN_006)
      .filter(([file, digest]) => sha256(file) !== digest)
      .map(([file]) => file);
    expect(changed).toEqual([]);
  });

  it('adds no file to a frozen source or test directory', () => {
    const present = FROZEN_DIRECTORIES.flatMap((dir) =>
      readdirSync(new URL(`${dir}/`, repoRoot)).map((f) => `${dir}/${f}`),
    );
    expect(present.filter((f) => !(f in FROZEN_AT_AVEN_006))).toEqual([]);
  });
});
