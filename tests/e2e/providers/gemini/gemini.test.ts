import { describeProvider } from "../provider-suite.ts";

describeProvider({
  provider: "gemini",
  serviceId: "google-gemini",
  allowed: ["generate-content", "stream-generate-content"],
  blocked: ["generate-content", "stream-generate-content"],
  exception: "generate-content",
});
