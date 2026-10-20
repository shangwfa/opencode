export type AggregateProject = {
  appId: string;
  name: string;
  description: string;
  repos: string[];
};

export const AGGREGATE_PROJECTS: AggregateProject[] = [
  {
    appId: "xbot-client",
    name: "XBot 客户端（聚合项目）",
    description:
      "xbot-engine / xbot-local-pages / xbot-private / xbot-v3 跨项目需求录入",
    repos: ["xbot-engine", "xbot-local-pages", "xbot-private", "xbot-v3"],
  },
];

const AGGREGATE_APP_ID_SET = new Set(
  AGGREGATE_PROJECTS.map((p) => p.appId),
);

export function isAggregateAppId(appId: string): boolean {
  return AGGREGATE_APP_ID_SET.has(appId.trim());
}

export function getAggregateProject(
  appId: string,
): AggregateProject | undefined {
  return AGGREGATE_PROJECTS.find((p) => p.appId === appId.trim());
}

export function aggregateAppOptions() {
  return AGGREGATE_PROJECTS.map((p) => ({
    appId: p.appId,
    name: p.name,
  }));
}
