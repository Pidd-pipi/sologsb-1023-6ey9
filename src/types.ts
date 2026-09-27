export type DifferenceStatus = 'same' | 'changed' | 'added' | 'removed' | 'misaligned';

export interface TextUnit {
  id: string;
  paragraphId: string;
  paragraphOrder: number;
  sentenceOrder: number;
  paragraphText: string;
  text: string;
}

export interface VersionDocument {
  id: string;
  name: string;
  source: string;
  createdAt: string;
  text: string;
  units: TextUnit[];
}

export interface AlignmentRow {
  id: string;
  left?: TextUnit;
  right?: TextUnit;
  status: DifferenceStatus;
  similarity: number;
  note: string;
  source: string;
  accepted: boolean;
  manuallyAdjusted: boolean;
}

export interface ComparisonRules {
  ignorePunctuation: boolean;
  ignoreVariants: boolean;
  candidateWindow: number;
}

export interface PersistedCollationState {
  versions: VersionDocument[];
  leftVersionId: string;
  rightVersionId: string;
  rows: AlignmentRow[];
  rules: ComparisonRules;
  selectedRowId: string;
}

export interface WorkPackage {
  kind: 'collation-workpackage';
  appVersion: 1;
  exportedAt: string;
  versions: VersionDocument[];
  leftVersionId: string;
  rightVersionId: string;
  rules: ComparisonRules;
  rows: AlignmentRow[];
  selectedRowId?: string;
}

export interface WorkPackageIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
}

export interface WorkPackageRestorePlan {
  versions: VersionDocument[];
  leftVersionId: string;
  rightVersionId: string;
  rules: ComparisonRules;
  rows: AlignmentRow[];
  selectedRowId: string;
  reusedVersionIds: string[];
  createdVersionIds: string[];
}

export interface WorkPackageInspectionSummary {
  versionCount: number;
  rowCount: number;
  differenceCount: number;
  baseName: string;
  referenceName: string;
  reusedCount: number;
  createdCount: number;
}

export interface WorkPackageInspection {
  ok: boolean;
  issues: WorkPackageIssue[];
  summary: WorkPackageInspectionSummary;
  plan?: WorkPackageRestorePlan;
}
