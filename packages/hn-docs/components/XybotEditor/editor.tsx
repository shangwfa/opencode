"use client";

import React, { useEffect, useState, useRef, useMemo } from "react";
import { useDebouncedCallback } from "use-debounce";
import { EditorContent, useEditor } from "@tiptap/react";
import { useRouter } from "next/router";
import { env } from "@/utils/env";

import { BubbleMenu } from "@xybot/editor-menu";
import { getBookTiptapExtensions } from "./tiptapConfig";

import AnchorMenu from "./ui/AnchorMenu";
import ActionBtn from "./ui/ActionBtn";
import NoData from "./ui/NoData";
import ImgPreviewModel from "./ui/ImgPreviewModel";

import { usePcMobile } from "@/hooks";
import { type EditorData, type DocInfo, DocActionTypes } from "./types";
import { generateUUID, textToSlug } from "@/utils";
import { getDocData } from "@/utils/getDocData";
import { migrateDoc } from "@/utils/migrateDoc";
import { useSharedData } from "@/context/SharedDataContext";
import { useAuthComponents, DOC_COMPONENTS } from "@/hooks/auth";
import { resourceDomain } from "@/utils/resources";
import { getTextContent } from "./utils";

import "./index.css";

/** ProseMirror/Tiptap 文档 JSON 类型（与 EditorData 兼容） */
export type JSONContent = {
  type: string;
  content?: JSONContent[];
  attrs?: Record<string, unknown>;
  text?: string;
  [key: string]: unknown;
};

const initData: JSONContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [] }],
};

/** 文档模式：需要 docInfo / initDocJson / editPermissions */
export interface XybotEditorDocProps {
  embedded?: false;
  docInfo: DocInfo;
  initDocJson: JSONContent | null;
  editPermissions: boolean;
}

/** 嵌入式模式：用于 AiSearch 等，受控 value/onChange */
export interface XybotEditorEmbeddedProps {
  embedded: true;
  value?: JSONContent | string | null;
  onChange?: (content: JSONContent) => void;
  editable?: boolean;
  onRendered?: () => void;
  envCode?: string;
  docUniqueId?: string;
  docInfo?: DocInfo;
  initDocJson?: JSONContent | null;
  editPermissions?: boolean;
}

export type Props = XybotEditorDocProps | XybotEditorEmbeddedProps;

const XybotEditor = (props: Props) => {
  const isEmbedded = props.embedded === true;
  const isMobile = usePcMobile();

  const docInfo: DocInfo = isEmbedded
    ? (props.docInfo ?? {
        content: "",
        contentType: "oss",
        hasDraft: false,
        menuId: "",
      })
    : props.docInfo;
  const initDocJson = isEmbedded
    ? (props.initDocJson ?? null)
    : props.initDocJson;
  const editPermissions = isEmbedded
    ? (props.editPermissions ?? false)
    : props.editPermissions;

  const embeddedValue = isEmbedded
    ? (props as XybotEditorEmbeddedProps).value
    : undefined;
  const embeddedOnChange = isEmbedded
    ? (props as XybotEditorEmbeddedProps).onChange
    : undefined;
  const embeddedEditable = isEmbedded
    ? ((props as XybotEditorEmbeddedProps).editable ?? false)
    : undefined;
  const embeddedOnRendered = isEmbedded
    ? (props as XybotEditorEmbeddedProps).onRendered
    : undefined;

  const resolveInitialFromEmbedded = (): JSONContent | null => {
    if (!isEmbedded || embeddedValue == null) return initData;
    if (typeof embeddedValue === "string") {
      try {
        const parsed = JSON.parse(embeddedValue) as JSONContent;
        if (parsed && typeof parsed.type === "string") return parsed;
      } catch {
        // ignore
      }
      return initData;
    }
    return embeddedValue;
  };

  const [initialContent, setInitialContent] = useState<JSONContent | null>(() =>
    resolveInitialFromEmbedded(),
  );
  const [docData, setDocData] = useState<EditorData>({} as EditorData);
  const [editable, setEditable] = useState(
    isEmbedded ? embeddedEditable : false,
  );
  const [docId, setDocId] = useState("");
  const [docBasicInfo, setDocBasicInfo] = useState<DocInfo>(docInfo);
  const [imgPreviewInfo, setImgPreviewInfo] = useState({
    visible: false,
    imgUrl: "",
  });
  const [isBrowser, setIsBrowser] = useState(false);
  const [trustedImagePrefixes, setTrustedImagePrefixes] = useState<string[]>(
    [],
  );
  const [resourceDomainResolved, setResourceDomainResolved] = useState(false);

  const editableRef = useRef(editable);
  const router = useRouter();
  const { brandCode } = router.query;
  const { sharedData } = useSharedData();
  const envCodeFromShared = sharedData?.envCode ?? "";
  const docUniqueIdFromShared = sharedData?.docUniqueId ?? "";
  const envCode =
    isEmbedded && (props as XybotEditorEmbeddedProps).envCode != null
      ? (props as XybotEditorEmbeddedProps).envCode!
      : envCodeFromShared;
  const docUniqueId =
    isEmbedded && (props as XybotEditorEmbeddedProps).docUniqueId != null
      ? (props as XybotEditorEmbeddedProps).docUniqueId!
      : docUniqueIdFromShared;
  const authComponents = useAuthComponents();

  const extensions = useMemo(
    () =>
      getBookTiptapExtensions({
        envCode: envCode ?? "",
        docUniqueId: docUniqueId ?? "",
        trustedImagePrefixes,
        resourceDomainResolved,
        editable,
      }),
    [
      envCode,
      docUniqueId,
      trustedImagePrefixes,
      resourceDomainResolved,
      editable,
    ],
  );

  useEffect(() => {
    resourceDomain().then((d) => {
      setTrustedImagePrefixes(d ? [d.trim()] : []);
      setResourceDomainResolved(true);
    });
  }, []);

  const editor = useEditor(
    {
      extensions,
      immediatelyRender: false,
      content: "",
      editable,
    },
    [editable, docId, extensions],
  );

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;

    let cancelled = false;
    const content = initialContent ?? initData;

    // setContent may synchronously create React NodeViews. Tiptap renders those
    // with flushSync once EditorContent is initialized, so defer the command
    // until React has finished the current lifecycle.
    queueMicrotask(() => {
      if (cancelled || editor.isDestroyed) return;
      editor.commands.setContent(content);
    });

    return () => {
      cancelled = true;
    };
  }, [editor, initialContent]);

  // Embedded: sync editable from props
  useEffect(() => {
    if (isEmbedded && embeddedEditable !== undefined) {
      setEditable(embeddedEditable);
    }
  }, [isEmbedded, embeddedEditable]);

  // Embedded: sync initial content from value
  useEffect(() => {
    if (!isEmbedded || embeddedValue == null) return;
    if (typeof embeddedValue === "string") {
      try {
        const parsed = JSON.parse(embeddedValue) as JSONContent;
        if (parsed && typeof parsed.type === "string") {
          setInitialContent(parsed);
          return;
        }
      } catch {
        // 当作 HTML 不在这里 set，由 editor 的 content 或下方 setContent 处理
      }
      setInitialContent(initData);
      return;
    }
    setInitialContent(embeddedValue);
  }, [isEmbedded, embeddedValue]);

  // Embedded: notify onChange when content changes
  useEffect(() => {
    if (!isEmbedded || !editor || !embeddedOnChange) return;
    const handler = () => {
      embeddedOnChange(editor.getJSON() as JSONContent);
    };
    editor.on("update", handler);
    return () => editor.off("update", handler);
  }, [isEmbedded, editor, embeddedOnChange]);

  // Embedded: call onRendered when editor is ready
  useEffect(() => {
    if (isEmbedded && editor && embeddedOnRendered) {
      embeddedOnRendered();
    }
  }, [isEmbedded, editor, embeddedOnRendered]);

  useEffect(() => {
    setIsBrowser(true);
  }, []);

  useEffect(() => {
    editableRef.current = editable;
  }, [editable]);

  useEffect(() => {
    const onCopy = (e: ClipboardEvent) => {
      e.preventDefault();
      const selectedText = window.getSelection()?.toString() ?? "";
      if (e.clipboardData) e.clipboardData.setData("text/plain", selectedText);
    };
    document.addEventListener("copy", onCopy);
    return () => document.removeEventListener("copy", onCopy);
  }, []);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      if (target.tagName?.toLowerCase() === "a" && env.ENV === "private") {
        e.preventDefault();
        const url = target.getAttribute("href");
        const basePath = env.BASE_PATH;
        if (basePath && url?.includes(`${basePath}/`)) {
          const newUrl = url.split(`${basePath}/`)[1];
          if (newUrl) window.open(`${basePath}/${newUrl}`, "_blank");
        }
      }
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  useEffect(() => {
    if (!isEmbedded) setEditable(false);
  }, [isEmbedded, docInfo?.menuId]);

  const removeLoadingAttachments = (json: EditorData): EditorData => {
    const cleaned = JSON.parse(JSON.stringify(json)) as EditorData;
    const recursive = (node: { content?: unknown[] }) => {
      if (node.content && Array.isArray(node.content)) {
        node.content = node.content.filter(
          (item: { type?: string; attrs?: { isLoading?: boolean } }) => {
            if (item.type === "attachment" && item.attrs?.isLoading === true)
              return false;
            return true;
          },
        );
        node.content.forEach((item: { content?: unknown[] }) => {
          if (item.content && Array.isArray(item.content)) recursive(item);
        });
      }
    };
    recursive(cleaned);
    return cleaned;
  };

  const onSetHeadingId = (json: JSONContent, fromEditorUpdate?: boolean) => {
    if (!json.content) return;
    json.content.forEach((item) => {
      if (item.type === "heading" && item.content?.length) {
        const headingText = getTextContent(item);
        const slug = textToSlug(headingText);
        const attrs = item.attrs ?? {};
        const id = attrs.id as string | undefined;
        const isOldUuidFormat =
          id &&
          /^h[1-6]_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            id,
          );
        if (!id || isOldUuidFormat) {
          attrs.id = slug || generateUUID(`h${(attrs.level as number) ?? 1}`);
        }
        item.attrs = attrs;
      }
    });
    if (!fromEditorUpdate) {
      setInitialContent(json);
    }
    setDocData(json as EditorData);
  };

  const debouncedUpdates = useDebouncedCallback(() => {
    if (editor) {
      const json = editor.getJSON() as JSONContent;
      onSetHeadingId(json, true);
    }
  }, 500);

  useEffect(() => {
    if (!editor) return;
    editor.on("update", debouncedUpdates);
    return () => editor.off("update", debouncedUpdates);
  }, [editor, debouncedUpdates]);

  const onAction = (action: string, data?: DocInfo) => {
    let obj: DocInfo = { ...docInfo };
    if (action === DocActionTypes.EDIT) {
      setEditable(true);
      obj = { ...obj, content: data?.content ?? "" };
    }
    if (action === DocActionTypes.PUBLISH) {
      setEditable(false);
      obj = { ...obj, hasDraft: false, content: data?.content ?? "" };
    }
    if (action === DocActionTypes.EDIT_DRAFT) {
      setEditable(true);
      obj = { ...obj, content: data?.content ?? "", hasDraft: true };
    }
    if (action === DocActionTypes.SAVE_DRAFT) {
      setEditable(false);
      obj = { ...obj, content: data?.content ?? "", hasDraft: true };
    }
    setDocBasicInfo(obj);
    getOSSInfo(obj, action === DocActionTypes.EDIT_DRAFT);
  };

  const getOSSInfo = async (info: DocInfo, isEditDraft: boolean = false) => {
    if (!info?.content) {
      setInitialContent(initData);
      setDocId(docInfo.menuId);
      setDocData(initData as EditorData);
      return;
    }
    const doc = await getDocData(info.content);
    const cleaned = isEditDraft
      ? removeLoadingAttachments((doc ?? initData) as EditorData)
      : (doc ?? initData);
    const migrated = migrateDoc(cleaned as Parameters<typeof migrateDoc>[0]);
    onSetHeadingId(migrated as JSONContent);
    setDocId(info.content);
  };

  useEffect(() => {
    if (isEmbedded) return;
    if (initDocJson) {
      const migrated = migrateDoc(
        JSON.parse(JSON.stringify(initDocJson)) as Parameters<
          typeof migrateDoc
        >[0],
      );
      onSetHeadingId(migrated as JSONContent);
    } else {
      setInitialContent(initData);
      setDocData(initData as EditorData);
    }
    setDocBasicInfo(docInfo);
    setDocId(docInfo.menuId);
  }, [isEmbedded, docInfo?.menuId, initDocJson]);

  if (initialContent == null) return null;

  return (
    <div
      className={`relative w-full ${!isEmbedded && (editable || docBasicInfo.content) ? "max-w-[682px]" : ""}`}
      style={
        isEmbedded
          ? undefined
          : { width: isMobile ? "100%" : "calc(100% - 16vw)" }
      }
    >
      {!isEmbedded && (
        <ActionBtn
          docData={docData}
          docInfo={docBasicInfo}
          editable={editable}
          onAction={onAction}
          editPermissions={editPermissions}
        />
      )}
      {!isEmbedded &&
        !isMobile &&
        authComponents.includes(DOC_COMPONENTS.ANCHOR_MENU) && (
          <AnchorMenu docData={docData} />
        )}
      {isEmbedded || editable || docBasicInfo.content ? (
        <div key={isEmbedded ? "embedded" : `${docId}-${editable}`}>
          <div className={`editor${!editable ? " editor--readonly" : ""}`}>
            {editable && editor && <BubbleMenu editor={editor} />}
            <EditorContent
              editor={editor}
              id="editor-container"
              className={`relative min-h-[500px] w-full border-muted bg-background ${
                !isEmbedded &&
                authComponents.includes(DOC_COMPONENTS.DOC_CONTENT_LAYOUT)
                  ? "sm:mb-[100px]"
                  : ""
              } ${brandCode === "rpa" && isMobile ? "rpa-mobile" : ""} ${isEmbedded ? "ai-tiptap" : ""} ${envCode}`}
            />
          </div>
        </div>
      ) : (
        <>{isBrowser ? <NoData docInfo={docBasicInfo} /> : null}</>
      )}
      <ImgPreviewModel
        visible={imgPreviewInfo.visible}
        imgUrl={imgPreviewInfo.imgUrl}
        onCancel={() => setImgPreviewInfo({ imgUrl: "", visible: false })}
      />
    </div>
  );
};

export default XybotEditor;
