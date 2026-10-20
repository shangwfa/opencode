export function isRequirementDebugFlagEnabled(value: unknown) {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1";
}

export function isRequirementDebugEnabled() {
  if (typeof window === "undefined") return false;
  return isRequirementDebugFlagEnabled(window.YD?.ENABLE_DEBUG);
}
