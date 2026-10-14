export const encodeUnicode = (str: string) => {
  return btoa(unescape(encodeURIComponent(str)));
};

export const decodeUnicode = (encoded: string) => {
  return decodeURIComponent(escape(atob(encoded)));
};
