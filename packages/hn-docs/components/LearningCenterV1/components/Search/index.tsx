import React from "react";

import SearchContent from "@/components/SearchContent";
import SearchPortal from "@/components/SearchPortal";

import { useIsYdBrowser } from "@/hooks";

interface Iprops {
  keywords: string;
  onKeyChange: (key: string) => void;
}

export const Search: React.FC<Iprops> = (p) => {
  const isYd = useIsYdBrowser();
  const { keywords, onKeyChange } = p;
  return (
    <>
      <div className="w-full px-[20px] bg-white">
        <SearchPortal keywords={keywords} onKeyChange={onKeyChange} />
        <SearchContent
          style={{
            paddingTop: isYd ? "100px" : "160px",
          }}
          keywords={keywords}
        />
      </div>
    </>
  );
};

export default Search;
