export interface EditorData {
  type: string;
  content: EditorContent[];
}

export interface EditorContent {
  type: string;
  content: EditorContent[];
  attrs?: {
    id?: string;
    level?: number;
    [key: string]: string | number | null | undefined;
  };
  text?: string;
}

export enum DocActionTypes {
  PUBLISH = "publish",
  EDIT = "edit",
  SAVE_DRAFT = "saveDraft",
  EDIT_DRAFT = "editDraft",
}

export interface DocInfo {
  content: string;
  contentType: string;
  hasDraft: boolean;
  menuId: string;
  name?: string;
  draftId?: string;
  scope?: string;
}
