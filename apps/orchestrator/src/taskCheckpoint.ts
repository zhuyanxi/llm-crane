import { PipelineCheckpointSchema, type PipelineCheckpoint, type PlannerResult, type ReasonerResult, type RouteDecision, type StructurizerResult, type TaskRequest, type PipelineState, type PipelineTraceEvent } from '@llm-crane/schemas';

type CreateTaskCheckpointInput = {
  taskRequest: TaskRequest;
  pipeline: PipelineState;
  trace: PipelineTraceEvent[];
  capturedAt: string;
  structurizerResult?: StructurizerResult;
  routeDecision?: RouteDecision;
  plannerResult?: PlannerResult;
  reasonerResult?: ReasonerResult;
};

export function createTaskCheckpoint(input: CreateTaskCheckpointInput): PipelineCheckpoint {
  return PipelineCheckpointSchema.parse({
    taskRequest: input.taskRequest,
    structurizerResult: input.structurizerResult,
    routeDecision: input.routeDecision,
    plannerResult: input.plannerResult,
    reasonerResult: input.reasonerResult,
    pipeline: input.pipeline,
    trace: input.trace,
    capturedAt: input.capturedAt,
  });
}