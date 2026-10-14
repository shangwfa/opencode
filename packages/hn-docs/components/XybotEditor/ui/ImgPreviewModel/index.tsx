/**
 * 图片预览弹窗
 */
import { Image } from "antd";
import "./index.css";

interface Props {
  visible: boolean;
  imgUrl: string;
  onCancel: () => void;
}

const ImgPreviewModel = (props: Props) => {
  const { visible, imgUrl, onCancel } = props;

  if (!imgUrl) {
    return null;
  }

  return (
    <Image
      src={imgUrl}
      alt="预览"
      style={{ display: "none" }}
      preview={{
        visible: visible,
        onVisibleChange: (visible) => {
          if (!visible) {
            onCancel();
          }
        },
        mask: "预览",
      }}
    />
  );
};

export default ImgPreviewModel;
