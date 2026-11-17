import type { BrowserContext } from "@playwright/test";
import { ConsoleInvitationCreated } from "@vibtra/console-api";
import { MEMBER, SIGNED_OUT, expect, test } from "./support/console.ts";
import { REGISTRY_URL } from "./support/env.ts";
import { ConsoleClient, SESSION_COOKIE, signUp, type Account } from "./support/registry.ts";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

const run = Date.now().toString(36);

const domainFor = (name: string): string => `${name}-${run}.example`;

const signedInAs = async (context: BrowserContext, account: Account): Promise<void> => {
  await context.addCookies([{ name: SESSION_COOKIE, value: account.sessionToken, url: REGISTRY_URL, httpOnly: true, sameSite: "Lax" }]);
};

const ownerOf = async (name: string): Promise<ConsoleClient> => ConsoleClient.open(await signUp({ email: `${name}@${domainFor(name)}`, name }));

const invite = async (admin: ConsoleClient, email: string): Promise<string> =>
  (await admin.write(ConsoleInvitationCreated, "POST", "/people/invitations", { email, role: "member" })).invitationId;

test.describe("the start page after signing in without the invitation link", () => {
  test.use({ storageState: SIGNED_OUT });

  test("shows the one invitation waiting for the address, and Join admits the person to the dashboard", async ({ page, context }) => {
    const ivy = await ownerOf("ivy");
    const email = `kit@${domainFor("ivy")}`;
    await invite(ivy, email);
    await signedInAs(context, await signUp({ email, name: "Kit" }));

    await page.goto("/start");
    await expect(page.getByRole("heading", { name: `Join ${ivy.session.orgName}` })).toBeVisible();
    await expect(page.getByText(`ivy invited ${email} to ${ivy.session.orgName} on Guard.`)).toBeVisible();
    await page.getByRole("link", { name: `Join ${ivy.session.orgName}` }).click();
    await expect(page).toHaveURL(new RegExp(`/${ivy.session.handle}/guard`));
  });

  test("lists several invitations, one Join for each organisation", async ({ page, context }) => {
    const jo = await ownerOf("jo");
    const ned = await ownerOf("ned");
    const email = `lin@${domainFor("jo")}`;
    await invite(jo, email);
    await invite(ned, email);
    await signedInAs(context, await signUp({ email, name: "Lin" }));

    await page.goto("/start");
    await expect(page.getByRole("heading", { name: "Choose your organisation" })).toBeVisible();
    for (const org of [jo, ned]) await expect(page.getByRole("link", { name: org.session.orgName, exact: true })).toBeVisible();
    await expect(page.getByText("Invited by ned.", { exact: false })).toBeVisible();
  });
});

test.describe("the invitation link opened with another account", () => {
  test.use({ storageState: SIGNED_OUT });

  test("says the invitation is for another address without naming it, and signs in again keeping the invitation", async ({ page, context }) => {
    const pia = await ownerOf("pia");
    const invited = `uma@${domainFor("pia")}`;
    const invitationId = await invite(pia, invited);
    const other = await signUp({ email: `mo@${domainFor("mo")}`, name: "Mo" });
    await signedInAs(context, other);

    await page.goto(`/start?invitation=${encodeURIComponent(invitationId)}`);
    await expect(page.getByRole("heading", { name: "This invitation is for another address" })).toBeVisible();
    await expect(page.getByRole("status")).toContainText(`You are signed in as ${other.email}`);
    await expect(page.locator("body")).not.toContainText(invited);
    await expect(page.locator("body")).not.toContainText("Ask whoever invited you");
    await page.getByRole("button", { name: "Sign in with another account" }).click();
    await expect(page).toHaveURL(`${REGISTRY_URL}/login?invitation=${encodeURIComponent(invitationId)}&account=another`);
    await expect(page.getByText("You have an invitation.")).toBeVisible();

    await page.route("https://accounts.google.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>Google</title>" }));
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await page.waitForURL(/^https:\/\/accounts\.google\.com\//);
    const google = new URL(page.url());
    expect(google.searchParams.get("prompt")).toBe("select_account");
    expect(new URL(String(google.searchParams.get("redirect_uri"))).pathname).toBe("/api/auth/callback/google");

    const cancelled = new URL(String(google.searchParams.get("redirect_uri")));
    cancelled.searchParams.set("error", "access_denied");
    cancelled.searchParams.set("state", String(google.searchParams.get("state")));
    await page.goto(cancelled.toString());
    await expect(page.getByRole("status")).toContainText("Sign-in was cancelled");
    const back = new URL(page.url());
    expect([back.pathname, back.searchParams.get("invitation"), back.searchParams.get("account")]).toEqual(["/login", invitationId, "another"]);
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await page.waitForURL(/^https:\/\/accounts\.google\.com\//);
    expect(new URL(page.url()).searchParams.get("prompt")).toBe("select_account");
  });

  test("an ordinary sign-in does not ask Google to choose the account", async ({ page }) => {
    await page.route("https://accounts.google.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>Google</title>" }));
    await page.goto("/login");
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await page.waitForURL(/^https:\/\/accounts\.google\.com\//);
    expect(new URL(page.url()).searchParams.get("prompt")).toBeNull();
  });
});

test.describe("the start page sending a member on to the enrol page", () => {
  test.use({ storageState: MEMBER, userAgent: MAC });

  test("goes to /guard/enrol, where the member can make an enrol link", async ({ page }) => {
    await page.goto(`/start?next=${encodeURIComponent("/guard/enrol")}`);
    await expect(page).toHaveURL(`${REGISTRY_URL}/guard/enrol`);
    await expect(page.getByRole("heading", { name: "Enrol this Mac in Guard" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Make my enrol link" })).toBeVisible();
  });
});
