import * as React from "react";
import { BanIcon, CircleCheckIcon, CircleDashedIcon, CircleHelpIcon, CopyIcon, EyeIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { toast, toastError } from "@vibtra/ui/react";
import {
  GUARD_ACTIVATABLE_SURFACES,
  GUARD_SERVICE_CATEGORIES,
  GUARD_SURFACE_IDS,
  GUARD_SURFACE_SERVICE_IDS,
  GuardRulesUpdate,
  GuardServiceCreate,
  type GuardFlowAction,
  type GuardRulesPage,
  type GuardServiceCategory,
  type GuardServiceRow,
  type GuardServicesPage,
  type GuardSurfaceId,
} from "@vibtra/guard-contract";
import { guard } from "../api/guard";
import { ConsoleApiError, refusalWords } from "../api/client";
import { useDoor } from "../api/useDoor";
import { DoorError } from "../shell/DoorState";
import {
  ActionButton,
  CellTitle,
  ConfirmModal,
  CountBadge,
  DataTable,
  EmptyState,
  EMPTY,
  Field,
  FieldStack,
  FormSheet,
  ListToolbar,
  Modal,
  ModalFooter,
  PageHeader,
  Pill,
  Problem,
  SegmentedTabs,
  SelectInput,
  SheetList,
  SheetListRow,
  StatCard,
  StatRow,
  TextAreaInput,
  TextInput,
  Toggle,
  useHeld,
  type SelectOption,
} from "@/components/kit";
import { copyToClipboard } from "@/lib/copy";
import { CATEGORY_WORD, FLOW_WORD, categoryWord } from "../guard/words";
import { PageLoading, ServiceTile, TableFoot } from "../guard/parts";

const INHERIT = "inherit";
type View = "services" | "apps" | "clis";
type Row = { kind: "service"; service: GuardServiceRow } | { kind: "surface"; service: GuardServiceRow; surface: GuardSurfaceId };

const SURFACE_WORD: Readonly<Record<GuardSurfaceId, { title: string; sub: string }>> = {
  "claude-web": { title: "Claude website", sub: "Chat in Google Chrome" },
  "claude-macos": { title: "Claude Mac app", sub: "Chat in the app" },
  "chatgpt-web": { title: "ChatGPT website", sub: "Chat in Google Chrome" },
  "chatgpt-macos": { title: "ChatGPT Mac app", sub: "ChatGPT and Codex, blocked together" },
};

const surfacesOf = (serviceId: string): GuardSurfaceId[] => GUARD_SURFACE_IDS.filter((id) => GUARD_SURFACE_SERVICE_IDS[id] === serviceId);

const defaultOptions = (inheritDisabled: boolean): SelectOption<GuardFlowAction | typeof INHERIT>[] => [
  { value: INHERIT, label: "Inherit", icon: CircleDashedIcon, iconClassName: "text-g-muted", disabled: inheritDisabled },
  { value: "allow", label: FLOW_WORD.allow.label, icon: CircleCheckIcon, iconClassName: "text-g-dot-ok", separatorBefore: true },
  { value: "block", label: FLOW_WORD.block.label, icon: BanIcon, iconClassName: "text-g-danger" },
  { value: "ask", label: FLOW_WORD.ask.label, icon: CircleHelpIcon, iconClassName: "text-g-dot-warn" },
];

const SURFACE_OPTIONS: SelectOption<"allowed" | "blocked">[] = [
  { value: "allowed", label: "Allowed", icon: CircleCheckIcon, iconClassName: "text-g-dot-ok" },
  { value: "blocked", label: "Blocked", icon: BanIcon, iconClassName: "text-g-danger" },
];

const CATEGORY_OPTIONS: SelectOption<GuardServiceCategory>[] = GUARD_SERVICE_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_WORD[c] }));

const linesOf = (text: string): string[] => [...new Set(text.split(/[\n,]+/).map((l) => l.trim()).filter((l) => l !== ""))];

const FIELD_PROBLEM: Record<string, string> = {
  name: "Give the service a name.",
  slug: "Use lowercase letters, digits and hyphens for the ID.",
  vendor: "Name the vendor.",
  category: "Pick a category.",
  domains: "Add at least one domain, one per line.",
  bundleIds: "Check the Mac app bundle IDs.",
  cliNames: "Check the CLI names.",
};
const FIELD_ORDER = ["name", "slug", "vendor", "category", "domains", "bundleIds", "cliNames"] as const;
const FIELD_ID: Record<(typeof FIELD_ORDER)[number], string> = {
  name: "svc-name",
  slug: "svc-slug",
  vendor: "svc-vendor",
  category: "svc-category",
  domains: "svc-domains",
  bundleIds: "svc-bundles",
  cliNames: "svc-clis",
};

function RowControl({ children }: { children: React.ReactNode }) {
  return (
    <span data-row-stop className="contents" onClick={(event) => event.stopPropagation()}>
      {children}
    </span>
  );
}

export function AddServiceSheet({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const [slug, setSlug] = React.useState("");
  const [name, setName] = React.useState("");
  const [vendor, setVendor] = React.useState("");
  const [category, setCategory] = React.useState<GuardServiceCategory>("chat");
  const [domains, setDomains] = React.useState("");
  const [bundleIds, setBundleIds] = React.useState("");
  const [cliNames, setCliNames] = React.useState("");
  const [problem, setProblem] = React.useState<string | undefined>(undefined);
  const [problemFields, setProblemFields] = React.useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = React.useState(false);
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setSlug("");
      setName("");
      setVendor("");
      setCategory("chat");
      setDomains("");
      setBundleIds("");
      setCliNames("");
      setProblem(undefined);
      setProblemFields(new Set());
    }
  }
  const fieldProblem = (field: (typeof FIELD_ORDER)[number]) =>
    problemFields.has(field) ? { "aria-invalid": true as const, "aria-describedby": `${FIELD_ID[field]}-error` } : {};
  const errorOf = (field: (typeof FIELD_ORDER)[number]) => (problemFields.has(field) ? FIELD_PROBLEM[field] : undefined);
  const add = async () => {
    const parsed = GuardServiceCreate.safeParse({
      slug: slug.trim().toLowerCase(),
      name: name.trim(),
      vendor: vendor.trim(),
      category,
      domains: linesOf(domains).map((d) => d.toLowerCase()),
      bundleIds: linesOf(bundleIds),
      cliNames: linesOf(cliNames),
    });
    if (!parsed.success) {
      const fields = parsed.error.issues.map((i) => String(i.path[0] ?? ""));
      setProblemFields(new Set(fields));
      setProblem(fields.some((f) => !(FIELD_ORDER as readonly string[]).includes(f)) ? "Check the form and add the service again." : undefined);
      const first = FIELD_ORDER.find((f) => fields.includes(f));
      if (first !== undefined) document.getElementById(FIELD_ID[first])?.focus();
      return;
    }
    setProblem(undefined);
    setProblemFields(new Set());
    setBusy(true);
    try {
      const row = await guard.createService(parsed.data);
      toast.success(`${row.name} is in the catalogue. Laptops start recognising it at their next check-in.`);
      onAdded();
    } catch (error) {
      const words = refusalWords(error);
      setProblem(words);
      toastError(`${parsed.data.name} was not added`, words);
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormSheet
      open={open}
      onClose={onClose}
      title="Add a service"
      description="An AI service the catalogue does not list yet. Laptops decrypt only these domains. Every other site stays untouched."
      primaryLabel="Add service"
      onPrimary={() => void add()}
      busy={busy}
    >
      <FieldStack>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="svc-name" error={errorOf("name")}>
            <TextInput id="svc-name" {...fieldProblem("name")} maxLength={80} placeholder="Acme Assistant" value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field label="ID" htmlFor="svc-slug" error={errorOf("slug")}>
            <TextInput id="svc-slug" {...fieldProblem("slug")} maxLength={48} placeholder="acme-assistant" className="font-mono" value={slug} onChange={(event) => setSlug(event.target.value)} />
          </Field>
          <Field label="Vendor" htmlFor="svc-vendor" error={errorOf("vendor")}>
            <TextInput id="svc-vendor" {...fieldProblem("vendor")} maxLength={80} placeholder="Acme" value={vendor} onChange={(event) => setVendor(event.target.value)} />
          </Field>
          <Field label="Category" htmlFor="svc-category" error={errorOf("category")}>
            <SelectInput<GuardServiceCategory> id="svc-category" {...fieldProblem("category")} value={category} onValueChange={setCategory} options={CATEGORY_OPTIONS} />
          </Field>
        </div>
        <Field label="Domains, one per line" htmlFor="svc-domains" hint="A domain matches itself and its subdomains. * stands for one label." error={errorOf("domains")}>
          <TextAreaInput id="svc-domains" className="font-mono text-13 max-md:text-16" {...fieldProblem("domains")} rows={3} placeholder={"assistant.acme.com\n*.acme-ai.net"} value={domains} onChange={(event) => setDomains(event.target.value)} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Mac app bundle IDs" htmlFor="svc-bundles" hint="Optional." error={errorOf("bundleIds")}>
            <TextAreaInput id="svc-bundles" className="font-mono text-13 max-md:text-16" {...fieldProblem("bundleIds")} rows={2} placeholder="com.acme.assistant" value={bundleIds} onChange={(event) => setBundleIds(event.target.value)} />
          </Field>
          <Field label="CLI names" htmlFor="svc-clis" hint="Optional." error={errorOf("cliNames")}>
            <TextAreaInput id="svc-clis" className="font-mono text-13 max-md:text-16" {...fieldProblem("cliNames")} rows={2} placeholder="acme" value={cliNames} onChange={(event) => setCliNames(event.target.value)} />
          </Field>
        </div>
        {problem === undefined ? null : <Problem id="svc-problem">{problem}</Problem>}
      </FieldStack>
    </FormSheet>
  );
}

function ServiceDetailsModal({ open, service, onClose }: { open: boolean; service: GuardServiceRow; onClose: () => void }) {
  const lists: { label: string; items: string[] }[] = [
    { label: "Domains", items: service.domains },
    { label: "Mac apps", items: service.bundleIds },
    { label: "CLIs", items: service.cliNames.map((c) => `$ ${c}`) },
  ].filter((l) => l.items.length > 0);
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="list"
      role="dialog"
      title={`Where ${service.name} is recognised`}
      description={`${service.vendor} · ${categoryWord(service.category)}${service.custom ? " · Added by your organisation" : ""}`}
      footer={<ModalFooter start={<ActionButton onClick={onClose}>Close</ActionButton>} />}
    >
      <div data-testid="service-details" className="flex flex-col gap-5">
        {lists.length === 0 ? <EmptyState title="Nothing listed" description="This service names no domain, app or CLI." className="py-6" /> : null}
        {lists.map((list) => (
          <section key={list.label} className="flex flex-col gap-2">
            <p className="text-13 text-g-muted">{list.label}</p>
            <SheetList label={list.label} items={list.items} itemKey={(v) => v} render={(v) => <SheetListRow title={<span className="font-mono text-13">{v}</span>} />} />
          </section>
        ))}
        {service.note === undefined ? null : <p className="text-12 text-pretty text-g-muted">{service.note}</p>}
      </div>
    </Modal>
  );
}

export function Services() {
  const door = useDoor(() => guard.services(), []);
  const rulesDoor = useDoor(() => guard.rules(), []);
  const [held, setHeld] = React.useState<GuardServicesPage | undefined>(undefined);
  const [heldRules, setHeldRules] = React.useState<GuardRulesPage | undefined>(undefined);
  const [adding, setAdding] = React.useState(false);
  const [deleting, setDeleting] = React.useState<GuardServiceRow | undefined>(undefined);
  const [details, setDetails] = React.useState<GuardServiceRow | undefined>(undefined);
  const heldDetails = useHeld(details);
  const heldDeleting = useHeld(deleting);
  const [busy, setBusy] = React.useState<string | undefined>(undefined);
  const [query, setQuery] = React.useState("");
  const [view, setView] = React.useState<View>("services");
  React.useEffect(() => {
    if (door.state.status === "ready") setHeld(undefined);
  }, [door.state]);
  React.useEffect(() => {
    if (rulesDoor.state.status === "ready") setHeldRules(undefined);
  }, [rulesDoor.state]);

  if (door.state.status === "loading") return <PageLoading />;
  if (door.state.status === "error") return <DoorError error={door.state.error} onRetry={door.reload} />;
  const page = held ?? door.state.data;
  const rules = heldRules ?? (rulesDoor.state.status === "ready" ? rulesDoor.state.data : undefined);
  const q = query.trim().toLowerCase();
  const inView = (r: GuardServiceRow) => (view === "apps" ? r.bundleIds.length > 0 : view === "clis" ? r.cliNames.length > 0 : true);
  const rows: Row[] = page.rows
    .filter((r) => inView(r) && (q === "" || [r.name, r.vendor, r.serviceId, ...r.domains, ...r.bundleIds, ...r.cliNames].some((v) => v.toLowerCase().includes(q))))
    .map((service) => ({ kind: "service", service }));
  const blockedSurfaces = rules === undefined ? undefined : GUARD_SURFACE_IDS.filter((id) => rules.document.surfaceBlocks?.[id] === true).length;

  const update = async (row: GuardServiceRow, body: { enabled?: boolean; defaultAction?: GuardFlowAction }) => {
    setBusy(row.serviceId);
    try {
      const next = await guard.updateService(row.serviceId, body);
      setHeld({ ...page, rows: page.rows.map((r) => (r.serviceId === next.serviceId ? next : r)) });
      door.reload();
    } catch (error) {
      toastError(`${row.name} was not changed`, refusalWords(error));
    } finally {
      setBusy(undefined);
    }
  };
  const remove = async (row: GuardServiceRow) => {
    setBusy(row.serviceId);
    try {
      setHeld(await guard.deleteService(row.serviceId));
      toast.success(`${row.name} left the catalogue.`);
    } catch (error) {
      toastError(`${row.name} was not deleted`, refusalWords(error));
    } finally {
      setBusy(undefined);
      setDeleting(undefined);
    }
  };
  const setSurface = async (surface: GuardSurfaceId, blocked: boolean) => {
    if (rules === undefined) return;
    const doc = rules.document;
    const surfaceBlocks = { ...doc.surfaceBlocks };
    if (blocked) surfaceBlocks[surface] = true;
    else delete surfaceBlocks[surface];
    const body = GuardRulesUpdate.safeParse({
      baseVersion: doc.version,
      document: { defaultAction: doc.defaultAction, surfaceBlocks, serviceRules: doc.serviceRules, contentRules: doc.contentRules },
    });
    const words = SURFACE_WORD[surface].title;
    if (!body.success) {
      toastError(`${words} was not changed`, "The rules on this page are out of date. Reload the page and try again.");
      return;
    }
    setBusy(surface);
    try {
      setHeldRules(await guard.putRules(body.data));
      toast.success(`${words} is ${blocked ? "blocked" : "allowed"}. Laptops pick it up at their next check-in (about a minute).`);
    } catch (error) {
      if (error instanceof ConsoleApiError && error.code === "STALE_BASE") {
        toastError(`${words} was not changed`, "The rules changed somewhere else. They have been reloaded, so try again.");
        setHeldRules(undefined);
        rulesDoor.reload();
      } else if (error instanceof ConsoleApiError) {
        toastError(`${words} was not changed`, refusalWords(error, ""));
      } else toastError(`${words} was not changed`, refusalWords(error));
    } finally {
      setBusy(undefined);
    }
  };

  const defaultSelect = (row: GuardServiceRow) => (
    <RowControl>
    <SelectInput<GuardFlowAction | typeof INHERIT>
      size="sm"
      aria-label={`Default for ${row.name}`}
      wrapperClassName="w-[168px]"
      disabled={busy === row.serviceId}
      value={row.defaultAction ?? INHERIT}
      options={defaultOptions(row.defaultAction !== undefined && row.seedDefaultAction === undefined)}
      onValueChange={(v) => {
        if (v === INHERIT) {
          if (row.seedDefaultAction !== undefined) void update(row, { defaultAction: row.seedDefaultAction });
          return;
        }
        void update(row, { defaultAction: v });
      }}
    />
    </RowControl>
  );

  const surfaceSelect = (surface: GuardSurfaceId) => {
    if (rules === undefined) return <span className="text-g-muted">{EMPTY}</span>;
    const blocked = rules.document.surfaceBlocks?.[surface] === true;
    const available = GUARD_ACTIVATABLE_SURFACES.includes(surface);
    return (
      <RowControl>
      <SelectInput<"allowed" | "blocked">
        size="sm"
        aria-label={`${SURFACE_WORD[surface].title} access`}
        wrapperClassName="w-[168px]"
        disabled={busy === surface || (!available && !blocked)}
        value={blocked ? "blocked" : "allowed"}
        options={SURFACE_OPTIONS}
        onValueChange={(v) => void setSurface(surface, v === "blocked")}
      />
      </RowControl>
    );
  };

  const sub = (r: GuardServiceRow): string =>
    view === "apps"
      ? r.bundleIds.join(", ")
      : view === "clis"
        ? r.cliNames.map((c) => `$ ${c}`).join(", ")
        : `${r.vendor} · ${categoryWord(r.category)}${r.custom ? " · Added by your organisation" : ""}`;

  const counts = {
    services: page.rows.length,
    apps: page.rows.filter((r) => r.bundleIds.length > 0).length,
    clis: page.rows.filter((r) => r.cliNames.length > 0).length,
  };

  return (
    <div data-testid="services-page" className="flex flex-col">
      <PageHeader
        className="mb-4"
        actions={
          <ActionButton variant="primary" icon={PlusIcon} onClick={() => setAdding(true)} data-testid="add-service">
            Add a service
          </ActionButton>
        }
      />
      <StatRow label="Catalogue totals">
        <StatCard label="In the catalogue" value={page.rows.length.toLocaleString("en-US")} />
        <StatCard label="Used in 30 days" value={page.rows.filter((r) => r.people30d > 0 || r.devices30d > 0).length.toLocaleString("en-US")} />
        <StatCard label="Blocked by default" value={page.rows.filter((r) => r.defaultAction === "block").length.toLocaleString("en-US")} />
        <StatCard label="Surfaces blocked" value={blockedSurfaces === undefined ? undefined : `${blockedSurfaces} of ${GUARD_SURFACE_IDS.length}`} />
      </StatRow>

      <ListToolbar
        views={
          <SegmentedTabs<View>
            size="list"
            label="Catalogue views"
            idPrefix="svc"
            value={view}
            onValueChange={setView}
            items={[
              { value: "services", label: "Services", count: counts.services },
              { value: "apps", label: "Mac apps", count: counts.apps },
              { value: "clis", label: "CLIs", count: counts.clis },
            ]}
          />
        }
        search={{ value: query, onChange: setQuery, placeholder: "Search by name, vendor, domain, app or CLI" }}
      />

      <div role="tabpanel" id={`svc-panel-${view}`} aria-labelledby={`svc-tab-${view}`}>
        <DataTable<Row>
          label="AI services"
          rows={rows}
          rowKey={(r) => (r.kind === "service" ? r.service.serviceId : `${r.service.serviceId}:${r.surface}`)}
          subRows={(r) => (r.kind === "service" ? surfacesOf(r.service.serviceId).map((surface) => ({ kind: "surface", service: r.service, surface })) : undefined)}
          onRowClick={(r) => setDetails(r.service)}
          rowLabel={(r) => (r.kind === "service" ? `${r.service.name}, where it is recognised` : `${SURFACE_WORD[r.surface].title}, ${r.service.name}`)}
          expandLabel={(r, expanded) => `${expanded ? "Hide" : "Show"} surfaces for ${r.service.name}`}
          rowMenu={(r) =>
            r.kind === "surface"
              ? []
              : [
                  { label: "View details", icon: EyeIcon, onSelect: () => setDetails(r.service) },
                  { label: "Copy ID", icon: CopyIcon, onSelect: () => copyToClipboard(r.service.serviceId, "Service ID") },
                  ...(r.service.custom ? [{ label: "Delete…", icon: Trash2Icon, destructive: true, separatorBefore: true, onSelect: () => setDeleting(r.service) }] : []),
                ]
          }
          menuLabel={(r) => `Actions for ${r.service.name}`}
          minWidth={980}
          empty={
            q === "" ? (
              <EmptyState title={view === "apps" ? "No Mac apps listed" : view === "clis" ? "No CLIs listed" : "No services"} description="The catalogue lists none of these yet." />
            ) : (
              <EmptyState
                title={`No service matches “${query.trim()}”`}
                description="Try a different search, or clear it to see the whole catalogue."
                action={
                  <ActionButton static onClick={() => setQuery("")}>
                    Clear search
                  </ActionButton>
                }
              />
            )
          }
          columns={[
            {
              id: "service",
              header: "Service",
              cell: (r) =>
                r.kind === "surface" ? (
                  <CellTitle title={SURFACE_WORD[r.surface].title} sub={SURFACE_WORD[r.surface].sub} />
                ) : (
                  <CellTitle
                    icon={<ServiceTile serviceId={r.service.serviceId} markId={r.service.markId} />}
                    title={
                      <span className="inline-flex min-w-0 items-center gap-2" data-testid="service-name" data-enabled={r.service.enabled ? "true" : "false"}>
                        <span className="truncate">{r.service.name}</span>
                        {r.service.enabled ? null : <Pill tone="muted">Off</Pill>}
                      </span>
                    }
                    sub={sub(r.service)}
                  />
                ),
            },
            { id: "people", header: "People", width: "88px", cell: (r) => (r.kind === "surface" ? null : <CountBadge count={r.service.people30d} aria-label={`${r.service.people30d} people in 30 days`} />) },
            { id: "devices", header: "Devices", width: "88px", cell: (r) => (r.kind === "surface" ? null : <CountBadge count={r.service.devices30d} aria-label={`${r.service.devices30d} devices in 30 days`} />) },
            { id: "default", header: "Default", width: "184px", cell: (r) => (r.kind === "surface" ? null : defaultSelect(r.service)) },
            {
              id: "surface",
              header: "Surfaces",
              width: "184px",
              cell: (r) =>
                r.kind === "surface" ? surfaceSelect(r.surface) : surfacesOf(r.service.serviceId).length > 0 ? <span className="text-13 text-g-muted">Per surface</span> : <span className="text-g-muted">{EMPTY}</span>,
            },
            {
              id: "on",
              header: "On",
              width: "72px",
              cell: (r) =>
                r.kind === "surface" ? null : (
                  <Toggle aria-label={`${r.service.name} on`} checked={r.service.enabled} disabled={busy === r.service.serviceId} onCheckedChange={(on) => void update(r.service, { enabled: on })} />
                ),
            },
          ]}
        />
        <TableFoot>
          Catalogue {page.catalogueVersion} (seed {page.seedVersion}). A domain matches itself and its subdomains.
        </TableFoot>
      </div>

      <AddServiceSheet
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={() => {
          setAdding(false);
          door.reload();
        }}
      />
      {heldDetails.value === undefined ? null : <ServiceDetailsModal open={heldDetails.open} service={heldDetails.value} onClose={() => setDetails(undefined)} />}
      {heldDeleting.value === undefined ? null : (
        <ConfirmModal
          open={heldDeleting.open}
          onClose={() => setDeleting(undefined)}
          title={`Delete ${heldDeleting.value.name}?`}
          confirmLabel="Delete service"
          cancelLabel="Cancel"
          busy={busy === heldDeleting.value.serviceId}
          onConfirm={() => {
            if (deleting !== undefined) void remove(deleting);
          }}
        >
          Laptops stop recognising it at their next check-in. Its domains pass untouched and rules naming it no longer apply. Past activity stays.
        </ConfirmModal>
      )}
    </div>
  );
}
