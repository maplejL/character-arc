import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  AssistantEventPush,
  StageAcceptRequest,
  StageBindTargetRequest,
  StageCommitRequest,
  StageRejectRequest,
  TurnCancelRequest,
  TurnSendRequest,
} from '@shared/assistant-runtime'
import { runWithUserWorkspace } from '../ai/user-workspace-run.js'
import { emitProgress, PROGRESS_CHANNELS } from '../events/progress-hub.js'
import { cancelActiveTurn, setActiveTurn, takeActiveTurn } from './active-turns.js'

type SnapshotRef = import('../../../electron/main/workspace-types.js').WorkspacePayload

async function withBootstrappedAssistant<T>(
  userId: string,
  fn: (ctx: {
    db: DatabaseSync
    getSnapshot: () => SnapshotRef
    refreshSnapshot: () => Promise<void>
  }) => Promise<T>,
): Promise<T> {
  return runWithUserWorkspace(
    userId,
    async (ctx) => {
      const { readWorkspaceSnapshot } = await import('../../../electron/main/workspace-store.js')
      const { bootstrapAssistantRuntime } = await import('../../../electron/main/ai/runtime-v2/bootstrap.js')

      let snapshotRef = ctx.snapshot as SnapshotRef
      const getSnapshot = (): SnapshotRef => snapshotRef
      const refreshSnapshot = async (): Promise<void> => {
        const next = readWorkspaceSnapshot(ctx.db)
        if (next) snapshotRef = next
        await ctx.persist()
      }

      bootstrapAssistantRuntime({
        ensureDb: async () => ctx.db,
        getSnapshot,
        refreshSnapshot,
      })

      return fn({ db: ctx.db, getSnapshot, refreshSnapshot })
    },
    { persist: true },
  )
}

function pushAssistantEvent(userId: string, push: AssistantEventPush): void {
  emitProgress(userId, PROGRESS_CHANNELS.assistant, push)
}

export async function assistantSessionList(
  userId: string,
  payload: { projectId: string; surfaceId?: string; scopeRef?: string; limit?: number },
) {
  return withBootstrappedAssistant(userId, async () => {
    const { getConversation } = await import('../../../electron/main/ai/runtime-v2/ipc.js')
    const cm = await getConversation()
    return cm.listSessions({
      projectId: payload.projectId,
      surfaceId: payload.surfaceId as never,
      scopeRef: payload.scopeRef,
      limit: payload.limit,
    })
  })
}

export async function assistantSessionCreate(
  userId: string,
  payload: { projectId: string; surfaceId: string; scopeRef?: string; title: string },
) {
  return withBootstrappedAssistant(userId, async () => {
    const { getConversation } = await import('../../../electron/main/ai/runtime-v2/ipc.js')
    const cm = await getConversation()
    return cm.createSession({
      projectId: payload.projectId,
      surfaceId: payload.surfaceId as never,
      scopeRef: payload.scopeRef,
      title: payload.title,
    })
  })
}

export async function assistantSessionDelete(userId: string, payload: { sessionId: string }) {
  return withBootstrappedAssistant(userId, async () => {
    const { getConversation } = await import('../../../electron/main/ai/runtime-v2/ipc.js')
    const { stagedChangesStore } = await import('../../../electron/main/ai/runtime-v2/staged-changes-store.js')
    const cm = await getConversation()
    cm.deleteSession(payload.sessionId)
    stagedChangesStore.clearSession(payload.sessionId)
    return { ok: true }
  })
}

export async function assistantSessionLoad(
  userId: string,
  payload: { sessionId: string; withReplay?: boolean },
) {
  return withBootstrappedAssistant(userId, async () => {
    const { getConversation } = await import('../../../electron/main/ai/runtime-v2/ipc.js')
    const cm = await getConversation()
    const session = cm.getSession(payload.sessionId)
    if (!session) return { session: null, turns: [], events: [] }
    const turns = cm.listTurns(payload.sessionId)
    const events = payload.withReplay ? turns.flatMap((t) => cm.listEvents(t.id)) : []
    return { session, turns, events }
  })
}

export async function assistantSessionRename(
  userId: string,
  payload: { sessionId: string; title: string },
) {
  return withBootstrappedAssistant(userId, async () => {
    const { getConversation } = await import('../../../electron/main/ai/runtime-v2/ipc.js')
    const cm = await getConversation()
    cm.renameSession(payload.sessionId, payload.title)
    return { ok: true }
  })
}

export async function assistantTurnSend(userId: string, payload: TurnSendRequest) {
  return withBootstrappedAssistant(userId, async (ctx) => {
    const { getConversation } = await import('../../../electron/main/ai/runtime-v2/ipc.js')
    const { stagedChangesStore } = await import('../../../electron/main/ai/runtime-v2/staged-changes-store.js')
    const { AgentLoop } = await import('../../../electron/main/ai/runtime-v2/agent-loop.js')
    const { createExecutionPlanner } = await import('../../../electron/main/ai/runtime-v2/execution-plan.js')

    const cm = await getConversation()
    const session = cm.getSession(payload.sessionId)
    if (!session) throw new Error(`session not found: ${payload.sessionId}`)

    const resolvePlan = createExecutionPlanner({
      snapshot: { getSnapshot: ctx.getSnapshot },
      onKnowledgeSaved: ctx.refreshSnapshot,
    })

    const plan = await resolvePlan({ session, surface: payload.surface, request: payload })
    const controller = new AbortController()
    const emitter = (evt: AssistantEventPush): void => pushAssistantEvent(userId, evt)

    const loop = new AgentLoop(cm, stagedChangesStore, emitter)
    const result = await loop.run({
      session,
      surface: payload.surface,
      turnInput: {
        userMessage: payload.userMessage,
        intentHint: payload.intentHint,
        attachments: payload.attachments,
      },
      systemPrompt: plan.systemPrompt,
      tools: plan.tools,
      settings: plan.settings,
      signal: controller.signal,
      maxSteps: payload.surface.maxSteps,
      maxOutputTokens: plan.maxOutputTokens,
      onTurnCreated: (turnId) => setActiveTurn(turnId, controller),
    })
    takeActiveTurn(result.turnId)

    const ledgerSnapshot = plan.evidenceLedger.snapshot()
    const resumable =
      result.status === 'done' && (plan.runtimePlan.requiresBatching || ledgerSnapshot.budgetExhausted)
    cm.upsertTurnState({
      turnId: result.turnId,
      sessionId: session.id,
      phase: resumable ? 'awaiting-continue' : 'done',
      planJson: JSON.stringify(plan.runtimePlan),
      ledgerJson: JSON.stringify(ledgerSnapshot),
      resumable,
      continuationPrompt: resumable ? plan.runtimePlan.continuationPrompt : '',
    })

    if (resumable) {
      emitter({
        sessionId: session.id,
        turnId: result.turnId,
        event: {
          kind: 'resumable',
          seq: 0,
          label: plan.runtimePlan.continuationLabel,
          prompt: plan.runtimePlan.continuationPrompt,
          reason: ledgerSnapshot.budgetExhausted
            ? '本批读取预算已用完，建议进入下一批。'
            : '这是分批任务，建议按下一批继续推进。',
        },
      })
    }

    return result
  })
}

export async function assistantTurnCancel(userId: string, payload: TurnCancelRequest) {
  const ok = cancelActiveTurn(payload.turnId)
  return ok
    ? { ok: true }
    : { ok: false, reason: 'turn not active or already finished' }
}

export async function assistantStageList(
  userId: string,
  payload: { sessionId?: string; status?: readonly string[]; kind?: readonly string[]; turnId?: string },
) {
  return withBootstrappedAssistant(userId, async () => {
    const { stagedChangesStore } = await import('../../../electron/main/ai/runtime-v2/staged-changes-store.js')
    await import('../../../electron/main/ai/runtime-v2/ipc.js').then((m) => m.getConversation())
    return stagedChangesStore.list(
      { status: payload.status as never, kind: payload.kind as never, turnId: payload.turnId },
      payload.sessionId,
    )
  })
}

export async function assistantStageAccept(userId: string, payload: StageAcceptRequest) {
  return withBootstrappedAssistant(userId, async () => {
    const { stagedChangesStore } = await import('../../../electron/main/ai/runtime-v2/staged-changes-store.js')
    await import('../../../electron/main/ai/runtime-v2/ipc.js').then((m) => m.getConversation())
    return stagedChangesStore.accept(payload.changeIds)
  })
}

export async function assistantStageReject(userId: string, payload: StageRejectRequest) {
  return withBootstrappedAssistant(userId, async () => {
    const { stagedChangesStore } = await import('../../../electron/main/ai/runtime-v2/staged-changes-store.js')
    await import('../../../electron/main/ai/runtime-v2/ipc.js').then((m) => m.getConversation())
    return stagedChangesStore.reject(payload.changeIds)
  })
}

export async function assistantStageBindTarget(userId: string, payload: StageBindTargetRequest) {
  return withBootstrappedAssistant(userId, async () => {
    const { stagedChangesStore } = await import('../../../electron/main/ai/runtime-v2/staged-changes-store.js')
    await import('../../../electron/main/ai/runtime-v2/ipc.js').then((m) => m.getConversation())
    const updated = stagedChangesStore.bindTarget(payload.changeId, payload.entityId)
    return updated ?? null
  })
}

export async function assistantStageCommit(userId: string, payload: StageCommitRequest) {
  return withBootstrappedAssistant(userId, async (ctx) => {
    const { stagedChangesStore } = await import('../../../electron/main/ai/runtime-v2/staged-changes-store.js')
    const { createCommitter } = await import('../../../electron/main/ai/runtime-v2/committer.js')
    const { peekSharedConversation } = await import('../../../electron/main/ai/runtime-v2/state.js')
    await import('../../../electron/main/ai/runtime-v2/ipc.js').then((m) => m.getConversation())

    const commitChange = createCommitter({
      resolveProjectId: (sessionId) => {
        const cm = peekSharedConversation()
        if (!cm) return null
        return cm.getSession(sessionId)?.projectId ?? null
      },
      onCommitted: ctx.refreshSnapshot,
    })

    return stagedChangesStore.commit(commitChange, { changeIds: payload.changeIds })
  })
}

export async function legacySessionList(userId: string, projectId: string) {
  return runWithUserWorkspace(userId, async (ctx) => {
    const rows = ctx.db
      .prepare(
        'SELECT id, title, created_at, updated_at FROM assistant_sessions WHERE project_id = ? ORDER BY updated_at DESC',
      )
      .all(projectId) as Array<{ id: string; title: string; created_at: string; updated_at: string }>
    return { success: true, result: rows }
  })
}

export async function legacySessionLoad(userId: string, sessionId: string) {
  return runWithUserWorkspace(userId, async (ctx) => {
    const row = ctx.db
      .prepare(
        'SELECT id, project_id, title, messages_json, created_at, updated_at FROM assistant_sessions WHERE id = ?',
      )
      .get(sessionId) as
      | { id: string; project_id: string; title: string; messages_json: string; created_at: string; updated_at: string }
      | undefined
    if (!row) return { success: false, error: '会话不存在' }
    const parsed = JSON.parse(row.messages_json)
    const messages = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.messages) ? parsed.messages : []
    return {
      success: true,
      result: {
        ...row,
        ...(!Array.isArray(parsed) && parsed && typeof parsed === 'object' ? parsed : {}),
        messages,
      },
    }
  })
}

export async function legacySessionSave(
  userId: string,
  payload: {
    id: string
    projectId: string
    title: string
    messages: unknown[]
    proposal?: unknown | null
    lastProposalPrompt?: string
    lastAssistantReply?: string
  },
) {
  return runWithUserWorkspace(
    userId,
    async (ctx) => {
      const now = new Date().toISOString()
      const messagesJson = JSON.stringify({
        messages: payload.messages,
        proposal: payload.proposal ?? null,
        lastProposalPrompt: payload.lastProposalPrompt ?? '',
        lastAssistantReply: payload.lastAssistantReply ?? '',
      })
      ctx.db
        .prepare(
          `INSERT INTO assistant_sessions (id, project_id, title, messages_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, messages_json = excluded.messages_json, updated_at = excluded.updated_at`,
        )
        .run(payload.id, payload.projectId, payload.title, messagesJson, now, now)
      return { success: true }
    },
    { persist: true },
  )
}

export async function legacySessionDelete(userId: string, sessionId: string) {
  return runWithUserWorkspace(
    userId,
    async (ctx) => {
      ctx.db.prepare('DELETE FROM assistant_sessions WHERE id = ?').run(sessionId)
      return { success: true }
    },
    { persist: true },
  )
}
