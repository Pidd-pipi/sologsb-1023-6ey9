import { strict as assert } from 'node:assert';
import { inspectWorkPackage } from '../src/composables/useCollation';
import { splitIntoUnits } from '../src/data';
import type { AlignmentRow, VersionDocument, WorkPackage } from '../src/types';

function makeVersion(id: string, name: string, text: string): VersionDocument {
  return {
    id,
    name,
    source: '测试来源',
    createdAt: '2026-09-27T00:00:00.000Z',
    text,
    units: splitIntoUnits(text, id)
  };
}

const textA = '道可道，非常道。名可名，非常名。';
const textB = '道可道也，非恒道也。名可名也，非恒名也。';

function makePackage(overrides: Partial<WorkPackage> = {}): WorkPackage {
  const va = makeVersion('v-a', '底本甲', textA);
  const vb = makeVersion('v-b', '参校乙', textB);
  const rows: AlignmentRow[] = [
    {
      id: 'r1',
      left: va.units[0],
      right: vb.units[0],
      status: 'changed',
      similarity: 0.7,
      note: '通假',
      source: '整理稿',
      accepted: true,
      manuallyAdjusted: true
    },
    {
      id: 'r2',
      left: va.units[1],
      right: vb.units[1],
      status: 'same',
      similarity: 1,
      note: '',
      source: '',
      accepted: true,
      manuallyAdjusted: false
    }
  ];
  return {
    kind: 'collation-workpackage',
    appVersion: 1,
    exportedAt: '2026-09-27T08:00:00.000Z',
    versions: [va, vb],
    leftVersionId: 'v-a',
    rightVersionId: 'v-b',
    rules: { ignorePunctuation: true, ignoreVariants: false, candidateWindow: 3 },
    rows,
    selectedRowId: 'r1',
    ...overrides
  };
}

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

// 1. 干净环境恢复：应通过并携带完整计划
test('干净工作区可直接恢复，计划保留底本/参校/规则/校记/接受结果', () => {
  const result = inspectWorkPackage(JSON.stringify(makePackage()), []);
  assert.equal(result.ok, true);
  assert.equal(result.issues.filter((i) => i.level === 'error').length, 0);
  assert.ok(result.plan);
  assert.equal(result.plan!.leftVersionId, 'v-a');
  assert.equal(result.plan!.rightVersionId, 'v-b');
  assert.equal(result.plan!.rules.ignoreVariants, false);
  assert.equal(result.plan!.rows.length, 2);
  assert.equal(result.plan!.rows[0].note, '通假');
  assert.equal(result.plan!.rows[0].accepted, true);
  assert.equal(result.summary.baseName, '底本甲');
  assert.equal(result.summary.referenceName, '参校乙');
  assert.equal(result.summary.createdCount, 2);
  assert.equal(result.summary.differenceCount, 1);
});

// 2. 同名同正文：复用，不算冲突
test('本地存在同名同正文版本时判定为复用', () => {
  const local = [makeVersion('local-id', '底本甲', textA), makeVersion('v-b', '参校乙', textB)];
  const result = inspectWorkPackage(JSON.stringify(makePackage()), local);
  assert.equal(result.ok, true);
  assert.equal(result.summary.reusedCount, 2);
  assert.equal(result.summary.createdCount, 0);
});

// 3. 同名版本正文不同：逐项说明、拒绝恢复、原工作区不动
test('同名版本正文不同：报告具体差异位置并阻止恢复', () => {
  const local = [makeVersion('v-a', '底本甲', '道可道，非常道也。名可名，非常名。')];
  const result = inspectWorkPackage(JSON.stringify(makePackage()), local);
  assert.equal(result.ok, false);
  assert.equal(result.plan, undefined);
  const issue = result.issues.find((i) => i.code === 'version-text-mismatch');
  assert.ok(issue, '应包含 version-text-mismatch 项');
  assert.match(issue!.message, /底本甲/);
  assert.match(issue!.message, /第 \d+ 字/);
});

// 4. 底本缺失：leftVersionId 指向包内不存在的版本
test('底本缺失：报告底本名称并阻止恢复', () => {
  const pack = makePackage({ leftVersionId: 'v-missing' });
  const result = inspectWorkPackage(JSON.stringify(pack), []);
  assert.equal(result.ok, false);
  const issue = result.issues.find((i) => i.code === 'base-missing');
  assert.ok(issue);
  assert.match(issue!.message, /v-missing/);
});

// 5. 对齐行引用的句段不在包内版本中
test('对齐行引用丢失：指出哪一行哪个句段对不上', () => {
  const pack = makePackage();
  pack.rows[0].left = { ...pack.rows[0].left!, id: 'ghost-unit' };
  const result = inspectWorkPackage(JSON.stringify(pack), []);
  assert.equal(result.ok, false);
  const issue = result.issues.find((i) => i.code === 'row-unit-missing');
  assert.ok(issue);
  assert.match(issue!.message, /第 1 行/);
  assert.match(issue!.message, /ghost-unit/);
});

// 6. 非法 JSON 与未知格式
test('非法 JSON 与无法识别格式均被拦截且不产生计划', () => {
  const r1 = inspectWorkPackage('{不是json', []);
  assert.equal(r1.ok, false);
  assert.equal(r1.issues[0].code, 'invalid-json');
  const r2 = inspectWorkPackage(JSON.stringify({ hello: 'world' }), []);
  assert.equal(r2.ok, false);
  assert.equal(r2.issues[0].code, 'unknown-format');
});

// 7. id 冲突：同 id 不同名
test('版本 id 相同但名称不同：报告冲突', () => {
  const local = [makeVersion('v-a', '另一个底本', textA)];
  const result = inspectWorkPackage(JSON.stringify(makePackage()), local);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((i) => i.code === 'version-id-collision'));
});

// 8. 缺失规则/句段数据：警告但可恢复
test('缺少规则与句段数据时给警告但仍生成计划', () => {
  const va = makeVersion('v-a', '底本甲', textA);
  const vb = makeVersion('v-b', '参校乙', textB);
  (va as { units?: unknown }).units = undefined;
  const pack: WorkPackage = {
    ...makePackage({ versions: [va, vb] }),
    rules: undefined as unknown as WorkPackage['rules']
  };
  const result = inspectWorkPackage(JSON.stringify(pack), []);
  assert.equal(result.ok, true);
  assert.ok(result.issues.some((i) => i.code === 'missing-units'));
  assert.ok(result.issues.some((i) => i.code === 'rules-missing'));
  const restored = result.plan!.versions.find((v) => v.id === 'v-a')!;
  assert.equal(restored.units.length, makeVersion('v-a', '底本甲', textA).units.length);
});

// 9. 旧版 JSON 校勘数据兼容
test('旧版 JSON 校勘数据（left/right/rows）可识别并恢复', () => {
  const va = makeVersion('v-a', '底本甲', textA);
  const vb = makeVersion('v-b', '参校乙', textB);
  const legacy = JSON.stringify({
    left: va,
    right: vb,
    rules: { ignorePunctuation: false, ignoreVariants: false, candidateWindow: 3 },
    rows: [
      { id: 'x1', left: va.units[0], right: vb.units[0], status: 'changed', similarity: 0.5, note: '', source: '', accepted: false, manuallyAdjusted: false }
    ],
    exportedAt: '2026-09-27T00:00:00.000Z'
  });
  const result = inspectWorkPackage(legacy, []);
  assert.equal(result.ok, true);
  assert.ok(result.issues.some((i) => i.code === 'legacy-format'));
  assert.equal(result.plan!.leftVersionId, 'v-a');
  assert.equal(result.plan!.rightVersionId, 'v-b');
});

// 10. CRLF 差异不应误报"同名版本正文不同"
test('换行符差异（CRLF）不触发正文不一致', () => {
  const local = [makeVersion('v-a', '底本甲', textA.replace(/\n/g, '\r\n')), makeVersion('v-b', '参校乙', textB)];
  const result = inspectWorkPackage(JSON.stringify(makePackage()), local);
  assert.equal(result.ok, true);
  assert.equal(result.summary.reusedCount, 2);
});

console.log(`\n${passed} 项测试全部通过`);
