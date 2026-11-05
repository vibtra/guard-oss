import { describe, expect, it } from "vitest";
import {
  CONSOLE_GROUP_NAME_MAX,
  CONSOLE_RESPONSE_SCHEMAS,
  ConsoleGroupInUse,
  ConsoleGroupMemberRequest,
  ConsoleGroupNameRequest,
  ConsoleGroupRow,
  ConsoleMyGroupsPage,
  ConsoleScope,
  isBannedFieldName,
  MY_GROUPS_RESPONSE_SCHEMAS,
} from "@vibtra/console-api";

describe("ConsoleGroupRow", () => {
  const row = {
    id: "team_hr",
    name: "HR",
    members: [
      { email: "ada@acme.example", name: "Ada" },
      { email: "bea@acme.example", name: null },
    ],
    memberCount: 2,
    usedBy: { tools: 2, connections: 1 },
    createdAt: "2026-09-09T00:00:00.000Z",
    createdBy: "ada@acme.example",
  };

  it("parses a group with named and unnamed members", () => {
    expect(ConsoleGroupRow.parse(row).members).toHaveLength(2);
  });

  it("parses a MEMBER's row — a size, a name, a usage, and no address at all", () => {
    const { members: _members, createdBy: _createdBy, ...forAMember } = row;
    const parsed = ConsoleGroupRow.safeParse(forAMember);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.members).toBeUndefined();
    expect(parsed.data.createdBy).toBeUndefined();
    expect(parsed.data.memberCount).toBe(2);
    expect(JSON.stringify(parsed.data)).not.toContain("@");
  });

  it("requires the COUNT even when the roster is withheld", () => {
    const { members: _members, memberCount: _count, ...neither } = row;
    expect(ConsoleGroupRow.safeParse(neither).success).toBe(false);
    expect(ConsoleGroupRow.safeParse({ ...row, memberCount: -1 }).success).toBe(false);
    expect(ConsoleGroupRow.safeParse({ ...row, members: [], memberCount: 0 }).success).toBe(true);
  });

  it("keeps a missing display name as null rather than absent", () => {
    expect(ConsoleGroupRow.safeParse({ ...row, members: [{ email: "a@b.example" }] }).success).toBe(false);
  });

  it("refuses a group with no id, no name or an EMPTY creator", () => {
    for (const field of ["id", "name", "createdBy", "createdAt"] as const) {
      expect(ConsoleGroupRow.safeParse({ ...row, [field]: "" }).success, field).toBe(false);
    }
  });

  it("carries no field a credential could travel in", () => {
    for (const key of Object.keys(ConsoleGroupRow.shape)) {
      expect(isBannedFieldName(key), key).toBe(false);
    }
    for (const key of ["email", "name"]) expect(isBannedFieldName(key), key).toBe(false);
  });
});

describe("the group write requests", () => {
  it("bounds a group name at the display-name ceiling", () => {
    expect(ConsoleGroupNameRequest.safeParse({ name: "x".repeat(CONSOLE_GROUP_NAME_MAX) }).success).toBe(true);
    expect(ConsoleGroupNameRequest.safeParse({ name: "x".repeat(CONSOLE_GROUP_NAME_MAX + 1) }).success).toBe(false);
    expect(ConsoleGroupNameRequest.safeParse({ name: "" }).success).toBe(false);
  });

  it("takes an address to add a member, and nothing else", () => {
    expect(ConsoleGroupMemberRequest.parse({ email: "ada@acme.example" }).email).toBe("ada@acme.example");
    expect(ConsoleGroupMemberRequest.safeParse({ email: "" }).success).toBe(false);
  });
});

describe("a groups audience carries ids, and the names ride beside them", () => {
  it("keeps group ids in `subjects` and names in `subjectNames`", () => {
    const scope = ConsoleScope.parse({
      kind: "groups",
      summary: "1 group",
      subjects: ["team_hr"],
      subjectNames: ["HR"],
      unknown: false,
    });
    expect(scope.subjects).toEqual(["team_hr"]);
    expect(scope.subjectNames).toEqual(["HR"]);
  });

  it("leaves `subjectNames` absent on every other kind", () => {
    const people = ConsoleScope.parse({
      kind: "people",
      summary: "1 named person",
      subjects: ["ada@acme.example"],
      unknown: false,
    });
    expect(people.subjectNames).toBeUndefined();
  });
});

describe("the delete refusal", () => {
  it("names the tools and connections that must be unscoped first", () => {
    const parsed = ConsoleGroupInUse.parse({
      message: "That group is still in use",
      usedBy: { tools: [{ id: "tool_payroll", name: "Payroll" }], connections: [] },
    });
    expect(parsed.usedBy.tools[0]?.name).toBe("Payroll");
  });

  it("is registered as a door so the banned-field walk covers it", () => {
    expect(Object.keys(CONSOLE_RESPONSE_SCHEMAS)).toContain("DELETE /groups/:id?inUse");
  });
});

describe("the six group doors are declared", () => {
  it("registers every path the console codes against", () => {
    for (const door of [
      "GET /groups",
      "POST /groups",
      "PATCH /groups/:id",
      "POST /groups/:id/members",
      "DELETE /groups/:id/members/:email",
    ] as const) {
      expect(CONSOLE_RESPONSE_SCHEMAS[door], door).toBeDefined();
    }
  });

  it("gives the DELETE no success body — a removal has nothing true to say", () => {
    expect(Object.keys(CONSOLE_RESPONSE_SCHEMAS)).not.toContain("DELETE /groups/:id");
  });
});

describe("GET /me/groups — the signed-in person's own groups", () => {
  it("answers ids and names only: no roster, no count, no address", () => {
    const row = ConsoleMyGroupsPage.shape.rows.element;
    expect(Object.keys(row.shape).sort()).toEqual(["id", "name"]);
    expect(Object.keys(row.shape).filter(isBannedFieldName)).toEqual([]);
    expect(
      ConsoleMyGroupsPage.parse({ rows: [{ id: "g1", name: "Finance", members: [{ email: "x@y" }] }] }),
    ).toEqual({ rows: [{ id: "g1", name: "Finance" }] });
  });

  it("answers through its own door map", () => {
    expect(MY_GROUPS_RESPONSE_SCHEMAS["GET /me/groups"]).toBe(ConsoleMyGroupsPage);
  });
});
