import {
  GUARD_CONSOLE_API_PREFIX,
  GuardActivityPage,
  type GuardActivityQuery,
  GuardDeviceRow,
  GuardDevicesPage,
  GuardEnrolLink,
  type GuardEnrolLinkCreate,
  GuardEnrolLinksPage,
  GuardOverviewPage,
  GuardRuleTestResult,
  type GuardRuleTestInput,
  GuardRulesPage,
  type GuardRulesUpdate,
  GuardServiceRow,
  type GuardServiceCreate,
  GuardServicesPage,
  type GuardServiceUpdate,
  GuardSettingsPage,
  type GuardSettingsUpdate,
} from "@vibtra/guard-contract";
import { CONSOLE_API_PREFIX } from "@vibtra/console-api";
import { api, call, queryOf, send, write } from "./client";

const PREFIX = GUARD_CONSOLE_API_PREFIX.slice(CONSOLE_API_PREFIX.length);
const at = (path: string): string => `${PREFIX}${path}`;
const id = (value: string): string => encodeURIComponent(value);

export type ActivityQuery = Partial<Omit<GuardActivityQuery, "limit">> & { limit?: number };

export const guard = {
  overview: (days: 7 | 30 = 7) => call(GuardOverviewPage, at(`/overview${queryOf({ days })}`)),
  activity: (query: ActivityQuery = {}) =>
    call(
      GuardActivityPage,
      at(
        `/activity${queryOf({
          cursor: query.cursor,
          limit: query.limit,
          serviceId: query.serviceId,
          action: query.action,
          deviceId: query.deviceId,
          personUserId: query.personUserId,
          q: query.q,
        })}`,
      ),
    ),
  rules: () => call(GuardRulesPage, at("/rules")),
  putRules: (body: GuardRulesUpdate) => send(GuardRulesPage, "PUT", at("/rules"), body),
  testRules: (body: GuardRuleTestInput) => write(GuardRuleTestResult, at("/rules/test"), body),
  devices: () => call(GuardDevicesPage, at("/devices")),
  enrolLinks: () => call(GuardEnrolLinksPage, at("/devices/enrol-links")),
  createEnrolLink: (body: GuardEnrolLinkCreate) => write(GuardEnrolLink, at("/devices/enrol-links"), body),
  revokeDevice: (deviceId: string) => write(GuardDeviceRow, at(`/devices/${id(deviceId)}/revoke`), {}),
  services: () => call(GuardServicesPage, at("/services")),
  createService: (body: GuardServiceCreate) => write(GuardServiceRow, at("/services"), body),
  updateService: (serviceId: string, body: GuardServiceUpdate) => send(GuardServiceRow, "PUT", at(`/services/${id(serviceId)}`), body),
  deleteService: (serviceId: string) => send(GuardServicesPage, "DELETE", at(`/services/${id(serviceId)}`)),
  settings: () => call(GuardSettingsPage, at("/settings")),
  putSettings: (body: GuardSettingsUpdate) => send(GuardSettingsPage, "PUT", at("/settings"), body),

  policyRequests: (status?: "pending") => api.policyRequests({ kind: "guard", ...(status === undefined ? {} : { status }) }),
  policyRequest: (requestId: string) => api.policyRequest(requestId),
  approve: (requestId: string, decision: { grant: { days?: number; hours?: number; scope?: "user" | "org" }; note?: string }) =>
    api.approvePolicyRequest(requestId, decision),
  decline: (requestId: string, note?: string) => api.declinePolicyRequest(requestId, note),
  policyGrants: async () => {
    const page = await api.policyGrants();
    return { grants: page.grants.filter((grant) => grant.kind === "guard") };
  },
  revokeGrant: (grantId: string) => api.revokePolicyGrant(grantId),
  people: () => api.people(),
};
