// Keep labels outside the Git inputs. A known miss still labels a real defect;
// limitation-only comparisons are coverage gaps, not certified clean changes.
export interface ComparisonExpectation {
  name: string;
  finding?: RegExp;
  location?: string;
  knownMiss?: RegExp;
  limitation?: RegExp;
}

export const comparisonExpectations: ComparisonExpectation[] = [
  { name: "script-rename" },
  { name: "script-removed", finding: /Missing npm script lint/, location: "package.json:4" },
  { name: "script-optional", limitation: /npm configuration/ },
  { name: "script-existing" },
  { name: "script-shared-target", finding: /Missing npm script lint/, location: "package.json:4" },
  { name: "manifest-punctuation", finding: /Invalid package manifest JSON/, location: "package.json:3" },
  { name: "manifest-metadata" },
  { name: "manifest-move" },
  { name: "module-declaration", finding: /Module fails to parse/, location: "total.mjs:1" },
  { name: "module-expression" },
  { name: "module-existing" },
  { name: "import-binding", finding: /Missing named export: balance/, location: "invoice.mjs:1" },
  { name: "import-alias" },
  { name: "unchanged-consumer", finding: /Missing named export: total/, location: "invoice.mjs:1" },
  { name: "compatible-export" },
  { name: "forwarded-binding", limitation: /outside the supported source syntax/ },
  { name: "empty-cart", knownMiss: /empty.*(?:cart|array|reduce)|reduce.*(?:initial|empty)/i },
  { name: "cart-refactor" },
  { name: "module-binary", limitation: /source is unavailable/i },
  { name: "package-deleted", limitation: /Impact of removing this package/ },
];
