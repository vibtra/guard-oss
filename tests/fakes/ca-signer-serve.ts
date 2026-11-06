import { startCaSigner } from "./ca-signer.ts";

const signer = await startCaSigner();
const stop = (): void => {
  void signer.close().finally(() => process.exit(0));
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
process.stdout.write(`${signer.socket}\n`);
