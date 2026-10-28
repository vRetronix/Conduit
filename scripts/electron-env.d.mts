export declare const STRIPPED_VARIABLES: readonly string[];
export declare function readLocalEnvFile(contents: string): Record<string, string>;
export declare function electronChildEnv(
  parentEnv: Record<string, string | undefined>,
  extra?: Record<string, string>,
): Record<string, string | undefined>;
