import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '#components/ui/button'
import { Textarea } from '#components/ui/textarea'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '#components/ui/sheet'

type Note = { id: string; authorName: string; createdAt: string; text: string }
type NotePage = { notes: Note[]; olderCursor: string | null }

export function InternalNotes({
  workspaceId,
  conversationId,
  closed,
  revision,
}: {
  workspaceId: string
  conversationId: string
  closed: boolean
  revision: number
}) {
  const [open, setOpen] = useState(false)
  const [notes, setNotes] = useState<Note[]>([])
  const [draft, setDraft] = useState('')
  const clientKey = useRef(crypto.randomUUID())
  const [pages, setPages] = useState(1)
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [status, setStatus] = useState('')
  const generation = useRef(0)
  const base = `/api/workspaces/${workspaceId}/conversations/${conversationId}/notes`

  const refresh = useCallback(async () => {
    const request = ++generation.current
    setLoading(true)
    try {
      const items = new Map<string, Note>()
      let before: string | null = null
      for (let page = 0; page < pages; page++) {
        const response = await fetch(
          `${base}${before ? `?before=${encodeURIComponent(before)}` : ''}`,
        )
        if (request !== generation.current) return
        if (!response.ok) {
          if (response.status === 403) setNotes([])
          throw new Error(
            response.status === 403
              ? '无权读取内部备注，请检查频道权限。'
              : '内部备注加载失败，请重试。',
          )
        }
        const data = (await response.json()) as NotePage
        if (request !== generation.current) return
        for (const note of data.notes) items.set(note.id, note)
        before = data.olderCursor
        if (!before) break
      }
      setNotes(
        [...items.values()].sort(
          (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
      )
      setCursor(before)
      setError('')
    } catch (cause) {
      if (request === generation.current) setError((cause as Error).message)
    } finally {
      if (request === generation.current) setLoading(false)
    }
  }, [base, pages])

  useEffect(() => {
    if (!open) return
    void revision
    void refresh()
    const visible = () => {
      if (!document.hidden) void refresh()
    }
    window.addEventListener('focus', visible)
    return () => {
      generation.current++
      window.removeEventListener('focus', visible)
    }
  }, [open, refresh, revision])

  async function submit() {
    if (!draft.trim() || busy || closed) return
    setBusy(true)
    setSaveError('')
    setStatus('')
    try {
      const response = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: clientKey.current, text: draft }),
      })
      if (!response.ok)
        throw new Error(
          response.status === 403
            ? '无权添加内部备注，请检查频道权限。'
            : '备注未确认保存，草稿已保留；请重试。',
        )
      const data = (await response.json()) as { note: Note }
      setNotes((current) =>
        [...current.filter((note) => note.id !== data.note.id), data.note].sort(
          (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        ),
      )
      setDraft('')
      clientKey.current = crypto.randomUUID()
      setStatus('内部备注已保存')
      await refresh()
    } catch (cause) {
      setSaveError(
        cause instanceof TypeError
          ? '保存结果未确认，草稿已保留；重试不会重复添加。'
          : (cause as Error).message,
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button type="button" variant="outline">
          内部备注
        </Button>
      </SheetTrigger>
      <SheetContent showCloseButton={false} className="overflow-y-auto p-4">
        <SheetHeader>
          <SheetTitle>内部备注</SheetTitle>
          <SheetDescription>仅授权团队可见，不发送给客户，也不作为 AI 回答依据。</SheetDescription>
        </SheetHeader>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          关闭备注
        </Button>
        {error && <p role="alert">{error}</p>}
        {saveError && <p role="alert">{saveError}</p>}
        {status && <p role="status">{status}</p>}
        <Button type="button" variant="ghost" disabled={loading} onClick={() => void refresh()}>
          刷新备注
        </Button>
        {loading && <p role="status">正在加载内部备注…</p>}
        {cursor && (
          <Button
            type="button"
            variant="ghost"
            disabled={loading}
            onClick={() => setPages((current) => current + 1)}
          >
            加载更早备注
          </Button>
        )}
        <ol className="space-y-4" aria-label="内部备注列表">
          {notes.map((note) => (
            <li key={note.id} className="border-l-2 border-border pl-3">
              <p>
                <strong>{note.authorName}</strong> ·{' '}
                <time dateTime={note.createdAt}>{new Date(note.createdAt).toLocaleString()}</time>
              </p>
              <p className="whitespace-pre-wrap break-words">{note.text}</p>
            </li>
          ))}
        </ol>
        {!loading && !notes.length && <p>暂无内部备注。</p>}
        <label htmlFor={`note-draft-${conversationId}`}>内部备注草稿</label>
        <Textarea
          id={`note-draft-${conversationId}`}
          maxLength={2000}
          value={draft}
          disabled={busy || closed}
          onChange={(event) => {
            setDraft(event.target.value)
            clientKey.current = crypto.randomUUID()
          }}
        />
        {closed && <p>已关闭历史仅供阅读，无法添加备注。</p>}
        <Button
          type="button"
          disabled={busy || closed || !draft.trim()}
          onClick={() => void submit()}
        >
          {busy ? '保存中…' : '保存内部备注'}
        </Button>
      </SheetContent>
    </Sheet>
  )
}
