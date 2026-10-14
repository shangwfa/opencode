import {
  FileImageOutlined,
  FilePdfOutlined,
  FileWordOutlined,
  FileExcelOutlined,
  FilePptOutlined,
  FileZipOutlined,
  FileTextOutlined,
  FileUnknownOutlined,
  VideoCameraOutlined,
} from "@ant-design/icons";

export type FileIconType = React.ComponentType<any>;

export const getFileIcon = (fileName: string): FileIconType => {
  const ext = fileName.split(".").pop()?.toLowerCase();

  switch (ext) {
    case "mp4":
    case "avi":
    case "mov":
    case "wmv":
    case "flv":
    case "mkv":
      return VideoCameraOutlined;
    case "jpg":
    case "jpeg":
    case "png":
    case "gif":
    case "webp":
    case "svg":
      return FileImageOutlined;
    case "pdf":
      return FilePdfOutlined;
    case "doc":
    case "docx":
      return FileWordOutlined;
    case "xls":
    case "xlsx":
      return FileExcelOutlined;
    case "ppt":
    case "pptx":
      return FilePptOutlined;
    case "jpg":
    case "jpeg":
    case "png":
    case "gif":
    case "webp":
      return FileImageOutlined;
    case "zip":
    case "rar":
    case "7z":
      return FileZipOutlined;
    case "txt":
    case "md":
    case "log":
      return FileTextOutlined;
    default:
      return FileUnknownOutlined;
  }
};
