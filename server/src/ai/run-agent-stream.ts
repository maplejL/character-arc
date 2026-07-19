import { randomUUID } from 'node:crypto'
import { prepareServerAiTask, type AiTaskPayloadInput } from './prepare-ai-task.js'
import {
  closeStreamSession,
  createStreamSession,
  emitStreamEvent,
  type StreamSession,
} from './stream-session.js'
import { importAiRuntime } from './register-electron-mock.js'

function isToolUseNotSupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('tool') && (message.includes('not supported') || message.includes('不支持'))
}

export function startServerAgentStream(
  userId: string,
  payload: AiTaskPayloadInput,
  streamId: string,
): StreamSession {
  const session = createStreamSession(userId, streamId)

  void (async () => {
    let streamedContent = ''
    let db: Awaited<ReturnType<typeof prepareServerAiTask>>['db'] | null = null

    try {
      const prepared = await prepareServerAiTask(userId, payload)
      db = prepared.db
      const { runStreamingAgentTask } = await import(
        '../../../electron/main/ai/agent/streaming-orchestrator.js'
      )

      const runAgent = async (): Promise<void> => {
        const result = await prepared.runWithWorkspaceDb(db!, async () =>
          runStreamingAgentTask(
            prepared.taskPayload,
            {
              onTextDelta: (delta: string) => {
                streamedContent += delta
                emitStreamEvent(streamId, { type: 'chunk', delta, charCount: streamedContent.length })
              },
              onReasoningDelta: (delta: string) => {
                emitStreamEvent(streamId, { type: 'reasoning', delta })
              },
              onToolUseStart: (toolUseId, toolName, args) => {
                emitStreamEvent(streamId, { type: 'tool_use_start', toolUseId, toolName, args })
              },
              onToolResult: (toolUseId, toolName, content, isError, durationMs) => {
                emitStreamEvent(streamId, { type: 'tool_result', toolUseId, toolName, content, isError, durationMs })
              },
              onAgentStatus: (message, iteration, maxIterations) => {
                emitStreamEvent(streamId, { type: 'agent_status', message, iteration, maxIterations })
              },
              onEditApplied: (chapterId, editType, preview, versionId) => {
                emitStreamEvent(streamId, { type: 'edit_applied', chapterId, editType, preview, versionId })
              },
              onEditProposed: (chapterId, proposalId, editType, preview, oldContent, newContent) => {
                emitStreamEvent(streamId, {
                  type: 'edit_proposed',
                  chapterId,
                  proposalId,
                  editType,
                  preview,
                  oldContent,
                  newContent,
                })
              },
            },
            session.controller.signal,
            prepared.knowledgeContext,
          ),
        )

        emitStreamEvent(streamId, {
          type: 'done',
          content: streamedContent,
          result: result.result,
          meta: { id: randomUUID(), ...result.meta },
        })
      }

      try {
        await runAgent()
      } catch (agentError) {
        if (!isToolUseNotSupportedError(agentError)) throw agentError
        if (!db) throw agentError
        streamedContent = ''
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
      }
    } catch (error) {
      if (session.controller.signal.aborted) {
        emitStreamEvent(streamId, { type: 'canceled', content: streamedContent })
      } else {
        const message = error instanceof Error ? error.message : 'Agent 流式调用失败'
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
