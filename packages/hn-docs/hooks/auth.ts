import { useState, useEffect } from "react";
import { useRouter } from "next/router";

// 来源
export enum AuthForm {
  INSTRUCTIONS = "instructions",
  DEFAULT = "default",
  SHARED = "shared",
}

// 文档组件
export enum DOC_COMPONENTS {
  HEADER = "header", // 头部
  FOOTER = "footer", // 底部
  SIDEBAR = "sidebar", // 菜单
  ANCHOR_MENU = "anchor_menu", // 锚点菜单
  DOC_CONTENT_LAYOUT = "doc_content_layout", // 文档内容布局
  FULL_SCREEN = "full_screen", // 全屏展示
}

// 使用说明对应的有权限的组件
const INSTRUCTIONS_AUTH = [];

// 默认文档组件对应的有权限的组件
const DEFAULT_AUTH = [
  DOC_COMPONENTS.HEADER,
  DOC_COMPONENTS.DOC_CONTENT_LAYOUT,
  DOC_COMPONENTS.ANCHOR_MENU,
  DOC_COMPONENTS.FOOTER,
  DOC_COMPONENTS.SIDEBAR,
  DOC_COMPONENTS.FULL_SCREEN,
];

// 共享文档组件对应的有权限的组件
const SHARED_AUTH = [
  DOC_COMPONENTS.HEADER,
  DOC_COMPONENTS.DOC_CONTENT_LAYOUT,
  DOC_COMPONENTS.ANCHOR_MENU,
];

export const useAuthComponents = () => {
  const router = useRouter();

  const { link_source } = router.query;
  const [authComponents, setAuthComponents] = useState<DOC_COMPONENTS[]>([]);
  useEffect(() => {
    // 根据 link_source 更新 authComponents
    setAuthComponents(
      link_source === AuthForm.INSTRUCTIONS ? INSTRUCTIONS_AUTH : DEFAULT_AUTH
    );
  }, [link_source]);

  return authComponents;
};
