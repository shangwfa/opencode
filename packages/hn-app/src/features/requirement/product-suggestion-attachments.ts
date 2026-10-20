export function appendProductSuggestionFiles(current: readonly File[], incoming: readonly File[]): File[] {
  return [...current, ...incoming];
}

export function removeProductSuggestionFile(current: readonly File[], index: number): File[] {
  return current.filter((_, i) => i !== index);
}

export function filesFromProductSuggestionClipboard(event: ClipboardEvent): File[] {
  const items = event.clipboardData?.items;
  if (!items) return [];
  return Array.from(items).flatMap((item) => {
    if (item.kind !== "file") return [];
    const file = item.getAsFile();
    return file ? [file] : [];
  });
}
