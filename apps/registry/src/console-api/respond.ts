import type { FastifyReply } from "fastify";
import { VibtraError, type VibtraErrorCode } from "../errors.js";
import { CONSOLE_RESPONSE_SCHEMAS, type ConsoleDoor } from "@vibtra/console-api";

export const sendConsole = <D extends ConsoleDoor>(reply: FastifyReply, door: D, value: unknown): FastifyReply =>
  reply.send(CONSOLE_RESPONSE_SCHEMAS[door].parse(value));

export const notFound = (reply: FastifyReply, message: string, detail: string): FastifyReply =>
  reply.code(404).send(new VibtraError({ code: "VALIDATION", message, detail }).toJSON());

export const forbidden = (reply: FastifyReply, message: string, detail: string): FastifyReply =>
  reply.code(403).send(new VibtraError({ code: "VALIDATION", message, detail }).toJSON());

export const refuseWithStatus = (
  reply: FastifyReply,
  status: number,
  code: VibtraErrorCode,
  message: string,
  detail: string,
): FastifyReply => reply.code(status).send(new VibtraError({ code, message, detail }).toJSON());
