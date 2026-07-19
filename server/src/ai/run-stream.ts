import { randomUUID } from 'node:crypto'
import { prepareServerAiTask, type AiTaskPayloadInput } from './prepare-ai-task.js'
import {
  closeStreamSession,
  createStreamSession,
  emitStreamEvent,
  type StreamSession,
} from './stream-session.js'
import { importAiRuntime } from './register-electron-mock.js'

export function startServerAiStream(userId: string, payload: AiTaskPayloadInput, streamId: string): StreamSession {
  const session = createStreamSession(userId, streamId)

  void (async () => {
    let streamedContent = ''
    let db: Awaited<ReturnType<typeof prepareServerAiTask>>['db'] | null = null

    try {
      const prepared = await prepareServerAiTask(userId, payload)
      db = prepared.db
      const { streamAiTask } = await importAiRuntime()

      const result = await prepared.runWithWorkspaceDb(db, async () =>
        streamAiTask(
          prepared.taskPayload,
          {
            onTextDelta: (delta: string) => {
              streamedContent += delta
              emitStreamEvent(streamId, { type: 'chunk', delta, charCount: streamedContent.length })
            },
            onReasoningDelta: (delta: string) => {
              emitStreamEvent(streamId, { type: 'reasoning', delta })
            },
          },
          session.controller.signal,
          prepared.knowledgeContext,
        ),
      )

      const content =
        (result.result as { content?: string } | undefined)?.content?.trim() || streamedContent.trim()

      emitStreamEvent(streamId, {
        type: 'done',
        content,
        result: result.result,
        meta: { id: randomUUID(), ...result.meta },
      })
    } catch (error) {
      if (session.controller.signal.aborted) {
        emitStreamEvent(streamId, { type: 'canceled', content: streamedContent })
      } else {
        const message = error instanceof Error ? error.message : 'AI 流式调用失败'
        emitStreamEvent(streamId, { type: 'error', error: message })
      }
    } finally {
      try {
        db?.close()
      } catch {
        /* ignore */
      }
      closeStreamSession(streamId)
    }
  })()

  return session
}
