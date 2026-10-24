import { useCallback, useEffect, useRef, useState } from "react"
import { errorText } from "./model"

export function useResource<T>(key: string, load: (signal: AbortSignal) => Promise<T>) {
  const loader = useRef(load)
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<{ key: string; data?: T; error?: string; loading: boolean }>({ key: "", loading: true })
  useEffect(() => { loader.current = load }, [load])
  useEffect(() => {
    const abort = new AbortController()
    setState((old) => ({ key, data: old.key === key ? old.data : undefined, loading: true }))
    void loader.current(abort.signal).then(
      (data) => { if (!abort.signal.aborted) setState({ key, data, loading: false }) },
      (error: unknown) => { if (!abort.signal.aborted) setState((old) => ({ ...old, error: errorText(error), loading: false })) },
    )
    return () => abort.abort()
  }, [key, revision])
  const reload = useCallback(() => setRevision((value) => value + 1), [])
  return { data: state.key === key ? state.data : undefined, error: state.key === key ? state.error : undefined, loading: state.key !== key || state.loading, reload }
}
