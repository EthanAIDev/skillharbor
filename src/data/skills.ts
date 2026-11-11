/**
 * Skill list and stats come from the Skill Gateway at runtime
 * (`services/skillsGateway.ts`). This constant is only a default base URL.
 */
export const SKILL_GATEWAY_URL = 'http://127.0.0.1:8800/';

/** Categories used when uploading / editing skills */
export const SKILL_CATEGORIES = ['规划咨询', '文档办公', '数据分析', '其他'];

export const SKILL_STYLES: Record<string, { bg: string; fg: string }> = {
  规划咨询: { bg: 'bg-[#EEEDFE] dark:bg-[#2A2342]', fg: 'text-[#5046E5] dark:text-[#B49CFF]' },
  文档办公: { bg: 'bg-[#E3EDFE] dark:bg-[#1E2A4A]', fg: 'text-[#2563EB] dark:text-[#6E9BFF]' },
};
