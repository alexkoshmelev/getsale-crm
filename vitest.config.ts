import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'services/**/src/**/*.test.ts',
      'services-v2/**/src/**/*.test.ts',
      'shared/**/src/**/*.test.ts',
      'shared-v2/**/src/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
  },
});
