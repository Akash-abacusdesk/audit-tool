/**
 * Section-14 Deep Security & Posture Auditing — D1 common orchestration contract.
 *
 * This is the shared, reusable pipeline contract that the deep-audit pipeline
 * (and any future serialized pipeline) conforms to: an ordered list of stages,
 * per-stage status, cross-stage transitions (a stage may not start before the
 * prior stage is done), and overall pipeline status derivation with failure
 * propagation. It is persistence-agnostic — see {@link RunStore}.
 */
import { ApiError } from './errors.js';

export type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export type PipelineStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface StageState {
  stage: string;
  status: StageStatus;
  error?: string;
}

export interface PipelineContract<S extends string = string> {
  readonly stages: readonly S[];
  /** A stage may start only once every prior stage is done/skipped. */
  canStartStage(states: StageState[], index: number): boolean;
  startStage(states: StageState[], index: number): StageState[];
  applyStageResult(
    states: StageState[],
    index: number,
    status: 'done' | 'failed' | 'skipped',
    error?: string
  ): StageState[];
  /** Derive overall status from per-stage states. */
  overallStatus(states: StageState[]): PipelineStatus;
}

export function definePipeline<S extends string>(stages: readonly S[]): PipelineContract<S> {
  function clone(states: StageState[]): StageState[] {
    return states.map((s) => ({ ...s }));
  }
  function priorComplete(states: StageState[], index: number): boolean {
    for (let i = 0; i < index; i++) {
      const st = stages[i];
      // prior stage must be resolvable; if not done and not skipped, block.
      void st;
      const s = states[i]!;
      if (s.status !== 'done' && s.status !== 'skipped') return false;
    }
    return true;
  }
  return {
    stages,
    canStartStage(states, index) {
      if (index < 0 || index >= stages.length) return false;
      if (states[index]!.status !== 'pending') return false;
      return priorComplete(states, index);
    },
    startStage(states, index) {
      const next = clone(states);
      if (!this.canStartStage(next, index)) {
        throw new ApiError('FORBIDDEN', `stage ${stages[index]} cannot start yet`);
      }
      next[index] = { ...next[index]!, status: 'running' };
      return next;
    },
    applyStageResult(states, index, status, error) {
      const next = clone(states);
      const cur = next[index]!;
      if (cur.status !== 'running') {
        throw new ApiError('FORBIDDEN', `stage ${stages[index]} is not running`);
      }
      next[index] = { stage: cur.stage, status, error: status === 'failed' ? error : undefined };
      return next;
    },
    overallStatus(states) {
      if (states.some((s) => s.status === 'failed')) return 'failed';
      if (states.every((s) => s.status === 'done' || s.status === 'skipped')) return 'completed';
      if (states.some((s) => s.status === 'running')) return 'running';
      // a pending stage that has a prior done/skipped stage has effectively started
      for (let i = 1; i < states.length; i++) {
        if (
          states[i]!.status === 'pending' &&
          (states[i - 1]!.status === 'done' || states[i - 1]!.status === 'skipped')
        ) {
          return 'running';
        }
      }
      return 'pending';
    },
  };
}

/** Build a fresh per-stage state vector for the given stage names. */
export function initialStageStates(stages: readonly string[]): StageState[] {
  return stages.map((stage) => ({ stage, status: 'pending' as StageStatus }));
}

// ---- Persistence model ------------------------------------------------------

export interface RunStoreEntry<T> {
  id: string;
  stages: StageState[];
  payload: T;
  status: PipelineStatus;
  createdAt: string;
  finishedAt: string | null;
}

export interface RunStore<T> {
  create(id: string, stages: StageState[], payload: T): void;
  get(id: string): RunStoreEntry<T> | null;
  update(id: string, stages: StageState[], status: PipelineStatus, finishedAt?: string | null): void;
}

/** In-memory RunStore — swap for a PG table when pipelines are promoted past CI. */
export class InMemoryRunStore<T> implements RunStore<T> {
  private readonly runs = new Map<string, RunStoreEntry<T>>();

  create(id: string, stages: StageState[], payload: T): void {
    this.runs.set(id, {
      id,
      stages,
      payload,
      status: 'pending',
      createdAt: new Date().toISOString(),
      finishedAt: null,
    });
  }

  get(id: string): RunStoreEntry<T> | null {
    return this.runs.get(id) ?? null;
  }

  update(id: string, stages: StageState[], status: PipelineStatus, finishedAt: string | null = null): void {
    const e = this.runs.get(id);
    if (!e) return;
    e.stages = stages;
    e.status = status;
    if (finishedAt !== null) e.finishedAt = finishedAt;
  }
}
