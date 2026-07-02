import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"

export function build<A, E>(root: LayerNode.Node<A, E, any>, replacements: LayerNode.Replacements = []) {
  return AppNodeBuilder.build(root, replacements.concat([[InstanceStore.bootstrapNode, InstanceBootstrap.node]]))
}

export * as AppNodeBuilderV1 from "./app-node-builder-v1"
