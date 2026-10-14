import { useIsYdBrowser, useClientVersion } from "@/hooks";

interface IProps {
  children: React.ReactNode;
}

import "./index.css";

export default (props: IProps) => {
  const { children } = props;

  const isYD = useIsYdBrowser();
  const { version, isLoading } = useClientVersion();

  return (
    <div
      className="relative custom-bg-shadow w-full"
      style={{ marginTop: isYD || version ? "0px" : "81px" }}
    >
      <div className="custom-bg"></div>
      <div className="relative h-full">{children}</div>
    </div>
  );
};
