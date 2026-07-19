import { streamAiTask } from '../electron/main/ai/runtime/orchestrator'
import { retrieveKnowledgeContext } from '../electron/main/ai/knowledge-retrieval'
import type { AiTaskName, AppSettings, AiTaskPayload } from '../electron/main/ai/shared-types'
import type { WorkspacePayload } from '../electron/main/workspace-types'

export type HeadlessStreamTaskName =
  | 'chapter-first-draft'
  | 'chapter-memo'
  | 'chapter-audit'
  | 'chapter-quality-review'
  | 'chapter-repair'
  | 'chapter-session-note'

function extractStreamText(task: HeadlessStreamTaskName, buffer: string, result: unknown): string {
  if (buffer.trim()) return buffer.trim()
  if (!result || typeof result !== 'object') return ''
  const record = result as Record<string, unknown>
  if (typeof record.content === 'string' && record.content.trim()) return record.content.trim()
  if (typeof record.text === 'string' && record.text.trim()) return record.text.trim()
  if (typeof record.repairedContent === 'string' && record.repairedContent.trim()) {
    return record.repairedContent.trim()
  }
  if (task === 'chapter-repair' && typeof record.repair === 'string') return record.repair.trim()
  return ''
}

export function createHeadlessStreamTask(
  appSettings: AppSettings,
  getSnapshot: () => WorkspacePayload | null,
): (task: HeadlessStreamTaskName, context: Record<string, unknown>) => Promise<{ text: string; result?: unknown }> {
  return async (task, context) => {
    let buffer = ''
    const payload: AiTaskPayload = {
      task: task as AiTaskName,
      settings: appSettings,
      context,
    }
    const knowledgeContext = retrieveKnowledgeContext(
      payload,
      getSnapshot() as Parameters<typeof retrieveKnowledgeContext>[1],
    )
    const response = await streamAiTask(
      payload,
      {
        onTextDelta: (delta) => {
          buffer += delta
        },
      },
      new AbortController().signal,
      knowledgeContext,
    )
    const text = extractStreamText(task, buffer, response.result)
    return { text, result: response.result }
  }
}
