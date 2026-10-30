import FileViewer, { type FileViewerProps } from "@file-viewer/react"
import liteRenderers from "@file-viewer/preset-lite"
import officeRenderers from "@file-viewer/preset-office"

const options: NonNullable<FileViewerProps["options"]> = {
  preset: [liteRenderers, officeRenderers],
  rendererMode: "replace",
  theme: "light",
  styleIsolation: "shadow",
  toolbar: { position: "bottom-right" },
}

export default function FileViewerPreview({ file }: { file: File }) {
  return <FileViewer file={file} name={file.name} options={options} className="h-full min-h-0 w-full" />
}
