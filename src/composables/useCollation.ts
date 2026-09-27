import { computed, onMounted, ref, watch } from 'vue';
import { sampleVersions, splitIntoUnits } from '../data';
import type {
  AlignmentRow,
  ComparisonRules,
  DifferenceStatus,
  PersistedCollationState,
  TextUnit,
  VersionDocument,
  WorkPackage,
  WorkPackageInspection,
  WorkPackageIssue,
  WorkPackageRestorePlan
} from '../types';

const STORAGE_KEY = 'sologsb-1023/multi-version-collation/v1';

const variantMap: Record<string, string> = {
  為: '为',
  爲: '为',
  識: '识',
  強: '强',
  與: '与',
  猶: '犹',
  鄰: '邻',
  儼: '俨',
  渙: '涣',
  將: '将',
  樸: '朴',
  曠: '旷',
  濁: '浊',
  靜: '静',
  動: '动',
  玅: '妙',
  裏: '里',
  裡: '里',
  說: '说',
  國: '国'
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

function yieldToBrowser() {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function normalized(value: string, rules: ComparisonRules) {
  let result = value.toLocaleLowerCase().trim();
  if (rules.ignoreVariants) {
    result = Array.from(result, (character) => variantMap[character] ?? character).join('');
  }
  if (rules.ignorePunctuation) {
    result = result.replace(/[\s，。！？；：、“”‘’「」『』（）()《》〈〉·,.!?;:'"[\]{}<>—\-…]/g, '');
  }
  return result;
}

function similarity(left: string, right: string) {
  const a = Array.from(left);
  const b = Array.from(right);
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const previous = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const old = previous[j];
      previous[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(previous[j], previous[j - 1]);
      diagonal = old;
    }
  }
  return previous[b.length] / Math.max(a.length, b.length);
}

function statusFor(left: TextUnit | undefined, right: TextUnit | undefined, ratio: number): DifferenceStatus {
  if (!left) return 'added';
  if (!right) return 'removed';
  if (ratio > 0.995) return 'same';
  if (ratio >= 0.38) return 'changed';
  return 'misaligned';
}

async function alignUnits(
  leftUnits: TextUnit[],
  rightUnits: TextUnit[],
  rules: ComparisonRules,
  onProgress: (value: number) => void
): Promise<AlignmentRow[]> {
  const rows: AlignmentRow[] = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < leftUnits.length || rightIndex < rightUnits.length) {
    const left = leftUnits[leftIndex];
    const right = rightUnits[rightIndex];

    if (!left) {
      rows.push(makeRow(undefined, right, rules, '自动补齐右侧新增内容'));
      rightIndex += 1;
    } else if (!right) {
      rows.push(makeRow(left, undefined, rules, '自动标记左侧缺失内容'));
      leftIndex += 1;
    } else {
      const sameParagraph =
        left.paragraphOrder === right.paragraphOrder || Math.abs(left.paragraphOrder - right.paragraphOrder) <= 1;
      const ratio = similarity(normalized(left.text, rules), normalized(right.text, rules));
      const nextLeftRatio =
        leftUnits[leftIndex + 1] && right
          ? similarity(normalized(leftUnits[leftIndex + 1].text, rules), normalized(right.text, rules))
          : 0;
      const nextRightRatio =
        rightUnits[rightIndex + 1] && left
          ? similarity(normalized(left.text, rules), normalized(rightUnits[rightIndex + 1].text, rules))
          : 0;

      if (sameParagraph && (ratio >= 0.28 || (nextLeftRatio < 0.58 && nextRightRatio < 0.58))) {
        const score = Number(ratio.toFixed(3));
        rows.push({
          id: `row-${rows.length + 1}-${left.id}-${right.id}`,
          left,
          right,
          status: statusFor(left, right, score),
          similarity: score,
          note: '',
          source: '',
          accepted: score > 0.995,
          manuallyAdjusted: false
        });
        leftIndex += 1;
        rightIndex += 1;
      } else if (nextRightRatio > ratio && nextRightRatio > nextLeftRatio) {
        rows.push(makeRow(undefined, right, rules, '右侧有段落或句子插入'));
        rightIndex += 1;
      } else {
        rows.push(makeRow(left, undefined, rules, '左侧有段落或句子缺失'));
        leftIndex += 1;
      }
    }

    if (rows.length % 24 === 0) {
      onProgress(Math.round(((leftIndex + rightIndex) / Math.max(1, leftUnits.length + rightUnits.length)) * 100));
      await yieldToBrowser();
    }
  }
  onProgress(100);
  return rows;
}

function makeRow(
  left: TextUnit | undefined,
  right: TextUnit | undefined,
  rules: ComparisonRules,
  source: string
): AlignmentRow {
  const score = left && right ? Number(similarity(normalized(left.text, rules), normalized(right.text, rules)).toFixed(3)) : 0;
  return {
    id: `row-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    left,
    right,
    status: statusFor(left, right, score),
    similarity: score,
    note: '',
    source,
    accepted: score > 0.995,
    manuallyAdjusted: false
  };
}

function defaultRules(): ComparisonRules {
  return { ignorePunctuation: true, ignoreVariants: true, candidateWindow: 3 };
}

const WORKPACKAGE_KIND = 'collation-workpackage';
const validStatuses: DifferenceStatus[] = ['same', 'changed', 'added', 'removed', 'misaligned'];

/** 工作包比对时消除换行差异，避免 \r\n / \n 造成"同名版本正文不同"的误报 */
function canonicalText(value: unknown): string {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstDifference(expected: string, actual: string) {
  const a = Array.from(expected);
  const b = Array.from(actual);
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  const clip = (chars: string[], at: number) => chars.slice(Math.max(0, at - 8), at + 8).join('');
  return {
    index,
    expectedSnippet: clip(a, index) || '（结尾）',
    actualSnippet: clip(b, index) || '（结尾）'
  };
}

/**
 * 校验粘贴进来的工作包并生成恢复计划（纯函数，不改动任何当前状态）。
 * 错误项会阻止恢复；警告项可恢复。计划中的版本直接采用工作包自带正文，
 * 本地仅用于检测同名版本正文不一致等冲突。
 */
export function inspectWorkPackage(raw: string, localVersions: VersionDocument[]): WorkPackageInspection {
  const issues: WorkPackageIssue[] = [];
  const error = (code: string, message: string) => issues.push({ level: 'error', code, message });
  const warning = (code: string, message: string) => issues.push({ level: 'warning', code, message });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      issues: [{ level: 'error', code: 'invalid-json', message: `内容不是合法 JSON：${(err as Error).message}` }],
      summary: { versionCount: 0, rowCount: 0, differenceCount: 0, baseName: '', referenceName: '', reusedCount: 0, createdCount: 0 }
    };
  }
  if (!isRecord(parsed)) {
    return {
      ok: false,
      issues: [{ level: 'error', code: 'invalid-shape', message: '工作包结构不正确：顶层应为对象' }],
      summary: { versionCount: 0, rowCount: 0, differenceCount: 0, baseName: '', referenceName: '', reusedCount: 0, createdCount: 0 }
    };
  }

  // 兼容旧版"JSON 校勘数据"导出
  if (parsed.kind !== WORKPACKAGE_KIND) {
    if (isRecord(parsed.left) && isRecord(parsed.right) && Array.isArray(parsed.rows)) {
      warning('legacy-format', '这是旧版 JSON 校勘数据，仅含底本与参校本两个版本，仍可恢复。');
      const left = parsed.left as unknown as VersionDocument;
      const right = parsed.right as unknown as VersionDocument;
      const versions: VersionDocument[] = [left, right];
      if (!parsed.leftVersionId && !parsed.rightVersionId) {
        parsed.leftVersionId = left.id;
        parsed.rightVersionId = right.id;
      }
      parsed.versions = versions;
      parsed.kind = WORKPACKAGE_KIND;
    } else {
      error('unknown-format', '无法识别：缺少工作包标记（collation-workpackage），也不是旧版校勘数据。');
      return {
        ok: false,
        issues,
        summary: { versionCount: 0, rowCount: 0, differenceCount: 0, baseName: '', referenceName: '', reusedCount: 0, createdCount: 0 }
      };
    }
  }

  // ---- 版本清单 ----
  if (!Array.isArray(parsed.versions) || !parsed.versions.length) {
    error('missing-versions', '工作包缺少版本正文清单（versions 为空）。');
    return {
      ok: false,
      issues,
      summary: { versionCount: 0, rowCount: 0, differenceCount: 0, baseName: '', referenceName: '', reusedCount: 0, createdCount: 0 }
    };
  }

  const packageVersions: VersionDocument[] = [];
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  parsed.versions.forEach((entry, index) => {
    const label = `第 ${index + 1} 个版本`;
    if (!isRecord(entry)) {
      error('bad-version', `${label}结构不正确。`);
      return;
    }
    if (typeof entry.id !== 'string' || !entry.id) {
      error('bad-version-id', `${label}缺少版本标识 id。`);
      return;
    }
    if (seenIds.has(entry.id)) {
      error('duplicate-version-id', `版本标识「${entry.id}」在包内重复，无法可靠恢复对齐引用。`);
    }
    seenIds.add(entry.id);
    if (typeof entry.name !== 'string' || !entry.name.trim()) {
      error('bad-version-name', `${label}（id：${entry.id}）缺少版本名称。`);
    } else if (seenNames.has(entry.name)) {
      error('duplicate-version-name', `版本名称「${entry.name}」在包内重复，无法按名称与本地工作区核对。`);
    } else {
      seenNames.add(entry.name);
    }
    const text = typeof entry.text === 'string' ? entry.text : '';
    if (!text.trim()) {
      error('bad-version-text', `版本「${String(entry.name ?? entry.id)}」缺少正文文本，工作包无法用于重新粘贴恢复。`);
      return;
    }
    let units: TextUnit[];
    if (Array.isArray(entry.units) && entry.units.length) {
      const wellFormed = entry.units.every(
        (unit) =>
          isRecord(unit) &&
          typeof unit.id === 'string' &&
          typeof unit.text === 'string'
      );
      if (!wellFormed) {
        warning('bad-units', `版本「${String(entry.name)}」的句段数据不完整，已按正文重新分段。`);
        units = splitIntoUnits(text, entry.id);
      } else {
        units = entry.units as unknown as TextUnit[];
      }
    } else {
      warning('missing-units', `版本「${String(entry.name)}」缺少句段数据，已按正文重新分段。`);
      units = splitIntoUnits(text, entry.id);
    }
    packageVersions.push({
      id: entry.id,
      name: typeof entry.name === 'string' ? entry.name : entry.id,
      source: typeof entry.source === 'string' ? entry.source : '',
      text,
      units,
      createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString()
    });
  });

  const byId = new Map(packageVersions.map((item) => [item.id, item]));
  const byName = new Map(packageVersions.map((item) => [item.name, item]));

  // ---- 底本 / 参校组合 ----
  const leftId = typeof parsed.leftVersionId === 'string' ? parsed.leftVersionId : '';
  const rightId = typeof parsed.rightVersionId === 'string' ? parsed.rightVersionId : '';
  if (!leftId) error('missing-base-id', '工作包未记录当前底本（leftVersionId 为空）。');
  else if (!byId.has(leftId)) error('base-missing', `底本缺失：工作包指定的底本「${leftId}」不在版本正文清单中。`);
  if (!rightId) warning('missing-reference-id', '工作包未记录参校本（rightVersionId 为空），恢复后可手动选择。');
  else if (!byId.has(rightId)) error('reference-missing', `参校本缺失：指定的参校本「${rightId}」不在版本正文清单中。`);

  // ---- 比较规则 ----
  let rules: ComparisonRules = defaultRules();
  if (isRecord(parsed.rules)) {
    rules = {
      ignorePunctuation: typeof parsed.rules.ignorePunctuation === 'boolean' ? parsed.rules.ignorePunctuation : true,
      ignoreVariants: typeof parsed.rules.ignoreVariants === 'boolean' ? parsed.rules.ignoreVariants : true,
      candidateWindow: typeof parsed.rules.candidateWindow === 'number' ? parsed.rules.candidateWindow : 3
    };
    if (typeof parsed.rules.ignorePunctuation !== 'boolean' || typeof parsed.rules.ignoreVariants !== 'boolean') {
      warning('rules-partial', '比较规则字段不完整，已用默认规则补齐。');
    }
  } else {
    warning('rules-missing', '工作包缺少比较规则，已使用默认规则（忽略标点、忽略异体字）。');
  }

  // ---- 对齐行 ----
  const unitOwners = new Map<string, string>();
  packageVersions.forEach((version) => {
    version.units.forEach((unit) => unitOwners.set(unit.id, version.id));
  });

  const rows: AlignmentRow[] = [];
  if (!Array.isArray(parsed.rows)) {
    error('missing-rows', '工作包缺少对齐行数据（rows 不是数组）。');
  } else if (!parsed.rows.length) {
    warning('empty-rows', '工作包中的对齐行为空，恢复后需要重新执行自动对齐。');
  } else {
    const rowIds = new Set<string>();
    let regeneratedRows = 0;
    let sideMismatch = false;
    parsed.rows.forEach((entry, index) => {
      const label = `第 ${index + 1} 行`;
      if (!isRecord(entry)) {
        error('bad-row', `${label}结构不正确。`);
        return;
      }
      const status = entry.status as DifferenceStatus;
      if (!validStatuses.includes(status)) {
        error('bad-row-status', `${label}的状态「${String(entry.status)}」无法识别。`);
      }
      const checkSide = (side: 'left' | 'right') => {
        const unit = entry[side];
        if (unit == null) return undefined;
        if (!isRecord(unit) || typeof unit.id !== 'string') {
          error('bad-row-unit', `${label}的${side === 'left' ? '底本' : '参校本'}句段结构不正确。`);
          return undefined;
        }
        const owner = unitOwners.get(unit.id);
        if (!owner) {
          error(
            'row-unit-missing',
            `${label}引用的${side === 'left' ? '底本' : '参校本'}句段「${unit.id}」在工作包版本正文中找不到，对齐关系无法恢复。`
          );
        } else if (side === 'left' && leftId && owner !== leftId) {
          sideMismatch = true;
        } else if (side === 'right' && rightId && owner !== rightId) {
          sideMismatch = true;
        }
        return unit as unknown as TextUnit;
      };
      const left = checkSide('left');
      const right = checkSide('right');
      if (!left && !right) error('empty-row', `${label}底本与参校本两侧都为空，无法构成对齐行。`);

      let id = typeof entry.id === 'string' && entry.id ? entry.id : '';
      if (!id) {
        id = `restored-row-${Date.now().toString(36)}-${index}`;
        regeneratedRows += 1;
      } else if (rowIds.has(id)) {
        error('duplicate-row-id', `对齐行标识「${id}」在包内重复。`);
      }
      rowIds.add(id);

      rows.push({
        id,
        left,
        right,
        status: validStatuses.includes(status) ? status : 'misaligned',
        similarity: typeof entry.similarity === 'number' ? entry.similarity : 0,
        note: typeof entry.note === 'string' ? entry.note : '',
        source: typeof entry.source === 'string' ? entry.source : '',
        accepted: Boolean(entry.accepted),
        manuallyAdjusted: Boolean(entry.manuallyAdjusted)
      });
    });
    if (regeneratedRows) warning('row-id-regenerated', `有 ${regeneratedRows} 条对齐行缺少标识，已重新生成。`);
    if (sideMismatch) warning('row-side-mismatch', '部分对齐行引用的句段不属于当前底本/参校组合，请逐行核对配对关系。');
  }

  // ---- 与本地工作区核对：同名版本正文不同、id 冲突 ----
  const localByName = new Map(localVersions.map((item) => [item.name, item]));
  const localById = new Map(localVersions.map((item) => [item.id, item]));
  packageVersions.forEach((candidate) => {
    const sameName = localByName.get(candidate.name);
    if (sameName && canonicalText(sameName.text) !== canonicalText(candidate.text)) {
      const diff = firstDifference(canonicalText(sameName.text), canonicalText(candidate.text));
      error(
        'version-text-mismatch',
        `同名版本正文不同：「${candidate.name}」在第 ${diff.index + 1} 字处对不上。` +
          `本地为「…${diff.expectedSnippet}…」，工作包为「…${diff.actualSnippet}…」。`
      );
    }
    const sameId = localById.get(candidate.id);
    if (sameId && sameId.name !== candidate.name) {
      error(
        'version-id-collision',
        `版本标识冲突：本地「${sameId.name}」与工作包「${candidate.name}」共用 id ${candidate.id}，恢复会串用正文。`
      );
    }
  });

  const baseName = byId.get(leftId)?.name ?? '';
  const referenceName = byId.get(rightId)?.name ?? '';
  const reusableIds = new Set(
    packageVersions.filter((candidate) => localByName.has(candidate.name)).map((item) => item.id)
  );

  const summary = {
    versionCount: packageVersions.length,
    rowCount: rows.length,
    differenceCount: rows.filter((row) => row.status !== 'same').length,
    baseName,
    referenceName,
    reusedCount: reusableIds.size,
    createdCount: packageVersions.length - reusableIds.size
  };

  const hasError = issues.some((issue) => issue.level === 'error');
  let plan: WorkPackageRestorePlan | undefined;
  if (!hasError) {
    let selectedRowId = typeof parsed.selectedRowId === 'string' ? parsed.selectedRowId : '';
    if (selectedRowId && !rows.some((row) => row.id === selectedRowId)) {
      warning('selection-lost', '工作包记录的当前行已不存在，恢复后定位到第一处差异。');
      selectedRowId = '';
    }
    plan = {
      versions: clone(packageVersions),
      leftVersionId: leftId,
      rightVersionId: rightId,
      rules,
      rows: clone(rows),
      selectedRowId: selectedRowId || rows.find((row) => row.status !== 'same')?.id || rows[0]?.id || '',
      reusedVersionIds: packageVersions.filter((item) => reusableIds.has(item.id)).map((item) => item.id),
      createdVersionIds: packageVersions.filter((item) => !reusableIds.has(item.id)).map((item) => item.id)
    };
  }

  return { ok: !hasError, issues, summary, plan };
}

export function useCollation() {
  const versions = ref<VersionDocument[]>(clone(sampleVersions));
  const leftVersionId = ref(versions.value[0].id);
  const rightVersionId = ref(versions.value[1].id);
  const rows = ref<AlignmentRow[]>([]);
  const rules = ref<ComparisonRules>(defaultRules());
  const selectedRowId = ref('');
  const selectedRowIds = ref<(string | number)[]>([]);
  const processing = ref(false);
  const progress = ref(0);
  const message = ref('正在载入本地校勘数据…');
  const history = ref<string[]>([]);
  const future = ref<string[]>([]);
  const canUndo = computed(() => history.value.length > 0);
  const canRedo = computed(() => future.value.length > 0);
  const leftVersion = computed(() => versions.value.find((item) => item.id === leftVersionId.value));
  const rightVersion = computed(() => versions.value.find((item) => item.id === rightVersionId.value));
  const selectedRow = computed(() => rows.value.find((item) => item.id === selectedRowId.value));
  const differenceCount = computed(() => rows.value.filter((row) => row.status !== 'same').length);
  const acceptedCount = computed(() => rows.value.filter((row) => row.accepted).length);
  const unresolvedCount = computed(() => rows.value.filter((row) => !row.accepted && row.status !== 'same').length);

  function snapshot(): string {
    const data: PersistedCollationState = {
      versions: versions.value,
      leftVersionId: leftVersionId.value,
      rightVersionId: rightVersionId.value,
      rows: rows.value,
      rules: rules.value,
      selectedRowId: selectedRowId.value
    };
    return JSON.stringify(data);
  }

  function persist() {
    localStorage.setItem(STORAGE_KEY, snapshot());
  }

  function commit(label: string, mutate: () => void) {
    history.value.push(snapshot());
    if (history.value.length > 50) history.value.shift();
    future.value = [];
    mutate();
    message.value = label;
    persist();
  }

  function restore(raw: string) {
    const parsed = JSON.parse(raw) as PersistedCollationState;
    versions.value = parsed.versions;
    leftVersionId.value = parsed.leftVersionId;
    rightVersionId.value = parsed.rightVersionId;
    rows.value = parsed.rows;
    rules.value = parsed.rules;
    selectedRowId.value = parsed.selectedRowId;
    persist();
  }

  function undo() {
    const previous = history.value.pop();
    if (!previous) return;
    future.value.push(snapshot());
    restore(previous);
    message.value = '已撤销上一步操作';
  }

  function redo() {
    const next = future.value.pop();
    if (!next) return;
    history.value.push(snapshot());
    restore(next);
    message.value = '已重做上一步操作';
  }

  async function runAlignment(commitHistory = true) {
    if (!leftVersion.value || !rightVersion.value || processing.value) return;
    processing.value = true;
    progress.value = 0;
    message.value = '正在分片执行自动对齐…';
    const previous = commitHistory ? snapshot() : '';
    try {
      const result = await alignUnits(leftVersion.value.units, rightVersion.value.units, rules.value, (value) => {
        progress.value = value;
      });
      if (commitHistory) {
        history.value.push(previous);
        future.value = [];
      }
      rows.value = result;
      selectedRowId.value = result.find((row) => row.status !== 'same')?.id ?? result[0]?.id ?? '';
      selectedRowIds.value = [];
      message.value = `自动对齐完成：${result.filter((row) => row.status !== 'same').length} 处差异`;
      persist();
    } finally {
      processing.value = false;
    }
  }

  function recalculate() {
    commit('已按比较规则重算差异', () => {
      rows.value = rows.value.map((row) => {
        if (!row.left || !row.right) return row;
        const score = Number(
          similarity(normalized(row.left.text, rules.value), normalized(row.right.text, rules.value)).toFixed(3)
        );
        return { ...row, similarity: score, status: statusFor(row.left, row.right, score) };
      });
      selectedRowIds.value = [];
    });
  }

  function updateRow(id: string, patch: Partial<AlignmentRow>) {
    commit('已更新校勘行', () => {
      const row = rows.value.find((item) => item.id === id);
      if (row) Object.assign(row, patch, { manuallyAdjusted: true });
    });
  }

  function shiftPairing(id: string, direction: -1 | 1) {
    commit(direction < 0 ? '已向前调整错位' : '已向后调整错位', () => {
      const index = rows.value.findIndex((row) => row.id === id);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= rows.value.length) return;
      const current = rows.value[index];
      const target = rows.value[targetIndex];
      const currentLeft = current.left;
      current.left = target.left;
      target.left = currentLeft;
      for (const row of [current, target]) {
        if (row.left && row.right) {
          row.similarity = Number(
            similarity(normalized(row.left.text, rules.value), normalized(row.right.text, rules.value)).toFixed(3)
          );
          row.status = statusFor(row.left, row.right, row.similarity);
        } else {
          row.status = row.left ? 'removed' : 'added';
          row.similarity = 0;
        }
        row.manuallyAdjusted = true;
      }
    });
  }

  function moveRow(id: string, direction: -1 | 1) {
    commit('已移动校勘顺序', () => {
      const index = rows.value.findIndex((row) => row.id === id);
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= rows.value.length) return;
      const [row] = rows.value.splice(index, 1);
      rows.value.splice(targetIndex, 0, row);
      row.manuallyAdjusted = true;
    });
  }

  function acceptRows(ids: string[]) {
    if (!ids.length) return;
    commit(`已接受 ${ids.length} 条校对建议`, () => {
      const selected = new Set(ids);
      rows.value.forEach((row) => {
        if (selected.has(row.id)) row.accepted = true;
      });
      selectedRowIds.value = [];
    });
  }

  function acceptAll() {
    commit('已批量接受全部差异建议', () => {
      rows.value.forEach((row) => {
        row.accepted = true;
      });
      selectedRowIds.value = [];
    });
  }

  function nextDifference() {
    const start = rows.value.findIndex((row) => row.id === selectedRowId.value);
    for (let offset = 1; offset <= rows.value.length; offset += 1) {
      const index = (start + offset) % rows.value.length;
      const row = rows.value[index];
      if (row && row.status !== 'same' && !row.accepted) {
        selectedRowId.value = row.id;
        message.value = `已跳到第 ${index + 1} 条未接受差异`;
        persist();
        return;
      }
    }
    message.value = '没有更多未接受的差异';
  }

  function addVersion(name: string, source: string, text: string) {
    const id = `version-${Date.now().toString(36)}`;
    const item: VersionDocument = {
      id,
      name: name.trim() || `版本 ${versions.value.length + 1}`,
      source: source.trim() || '手工导入',
      text,
      units: splitIntoUnits(text, id),
      createdAt: new Date().toISOString()
    };
    commit(`已导入版本：${item.name}`, () => {
      versions.value.push(item);
    });
    rightVersionId.value = id;
    void runAlignment();
  }

  function exportMarkdown() {
    const changed = rows.value.filter((row) => row.status !== 'same' || row.note || row.source);
    const lines = [
      '# 校勘记',
      '',
      `- 底本：${leftVersion.value?.name ?? '未选择'}`,
      `- 参校本：${rightVersion.value?.name ?? '未选择'}`,
      `- 比较规则：${rules.value.ignorePunctuation ? '忽略标点；' : ''}${rules.value.ignoreVariants ? '忽略异体字；' : ''}保留正文。`,
      `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
      '',
      '| 序 | 类别 | 底本 | 参校本 | 校记 | 来源 | 状态 |',
      '|---|---|---|---|---|---|---|'
    ];
    changed.forEach((row, index) => {
      const cell = (value?: string) => (value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
      lines.push(
        `| ${index + 1} | ${statusLabel(row.status)} | ${cell(row.left?.text)} | ${cell(row.right?.text)} | ${cell(row.note)} | ${cell(row.source)} | ${row.accepted ? '已接受' : '待处理'} |`
      );
    });
    lines.push('', `共 ${changed.length} 条校勘记录。`);
    return lines.join('\n');
  }

  function exportJson() {
    return JSON.stringify(
      {
        left: leftVersion.value,
        right: rightVersion.value,
        rules: rules.value,
        rows: rows.value,
        exportedAt: new Date().toISOString()
      },
      null,
      2
    );
  }

  /** 生成可粘贴恢复的工作包：版本正文 + 底本参校组合 + 比较规则 + 全部对齐行 */
  function exportWorkPackage() {
    const pack: WorkPackage = {
      kind: 'collation-workpackage',
      appVersion: 1,
      exportedAt: new Date().toISOString(),
      versions: clone(versions.value),
      leftVersionId: leftVersionId.value,
      rightVersionId: rightVersionId.value,
      rules: clone(rules.value),
      rows: clone(rows.value),
      selectedRowId: selectedRowId.value
    };
    return JSON.stringify(pack, null, 2);
  }

  /** 仅校验并生成恢复计划，不触碰当前工作区 */
  function inspectPackage(raw: string): WorkPackageInspection {
    return inspectWorkPackage(raw, versions.value);
  }

  /** 校验通过后整体恢复；恢复动作进入撤销历史，可随时撤回原工作区 */
  function restoreFromPackage(plan: WorkPackageRestorePlan) {
    commit(
      `已从工作包恢复：${plan.versions.length} 个版本、${plan.rows.length} 条对齐行（可撤销）`,
      () => {
        versions.value = clone(plan.versions);
        leftVersionId.value = plan.leftVersionId;
        rightVersionId.value = plan.rightVersionId;
        rules.value = clone(plan.rules);
        rows.value = clone(plan.rows);
        selectedRowId.value = plan.selectedRowId;
        selectedRowIds.value = [];
      }
    );
  }

  onMounted(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        restore(raw);
        message.value = '已恢复浏览器中的校勘草稿';
      } else {
        message.value = '已载入示例版本，正在自动对齐…';
        void runAlignment(false);
      }
    } catch {
      message.value = '本地草稿读取失败，已载入示例数据';
      void runAlignment(false);
    }
  });

  watch(
    [leftVersionId, rightVersionId, () => rules.value.ignorePunctuation, () => rules.value.ignoreVariants],
    () => {
      if (!processing.value) persist();
    }
  );

  return {
    versions,
    leftVersionId,
    rightVersionId,
    rows,
    rules,
    selectedRowId,
    selectedRowIds,
    processing,
    progress,
    message,
    history,
    future,
    canUndo,
    canRedo,
    leftVersion,
    rightVersion,
    selectedRow,
    differenceCount,
    acceptedCount,
    unresolvedCount,
    runAlignment,
    recalculate,
    updateRow,
    shiftPairing,
    moveRow,
    acceptRows,
    acceptAll,
    nextDifference,
    addVersion,
    undo,
    redo,
    exportMarkdown,
    exportJson,
    exportWorkPackage,
    inspectPackage,
    restoreFromPackage,
    commit
  };
}

export function statusLabel(status: DifferenceStatus) {
  return {
    same: '相同',
    changed: '改动',
    added: '右侧新增',
    removed: '左侧删减',
    misaligned: '疑错位'
  }[status];
}
