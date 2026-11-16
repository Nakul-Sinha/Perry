import { postModelJson } from "./provider-http.ts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function opencodeMessage(model: string, instructions: string, payload: string, apiKey: string): Promise<string> {
  const reply = await postModelJson("https://opencode.ai/inference/openai/v1/chat/completions", apiKey, {
    model, max_tokens: 3000, stream: false,
    messages: [{ role: "system", content: instructions }, { role: "user", content: payload }],
  });
  const invalid = new Error("OpenCode returned an incomplete or unsupported response.");
  if (!record(reply) || reply.error != null || !Array.isArray(reply.choices) || reply.choices.length !== 1) throw invalid;
  const choice: unknown = reply.choices[0];
  if (!record(choice) || choice.finish_reason !== "stop" || !record(choice.message)) throw invalid;
  const message = choice.message;
  if (message.role !== "assistant" || message.refusal != null || message.function_call != null
    || (message.tool_calls != null && !(Array.isArray(message.tool_calls) && message.tool_calls.length === 0))
    || typeof message.content !== "string" || !message.content.trim() || Buffer.byteLength(message.content) > 16 * 1024) throw invalid;
  return message.content;
}
