import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Tests import .tsx modules, so esbuild needs the automatic JSX runtime.
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node'
  }
})
