import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GUARD_PROTOCOL_VERSION, type GuardClientMode, type GuardDeviceRow, type GuardPreflightRequest } from "@vibtra/guard-contract";
import { startRegistry, type TestRegistry } from "../../support/registry.ts";
import { agentDoor, enrolDevice, preflightBody, type EnrolledDevice } from "../registry/guard-device.ts";
import { manualClock, type ManualClock } from "../registry/server-options.ts";
import { loadConsoleModule, type ConsoleModule } from "./load-console-module.ts";

type Fleet = { DevicePill: ComponentType<{ row: GuardDeviceRow }> };
type Health = NonNullable<GuardPreflightRequest["health"]>;

export const PROVEN: Health = { interception: { on: true }, extensionActive: true };
export const SECONDS = 1000;
export const MINUTES = 60 * SECONDS;

export interface Laptop extends EnrolledDevice {
  hostname: string;
}

export interface Pill {
  state: string;
  tone: string;
  label: string;
}

export interface FleetBed {
  registry: TestRegistry;
  clock: ManualClock;
  enrol: (hostname: string) => Promise<Laptop>;
  checkIn: (laptop: Laptop, clientMode: GuardClientMode, health?: Health) => Promise<void>;
  applyPolicy: (laptop: Laptop, clientMode: GuardClientMode) => Promise<void>;
  synced: (hostname: string, clientMode?: GuardClientMode, health?: Health) => Promise<Laptop>;
  revoke: (laptop: Laptop) => Promise<void>;
  settings: (update: Record<string, unknown>) => Promise<void>;
  rowOf: (laptop: Laptop) => Promise<GuardDeviceRow>;
  pillOf: (laptop: Laptop) => Promise<Pill>;
  close: () => Promise<void>;
}

const attribute = (markup: string, name: string): string => markup.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? "";

export const startFleetBed = async (domain: string): Promise<FleetBed> => {
  const clock = manualClock();
  const registry = await startRegistry({ domain, configure: (options) => ({ ...options, clock }) });
  let fleet: ConsoleModule<Fleet>;
  try {
    fleet = await loadConsoleModule<Fleet>("/src/people/fleet.tsx");
  } catch (error) {
    await registry.close();
    throw error;
  }
  const { owner, member } = registry.people;
  const expectOk = (reply: { status: number; text: string }, what: string): void => {
    if (reply.status !== 200) throw new Error(`${what} answered ${reply.status}: ${reply.text.slice(0, 300)}`);
  };

  const bed: FleetBed = {
    registry,
    clock,
    enrol: async (hostname) => ({ ...(await enrolDevice(registry, owner, member, hostname)), hostname }),
    checkIn: async (laptop, clientMode, health) => {
      const body = preflightBody(laptop.hostname, { clientMode, ...(health === undefined ? {} : { health }) });
      expectOk(await agentDoor(registry, "POST", `/preflight/${laptop.deviceId}`, laptop.token, body), `the preflight of ${laptop.hostname}`);
    },
    applyPolicy: async (laptop, clientMode) => {
      const body = { protocol: GUARD_PROTOCOL_VERSION, bundleVersion: 0, catalogueVersion: "x", rulesReceived: 0, rulesProcessed: 0, clientMode };
      expectOk(await agentDoor(registry, "POST", `/postflight/${laptop.deviceId}`, laptop.token, body), `the postflight of ${laptop.hostname}`);
    },
    synced: async (hostname, clientMode = "enforce", health = PROVEN) => {
      const laptop = await bed.enrol(hostname);
      await bed.checkIn(laptop, clientMode, health);
      await bed.applyPolicy(laptop, clientMode);
      return laptop;
    },
    revoke: async (laptop) => expectOk(await registry.consoleWrite(owner, "POST", `/guard/devices/${laptop.deviceId}/revoke`, {}), `revoking ${laptop.hostname}`),
    settings: async (update) => expectOk(await registry.consoleWrite(owner, "PUT", "/guard/settings", update), "the settings change"),
    rowOf: async (laptop) => {
      const page = (await registry.consoleGet(owner, "/guard/devices")).body as { rows: GuardDeviceRow[] };
      const row = page.rows.find((device) => device.deviceId === laptop.deviceId);
      if (row === undefined) throw new Error(`${laptop.hostname} is not on the devices page`);
      return row;
    },
    pillOf: async (laptop) => {
      const markup = renderToStaticMarkup(createElement(fleet.module.DevicePill, { row: await bed.rowOf(laptop) }));
      return { state: attribute(markup, "data-state"), tone: attribute(markup, "data-tone"), label: markup.replace(/<[^>]*>/g, "") };
    },
    close: async () => {
      await fleet.close();
      await registry.close();
    },
  };
  return bed;
};
