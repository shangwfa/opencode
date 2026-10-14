export const setCookie = (name: string, value: any) => {
  if (!typeof window || typeof window === "undefined") return;
  const Days = 5;
  const exp = new Date();
  exp.setTime(exp.getTime() + Days * 24 * 60 * 60 * 1000);
  document.cookie =
    name + "=" + escape(value) + ";expires=" + exp.toGMTString() + "; path=/";
};

export const getCookie = (name: string) => {
  if (!typeof window || typeof window === "undefined") return;
  let arr;
  const reg = new RegExp("(^| )" + name + "=([^;]*)(;|$)");
  if ((arr = document.cookie.match(reg))) return unescape(arr[2]);
  else return null;
};

export const delCookie = (name: string) => {
  if (!typeof window || typeof window === "undefined") return;
  const exp = new Date();
  exp.setTime(exp.getTime() - 10000);
  const cval = getCookie(name);
  if (cval != null)
    document.cookie =
      name + "=" + "" + ";expires=" + exp.toGMTString() + "; path=/";
};
