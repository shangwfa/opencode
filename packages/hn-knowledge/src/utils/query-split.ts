/**
 * 查询分词（规则式查询理解，无 LLM 依赖）。
 *
 * 背景（2026-10 实测）：自然语言问句的疑问框架（"是什么/怎么/吗"）与定语虚词会稀释
 * 检索排序——"知识库是什么" 漏检最佳答案《总览》，而拆成核心片段并行检索 + RRF 融合后
 * 稳定排第 1。本模块提供确定性的核心片段抽取，作为 LLM 类查询扩展（multiQuery/HyDE）的
 * 无 LLM 替代；是否启用由调用方通过 recallConfig.enableQuerySplit 决定。
 */

/** 疑问框架/语气词/动词框架（反复剥离直至稳定） */
const STOP_PATTERNS: RegExp[] = [
  /(?:请(?:问|帮我)?|麻烦|我想(?:知道|了解|问)|我要(?:知道|问)|能不能|可不可以|可以吗|能否)/g,
  /(?:是|为|有)(?:什么|啥|怎么(?:回事|样)?|干嘛|干什么)(?:呢|吗|的)?/g,
  /(?:怎么|怎样|咋)(?:办|弄|搞|做|样)?/g,
  /(?:如何|为何|为什么|为啥)(?:呢|吗)?/g,
  /(?:讲(?:讲|一下)|说(?:说|一下)|介绍(?:一下)?|解释(?:一下)?|说明(?:一下)?)/g,
  /(?:吗|呢|啊|吧|哦|呀|哈)(?![\w])/g,
  /(?:一下|这些|那些|这个|那个|的话)$/g,
]

/** 定语虚词（切分边界，不进入片段） */
const BOUNDARY_SPLIT = /(?:的|地|得|之)/g
/** 并列连接词（切分边界） */
const CONNECTOR_SPLIT = /(?:和|与|或|还是|以及|、|，|,|；|;)/g

function stripNoise(input: string): string {
  let s = input.trim()
  for (let round = 0; round < 3; round++) {
    const before = s
    for (const p of STOP_PATTERNS) s = s.replace(p, " ")
    if (s === before) break
  }
  return s.replace(/\s+/g, " ").trim()
}

/**
 * 把用户问句拆为核心片段组：
 * [0] 为去疑问框架的主干（保留原始语序信息），其后为按定语/连接词边界切出的子片段。
 * 保底：全部剥空时返回原句；片段去重、去单字、最多 4 段。
 */
export function splitQuery(query: string): string[] {
  const core = stripNoise(query)
  const fallback = core || query.trim()
  const parts = fallback
    .replace(CONNECTOR_SPLIT, "的")
    .split(BOUNDARY_SPLIT)
    .map((s) => s.replace(/[？?！!。.]+$/g, "").trim())
    .filter((s) => s.length >= 2)
  const subs: string[] = []
  for (const s of [fallback, ...parts]) {
    if (s && !subs.includes(s)) subs.push(s)
    if (subs.length >= 4) break
  }
  return subs.length ? subs : [query.trim()]
}
