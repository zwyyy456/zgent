export type ModelChoice = { id: string; label: string };
export type TurnResult = { nativeId?: string; text: string; cancelled?: boolean; usage?: unknown };
export type TurnHooks = { text: (delta: string) => void; session: (id: string) => void; runtime: (version: string) => void; models: (models: ModelChoice[]) => void };
export type MainRuntime = {
  prompt: (text: string, model: string, hooks: TurnHooks) => Promise<TurnResult>;
  interrupt: () => Promise<void>;
  close: () => Promise<void>;
};
export type MainMcp = { url: string; token: string };
