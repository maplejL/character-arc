import { randomUUID } from 'node:crypto'
import { prepareServerAiTask, type AiTaskPayloadInput } from './prepare-ai-task.js'
import { importAiRuntime } from './register-electron-mock.js'
import { resolveUserAppSettings, mapProviderForAiSdk } from './settings.js'
import {
  applyTaskModelSettings,
  forceTemperatureForModel,
  mergeChapterProductionModels,
  type ChapterProductionModels,
} from '../../../electron/shared/ai/model-roles.js'
import { resolveUserProductionAiContext } from '../services/ai-production-config.js'

const activeTasks = new Map<string, AbortController>()

export function cancelAiTask(clientTaskId: string): boolean {
  const controller = activeTasks.get(clientTaskId)
  if (!controller) return false
  controller.abort()
  return true
}

/**
 * 不灌内存 SQLite / 不做知识库检索的 AI 调用。
 * 适合 continuation-reverse-extract 这类「材料全在 context」的任务，
 * 避免大 workspace 写入 SQLite 触发外键失败。
 */
export async function runServerAiTaskDirect(
  userId: string,
  payload: AiTaskPayloadInput,
  options?: { chapterProductionModels?: ChapterProductionModels },
): Promise<{ success: boolean; result?: unknown; error?: string; meta?: Record<string, unknown> }> {
  const clientTaskId = payload.clientTaskId || ''
  const controller = new AbortController()
  if (clientTaskId) activeTasks.set(clientTaskId, controller)

  try {
    const { runAiTask } = await importAiRuntime()
    const serverDefaults = await resolveUserAppSettings(userId)
    const productionCtx = await resolveUserProductionAiContext(userId)
    const chapterProductionModels = mergeChapterProductionModels(
      productionCtx.chapterProductionModels,
      options?.chapterProductionModels,
    )
    const mergedSettings = applyTaskModelSettings(
      {
        ...serverDefaults,
        embeddingModel: '',
        aiProfiles: productionCtx.aiProfiles,
        activeAiProfileId: productionCtx.activeAiProfileId,
        chapterProductionModels,
        aiTimeoutSeconds: serverDefaults.aiTimeoutSeconds ?? 300,
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

    const response = await runAiTask(taskPayload, undefined, controller.signal)
    return {
      success: true,
      result: response.result,
      meta: { id: randomUUID(), ...response.meta },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI 调用失败'
    return { success: false, error: message }
  } finally {
    if (clientTaskId) activeTasks.delete(clientTaskId)
  }
}

export async function runServerAiTask(
  userId: string,
  payload: AiTaskPayloadInput,
): Promise<{ success: boolean; result?: unknown; error?: string; meta?: Record<string, unknown> }> {
  const clientTaskId = payload.clientTaskId || ''
  const controller = new AbortController()
  if (clientTaskId) activeTasks.set(clientTaskId, controller)

  let db: Awaited<ReturnType<typeof prepareServerAiTask>>['db'] | null = null

  try {
    const prepared = await prepareServerAiTask(userId, payload)
    db = prepared.db
    const { runAiTask } = await importAiRuntime()

    const response = await prepared.runWithWorkspaceDb(db, async () =>
      runAiTask(prepared.taskPayload, prepared.knowledgeContext, controller.signal),
    )

    return {
      success: true,
      result: response.result,
      meta: { id: randomUUID(), ...response.meta },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI 调用失败'
    return { success: false, error: message }
  } finally {
    if (clientTaskId) activeTasks.delete(clientTaskId)
    try {
      db?.close()
    } catch {
      /* ignore */
    }
  }
}

export async function fetchServerModels(userId: string): Promise<Array<{ id: string; ownedBy: string | null }>> {
  const { fetchModels } = await importAiRuntime()
  const { normalizeSettings } = await import('../../../electron/main/ai/settings.js')
  const { resolveUserAppSettings, mapProviderForAiSdk } = await import('./settings.js')
  const settings = await resolveUserAppSettings(userId)
  return fetchModels(
    normalizeSettings({
      ...settings,
      provider: mapProviderForAiSdk(settings.provider),
    }),
  )
}
