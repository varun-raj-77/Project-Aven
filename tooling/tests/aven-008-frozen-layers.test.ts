import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * AVEN-008 frozen-layer REGRESSION TRIPWIRE (tooling discipline, not security).
 *
 * SHA-256 of EVERY file tracked at tag `aven-007` (1658eda), computed from the
 * tag's blobs, except the narrow set AVEN-008 is authorized to update:
 * `README.md`, `AGENTS.md`, `docs/ROADMAP.md`, the root `package.json`
 * (workspace typecheck wiring and description), `pnpm-lock.yaml` (the new
 * importer only) and the `packages/context-broker/.gitkeep` placeholder that
 * the new package replaces. This covers AVEN-001 to AVEN-007 and MAINT-001:
 * contracts, storage, migrations, Ledger, API, runtime, the AVEN-007 baseline
 * package, dataset, oracle, reviewed-v1 archive, tooling, EXP-001, reports,
 * principles and source documents. The earlier tripwires
 * (`frozen-layers.test.ts`, `aven-007-frozen-layers.test.ts`) are unchanged.
 * A later milestone explicitly authorized to change one of these files
 * updates this table in the same reviewed change. Files are compared
 * byte-for-byte (the repository checks text out with LF line endings).
 */
const repoRoot = new URL('../../', import.meta.url);
const FROZEN_AT_AVEN_007: Record<string, string> = {
  '.editorconfig':
    '827dacbabd7177a7cf0689d50e1f9f8f2a317191aa75c42524a187b30e684426',
  '.gitattributes':
    'fe27eb454f621406a751189a4be1ca15c7c6c723c3456eeeccf1aada0ed67273',
  '.gitignore':
    'e1dfbfe27d54da641ad8e35afe1d71461081ff0aea5397bd58f5ea2ba1a17979',
  '.prettierignore':
    'd844d1827f2922289037333871f472bf9cad79bfad124ab75381730ee6575b4b',
  '.prettierrc.json':
    '6da8d5defb860b5f1db1d8239810f3c40de8c0175bf1cf9d32ce8824ce8978fb',
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
  'apps/web/.gitkeep':
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'decisions/README.md':
    '035ade6c8033b30fa372c5ba44ea38933595b5ef489894bf12ae5cbb3f4a81fe',
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
  'docs/AVEN_007_REPORT.md':
    '7247c25076a38f9dc442cab77c9fc6193cfb852f0f7fbfd51d4e1ed7a9bc380e',
  'docs/AVEN_PRINCIPLES.md':
    '1ad29dd728564d3e1ee4e28d063194b4b96b5ca4e8ff75c35dc173b07419156c',
  'docs/BACKLOG_FUTURE.md':
    '59ae70edd99d57605f6f9945db6202f1fa6f3dcb26fd4540abb26581ddd9b40b',
  'docs/MAINT_001_REPORT.md':
    '327ba4db6a9fb794b3c2649aac573768b48ee91a4478e030d2fc33aea25be6ae',
  'docs/PRODUCT_THESIS.md':
    '0f0996a4f1a122f7c83a9b65a1f2a67c7b9360c44ace36cdcd5f3d291417ef82',
  'docs/PROJECT_DESCRIPTION.md':
    '45b4672871bde72f94741e2caf2c74b36f3f252390fb587e541c29b5810f7057',
  'docs/REPOSITORY_INSPECTION.md':
    '617713c6080f2992004adb653dba679f059105adb76b341d5c139610d8156757',
  'docs/RISK_REGISTER.md':
    'aa2d405680137968dd40455a32ba2a41d88145dfdff17b2a1f6d2bb87199bca2',
  'docs/THREAT_MODEL.md':
    '65090ee0a0731c6183e3a1c1c4ff5df5e098796260d1959a02b8ebbb588be288',
  'docs/USER_RESEARCH.md':
    '010da0b710dba6ae5a1f038f25c6779631dda1f3ae65c863e313c080f99d0057',
  'docs/sources/AVEN — IMPLEMENTATION INSTRUCTIONS.txt':
    '3d8cad37688476e0f9c0501d9a597a8b2ec038e490f8c9219c5b385bde159ec4',
  'docs/sources/AVEN_MASTER_PROJECT_DESCRIPTION_2026-10-03.pdf':
    'd76e014f1a0a10364bbe1bbfdfe74cd4188810b3eb45a66f74aeeb2a932ae446',
  'docs/sources/README.md':
    '1dd2a84ae03e9308d24c34d4547057479dd231d50e6e6b37d4eca19136527b9e',
  'docs/sources/workspace-inventory.json':
    '1f98e8f0a0f1f7338a9684039c4fe983a7345c7722c958d6ac47ceeba85c38ab',
  'evals/README.md':
    '9bb55485a1e68154c94d003026fed52640b548255e3b36ebac75f7cb8167cb0e',
  'evals/aven-007/README.md':
    '840e4f334474309275d990b416e7614c45aec0cfc505e253aeab310fc350705c',
  'evals/aven-007/b-mechanics-controls.json':
    'cea4acf336a26cf94b36dc848c189d3deca5fb6cd9a819a9076b480ab2f8208c',
  'evals/aven-007/cases.jsonl':
    'a598b6d4bf3a3c478406d0f198a7f0f810ee5a60d59fe21d63e7df7291425190',
  'evals/aven-007/construction.json':
    '29db270d2612179ce21529761ff9d8d8712ecc0cf49af1ced9a627f2589e0f2e',
  'evals/aven-007/diagnostics.json':
    'e4a18afa5074890559d8f65536f5054f173c5551841d4d48fa33f48e064a66b5',
  'evals/aven-007/manifest.json':
    '9196ad4ef03a9f5ca17b9100ed71af08bb00e074a9a5e0b1e5cc5c803078227b',
  'evals/aven-007/oracle.jsonl':
    'dd1d192d563e0fcd8c52e5d840270afabc388da078e7adc642d20620ec1b832f',
  'evals/aven-007/reviewed-v1/README.md':
    '82bce1ae17d213aa9a8798f360c1ad594109f97a411b6d7d57d3a65745dadd4a',
  'evals/aven-007/reviewed-v1/cases.jsonl':
    '162a879729293a28bad2afdec54936b66d0ad05aec56315afeed3295c1184cc8',
  'evals/aven-007/reviewed-v1/manifest.json':
    'd6dc4bcdf3fbcb480f45222d2dc14aeaf7c3a8b0f4d4f60951570f8ba03f4205',
  'evals/aven-007/reviewed-v1/oracle.jsonl':
    '5798eb24b68cffbc00ad40d9a76fd88ab8b7c83fd0a92800d19f18c0b388ff58',
  'evals/datasets/.gitkeep':
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'evals/held-out/.gitkeep':
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'evals/regression/.gitkeep':
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'evals/scorers/.gitkeep':
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'experiments/EXP-001/hypothesis.md':
    '80ea119f25ff453660ce23df2ef6550e21f38371317ca0a8c1e311680c138d8a',
  'experiments/EXP-001/manifest.yaml':
    '88290cd8b41f8b5b2dd259137ab0d7ffdf7c24f26ee4e8e9d6d9e9aa3e85a235',
  'experiments/EXP-001/protocol.md':
    '79d268010cb2d29fc870b91c4b91d471d67ce43b5c9c64c8db2fc6bea9b3b491',
  'experiments/README.md':
    'f05ee4daa399471957ddc2138aacd02c251bb177078827704b5292ed670ac401',
  'packages/baseline/README.md':
    '1b1046076cd3f56267dba412551bf05e5bb94a57e713a8ecef1bce220f1ff329',
  'packages/baseline/package.json':
    'd5c55eec33b8d64a7e8b7ab2a1b426377c6e95159a96c69672af4819ad0b9c9d',
  'packages/baseline/src/config.ts':
    '60b9d2e3472046dc4b98773f3b808f6929cf4452e1b155c813895b6b833299a1',
  'packages/baseline/src/dataset.ts':
    '1df665bc5c8f086e9921d7d03f6fa55519cead71bfaef8ac081c60790aee24bc',
  'packages/baseline/src/errors.ts':
    'ec7d2f28c76e140b980630807e51d703262b7e7889426efeebd93e4c99a078c6',
  'packages/baseline/src/history-search.ts':
    '08b27e1529a5ea188a77600394a22d8288e100459fa5d69248e0c0d3986a03fb',
  'packages/baseline/src/index.ts':
    '6e153802a1fd6cc32885d8af5d7f2e62dfaef90247a5b9ee2e7e6ec9daa96659',
  'packages/baseline/src/profile.ts':
    'c5a3b61e1744613ea839d1f32b7ef4890dd9724cfde23a2ddf804a1f78743319',
  'packages/baseline/src/prompt.ts':
    '0a8b7b52009c927b4e10cf4e73a0255136ec8343555eff65f3525715b7a2416b',
  'packages/baseline/src/run-record.ts':
    'aa8fd646eed1252afe579f4a0ceb01b2db93d60c8a8f18315b17c29d05497b4a',
  'packages/baseline/src/runner.ts':
    'b701a8ba8b41c10c046bd2aa2bdbc83a84e24ff3c7840aa592acb419e1b18ae1',
  'packages/baseline/src/types.ts':
    'c080a954290c41db467f1f975165dbbac0f57993d7441de5c7f336720da7e3cf',
  'packages/baseline/test/boundaries.test.ts':
    '6314dac6e0bcbef28cf108c36bd0cdc8f51f95eed45620fdc322113ef1919b84',
  'packages/baseline/test/dataset.test.ts':
    '0c981990a0e5610955fd6c8089d2b4911043a0e7db032f4129ece07233760834',
  'packages/baseline/test/fixtures.ts':
    '17ef35c6c68198934afb2f8cd78e18deb3ae1a9f559415af0f28a36f4f8aa052',
  'packages/baseline/test/history-search.test.ts':
    'a98d57ba12d6efb0e7603b6c1d9ebbc7604fddae3eb68c65b2e03e3c7e94a14d',
  'packages/baseline/test/profile.test.ts':
    '50dd8efbbff205ce28303aaacd5268137d39275850a3d0e3c682141866fa1f8a',
  'packages/baseline/test/prompt.test.ts':
    '17abf761a9784f1083826362c2c049b82de4b1f924f531d035ccc4477d2e4b35',
  'packages/baseline/test/runner.test.ts':
    'b9f0d5eb55006706e6d5d8f301d1754fb5c08347b4c378cce763d05cba221b02',
  'packages/baseline/test/tokenizer-v1-fixture.ts':
    '57883f37a4c0d521fe0f41d7caffffbb8f4aa68e916907d85b40caf769d0b9c0',
  'packages/baseline/tsconfig.json':
    '96877be49c836acb8e4fd2d3a1c0e35a156a9fdf386a86ab1bccc23fe1b4a42e',
  'packages/contracts/README.md':
    'c3d9b9662ffbc4ac1d4bc2c1de6a74500f016e984ef86c0868a9b0bfca6ec48b',
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
  'packages/contracts/tsconfig.json':
    '96877be49c836acb8e4fd2d3a1c0e35a156a9fdf386a86ab1bccc23fe1b4a42e',
  'packages/eval/.gitkeep':
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'packages/learning/.gitkeep':
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'packages/ledger/README.md':
    '9475739f893886ec09ea141f182653d8d458a5e7bb24b36712c08b650fe1fc10',
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
  'packages/ledger/test/fixtures.ts':
    'b70b9287695dab0bb488c3d322b3db148794f0f4eb7fec92e9c701ce84d3f5a1',
  'packages/ledger/test/integrity.test.ts':
    '9e600b3f13a17133445bf4845e1513fa7a4ac78f36e3e06768cefdd406d77062',
  'packages/ledger/test/ledger.test.ts':
    '168700fe638adf05ae1a65f4ef129010c1b13e4e47628c1858f11ff01a51d02c',
  'packages/ledger/test/types.ts':
    'd4ef710384b3b8ecbe5d44e98142722ef72ae781b005b94a96a65d8e3414e397',
  'packages/ledger/tsconfig.json':
    '96877be49c836acb8e4fd2d3a1c0e35a156a9fdf386a86ab1bccc23fe1b4a42e',
  'packages/owner-model/.gitkeep':
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'packages/root/.gitkeep':
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
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
  'packages/storage/README.md':
    '3887b2ebe5669ab10d7bbaff763a14c3a031725f7b289f82223c3265c6860af5',
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
  'packages/storage/test/fixtures.ts':
    'c7f77f3be6a52975ee3dbfc62f60d3f5136da3661fde59aee48b07584fda4cd8',
  'packages/storage/test/migrations.test.ts':
    '6661cdd67d2a087ea659261f5d0a265d999b91771fe41ac1a89a4656777811b8',
  'packages/storage/test/schema.test.ts':
    '12c6eb17977a9e9c1c978c00bc8554703e933e8309dd088fe0926f5e7e3b1a35',
  'packages/storage/tsconfig.json':
    '96877be49c836acb8e4fd2d3a1c0e35a156a9fdf386a86ab1bccc23fe1b4a42e',
  'packages/test-utils/.gitkeep':
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'pnpm-workspace.yaml':
    '253208fa7c1b64372c219b9e19cef15ed70ca93b66a4d5c4c4d2297a5aff8880',
  'results/README.md':
    'c3b856b43775fb6554378bc8404b5096a352b164dbd74c08d5b471728e54de1b',
  'tooling/scripts/aven-007-dataset.ts':
    'bb5d5b61a0e246161b18acddd7b0a960bc42a27d136d2220e164f476bc076050',
  'tooling/scripts/aven-007-diagnostics.ts':
    '2ee40de5cda1c8726e43f255df85f5086db92f6dd3ce2f04e4fbdf205fd9390b',
  'tooling/scripts/check-aven-007-dataset.ts':
    '8ffa590dd4b58b8a5ac80d9805d31ecc5b2fcab203e1407b945ae84bcdce4ae2',
  'tooling/scripts/check-experiment.ts':
    'b19f384622d0d4e17df2079fc8ad353f313c3181c89777de31914460f45f7b40',
  'tooling/scripts/experiment-schema.ts':
    'b5ccd14aef3daf3d1993f8bd372620682be2d932598e37d6cd8ab21ab5de30b3',
  'tooling/tests/aven-007-dataset.test.ts':
    'b85def74bade7b819fc375bdc6c6460d2a98475d9800d0224a1b6309b76f84fc',
  'tooling/tests/aven-007-frozen-layers.test.ts':
    'f807d575116217c912672272c8ebca097910bdd162a2bbe391c60eb3812d7f05',
  'tooling/tests/experiment-manifest.test.ts':
    'ab48ec28cfe77970b1c39af8d573e6b5e9d95b0238c06ebae1d6c3e186e236af',
  'tooling/tests/frozen-layers.test.ts':
    'c4d5d08b83e76092c4268c7183df121789c1fea9cd647a797ad7cb43f032e78b',
  'tooling/tests/repository-maintenance.test.ts':
    '3b872d1a2dad13930823394d2ce481d425e658907920681317506cc340eee1ab',
  'tsconfig.base.json':
    '311ec9efebbb5944137397d49176d0a843b7bf47386a9f781265a63373555b21',
  'tsconfig.json':
    'acb4ba736638a3573ca87d616250c35d6a1381f77aa93ad16f58da2777916e7c',
  'vitest.config.ts':
    '4a374c56f53f7cd3d1a35ce01c344240d18bf48a8e49499624be57f49e9fcbe8',
};

/** Directories whose file set is frozen at aven-007: AVEN-008 adds nothing. */
const FROZEN_DIRECTORIES = [
  'apps/api/src',
  'apps/api/test',
  'docs/sources',
  'evals/aven-007',
  'evals/aven-007/reviewed-v1',
  'experiments/EXP-001',
  'packages/baseline',
  'packages/baseline/src',
  'packages/baseline/test',
  'packages/contracts/src',
  'packages/contracts/test',
  'packages/ledger/src',
  'packages/ledger/test',
  'packages/runtime/src',
  'packages/runtime/test',
  'packages/storage/migrations',
  'packages/storage/src',
  'packages/storage/test',
  'tooling/scripts',
];

const sha256 = (relativePath: string): string =>
  createHash('sha256')
    .update(readFileSync(new URL(relativePath, repoRoot)))
    .digest('hex');

describe('AVEN-008 frozen layers (tooling tripwire, not runtime security)', () => {
  it('keeps every file tracked at aven-007, outside the authorized update set, byte-identical', () => {
    expect(Object.keys(FROZEN_AT_AVEN_007)).toHaveLength(169);
    const changed = Object.entries(FROZEN_AT_AVEN_007)
      .filter(([file, digest]) => sha256(file) !== digest)
      .map(([file]) => file);
    expect(changed).toEqual([]);
  });

  it('adds no file to a frozen source, test, dataset, protocol or tooling directory', () => {
    const present = FROZEN_DIRECTORIES.flatMap((dir) =>
      readdirSync(new URL(`${dir}/`, repoRoot), { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => `${dir}/${entry.name}`),
    );
    expect(present.filter((f) => !(f in FROZEN_AT_AVEN_007))).toEqual([]);
  });

  it('pins the frozen AVEN-007 baseline and dataset that AVEN-008 must not depend on or edit', () => {
    for (const file of [
      'packages/baseline/src/history-search.ts',
      'packages/baseline/src/config.ts',
      'evals/aven-007/manifest.json',
      'evals/aven-007/oracle.jsonl',
      'evals/aven-007/cases.jsonl',
      'docs/AVEN_007_REPORT.md',
    ])
      expect(FROZEN_AT_AVEN_007, file).toHaveProperty([file]);
  });
});
