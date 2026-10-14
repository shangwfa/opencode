import { getUploadUrl } from "@/api/admin";
import { FileType } from "@/api/index.d";

// 定义上传信息接口
interface UploadInfo {
  key: string | null;
  uploadUrl: string | null;
  readUrl: string | null;
}

// 获取上传地址的函数
export const getUploadAddress = async (
  fileName: string,
  fileSize: number,
  fileType: FileType,
  envCode: string,
  menuId?: string
): Promise<UploadInfo> => {
  const response = await getUploadUrl({
    fileName,
    fileSize,
    fileType,
    envCode,
    menuId,
  });
  return response.data;
};

// 上传文件的函数
export const uploadFile = async (
  file: File,
  uploadUrl: string
): Promise<{
  message: string;
  status: string;
} | void> => {
  if (!file) return;

  // 获取上传地址

  return new Promise((resolve, reject) => {
    if (uploadUrl) {
      // 发起文件上传请求
      const fileReader = new FileReader();

      fileReader.readAsArrayBuffer(file);
      fileReader.onload = async (e) => {
        const resultData = e.target?.result;

        const response = await fetch(uploadUrl!, {
          method: "put",
          headers: {
            contentType: "",
          },
          body: resultData,
          signal: new AbortController().signal,
        });

        if (response.ok) {
          // 返回上传结果
          resolve({
            status: "success",
            message: "上传成功",
          });
        } else {
          throw new Error("Upload failed");
        }
      };
    } else {
      // 如果请求失败或者数据为空，则返回未定义
      reject({
        status: "error",
        message: "获取上传地址失败",
      });
    }
  });
};
