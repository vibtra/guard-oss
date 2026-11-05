import { once } from "node:events";
import net from "node:net";
import { Duplex } from "node:stream";
import tls, { type TLSSocket } from "node:tls";
import type { Cleanup } from "../../support/cleanup.ts";
import type { TlsOptions } from "./running.ts";

export const UNSAFE_EXTENSIONS: readonly number[] = [22, 41, 42, 44];

export const isGrease = (value: number): boolean => (value & 0x0f0f) === 0x0a0a && value >> 8 === (value & 0xff);

export interface HelloRead {
  readonly wireLength: number;
  readonly handshake: Buffer;
}

export const readHello = (wire: Buffer): HelloRead | undefined => {
  const parts: Buffer[] = [];
  let at = 0;
  while (at + 5 <= wire.length) {
    if (wire[at] !== 22) throw new Error("the first record is not a TLS handshake record");
    const size = wire.readUInt16BE(at + 3);
    if (at + 5 + size > wire.length) return undefined;
    parts.push(wire.subarray(at + 5, at + 5 + size));
    at += 5 + size;
    const handshake = Buffer.concat(parts);
    if (handshake.length >= 4) {
      const want = 4 + handshake.readUIntBE(1, 3);
      if (handshake.length >= want) return { wireLength: at, handshake: handshake.subarray(0, want) };
    }
  }
  return undefined;
};

export interface Extension {
  readonly type: number;
  readonly data: Buffer;
}

export interface HelloShape {
  readonly version: number;
  readonly suites: number[];
  readonly extensions: Extension[];
  readonly alpn: string[];
  readonly serverName: string | undefined;
}

export const helloShape = (handshake: Buffer): HelloShape => {
  let at = 4;
  const take = (length: number): Buffer => {
    if (at + length > handshake.length) throw new Error("the ClientHello is truncated");
    const bytes = handshake.subarray(at, at + length);
    at += length;
    return bytes;
  };
  const version = take(2).readUInt16BE(0);
  take(32);
  take(take(1).readUInt8(0));
  const suiteBytes = take(take(2).readUInt16BE(0));
  const suites = Array.from({ length: suiteBytes.length / 2 }, (_, index) => suiteBytes.readUInt16BE(index * 2));
  take(take(1).readUInt8(0));
  const extensions: Extension[] = [];
  if (at < handshake.length) {
    for (let left = take(2).readUInt16BE(0); left > 0; ) {
      const type = take(2).readUInt16BE(0);
      const data = take(take(2).readUInt16BE(0));
      extensions.push({ type, data });
      left -= 4 + data.length;
    }
  }
  const alpnData = extensions.find((extension) => extension.type === 16)?.data;
  const alpn: string[] = [];
  if (alpnData !== undefined) {
    for (let index = 2; index < alpnData.length; index += 1 + (alpnData[index] ?? 0)) alpn.push(alpnData.subarray(index + 1, index + 1 + (alpnData[index] ?? 0)).toString("latin1"));
  }
  const sniData = extensions.find((extension) => extension.type === 0)?.data;
  const serverName = sniData === undefined ? undefined : sniData.subarray(5, 5 + sniData.readUInt16BE(3)).toString("latin1");
  return { version, suites, extensions, alpn, serverName };
};

export const comparableShape = (shape: HelloShape): { suites: number[]; extensions: number[]; alpn: string[] } => ({
  suites: shape.suites.filter((suite) => !isGrease(suite)),
  extensions: shape.extensions.map((extension) => extension.type).filter((type) => !isGrease(type) && !UNSAFE_EXTENSIONS.includes(type)),
  alpn: shape.alpn,
});

const u16 = (value: number): Buffer => Buffer.from([value >> 8, value & 0xff]);
const vector16 = (data: Buffer): Buffer => Buffer.concat([u16(data.length), data]);

export const extension = (type: number, data: Buffer = Buffer.alloc(0)): Extension => ({ type, data });

export const serverNameExtension = (name: string): Extension => {
  const host = Buffer.from(name, "latin1");
  return extension(0, vector16(Buffer.concat([Buffer.from([0]), vector16(host)])));
};

export interface HelloFields {
  readonly version?: number;
  readonly suites?: readonly number[];
  readonly extensions?: readonly Extension[] | null;
}

export const buildHello = (fields: HelloFields = {}): Buffer => {
  const suites = fields.suites ?? [0x1301];
  const extensions = fields.extensions === null ? undefined : (fields.extensions ?? []);
  const body = Buffer.concat([
    u16(fields.version ?? 0x0303),
    Buffer.alloc(32, 7),
    Buffer.from([0]),
    vector16(Buffer.concat(suites.map(u16))),
    Buffer.from([1, 0]),
    ...(extensions === undefined ? [] : [vector16(Buffer.concat(extensions.map((item) => Buffer.concat([u16(item.type), vector16(item.data)]))))]),
  ]);
  return Buffer.concat([Buffer.from([1, body.length >> 16, (body.length >> 8) & 0xff, body.length & 0xff]), body]);
};

export const records = (handshake: Buffer, sizes: readonly number[] = []): Buffer => {
  const out: Buffer[] = [];
  let at = 0;
  for (let index = 0; at < handshake.length; index += 1) {
    const size = Math.min(sizes[index] ?? 16_384, handshake.length - at);
    out.push(Buffer.from([22, 3, 1, size >> 8, size & 0xff]), handshake.subarray(at, at + size));
    at += size;
  }
  return Buffer.concat(out);
};

export const recordSizes = (wire: Buffer): number[] => {
  const sizes: number[] = [];
  for (let at = 0; at + 5 <= wire.length; at += 5 + wire.readUInt16BE(at + 3)) sizes.push(wire.readUInt16BE(at + 3));
  return sizes;
};

export interface CapturedHello {
  readonly wire: Buffer;
  readonly handshake: Buffer;
}

export interface HelloCapture {
  readonly port: number;
  readonly hellos: CapturedHello[];
  next(): Promise<CapturedHello>;
}

export const startHelloCapture = async (cleanup: Cleanup, reply?: (hello: CapturedHello) => Buffer | undefined): Promise<HelloCapture> => {
  const hellos: CapturedHello[] = [];
  const waiting: ((hello: CapturedHello) => void)[] = [];
  let read = 0;
  const server = net.createServer((socket) => {
    let received = Buffer.alloc(0);
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      let parsed: HelloRead | undefined;
      try {
        parsed = readHello(received);
      } catch {
        socket.destroy();
        return;
      }
      if (parsed === undefined) return;
      socket.removeAllListeners("data");
      const hello = { wire: received.subarray(0, parsed.wireLength), handshake: parsed.handshake };
      hellos.push(hello);
      waiting.shift()?.(hello);
      const answer = reply?.(hello);
      if (answer === undefined) socket.destroy();
      else socket.end(answer);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.defer(async () => {
    server.close();
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the hello capture server has no port");
  return {
    port: address.port,
    hellos,
    next: async () => {
      const index = read;
      read += 1;
      const ready = hellos[index];
      if (ready !== undefined) return ready;
      const pending = Promise.withResolvers<CapturedHello>();
      waiting.push(pending.resolve);
      return pending.promise;
    },
  };
};

export interface FramedTls {
  readonly secure: TLSSocket;
  readonly sent: CapturedHello;
}

export const framedTls = async (raw: net.Socket, servername: string, options: TlsOptions, sizes?: readonly number[]): Promise<FramedTls> => {
  let pending = Buffer.alloc(0);
  let sent: CapturedHello | undefined;
  const duplex = new Duplex({
    read() {
      raw.resume();
    },
    write(chunk: Buffer, _encoding, callback) {
      if (sent !== undefined) {
        raw.write(chunk, callback);
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      const parsed = readHello(pending);
      if (parsed === undefined) {
        callback();
        return;
      }
      const wire = sizes === undefined ? pending.subarray(0, parsed.wireLength) : records(parsed.handshake, sizes);
      sent = { wire, handshake: parsed.handshake };
      raw.write(Buffer.concat([wire, pending.subarray(parsed.wireLength)]), callback);
    },
    final(callback) {
      raw.end();
      callback();
    },
    destroy(error, callback) {
      raw.destroy();
      callback(error);
    },
  });
  raw.on("data", (chunk: Buffer) => {
    if (!duplex.push(chunk)) raw.pause();
  });
  raw.on("end", () => duplex.push(null));
  raw.on("error", (error) => duplex.destroy(error));
  const secure = tls.connect({ ALPNProtocols: ["http/1.1"], ...options, socket: duplex, servername });
  const ready = Promise.withResolvers<FramedTls>();
  secure.once("secureConnect", () => {
    if (sent === undefined) ready.reject(new Error("the client finished TLS without sending a ClientHello"));
    else ready.resolve({ secure, sent });
  });
  secure.once("error", (error) => {
    secure.destroy();
    ready.reject(error);
  });
  return ready.promise;
};

export const clientHelloOf = async (cleanup: Cleanup, options: TlsOptions & { servername?: string }): Promise<CapturedHello> => {
  const capture = await startHelloCapture(cleanup);
  const socket = tls.connect({ ALPNProtocols: ["http/1.1"], ...options, host: "127.0.0.1", port: capture.port, servername: options.servername ?? "chatgpt.com" });
  socket.on("error", () => undefined);
  try {
    return await capture.next();
  } finally {
    socket.destroy();
  }
};
