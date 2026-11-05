import type { Page } from "@playwright/test";
import { CONSOLE_API_PREFIX } from "@vibtra/console-api";

export interface Call {
  method: string;
  path: string;
  search: string;
  query: URLSearchParams;
  body: unknown;
  headers: Record<string, string>;
}

export type Answer = { status?: number; body?: unknown } | "pending";

export type Doors = Record<string, Answer | ((call: Call) => Answer)>;

export const refused = (status: number, code: string, message: string, detail?: string): Answer => ({
  status,
  body: detail === undefined ? { code, message } : { code, message, detail },
});

export const answerDoors = async (page: Page, doors: Doors): Promise<{ calls: Call[] }> => {
  const calls: Call[] = [];
  await page.route(`**${CONSOLE_API_PREFIX}/**`, async (route, request) => {
    const url = new URL(request.url());
    const raw = request.postData();
    const call: Call = {
      method: request.method(),
      path: url.pathname.slice(CONSOLE_API_PREFIX.length),
      search: url.search,
      query: url.searchParams,
      body: raw === null || raw === "" ? undefined : JSON.parse(raw),
      headers: request.headers(),
    };
    calls.push(call);
    const door = doors[`${call.method} ${call.path}`];
    const answer = typeof door === "function" ? door(call) : door;
    if (answer === undefined) return route.fallback();
    if (answer === "pending") return;
    return route.fulfill({
      status: answer.status ?? 200,
      contentType: "application/json",
      body: answer.body === undefined ? "" : JSON.stringify(answer.body),
    });
  });
  return { calls };
};
