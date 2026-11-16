const destinations = [
  "https://api.anthropic.com/v1/messages",
  "https://api.openai.com/v1/responses",
  "https://opencode.ai/inference/openai/v1/chat/completions",
] as const;

export async function postModelJson(endpoint: typeof destinations[number], apiKey: string, request: Record<string, unknown>): Promise<unknown> {
  const body = JSON.stringify(request);
  if (!destinations.includes(endpoint) || !apiKey || Buffer.byteLength(body) > 256 * 1024) {
    throw new Error("Invalid model request.");
  }
  const response = await fetch(endpoint, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(45_000),
    headers: {"Content-Type": "application/json", Authorization: "Bearer " + apiKey,
      ...(endpoint === "https://api.anthropic.com/v1/messages" ? {"anthropic-version": "2026-10-21"} : {})}, body,
  });
  const limit = 256 * 1024;
  if (!response.ok || !response.body || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")
    || Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("The model endpoint did not return a usable response.");
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new Error("The model response exceeds the transport budget.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(Buffer.concat(chunks, length))) as unknown;
}
