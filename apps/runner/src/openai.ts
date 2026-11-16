import { postModelJson } from "./provider-http.ts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function openaiMessage(model: string, instructions: string, payload: string, apiKey: string): Promise<string> {
  const reply = await postModelJson("https://api.openai.com/v1/responses", apiKey, {
    model, instructions, input: payload, store: false, tools: [], max_output_tokens: 3000,
  });
  const invalid = new Error("OpenAI returned an incomplete or unsupported response.");
  if (!record(reply) || reply.status !== "completed" || reply.error != null || reply.incomplete_details != null
    || !Array.isArray(reply.output)) throw invalid;

  let answer: string | undefined;
  for (const item of reply.output) {
    if (!record(item)) throw invalid;
    if (item.type === "reasoning" && (item.status === undefined || item.status === "completed")) continue;
    if (item.type !== "message" || item.role !== "assistant" || item.status !== "completed"
      || !Array.isArray(item.content) || !item.content.length) throw invalid;
    const parts: string[] = [];
    for (const part of item.content) {
      if (!record(part) || part.type !== "output_text" || typeof part.text !== "string") throw invalid;
      parts.push(part.text);
    }
    if (item.phase === "commentary") continue;
    if (answer !== undefined || (item.phase != null && item.phase !== "final_answer")) throw invalid;
    answer = parts.join("");
  }
  if (!answer?.trim() || Buffer.byteLength(answer) > 16 * 1024) throw invalid;
  return answer;
}
