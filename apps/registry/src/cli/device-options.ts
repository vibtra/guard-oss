import { randomInt } from "node:crypto";

export const CLI_CLIENT_ID = "vibtra-cli";
export const CLI_DEVICE_EXPIRES_IN = "10m";
export const CLI_DEVICE_INTERVAL = "5s";
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

export const cliUserCode = (): string => Array.from({ length: 8 }, () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]).join("");

