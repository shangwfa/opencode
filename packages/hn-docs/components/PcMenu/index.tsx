import Menu from "@/components/Menu";
import FindAnswer from "./components/FindAnswer";

export default (props) => {
  const { onKeyChange, style } = props;
  return (
    <div
      className="fixed bg-white border-r-[1px] border-solid border-gray-200 transition-all duration-500 ease-in-out"
      style={style}
    >
      <div className="h-calc-height overflow-y-overlay overflow-x-hidden">
        <div className="mt-[24px] mr-[16px] ml-[16px]">
          <FindAnswer onKeyChange={onKeyChange} />
          <Menu menuData={props.menuData} />
        </div>
      </div>
    </div>
  );
};
