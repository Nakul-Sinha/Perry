export type Revision = "base" | "head" | "merge_base";
export type BlobRead =
  | { kind: "text"; text: string }
  | { kind: "missing" }
  | { kind: "unavailable"; reason: string };

export interface Snapshot {
  base: string;
  head: string;
  merge_base: string;
  changes: { path: string; previousPath?: string; status: "added" | "modified" | "deleted" | "type_changed" }[];
  read(ref: Revision, path: string): Promise<BlobRead>;
  listPaths?(ref: Revision): Promise<string[]>;
}

export type Severity = "low" | "medium" | "high" | "critical";

type SourceLocation = { sha: string; path: string; line: number };

export interface Finding {
  id: string;
  title: string;
  severity: Severity;
  trigger: string;
  impact: string;
  fix: string;
  evidence: SourceLocation;
  verifiedProvider?: SourceLocation;
}

export interface Inspection {
  changes: string[];
  findings: Finding[];
  coverage: { path: string; disposition: "checked" | "incomplete"; reason: string }[];
  limitations: string[];
}

export interface ReportInput {
  checksRun?: string[];
  snapshot: Pick<Snapshot, "base" | "head" | "merge_base"> | null;
  inspection: Inspection;
  assessment: "completed" | "partial" | "failed" | "canceled" | "stale" | "unassessed";
  readiness: {
    freshness: "current" | "stale" | "unknown";
    mergeability: "clean" | "conflicts" | "unknown";
    checks: "passed" | "failed" | "pending" | "not_required" | "unknown";
    prerequisites: "satisfied" | "unsatisfied" | "unknown";
    unresolvedMaterialRisk: boolean;
  };
}
