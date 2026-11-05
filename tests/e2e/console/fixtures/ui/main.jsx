import * as React from "react";
import { createRoot } from "react-dom/client";
import {
  ActiveFrame,
  ActivityLine,
  Badge,
  Button,
  DecisionCard,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogTitle,
  EmptyCard,
  EmptyCardDescription,
  EmptyCardGlyph,
  EmptyCardTitle,
  FollowPill,
  ListAddRow,
  ListCard,
  ListRow,
  MetricCard,
  NewResourceTile,
  ResourceCard,
  ShimmerText,
  StatusDot,
  StatusStrip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableMenuCell,
  TableMenuHead,
  TableRow,
  ThreadStatusRow,
  TouchedStrip,
  WorkLog,
  WorkLogProse,
  WorkLogRow,
  WorkingAvatar,
  formatThoughtFor,
} from "@vibtra/ui/react";
import "./main.css";

window.__events = [];
const log = (...event) => {
  window.__events.push(event);
};

const params = new URLSearchParams(window.location.search);

const LOOPS = ["v-shimmer-text", "v-spin-ring", "v-spin-ring-slow", "v-blink", "v-caret", "v-pulse", "v-pulse-soft", "v-pulse-quick", "v-ping", "v-jiggle", "v-ants"];

const WRITING = { activityKey: "w1", hue: "orange", target: "Lunch poll", action: "Writing src/app/index.html…" };
const READING = { activityKey: "r1", hue: "teal", target: "Read poll", action: "Reading package.json…" };

function ActivityScene() {
  const [item, setItem] = React.useState(WRITING);
  return (
    <>
      <section data-testid="live">
        <ActivityLine item={item} />
      </section>
      <section data-testid="icon">
        <ActivityLine item={{ activityKey: "i", icon: <svg data-testid="activity-icon" />, action: "Inspected scaffold files", live: false }} />
      </section>
      <button type="button" onClick={() => setItem(READING)}>
        Next activity
      </button>
      <button type="button" onClick={() => setItem({ ...WRITING, action: "Writing src/app/app.js…" })}>
        Same activity
      </button>
      <button type="button" onClick={() => setItem(null)}>
        Clear
      </button>
    </>
  );
}

function StatusScene() {
  const [startedAt, setStartedAt] = React.useState(undefined);
  return (
    <>
      <section data-testid="ticking">
        {startedAt === undefined ? null : <StatusStrip sentence="Vibtra is building" working startedAt={startedAt} />}
      </section>
      <section data-testid="idle">
        <StatusStrip sentence="What do you want to do?" />
      </section>
      <section data-testid="fixed">
        <StatusStrip sentence="Vibtra is thinking" working elapsedMs={9_500} />
      </section>
      <button type="button" onClick={() => setStartedAt(Date.now())}>
        Start
      </button>
    </>
  );
}

function Log(props) {
  return (
    <WorkLog summary="Worked for 2m 40s" {...props}>
      <WorkLogRow kind="read" label="Read skill file" />
      <WorkLogProse>I'll make one shared poll.</WorkLogProse>
      <WorkLogRow kind="run" label="Ran Lunch poll">
        200 OK in 41ms
      </WorkLogRow>
      <WorkLogRow kind="think" label={formatThoughtFor(2_000)} />
    </WorkLog>
  );
}

function WorkLogScene() {
  const [open, setOpen] = React.useState(false);
  const [answered, setAnswered] = React.useState(false);
  return (
    <>
      <section data-testid="collapsed">
        <Log />
      </section>
      <section data-testid="open">
        <Log defaultOpen />
      </section>
      <section data-testid="controlled">
        <WorkLog summary="Worked for 5s" open={open} onOpenChange={(next) => log("openChange", next)} />
        <button type="button" onClick={() => setOpen(true)}>
          Open from outside
        </button>
      </section>
      <section data-testid="thread-status">
        {answered ? <ThreadStatusRow tone="done">Question answered: The organiser</ThreadStatusRow> : <ThreadStatusRow tone="waiting">Waiting for answer…</ThreadStatusRow>}
        <button type="button" onClick={() => setAnswered(true)}>
          Answer
        </button>
      </section>
    </>
  );
}

const QUESTIONS = {
  one: [
    {
      id: "q1",
      prompt: "Who should close the poll?",
      options: [
        { id: "a", label: "The organiser" },
        { id: "b", label: "Anyone on the team" },
        { id: "c", label: "Nobody, it closes on a timer" },
      ],
    },
  ],
  three: [
    { id: "q1", prompt: "First?", options: [{ id: "a", label: "A1" }, { id: "b", label: "B1" }] },
    { id: "q2", prompt: "Second?", options: [{ id: "a", label: "A2" }, { id: "b", label: "B2" }] },
    { id: "q3", prompt: "Third?", options: [{ id: "a", label: "A3" }] },
  ],
  details: [{ id: "q", prompt: "Who?", detail: "Pick one.", options: [{ id: "a", label: "Ada", detail: "The organiser" }, { id: "b", label: "Bob" }] }],
  plan: [
    {
      id: "plan",
      prompt: "What would you like to do?",
      allowOther: false,
      options: [
        { id: "approve", label: "Approve and build" },
        { id: "keep", label: "Keep planning" },
      ],
    },
  ],
  wait: [{ id: "r1", prompt: "Waiting for IT to approve Slack", options: [] }],
};

function DecisionScene() {
  const questions = QUESTIONS[params.get("q") ?? "one"] ?? QUESTIONS.one;
  const callbacks = new Set((params.get("on") ?? "answer,complete,skip,chat").split(","));
  const [keyboard, setKeyboard] = React.useState(params.get("keys") !== "0");
  const [mounted, setMounted] = React.useState(true);
  return (
    <>
      {params.get("outside") === "1" ? <textarea aria-label="Another field" /> : null}
      {mounted ? (
        <DecisionCard
          questions={questions}
          keyboard={keyboard}
          {...(params.get("q") === "plan" ? { labels: { skip: "Keep planning" } } : {})}
          {...(callbacks.has("answer") ? { onAnswer: (answer) => log("answer", answer) } : {})}
          {...(callbacks.has("complete") ? { onComplete: (answers) => log("complete", answers) } : {})}
          {...(callbacks.has("skip") ? { onSkip: (questionId, index) => log("skip", questionId, index) } : {})}
          {...(callbacks.has("chat") ? { onChatInstead: () => log("chat") } : {})}
        />
      ) : null}
      <button type="button" onClick={() => setKeyboard(true)}>
        Keyboard on
      </button>
      <button type="button" onClick={() => setMounted(false)}>
        Unmount
      </button>
    </>
  );
}

const TOUCHED = [
  { id: "a", name: "Lunch poll", count: 2 },
  { id: "b", name: "Read poll", count: 1 },
  { id: "c", name: "Update poll", count: 0, hue: "sky" },
];

function BuildScene() {
  const [frame, setFrame] = React.useState("inactive");
  return (
    <>
      <section data-testid="follow" style={{ position: "relative", height: 52 }}>
        <FollowPill name="Vibtra" onStop={() => log("stop")} floating />
      </section>
      <section data-testid="touched">
        <TouchedStrip items={TOUCHED} activeId="b" onSelect={(id) => log("select", id)} activeBadge={<span data-testid="badge" />} />
      </section>
      <section data-testid="frame">
        {frame === "inactive" ? <ActiveFrame>code</ActiveFrame> : frame === "solid" ? <ActiveFrame active hue="teal">code</ActiveFrame> : <ActiveFrame active hues={["orange", "teal", "pink"]}>code</ActiveFrame>}
      </section>
      <button type="button" onClick={() => setFrame("solid")}>
        One step
      </button>
      <button type="button" onClick={() => setFrame("gradient")}>
        Several steps
      </button>
    </>
  );
}

function OnaScene() {
  return (
    <>
      <section data-testid="list-card">
        <ListCard aria-label="Connections">
          <ListRow
            icon={<svg data-testid="mark" />}
            title="Reporting warehouse"
            tags={<Badge size="xs">Postgres</Badge>}
            description="db.fernwood.example · added by Ada"
            end={<Badge tone="ok">Healthy</Badge>}
          />
          <ListAddRow onClick={() => log("add-connection")}>Add connection</ListAddRow>
        </ListCard>
        <ListCard aria-label="Linked">
          <ListRow title="Ticketing" link={<a href="#connections-c1" />} end={<button type="button">Test</button>} />
        </ListCard>
      </section>
      <section data-testid="resource-card">
        <ResourceCard
          icon={<svg />}
          title="open-tickets"
          sub="open-tickets.apps.example"
          status={<Badge tone="ok">Awake</Badge>}
          meta={<span>r3 · 1a2b3c4</span>}
          corner={<button type="button" aria-label="Actions">⋮</button>}
        />
        <NewResourceTile onClick={() => log("promote")}>Promote from a workbox</NewResourceTile>
      </section>
      <section data-testid="pills">
        <Badge tone="ok">me</Badge>
        <Badge size="xs">MCP</Badge>
        <Badge tone="outline">Linear</Badge>
        <Badge tone="mono">us-east-1</Badge>
        <StatusDot tone="ok" label="Running" />
      </section>
      <section data-testid="table">
        <Table bleed aria-label="People">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableMenuHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>Ada</TableCell>
              <TableMenuCell>
                <button type="button" aria-label="Actions for Ada" />
              </TableMenuCell>
            </TableRow>
          </TableBody>
        </Table>
      </section>
      <section data-testid="empty">
        <EmptyCard>
          <EmptyCardGlyph />
          <EmptyCardTitle>No app boxes yet</EmptyCardTitle>
          <EmptyCardDescription>Promote one from a workbox.</EmptyCardDescription>
        </EmptyCard>
        <EmptyCard variant="box">
          <EmptyCardTitle>Nothing waiting</EmptyCardTitle>
          <EmptyCardDescription>Requests appear here.</EmptyCardDescription>
        </EmptyCard>
      </section>
      <section data-testid="metric">
        <MetricCard
          title="Session-hours"
          numbers={[
            { label: "Included", value: "400" },
            { label: "Used", value: "128" },
            { label: "Overage", value: "$0" },
          ]}
          progress={{ value: 128, max: 400 }}
        />
      </section>
    </>
  );
}

function DialogScene() {
  return (
    <Dialog open>
      <DialogContent size="lg" aria-describedby={undefined}>
        <DialogTitle>Invite people</DialogTitle>
        <DialogFooter>
          <Button variant="neutral">Cancel</Button>
          <Button variant="solid">Invite</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ButtonScene() {
  return (
    <section data-testid="buttons">
      <Button variant="solid" loading>
        Create link
      </Button>
      <Button variant="neutral">Cancel</Button>
    </section>
  );
}

function MotionScene() {
  return (
    <>
      <section data-testid="everything">
        <ShimmerText>Writing App.tsx…</ShimmerText>
        <WorkingAvatar working />
        <StatusStrip sentence="Vibtra is building" working elapsedMs={1_000} />
        <ActivityLine item={{ activityKey: "a", hue: "orange", target: "Lunch poll", action: "Writing…" }} />
        <ThreadStatusRow tone="waiting">Waiting for answer…</ThreadStatusRow>
        <ActiveFrame active hues={["orange", "teal", "pink"]}>code</ActiveFrame>
      </section>
      <section data-testid="loop-probes" aria-hidden>
        {LOOPS.map((loop) => (
          <span key={loop} data-loop={loop} className={loop}>
            {loop}
          </span>
        ))}
        <span data-testid="transition-probe" style={{ transition: "opacity 500ms linear" }}>
          transition
        </span>
        <span data-testid="muted-probe" style={{ color: "var(--muted-foreground)" }}>
          muted
        </span>
        <span data-testid="ink-probe" style={{ color: "var(--foreground)" }}>
          ink
        </span>
      </section>
    </>
  );
}

const SCENES = {
  activity: ActivityScene,
  status: StatusScene,
  worklog: WorkLogScene,
  decision: DecisionScene,
  build: BuildScene,
  ona: OnaScene,
  dialog: DialogScene,
  button: ButtonScene,
  motion: MotionScene,
};

function Fixture() {
  const Scene = SCENES[params.get("scene") ?? ""];
  if (Scene === undefined) {
    return (
      <ul aria-label="Scenes">
        {Object.keys(SCENES).map((name) => (
          <li key={name}>
            <a href={`?scene=${name}`}>{name}</a>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <main data-scene={params.get("scene")}>
      <Scene />
    </main>
  );
}

createRoot(document.getElementById("root")).render(<Fixture />);
