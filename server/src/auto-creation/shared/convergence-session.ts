export type ConvergencePhase = 'quality-review' | 'audit' | 'repair'

export type ConvergenceChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

export class ChapterConvergenceSession {
  readonly frozenPrefix: string
  readonly systemPrompt: string
  readonly messages: ConvergenceChatMessage[] = []
  private seeded = false

  constructor(frozenPrefix: string, systemPrompt: string) {
    this.frozenPrefix = frozenPrefix.trim()
    this.systemPrompt = systemPrompt.trim()
  }

  get isSeeded(): boolean {
    return this.seeded
  }

  seedWithDraft(draftUserTurn: string, draftText: string): void {
    if (this.seeded) return
    this.messages.push({ role: 'user', content: draftUserTurn })
    this.messages.push({ role: 'assistant', content: draftText.trim() })
    this.seeded = true
  }

  resetDraftHistory(draftUserTurn: string, draftText: string): void {
    this.messages.length = 0
    this.messages.push({ role: 'user', content: draftUserTurn })
    this.messages.push({ role: 'assistant', content: draftText.trim() })
    this.seeded = true
  }

  appendUserTurn(content: string): void {
    this.messages.push({ role: 'user', content: content.trim() })
  }

  appendAssistantTurn(content: string): void {
    this.messages.push({ role: 'assistant', content: content.trim() })
  }
}
