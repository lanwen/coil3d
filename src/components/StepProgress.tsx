import { useEffect, useState } from "react";
import type { StepStage, StepStageId } from "../core";
import type { StepExportState } from "../useStepExport";

const COUNT_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

const countedLabel = (count: number | undefined, noun: string) => {
  const n = count ?? 1;
  return `${COUNT_WORDS[n] ?? n} ${noun}${n === 1 ? "" : "s"}`;
};

const STAGE_LABELS: Record<StepStageId, (stage: StepStage) => string> = {
  engine: () => "Loading the CAD engine",
  wall: () => "Winding wall",
  flange: () => "Flange and cut-outs",
  join: () => "Joining wall and flange",
  joints: () => "Mount holes and cap joint",
  topCap: () => "Top cap",
  mountPlate: () => "Mount plate",
  clips: (stage) => countedLabel(stage.count, "SKÅDIS clip"),
  tclips: (stage) => countedLabel(stage.count, "T-clip"),
  pegs: (stage) => countedLabel(stage.count, "peg"),
  write: () => "Writing the file",
};

const STAGE_MARKS = { done: "✓", current: "▸", waiting: "·" } as const;

const CANCEL_ARM_DELAY_MS = 600;

export function useCancelArmed(startedAt: number | null) {
  const [armed, setArmed] = useState(false);
  const busy = startedAt !== null;
  useEffect(() => {
    setArmed(false);
    if (!busy) return;
    const timer = window.setTimeout(() => setArmed(true), CANCEL_ARM_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [busy, startedAt]);
  return busy && armed;
}

function useElapsedSeconds(since: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return Math.max(0, Math.floor((now - since) / 1000));
}

export function StepElapsed({ since }: { since: number }) {
  return <span data-testid="step-timer">{useElapsedSeconds(since)} s</span>;
}

function StepElapsedForReaders({ since }: { since: number }) {
  return (
    <p className="visually-hidden" aria-live="off" data-testid="step-elapsed-sr">
      Elapsed {useElapsedSeconds(since)} seconds
    </p>
  );
}

export function StepStages({ state }: { state: StepExportState }) {
  const currentIndex = state.plan.findIndex((stage) => stage.id === state.stage);
  const showList = !state.restarting && state.stage !== null;
  return (
    <div className="step-stages" data-testid="step-stages" role="status">
      {state.restarting && (
        <p className="step-restarting" data-testid="step-restarting">
          Design changed, restarting…
        </p>
      )}
      {showList && (
        <ol className="step-stage-list">
          {state.plan.map((stage, i) => {
            const status = i < currentIndex ? "done" : i === currentIndex ? "current" : "waiting";
            return (
              <li key={stage.id} data-testid={`step-stage-${stage.id}`} data-state={status}>
                <span className="step-stage-mark" aria-hidden="true">
                  {STAGE_MARKS[status]}
                </span>
                {STAGE_LABELS[stage.id](stage)}
              </li>
            );
          })}
        </ol>
      )}
      <StepElapsedForReaders since={state.startedAt} />
    </div>
  );
}
