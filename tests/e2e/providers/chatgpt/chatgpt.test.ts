import { describeProvider } from "../provider-suite.ts";

describeProvider({
  provider: "chatgpt",
  serviceId: "openai-chatgpt",
  allowed: ["f-conversation", "conversation"],
  blocked: ["f-conversation", "conversation"],
  exception: "f-conversation",
});
