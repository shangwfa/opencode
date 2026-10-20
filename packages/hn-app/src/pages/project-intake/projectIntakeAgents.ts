export const PROJECT_INTAKE_AGENTS = [
  "project-requirement-parser",
  "project-intake",
  "client-project-intake",
] as const;

export type ProjectIntakeAgent = (typeof PROJECT_INTAKE_AGENTS)[number];

export const DEFAULT_PROJECT_INTAKE_AGENT: ProjectIntakeAgent =
  "project-requirement-parser";

export function isProjectIntakeAgent(
  name: string,
): name is ProjectIntakeAgent {
  return (PROJECT_INTAKE_AGENTS as readonly string[]).includes(name);
}

export function matchProjectIntakeAgent(
  agents: Array<{ name?: string; mode?: string }>,
): ProjectIntakeAgent {
  for (const candidate of PROJECT_INTAKE_AGENTS) {
    const found = agents.some(
      (a) => a.name === candidate && a.mode !== "subagent",
    );
    if (found) return candidate;
  }
  return DEFAULT_PROJECT_INTAKE_AGENT;
}
