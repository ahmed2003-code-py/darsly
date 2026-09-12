/** Mirrors `EducationStage` on the API. Order is the order they are offered in. */
export const STAGES = ['PRIMARY', 'PREPARATORY', 'SECONDARY', 'BACCALAUREATE'] as const;
export type Stage = (typeof STAGES)[number];

export interface Grade {
  id: string;
  nameAr: string;
  nameEn: string;
  stage: Stage | null;
}
