"use client";

import Highlight from "@tiptap/extension-highlight";
import Underline from "@tiptap/extension-underline";
import StarterKit from "@tiptap/starter-kit";
import { Placeholder } from "@tiptap/extension-placeholder";
import { message } from "antd";

import {
  attachmentExtension,
  Color,
  BackgroundColor,
  createBoardExtension,
  createBlockIdExtension,
  createCodeBlockExtension,
  createColumnsExtensions,
  createFileHandlerExtension,
  createHighlightBlockExtension,
  createImageResizeHandleExtension,
  createLinkExtensions,
  createSlashCommandsExtension,
  createTableExtensions,
  customListItem,
  customVideoExtension,
  FontSize,
  headingAnchorExtension,
  horizontalRuleExtension,
  iframeExtension,
  imageExtension,
  indentExtension,
  listExtension,
  taskListExtension,
  taskItemExtension,
  quoteExtension,
  rpaFlowExtension,
  TextAlign,
  TextStyle,
  videoExtension,
  RequestMethod,
  UploadWay,
  fetchImageAsFile,
  handleBuiltinUpload,
  type UploadConfig,
} from "@xybot/editor-extensions";
import { FileType } from "@/api/index.d";
import { getCookie } from "@/utils/cookie";
import { env } from "@/utils/env";
import { getUrlParams } from "@/utils";

const TOP_LEVEL_BLOCK_TYPES = [
  "paragraph",
  "heading",
  "blockquote",
  "bulletList",
  "orderedList",
  "codeBlock",
  "columns",
  "horizontalRule",
  "image",
  "listItem",
  "taskList",
  "taskItem",
  "quoteBlock",
  "video",
  "customVideo",
  "rpaFlow",
  "attachment",
  "highlightBlock",
  "table",
  "board",
  "iframe",
];

/** 与 admin.getUploadUrl 一致的 Boss 取址完整 URL */
function getBossHelpdocOssUploadUrl(): string {
  const bossBase = env.BOSS_URL ?? "";
  const envPath = env.ENV === "private" ? "" : "/boss";
  return `${bossBase}${envPath}/api/v3/cornerstone/helpdoc/oss/getUploadUrl`;
}

function getClientBearerToken(): string {
  if (typeof window === "undefined") return "";
  return getUrlParams("access_token") || getCookie("token") || "";
}

function getFileBaseName(fileName: string): string {
  const lastDotIndex = fileName.lastIndexOf(".");
  return lastDotIndex > 0 ? fileName.slice(0, lastDotIndex) : fileName;
}

function isValidUploadFileName(fileName: string): boolean {
  return /^[\u4e00-\u9fa5a-zA-Z0-9_-]+$/.test(getFileBaseName(fileName));
}

export interface BookTiptapOptions {
  /** 用于获取上传地址的 envCode */
  envCode: string;
  /** 用于获取上传地址的 docUniqueId (menuId) */
  docUniqueId: string;
  /** 可选：覆盖默认上传配置，不传则使用内置 uploadData（Boss getUploadUrl + 直传） */
  uploadConfig?: UploadConfig;
  /** 信任的图片 URL 前缀（如 OSS 域名），用于避免对已托管图片重复上传 */
  trustedImagePrefixes?: string[];
  /**
   * 资源域名（resourceDomain）是否已从接口解析完成。
   * 未完成前关闭外链图片自动上传，避免 trustedImagePrefixes 为空时误把 OSS 当外链上传。
   * 省略时视为 true，保持其它调用方默认行为。
   */
  resourceDomainResolved?: boolean;
  /**
   * 编辑器是否可编辑；只读时不开启外链图片自动上传。
   * 省略时视为 true。
   */
  editable?: boolean;
}

function buildDefaultUploadConfig(
  envCode: string,
  docUniqueId: string,
): UploadConfig {
  return {
    isCustomUpload: false,
    uploadData: {
      url: getBossHelpdocOssUploadUrl(),
      uploadWay: UploadWay.FRONT,
      reqWay: RequestMethod.POST,
      token: getClientBearerToken(),
      srcField: "",
      extraParams: {
        fileType: FileType.DOC_ASSET,
        envCode,
        menuId: docUniqueId,
      },
    },
  };
}

/**
 * 创建 book-v3 使用的 Tiptap 扩展列表（Tiptap v3 + editor-extensions）。
 * 需传入 envCode、docUniqueId 以支持图片/附件/画板/RPA 等上传。
 */
export function getBookTiptapExtensions(options: BookTiptapOptions) {
  const {
    envCode,
    docUniqueId,
    uploadConfig: customUploadConfig,
    trustedImagePrefixes = [],
    resourceDomainResolved = true,
    editable: editorEditable = true,
  } = options;
  const uploadConfig =
    customUploadConfig ?? buildDefaultUploadConfig(envCode, docUniqueId);
  const uploadFileInfo = {
    uploadConfig,
    validateFn: (file: File) => {
      if (!isValidUploadFileName(file.name)) {
        message.error("文件名仅支持中文、英文、数字、下划线和中划线");
        return false;
      }

      // 图片大小是否超过20MB
      if (file.type.startsWith("image/") && file.size / 1024 / 1024 > 20) {
        message.error("图片大小不能超过20MB");
        return false;
      }
      return true;
    },
  };
  return [
    createBlockIdExtension({ types: TOP_LEVEL_BLOCK_TYPES }),
    Placeholder.configure({
      placeholder: ({ node }) =>
        node.type.name === "paragraph" ? "输入 / 唤起快捷操作" : "",
      showOnlyCurrent: true,
    }),
    TextStyle,
    Color,
    BackgroundColor,
    Highlight.configure({ multicolor: true }),
    iframeExtension,
    StarterKit.configure({
      link: false,
      underline: false,
      codeBlock: false,
      horizontalRule: false,
      listItem: false,
      heading: false,
    }),
    headingAnchorExtension,
    customListItem,
    listExtension,
    taskListExtension,
    taskItemExtension,
    FontSize,
    TextAlign.configure({
      types: ["heading", "paragraph"],
      defaultAlignment: "left",
    }),
    indentExtension,
    Underline,
    ...createLinkExtensions({
      // private 依赖 editor.tsx 内 document 级 <a> 处理（BASE_PATH）；非 private 编辑态需允许点击跳转
      openOnClick: env.ENV !== "private",
      autolink: true,
      linkOnPaste: true,
      protocols: ["http", "https", "ftp", "mailto"],
      validate: (url: string) => /^https?:\/\/[^\s<>"{}|\\^`[\]]+$/.test(url),
      HTMLAttributes: {
        // editor-link 供 editor-extensions 内链接 hover 气泡用 closest(".editor-link") 匹配，不可省略
        class:
          "editor-link underline underline-offset-[3px] hover:text-primary cursor-pointer",
        rel: "noopener noreferrer",
        target: "_blank",
      },
    }),
    createCodeBlockExtension({
      autoDetectLanguage: true,
      defaultLanguage: "javascript",
      editable: true,
      theme: "atom-one-dark",
      highlightEngine: "lezer",
    }),
    ...createColumnsExtensions(),
    createFileHandlerExtension({
      uploadConfig,
      autoUploadBase64: true, // 自动上传粘贴的截图（base64 图片）
      autoUploadExternalImages: resourceDomainResolved && editorEditable, // 域名就绪且可编辑时开启；只读不触发外链自动上传
      trustedImagePrefixes, // 已在 OSS 的图片不再上传（由 editor 侧 await resourceDomain 后传入）
      onAutoUpload: async (source: string | File) => {
        // 如果是 File 对象则直接使用，否则将 base64 或外部 URL 转换为 File 对象
        const file =
          source instanceof File ? source : await fetchImageAsFile(source);
        // 使用内置上传函数上传到 OSS
        return await handleBuiltinUpload(
          file,
          uploadFileInfo.uploadConfig.uploadData!,
        );
      },
      onError: (_editor, file, error) => {
        console.error("上传失败:", file.name, error);
      },
    }),
    createImageResizeHandleExtension({
      minWidth: 40,
      minHeight: 40,
      maxWidth: 800,
      maxHeight: 600,
    }),
    quoteExtension,
    createSlashCommandsExtension(uploadFileInfo),
    videoExtension,
    customVideoExtension,
    rpaFlowExtension.configure({
      uploadFileInfo,
    }),
    imageExtension,
    attachmentExtension,
    createHighlightBlockExtension(),
    ...createTableExtensions({
      tablePopoverEnabled: true,
      tableColumnResizeEnabled: true,
    }),
    createBoardExtension({ uploadFileInfo }),
    horizontalRuleExtension,
  ];
}
