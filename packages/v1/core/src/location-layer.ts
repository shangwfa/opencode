import { Effect, Layer, LayerMap } from "effect"
import { Location } from "./location"
import { Policy } from "./policy"
import { Config } from "./config"
import { PluginV2 } from "./plugin"
import { Catalog } from "./catalog"
import { Connector } from "./connector"
import { CommandV2 } from "./command"
import { AgentV2 } from "./agent"
import { PluginBoot } from "./plugin/boot"
import { Project } from "./project"
import { EventV2 } from "./event"
import { Credential } from "./credential"
import { Npm } from "./npm"
import { ModelsDev } from "./models-dev"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { Database } from "./database/database"
import { PermissionV2 } from "./permission"
import { PermissionSaved } from "./permission/saved"
import { FileSystem } from "./filesystem"
import { Ripgrep } from "./ripgrep"
import { Watcher } from "./filesystem/watcher"
import { LocationMutation } from "./location-mutation"
import { FileMutation } from "./file-mutation"
import { Reference } from "./reference"
import { ReferenceGuidance } from "./reference/guidance"
import { RepositoryCache } from "./repository-cache"
import { Pty } from "./pty"
import { SkillV2 } from "./skill"
import { SkillGuidance } from "./skill/guidance"
import { BuiltInTools } from "./tool/builtins"
import { Image } from "./image"
import { ToolRegistry } from "./tool/registry"
import { ToolOutputStore } from "./tool-output-store"
import { AppProcess } from "./process"
import { SessionStore } from "./session/store"
import { SessionTodo } from "./session/todo"
import { QuestionV2 } from "./question"
import { LLMClient } from "@opencode-ai/llm"
import { RequestExecutor } from "@opencode-ai/llm/route"
import * as SessionRunnerLLM from "./session/runner/llm"
import { SessionRunnerModel } from "./session/runner/model"
import { SystemContextBuiltIns } from "./system-context/builtins"
import { FetchHttpClient } from "effect/unstable/http"
import { LayerNode } from "./effect/layer-node"

export class LocationServiceMap extends LayerMap.Service<LocationServiceMap>()("@opencode/example/LocationServiceMap", {
  lookup: (ref: Location.Ref) => {
    const boot = Layer.effectDiscard(
      Effect.logInfo("booting location services", { directory: ref.directory, workspaceID: ref.workspaceID }),
    )
    const location = LayerNode.compile(Location.boundNode(ref))
    const systemContext = LayerNode.compile(SystemContextBuiltIns.node)
    const base = Layer.mergeAll(
      location,
      Policy.locationLayer,
      Config.locationLayer,
      Reference.locationLayer,
      PluginV2.locationLayer,
      Catalog.locationLayer,
      Connector.locationLayer,
      CommandV2.locationLayer,
      AgentV2.locationLayer,
      PluginBoot.locationLayer,
      LayerNode.compile(FileSystem.node),
      LayerNode.compile(Watcher.node),
      Pty.locationLayer,
      LayerNode.compile(SkillV2.node),
      systemContext,
      LocationMutation.locationLayer.pipe(Layer.orDie),
    ).pipe(Layer.provideMerge(location))
    const resources = LayerNode.compile(ToolOutputStore.node).pipe(Layer.provide(base))
    const permissionsAndTools = LayerNode.compile(ToolRegistry.node).pipe(
      Layer.provideMerge(PermissionV2.locationLayer),
      Layer.provide(resources),
      Layer.provide(base),
    )
    const services = Layer.mergeAll(base, resources, permissionsAndTools)
    const image = LayerNode.compile(Image.node).pipe(Layer.provide(services))
    const mutation = FileMutation.locationLayer.pipe(Layer.provide(services))
    const skillGuidance = SkillGuidance.locationLayer.pipe(Layer.provide(services))
    const referenceGuidance = ReferenceGuidance.locationLayer.pipe(Layer.provide(services))
    const todos = LayerNode.compile(SessionTodo.node).pipe(Layer.provide(services))
    const questions = QuestionV2.locationLayer.pipe(Layer.provide(services))
    const builtInTools = LayerNode.compile(BuiltInTools.node).pipe(
      Layer.provide(services),
      Layer.provide(mutation),
      Layer.provide(resources),
      Layer.provide(todos),
      Layer.provide(questions),
      Layer.provide(image),
    )
    const model = SessionRunnerModel.locationLayer.pipe(Layer.provide(services))
    const runner = LayerNode.compile(SessionRunnerLLM.node).pipe(
      Layer.provide(services),
      Layer.provide(model),
      Layer.provide(skillGuidance),
      Layer.provide(referenceGuidance),
    )
    return Layer.mergeAll(
      boot,
      services,
      image,
      mutation,
      resources,
      todos,
      questions,
      model,
      runner,
      builtInTools,
      referenceGuidance,
    ).pipe(Layer.fresh)
  },
  idleTimeToLive: "60 minutes",
  dependencies: [
    LayerNode.compile(Project.node),
    LayerNode.compile(EventV2.node),
    LayerNode.compile(Credential.node),
    LayerNode.compile(Npm.node),
    LayerNode.compile(ModelsDev.node),
    LayerNode.compile(FSUtil.node),
    LayerNode.compile(AppProcess.node),
    LayerNode.compile(Global.node),
    LayerNode.compile(Ripgrep.node),
    Database.defaultLayer,
    LayerNode.compile(SessionStore.node).pipe(Layer.provide(Database.defaultLayer)),
    LayerNode.compile(PermissionSaved.node),
    LayerNode.compile(RepositoryCache.node),
    LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer)),
    FetchHttpClient.layer,
  ],
}) {}
