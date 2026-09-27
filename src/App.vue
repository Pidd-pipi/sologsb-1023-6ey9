<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Message } from '@arco-design/web-vue';
import { statusLabel, useCollation } from './composables/useCollation';
import type { AlignmentRow, DifferenceStatus, WorkPackageInspection } from './types';

const {
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
  canUndo,
  canRedo,
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
} = useCollation();

const importVisible = ref(false);
const onlyDifferences = ref(false);
const rowQuery = ref('');
const noteDraft = ref('');
const sourceDraft = ref('');
const importForm = ref({ name: '', source: '', text: '' });
const fileInput = ref<HTMLInputElement | null>(null);

const packageVisible = ref(false);
const packageTab = ref<'export' | 'import'>('export');
const packageExportText = ref('');
const packageImportText = ref('');
const packageInspection = ref<WorkPackageInspection | null>(null);
const packageFileInput = ref<HTMLInputElement | null>(null);
let packageInspectTimer: number | undefined;

const columns = [
  { title: '状态', dataIndex: 'status', slotName: 'status', width: 122, fixed: 'left' as const },
  { title: '底本', dataIndex: 'left', slotName: 'left', width: 330 },
  { title: '对准操作', dataIndex: 'align', slotName: 'align', width: 112, align: 'center' as const },
  { title: '参校本', dataIndex: 'right', slotName: 'right', width: 330 },
  { title: '校记 / 来源', dataIndex: 'note', slotName: 'note', width: 240 }
];

const filteredRows = computed(() => {
  const query = rowQuery.value.trim().toLocaleLowerCase();
  return rows.value.filter((row) => {
    if (onlyDifferences.value && row.status === 'same') return false;
    if (!query) return true;
    return [row.left?.text, row.right?.text, row.note, row.source, statusLabel(row.status)]
      .filter(Boolean)
      .some((value) => value!.toLocaleLowerCase().includes(query));
  });
});

const rowSelection = computed(() => ({
  type: 'checkbox' as const,
  showCheckedAll: true,
  selectedRowKeys: selectedRowIds.value,
  onlyCurrent: false
}));

watch(
  selectedRow,
  (row) => {
    noteDraft.value = row?.note ?? '';
    sourceDraft.value = row?.source ?? '';
  },
  { immediate: true }
);

function statusColor(status: DifferenceStatus) {
  return {
    same: 'gray',
    changed: 'orange',
    added: 'green',
    removed: 'red',
    misaligned: 'arcoblue'
  }[status] as 'gray' | 'orange' | 'green' | 'red' | 'arcoblue';
}

function rowClass(record: AlignmentRow) {
  return record.id === selectedRowId.value ? 'row-active' : '';
}

function onSelectionChange(keys: (string | number)[]) {
  selectedRowIds.value = keys;
}

function updateStatus(status: unknown) {
  if (!selectedRow.value) return;
  updateRow(selectedRow.value.id, { status: String(status) as DifferenceStatus });
}

function onRowClick(record: Record<string, unknown>) {
  const row = record as unknown as AlignmentRow;
  selectedRowId.value = row.id;
}

function saveAnnotation() {
  if (!selectedRow.value) return;
  updateRow(selectedRow.value.id, {
    note: noteDraft.value.trim(),
    source: sourceDraft.value.trim()
  });
  Message.success('校勘说明已保存');
}

function download(filename: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function handleExport(kind: 'markdown' | 'json') {
  if (kind === 'markdown') {
    download('校勘记.md', exportMarkdown(), 'text/markdown;charset=utf-8');
  } else {
    download('校勘数据.json', exportJson(), 'application/json;charset=utf-8');
  }
}

function openImport() {
  importForm.value = { name: `导入版本 ${versions.value.length + 1}`, source: '', text: '' };
  importVisible.value = true;
}

function confirmImport() {
  if (!importForm.value.text.trim()) {
    Message.warning('请粘贴版本正文或选择文本文件');
    return;
  }
  addVersion(importForm.value.name, importForm.value.source, importForm.value.text.trim());
  importVisible.value = false;
}

function handleFile(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;
  file.text().then((text) => {
    importForm.value.text = text;
    if (!importForm.value.name || importForm.value.name.startsWith('导入版本')) {
      importForm.value.name = file.name.replace(/\.[^.]+$/, '');
    }
  });
}

const packageErrors = computed(() => packageInspection.value?.issues.filter((issue) => issue.level === 'error') ?? []);
const packageWarnings = computed(() => packageInspection.value?.issues.filter((issue) => issue.level === 'warning') ?? []);

function openPackage(tab: 'export' | 'import' = 'export') {
  packageTab.value = tab;
  packageVisible.value = true;
  if (tab === 'export') packageExportText.value = exportWorkPackage();
  if (tab === 'import' && !packageImportText.value) packageInspection.value = null;
}

function switchPackageTab(key: string | number) {
  if (key === 'export') packageExportText.value = exportWorkPackage();
}

async function copyPackage() {
  try {
    await navigator.clipboard.writeText(packageExportText.value);
    Message.success('工作包已复制，可直接粘贴');
  } catch {
    Message.warning('浏览器拒绝了剪贴板访问，请手动全选复制');
  }
}

function downloadPackage() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  download(`校勘工作包-${stamp}.json`, packageExportText.value, 'application/json;charset=utf-8');
}

function scheduleInspection() {
  window.clearTimeout(packageInspectTimer);
  if (!packageImportText.value.trim()) {
    packageInspection.value = null;
    return;
  }
  packageInspectTimer = window.setTimeout(() => {
    packageInspection.value = inspectPackage(packageImportText.value);
  }, 250);
}

function handlePackageFile(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;
  file.text().then((text) => {
    packageImportText.value = text;
    packageInspection.value = inspectPackage(text);
    Message.success(`已读入文件：${file.name}`);
  });
}

function confirmRestore() {
  const inspection = inspectPackage(packageImportText.value);
  packageInspection.value = inspection;
  if (!inspection.ok || !inspection.plan) {
    Message.error(`校验未通过（${inspection.issues.filter((issue) => issue.level === 'error').length} 项对不上），原工作区保持不变`);
    return;
  }
  restoreFromPackage(inspection.plan);
  const { summary } = inspection;
  packageVisible.value = false;
  Message.success(
    `工作区已恢复：底本「${summary.baseName}」对参校「${summary.referenceName}」，` +
      `${summary.rowCount} 条对齐行；如不满意可点撤销回到原工作区`
  );
}

function handleKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null;
  const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    event.shiftKey ? redo() : undo();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
    event.preventDefault();
    redo();
    return;
  }
  if (typing) return;
  if (event.altKey && event.key === 'ArrowDown') {
    event.preventDefault();
    nextDifference();
  } else if (event.key.toLowerCase() === 'a' && selectedRowIds.value.length) {
    acceptRows(selectedRowIds.value.map(String));
  }
}

window.addEventListener('keydown', handleKeydown);

const beforeUnload = (event: BeforeUnloadEvent) => {
  if (unresolvedCount.value > 0) {
    event.preventDefault();
    event.returnValue = '';
  }
};
window.addEventListener('beforeunload', beforeUnload);
</script>

<template>
  <a-layout class="workbench-shell">
    <a-layout-header class="topbar">
      <div style="display: flex; align-items: center; gap: 12px; width: 100%">
        <div class="brand-mark">校</div>
        <div>
          <h1 class="brand-title">校异斋 · 多版本校勘台</h1>
          <div class="brand-subtitle">自动对齐、人工修正、校记导出，全程本地保存</div>
        </div>
        <a-space style="margin-left: auto" wrap>
          <a-button :disabled="!canUndo" @click="undo">撤销</a-button>
          <a-button :disabled="!canRedo" @click="redo">重做</a-button>
          <a-button type="primary" :loading="processing" @click="runAlignment()">重新自动对齐</a-button>
          <a-button @click="openImport">导入版本</a-button>
          <a-button type="outline" @click="openPackage('export')">工作包</a-button>
          <a-dropdown>
            <a-button>导出校勘记</a-button>
            <template #content>
              <a-doption @click="handleExport('markdown')">Markdown 校勘记</a-doption>
              <a-doption @click="handleExport('json')">JSON 校勘数据</a-doption>
            </template>
          </a-dropdown>
        </a-space>
      </div>
    </a-layout-header>

    <a-layout class="main-layout">
      <a-layout-sider class="left-panel" :width="282">
        <section class="panel-section">
          <h2 class="panel-title">比对版本</h2>
          <div style="display: grid; gap: 10px">
            <a-select v-model="leftVersionId" aria-label="底本">
              <template #prefix>底本</template>
              <a-option v-for="version in versions" :key="version.id" :value="version.id">{{ version.name }}</a-option>
            </a-select>
            <a-select v-model="rightVersionId" aria-label="参校本">
              <template #prefix>参校</template>
              <a-option v-for="version in versions" :key="version.id" :value="version.id">{{ version.name }}</a-option>
            </a-select>
            <a-button long type="outline" @click="runAlignment()">执行分片自动对齐</a-button>
          </div>
          <a-progress v-if="processing" :percent="progress" size="small" style="margin-top: 12px" />
          <div v-if="processing" style="margin-top: 6px; color: #86909c; font-size: 12px">
            正在让出主线程，长文本编辑不会一直卡住
          </div>
        </section>

        <section class="panel-section">
          <h2 class="panel-title">比较规则</h2>
          <a-space direction="vertical" fill>
            <a-checkbox v-model="rules.ignorePunctuation" @change="recalculate">忽略标点差异</a-checkbox>
            <a-checkbox v-model="rules.ignoreVariants" @change="recalculate">忽略常见异体字</a-checkbox>
          </a-space>
          <div style="margin-top: 10px; color: #86909c; font-size: 12px; line-height: 1.6">
            规则只影响相同/改动判断，原始正文始终保留；重算会进入撤销历史。
          </div>
        </section>

        <section class="panel-section">
          <h2 class="panel-title">处理进度</h2>
          <div class="stats-grid">
            <div class="stat-card">
              <div class="stat-number">{{ differenceCount }}</div>
              <div class="stat-label">全部差异</div>
            </div>
            <div class="stat-card">
              <div class="stat-number" style="color: #d25f00">{{ unresolvedCount }}</div>
              <div class="stat-label">待校勘</div>
            </div>
            <div class="stat-card">
              <div class="stat-number" style="color: #00875a">{{ acceptedCount }}</div>
              <div class="stat-label">已接受</div>
            </div>
            <div class="stat-card">
              <div class="stat-number">{{ rows.length }}</div>
              <div class="stat-label">对齐句段</div>
            </div>
          </div>
          <a-button long type="primary" status="success" style="margin-top: 12px" :disabled="!unresolvedCount" @click="acceptAll">
            批量接受全部建议
          </a-button>
          <a-button long style="margin-top: 8px" @click="nextDifference">跳到下一处未接受差异</a-button>
        </section>

        <section class="panel-section">
          <h2 class="panel-title">键盘辅助</h2>
          <div style="color: #4e5969; font-size: 12px; line-height: 2">
            <div><a-tag size="small">Alt ↓</a-tag> 下一处差异</div>
            <div><a-tag size="small">A</a-tag> 接受勾选建议</div>
            <div><a-tag size="small">Ctrl/⌘ Z</a-tag> 撤销</div>
            <div><a-tag size="small">Ctrl/⌘ Y</a-tag> 重做</div>
          </div>
        </section>
      </a-layout-sider>

      <a-layout-content class="center-panel">
        <a-card :bordered="false" style="margin-bottom: 12px">
          <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap">
            <a-input-search v-model="rowQuery" placeholder="搜索正文、校记或来源" allow-clear style="max-width: 360px" />
            <a-checkbox v-model="onlyDifferences">只看差异</a-checkbox>
            <a-tag color="arcoblue">{{ filteredRows.length }} / {{ rows.length }} 行</a-tag>
            <a-tag v-if="selectedRowIds.length" color="green">{{ selectedRowIds.length }} 行已勾选</a-tag>
            <a-button
              v-if="selectedRowIds.length"
              type="primary"
              status="success"
              size="small"
              style="margin-left: auto"
              @click="acceptRows(selectedRowIds.map(String))"
            >
              接受勾选建议
            </a-button>
          </div>
        </a-card>

        <a-card :bordered="false" :body-style="{ padding: 0 }">
          <a-alert :show-icon="processing" :type="unresolvedCount ? 'warning' : 'success'" style="border-radius: 0">
            {{ message }}<span v-if="unresolvedCount"> · {{ unresolvedCount }} 条差异尚未接受</span>
          </a-alert>
          <a-table
            class="virtual-table"
            row-key="id"
            :columns="columns"
            :data="filteredRows"
            :pagination="false"
            :row-selection="rowSelection"
            :row-class="rowClass"
            :scroll="{ x: 1160, y: 'calc(100vh - 260px)' }"
            :virtual-list-props="{ height: 590, threshold: 40 }"
            @selection-change="onSelectionChange"
            @row-click="onRowClick"
          >
            <template #status="{ record }">
              <a-tag :color="statusColor(record.status)">
                {{ statusLabel(record.status) }}
              </a-tag>
              <div style="margin-top: 6px; color: #86909c; font-size: 11px">
                相似度 {{ Math.round(record.similarity * 100) }}%
              </div>
              <div v-if="record.manuallyAdjusted" style="margin-top: 4px; color: #165dff; font-size: 11px">人工调整</div>
            </template>

            <template #left="{ record }">
              <div v-if="record.left">
                <div class="paragraph-label">段 {{ record.left.paragraphOrder }} · 句 {{ record.left.sentenceOrder }}</div>
                <div class="diff-text" :class="record.status === 'removed' ? 'removed' : record.status === 'changed' || record.status === 'misaligned' ? 'changed' : 'same'">
                  {{ record.left.text }}
                </div>
              </div>
              <div v-else style="padding: 20px 8px; color: #86909c; text-align: center">无对应底本句</div>
            </template>

            <template #align="{ record }">
              <a-space direction="vertical" size="mini">
                <a-button size="mini" @click.stop="shiftPairing(record.id, -1)">配对上移</a-button>
                <a-button size="mini" @click.stop="shiftPairing(record.id, 1)">配对下移</a-button>
                <a-button size="mini" @click.stop="moveRow(record.id, -1)">整行上移</a-button>
                <a-button size="mini" @click.stop="moveRow(record.id, 1)">整行下移</a-button>
                <a-tooltip content="接受这一行的自动判断">
                  <a-button size="mini" status="success" @click.stop="acceptRows([record.id])">接受</a-button>
                </a-tooltip>
              </a-space>
            </template>

            <template #right="{ record }">
              <div v-if="record.right">
                <div class="paragraph-label">段 {{ record.right.paragraphOrder }} · 句 {{ record.right.sentenceOrder }}</div>
                <div class="diff-text" :class="record.status === 'added' ? 'added' : record.status === 'changed' || record.status === 'misaligned' ? 'changed' : 'same'">
                  {{ record.right.text }}
                </div>
              </div>
              <div v-else style="padding: 20px 8px; color: #86909c; text-align: center">无对应参校本句</div>
            </template>

            <template #note="{ record }">
              <div style="font-size: 12px; line-height: 1.6; color: #4e5969">
                <div>{{ record.note || '尚未填写校勘说明' }}</div>
                <div v-if="record.source" style="margin-top: 5px; color: #86909c">来源：{{ record.source }}</div>
                <a-tag v-if="record.accepted" size="small" color="green" style="margin-top: 7px">已接受</a-tag>
                <a-tag v-else size="small" color="orange" style="margin-top: 7px">待处理</a-tag>
              </div>
            </template>

            <template #empty>
              <a-empty description="没有符合条件的对齐行" />
            </template>
          </a-table>
        </a-card>
      </a-layout-content>

      <a-layout-sider class="right-panel" :width="340">
        <section class="panel-section">
          <div style="display: flex; align-items: center">
            <h2 class="panel-title" style="margin: 0">校勘详情</h2>
            <a-tag v-if="selectedRow" color="arcoblue" style="margin-left: auto">{{ statusLabel(selectedRow.status) }}</a-tag>
          </div>
        </section>

        <template v-if="selectedRow">
          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">判断类别</div>
            <a-select :model-value="selectedRow.status" style="width: 100%" @change="updateStatus">
              <a-option value="same">相同</a-option>
              <a-option value="changed">改动</a-option>
              <a-option value="added">右侧新增</a-option>
              <a-option value="removed">左侧删减</a-option>
              <a-option value="misaligned">疑错位</a-option>
            </a-select>
          </section>

          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">底本 / 参校本</div>
            <div class="diff-text same">{{ selectedRow.left?.text || '（无）' }}</div>
            <div style="height: 8px" />
            <div class="diff-text changed">{{ selectedRow.right?.text || '（无）' }}</div>
          </section>

          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">校勘说明</div>
            <a-textarea
              v-model="noteDraft"
              placeholder="记录字形、词句、标点或语义差异的判断依据"
              :auto-size="{ minRows: 5, maxRows: 10 }"
            />
            <a-input v-model="sourceDraft" placeholder="来源，如：某刻本、某整理者" style="margin-top: 10px" />
            <a-button long type="primary" style="margin-top: 10px" @click="saveAnnotation">保存校勘说明</a-button>
          </section>

          <section class="panel-section">
            <div style="margin-bottom: 10px; color: #86909c; font-size: 12px">错位修正</div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px">
              <a-button @click="shiftPairing(selectedRow.id, -1)">配对向前</a-button>
              <a-button @click="shiftPairing(selectedRow.id, 1)">配对向后</a-button>
              <a-button @click="moveRow(selectedRow.id, -1)">整行上移</a-button>
              <a-button @click="moveRow(selectedRow.id, 1)">整行下移</a-button>
            </div>
            <a-alert type="info" style="margin-top: 10px" :show-icon="true">
              配对移动只交换左栏句段，不会改写底本或参校本原文。
            </a-alert>
          </section>

          <section class="panel-section">
            <a-button
              long
              :status="selectedRow.accepted ? 'normal' : 'success'"
              :type="selectedRow.accepted ? 'outline' : 'primary'"
              @click="updateRow(selectedRow.id, { accepted: !selectedRow.accepted })"
            >
              {{ selectedRow.accepted ? '撤回接受状态' : '接受这条校勘建议' }}
            </a-button>
          </section>
        </template>

        <div v-else class="inspector-empty">
          <div>
            <div style="font-size: 30px; color: #c9cdd4">择</div>
            <p>选择中间表格的一行<br />即可调整错位并填写校勘说明</p>
          </div>
        </div>

        <section class="panel-section" style="margin-top: auto">
          <div style="color: #86909c; font-size: 11px; line-height: 1.7">
            最近状态：{{ message }}<br />
            数据保存在当前浏览器，刷新后继续。
          </div>
        </section>
      </a-layout-sider>
    </a-layout>
  </a-layout>

  <a-modal v-model:visible="importVisible" title="导入同一作品的新版本" width="700px" @ok="confirmImport">
    <a-form :model="importForm" layout="vertical">
      <a-grid :cols="2" :col-gap="12">
        <a-grid-item>
          <a-form-item label="版本名称">
            <a-input v-model="importForm.name" placeholder="如：某刻本 / 某校点本" />
          </a-form-item>
        </a-grid-item>
        <a-grid-item>
          <a-form-item label="来源">
            <a-input v-model="importForm.source" placeholder="馆藏、整理者或文件来源" />
          </a-form-item>
        </a-grid-item>
      </a-grid>
      <a-form-item label="选择文本文件">
        <input ref="fileInput" type="file" accept=".txt,.md,text/plain,text/markdown" @change="handleFile" />
      </a-form-item>
      <a-form-item label="或直接粘贴正文">
        <a-textarea
          v-model="importForm.text"
          placeholder="空行分段；句号、问号、感叹号或分号后自动分句"
          :auto-size="{ minRows: 10, maxRows: 18 }"
        />
      </a-form-item>
      <a-alert type="info" :show-icon="true">导入仅写入当前浏览器。对齐过程会分片执行，原文不会被自动改写。</a-alert>
    </a-form>
  </a-modal>

  <a-modal
    v-model:visible="packageVisible"
    title="校勘工作包 · 导出与粘贴恢复"
    width="760px"
    :ok-text="packageTab === 'import' ? '校验并恢复' : '完成'"
    :cancel-text="packageTab === 'import' ? '关闭（保留当前工作区）' : '取消'"
    :ok-button-props="{ status: packageTab === 'import' ? 'success' : 'normal', type: packageTab === 'import' ? 'primary' : 'secondary' }"
    @ok="packageTab === 'import' ? confirmRestore() : (packageVisible = false)"
  >
    <a-tabs v-model:active-key="packageTab" @change="switchPackageTab">
      <a-tab-pane key="export" title="导出工作包">
        <a-alert type="info" :show-icon="true" style="margin-bottom: 12px">
          工作包自包含全部版本正文、当前底本/参校组合、比较规则和全部对齐行（含校记、来源与接受结果）。整体复制到另一台电脑粘贴即可恢复，无需先导入任何版本。
        </a-alert>
        <div style="display: flex; gap: 8px; margin-bottom: 8px">
          <a-button type="primary" size="small" @click="copyPackage">复制全部内容</a-button>
          <a-button size="small" @click="downloadPackage">下载为 .json 文件</a-button>
          <a-button size="small" @click="packageExportText = exportWorkPackage()">重新生成</a-button>
          <a-tag color="arcoblue" style="margin-left: auto">{{ packageExportText.length }} 字符</a-tag>
        </div>
        <a-textarea
          v-model="packageExportText"
          readonly
          :auto-size="{ minRows: 14, maxRows: 18 }"
          class="package-textarea"
          aria-label="工作包 JSON 全文"
        />
      </a-tab-pane>

      <a-tab-pane key="import" title="粘贴恢复">
        <a-form :model="{}" layout="vertical">
          <a-form-item label="粘贴工作包 JSON，或选择工作包文件">
            <input
              ref="packageFileInput"
              type="file"
              accept=".json,application/json"
              style="margin-bottom: 8px"
              @change="handlePackageFile"
            />
            <a-textarea
              v-model="packageImportText"
              placeholder="粘贴另一台电脑导出的「collation-workpackage」JSON 全文"
              :auto-size="{ minRows: 10, maxRows: 14 }"
              class="package-textarea"
              aria-label="待恢复的工作包 JSON"
              @input="scheduleInspection"
            />
          </a-form-item>
        </a-form>

        <a-alert v-if="packageInspection && packageErrors.length" type="error" :show-icon="true" style="margin-bottom: 8px">
          <div style="font-weight: 600; margin-bottom: 4px">
            校验未通过：{{ packageErrors.length }} 项对不上，已保留原来的工作区，未做任何修改
          </div>
          <ul class="issue-list">
            <li v-for="(issue, index) in packageErrors" :key="`e-${index}`">{{ issue.message }}</li>
          </ul>
        </a-alert>

        <a-alert v-if="packageInspection && packageWarnings.length" type="warning" :show-icon="true" style="margin-bottom: 8px">
          <div style="font-weight: 600; margin-bottom: 4px">{{ packageWarnings.length }} 项提醒（不阻止恢复）</div>
          <ul class="issue-list">
            <li v-for="(issue, index) in packageWarnings" :key="`w-${index}`">{{ issue.message }}</li>
          </ul>
        </a-alert>

        <a-alert v-if="packageInspection && packageInspection.ok" type="success" :show-icon="true">
          <div style="font-weight: 600; margin-bottom: 4px">校验通过，可以恢复：</div>
          <div style="line-height: 1.8">
            底本「{{ packageInspection.summary.baseName || '未指定' }}」对参校本「{{
              packageInspection.summary.referenceName || '未指定'
            }}」；共 {{ packageInspection.summary.versionCount }} 个版本（{{
              packageInspection.summary.reusedCount
            }} 个与本地一致、{{ packageInspection.summary.createdCount }} 个将新建）、{{
              packageInspection.summary.rowCount
            }} 条对齐行，其中 {{ packageInspection.summary.differenceCount }} 处差异。恢复后可继续调整，也可用撤销退回原工作区。
          </div>
        </a-alert>

        <a-alert v-else-if="!packageInspection && packageImportText" type="info" :show-icon="true">
          正在校验粘贴内容…
        </a-alert>
        <a-alert v-else-if="!packageInspection" type="info" :show-icon="true">
          恢复前会先校验：同名版本正文不同、底本或参校本缺失、对齐行引用的句段不在包内等问题都会逐项列出；任何一项对不上都不会改动当前工作区。
        </a-alert>
      </a-tab-pane>
    </a-tabs>
  </a-modal>
</template>
