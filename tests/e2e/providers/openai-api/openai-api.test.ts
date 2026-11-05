import { describeProvider } from "../provider-suite.ts";

describeProvider({
  provider: "openai-api",
  serviceId: "openai-api",
  allowed: ["chat-completions", "chat-completions-stream", "responses", "responses-stream"],
  blocked: ["chat-completions", "responses"],
  exception: "chat-completions",
});
