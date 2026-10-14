import { useEffect, useState } from 'react'
import { Button } from '#components/ui/button'
import { Input } from '#components/ui/input'
import { Textarea } from '#components/ui/textarea'
import { Switch } from '#components/ui/switch'
import { StatusBadge } from '#components/ui/status-badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '#components/ui/alert-dialog'

type Plugin = {
  id: string
  revision?: number
  name: string
  channelId: string
  origin: string
  enabled: boolean
  auth: 'NONE' | 'BEARER'
  configured: boolean
}
type Tool = {
  id: string
  revision?: number
  pluginId: string
  name: string
  description: string
  enabled: boolean
  method: string
  path: string
  effect: 'READ' | 'WRITE'
  inputs: unknown[]
  fixed: unknown[]
  output: unknown[]
  objectScope: string
}
type Configuration = { plugins: Plugin[]; tools: Tool[]; allowedOrigins: string[] }
type JsonFields = { inputs: string; fixed: string; output: string }
const schemaExample = '[{"name":"status","path":["status"],"type":"string"}]'
export function AiExternalTools({
  workspaceId,
  memberId,
}: {
  workspaceId: string
  memberId: string
}) {
  const root = `/api/workspaces/${workspaceId}/ai-operations/${memberId}`
  const [data, setData] = useState<Configuration>()
  const [channels, setChannels] = useState<{ id: string; name: string }[]>([])
  const [plugin, setPlugin] = useState<Plugin>()
  const [credential, setCredential] = useState('')
  const [clearCredential, setClearCredential] = useState(false)
  const [tool, setTool] = useState<Tool>()
  const [json, setJson] = useState<JsonFields>({ inputs: '[]', fixed: '[]', output: schemaExample })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [debugValues, setDebugValues] = useState('{}')
  const [debug, setDebug] = useState<{
    state: string
    simulated: boolean
    result?: unknown
    failureCode?: string
  }>()
  const [deleting, setDeleting] = useState<{
    kind: 'plugins' | 'external-tools'
    id: string
    revision: number
    name: string
  }>()
  async function refresh() {
    const response = await fetch(`${root}/plugins`)
    if (!response.ok) throw new Error('工具配置读取失败，请重试。')
    setData(await response.json())
  }
  useEffect(() => {
    const controller = new AbortController()
    void Promise.all([
      fetch(`${root}/plugins`, { signal: controller.signal }),
      fetch(`${root}/setup`, { signal: controller.signal }),
    ])
      .then(async ([config, setup]) => {
        if (!config.ok || !setup.ok) throw new Error('工具配置读取失败，请重试。')
        const configuration = await config.json(),
          readiness = await setup.json()
        if (!controller.signal.aborted) {
          setData(configuration)
          setChannels(readiness.channels)
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(cause.message)
      })
    return () => controller.abort()
  }, [root])
  async function request(path: string, method: string, body: unknown) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await fetch(`${root}/${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const result = await response.json().catch(() => null)
      if (!response.ok)
        throw new Error(`操作失败：${result?.error?.code ?? '请重试'}。输入已保留。`)
      await refresh()
      window.dispatchEvent(new Event('ai-tools.changed'))
      return result
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败，请重试。')
      return null
    } finally {
      setBusy(false)
    }
  }
  function editTool(value: Tool) {
    setTool(value)
    setJson({
      inputs: JSON.stringify(value.inputs, null, 2),
      fixed: JSON.stringify(value.fixed, null, 2),
      output: JSON.stringify(value.output, null, 2),
    })
    setDebug(undefined)
  }
  async function saveTool() {
    if (!tool) return
    try {
      const {
        id,
        revision,
        pluginId,
        name,
        description,
        enabled,
        method,
        path,
        effect,
        objectScope,
      } = tool
      const saved = await request('external-tools', 'POST', {
        id,
        revision,
        pluginId,
        name,
        description,
        enabled,
        method,
        path,
        effect,
        objectScope,
        inputs: JSON.parse(json.inputs),
        fixed: JSON.parse(json.fixed),
        output: JSON.parse(json.output),
      })
      if (saved) {
        editTool(saved)
        setNotice('工具定义已立即生效。')
      }
    } catch {
      setError('参数或输出映射 JSON 无效，输入已保留。')
    }
  }
  return (
    <section className="runtime-panel" aria-label="外部 API 工具">
      <h2>外部 API 工具</h2>
      <p className="field-description">
        插件按渠道组织工具，保存立即生效。工具引用随指令发布；权限、定义和当前输入会在执行时重新检查。
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!data && !error && <p>正在读取工具配置…</p>}
      <div className="row-actions">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => void refresh().catch((cause) => setError(cause.message))}
        >
          刷新工具配置
        </Button>
        <Button
          type="button"
          disabled={busy || !data?.allowedOrigins.length || !channels.length}
          onClick={() => {
            setPlugin({
              id: crypto.randomUUID(),
              name: '',
              channelId: channels[0].id,
              origin: data?.allowedOrigins[0] ?? '',
              enabled: true,
              auth: 'BEARER',
              configured: false,
            })
            setCredential('')
            setClearCredential(false)
          }}
        >
          新建 API 插件
        </Button>
      </div>
      {data && !data.allowedOrigins.length && (
        <p className="field-description">
          尚未配置部署允许的 HTTPS 地址，请由站点管理员配置后刷新。
        </p>
      )}
      {data && !channels.length && (
        <p className="field-description">需要您与 AI 共同拥有的渠道权限才能配置工具。</p>
      )}
      {data?.plugins.length === 0 && <p>尚未配置 API 插件。</p>}
      {data?.plugins.map((item) => (
        <div key={item.id} className="runtime-panel">
          <p>
            <strong>{item.name}</strong> · {item.origin} ·{' '}
            <StatusBadge tone={item.enabled && item.configured ? 'success' : 'warning'}>
              {!item.enabled ? '已停用' : item.configured ? '可配置工具' : '凭据未配置'}
            </StatusBadge>
          </p>
          <p className="field-description">
            {item.auth === 'NONE' ? '无需凭据' : item.configured ? '凭据已配置' : '凭据未配置'} ·
            修订 {item.revision}
          </p>
          <div className="row-actions">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setPlugin(item)
                setCredential('')
                setClearCredential(false)
              }}
            >
              编辑插件 {item.name}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() =>
                editTool({
                  id: crypto.randomUUID(),
                  pluginId: item.id,
                  name: '',
                  description: '',
                  enabled: true,
                  method: 'GET',
                  path: '/status',
                  effect: 'READ',
                  inputs: [],
                  fixed: [],
                  output: JSON.parse(schemaExample),
                  objectScope: '',
                })
              }
            >
              添加工具到 {item.name}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() =>
                setDeleting({
                  kind: 'plugins',
                  id: item.id,
                  revision: item.revision ?? 1,
                  name: item.name,
                })
              }
            >
              删除插件 {item.name}
            </Button>
          </div>
        </div>
      ))}
      {plugin && (
        <form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault()
            const { id, revision, name, channelId, origin, enabled, auth } = plugin
            void request('plugins', 'POST', {
              id,
              revision,
              name,
              channelId,
              origin,
              enabled,
              auth,
              ...(clearCredential ? { credential: null } : credential ? { credential } : {}),
            }).then((saved) => {
              if (saved) {
                setPlugin(saved)
                setCredential('')
                setClearCredential(false)
                setNotice('插件配置已立即生效。')
              }
            })
          }}
        >
          <h3>编辑 API 插件</h3>
          <label className="form-field" htmlFor="external-plugin-name">
            插件名称
            <Input
              id="external-plugin-name"
              required
              maxLength={100}
              disabled={busy}
              value={plugin.name}
              onChange={(event) => setPlugin({ ...plugin, name: event.target.value })}
            />
          </label>
          <label htmlFor="external-plugin-channel">适用渠道</label>
          <Select
            value={plugin.channelId}
            disabled={busy}
            onValueChange={(channelId) => setPlugin({ ...plugin, channelId })}
          >
            <SelectTrigger id="external-plugin-channel">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {channels.map((channel) => (
                <SelectItem key={channel.id} value={channel.id}>
                  {channel.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label htmlFor="external-plugin-origin">部署允许的 API 地址</label>
          <Select
            value={plugin.origin}
            disabled={busy}
            onValueChange={(origin) => setPlugin({ ...plugin, origin })}
          >
            <SelectTrigger id="external-plugin-origin">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {data?.allowedOrigins.map((origin) => (
                <SelectItem key={origin} value={origin}>
                  {origin}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label htmlFor="external-plugin-auth">鉴权</label>
          <Select
            value={plugin.auth}
            disabled={busy}
            onValueChange={(auth) => setPlugin({ ...plugin, auth: auth as Plugin['auth'] })}
          >
            <SelectTrigger id="external-plugin-auth">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="BEARER">Bearer 凭据</SelectItem>
              <SelectItem value="NONE">无需凭据</SelectItem>
            </SelectContent>
          </Select>
          {plugin.auth === 'BEARER' && (
            <>
              <label className="form-field" htmlFor="external-plugin-secret">
                设置或替换凭据
                <Input
                  id="external-plugin-secret"
                  type="password"
                  autoComplete="new-password"
                  maxLength={4000}
                  disabled={busy || clearCredential}
                  value={credential}
                  onChange={(event) => setCredential(event.target.value)}
                />
              </label>
              <p className="field-description">
                只显示是否已配置。留空保留当前凭据，保存后不会回显。
              </p>
              <label>
                <input
                  type="checkbox"
                  disabled={busy}
                  checked={clearCredential}
                  onChange={(event) => setClearCredential(event.target.checked)}
                />
                清除当前凭据
              </label>
            </>
          )}
          <div className="switch-field">
            <span>启用插件</span>
            <Switch
              aria-label="启用插件"
              checked={plugin.enabled}
              disabled={busy}
              onCheckedChange={(enabled) => setPlugin({ ...plugin, enabled })}
            />
          </div>
          <div className="ai-form-actions">
            <Button type="submit" disabled={busy}>
              保存 API 插件
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setPlugin(undefined)
                setCredential('')
              }}
            >
              取消插件编辑
            </Button>
          </div>
        </form>
      )}
      <h3>工具定义</h3>
      {data?.tools.length === 0 && <p>尚未添加工具。</p>}
      {data?.tools.map((item) => (
        <div key={item.id} className="runtime-panel">
          <p>
            <strong>{item.name}</strong> · {item.effect === 'WRITE' ? '写入' : '读取'} ·{' '}
            <StatusBadge tone={item.enabled ? 'info' : 'neutral'}>
              {item.enabled ? '已启用' : '已停用'}
            </StatusBadge>{' '}
            · 修订 {item.revision}
          </p>
          <div className="row-actions">
            <Button type="button" variant="outline" disabled={busy} onClick={() => editTool(item)}>
              编辑工具 {item.name}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => {
                void navigator.clipboard
                  .writeText(`[[tool:external:${item.id}]]`)
                  .then(() => setNotice('工具引用已复制，可插入指令。'))
                  .catch(() => setError('复制失败，请通过指令编辑器的工具列表插入。'))
              }}
            >
              复制引用 {item.name}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() =>
                setDeleting({
                  kind: 'external-tools',
                  id: item.id,
                  revision: item.revision ?? 1,
                  name: item.name,
                })
              }
            >
              删除工具 {item.name}
            </Button>
          </div>
        </div>
      ))}
      {tool && (
        <form
          className="dialog-form"
          onSubmit={(event) => {
            event.preventDefault()
            void saveTool()
          }}
        >
          <h3>编辑外部工具</h3>
          <label className="form-field" htmlFor="external-tool-name">
            工具名称
            <Input
              id="external-tool-name"
              required
              maxLength={100}
              disabled={busy}
              value={tool.name}
              onChange={(event) => setTool({ ...tool, name: event.target.value })}
            />
          </label>
          <label className="form-field" htmlFor="external-tool-description">
            用途说明
            <Textarea
              id="external-tool-description"
              maxLength={1000}
              disabled={busy}
              value={tool.description}
              onChange={(event) => setTool({ ...tool, description: event.target.value })}
            />
          </label>
          <label htmlFor="external-tool-method">HTTP 方法</label>
          <Select
            value={tool.method}
            disabled={busy}
            onValueChange={(method) => setTool({ ...tool, method })}
          >
            <SelectTrigger id="external-tool-method">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => (
                <SelectItem key={method} value={method}>
                  {method}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label className="form-field" htmlFor="external-tool-path">
            固定路径
            <Input
              id="external-tool-path"
              required
              maxLength={1000}
              disabled={busy}
              value={tool.path}
              onChange={(event) => setTool({ ...tool, path: event.target.value })}
            />
          </label>
          <label htmlFor="external-tool-effect">操作性质</label>
          <Select
            value={tool.effect}
            disabled={busy}
            onValueChange={(effect) => setTool({ ...tool, effect: effect as Tool['effect'] })}
          >
            <SelectTrigger id="external-tool-effect">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="READ">只读</SelectItem>
              <SelectItem value="WRITE">写入</SelectItem>
            </SelectContent>
          </Select>
          <p className="field-description">
            按 API
            实际效果选择。写入必须绑定固定目标，不能把对象、账号或主机交由模型选择；站点不会自动验证第三方对象归属。
          </p>
          {(['inputs', 'fixed', 'output'] as const).map((key) => (
            <label key={key} className="form-field" htmlFor={`external-tool-${key}`}>
              {
                {
                  inputs: '输入定义 JSON（name、type、location、required）',
                  fixed: '固定参数 JSON（name、location、value）',
                  output: '输出映射 JSON（name、path、type）',
                }[key]
              }
              <Textarea
                id={`external-tool-${key}`}
                required
                disabled={busy}
                value={json[key]}
                onChange={(event) => setJson({ ...json, [key]: event.target.value })}
              />
            </label>
          ))}
          <p className="field-description">
            type 为 string、number 或 boolean；location 为 path、query 或 body。输出 path 为最多 4
            层字段名数组，仅映射选定字段。每次最多 10 秒、64 KiB；整轮最多 3 个工具动作。
          </p>
          {tool.effect === 'WRITE' && (
            <label className="form-field" htmlFor="external-tool-scope">
              固定对象授权策略 JSON
              <Textarea
                id="external-tool-scope"
                required
                disabled={busy}
                value={tool.objectScope}
                placeholder={
                  '{"policy":"FIXED_CONFIG","description":"已授权固定账号","targets":[{"name":"accountId","location":"body"}]}'
                }
                onChange={(event) => setTool({ ...tool, objectScope: event.target.value })}
              />
            </label>
          )}
          <div className="switch-field">
            <span>启用工具</span>
            <Switch
              aria-label="启用工具"
              checked={tool.enabled}
              disabled={busy}
              onCheckedChange={(enabled) => setTool({ ...tool, enabled })}
            />
          </div>
          <div className="ai-form-actions">
            <Button type="submit" disabled={busy}>
              保存外部工具
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setTool(undefined)}
            >
              取消工具编辑
            </Button>
          </div>
          {tool.revision && (
            <>
              <h3>沙箱调试</h3>
              <p className="field-description">
                始终返回带模拟标记的映射示例，不读取生产凭据、不请求生产
                API。未知写入结果需人工核实，系统不会盲目重试。
              </p>
              <label className="form-field" htmlFor="external-tool-debug">
                模拟输入 JSON
                <Textarea
                  id="external-tool-debug"
                  disabled={busy}
                  value={debugValues}
                  onChange={(event) => setDebugValues(event.target.value)}
                />
              </label>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  try {
                    const values = JSON.parse(debugValues)
                    void request(`external-tools/${tool.id}/debug`, 'POST', {
                      id: crypto.randomUUID(),
                      values,
                    }).then((result) => {
                      if (result) setDebug(result)
                    })
                  } catch {
                    setError('模拟输入 JSON 无效，输入已保留。')
                  }
                }}
              >
                运行沙箱调试
              </Button>
            </>
          )}
          {debug && (
            <div role="status">
              <StatusBadge
                tone={
                  debug.state === 'UNKNOWN'
                    ? 'warning'
                    : debug.state === 'SUCCEEDED'
                      ? 'info'
                      : 'destructive'
                }
              >
                {debug.simulated ? '沙箱模拟' : ''} ·{' '}
                {debug.state === 'SUCCEEDED'
                  ? '已完成'
                  : debug.state === 'UNKNOWN'
                    ? '结果不明，已暂停'
                    : '失败'}
              </StatusBadge>
              <pre>{JSON.stringify(debug.result ?? { error: debug.failureCode }, null, 2)}</pre>
            </div>
          )}
        </form>
      )}
      <AlertDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleting(undefined)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除 {deleting?.name}？</AlertDialogTitle>
            <AlertDialogDescription>
              新动作会被阻止，已有动作事实保留。删除插件还会清除凭据，已发生的外部操作不会自动撤回。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>保留配置</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                event.preventDefault()
                if (deleting)
                  void request(deleting.kind, 'DELETE', {
                    id: deleting.id,
                    revision: deleting.revision,
                  }).then((result) => {
                    if (result) {
                      setDeleting(undefined)
                      setPlugin(undefined)
                      setTool(undefined)
                      setNotice('配置已删除，动作记录保留。')
                    }
                  })
              }}
            >
              确认删除配置
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
