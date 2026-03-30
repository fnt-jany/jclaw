import { cancelLlmRuns, runLlmProcess, type RunLlmProcessInput, type RunLlmProcessResult } from "./runner";

export type RunLlmInput = RunLlmProcessInput;
export type RunLlmResult = RunLlmProcessResult;

export async function runLlm(input: RunLlmInput): Promise<RunLlmResult> {
  return runLlmProcess(input);
}

export function cancelSessionRuns(sessionId: string): boolean {
  return cancelLlmRuns(sessionId);
}
