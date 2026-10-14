export enum LearnStatus {
  notStart = "notStart",
  complete = "complete",
  learning = "learning",
  exam = "exam",
}

export interface LearnProgressInfoData {
  isEnterprise: boolean;
  paidFund?: number;
  learnRouteStatus: LearnStatus;
  learnBookStatus: LearnStatus;
  learnStatus: string;
  textBookName: string;
  learnProgress: number;
  textBookRecordUuid: string;
  catalogName?: string;
  bookLevel?: number;
  catalogUuid?: string;
  getCertNum?: number;
  classInfoUuid: string;
  textBookUuid: string;
}
