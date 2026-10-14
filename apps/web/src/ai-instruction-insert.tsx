import { useCallback, useEffect, useId, useState } from 'react'
import { Button } from './components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/ui/select'

export function AiInstructionInsert({
  workspaceId,
  memberId,
  disabled,
  onInsert,
}: {
  workspaceId: string
  memberId: string
  disabled: boolean
  onInsert: (text: string) => void
}) {
  const id = useId()
  const [variables, setVariables] = useState<{ key: string; label: string; type: string }[]>([])
  const [tools, setTools] = useState<{ id: string; label: string; description: string }[]>([])
  const [error, setError] = useState(false)
  const load = useCallback(
    async (signal?: AbortSignal) => {
      setError(false)
      setVariables([])
      setTools([])
      try {
        const response = await fetch(
          `/api/workspaces/${workspaceId}/ai-operations/${memberId}/variables`,
          { signal },
        )
        if (!response.ok) throw new Error('Variables unavailable')
        const data = await response.json()
        if (!signal?.aborted) {
          setVariables(data.variables)
          setTools(data.tools)
        }
      } catch {
        if (!signal?.aborted) setError(true)
      }
    },
    [workspaceId, memberId],
  )
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    const changed = () => {
      void load(controller.signal)
    }
    window.addEventListener('ai-tools.changed', changed)
    return () => {
      controller.abort()
      window.removeEventListener('ai-tools.changed', changed)
    }
  }, [load])
  return (
    <div className="form-field">
      <label htmlFor={id}>插入变量</label>
      <Select
        value=""
        disabled={disabled || !variables.length}
        onValueChange={(key) => onInsert(`{{${key}}}`)}
      >
        <SelectTrigger id={id}>
          <SelectValue placeholder={variables.length ? '选择变量插入指令' : '正在读取变量…'} />
        </SelectTrigger>
        <SelectContent>
          {variables.map((variable) => (
            <SelectItem key={variable.key} value={variable.key}>
              {variable.label} ·{' '}
              {(
                {
                  text: '文本',
                  number: '数字',
                  properties: '属性列表',
                  tags: '标签列表',
                } as Record<string, string>
              )[variable.type] ?? variable.type}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <label htmlFor={`${id}-tool`}>插入工具</label>
      <Select
        value=""
        disabled={disabled || !tools.length}
        onValueChange={(key) => onInsert(`[[tool:${key}]]`)}
      >
        <SelectTrigger id={`${id}-tool`}>
          <SelectValue placeholder={tools.length ? '选择工具插入指令' : '正在读取工具…'} />
        </SelectTrigger>
        <SelectContent>
          {tools.map((tool) => (
            <SelectItem key={tool.id} value={tool.id}>
              {tool.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="field-description">
        工具引用随指令发布生效，仍检查当前授权和输入。测试台仅模拟写动作，不分配、不记录真实备注、不外发。
      </p>
      <p className="field-description">
        仅用于 AI 指令。不存在或无权限的值为 null，不臆造；属性最多 20 项、标签最多 50
        项。变量是引用数据，不授予权限，也不用于 SQL 或 URL 主机。
      </p>
      {error && (
        <>
          <p role="alert">变量目录读取失败。</p>
          <Button type="button" variant="ghost" disabled={disabled} onClick={() => void load()}>
            重试读取变量
          </Button>
        </>
      )}
    </div>
  )
}
