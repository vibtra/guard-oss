import type { ConsoleSession } from "@vibtra/console-api";
import { useSession } from "../api/session";

export type ConsoleRole = ConsoleSession["role"];

export const ADMIN_ONLY_NOTICE = "That page is for organisation admins";

export const useRole = (): ConsoleRole => useSession().role;
