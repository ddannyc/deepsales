import { useEffect, useId, useRef, useState } from 'react'
import { Button } from './components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/ui/select'
import { Switch } from './components/ui/switch'

export type Translation = {
  id: string
  sourceVersion: string
  sourceText: string
  targetLanguage: string
  translatedText: string
}
const languages = {
  en: '英语',
  zh: '中文',
  es: '西班牙语',
  fr: '法语',
  de: '德语',
  ja: '日语',
  pt: '葡萄牙语',
  ar: '阿拉伯语',
}

export function MessageTranslation({
  workspaceId,
  conversationId,
  text,
  messageId,
  disabled = false,
  onSend,
}: {
  workspaceId: string
  conversationId: string
  text: string
  messageId?: string
  disabled?: boolean
  onSend?: (translation: Translation) => Promise<void>
}) {
  const [enabled, setEnabled] = useState(!messageId)
  const [language, setLanguage] = useState('en')
  const [result, setResult] = useState<Translation>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const switchId = useId()
  const inputKey = JSON.stringify([text, language, workspaceId, conversationId])
  const input = useRef({ key: inputKey, version: crypto.randomUUID() })
  if (input.current.key !== inputKey)
    input.current = { key: inputKey, version: crypto.randomUUID() }
  const version = input.current.version
  const requestId = version
  const current = useRef(version)
  current.current = version
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const valid =
    result?.sourceText === (messageId ? text : text.trim()) &&
    result.targetLanguage === language &&
    (messageId || result.sourceVersion === version)
  async function translate() {
    setBusy(true)
    setError('')
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/conversations/${conversationId}/translations`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: requestId,
            sourceVersion: version,
            targetLanguage: language,
            ...(messageId ? { sourceMessageId: messageId } : { sourceText: text }),
          }),
        },
      )
      const data = await response.json().catch(() => ({}))
      if (!response.ok)
        throw new Error(
          data.error?.code === 'QUOTA_EXHAUSTED'
            ? '翻译额度不足，原稿已保留。'
            : data.error?.code === 'OPERATION_PAUSED'
              ? '翻译结果未确认，已暂停。原稿已保留，请稍后检查重试。'
              : data.error?.code === 'RETRY_LATER'
                ? '服务暂不可用，请按重试间隔稍后重试。原稿已保留。'
                : '翻译失败或权限已变化，原稿已保留，请检查后重试。',
        )
      if (mounted.current && current.current === version) setResult(data.translation)
    } catch (cause) {
      if (mounted.current && current.current === version)
        setError(cause instanceof Error ? cause.message : '翻译失败，原稿已保留。')
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <section className="message-translation" aria-label={messageId ? '消息翻译' : '发送翻译'}>
      {messageId && (
        <label className="switch-field" htmlFor={switchId}>
          显示译文
          <Switch id={switchId} checked={enabled} onCheckedChange={setEnabled} />
        </label>
      )}
      {enabled && (
        <>
          <div className="message-translation-controls">
            <Select
              value={language}
              onValueChange={(value) => {
                setLanguage(value)
                setError('')
              }}
              disabled={disabled}
            >
              <SelectTrigger aria-label={messageId ? '消息翻译目标语言' : '发送翻译目标语言'}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(languages).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || busy || !text.trim()}
              onClick={() => void translate()}
            >
              {busy ? '处理中…' : '预览译文'}
            </Button>
          </div>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {result && !valid && (
            <p className="field-description" role="status">
              原稿或目标语言已变化，旧译文失效。请重新翻译。
            </p>
          )}
          {valid && result && (
            <>
              <p className="field-description">
                译文 · {languages[result.targetLanguage as keyof typeof languages]}
              </p>
              <p className="translation-text" dir="auto">
                {result.translatedText}
              </p>
              {onSend && (
                <Button
                  type="button"
                  disabled={disabled || busy}
                  onClick={() => {
                    setBusy(true)
                    setError('')
                    void onSend(result)
                      .catch(() => {
                        if (mounted.current)
                          setError('发送未确认成功，原稿与译文已保留；请检查状态后重试。')
                      })
                      .finally(() => {
                        if (mounted.current) setBusy(false)
                      })
                  }}
                >
                  确认发送译文
                </Button>
              )}
            </>
          )}
          {!messageId && (
            <p className="field-description">保留原稿与译文，确认后才发送；翻译计入工作区用量。</p>
          )}
        </>
      )}
    </section>
  )
}
