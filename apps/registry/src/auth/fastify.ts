import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export const AUTH_BASE_PATH = "/api/auth";

export const googleRedirectUri = (baseUrl: string): string =>
  `${baseUrl.replace(/\/+$/, "")}${AUTH_BASE_PATH}/callback/google`;

const requestHeaders = (req: FastifyRequest): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.append(name, String(value));
  }
  return headers;
};

const requestBody = (req: FastifyRequest): string | undefined => {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  if (req.body === undefined || req.body === null) return undefined;
  if (typeof req.body === "string") return req.body;
  return JSON.stringify(req.body);
};

const sendResponse = async (reply: FastifyReply, response: Response): Promise<void> => {
  reply.status(response.status);
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) reply.header("set-cookie", cookies);
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") return;
    void reply.header(key, value);
  });
  const body = await response.text();
  await reply.send(body === "" ? null : body);
};

export interface AuthHandler {
  handler(request: Request): Promise<Response>;
}

export const registerAuthHandler = (app: FastifyInstance, auth: AuthHandler): void => {
  app.route({
    method: ["GET", "POST"],
    url: `${AUTH_BASE_PATH}/*`,
    async handler(req, reply) {
      const origin = `http://${req.headers.host ?? "localhost"}`;
      const url = new URL(req.url, origin);
      const body = requestBody(req);
      const request = new Request(url.toString(), {
        method: req.method,
        headers: requestHeaders(req),
        ...(body === undefined ? {} : { body }),
      });
      await sendResponse(reply, await auth.handler(request));
    },
  });
};
