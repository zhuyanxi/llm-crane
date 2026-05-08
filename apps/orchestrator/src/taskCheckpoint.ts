import { PipelineCheckpointSchema, type PipelineCheckpoint, type PipelineState, type PipelineTraceEvent, type PlannerResult, type ReasonerResult, type RouteDecision, type StructurizerResult, type TaskRequest, type VerificationResult } from '@llm-crane/schemas';

type CreateTaskCheckpointInput = {
  taskRequest: TaskRequest;
  pipeline: PipelineState;
  trace: PipelineTraceEvent[];
  capturedAt: string;
  structurizerResult?: StructurizerResult;
  routeDecision?: RouteDecision;
  plannerResult?: PlannerResult;
  reasonerResult?: ReasonerResult;
  verifierResult?: VerificationResult;
};

export function createTaskCheckpoint(input: CreateTaskCheckpointInput): PipelineCheckpoint {
  return PipelineCheckpointSchema.parse({
    taskRequest: input.taskRequest,
    structurizerResult: input.structurizerResult,
    routeDecision: input.routeDecision,
    plannerResult: input.plannerResult,
    reasonerResult: input.reasonerResult,
    verifierResult: input.verifierResult,
    pipeline: input.pipeline,
    trace: input.trace,
    capturedAt: input.capturedAt,
  });
}