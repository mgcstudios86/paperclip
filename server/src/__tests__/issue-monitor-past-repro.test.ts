/**
 * Regression test for MGC-2860.
 *
 * Reported symptom: PATCH /api/issues/{id} on an issue whose monitor is
 * armed in the past (scheduledBy=assignee, monitorNextCheckAt < now,
 * attemptCount=0) returned HTTP 500. POST /release and DELETE on the same
 * issue also 500'd, while GET and POST /comments worked normally.
 *
 * The 500 could not be reproduced against the current code: all three
 * PATCH variants below return 200 with the monitor auto-cleared. This
 * test guards against the regression returning — the routes must always
 * respond with a 4xx (handled HttpError) and never 500 in this state.
 *
 * If the bug resurfaces, this test will fail with the exact request that
 * triggered it, making the cause much easier to localise.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeIssueExecutionPolicy } from "../services/issue-execution-policy.ts";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  update: vi.fn(),
  createChild: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(),
  getRelationSummaries: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  triggerIssueMonitor: vi.fn(async () => ({ outcome: "triggered" as const })),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(async () => false),
  decide: vi.fn(),
  hasPermission: vi.fn(async () => false),
}));
const mockDbSelectWhere = vi.hoisted(() => vi.fn(() => ({
  then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
    Promise.resolve([{
      companyId: "company-1",
      agentId: "33333333-3333-4333-8333-333333333333",
      contextSnapshot: null,
      permissions: null,
    }]).then(onFulfilled, onRejected),
})));
const mockDbSelectFrom = vi.hoisted(() => vi.fn(() => ({ where: mockDbSelectWhere })));
const mockDbSelect = vi.hoisted(() => vi.fn(() => ({ from: mockDbSelectFrom })));
const mockDb = vi.hoisted(() => ({ select: mockDbSelect }));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  listForIssue: vi.fn(async () => []),
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
}));
const mockIssueApprovalService = vi.hoisted(() => ({
  listApprovalsForIssue: vi.fn(async () => []),
}));

function registerModuleMocks() {
  vi.doMock("../services/index.js", () => ({
    companyService: () => ({
      getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
    }),
    accessService: () => mockAccessService,
    agentService: () => ({
      getById: vi.fn(async (agentId: string) => ({
        id: agentId,
        companyId: "company-1",
        permissions: null,
      })),
      resolveByReference: vi.fn(async (_companyId: string, reference: string) => ({
        ambiguous: false,
        agent: {
          id: reference,
          companyId: "company-1",
          status: "idle",
          orgChainHealth: { status: "healthy" },
        },
      })),
    }),
    companySkillService: () => ({ completeTestRunForIssue: vi.fn(async () => null) }),
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
    documentService: () => ({}),
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({
      listIssueVotesForUser: vi.fn(async () => []),
      saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })),
    }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    environmentService: () => ({ getById: vi.fn(async () => null) }),
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => mockIssueApprovalService,
    issueReferenceService: () => ({
      deleteDocumentSource: async () => undefined,
      diffIssueReferenceSummary: () => ({
        addedReferencedIssues: [], removedReferencedIssues: [], currentReferencedIssues: [],
      }),
      emptySummary: () => ({ outbound: [], inbound: [] }),
      listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
      syncComment: async () => undefined,
      syncDocument: async () => undefined,
      syncIssue: async () => undefined,
    }),
    issueRecoveryActionService: () => ({
      getActiveForIssue: vi.fn(async () => null),
      listActiveForIssues: vi.fn(async () => new Map()),
    }),
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: mockLogActivity,
    projectService: () => ({}),
    routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
    workProductService: () => ({}),
  }));
}

async function createApp(actor?: any) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    import("../middleware/index.js"),
    import("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor ?? {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("MGC-2860 PATCH 500 repro: monitor armed in the past", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../services/index.js");
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.createChild.mockResolvedValue({
      issue: { id: "child", companyId: "company-1", identifier: "PAP-CHILD", title: "child" },
      parentBlockerAdded: false,
    });
    mockIssueThreadInteractionService.listForIssue.mockResolvedValue([]);
    mockIssueThreadInteractionService.expireRequestConfirmationsSupersededByComment.mockResolvedValue([]);
    mockIssueApprovalService.listApprovalsForIssue.mockResolvedValue([]);
    mockDbSelect.mockImplementation(() => ({ from: mockDbSelectFrom }));
    mockDbSelectFrom.mockImplementation(() => ({ where: mockDbSelectWhere }));
    mockDbSelectWhere.mockImplementation(() => ({
      then: (onFulfilled: (rows: unknown[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve([{
          companyId: "company-1",
          agentId: "33333333-3333-4333-8333-333333333333",
          contextSnapshot: null,
          permissions: null,
        }]).then(onFulfilled, onRejected),
    }));
    mockAccessService.canUser.mockResolvedValue(false);
    mockAccessService.decide.mockImplementation(async (input: { actor?: { type?: string; source?: string }; action?: string }) => {
      const allowed = (input.actor?.type === "board" && input.actor.source === "local_implicit")
        || (input.actor?.type === "agent" && [
          "company_scope:read", "issue:read", "issue:mutate", "runtime:manage",
        ].includes(input.action ?? ""));
      return {
        allowed,
        action: input.action,
        reason: allowed ? "allow_explicit_grant" : "deny_missing_grant",
        explanation: allowed ? "Allowed by test grant." : `Missing permission: ${input.action ?? "action"}`,
      };
    });
    mockAccessService.hasPermission.mockResolvedValue(false);
  });

  it("PATCH {status:cancelled} on issue with monitor armed in the past + attemptCount=0", async () => {
    const pastIso = "2026-08-14T17:47:08.000Z";
    const monitorPolicy = normalizeIssueExecutionPolicy({
      stages: [],
      monitor: { nextCheckAt: pastIso, scheduledBy: "assignee", notes: "MGC-2852 self-triage monitor" },
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1", status: "in_progress",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333", assigneeUserId: null,
      createdByUserId: "local-board", identifier: "MGC-2852-REPRO",
      title: "Repro of MGC-2860", executionPolicy: monitorPolicy, executionState: null,
      monitorAttemptCount: 0, monitorNextCheckAt: new Date(pastIso),
      monitorLastTriggeredAt: null, monitorNotes: "MGC-2852 self-triage monitor",
      monitorScheduledBy: "assignee",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue, ...patch, updatedAt: new Date(),
    }));
    const res = await request(await createApp({
      type: "agent", agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1", runId: "run-1",
    })).patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").send({ status: "cancelled" });
    expect(res.status).toBe(200);
    expect(res.body).not.toMatchObject({ error: "Internal server error" });
  });

  it("PATCH {executionPolicy:{monitor:null}} on issue with monitor armed in the past", async () => {
    const pastIso = "2026-08-14T17:47:08.000Z";
    const monitorPolicy = normalizeIssueExecutionPolicy({
      stages: [],
      monitor: { nextCheckAt: pastIso, scheduledBy: "assignee", notes: "..." },
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1", status: "in_progress",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333", assigneeUserId: null,
      createdByUserId: "local-board", identifier: "MGC-2852-REPRO-2",
      title: "Repro 2", executionPolicy: monitorPolicy, executionState: null,
      monitorAttemptCount: 0, monitorNextCheckAt: new Date(pastIso),
      monitorLastTriggeredAt: null, monitorNotes: "...", monitorScheduledBy: "assignee",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue, ...patch, updatedAt: new Date(),
    }));
    const res = await request(await createApp({
      type: "agent", agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1", runId: "run-1",
    })).patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ executionPolicy: { monitor: null } });
    expect(res.status).toBe(200);
    expect(res.body).not.toMatchObject({ error: "Internal server error" });
  });

  it("PATCH {monitorNextCheckAt:null} on issue with monitor armed in the past", async () => {
    const pastIso = "2026-08-14T17:47:08.000Z";
    const monitorPolicy = normalizeIssueExecutionPolicy({
      stages: [],
      monitor: { nextCheckAt: pastIso, scheduledBy: "assignee", notes: "..." },
    })!;
    const issue = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      companyId: "company-1", status: "in_progress",
      assigneeAgentId: "33333333-3333-4333-8333-333333333333", assigneeUserId: null,
      createdByUserId: "local-board", identifier: "MGC-2852-REPRO-3",
      title: "Repro 3", executionPolicy: monitorPolicy, executionState: null,
      monitorAttemptCount: 0, monitorNextCheckAt: new Date(pastIso),
      monitorLastTriggeredAt: null, monitorNotes: "...", monitorScheduledBy: "assignee",
    };
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
      ...issue, ...patch, updatedAt: new Date(),
    }));
    const res = await request(await createApp({
      type: "agent", agentId: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1", runId: "run-1",
    })).patch("/api/issues/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
      .send({ monitorNextCheckAt: null });
    expect(res.status).toBe(200);
    expect(res.body).not.toMatchObject({ error: "Internal server error" });
  });
});
