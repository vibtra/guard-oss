import { describeProvider } from "../provider-suite.ts";

describeProvider({
  provider: "anthropic",
  serviceId: "anthropic-api",
  allowed: ["messages", "messages-stream"],
  blocked: ["messages"],
  exception: "messages",
});
