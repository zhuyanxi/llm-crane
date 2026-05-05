import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

function resolvePath(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

export default defineConfig({
  resolve: {
    alias: {
      '@llm-crane/core': resolvePath('./packages/core/src/index.ts'),
      '@llm-crane/providers': resolvePath('./packages/providers/src/index.ts'),
      '@llm-crane/prompts': resolvePath('./packages/prompts/src/index.ts'),
      '@llm-crane/schemas': resolvePath('./packages/schemas/src/index.ts'),
    },
  },
  test: {
    passWithNoTests: true,
  },
});