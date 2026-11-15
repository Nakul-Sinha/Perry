import assert from "node:assert/strict";

// The child process alone loads this test transport. Expectations and staged
// replies live outside the Git fixture that Perry sends to the model.
globalThis.fetch = async (url, init) => {
  const req = new Request(url, init);
  assert.equal(req.url, "https://api.anthropic.com/v1/messages");
  const message = await req.json();
  const {files, claims} = JSON.parse(message.messages[0].content);
  const consumer = files.some(file => file.path === "invoice.mjs" && !file.changed && file.text.includes("import { total }"));
  const changed = consumer ? "total.mjs" : "cart.mjs";
  if (!consumer) assert.ok(files.some(file => file.path === "docs/plan.md" && file.ref === "base"));
  function cite(ref) {
    const file = files.findIndex(item => item.path === changed && item.ref === ref);
    return { file, line: 1, quote: files[file].text.trim() };
  }
  const cause = cite("head");
  const prior = cite("merge_base");
  const importer = files.findIndex(file => file.path === "invoice.mjs" && file.ref === "head");
  const linking = consumer ? { missingExport: {
    name: "total", importer: { file: importer, line: 1, quote: files[importer].text.split("\n")[0].trim() },
  } } : {};
  const claim = consumer ? {
    title: "Removed export breaks invoice", severity: "medium", trigger: "Load invoice.mjs.",
    impact: "The unchanged caller imports total.", fix: "Keep an export named total.", cause, prior, ...linking,
  } : {
    title: "Empty cart throws", severity: "medium", trigger: "Request an empty cart total.",
    impact: "An empty array has no first accumulator.", fix: "Pass zero as the initial value.", cause, prior,
  };
  const reply = claims
    ? { decisions: [{index: 0, verdict: cause.quote.includes(", 0)") ? "reject" : "accept", reason: consumer ? "The unchanged caller still imports total." : "Compared the initial accumulator in both revisions.", cause, prior, ...linking}] }
    : { candidates: [claim], incomplete: false };
  return Response.json({ stop_reason: "end_turn", content: [{type: "text", text: JSON.stringify(reply)}] });
};
