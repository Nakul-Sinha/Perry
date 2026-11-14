// Only base files and edits enter the temporary Git repository. Case names
// are local selectors; review inputs and commit messages carry no labels.
export interface Comparison {
  base: Record<string, string>;
  edits: Record<string, string | null>;
}

export function manifest(scripts: Record<string, string>): string {
  return JSON.stringify({ name: "example", scripts }, null, 2) + "\n";
}

const npmBase = { "package.json": manifest({ check: "npm run lint", lint: "node --version" }) };
const esmBase = {
  "total.mjs": "export const total = 1;\n",
  "invoice.mjs": "import { total } from './total.mjs';\nexport const amount = total;\n",
};
const intentBase = {
  "docs/plan.md": "An empty shopping cart has a total of zero. The total must always be finite.\n",
  "cart.mjs": "export const total = prices => prices.reduce((sum, price) => sum + price, 0);\n",
};

export const comparisons: Record<string, Comparison> = {
  "script-rename": {
    base: npmBase, edits: { "package.json": manifest({ check: "npm run syntax", syntax: "node --version" }) },
  },
  "script-removed": {
    base: npmBase, edits: { "package.json": manifest({ check: "npm run lint" }) },
  },
  "script-optional": {
    base: { ...npmBase, ".npmrc": "if-present=true\n" },
    edits: { "package.json": manifest({ check: "npm run lint" }) },
  },
  "script-existing": {
    base: { "package.json": manifest({ check: "npm run lint" }) },
    edits: { "package.json": manifest({ check: "npm run lint", versionInfo: "node --version" }) },
  },
  "script-shared-target": {
    base: npmBase,
    edits: { "package.json": manifest({ check: "npm run lint", verify: "npm run lint" }) },
  },
  "manifest-punctuation": {
    base: npmBase, edits: { "package.json": '{\n  "private": true,\n}\n' },
  },
  "manifest-metadata": {
    base: npmBase, edits: { "package.json": '{\n  "name": "example",\n  "private": true\n}\n' },
  },
  "manifest-move": {
    base: { "old/package.json": manifest({ check: "npm run lint" }) },
    edits: { "old/package.json": null, "new/package.json": manifest({ check: "npm run lint" }) },
  },
  "module-declaration": {
    base: esmBase, edits: { "total.mjs": "export const total = ;\n" },
  },
  "module-expression": {
    base: esmBase, edits: { "total.mjs": "export const total = 1 + 0;\n" },
  },
  "module-existing": {
    base: { "total.mjs": "export const total = ;\n" },
    edits: { "total.mjs": "export const total = ;\n// Invoice totals are denominated in cents.\n" },
  },
  "import-binding": {
    base: esmBase, edits: { "invoice.mjs": "import { balance } from './total.mjs';\nexport const amount = balance;\n" },
  },
  "import-alias": {
    base: esmBase, edits: { "invoice.mjs": "import { total as balance } from './total.mjs';\nexport const amount = balance;\n" },
  },
  "unchanged-consumer": {
    base: esmBase, edits: { "total.mjs": "export const balance = 1;\n" },
  },
  "compatible-export": {
    base: esmBase, edits: { "total.mjs": "export const balance = 1;\nexport { balance as total };\n" },
  },
  "forwarded-binding": {
    base: { ...esmBase, "index.mjs": "export * from './total.mjs';\n" },
    edits: { "invoice.mjs": "import { total } from './index.mjs';\nexport const amount = total;\n" },
  },
  "empty-cart": {
    base: intentBase, edits: { "cart.mjs": "export const total = prices => prices.reduce((sum, price) => sum + price);\n" },
  },
  "cart-refactor": {
    base: intentBase,
    edits: { "cart.mjs": "export function total(prices) { return prices.reduce((a, b) => a + b, 0); }\n" },
  },
  "module-binary": { base: esmBase, edits: { "invoice.mjs": "invoice\u0000binary\n" } },
  "package-deleted": { base: npmBase, edits: { "package.json": null } },
};
