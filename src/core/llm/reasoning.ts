import type { ReasoningEffort } from "../session/sessionStore";

const LOW_REASONING_PATTERN =
  /(재시작|다시\s*시작|상태|리스트|목록|보여줘|확인|버전|크론\s*잡|크론잡|pm2|로그\s*(?:봐|확인)|커밋\s*이후\s*변경점|git\s+status|git\s+log|pwd|ls\b|dir\b)/i;

export function inferAutomaticReasoningEffort(prompt: string): Exclude<ReasoningEffort, "none"> {
  return LOW_REASONING_PATTERN.test(prompt) ? "low" : "medium";
}

export function resolveReasoningEffort(configured: ReasoningEffort, prompt: string): ReasoningEffort {
  if (configured !== "none") {
    return configured;
  }

  return inferAutomaticReasoningEffort(prompt);
}
