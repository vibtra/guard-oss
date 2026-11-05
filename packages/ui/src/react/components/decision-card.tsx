import * as React from "react";
import { CornerDownLeftIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { Kbd, KbdHint } from "./kbd";

export type DecisionOption = {
  id: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  text?: string;
  detail?: React.ReactNode;
};

export type DecisionQuestion = {
  id: string;
  prompt: React.ReactNode;
  options: readonly DecisionOption[];
  detail?: React.ReactNode;
  allowOther?: boolean;
  otherPlaceholder?: string;
};

export type DecisionAnswer = {
  questionId: string;
  optionId?: string;
  text: string;
};

export type DecisionCardLabels = {
  skip: string;
  chatInstead: string;
  cycle: string;
  select: string;
  other: string;
};

const DEFAULT_LABELS: DecisionCardLabels = {
  skip: "Skip",
  chatInstead: "Chat instead",
  cycle: "Cycle",
  select: "Select",
  other: "Something else…",
};

function isEditable(el: EventTarget | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function optionText(option: DecisionOption): string {
  if (option.text !== undefined) return option.text;
  return typeof option.label === "string" ? option.label : option.id;
}

export function DecisionCard({
  questions,
  header,
  onAnswer,
  onComplete,
  onSkip,
  onChatInstead,
  questionIndex: indexProp,
  onQuestionIndexChange,
  labels: labelsProp,
  keyboard = true,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children" | "onChange"> & {
  questions: readonly DecisionQuestion[];
  header?: React.ReactNode;
  onAnswer?: (answer: DecisionAnswer, question: DecisionQuestion, index: number) => void;
  onComplete?: (answers: DecisionAnswer[]) => void;
  onSkip?: (questionId: string, index: number) => void;
  onChatInstead?: () => void;
  questionIndex?: number;
  onQuestionIndexChange?: (index: number) => void;
  labels?: Partial<DecisionCardLabels>;
  keyboard?: boolean;
}) {
  const labels = { ...DEFAULT_LABELS, ...labelsProp };
  const total = questions.length;
  const [innerIndex, setInnerIndex] = React.useState(0);
  const index = Math.min(Math.max(indexProp ?? innerIndex, 0), Math.max(total - 1, 0));
  const question = questions[index];
  const options = question?.options ?? [];
  const allowOther = question === undefined ? false : (question.allowOther ?? options.length > 0);
  const otherIndex = allowOther ? options.length : -1;
  const rowCount = options.length + (allowOther ? 1 : 0);

  const [selected, setSelected] = React.useState(0);
  const [otherText, setOtherText] = React.useState("");
  const settled = React.useRef(new Map<string, DecisionAnswer | null>());
  const cardRef = React.useRef<HTMLDivElement>(null);
  const otherRef = React.useRef<HTMLInputElement>(null);
  const promptId = React.useId();

  React.useEffect(() => {
    setSelected(0);
    setOtherText("");
  }, [question?.id]);

  const goTo = React.useCallback(
    (next: number) => {
      if (total === 0) return;
      const wrapped = ((next % total) + total) % total;
      if (indexProp === undefined) setInnerIndex(wrapped);
      onQuestionIndexChange?.(wrapped);
    },
    [total, indexProp, onQuestionIndexChange],
  );

  const settle = React.useCallback(
    (answer: DecisionAnswer | null) => {
      if (question === undefined) return;
      settled.current.set(question.id, answer);
      const remaining = questions.findIndex((q, i) => i > index && !settled.current.has(q.id));
      const before = questions.findIndex((q) => !settled.current.has(q.id));
      const next = remaining !== -1 ? remaining : before;
      if (next === -1) {
        const answers = questions
          .map((q) => settled.current.get(q.id))
          .filter((a): a is DecisionAnswer => a !== null && a !== undefined);
        onComplete?.(answers);
      } else if (next !== index) {
        goTo(next);
      }
    },
    [question, questions, index, goTo, onComplete],
  );

  const submitOption = React.useCallback(
    (i: number) => {
      if (question === undefined) return;
      const option = options[i];
      if (option === undefined) return;
      const answer: DecisionAnswer = { questionId: question.id, optionId: option.id, text: optionText(option) };
      onAnswer?.(answer, question, index);
      settle(answer);
    },
    [question, options, index, onAnswer, settle],
  );

  const submitOther = React.useCallback(() => {
    if (question === undefined) return;
    const text = otherText.trim();
    if (text === "") {
      otherRef.current?.focus();
      return;
    }
    const answer: DecisionAnswer = { questionId: question.id, text };
    onAnswer?.(answer, question, index);
    settle(answer);
  }, [question, otherText, index, onAnswer, settle]);

  const skip = React.useCallback(() => {
    if (question === undefined || onSkip === undefined) return;
    onSkip(question.id, index);
    settle(null);
  }, [question, index, onSkip, settle]);

  const onKey = React.useRef<(event: KeyboardEvent) => void>(() => {});
  onKey.current = (event: KeyboardEvent) => {
    if (event.defaultPrevented || question === undefined) return;
    const target = event.target;
    const inOwnField = target === otherRef.current;
    const inCard = target instanceof Node && cardRef.current?.contains(target);
    if (isEditable(target) && !inOwnField) return;
    if (!inCard && target instanceof HTMLElement && target.closest("[role=dialog]")) return;

    const { key, shiftKey, metaKey, ctrlKey, altKey } = event;
    if (key === "Escape") {
      if (shiftKey) {
        if (onChatInstead === undefined) return;
        event.preventDefault();
        onChatInstead();
      } else {
        if (onSkip === undefined) return;
        event.preventDefault();
        skip();
      }
      return;
    }
    if ((key === "ArrowLeft" || key === "ArrowRight") && metaKey && ctrlKey) {
      if (total < 2) return;
      event.preventDefault();
      goTo(index + (key === "ArrowRight" ? 1 : -1));
      return;
    }
    if (metaKey || ctrlKey || altKey) return;
    if (key === "Enter" && !shiftKey) {
      if (rowCount === 0) return;
      event.preventDefault();
      if (selected === otherIndex) submitOther();
      else submitOption(selected);
      return;
    }
    if (inOwnField) {
      if (key === "ArrowUp" && options.length > 0) {
        event.preventDefault();
        otherRef.current?.blur();
        setSelected(options.length - 1);
      }
      return;
    }
    if (/^[1-9]$/.test(key)) {
      const i = Number(key) - 1;
      if (i >= rowCount) return;
      event.preventDefault();
      setSelected(i);
      if (i === otherIndex) otherRef.current?.focus();
      return;
    }
    if (key === "ArrowDown" || key === "ArrowUp") {
      if (rowCount === 0) return;
      event.preventDefault();
      const next = Math.min(Math.max(selected + (key === "ArrowDown" ? 1 : -1), 0), rowCount - 1);
      setSelected(next);
      if (next === otherIndex) otherRef.current?.focus();
    }
  };

  React.useEffect(() => {
    if (!keyboard) return;
    const listener = (event: KeyboardEvent) => onKey.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [keyboard]);

  const hasLeftHints = onSkip !== undefined || onChatInstead !== undefined || total > 1;

  return (
    <div
      ref={cardRef}
      data-slot="decision-card"
      className={cn("v-rise-in flex flex-col rounded-2xl bg-background p-1 hairline", className)}
      {...props}
    >
      {header === undefined ? null : <div data-slot="decision-card-header" className="rounded-xl p-0.5">{header}</div>}
      <div className="flex flex-col rounded-xl bg-card hairline">
        {question === undefined ? null : (
          <>
            <div
              id={promptId}
              data-slot="decision-question"
              className="flex items-baseline gap-1.5 px-2 py-2.5 text-xs leading-3 font-medium tracking-h-xs text-muted-foreground"
            >
              {total > 1 ? (
                <span data-slot="decision-progress" className="shrink-0 tabular-nums">
                  {index + 1}/{total}
                </span>
              ) : null}
              <span className="flex min-w-0 flex-col gap-1">
                <span>{question.prompt}</span>
                {question.detail === undefined ? null : (
                  <span data-slot="decision-question-detail" className="font-normal tracking-body-xs">
                    {question.detail}
                  </span>
                )}
              </span>
            </div>
            {rowCount === 0 ? null : (
              <div role="group" aria-labelledby={promptId} className="flex flex-col px-1">
                {options.map((option, i) => {
                  const isSelected = selected === i;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      data-slot="decision-option"
                      data-selected={isSelected || undefined}
                      aria-current={isSelected || undefined}
                      onMouseEnter={() => setSelected(i)}
                      onFocus={() => setSelected(i)}
                      onClick={() => {
                        setSelected(i);
                        submitOption(i);
                      }}
                      className={cn(
                        "relative flex h-8 w-full min-w-0 items-center gap-2 rounded-lg py-2 pr-7 pl-2 text-left outline-hidden",
                        "text-sm leading-4 font-normal tracking-body-sm text-foreground",
                        "transition-[background-color] duration-(--v-motion-hover) ease-(--v-ease-hover) focus-visible:ring-2 focus-visible:ring-focus-ring",
                        isSelected && "bg-(--v-hover-tint)",
                      )}
                    >
                      <Kbd aria-hidden className="tabular-nums">{i + 1}</Kbd>
                      {option.icon === undefined ? null : (
                        <span aria-hidden className="flex shrink-0 [&_svg]:size-3">{option.icon}</span>
                      )}
                      <span className="min-w-0 truncate">{option.label}</span>
                      {option.detail === undefined ? null : (
                        <span data-slot="decision-option-detail" className="min-w-0 shrink-[4] truncate text-xs tracking-body-xs text-muted-foreground">
                          {option.detail}
                        </span>
                      )}
                      {isSelected ? (
                        <Kbd aria-hidden className="absolute right-2">
                          <CornerDownLeftIcon />
                        </Kbd>
                      ) : null}
                    </button>
                  );
                })}
                {allowOther ? (
                  <label
                    data-slot="decision-other"
                    data-selected={selected === otherIndex || undefined}
                    onMouseEnter={() => setSelected(otherIndex)}
                    className={cn(
                      "relative flex h-8 w-full min-w-0 cursor-text items-center gap-2 rounded-lg py-2 pr-7 pl-2",
                      "transition-[background-color] duration-(--v-motion-hover) ease-(--v-ease-hover)",
                      selected === otherIndex && "bg-(--v-hover-tint)",
                    )}
                  >
                    <Kbd aria-hidden className="tabular-nums">{otherIndex + 1}</Kbd>
                    <input
                      ref={otherRef}
                      type="text"
                      value={otherText}
                      onChange={(event) => setOtherText(event.target.value)}
                      onFocus={() => setSelected(otherIndex)}
                      placeholder={question.otherPlaceholder ?? labels.other}
                      aria-label={question.otherPlaceholder ?? labels.other}
                      className="min-w-0 flex-1 bg-transparent text-sm leading-4 font-normal tracking-body-sm text-foreground outline-hidden placeholder:text-muted-foreground"
                    />
                    {selected === otherIndex && otherText.trim() !== "" ? (
                      <Kbd aria-hidden className="absolute right-2">
                        <CornerDownLeftIcon />
                      </Kbd>
                    ) : null}
                  </label>
                ) : null}
              </div>
            )}
          </>
        )}
        <div data-slot="decision-footer" className="flex items-center justify-between gap-2 px-1 pt-2 pb-1">
          <div className="flex min-w-0 flex-wrap items-center">
            {onSkip === undefined ? null : <KbdHint label={labels.skip} keys={["esc"]} onClick={skip} />}
            {onSkip !== undefined && onChatInstead !== undefined ? (
              <span aria-hidden className="px-0.5 text-tag text-muted-foreground">
                /
              </span>
            ) : null}
            {onChatInstead === undefined ? null : (
              <KbdHint label={labels.chatInstead} keys={["⇧esc"]} onClick={() => onChatInstead()} />
            )}
            {total > 1 ? <KbdHint label={labels.cycle} keys={["⌘^←", "⌘^→"]} onClick={() => goTo(index + 1)} /> : null}
            {hasLeftHints ? null : <span />}
          </div>
          {rowCount === 0 ? null : (
            <KbdHint
              label={labels.select}
              keys={[<CornerDownLeftIcon key="enter" aria-hidden />]}
              onClick={() => (selected === otherIndex ? submitOther() : submitOption(selected))}
            />
          )}
        </div>
      </div>
    </div>
  );
}
