const archiveFiles = new Map<string, File>()

export function cacheArchiveFile(file: File): string {
  const id = `web-archive-${crypto.randomUUID()}`
  archiveFiles.set(id, file)
  return id
}

export function takeArchiveFile(id: string): File | null {
  const file = archiveFiles.get(id) ?? null
  archiveFiles.delete(id)
  return file
}

export function peekArchiveFile(id: string): File | null {
  return archiveFiles.get(id) ?? null
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('read failed'))
    reader.readAsDataURL(file)
  })
}

export function pickImageFile(): Promise<{ canceled: true } | { canceled: false; file: File; dataUrl: string }> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png,image/jpeg,image/webp,image/gif'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) {
        resolve({ canceled: true })
        return
      }
      void readFileAsDataUrl(file).then(
        (dataUrl) => resolve({ canceled: false, file, dataUrl }),
        () => resolve({ canceled: true }),
      )
    }
    input.click()
  })
}

export function pickArchiveFile(): Promise<{ canceled: true } | { canceled: false; file: File }> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.carc,application/zip'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) resolve({ canceled: true })
      else resolve({ canceled: false, file })
    }
    input.click()
  })
}

export function pickZipFile(): Promise<{ canceled: true } | { canceled: false; file: File }> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.zip,application/zip'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) resolve({ canceled: true })
      else resolve({ canceled: false, file })
    }
    input.click()
  })
}

export function pickReferenceNovelFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = '.txt,.md,text/plain'
    input.onchange = () => resolve(Array.from(input.files ?? []))
    input.click()
  })
}

export function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export function downloadDataUrl(filename: string, dataUrl: string): void {
  const anchor = document.createElement('a')
  anchor.href = dataUrl
  anchor.download = filename
  anchor.click()
}

export function downloadBlobFile(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
}

export function pickJsonFile(): Promise<{ canceled: true } | { canceled: false; file: File; text: string }> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) {
        resolve({ canceled: true })
        return
      }
      void file.text().then(
        (text) => resolve({ canceled: false, file, text }),
        () => resolve({ canceled: true }),
      )
    }
    input.click()
  })
}

export async function exportChapterDocxFile(
  filename: string,
  title: string,
  content: string,
): Promise<{ success: boolean; canceled: boolean; error?: string }> {
  try {
    const { Document, HeadingLevel, Packer, Paragraph, TextRun } = await import('docx')
    const titleText = title.trim() || '未命名章节'
    const paragraphs = content.split(/\r?\n/).map((line) => line.trim())
    const doc = new Document({
      creator: 'CharacterArc',
      title: titleText,
      sections: [
        {
          children: [
            new Paragraph({
              heading: HeadingLevel.HEADING_1,
              children: [new TextRun({ text: titleText, bold: true, size: 36 })],
            }),
            ...paragraphs.map(
              (line) =>
                new Paragraph({
                  spacing: { line: 360 },
                  children: [new TextRun({ text: line, size: 24 })],
                }),
            ),
          ],
        },
      ],
    })
    const buffer = await Packer.toBlob(doc)
    downloadBlobFile(filename, buffer)
    return { success: true, canceled: false }
  } catch (e) {
    return { success: false, canceled: false, error: e instanceof Error ? e.message : '导出 DOCX 失败' }
  }
}
