export interface TextContentNode {
  text?: string;
  content?: TextContentNode[];
}

/**
 * 获取 Tiptap JSON 节点的完整纯文本内容。
 *
 * 带颜色、加粗等格式的文本会被拆成多个子节点，因此不能只读取
 * content[0].text。
 */
export function getTextContent(node?: TextContentNode): string {
  if (!node) return "";
  if (typeof node.text === "string") return node.text;
  return node.content?.map(getTextContent).join("") ?? "";
}
