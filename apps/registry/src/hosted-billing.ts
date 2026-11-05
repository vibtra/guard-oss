import type { FastifyInstance, FastifyRequest } from "fastify";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RegistrySession } from "./auth/session.js";
import type { RegistryConfig } from "./config.js";
import type { ConsoleApiContext } from "./console-api/routes.js";
import type { Clock } from "./metering/clock.js";
import type { MeteringService, MeteringServiceOptions } from "./metering/service.js";
import type { RegistryService } from "./service.js";
import type { OrgRow, TenancyStore } from "./tenancy/store.js";

export type HostedBillingFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface HostedBillingEndpoint {
  host: string;
  port: number;
  protocol: "http" | "https";
}

export interface HostedBillingInput {
  config: NonNullable<RegistryConfig["hosted"]>;
  baseUrl: string;
  tenancy: TenancyStore;
  vault: RegistryService["vault"];
  meteringStore: RegistryService["metering"];
  metering: () => MeteringService | undefined;
  clock: Clock;
  log: (line: string) => void;
  stripeFetch?: HostedBillingFetch | undefined;
  stripeEndpoint?: HostedBillingEndpoint | undefined;
}

export interface HostedBillingConsoleExtras {
  startCheckout?: ConsoleApiContext["startCheckout"];
  selfServePlanIds: readonly string[];
  billingEnabled: boolean;
  openPortal?: (args: { customerId: string; handle?: string | undefined }) => Promise<{ url: string } | undefined>;
  planIdForStripePrice: (priceId: string | undefined) => string | undefined;
  invoicePreview?: (org: OrgRow) => Promise<unknown>;
}

export interface HostedBilling {
  overflowSeats: boolean;
  report?: MeteringServiceOptions["report"];
  console: HostedBillingConsoleExtras;
  registerRoutes(app: FastifyInstance): void;
  registerConsoleRoutes(
    app: FastifyInstance,
    service: RegistryService,
    ctx: ConsoleApiContext,
    sessionOf: (req: FastifyRequest) => RegistrySession,
  ): void;
}

export interface HostedBillingModule {
  create(input: HostedBillingInput): HostedBilling;
}

export const HOSTED_BILLING_MODULE = new URL("./billing/hosted.js", import.meta.url).href;

const present = (specifier: string): boolean => {
  if (!specifier.startsWith("file:")) return true;
  const file = fileURLToPath(specifier);
  return existsSync(file) || existsSync(file.replace(/\.js$/, ".ts"));
};

export const loadHostedBilling = async (specifier: string = HOSTED_BILLING_MODULE): Promise<HostedBillingModule | undefined> => {
  if (!present(specifier)) return undefined;
  const loaded = (await import(specifier)) as { hostedBilling?: HostedBillingModule };
  return loaded.hostedBilling;
};
