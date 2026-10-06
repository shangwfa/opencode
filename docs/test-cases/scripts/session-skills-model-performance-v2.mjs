import assert from "node:assert/strict"

// 每个样本独立会话，避免resume:false积压输入随后被模型一起执行。
export async function measureSkillExecution({ api, command, db, base, headers, mode, image, save }) {
  const result = {
    scope: "真实模型原生skill加载、默认code-mode工具执行；每档单次探索样本",
    model: { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" },
    samples: [],
  }
  for (const [resourcesCount, steps] of [
    [0, 0],
    [5, 1],
    [50, 10],
  ]) {
    const session = await api("POST", "/api/session", {
      title: `skill-model-perf-${resourcesCount}`,
      model: result.model,
      location: { directory: "/workspace" },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
      sandbox: { cpu: "1", memory: "2Gi", image, persistMode: mode },
    })
    const sid = session.data.id
    const sample = { sessionID: sid, resourcesCount, steps, events: [], passed: false }
    result.samples.push(sample)
    save(result)
    try {
      const readyStarted = performance.now()
      await command(sid, "mkdir -p /workspace/perf-output")
      sample.createToShellReadyMs = performance.now() - readyStarted
      const id = `model-perf-${resourcesCount}`
      const resources = Array.from({ length: resourcesCount }, (_, i) =>
        i < steps
          ? {
              path: `scripts/step-${i}.cjs`,
              type: "script",
              content: `require('node:fs').writeFileSync('/workspace/perf-output/step-${i}.json',JSON.stringify({step:${i},value:${i + 1}}));console.log('STEP_${i}_OK')`,
            }
          : { path: `references/r${i}.txt`, type: "doc", content: "Benchmark reference. " + "x".repeat(1024) },
      )
      const finalCode = `const fs=require('node:fs');const n=${steps};let sum=0;for(let i=0;i<n;i++){const x=JSON.parse(fs.readFileSync('/workspace/perf-output/step-'+i+'.json'));if(x.step!==i||x.value!==i+1)throw Error('bad step');sum+=x.value}fs.writeFileSync('/workspace/perf-output/result.json',JSON.stringify({steps:n,sum}));console.log('PERF_DONE')`
      const content = steps
        ? `Execute each scripts/step-0.cjs through scripts/step-${steps - 1}.cjs from this skill's resource_directory with node. Use a separate native shell invocation for each script. Shell is native, not in the code-mode catalog. Then run node -e ${JSON.stringify(finalCode)} in a final native shell invocation. Never rewrite the supplied scripts. Finish only after PERF_DONE.`
        : `Run node -e ${JSON.stringify(finalCode)} in a shell tool invocation. Finish only after PERF_DONE.`
      await api("POST", `/api/session/${sid}/skills`, {
        id,
        description: "Deterministic benchmark workflow",
        content,
        resources,
      })
      const controller = new AbortController()
      const stream = await fetch(`${base}/api/session/${sid}/event`, { headers, signal: controller.signal })
      assert(stream.ok && stream.body)
      const reader = stream.body.getReader()
      const started = performance.now()
      let done, streamError
      const pump = (async () => {
        let buffer = ""
        const decoder = new TextDecoder()
        try {
          while (!done) {
            const chunk = await reader.read()
            if (chunk.done) break
            buffer += decoder.decode(chunk.value, { stream: true })
            let index
            while ((index = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, index).trim()
              buffer = buffer.slice(index + 1)
              if (!line.startsWith("data:")) continue
              let event
              try {
                event = JSON.parse(line.slice(5).trim())
              } catch {
                continue
              }
              if (
                !/^session\.(tool\.(input.started|called|success|failed)|step\.(started|ended|failed)|execution\.(started|succeeded|failed)|text.started)$/.test(
                  event.type,
                )
              )
                continue
              const recorded = {
                type: event.type,
                elapsedMs: performance.now() - started,
                id: event.data?.id,
                name: event.data?.name,
                ...(event.data?.error ? { error: event.data.error } : {}),
                ...(event.data?.input ? { input: event.data.input } : {}),
              }
              sample.events.push(recorded)
              save(result)
              if (["session.execution.succeeded", "session.execution.failed"].includes(event.type)) done = event.type
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) streamError = error
        }
      })()
      try {
        await api("POST", `/api/session/${sid}/prompt`, {
          text: `First call the execute/code-mode tool with JavaScript that computes the sum of integers 1 through ${steps} and returns that number. No search or external tools are needed for that calculation. Then load the skill ${id} with the native skill tool and execute its workflow exactly with native shell calls. Shell is not in the code-mode catalog. Do not only summarize instructions.`,
          model: result.model,
          resume: true,
        })
        sample.admissionMs = performance.now() - started
        const deadline = Date.now() + 300000
        while (!done && Date.now() < deadline) {
          if (streamError) throw streamError
          await Bun.sleep(200)
        }
        sample.totalMs = performance.now() - started
        assert.equal(done, "session.execution.succeeded", "模型执行未成功终止")
      } finally {
        controller.abort()
        await reader.cancel().catch(() => {})
        await pump
      }
      const skillCall = sample.events.find((e) => e.type === "session.tool.input.started" && e.name === "skill")
      const executeCall = sample.events.find((e) => e.type === "session.tool.input.started" && e.name === "execute")
      assert(skillCall && executeCall, "必须实际调用原生skill和默认code-mode execute")
      const skillEnd = sample.events.find((e) => e.type === "session.tool.success" && e.id === skillCall.id)
      assert(skillEnd, "skill加载未成功")
      sample.skillLoadMs = skillEnd.elapsedMs - skillCall.elapsedMs
      sample.firstSkillCallMs = skillCall.elapsedMs
      sample.firstExecuteMs = executeCall.elapsedMs
      sample.modelSteps = sample.events.filter((e) => e.type === "session.step.started").length
      const artifact = await command(sid, "cat /workspace/perf-output/result.json")
      assert.deepEqual(JSON.parse(artifact), { steps, sum: (steps * (steps + 1)) / 2 })
      const persisted = (await db`select resources from session_skills where session_id=${sid} and skill_id=${id}`)[0]
      assert.deepEqual(JSON.parse(persisted.resources), resources)
      sample.artifactPassed = true
      const failedTools = sample.events.filter((event) => event.type === "session.tool.failed")
      const executeEnd = sample.events.find(
        (event) => event.type === "session.tool.success" && event.id === executeCall.id,
      )
      sample.pathConformant = failedTools.length === 0 && Boolean(executeEnd)
      sample.passed = sample.pathConformant
      if (!sample.pathConformant) sample.warning = "任务产物成功，但有工具失败或execute未成功；不计入正常执行性能"
      sample.runnerDiagnostic = await command(
        sid,
        'node -e \'const fs=require("fs");const p="/tmp/opencode-codemode-runner.log";console.log(JSON.stringify({runnerLog:fs.existsSync(p)?fs.readFileSync(p,"utf8").slice(-2000):null}))\'',
      ).catch((error) => String(error))
    } catch (error) {
      sample.error = String(error)
      save(result)
      await api("POST", `/api/session/${sid}/interrupt`, {}).catch(() => {})
      throw error
    } finally {
      try {
        await api("DELETE", `/api/session/${sid}`)
        sample.cleaned = true
      } catch (error) {
        sample.cleanupError = String(error)
      }
      save(result)
    }
  }
  return result
}
