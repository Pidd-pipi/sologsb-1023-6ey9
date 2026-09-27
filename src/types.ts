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

export interface WorkPackageVersion {
  id: string;
  name: string;
  source: string;
  createdAt: string;
  text: string;
}

export interface WorkPackage {
  format: string;
  packageVersion: number;
  exportedAt: string;
  versions: WorkPackageVersion[];
  leftVersionId: string;
  rightVersionId: string;
  rules: ComparisonRules;
  rows: AlignmentRow[];
  selectedRowId: string;
}

export interface ImportResult {
  ok: boolean;
  problems: string[];
}
