export const DEFAULT_FLASH_MODEL = 'gemini-flash-latest';
export const DEFAULT_PRO_MODEL = 'gemini-pro-latest';

export function getFlashModel(): string {
  return process.env.GEMINI_FLASH_MODEL || DEFAULT_FLASH_MODEL;
}

export function getProModel(): string {
  return process.env.GEMINI_MODEL || DEFAULT_PRO_MODEL;
}

export function getJudgeModel(): string {
  return process.env.GEMINI_JUDGE_MODEL || getProModel();
}
