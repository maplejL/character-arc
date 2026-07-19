import { readUserWorkspace, type WorkspacePayload } from '../workspace/json-store.js'
import { registerElectronMock } from './register-electron-mock.js'
import { resolveUserAppSettings, mapProviderForAiSdk } from './settings.js'
import { normalizeAppSettings } from '../../../electron/main/workspace-types.js'
import {
  applyTaskModelSettings,
  forceTemperatureForModel,
  mergeChapterProductionModels,
  normalizeChapterProductionModels,
  type ChapterProductionModels,
} from '../../../electron/shared/ai/model-roles.js'
import { resolveUserProductionAiContext } from '../services/ai-production-config.js'

export type AiTaskPayloadInput = {
  task: string
  settings?: Record<string, unknown>
  context: Record<string, unknown>
  clientKey?: string
  clientTaskId?: string
}

export type PrepareServerAiTaskOptions = {
  chapterProductionModels?: ChapterProductionModels
}

function toElectronWorkspace(payload: WorkspacePayload): import('../../../electron/main/workspace-types.js').WorkspacePayload {
  return payload as unknown as import('../../../electron/main/workspace-types.js').WorkspacePayload
}

function pickRunModelOverrides(context: Record<string, unknown>): ChapterProductionModels {
  return normalizeChapterProductionModels({
    draftProfileId: context.draftProfileId,
    repairProfileId: context.repairProfileId,
    auditProfileId: context.auditProfileId,
  })
}

export async function prepareServerAiTask(
  userId: string,
  payload: AiTaskPayloadInput,
  options?: PrepareServerAiTaskOptions,
) {
  registerElectronMock()

  const { createMemoryWorkspaceDb, runWithWorkspaceDb } = await import(
    '../../../electron/main/workspace-store.js'
  )
  const { retrieveKnowledgeContext } = await import('../../../electron/main/ai/knowledge-retrieval.js')

  const workspace = await readUserWorkspace(userId)
  const db = await createMemoryWorkspaceDb(toElectronWorkspace(workspace))
  const serverDefaults = await resolveUserAppSettings(userId)
  const productionCtx = await resolveUserProductionAiContext(userId)
  const wsApp = normalizeAppSettings(workspace.appSettings as Parameters<typeof normalizeAppSettings>[0])

  const aiProfiles =
    productionCtx.aiProfiles.length > 0
      ? productionCtx.aiProfiles
      : wsApp.aiProfiles.map((profile) => ({
          id: profile.id,
          name: profile.name,
          provider: profile.provider,
          model: profile.model,
          baseUrl: profile.baseUrl,
          apiKey: profile.apiKey,
          temperature: profile.temperature,
          topP: profile.topP,
        }))

  const activeAiProfileId = productionCtx.activeAiProfileId || wsApp.activeAiProfileId
  const chapterProductionModels = mergeChapterProductionModels(
    productionCtx.chapterProductionModels,
    wsApp.chapterProductionModels,
    options?.chapterProductionModels,
    pickRunModelOverrides(payload.context),
  )

  const mergedSettings = applyTaskModelSettings(
    {
      ...serverDefaults,
      embeddingModel: '',
      aiProfiles,
      activeAiProfileId,
      chapterProductionModels,
      aiTimeoutSeconds: serverDefaults.aiTimeoutSeconds,
    },
    payload.task,
  )

  const clientSampling =
    payload.settings && typeof payload.settings === 'object'
      ? {
          temperature: payload.settings.temperature as number | undefined,
          topP: payload.settings.topP as number | undefined,
        }
      : {}
  const taskPayload = {
    ...payload,
    settings: {
      ...mergedSettings,
      provider: mapProviderForAiSdk(mergedSettings.provider),
      ...clientSampling,
      // 客户端 temperature 不得覆盖模型硬约束（如 k3 仅允许 1）
      temperature: forceTemperatureForModel(
        mergedSettings.model,
        clientSampling.temperature ?? mergedSettings.temperature,
      ),
    },
  } as import('../../../electron/main/ai/shared-types.js').AiTaskPayload

  const knowledgeContext = retrieveKnowledgeContext(
    taskPayload,
    workspace as unknown as Parameters<typeof retrieveKnowledgeContext>[1],
  )

  return {
    db,
    taskPayload,
    knowledgeContext,
    runWithWorkspaceDb,
    chapterProductionModels,
    aiProfiles,
    activeAiProfileId,
  }
}
