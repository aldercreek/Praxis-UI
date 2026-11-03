import { defineConfig } from 'vitest/config'

const domTests = ['src/renderer/src/markdownContent.test.ts', 'src/renderer/src/ComposerSuggestions.test.ts', 'src/renderer/src/messageActions.test.ts', 'src/renderer/src/imagePreview.test.ts', 'src/main/preview-navigation.test.ts', 'src/renderer/src/findInChat.test.ts', 'src/renderer/src/usePraxis.test.ts']

export default defineConfig({ test: { projects: [
  { test: { name: 'node', include: ['tests/**/*.test.ts', 'src/**/*.test.ts'], exclude: domTests } },
  { test: { name: 'dom', include: domTests, environment: 'jsdom' } }
] } })
