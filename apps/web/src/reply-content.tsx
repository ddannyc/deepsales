import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '#components/ui/button'
import { Input } from '#components/ui/input'
import { Textarea } from '#components/ui/textarea'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '#components/ui/sheet'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '#components/ui/alert-dialog'

type Asset = {
  id: string
  title: string
  filename: string
  kind: 'IMAGE' | 'FILE' | 'AUDIO' | 'VIDEO'
  mimeType: string
  byteSize: number
}
type Template = { id: string; title: string; text: string }

async function read<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok)
    throw new Error(
      response.status === 403
        ? '权限不足，请检查工作区或频道权限。'
        : response.status === 404
          ? '所选内容已失效，请重新选择。'
          : '操作未确认成功，草稿已保留；请重试。',
    )
  return response.json() as Promise<T>
}
const body = (value: unknown) => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(value),
})

export function ReplyContent({
  workspaceId,
  conversationId,
  canSend,
  onText,
  onEmoji,
  onSent,
}: {
  workspaceId: string
  conversationId: string
  canSend: boolean
  onText: (text: string) => void
  onEmoji: () => void
  onSent: () => Promise<void>
}) {
  const base = `/api/workspaces/${workspaceId}`
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [templates, setTemplates] = useState<Template[]>([])
  const [assets, setAssets] = useState<Asset[]>([])
  const [editing, setEditing] = useState<string>()
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<{
    kind: 'media-assets' | 'reply-templates'
    id: string
    title: string
  }>()
  const [file, setFile] = useState<File>()
  const [preview, setPreview] = useState('')
  const [selected, setSelected] = useState<Asset>()
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const [recording, setRecording] = useState(false)
  const recorder = useRef<MediaRecorder | undefined>(undefined)
  const microphone = useRef<MediaStream | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const recordingEpoch = useRef(0)
  const mounted = useRef(true)
  const loadEpoch = useRef(0)
  const deleteTrigger = useRef<HTMLButtonElement | null>(null)
  const searchInput = useRef<HTMLInputElement | null>(null)
  const uploadId = useRef(crypto.randomUUID())
  const sendKey = useRef(crypto.randomUUID())

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      recordingEpoch.current++
      if (recorder.current?.state === 'recording') recorder.current.stop()
      microphone.current?.getTracks().forEach((track) => {
        track.stop()
      })
      clearTimeout(timer.current)
      loadEpoch.current++
    }
  }, [])
  useEffect(() => {
    if (!file) {
      setPreview('')
      return
    }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const refresh = useCallback(async () => {
    const epoch = ++loadEpoch.current
    setLoading(true)
    try {
      const search = `?query=${encodeURIComponent(query)}`
      const [t, a] = await Promise.all([
        read<{ templates: Template[] }>(`${base}/reply-templates${search}`),
        read<{ assets: Asset[] }>(`${base}/media-assets${search}`),
      ])
      if (epoch !== loadEpoch.current || !mounted.current) return
      setTemplates(t.templates)
      setAssets(a.assets)
    } catch (cause) {
      if (epoch === loadEpoch.current) {
        setTemplates([])
        setAssets([])
        setError((cause as Error).message)
      }
    } finally {
      if (epoch === loadEpoch.current) setLoading(false)
    }
  }, [base, query])
  useEffect(() => {
    if (open) void refresh()
    return () => {
      loadEpoch.current++
    }
  }, [open, refresh])

  function chooseFile(value: File) {
    setFile(value)
    setSelected(undefined)
    uploadId.current = crypto.randomUUID()
    sendKey.current = crypto.randomUUID()
    setError('')
    setFeedback('')
  }
  async function upload() {
    if (!file) return
    setBusy(true)
    setError('')
    setFeedback('')
    try {
      const result = await read<{ asset: Asset }>(`${base}/media-assets`, {
        method: 'POST',
        headers: {
          'Content-Type': file.type,
          'X-Filename': encodeURIComponent(file.name),
          'X-Upload-Id': uploadId.current,
        },
        body: file,
      })
      if (mounted.current) {
        setSelected(result.asset)
        setFeedback('上传已完成，尚未发送。')
      }
    } catch (cause) {
      if (mounted.current) setError((cause as Error).message)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  async function send() {
    if (!selected || !canSend || busy) return
    setBusy(true)
    setError('')
    setFeedback('')
    try {
      await read(`${base}/conversations/${conversationId}/replies`, {
        method: 'POST',
        ...body({ assetId: selected.id, clientKey: sendKey.current }),
      })
      setSelected(undefined)
      setFile(undefined)
      sendKey.current = crypto.randomUUID()
      setFeedback('附件已提交，等待渠道发送。')
      await onSent()
    } catch (cause) {
      if (mounted.current) setError((cause as Error).message)
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  async function saveTemplate() {
    setBusy(true)
    setError('')
    try {
      await read(`${base}/reply-templates${editing ? `/${editing}` : ''}`, {
        method: editing ? 'PUT' : 'POST',
        ...body({ title, text }),
      })
      setTitle('')
      setText('')
      setEditing(undefined)
      setFeedback('话术已保存')
      await refresh()
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function mutateAsset(asset: Asset, change: { title?: string; inLibrary?: boolean }) {
    setBusy(true)
    setError('')
    try {
      await read(`${base}/media-assets/${asset.id}`, { method: 'PATCH', ...body(change) })
      setFeedback('素材已更新')
      await refresh()
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function remove() {
    if (!deleteTarget) return
    setBusy(true)
    setError('')
    try {
      await read(`${base}/${deleteTarget.kind}/${deleteTarget.id}`, { method: 'DELETE' })
      setFeedback('内容已删除')
      await refresh()
      searchInput.current?.focus()
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
      setDeleteTarget(undefined)
    }
  }

  async function startRecording() {
    setError('')
    setBusy(true)
    const epoch = ++recordingEpoch.current
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!mounted.current || epoch !== recordingEpoch.current) {
        stream.getTracks().forEach((track) => {
          track.stop()
        })
        return
      }
      microphone.current = stream
      const chunks: Blob[] = []
      const active = new MediaRecorder(stream)
      recorder.current = active
      active.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data)
      }
      active.onstop = async () => {
        stream.getTracks().forEach((track) => {
          track.stop()
        })
        clearTimeout(recordingTimer)
        if (!mounted.current || epoch !== recordingEpoch.current) return
        setRecording(false)
        setBusy(true)
        let audio: AudioContext | undefined
        try {
          audio = new AudioContext()
          const decoded = await audio.decodeAudioData(await new Blob(chunks).arrayBuffer())
          const samples = decoded.getChannelData(0)
          const wav = new ArrayBuffer(44 + samples.length * 2)
          const view = new DataView(wav)
          const write = (offset: number, value: string) => {
            for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
          }
          write(0, 'RIFF')
          view.setUint32(4, wav.byteLength - 8, true)
          write(8, 'WAVEfmt ')
          view.setUint32(16, 16, true)
          view.setUint16(20, 1, true)
          view.setUint16(22, 1, true)
          view.setUint32(24, decoded.sampleRate, true)
          view.setUint32(28, decoded.sampleRate * 2, true)
          view.setUint16(32, 2, true)
          view.setUint16(34, 16, true)
          write(36, 'data')
          view.setUint32(40, samples.length * 2, true)
          for (let i = 0; i < samples.length; i++)
            view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 32767, true)
          if (mounted.current && epoch === recordingEpoch.current)
            chooseFile(new File([wav], 'recording.wav', { type: 'audio/wav' }))
        } catch {
          if (mounted.current && epoch === recordingEpoch.current)
            setError('录音无法处理，请重新录制或上传音频。')
        } finally {
          await audio?.close().catch(() => {})
          if (mounted.current && epoch === recordingEpoch.current) setBusy(false)
        }
      }
      active.start()
      setRecording(true)
      const recordingTimer = setTimeout(() => {
        if (active.state === 'recording') active.stop()
      }, 60_000)
      timer.current = recordingTimer
    } catch {
      microphone.current?.getTracks().forEach((track) => {
        track.stop()
      })
      setError('无法使用麦克风，请检查浏览器权限，或上传音频文件。')
    } finally {
      if (mounted.current && epoch === recordingEpoch.current) setBusy(false)
    }
  }
  function cancelRecording() {
    recordingEpoch.current++
    if (recorder.current?.state === 'recording') recorder.current.stop()
    microphone.current?.getTracks().forEach((track) => {
      track.stop()
    })
    clearTimeout(timer.current)
    setRecording(false)
  }

  return (
    <div className="space-y-2 p-3 border-t border-border">
      <div className="flex flex-wrap items-center gap-2">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button type="button" variant="outline">
              话术与素材
            </Button>
          </SheetTrigger>
          <SheetContent showCloseButton={false} className="overflow-y-auto p-4 space-y-3">
            <SheetHeader>
              <SheetTitle>话术与私有素材</SheetTitle>
              <SheetDescription>
                团队共享；选用后进入草稿，不会直接发送。最多显示 100 项，可搜索。
              </SheetDescription>
            </SheetHeader>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              关闭内容库
            </Button>
            <label htmlFor="content-query">搜索话术和素材</label>
            <Input
              ref={searchInput}
              id="content-query"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              maxLength={200}
            />
            <Button variant="outline" disabled={loading} onClick={() => void refresh()}>
              搜索内容
            </Button>
            {loading && <p role="status">正在加载内容…</p>}
            <h3>话术</h3>
            {!loading && !templates.length && <p>暂无匹配话术。</p>}
            {templates.map((item) => (
              <div key={item.id} className="border-b border-border pb-2">
                <strong>{item.title}</strong>
                <p className="whitespace-pre-wrap">{item.text}</p>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    onText(item.text)
                    setOpen(false)
                  }}
                >
                  选用话术
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setEditing(item.id)
                    setTitle(item.title)
                    setText(item.text)
                  }}
                >
                  编辑话术
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={(event) => {
                    deleteTrigger.current = event.currentTarget
                    setDeleteTarget({ kind: 'reply-templates', id: item.id, title: item.title })
                  }}
                >
                  删除话术
                </Button>
              </div>
            ))}
            <label htmlFor="template-title">话术名称</label>
            <Input
              disabled={busy}
              id="template-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={100}
            />
            <label htmlFor="template-text">话术内容</label>
            <Textarea
              disabled={busy}
              id="template-text"
              value={text}
              onChange={(event) => setText(event.target.value)}
              maxLength={2000}
            />
            <Button
              disabled={busy || !title.trim() || !text.trim()}
              onClick={() => void saveTemplate()}
            >
              {editing ? '保存话术修改' : '创建话术'}
            </Button>
            {editing && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setEditing(undefined)
                  setTitle('')
                  setText('')
                }}
              >
                取消话术编辑
              </Button>
            )}
            <h3>私有素材</h3>
            {!loading && !assets.length && <p>暂无匹配素材。先在回复区上传，再加入素材库。</p>}
            {assets.map((asset) => (
              <div key={asset.id} className="border-b border-border pb-2">
                <label htmlFor={`asset-${asset.id}`}>素材名称</label>
                <Input
                  disabled={busy}
                  id={`asset-${asset.id}`}
                  defaultValue={asset.title}
                  maxLength={100}
                  onBlur={(event) => {
                    if (event.target.value.trim() && event.target.value !== asset.title)
                      void mutateAsset(asset, { title: event.target.value })
                  }}
                />
                <p>{asset.filename}</p>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setFile(undefined)
                    setSelected(asset)
                    sendKey.current = crypto.randomUUID()
                    setOpen(false)
                    setFeedback('素材已进入附件草稿，尚未发送。')
                  }}
                >
                  选用素材
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={(event) => {
                    deleteTrigger.current = event.currentTarget
                    setDeleteTarget({ kind: 'media-assets', id: asset.id, title: asset.title })
                  }}
                >
                  删除素材
                </Button>
              </div>
            ))}
            {error && <p role="alert">{error}</p>}
            {feedback && <p role="status">{feedback}</p>}
          </SheetContent>
        </Sheet>
        <label htmlFor="reply-file">上传附件</label>
        <Input
          id="reply-file"
          type="file"
          disabled={busy || recording}
          onChange={(event) => {
            const value = event.target.files?.[0]
            if (value) chooseFile(value)
            event.target.value = ''
          }}
        />
        {!recording ? (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void startRecording()}
          >
            开始录音
          </Button>
        ) : (
          <>
            <span role="status">录音中，最多 60 秒</span>
            <Button onClick={() => recorder.current?.stop()}>停止录音并预览</Button>
            <Button variant="ghost" onClick={cancelRecording}>
              取消录音
            </Button>
          </>
        )}
        <Button type="button" variant="ghost" onClick={onEmoji}>
          插入表情
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        图片 PNG/JPEG/GIF ≤8 MiB；PDF/TXT/ZIP/DOCX、MP3/WAV/OGG/M4A、MP4 ≤25
        MiB。附件单独发送，文字草稿保留。
      </p>
      {file && (
        <div>
          <span>
            {file.name} · {Math.ceil(file.size / 1024)} KiB
          </span>
          {file.type.startsWith('audio/') && (
            <audio controls src={preview} aria-label="录音或音频预览">
              <track kind="captions" />
            </audio>
          )}
          {file.type.startsWith('image/') && (
            <img className="max-h-32" src={preview} alt="待上传图片预览" />
          )}
          {file.type.startsWith('video/') && (
            <video controls className="max-h-32" src={preview} aria-label="待上传视频预览">
              <track kind="captions" />
            </video>
          )}
          {!selected && (
            <Button disabled={busy} onClick={() => void upload()}>
              {busy ? '上传中…' : '上传所选附件'}
            </Button>
          )}
        </div>
      )}
      {selected && (
        <div className="flex flex-wrap gap-2 items-center">
          <span>附件草稿：{selected.filename}</span>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => void mutateAsset(selected, { inLibrary: true })}
          >
            加入素材库
          </Button>
          <Button disabled={busy || !canSend} onClick={() => void send()}>
            {busy ? '提交中…' : '发送附件'}
          </Button>
        </div>
      )}
      {(file || selected) && (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setFile(undefined)
            setSelected(undefined)
            setFeedback('附件草稿已取消，未发送。')
          }}
        >
          取消附件草稿
        </Button>
      )}
      {error && !open && <p role="alert">{error}</p>}
      {feedback && !open && <p role="status">{feedback}</p>}
      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(value) => {
          if (!value) setDeleteTarget(undefined)
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            if (deleteTrigger.current?.isConnected) deleteTrigger.current.focus()
            else searchInput.current?.focus()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{deleteTarget?.title}」？</AlertDialogTitle>
            <AlertDialogDescription>
              内容将停止选用；已提交消息所引用的素材仍保留。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void remove()}>确认删除内容</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
