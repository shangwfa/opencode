import { type MenuData, MenuItemType } from "@/api/index.d";

export enum ActionType {
  DELETE = "delete",
  ADD = "add",
  RENAME = "rename",
  EDIT = "edit",
  DISABLE = "disable",
  ENABLE = "enable",
  ALIAS = "alias",
}

interface TreeNode {
  active: boolean;
  checked: boolean;
  dragOver: boolean;
  dragOverGapBottom: boolean;
  dragOverGapTop: boolean;
  enable: boolean;
  expanded: boolean;
  halfChecked: boolean;
  iconUrl: string;
  id: string;
  key: string;
  loaded: boolean;
  loading: boolean;
  menuTrees: MenuData[];
  name: string;
  parentId: string;
  pos: string;
  previousId: string;
  selected: boolean;
  type: MenuItemType;
}

export interface TreeInfo {
  expanded: boolean;
  node: TreeNode;
  selected: boolean;
}
