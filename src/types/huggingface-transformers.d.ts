/**
 * Minimal ambient declaration for the OPTIONAL peer dependency
 * @huggingface/transformers. The package is not installed by default (it is a
 * heavyweight, model-downloading runtime); this declaration lets the adapter
 * type-check without it. When the real package is installed its richer types
 * are compatible with this surface for the APIs we use.
 */
declare module "@huggingface/transformers" {
  export const env: {
    cacheDir?: string;
    allowRemoteModels?: boolean;
    allowLocalModels?: boolean;
    [key: string]: unknown;
  };

  export type Pipeline = ((inputs: string | string[], options?: Record<string, unknown>) => Promise<unknown>) & {
    dispose?: () => Promise<void>;
  };

  export function pipeline(task: string, model: string, options?: Record<string, unknown>): Promise<Pipeline>;

  export const RawWeb: unknown;
}
