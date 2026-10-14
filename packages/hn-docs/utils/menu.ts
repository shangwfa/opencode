import { MenuItemType, type MenuData, type TreeNode } from "@/api/index.d";
import { isUrlWithDomain } from "@/utils/document";

// 递归url查找菜单数据
export const findMenuData = (
  menuData: MenuData[],
  address: string
): MenuData | null => {
  for (const item of menuData) {
    if (item.id === address || item.docUniqueId === address) {
      return item;
    }

    if (item.menuTrees.length > 0) {
      const found = findMenuData(item.menuTrees, address);
      if (found) {
        return found;
      }
    }
  }

  return null;
};

// 递归拼接菜单icon
export const generateMenuData = (
  menuData: TreeNode[],
  resourceDomain: string
): TreeNode[] => {
  for (const item of menuData) {
    item.isLeaf = item.type === MenuItemType.FOLDER ? false : true;
    if (item.iconUrl) {
      // 如果判断到已经有域名，则将先将item.path的域名删除，在做domin+item.path的拼接
      if (isUrlWithDomain(item.iconUrl)) {
        item.iconUrl = new URL(item.iconUrl).pathname;
      }
      item.iconUrl = resourceDomain + item.iconUrl;
    }

    if (item.menuTrees.length > 0) {
      generateMenuData(item.menuTrees, resourceDomain);
    }
  }

  return menuData;
};
