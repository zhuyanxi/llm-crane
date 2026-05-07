import type {
  CostEstimate,
  Diagnostic,
  PipelineExecutionState,
  PipelineGraph,
  PipelineStageId,
  PipelineStageInput,
  PipelineStageOutput,
  PipelineStageState,
  PipelineState,
  PipelineStateTransition,
  PipelineTraceError,
  ProviderApiFamily,
  ProviderDeploymentMode,
  ProviderExecutionResult,
  ProviderId,
  RouteDecision,
  RouteTier,
  StructurizerResult,
  TaskRequest,
  TaskResponse,
} from '@llm-crane/schemas';

type CreateTimestamp = () => string;

export type ProviderTargetSnapshot = {
  providerId: ProviderId;
  modelId: string;
  runtimeId?: string;
  deploymentMode?: ProviderDeploymentMode;
  apiFamily?: ProviderApiFamily;
};

export type PipelineExecutionContext = {
  taskRequest: TaskRequest;
  structurizerResult?: StructurizerResult;
  routeDecision?: RouteDecision;
  providerTarget?: ProviderTargetSnapshot;
  providerResult?: ProviderExecutionResult;
  costEstimate?: CostEstimate;
  diagnostic?: Diagnostic;
  output?: string;
};

type StageTemplate = {
  stageId: PipelineStageId;
  label: string;
  dependsOn: PipelineStageId[];
};

type TransitionOptions = {
  detail?: string;
  input?: PipelineStageInput;
  output?: PipelineStageOutput;
  error?: PipelineTraceError;
  skippedReason?: string;
};

type StageCompletion = {
  output: PipelineStageOutput;
  detail?: string;
  error?: PipelineTraceError;
};

const TERMINAL_STATES = new Set<PipelineExecutionState>(['completed', 'failed', 'skipped']);

const ALLOWED_STAGE_TRANSITIONS: Record<PipelineExecutionState, ReadonlySet<PipelineExecutionState>> = {
  pending: new Set<PipelineExecutionState>(['running', 'skipped']),
  running: new Set<PipelineExecutionState>(['completed', 'failed', 'skipped']),
  completed: new Set<PipelineExecutionState>(),
  failed: new Set<PipelineExecutionState>(),
  skipped: new Set<PipelineExecutionState>(),
};

const GRAPH_TEMPLATES: Record<PipelineGraph, readonly StageTemplate[]> = {
  'simple-v1': [
    { stageId: 'request', label: 'Request Intake', dependsOn: [] },
    { stageId: 'structurizer', label: 'Structurizer', dependsOn: ['request'] },
    { stageId: 'router', label: 'Router', dependsOn: ['structurizer'] },
    { stageId: 'executor', label: 'Executor', dependsOn: ['router'] },
    { stageId: 'response', label: 'Response Assembly', dependsOn: ['executor'] },
  ],
  'complex-v1': [
    { stageId: 'request', label: 'Request Intake', dependsOn: [] },
    { stageId: 'structurizer', label: 'Structurizer', dependsOn: ['request'] },
    { stageId: 'router', label: 'Router', dependsOn: ['structurizer'] },
    { stageId: 'planner', label: 'Planner', dependsOn: ['router'] },
    { stageId: 'reasoner', label: 'Reasoner', dependsOn: ['planner'] },
    { stageId: 'verifier', label: 'Verifier', dependsOn: ['reasoner'] },
    { stageId: 'executor', label: 'Executor', dependsOn: ['verifier'] },
    { stageId: 'response', label: 'Response Assembly', dependsOn: ['executor'] },
  ],
};

function cloneStageState(stage: PipelineStageState): PipelineStageState {
  return {
    ...stage,
    dependsOn: [...stage.dependsOn],
    input: stage.input ? { ...stage.input } : undefined,
    output: stage.output ? { ...stage.output } : undefined,
    error: stage.error ? { ...stage.error } : undefined,
  };
}

function createGraphFromRoute(route: RouteTier): PipelineGraph {
  return route === 'complex' ? 'complex-v1' : 'simple-v1';
}

function createStageSet(graph: PipelineGraph, previousStages: PipelineStageState[] = []): PipelineStageState[] {
  const previousStageMap = new Map(previousStages.map((stage) => [stage.stageId, stage]));

  return GRAPH_TEMPLATES[graph].map((template) => {
    const previousStage = previousStageMap.get(template.stageId);

    if (!previousStage) {
      return {
        stageId: template.stageId,
        label: template.label,
        state: 'pending',
        dependsOn: [...template.dependsOn],
      };
    }

    return {
      ...cloneStageState(previousStage),
      label: template.label,
      dependsOn: [...template.dependsOn],
    };
  });
}

function getPipelineState(stages: PipelineStageState[]): PipelineExecutionState {
  if (stages.some((stage) => stage.state === 'failed')) {
    return 'failed';
  }

  if (stages.some((stage) => stage.state === 'running')) {
    return 'running';
  }

  if (stages.length > 0 && stages.every((stage) => TERMINAL_STATES.has(stage.state))) {
    return 'completed';
  }

  return 'pending';
}

function assertTransitionAllowed(stage: PipelineStageState, nextState: PipelineExecutionState): void {
  if (ALLOWED_STAGE_TRANSITIONS[stage.state].has(nextState)) {
    return;
  }

  throw new Error(`Invalid pipeline transition for ${stage.stageId}: ${stage.state} -> ${nextState}`);
}

type CachedPipelineResponse = Pick<
  TaskResponse,
  'output' | 'routeDecision' | 'selectedProvider' | 'providerResult' | 'costEstimate' | 'diagnostic'
>;

export class PipelineStateMachine {
  private graph: PipelineGraph = 'simple-v1';

  private stages: PipelineStageState[] = createStageSet('simple-v1');

  private readonly transitions: PipelineStateTransition[] = [];

  readonly context: PipelineExecutionContext;

  constructor(taskRequest: TaskRequest, private readonly createTimestamp: CreateTimestamp) {
    this.context = {
      taskRequest,
    };
  }

  updateContext(update: Partial<PipelineExecutionContext>): void {
    Object.assign(this.context, update);
  }

  setGraph(route: RouteTier): void {
    const nextGraph = createGraphFromRoute(route);
    if (nextGraph === this.graph) {
      return;
    }

    this.graph = nextGraph;
    this.stages = createStageSet(nextGraph, this.stages);
  }

  startStage(stageId: PipelineStageId, input: PipelineStageInput, detail?: string): void {
    this.transitionStage(stageId, 'running', {
      detail,
      input,
    });
  }

  completeStage(stageId: PipelineStageId, output: PipelineStageOutput, options: Omit<TransitionOptions, 'output' | 'skippedReason'> = {}): void {
    this.transitionStage(stageId, 'completed', {
      ...options,
      output,
    });
  }

  failStage(
    stageId: PipelineStageId,
    error: PipelineTraceError,
    output?: PipelineStageOutput,
    options: Omit<TransitionOptions, 'output' | 'error' | 'skippedReason'> = {},
  ): void {
    this.transitionStage(stageId, 'failed', {
      ...options,
      output,
      error,
    });
  }

  skipStage(
    stageId: PipelineStageId,
    reason: string,
    output?: PipelineStageOutput,
    options: Omit<TransitionOptions, 'output' | 'skippedReason'> = {},
  ): void {
    this.transitionStage(stageId, 'skipped', {
      ...options,
      output,
      skippedReason: reason,
      detail: options.detail ?? reason,
    });
  }

  serialize(): PipelineState {
    return {
      version: 'v1',
      graph: this.graph,
      route: this.context.routeDecision?.route ?? 'simple',
      state: getPipelineState(this.stages),
      currentStageId: this.stages.find((stage) => stage.state === 'running')?.stageId,
      stages: this.stages.map((stage) => cloneStageState(stage)),
      transitions: this.transitions.map((transition) => ({ ...transition })),
    };
  }

  private transitionStage(stageId: PipelineStageId, nextState: PipelineExecutionState, options: TransitionOptions = {}): void {
    const stage = this.stages.find((candidate) => candidate.stageId === stageId);
    if (!stage) {
      throw new Error(`Unknown pipeline stage ${stageId} for graph ${this.graph}`);
    }

    assertTransitionAllowed(stage, nextState);

    const timestamp = this.createTimestamp();
    const previousState = stage.state;

    if (options.input) {
      stage.input = { ...options.input };
    }

    if (options.output) {
      stage.output = { ...options.output };
    }

    if (options.error) {
      stage.error = { ...options.error };
    }

    if (nextState === 'running') {
      stage.startedAt = timestamp;
      stage.completedAt = undefined;
    } else {
      stage.startedAt = stage.startedAt ?? timestamp;
      stage.completedAt = timestamp;
    }

    stage.skippedReason = nextState === 'skipped' ? options.skippedReason ?? options.detail ?? 'Stage skipped.' : undefined;

    stage.state = nextState;
    this.transitions.push({
      stageId,
      fromState: previousState,
      toState: nextState,
      timestamp,
      detail: options.detail,
    });
  }
}

export async function runPipelineStage<TResult>(
  machine: PipelineStateMachine,
  stageId: PipelineStageId,
  input: PipelineStageInput,
  execute: () => TResult | Promise<TResult>,
  mapResult: (result: TResult) => StageCompletion,
): Promise<TResult> {
  machine.startStage(stageId, input);
  const result = await execute();
  const completion = mapResult(result);
  machine.completeStage(stageId, completion.output, {
    detail: completion.detail,
    error: completion.error,
  });
  return result;
}

export function createPipelineStateMachine(taskRequest: TaskRequest, createTimestamp: CreateTimestamp): PipelineStateMachine {
  return new PipelineStateMachine(taskRequest, createTimestamp);
}

export function createRequestStageInput(taskRequest: TaskRequest): PipelineStageInput {
  return {
    stageId: 'request',
    taskChars: taskRequest.task.length,
    contextCount: taskRequest.contexts.length,
    constraintCount: taskRequest.constraints.length,
    qualityBar: taskRequest.qualityBar,
  };
}

export function createRequestStageOutput(): PipelineStageOutput {
  return {
    stageId: 'request',
    accepted: true,
  };
}

export function createStructurizerStageInput(taskRequest: TaskRequest): PipelineStageInput {
  return {
    stageId: 'structurizer',
    taskChars: taskRequest.task.length,
    contextCount: taskRequest.contexts.length,
  };
}

export function createStructurizerStageOutput(structurizerResult: StructurizerResult): PipelineStageOutput {
  return {
    stageId: 'structurizer',
    status: structurizerResult.status,
    taskType: structurizerResult.structuredTask.taskType,
    targetKind: structurizerResult.structuredTask.target.kind,
    warningCount: structurizerResult.warnings.length,
    fallbackReason: structurizerResult.fallbackReason,
  };
}

export function createRouterStageInput(structurizerResult: StructurizerResult): PipelineStageInput {
  return {
    stageId: 'router',
    structurizerStatus: structurizerResult.status,
    taskType: structurizerResult.structuredTask.taskType,
    openQuestions: structurizerResult.structuredTask.openQuestions.length,
    warningCount: structurizerResult.warnings.length,
  };
}

export function createRouterStageOutput(routeDecision: RouteDecision): PipelineStageOutput {
  return {
    stageId: 'router',
    status: routeDecision.status,
    route: routeDecision.route,
    complexityScore: routeDecision.complexityScore,
    confidence: routeDecision.confidence,
    fallbackReason: routeDecision.fallbackReason,
  };
}

export function createPlannerStageInput(routeDecision: RouteDecision, structurizerResult: StructurizerResult): PipelineStageInput {
  return {
    stageId: 'planner',
    route: routeDecision.route,
    taskType: structurizerResult.structuredTask.taskType,
    openQuestions: structurizerResult.structuredTask.openQuestions.length,
  };
}

export function createPlannerStageOutput(status: 'completed' | 'skipped', detail: string, planStepCount = 0): PipelineStageOutput {
  return {
    stageId: 'planner',
    status,
    planStepCount,
    detail,
  };
}

export function createReasonerStageInput(taskRequest: TaskRequest, routeDecision: RouteDecision, plannerAvailable: boolean): PipelineStageInput {
  return {
    stageId: 'reasoner',
    route: routeDecision.route,
    qualityBar: taskRequest.qualityBar,
    plannerAvailable,
  };
}

export function createReasonerStageOutput(status: 'completed' | 'skipped', detail: string, needReasoning: boolean): PipelineStageOutput {
  return {
    stageId: 'reasoner',
    status,
    needReasoning,
    detail,
  };
}

export function createVerifierStageInput(routeDecision: RouteDecision, providerReady: boolean): PipelineStageInput {
  return {
    stageId: 'verifier',
    route: routeDecision.route,
    providerReady,
  };
}

export function createVerifierStageOutput(
  status: 'completed' | 'skipped',
  detail: string,
  verificationStatus: 'not-run' | 'passed' | 'failed' = 'not-run',
): PipelineStageOutput {
  return {
    stageId: 'verifier',
    status,
    verificationStatus,
    detail,
  };
}

export function createExecutorStageInput(routeDecision: RouteDecision, providerTarget: ProviderTargetSnapshot): PipelineStageInput {
  return {
    stageId: 'executor',
    route: routeDecision.route,
    providerId: providerTarget.providerId,
    modelId: providerTarget.modelId,
    runtimeId: providerTarget.runtimeId,
    deploymentMode: providerTarget.deploymentMode,
    apiFamily: providerTarget.apiFamily,
  };
}

export function createExecutorStageOutput(providerResult: ProviderExecutionResult): PipelineStageOutput {
  return {
    stageId: 'executor',
    status: providerResult.status,
    providerId: providerResult.providerId,
    modelId: providerResult.modelId,
    latencyMs: providerResult.latencyMs,
    errorCode: providerResult.error?.code,
  };
}

export function createResponseStageInput(
  providerResult: ProviderExecutionResult,
  costEstimate: CostEstimate,
  diagnostic?: Diagnostic,
): PipelineStageInput {
  return {
    stageId: 'response',
    providerStatus: providerResult.status,
    costStatus: costEstimate.status,
    diagnosticPresent: Boolean(diagnostic),
  };
}

export function createResponseStageOutput(
  output: string,
  providerResult: ProviderExecutionResult,
  costEstimate: CostEstimate,
  diagnostic?: Diagnostic,
): PipelineStageOutput {
  return {
    stageId: 'response',
    outputChars: output.length,
    providerStatus: providerResult.status,
    costStatus: costEstimate.status,
    diagnosticCode: diagnostic?.code,
  };
}

function createCacheFallbackStructurizerResult(taskRequest: TaskRequest): StructurizerResult {
  return {
    status: 'fallback',
    structuredTask: {
      originalTask: taskRequest.task,
      taskType: 'other',
      goal: taskRequest.task,
      target: {
        kind: 'unknown',
        value: taskRequest.task,
      },
      qualityBar: taskRequest.qualityBar,
      constraints: taskRequest.constraints,
      openQuestions: [],
      uncertaintyReasons: [],
      contextSummary: [],
    },
    warnings: [],
    fallbackReason: 'Cache hit omitted prior structurizer payload.',
  };
}

export function buildCachedPipelineState(
  taskRequest: TaskRequest,
  cachedResponse: CachedPipelineResponse,
  createTimestamp: CreateTimestamp,
): PipelineState {
  const machine = createPipelineStateMachine(taskRequest, createTimestamp);
  machine.updateContext({
    routeDecision: cachedResponse.routeDecision,
    providerTarget: {
      providerId: cachedResponse.selectedProvider.providerId,
      modelId: cachedResponse.selectedProvider.modelId,
      runtimeId: cachedResponse.selectedProvider.runtimeId,
      deploymentMode: cachedResponse.selectedProvider.deploymentMode,
      apiFamily: cachedResponse.selectedProvider.apiFamily,
    },
    providerResult: cachedResponse.providerResult,
    costEstimate: cachedResponse.costEstimate,
    diagnostic: cachedResponse.diagnostic,
    output: cachedResponse.output,
  });

  machine.startStage('request', createRequestStageInput(taskRequest));
  machine.completeStage('request', createRequestStageOutput());
  machine.setGraph(cachedResponse.routeDecision.route);
  machine.skipStage('structurizer', 'Cache hit; reused prior structurizer output.');
  machine.skipStage('router', 'Cache hit; reused prior route decision.', createRouterStageOutput(cachedResponse.routeDecision));

  if (cachedResponse.routeDecision.route === 'complex') {
    const cacheStructurizerResult = createCacheFallbackStructurizerResult(taskRequest);
    machine.skipStage(
      'planner',
      'Cache hit; reused complex graph state without rerunning planner.',
      createPlannerStageOutput('skipped', 'Cache hit reused planner checkpoint.'),
      {
        input: createPlannerStageInput(cachedResponse.routeDecision, cacheStructurizerResult),
      },
    );
    machine.skipStage(
      'reasoner',
      'Cache hit; reused complex graph state without rerunning reasoner.',
      createReasonerStageOutput('skipped', 'Cache hit reused reasoner checkpoint.', false),
      {
        input: createReasonerStageInput(taskRequest, cachedResponse.routeDecision, false),
      },
    );
    machine.skipStage(
      'verifier',
      'Cache hit; reused complex graph state without rerunning verifier.',
      createVerifierStageOutput('skipped', 'Cache hit reused verifier checkpoint.'),
      {
        input: createVerifierStageInput(cachedResponse.routeDecision, true),
      },
    );
  }

  machine.skipStage(
    'executor',
    'Cache hit; reused prior provider execution result.',
    createExecutorStageOutput(cachedResponse.providerResult),
    {
      input: createExecutorStageInput(cachedResponse.routeDecision, {
        providerId: cachedResponse.selectedProvider.providerId,
        modelId: cachedResponse.selectedProvider.modelId,
        runtimeId: cachedResponse.selectedProvider.runtimeId,
        deploymentMode: cachedResponse.selectedProvider.deploymentMode,
        apiFamily: cachedResponse.selectedProvider.apiFamily,
      }),
    },
  );
  machine.startStage('response', createResponseStageInput(cachedResponse.providerResult, cachedResponse.costEstimate, cachedResponse.diagnostic));
  machine.completeStage(
    'response',
    createResponseStageOutput(
      cachedResponse.output,
      cachedResponse.providerResult,
      cachedResponse.costEstimate,
      cachedResponse.diagnostic,
    ),
  );

  return machine.serialize();
}