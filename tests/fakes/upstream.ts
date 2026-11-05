import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { isRecord } from "../support/guards.ts";

export type Provider = "openai-api" | "chatgpt" | "anthropic" | "gemini";

const FIXTURES = new URL("../fixtures/providers/", import.meta.url);
const STREAM_HOLD_MS = 5_000;

export interface SseEvent {
  readonly event?: string;
  readonly data: unknown;
}

export interface Recording {
  readonly name: string;
  readonly host: string;
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly prompt: string;
    readonly body: unknown;
  };
  readonly response: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: unknown;
    readonly events?: readonly SseEvent[];
  };
}

export interface ReceivedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

export interface SentResponse {
  readonly recording: string;
  readonly status: number;
  readonly body: Buffer;
  readonly releasedByClient: boolean;
}

export interface FakeUpstream {
  readonly url: string;
  readonly host: string;
  readonly recordings: readonly Recording[];
  readonly received: readonly ReceivedRequest[];
  readonly sent: readonly SentResponse[];
  releaseStream(): void;
  close(): Promise<void>;
}

export interface FakeUpstreamOptions {
  readonly provider: Provider;
  readonly recording: string | readonly string[];
  readonly holdStream?: boolean;
}

const isStringMap = (value: unknown): value is Record<string, string> => isRecord(value) && Object.values(value).every((item) => typeof item === "string");

const isSseEvent = (value: unknown): value is SseEvent => isRecord(value) && "data" in value && (value.event === undefined || typeof value.event === "string");

const swapText = (value: unknown, from: string, to: string, count: { replaced: number }): unknown => {
  if (value === from) {
    count.replaced += 1;
    return to;
  }
  if (Array.isArray(value)) return value.map((item) => swapText(item, from, to, count));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, swapText(item, from, to, count)]));
  return value;
};

export const recordedRequestBody = (recording: Recording, prompt: string = recording.request.prompt): Buffer => {
  const count = { replaced: 0 };
  const body = swapText(recording.request.body, recording.request.prompt, prompt, count);
  if (count.replaced !== 1) {
    throw new Error(`recording ${recording.name}: the prompt must appear exactly once in the request body, found ${count.replaced}`);
  }
  return Buffer.from(JSON.stringify(body));
};

export const responseFrames = (recording: Recording): Buffer[] => {
  const { events, body } = recording.response;
  if (events === undefined) return [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))];
  return events.map((event) =>
    Buffer.from(`${event.event === undefined ? "" : `event: ${event.event}\n`}data: ${typeof event.data === "string" ? event.data : JSON.stringify(event.data)}\n\n`),
  );
};

const parseRecording = (provider: Provider, name: string, value: unknown): Recording => {
  const where = `recording ${provider}/${name}`;
  const request = isRecord(value) ? value.request : undefined;
  const response = isRecord(value) ? value.response : undefined;
  if (!isRecord(value) || typeof value.host !== "string") throw new Error(`${where}: host must be a string`);
  if (
    !isRecord(request) ||
    typeof request.method !== "string" ||
    typeof request.path !== "string" ||
    !isStringMap(request.headers) ||
    typeof request.prompt !== "string" ||
    request.body === undefined
  ) {
    throw new Error(`${where}: request needs method, path, headers, prompt and body`);
  }
  if (!isRecord(response) || typeof response.status !== "number" || !isStringMap(response.headers)) {
    throw new Error(`${where}: response needs status and headers`);
  }
  const events = response.events;
  if (events !== undefined && (!Array.isArray(events) || !events.every(isSseEvent))) throw new Error(`${where}: response.events must list { event?, data }`);
  if ((events === undefined) === (response.body === undefined)) throw new Error(`${where}: response needs exactly one of body and events`);
  const recording: Recording = {
    name,
    host: value.host,
    request: { method: request.method, path: request.path, headers: request.headers, prompt: request.prompt, body: request.body },
    response: Array.isArray(events)
      ? { status: response.status, headers: response.headers, events }
      : { status: response.status, headers: response.headers, body: response.body },
  };
  recordedRequestBody(recording);
  return recording;
};

export const loadRecording = async (provider: Provider, name: string): Promise<Recording> =>
  parseRecording(provider, name, JSON.parse(await readFile(new URL(`${provider}/${name}.json`, FIXTURES), "utf8")));

const releasedWithin = async (released: Promise<void>, ms: number): Promise<boolean> => {
  const expired = Promise.withResolvers<boolean>();
  const timer = setTimeout(() => expired.resolve(false), ms);
  try {
    return await Promise.race([released.then(() => true), expired.promise]);
  } finally {
    clearTimeout(timer);
  }
};

export const startFakeUpstream = async (options: FakeUpstreamOptions): Promise<FakeUpstream> => {
  const names = typeof options.recording === "string" ? [options.recording] : options.recording;
  const recordings = await Promise.all(names.map((name) => loadRecording(options.provider, name)));
  const [first] = recordings;
  if (first === undefined) throw new Error("a fake upstream needs at least one recording");
  if (recordings.some((recording) => recording.host !== first.host)) throw new Error(`the recordings ${names.join(", ")} do not share one host`);
  if (new Set(recordings.map((recording) => `${recording.request.method} ${recording.request.path}`)).size !== recordings.length) {
    throw new Error(`two of the recordings ${names.join(", ")} answer the same method and path`);
  }

  const received: ReceivedRequest[] = [];
  const sent: SentResponse[] = [];
  const release = Promise.withResolvers<void>();

  const server = createServer((req, res) => {
    const answer = async (): Promise<void> => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      received.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
      const recording = recordings.find((candidate) => candidate.request.method === req.method && candidate.request.path === req.url);
      if (recording === undefined) {
        const body = Buffer.from(JSON.stringify({ error: { message: `no recording answers ${req.method} ${req.url}` } }));
        res.writeHead(404, { "content-type": "application/json" }).end(body);
        sent.push({ recording: "", status: 404, body, releasedByClient: false });
        return;
      }
      const frames = responseFrames(recording);
      const streamed = recording.response.events !== undefined;
      res.writeHead(
        recording.response.status,
        streamed ? recording.response.headers : { ...recording.response.headers, "content-length": String(Buffer.concat(frames).length) },
      );
      let releasedByClient = false;
      for (const [index, frame] of frames.entries()) {
        res.write(frame);
        if (index === 0 && streamed && options.holdStream === true) releasedByClient = await releasedWithin(release.promise, STREAM_HOLD_MS);
      }
      res.end();
      sent.push({ recording: recording.name, status: recording.response.status, body: Buffer.concat(frames), releasedByClient });
    };
    answer().catch(() => res.destroy());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the fake upstream did not listen on a TCP port");

  return {
    url: `http://127.0.0.1:${address.port}`,
    host: first.host,
    recordings,
    received,
    sent,
    releaseStream: () => release.resolve(),
    close: async () => {
      release.resolve();
      const closed = once(server, "close");
      server.closeAllConnections();
      server.close();
      await closed;
    },
  };
};
