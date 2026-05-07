import type {
  CostEstimate,
  Diagnostic,
  PlannerResult,
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
  plannerResult?: PlannerResult;
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
  'output' | 'routeDecision' | 'plannerResult' | 'selectedProvider' | 'providerResult' | 'costEstimate' | 'diagnostic'
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
    constraintCount: structurizerResult.structuredTask.constraints.length,
    contextCount: structurizerResult.structuredTask.contextSummary.length,
  };
}

export function createPlannerStageOutput(
  source:
    | PlannerResult
    | {
        status: 'skipped';
        summary: string;
        detail: string;
        planStepCount?: number;
        decisionPointCount?: number;
        openQuestionCount?: number;
        downstreamHintCount?: number;
        fallbackReason?: string;
      },
): PipelineStageOutput {
  if ('steps' in source) {
    return {
      stageId: 'planner',
      status: source.status,
      summary: source.summary,
      planStepCount: source.steps.length,
      decisionPointCount: source.decisionPoints.length,
      openQuestionCount: source.openQuestions.length,
      downstreamHintCount: source.downstreamHints.reasonerFocus.length + source.downstreamHints.verifierChecks.length,
      detail: source.summary,
      fallbackReason: source.fallbackReason,
    };
  }

  return {
    stageId: 'planner',
    status: source.status,
    summary: source.summary,
    planStepCount: source.planStepCount ?? 0,
    decisionPointCount: source.decisionPointCount ?? 0,
    openQuestionCount: source.openQuestionCount ?? 0,
    downstreamHintCount: source.downstreamHintCount ?? 0,
    detail: source.detail,
    fallbackReason: source.fallbackReason,
  };
}

export function createReasonerStageInput(
  taskRequest: TaskRequest,
  routeDecision: RouteDecision,
  plannerAvailable: boolean,
  plannerStatus?: PlannerResult['status'] | 'skipped',
  planStepCount = 0,
): PipelineStageInput {
  return {
    stageId: 'reasoner',
    route: routeDecision.route,
    qualityBar: taskRequest.qualityBar,
    plannerAvailable,
    plannerStatus,
    planStepCount,
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

export function createVerifierStageInput(
  routeDecision: RouteDecision,
  providerReady: boolean,
  plannerStatus?: PlannerResult['status'] | 'skipped',
  planStepCount = 0,
): PipelineStageInput {
  return {
    stageId: 'verifier',
    route: routeDecision.route,
    providerReady,
    plannerStatus,
    planStepCount,
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

function createCacheFallbackPlannerResult(taskRequest: TaskRequest, routeDecision: RouteDecision): PlannerResult {
  return {
    status: 'fallback',
    summary: `Cache hit reused complex route for task "${taskRequest.task}" without persisted planner payload.`,
    steps: [
      {
        stepId: 'inspect-context',
        title: 'Inspect known context',
        objective: 'Use cached route and attached request context as conservative planner input.',
        acceptance: 'Executor keeps scope bounded to known request details.',
      },
      {
        stepId: 'answer-conservatively',
        title: 'Answer conservatively',
        objective: 'Produce bounded answer and surface missing details instead of guessing.',
        acceptance: 'Final answer calls out uncertainty or blockers when confidence is low.',
      },
    ],
    decisionPoints: [
      {
        question: 'Should cached complex route stay conservative without original planner payload?',
        whyItMatters: 'Missing planner payload reduces downstream context fidelity on cache-hit rebuild.',
        options: ['Yes, keep conservative fallback plan', 'No, reconstruct broad speculative plan'],
        defaultChoice: 'Yes, keep conservative fallback plan',
      },
    ],
    openQuestions: [],
    downstreamHints: {
      reasonerFocus: routeDecision.route === 'complex' ? ['Keep missing planner details explicit.'] : [],
      verifierChecks: ['Confirm final answer stays within cached request scope.'],
    },
    warnings: ['Cache hit rebuilt planner state from conservative fallback payload.'],
    fallbackReason: 'Cache hit omitted prior planner payload.',
  };
}

export function buildCachedPipelineState(
  taskRequest: TaskRequest,
  cachedResponse: CachedPipelineResponse,
  createTimestamp: CreateTimestamp,
): PipelineState {
  const machine = createPipelineStateMachine(taskRequest, createTimestamp);
  const plannerResult = cachedResponse.plannerResult;
  machine.updateContext({
    routeDecision: cachedResponse.routeDecision,
    plannerResult,
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
    const complexPlannerResult = plannerResult ?? createCacheFallbackPlannerResult(taskRequest, cachedResponse.routeDecision);
    machine.updateContext({
      plannerResult: complexPlannerResult,
    });
    machine.skipStage(
      'planner',
      'Cache hit; reused complex graph state without rerunning planner.',
      createPlannerStageOutput({
        status: 'skipped',
        summary: complexPlannerResult.summary,
        detail: 'Cache hit reused planner checkpoint.',
        planStepCount: complexPlannerResult.steps.length,
        decisionPointCount: complexPlannerResult.decisionPoints.length,
        openQuestionCount: complexPlannerResult.openQuestions.length,
        downstreamHintCount:
          complexPlannerResult.downstreamHints.reasonerFocus.length + complexPlannerResult.downstreamHints.verifierChecks.length,
        fallbackReason: complexPlannerResult.fallbackReason,
      }),
      {
        input: createPlannerStageInput(cachedResponse.routeDecision, cacheStructurizerResult),
      },
    );
    machine.skipStage(
      'reasoner',
      'Cache hit; reused complex graph state without rerunning reasoner.',
      createReasonerStageOutput('skipped', 'Cache hit reused reasoner checkpoint.', false),
      {
        input: createReasonerStageInput(
          taskRequest,
          cachedResponse.routeDecision,
          true,
          complexPlannerResult.status,
          complexPlannerResult.steps.length,
        ),
      },
    );
    machine.skipStage(
      'verifier',
      'Cache hit; reused complex graph state without rerunning verifier.',
      createVerifierStageOutput('skipped', 'Cache hit reused verifier checkpoint.'),
      {
        input: createVerifierStageInput(
          cachedResponse.routeDecision,
          true,
          complexPlannerResult.status,
          complexPlannerResult.steps.length,
        ),
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